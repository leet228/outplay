// ╔══════════════════════════════════════════════════════════════╗
// ║  process-crypto-withdrawals — auto user payouts (HD-0)        ║
// ╚══════════════════════════════════════════════════════════════╝
//
// Pays the 6 non-TON rails from the treasury automatically:
//   trx · usdt-trc20 · eth · usdt-erc20 · usdc-erc20 · usdc-bep20
// (TON + USDT-TON keep their own proven process-withdrawals path.)
//
// Signing is ported verbatim from treasury-withdraw (proven on
// chain). Flow: pick one pending row → convert net_rub → coin via
// live price → send → complete/fail (fail auto-refunds in SQL).
// Gated by app_settings.crypto_payout_enabled (arming switch);
// while false the queue just sits. Cron every minute + UI ping.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  HDNodeWallet, JsonRpcProvider, FetchRequest, Wallet, Contract,
  SigningKey, keccak256, sha256, getBytes, encodeBase58, decodeBase58,
  parseEther, parseUnits,
} from 'https://esm.sh/ethers@6.13.4'

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
// Anon key = proven-valid JWT for the Functions gateway (the
// service-role key can be a non-JWT secret → 'invalid JWT').
// dex-swap has its own admin gate, so anon here is safe.
const SUPABASE_ANON_KEY    = Deno.env.get('SUPABASE_ANON_KEY') || ''
const HD_MASTER_MNEMONIC   = Deno.env.get('HD_MASTER_MNEMONIC') || ''
const NOWNODES_API_KEY     = Deno.env.get('NOWNODES_API_KEY') || ''
const BOT_TOKEN            = Deno.env.get('TELEGRAM_BOT_TOKEN') || ''
const ADMIN_TG_ID          = Deno.env.get('ADMIN_TG_ID') || '945676433'
const TG = BOT_TOKEN ? `https://api.telegram.org/bot${BOT_TOKEN}` : ''

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } })
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
const safe = async <T>(p: Promise<T>, d: T): Promise<T> => { try { return await p } catch { return d } }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ── Global treasury lock (shared HD-0; serializes vs dex-swap /
// treasury-withdraw so EVM nonce / TRON never race). ──
async function acquireLock(channel: string, holder: string, ttl = 120, waitMs = 40_000): Promise<string | null> {
  const deadline = Date.now() + waitMs
  for (;;) {
    const { data } = await sb.rpc('acquire_treasury_lock', { p_channel: channel, p_holder: holder, p_ttl: ttl })
    if (data?.ok) return data.token as string
    if (Date.now() > deadline) return null
    await sleep(2_000)
  }
}
async function releaseLock(channel: string, token: string) {
  try { await sb.rpc('release_treasury_lock', { p_channel: channel, p_token: token }) } catch { /* noop */ }
}
const lockChannel = (chain: string) =>
  EVM_NET[chain] ? (EVM_NET[chain] === 'bsc' ? 'bsc' : 'eth') : 'tron'

const WALL_CLOCK_MS = 50_000
const MAX_PER_RUN   = 6

// ── price feed (mirrors daily-admin-report) ──
async function px(id: number): Promise<number> {
  try {
    const r = await fetch(`https://api.coinlore.net/api/ticker/?id=${id}`)
    const p = parseFloat((await r.json())?.[0]?.price_usd)
    return Number.isFinite(p) && p > 0 ? p : 0
  } catch { return 0 }
}
async function usdRub(): Promise<number> {
  try {
    const r = await fetch('https://api.exchangerate-api.com/v4/latest/USD')
    return (await r.json())?.rates?.RUB ?? 90
  } catch { return 90 }
}

// ── EVM (ported from treasury-withdraw) ──
const EVM_NET: Record<string, 'eth' | 'bsc'> = {
  eth: 'eth', 'usdt-erc20': 'eth', 'usdc-erc20': 'eth', 'usdc-bep20': 'bsc',
}
const EVM_TOKEN: Record<string, { addr: string; dec: number }> = {
  'usdt-erc20': { addr: '0xdAC17F958D2ee523a2206206994597C13D831ec7', dec: 6 },
  'usdc-erc20': { addr: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', dec: 6 },
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

// ── EVM nonce manager ──
// EVM accounts have a sequential `nonce` (the seqno analogue). The
// queue is already serialized, but we still manage nonce explicitly
// so two fast consecutive sends can't reuse the same value if the
// node hasn't yet reflected the first in its 'pending' count.
//
// Per invocation, per network: lazily seed from the chain's
// 'pending' count (the source of truth — already includes any
// still-mempooled tx from a previous run), then hand out
// nonce, nonce+1, … incrementing ONLY after a successful
// broadcast. On any send error we drop the cached value so the
// next withdrawal re-reads the chain (self-heals if a tx slipped
// through or got dropped). One Wallet/provider per network, reused.
class EvmNonce {
  private wallets = new Map<'eth' | 'bsc', Wallet>()
  private next = new Map<'eth' | 'bsc', number>()

  wallet(net: 'eth' | 'bsc'): Wallet {
    let w = this.wallets.get(net)
    if (!w) {
      w = new Wallet(evmTreasury().privateKey, evmProvider(net))
      this.wallets.set(net, w)
    }
    return w
  }
  async take(net: 'eth' | 'bsc'): Promise<number> {
    if (!this.next.has(net)) {
      const n = await this.wallet(net).getNonce('pending')
      this.next.set(net, n)
    }
    return this.next.get(net)!
  }
  consumed(net: 'eth' | 'bsc') {
    this.next.set(net, (this.next.get(net) ?? 0) + 1)
  }
  reset(net: 'eth' | 'bsc') {
    this.next.delete(net)
  }
}

// ── TRON (ported from treasury-withdraw) ──
const TRON_API  = 'https://trx.nownodes.io'
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
function isEvmAddr(a: string) { return /^0x[a-fA-F0-9]{40}$/.test(a) }
function isTronAddr(a: string) { return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a) }

// net_rub → coin units at live price.
function toCoin(chain: string, netUsd: number, pEth: number, pTrx: number): number {
  if (chain === 'eth') return pEth > 0 ? netUsd / pEth : 0
  if (chain === 'trx') return pTrx > 0 ? netUsd / pTrx : 0
  return netUsd // stablecoins ≈ $1
}

// ── Treasury balance readers (read-only; HD-0 public addrs) ──
const T_EVM      = '0x71740514b90aC31d0Ba0fF772107Ab5bA8496Ac2'
const T_EVM_LC   = T_EVM.toLowerCase().slice(2)
const T_TRON     = 'TNLov2u5DuHKiSJpQHziqb8Gcov2GQWZw4'
const T_TRON20HX = '87b763889b9edeee35caff2ffc56170fca1d10a0'
const num = (h: string) => { try { return Number(BigInt(h)) } catch { return 0 } }
async function rpcEvmRead(net: 'eth' | 'bsc', method: string, params: unknown[]) {
  const r = await fetch(RPC[net], {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'api-key': NOWNODES_API_KEY },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const j = await r.json()
  if (j.error) throw new Error(j.error.message)
  return j.result as string
}
const evmNativeBal = async (net: 'eth' | 'bsc') =>
  num(await rpcEvmRead(net, 'eth_getBalance', [T_EVM, 'latest'])) / 1e18
const evmTokenBal = async (net: 'eth' | 'bsc', c: string, dec: number) =>
  num(await rpcEvmRead(net, 'eth_call', [{ to: c, data: '0x70a08231' + '0'.repeat(24) + T_EVM_LC }, 'latest'])) / 10 ** dec
async function tronTrxBal(): Promise<number> {
  const r = await fetch(`${TRON_API}/wallet/getaccount`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'api-key': NOWNODES_API_KEY },
    body: JSON.stringify({ address: T_TRON, visible: true }),
  })
  return Number((await r.json())?.balance || 0) / 1e6
}
async function tronUsdtBal(): Promise<number> {
  const r = await fetch(`${TRON_API}/wallet/triggerconstantcontract`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'api-key': NOWNODES_API_KEY },
    body: JSON.stringify({
      owner_address: T_TRON, contract_address: TRON_USDT,
      function_selector: 'balanceOf(address)',
      parameter: '0'.repeat(24) + T_TRON20HX, visible: true,
    }),
  })
  const h = (await r.json())?.constant_result?.[0]
  return h ? num('0x' + h) / 1e6 : 0
}

