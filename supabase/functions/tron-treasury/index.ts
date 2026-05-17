// ╔══════════════════════════════════════════════════════════════╗
// ║  tron-treasury — admin TRON energy staking (Stake 2.0)       ║
// ╚══════════════════════════════════════════════════════════════╝
//
// The treasury (HD index 0 Tron) freezes TRX for ENERGY so sweeps
// delegate it and move USDT-TRC20 for ≈0 TRX. Frozen TRX is
// COLLATERAL, recoverable via unstake (14-day unbond) → withdraw.
//
// Self-contained (inlined HD + Tron signing — no _shared, so the
// Supabase bundler is happy). Admin-only: the caller's user_id
// must map to the hardcoded admin telegram_id.
//
// POST { action: 'info'|'stake'|'unstake'|'withdraw',
//        user_id, amount? }   amount = TRX (for stake/unstake)

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  HDNodeWallet, SigningKey, keccak256, sha256, getBytes, encodeBase58,
} from 'https://esm.sh/ethers@6.13.4'

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const HD_MASTER_MNEMONIC   = Deno.env.get('HD_MASTER_MNEMONIC') || ''
const TRON_KEY             = Deno.env.get('TRONGRID_API_KEY') || ''
const ADMIN_TG             = Deno.env.get('ADMIN_TELEGRAM_ID') || '945676433'

const TRON_API = 'https://api.trongrid.io'
const SUN = 1_000_000

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

let sbc: ReturnType<typeof createClient>
const sb = () => (sbc ??= createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY))

