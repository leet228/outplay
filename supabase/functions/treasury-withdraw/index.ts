// ╔══════════════════════════════════════════════════════════════╗
// ║  treasury-withdraw — admin payout from the treasury (HD 0)   ║
// ╚══════════════════════════════════════════════════════════════╝
//
// Admin-only. Sends a chosen amount of a chosen coin FROM the
// treasury (HD index 0, server-derived) to an arbitrary address.
// Self-contained (inlined signing — no _shared so the Supabase
// bundler is happy). Mirrors the existing TON/USDT admin payout,
// extended to the new chains.
//
// POST { user_id, chain, to, amount }
//   chain ∈ eth|bnb|usdt-erc20|usdc-erc20|usdt-bep20|usdc-bep20|
//           trx|usdt-trc20|btc|ltc
//   amount = decimal string in COIN units (e.g. "0.5", "100").

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  HDNodeWallet, JsonRpcProvider, FetchRequest, Wallet, Contract,
  SigningKey, keccak256, sha256, getBytes, encodeBase58, decodeBase58,
  parseEther, parseUnits,
} from 'https://esm.sh/ethers@6.13.4'
import * as btc from 'https://esm.sh/@scure/btc-signer@1.3.2'
import { secp256k1 } from 'https://esm.sh/@noble/curves@1.6.0/secp256k1'

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const HD_MASTER_MNEMONIC   = Deno.env.get('HD_MASTER_MNEMONIC') || ''
const NOWNODES_API_KEY     = Deno.env.get('NOWNODES_API_KEY') || ''
const ADMIN_TG             = Deno.env.get('ADMIN_TELEGRAM_ID') || '945676433'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } })

let sbc: ReturnType<typeof createClient>
const sb = () => (sbc ??= createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY))

// ── Global treasury lock (shared HD-0; serializes vs dex-swap /
// process-crypto-withdrawals so EVM nonce / TRON / UTXO never
// race). TON is not covered (separate Highload wallet). ──
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function acquireLock(channel: string, holder: string, ttl = 120, waitMs = 90_000): Promise<string | null> {
  const deadline = Date.now() + waitMs
  for (;;) {
    const { data } = await sb().rpc('acquire_treasury_lock', { p_channel: channel, p_holder: holder, p_ttl: ttl })
    if ((data as any)?.ok) return (data as any).token as string
    if (Date.now() > deadline) return null
    await sleep(2_000)
  }
}
async function releaseLock(channel: string, token: string) {
  try { await sb().rpc('release_treasury_lock', { p_channel: channel, p_token: token }) } catch { /* noop */ }
}