// Balance of the REQUESTED coin in the treasury (target units).
function targetBalance(chain: string): Promise<number> {
  if (chain === 'eth') return evmNativeBal('eth')
  if (chain === 'trx') return tronTrxBal()
  if (chain === 'usdt-trc20') return tronUsdtBal()
  const t = EVM_TOKEN[chain]                       // usdt/usdc erc20/bep20
  return evmTokenBal(EVM_NET[chain], t.addr, t.dec)
}
// USD price of the requested coin (stablecoins ≈ 1).
function targetUsd(chain: string, pEth: number, pTrx: number): number {
  if (chain === 'eth') return pEth
  if (chain === 'trx') return pTrx
  return 1
}
// Backup asset that funds a short payout via a dex-swap.
//   dir       — dex-swap direction (backup → target)
//   bal()     — backup balance in backup units
//   usd()     — backup USD price
//   reserve   — native units to KEEP for gas (0 for token backups)
interface Backup { dir: string; bal: () => Promise<number>; usd: () => number; reserve: number }
function backupOf(chain: string, pEth: number, pBnb: number, pTrx: number): Backup | null {
  switch (chain) {
    case 'eth':        return { dir: 'usdt_to_eth', bal: () => evmTokenBal('eth', EVM_TOKEN['usdt-erc20'].addr, 6), usd: () => 1,    reserve: 0 }
    case 'usdt-erc20': return { dir: 'eth_to_usdt', bal: () => evmNativeBal('eth'), usd: () => pEth, reserve: 0.01 }
    case 'usdc-erc20': return { dir: 'eth_to_usdc', bal: () => evmNativeBal('eth'), usd: () => pEth, reserve: 0.01 }
    case 'usdc-bep20': return { dir: 'bnb_to_usdc', bal: () => evmNativeBal('bsc'), usd: () => pBnb, reserve: 0.01 }
    case 'trx':        return { dir: 'usdt_to_trx', bal: () => tronUsdtBal(),       usd: () => 1,    reserve: 0 }
    case 'usdt-trc20': return { dir: 'trx_to_usdt', bal: () => tronTrxBal(),        usd: () => pTrx, reserve: 200 }
    default: return null
  }
}