function treasuryPriv(): string {
  return HDNodeWallet.fromPhrase(HD_MASTER_MNEMONIC, undefined, "m/44'/195'/0'/0/0").privateKey
}
function tronAddr(priv: string): string {
  const pub = getBytes(SigningKey.computePublicKey(priv, false)).slice(1)
  const h = getBytes(keccak256(pub))
  const a21 = new Uint8Array(21); a21[0] = 0x41; a21.set(h.slice(-20), 1)
  const chk = getBytes(sha256(sha256(a21))).slice(0, 4)
  const full = new Uint8Array(25); full.set(a21, 0); full.set(chk, 21)
  return encodeBase58(full)
}
async function rpc(path: string, body: unknown): Promise<any> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (TRON_KEY) headers['TRON-PRO-API-KEY'] = TRON_KEY
  const r = await fetch(`${TRON_API}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
  if (!r.ok) throw new Error(`trongrid ${path} HTTP ${r.status}`)
  return r.json()
}
function signAndSend(tx: any, priv: string) {
  const sk = new SigningKey(priv)
  const s = sk.sign('0x' + tx.txID)
  const signed = { ...tx, signature: [s.r.slice(2) + s.s.slice(2) + (s.yParity ? '01' : '00')] }
  return rpc('/wallet/broadcasttransaction', signed)
}

async function buildInfo(addr: string) {
  const [acc, res] = await Promise.all([
    rpc('/wallet/getaccount', { address: addr, visible: true }),
    rpc('/wallet/getaccountresource', { address: addr, visible: true }),
  ])
  const frozenV2 = Array.isArray(acc?.frozenV2) ? acc.frozenV2 : []
  const stakedEnergySun = frozenV2
    .filter((f: any) => f?.type === 'ENERGY')
    .reduce((s: number, f: any) => s + Number(f.amount || 0), 0)
  const unfrozen = Array.isArray(acc?.unfrozenV2) ? acc.unfrozenV2 : []
  const now = Date.now()
  const unfreezing = unfrozen.map((u: any) => ({
    trx: Number(u.unfreeze_amount || 0) / SUN,
    unlockAt: Number(u.unfreeze_expire_time || 0),
    ready: Number(u.unfreeze_expire_time || 0) <= now,
  }))
  const withdrawableTrx = unfreezing
    .filter(u => u.ready).reduce((s, u) => s + u.trx, 0)
  const totalE = Number(res?.TotalEnergyLimit || 0)
  const totalW = Number(res?.TotalEnergyWeight || 0)
  const energyTotal = Number(res?.EnergyLimit || 0)
  const energyUsed = Number(res?.EnergyUsed || 0)
  const delegatedOutSun = Number(acc?.account_resource?.delegated_frozenV2_balance_for_energy || 0)
  return {
    address: addr,
    trx: Number(acc?.balance || 0) / SUN,
    stakedEnergyTrx: stakedEnergySun / SUN,
    delegatedOutTrx: delegatedOutSun / SUN,
    energyPerTrx: totalW > 0 ? totalE / totalW : 0,
    energyTotal,
    energyUsed,
    energyAvail: Math.max(0, energyTotal - energyUsed),
    unfreezing,
    withdrawableTrx,
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    if (!HD_MASTER_MNEMONIC) return json({ error: 'no_master' }, 500)
    const { action, user_id, amount } = await req.json().catch(() => ({}))
    if (!user_id) return json({ error: 'missing_user_id' }, 400)

    // Admin gate.
    const { data: u } = await sb()
      .from('users').select('telegram_id').eq('id', user_id).maybeSingle()
    if (!u || String(u.telegram_id) !== String(ADMIN_TG)) {
      return json({ error: 'forbidden' }, 403)
    }

    const priv = treasuryPriv()
    const addr = tronAddr(priv)

    if (!action || action === 'info') {
      return json({ ok: true, info: await buildInfo(addr) })
    }

    if (action === 'stake') {
      const trx = Number(amount)
      if (!(trx > 0)) return json({ error: 'invalid_amount' }, 400)
      const built = await rpc('/wallet/freezebalancev2', {
        owner_address: addr, frozen_balance: Math.round(trx * SUN),
        resource: 'ENERGY', visible: true,
      })
      if (!built?.txID) return json({ error: 'build_failed', detail: built }, 502)
      const bc = await signAndSend(built, priv)
      const ok = bc?.result === true || !!bc?.txid
      await sb().rpc('admin_log', {
        p_level: ok ? 'info' : 'warn', p_source: 'edge:tron-treasury',
        p_message: 'stake', p_details: { trx, txID: built.txID, ok },
      })
      return json({ ok, txid: built.txID, info: await buildInfo(addr) })
    }

    if (action === 'unstake') {
      const trx = Number(amount)
      if (!(trx > 0)) return json({ error: 'invalid_amount' }, 400)
      const built = await rpc('/wallet/unfreezebalancev2', {
        owner_address: addr, unfreeze_balance: Math.round(trx * SUN),
        resource: 'ENERGY', visible: true,
      })
      if (!built?.txID) return json({ error: 'build_failed', detail: built }, 502)
      const bc = await signAndSend(built, priv)
      const ok = bc?.result === true || !!bc?.txid
      await sb().rpc('admin_log', {
        p_level: ok ? 'info' : 'warn', p_source: 'edge:tron-treasury',
        p_message: 'unstake', p_details: { trx, txID: built.txID, ok },
      })
      return json({ ok, txid: built.txID, info: await buildInfo(addr) })
    }

    if (action === 'withdraw') {
      const built = await rpc('/wallet/withdrawexpireunfreeze', {
        owner_address: addr, visible: true,
      })
      if (!built?.txID) return json({ error: 'nothing_to_withdraw', detail: built }, 400)
      const bc = await signAndSend(built, priv)
      const ok = bc?.result === true || !!bc?.txid
      await sb().rpc('admin_log', {
        p_level: ok ? 'info' : 'warn', p_source: 'edge:tron-treasury',
        p_message: 'withdraw', p_details: { txID: built.txID, ok },
      })
      return json({ ok, txid: built.txID, info: await buildInfo(addr) })
    }

    return json({ error: 'unknown_action' }, 400)
  } catch (e) {
    try {
      await sb().rpc('admin_log', {
        p_level: 'error', p_source: 'edge:tron-treasury',
        p_message: 'unhandled', p_details: { err: String(e).slice(0, 400) },
      })
    } catch { /* noop */ }
    return json({ error: 'internal', detail: String(e).slice(0, 200) }, 500)
  }
})