// ── EVM ──
const EVM_NET: Record<string, 'eth' | 'bsc'> = {
  eth: 'eth', 'usdt-erc20': 'eth', 'usdc-erc20': 'eth',
  bnb: 'bsc', 'usdt-bep20': 'bsc', 'usdc-bep20': 'bsc',
}
const EVM_TOKEN: Record<string, { addr: string; dec: number }> = {
  'usdt-erc20': { addr: '0xdAC17F958D2ee523a2206206994597C13D831ec7', dec: 6 },
  'usdc-erc20': { addr: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', dec: 6 },
  'usdt-bep20': { addr: '0x55d398326f99059fF775485246999027B3197955', dec: 18 },
  'usdc-bep20': { addr: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', dec: 18 },
}
const RPC = { eth: 'https://eth.nownodes.io', bsc: 'https://bsc.nownodes.io' }
const ERC20 = ['function transfer(address,uint256) returns (bool)']
const evmTreasury = () =>
  HDNodeWallet.fromPhrase(HD_MASTER_MNEMONIC, undefined, "m/44'/60'/0'/0/0")
function evmProvider(n: 'eth' | 'bsc') {
  const fr = new FetchRequest(RPC[n])
  if (NOWNODES_API_KEY) fr.setHeader('api-key', NOWNODES_API_KEY)
  return new JsonRpcProvider(fr)
}

// ── TRON ──
const TRON_API = 'https://trx.nownodes.io'
const TRON_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const tronPriv = () =>
  HDNodeWallet.fromPhrase(HD_MASTER_MNEMONIC, undefined, "m/44'/195'/0'/0/0").privateKey
function tronAddr(priv: string) {
  const pub = getBytes(SigningKey.computePublicKey(priv, false)).slice(1)
  const h = getBytes(keccak256(pub))
  const a = new Uint8Array(21); a[0] = 0x41; a.set(h.slice(-20), 1)
  const c = getBytes(sha256(sha256(a))).slice(0, 4)
  const f = new Uint8Array(25); f.set(a, 0); f.set(c, 21)
  return encodeBase58(f)
}
function tronB21(b58: string) {
  let h = decodeBase58(b58).toString(16); if (h.length % 2) h = '0' + h
  return getBytes('0x' + h).slice(0, 21)
}
async function tronRpc(path: string, body: unknown) {
  const h: Record<string, string> = { 'content-type': 'application/json' }
  if (NOWNODES_API_KEY) h['api-key'] = NOWNODES_API_KEY
  const r = await fetch(TRON_API + path, { method: 'POST', headers: h, body: JSON.stringify(body) })
  if (!r.ok) throw new Error(`tron ${path} ${r.status}`)
  return r.json()
}
function tronSign(tx: any, priv: string) {
  const s = new SigningKey(priv).sign('0x' + tx.txID)
  return { ...tx, signature: [s.r.slice(2) + s.s.slice(2) + (s.yParity ? '01' : '00')] }
}

// ── UTXO ──
const LTC_NET = { bech32: 'ltc', pubKeyHash: 0x30, scriptHash: 0x32, wif: 0xb0 }
const UTXO = {
  btc: { host: 'btcbook.nownodes.io', path: "m/84'/0'/0'/0/0", net: btc.NETWORK, fb: 8 },
  ltc: { host: 'ltcbook.nownodes.io', path: "m/84'/2'/0'/0/0", net: LTC_NET, fb: 4 },
}
async function bb(host: string, path: string) {
  const r = await fetch(`https://${host}${path}`, {
    headers: NOWNODES_API_KEY ? { 'api-key': NOWNODES_API_KEY } : {},
  })
  if (!r.ok) throw new Error(`${host} ${r.status}`)
  return r.json()
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    if (!HD_MASTER_MNEMONIC) return json({ error: 'no_master' }, 500)
    const { user_id, chain, to, amount } = await req.json().catch(() => ({}))
    if (!user_id || !chain || !to || !(Number(amount) > 0)) {
      return json({ error: 'bad_params' }, 400)
    }
    const { data: u } = await sb()
      .from('users').select('telegram_id').eq('id', user_id).maybeSingle()
    if (!u || String(u.telegram_id) !== String(ADMIN_TG)) return json({ error: 'forbidden' }, 403)

    const amt = String(amount)
    let txid = ''

    const lockCh = EVM_NET[chain] ? EVM_NET[chain]
      : (chain === 'trx' || chain === 'usdt-trc20') ? 'tron'
      : (chain === 'btc' || chain === 'ltc') ? chain
      : null
    if (!lockCh) return json({ error: 'unknown_chain' }, 400)
    const lock = await acquireLock(lockCh, 'treasury-withdraw')
    if (!lock) return json({ error: 'treasury_busy' }, 503)

    try {
    // ── EVM ──
    if (EVM_NET[chain]) {
      const net = EVM_NET[chain]
      const w = new Wallet(evmTreasury().privateKey, evmProvider(net))
      if (chain === 'eth' || chain === 'bnb') {
        const tx = await w.sendTransaction({ to, value: parseEther(amt) })
        txid = tx.hash
      } else {
        const tk = EVM_TOKEN[chain]
        const c = new Contract(tk.addr, ERC20, w)
        const tx = await c.transfer(to, parseUnits(amt, tk.dec))
        txid = tx.hash
      }
    }
    // ── TRON ──
    else if (chain === 'trx' || chain === 'usdt-trc20') {
      const priv = tronPriv()
      const from = tronAddr(priv)
      if (chain === 'trx') {
        const built = await tronRpc('/wallet/createtransaction', {
          owner_address: from, to_address: to,
          amount: Math.round(Number(amt) * 1e6), visible: true,
        })
        if (!built?.txID) return json({ error: 'build_failed', detail: built }, 502)
        const r = await tronRpc('/wallet/broadcasttransaction', tronSign(built, priv))
        if (r?.result !== true && !r?.txid) return json({ error: 'broadcast', detail: r }, 502)
        txid = built.txID
      } else {
        const toParam = '0'.repeat(24) +
          Array.from(tronB21(to).slice(1)).map(x => x.toString(16).padStart(2, '0')).join('')
        const amtRaw = BigInt(Math.round(Number(amt) * 1e6)).toString(16).padStart(64, '0')
        const r0 = await tronRpc('/wallet/triggersmartcontract', {
          owner_address: from, contract_address: TRON_USDT,
          function_selector: 'transfer(address,uint256)',
          parameter: toParam + amtRaw, fee_limit: 50_000_000, call_value: 0, visible: true,
        })
        const tx = r0?.transaction
        if (!tx?.txID) return json({ error: 'build_failed', detail: r0 }, 502)
        const r = await tronRpc('/wallet/broadcasttransaction', tronSign(tx, priv))
        if (r?.result !== true && !r?.txid) return json({ error: 'broadcast', detail: r }, 502)
        txid = tx.txID
      }
    }
    // ── BTC / LTC ──
    else if (chain === 'btc' || chain === 'ltc') {
      const cfg = UTXO[chain as 'btc' | 'ltc']
      const tp = HDNodeWallet.fromPhrase(HD_MASTER_MNEMONIC, undefined, cfg.path).privateKey
      const tpriv = getBytes(tp)
      const p2 = btc.p2wpkh(secp256k1.getPublicKey(tpriv, true), cfg.net)
      const utxos = await bb(cfg.host, `/api/v2/utxo/${p2.address}?confirmed=true`)
      const ins = (Array.isArray(utxos) ? utxos : [])
        .filter((x: any) => Number(x.confirmations || 0) >= 1)
        .map((x: any) => ({
          txid: x.txid, index: Number(x.vout),
          witnessUtxo: { script: p2.script, amount: BigInt(x.value) },
        }))
      if (ins.length === 0) return json({ error: 'no_utxo' }, 400)
      let satPerVb = cfg.fb
      try {
        const fe = await bb(cfg.host, '/api/v2/estimatefee/3')
        const k = Number(fe?.result || 0)
        if (k > 0) satPerVb = Math.max(1, Math.ceil(k * 1e8 / 1000))
      } catch { /* fb */ }
      const sendSat = BigInt(Math.round(Number(amt) * 1e8))
      const sel = btc.selectUTXO(ins, [{ address: to, amount: sendSat }], 'default', {
        changeAddress: p2.address, feePerByte: BigInt(satPerVb),
        bip69: true, createTx: true, network: cfg.net,
      })
      if (!sel?.tx) return json({ error: 'insufficient_or_dust' }, 400)
      sel.tx.sign(tpriv)
      sel.tx.finalize()
      const res = await bb(cfg.host, `/api/v2/sendtx/${sel.tx.hex}`)
      if (res?.error) return json({ error: 'broadcast', detail: res.error }, 502)
      txid = res?.result || sel.tx.id
    } else {
      return json({ error: 'unknown_chain' }, 400)
    }

    await sb().rpc('admin_log', {
      p_level: 'info', p_source: 'edge:treasury-withdraw',
      p_message: 'withdraw', p_details: { chain, to, amount: amt, txid },
    })
    return json({ ok: true, txid })
    } finally { await releaseLock(lockCh as string, lock as string) }
  } catch (e) {
    try {
      await sb().rpc('admin_log', {
        p_level: 'error', p_source: 'edge:treasury-withdraw',
        p_message: 'unhandled', p_details: { err: String(e).slice(0, 400) },
      })
    } catch { /* noop */ }
    return json({ error: 'internal', detail: String(e).slice(0, 200) }, 500)
  }
})