let _adminId: string | null | undefined
async function adminUserId(): Promise<string | null> {
  if (_adminId !== undefined) return _adminId
  const { data } = await sb.from('users')
    .select('id').eq('telegram_id', ADMIN_TG_ID).maybeSingle()
  _adminId = data?.id ?? null
  return _adminId
}
async function callDexSwap(userId: string, dir: string, amount: number) {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/dex-swap`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ user_id: userId, dir, amount: amount.toFixed(8), slippage: 0.01 }),
  })
  return r.json().catch(() => ({ error: `http_${r.status}` }))
}
const SWAP_HEADROOM = 1.03   // swap 3% extra to absorb slippage+fees

async function sendPayout(
  chain: string, to: string, coin: number, nm: EvmNonce,
): Promise<string> {
  const amt = coin.toFixed(chain === 'eth' ? 8 : 6)

  if (EVM_NET[chain]) {
    if (!isEvmAddr(to)) throw new Error('bad_evm_address')
    const net = EVM_NET[chain]
    const w = nm.wallet(net)
    const nonce = await nm.take(net)
    try {
      let hash: string
      if (chain === 'eth') {
        const tx = await w.sendTransaction({ to, value: parseEther(amt), nonce })
        hash = tx.hash
      } else {
        const tk = EVM_TOKEN[chain]
        const c = new Contract(tk.addr, ERC20, w)
        const tx = await c.transfer(to, parseUnits(amt, tk.dec), { nonce })
        hash = tx.hash
      }
      nm.consumed(net)          // advance ONLY after a clean broadcast
      return hash
    } catch (e) {
      nm.reset(net)             // re-read chain truth on the next one
      throw e
    }
  }

  if (chain === 'trx' || chain === 'usdt-trc20') {
    if (!isTronAddr(to)) throw new Error('bad_tron_address')
    const priv = tronPriv()
    const from = tronAddr(priv)
    if (chain === 'trx') {
      const built = await tronRpc('/wallet/createtransaction', {
        owner_address: from, to_address: to,
        amount: Math.round(Number(amt) * 1e6), visible: true,
      })
      if (!built?.txID) throw new Error('build_failed')
      const r = await tronRpc('/wallet/broadcasttransaction', tronSign(built, priv))
      if (r?.result !== true && !r?.txid) throw new Error('broadcast_failed')
      return built.txID
    }
    const toParam = '0'.repeat(24) +
      Array.from(tronB21(to).slice(1)).map(x => x.toString(16).padStart(2, '0')).join('')
    const amtRaw = BigInt(Math.round(Number(amt) * 1e6)).toString(16).padStart(64, '0')
    const r0 = await tronRpc('/wallet/triggersmartcontract', {
      owner_address: from, contract_address: TRON_USDT,
      function_selector: 'transfer(address,uint256)',
      parameter: toParam + amtRaw, fee_limit: 50_000_000, call_value: 0, visible: true,
    })
    const tx = r0?.transaction
    if (!tx?.txID) throw new Error('build_failed')
    const r = await tronRpc('/wallet/broadcasttransaction', tronSign(tx, priv))
    if (r?.result !== true && !r?.txid) throw new Error('broadcast_failed')
    return tx.txID
  }

  throw new Error('unknown_chain')
}

async function tg(text: string) {
  if (!TG) return
  await safe(fetch(`${TG}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: ADMIN_TG_ID, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  }).then(() => true), false)
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    if (!HD_MASTER_MNEMONIC) return json({ error: 'no_master' }, 500)

    const body = await req.json().catch(() => ({}))

    // ── action:'request' — feasibility gate + atomic deduct ──
    // Checks the treasury can actually fund this (coin in hand OR
    // enough backup to swap, incl. the 3% headroom). Only then
    // does it call the deduct RPC — so a network we can't cover
    // returns 'network_unavailable' WITHOUT touching the balance.
    if (body?.action === 'request') {
      const user_id = body.user_id
      const chain   = String(body.chain || '')
      const to      = String(body.to || '').trim()
      const amount  = Math.round(Number(body.amount_rub) || 0)
      if (!user_id || !(amount > 0) || !backupOf(chain, 1, 1, 1)) {
        return json({ error: 'bad_params' }, 400)
      }
      const okAddr = EVM_NET[chain] ? isEvmAddr(to) : isTronAddr(to)
      if (!okAddr) return json({ error: 'bad_address' }, 400)

      const { data: cfgRow } = await sb.from('app_settings')
        .select('value').eq('key', 'crypto_withdraw_cfg').maybeSingle()
      const cc = (cfgRow?.value as any)?.[chain] || {}
      const vMin = Number(cc.min ?? 500)
      const vGas = Number(cc.gas ?? 100)
      if (amount < vMin) return json({ error: 'min_amount', min: vMin })
      const fee = Math.ceil(amount * 0.01)
      const net = amount - fee - vGas
      if (net <= 0) return json({ error: 'amount_too_small_after_fees' })

      const [qEth, qBnb, qTrx, qRate] = await Promise.all([
        safe(px(80), 0), safe(px(2710), 0), safe(px(2713), 0), safe(usdRub(), 90),
      ])
      const netUsd = qRate > 0 ? net / qRate : 0
      const coin = toCoin(chain, netUsd, qEth, qTrx)
      if (!(coin > 0)) return json({ error: 'price_unavailable' }, 503)

      let feasible = false
      try {
        const bal = await targetBalance(chain)
        if (bal >= coin) feasible = true
        else {
          const bk = backupOf(chain, qEth, qBnb, qTrx)!
          const tUsd = targetUsd(chain, qEth, qTrx)
          const bUsd = bk.usd()
          if (tUsd > 0 && bUsd > 0) {
            const need = ((coin - bal) * tUsd * SWAP_HEADROOM) / bUsd
            const bkBal = await bk.bal()
            const avail = bk.reserve > 0 ? Math.max(0, bkBal - bk.reserve) : bkBal
            if (avail >= need) feasible = true
          }
        }
      } catch (_e) {
        return json({ error: 'price_unavailable' }, 503)
      }
      if (!feasible) return json({ error: 'network_unavailable' }, 200)

      const { data: rpc } = await sb.rpc('request_crypto_withdrawal', {
        p_user_id: user_id, p_amount_rub: amount, p_chain: chain, p_to: to,
      })
      return json(rpc ?? { error: 'rpc_failed' })
    }

    const { data: en } = await sb.from('app_settings')
      .select('value').eq('key', 'crypto_payout_enabled').maybeSingle()
    const enabled = en?.value === true || en?.value === 'true'
    if (!enabled) return json({ ok: true, skipped: 'disabled' })

    const [pEth, pBnb, pTrx, rate] = await Promise.all([
      safe(px(80), 0), safe(px(2710), 0), safe(px(2713), 0), safe(usdRub(), 90),
    ])

    const started = Date.now()
    const done: any[] = []
    const nm = new EvmNonce()   // one manager per invocation

    for (let i = 0; i < MAX_PER_RUN; i++) {
      if (Date.now() - started > WALL_CLOCK_MS) break
      const { data: rows } = await sb.rpc('pick_pending_crypto_withdrawal')
      const row = Array.isArray(rows) ? rows[0] : rows
      if (!row?.id) break

      try {
        const netUsd = rate > 0 ? Number(row.net_rub) / rate : 0
        const coin = toCoin(row.chain, netUsd, pEth, pTrx)
        if (!(coin > 0)) throw new Error('zero_amount (price feed?)')

        // 1. Enough of the requested coin already? → pay out.
        const bal = await targetBalance(row.chain)
        if (bal >= coin) {
          const ch = lockChannel(row.chain)
          const lock = await acquireLock(ch, 'crypto-withdraw')
          if (!lock) {
            // treasury busy — keep state, retry next tick
            await sb.rpc(row.swap_txid ? 'crypto_back_to_swapping' : 'requeue_crypto_pending', { p_id: row.id })
            break
          }
          let txid = ''
          try {
            txid = await sendPayout(row.chain, row.to_address, coin, nm)
          } finally {
            await releaseLock(ch, lock)
          }
          await sb.rpc('complete_crypto_withdrawal', {
            p_id: row.id, p_tx_hash: txid, p_coin_amount: coin,
          })
          done.push({ id: row.id, chain: row.chain, txid, coin })
          await tg(`✅ <b>Вывод выполнен</b>\n${row.chain} · ${coin.toFixed(6)}\n→ <code>${row.to_address}</code>\ntx: <code>${txid}</code>`)
          continue
        }

        // 2. A swap was already fired but the coin still hasn't
        //    landed → keep waiting (SQL 12-min guard refunds it).
        if (row.swap_txid) {
          await sb.rpc('crypto_back_to_swapping', { p_id: row.id })
          done.push({ id: row.id, chain: row.chain, waiting_swap: row.swap_txid })
          continue
        }

        // 3. Short, no swap yet → can the backup asset cover it?
        const bk = backupOf(row.chain, pEth, pBnb, pTrx)
        if (!bk) throw new Error('no_backup_route')
        const tUsd = targetUsd(row.chain, pEth, pTrx)
        const bUsd = bk.usd()
        if (!(tUsd > 0) || !(bUsd > 0)) throw new Error('no_price')

        const shortfall = coin - bal
        const needBackup = (shortfall * tUsd * SWAP_HEADROOM) / bUsd
        const bkBal = await bk.bal()
        const avail = bk.reserve > 0 ? Math.max(0, bkBal - bk.reserve) : bkBal
        if (avail < needBackup) {
          throw new Error(`treasury_short: need ~${needBackup.toFixed(4)} backup, have ${avail.toFixed(4)}`)
        }

        // 4. Fire the swap via dex-swap (it self-locks its chain;
        //    we hold NO lock here → no deadlock).
        const admin = await adminUserId()
        if (!admin) throw new Error('no_admin_user')
        const sr = await callDexSwap(admin, bk.dir, needBackup)
        if (sr?.step === 'approved') {
          // allowance set — retry the whole row next tick
          await sb.rpc('requeue_crypto_pending', { p_id: row.id })
          done.push({ id: row.id, chain: row.chain, approved: sr.txid })
          continue
        }
        if (sr?.ok && sr?.step === 'swap') {
          await sb.rpc('mark_crypto_swapping', { p_id: row.id, p_txid: sr.txid })
          done.push({ id: row.id, chain: row.chain, swap: sr.txid })
          await tg(`🔄 <b>Свап под вывод</b>\n${row.chain}: ${bk.dir} · ~${needBackup.toFixed(4)}\ntx: <code>${sr.txid}</code>\nвывод уйдёт после подтверждения свапа`)
          continue
        }
        // Transient (treasury lock busy / RPC 5xx) → retry, do NOT
        // refund. Only a genuine swap rejection fails the row.
        const se = String(sr?.error || '')
        if (se === 'treasury_busy' || /^http_5/.test(se) || se === 'no_hd_master') {
          await sb.rpc('requeue_crypto_pending', { p_id: row.id })
          done.push({ id: row.id, chain: row.chain, retry: se })
          break
        }
        throw new Error(`swap_failed: ${se || JSON.stringify(sr).slice(0, 120)}`)
      } catch (e) {
        const err = String(e).slice(0, 200)
        await sb.rpc('fail_crypto_withdrawal', { p_id: row.id, p_error: err })
        done.push({ id: row.id, chain: row.chain, error: err })
        await tg(`❌ <b>Вывод не прошёл</b> (баланс возвращён)\n${row.chain} → <code>${row.to_address}</code>\n${err}`)
      }
    }

    return json({ ok: true, processed: done.length, done })
  } catch (e) {
    await safe(sb.rpc('admin_log', {
      p_level: 'error', p_source: 'edge:process-crypto-withdrawals',
      p_message: 'unhandled', p_details: { err: String(e).slice(0, 400) },
    }).then(() => true), false)
    return json({ error: 'internal', detail: String(e).slice(0, 200) }, 500)
  }
})
