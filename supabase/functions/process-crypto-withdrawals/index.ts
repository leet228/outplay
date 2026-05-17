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

    const { data: en } = await sb.from('app_settings')
      .select('value').eq('key', 'crypto_payout_enabled').maybeSingle()
    const enabled = en?.value === true || en?.value === 'true'
    if (!enabled) return json({ ok: true, skipped: 'disabled' })

    const [pEth, pTrx, rate] = await Promise.all([
      safe(px(80), 0), safe(px(2713), 0), safe(usdRub(), 90),
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

        const txid = await sendPayout(row.chain, row.to_address, coin, nm)
        await sb.rpc('complete_crypto_withdrawal', {
          p_id: row.id, p_tx_hash: txid, p_coin_amount: coin,
        })
        done.push({ id: row.id, chain: row.chain, txid, coin })
        await tg(`✅ <b>Вывод выполнен</b>\n${row.chain} · ${coin.toFixed(6)}\n→ <code>${row.to_address}</code>\ntx: <code>${txid}</code>`)
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
