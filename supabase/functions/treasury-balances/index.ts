// ╔══════════════════════════════════════════════════════════════╗
// ║  treasury-balances — server-side, cached, NowNodes-backed    ║
// ╚══════════════════════════════════════════════════════════════╝
//
// Admin Wallet/Dashboard read every HD-0 treasury balance from
// here. Server-side over the PAID NowNodes key, cached 60s in
// app_settings so reloads/polls don't hammer upstream. Read-only.
// Shape: { assets, totalUsd, ok, ts }.
//
// Robustness (why balances no longer drop to 0): every upstream
// call has a timeout + one retry, and if it still fails the asset
// keeps its LAST KNOWN value from the previous cache instead of
// falling to 0 — so a transient NowNodes hiccup can't zero a
// wallet or poison the 60s cache.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const NOWNODES_API_KEY     = Deno.env.get('NOWNODES_API_KEY') || ''
const CACHE_KEY  = 'mc_bal_cache'
const CACHE_TTL  = 60_000  // ms

const T_EVM  = '0x71740514b90aC31d0Ba0fF772107Ab5bA8496Ac2'
const T_EVM_LC = T_EVM.toLowerCase().slice(2)
const T_TRON = 'TNLov2u5DuHKiSJpQHziqb8Gcov2GQWZw4'
const T_TRON20HEX = '87b763889b9edeee35caff2ffc56170fca1d10a0'
const T_BTC  = 'bc1qprd6zdx8kv73xup6ed9rypnedxcltm89k8pfzk'
const T_LTC  = 'ltc1qc65xapvmpzqesmvajncddleww3gxuy7z7jku6g'
const TRON_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const j = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } })
const num = (h: string) => { try { return Number(BigInt(h)) } catch { return 0 } }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// fetch with an 8s timeout (a hung upstream must not stall the run).
async function tf(url: string, opts: RequestInit = {}, ms = 8000) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), ms)
  try { return await fetch(url, { ...opts, signal: ac.signal }) }
  finally { clearTimeout(t) }
}
// run fn, retry once on any failure, then propagate.
async function retry<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn() }
  catch { await sleep(500); return await fn() }
}
// retry + on total failure return the previous-known value (fb)
// instead of throwing/zeroing.
async function keep<T>(fn: () => Promise<T>, fb: T): Promise<T> {
  try { return await retry(fn) } catch { return fb }
}

async function rpcEvm(net: 'eth' | 'bsc', method: string, params: unknown[]) {
  const r = await tf(`https://${net}.nownodes.io`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'api-key': NOWNODES_API_KEY },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const d = await r.json()
  if (d.error) throw new Error(d.error.message)
  return d.result as string
}
const evmNative = async (n: 'eth' | 'bsc') =>
  num(await rpcEvm(n, 'eth_getBalance', [T_EVM, 'latest'])) / 1e18
const evmTok = async (n: 'eth' | 'bsc', c: string, dec: number) =>
  num(await rpcEvm(n, 'eth_call', [{ to: c, data: '0x70a08231' + '0'.repeat(24) + T_EVM_LC }, 'latest'])) / 10 ** dec

async function tronTrx() {
  const r = await tf('https://trx.nownodes.io/wallet/getaccount', {
    method: 'POST', headers: { 'content-type': 'application/json', 'api-key': NOWNODES_API_KEY },
    body: JSON.stringify({ address: T_TRON, visible: true }),
  })
  return Number((await r.json())?.balance || 0) / 1e6
}
async function tronUsdt() {
  const r = await tf('https://trx.nownodes.io/wallet/triggerconstantcontract', {
    method: 'POST', headers: { 'content-type': 'application/json', 'api-key': NOWNODES_API_KEY },
    body: JSON.stringify({
      owner_address: T_TRON, contract_address: TRON_USDT,
      function_selector: 'balanceOf(address)',
      parameter: '0'.repeat(24) + T_TRON20HEX, visible: true,
    }),
  })
  const h = (await r.json())?.constant_result?.[0]
  return h ? num('0x' + h) / 1e6 : 0
}
async function bb(host: string, addr: string) {
  const r = await tf(`https://${host}/api/v2/address/${addr}`, {
    headers: { 'api-key': NOWNODES_API_KEY },
  })
  return Number((await r.json())?.balance || 0) / 1e8
}
async function px(id: number) {
  const r = await tf(`https://api.coinlore.net/api/ticker/?id=${id}`)
  const p = parseFloat((await r.json())?.[0]?.price_usd)
  return Number.isFinite(p) && p > 0 ? p : null
}

async function build(prev: any) {
  // last-known value per asset id from the previous cache.
  const pa: Record<string, { amount: number; priceUsd: number | null }> = {}
  for (const a of (prev?.assets || [])) pa[a.id] = { amount: Number(a.amount) || 0, priceUsd: a.priceUsd ?? null }
  const A = (id: string) => pa[id]?.amount ?? 0
  const P = (id: string) => pa[id]?.priceUsd ?? null

  const [
    ethN, eU, eC, bnbN, bU, bC, trx, tU, btc, ltc,
    pEth, pBnb, pTrx, pBtc, pLtc,
  ] = await Promise.all([
    keep(() => evmNative('eth'), A('eth')),
    keep(() => evmTok('eth', '0xdac17f958d2ee523a2206206994597c13d831ec7', 6), A('usdt-erc20')),
    keep(() => evmTok('eth', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 6), A('usdc-erc20')),
    keep(() => evmNative('bsc'), A('bnb')),
    keep(() => evmTok('bsc', '0x55d398326f99059ff775485246999027b3197955', 18), A('usdt-bep20')),
    keep(() => evmTok('bsc', '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', 18), A('usdc-bep20')),
    keep(() => tronTrx(), A('trx')),
    keep(() => tronUsdt(), A('usdt-trc20')),
    keep(() => bb('btcbook.nownodes.io', T_BTC), A('btc')),
    keep(() => bb('ltcbook.nownodes.io', T_LTC), A('ltc')),
    keep(() => px(80), P('eth')),
    keep(() => px(2710), P('bnb')),
    keep(() => px(2713), P('trx')),
    keep(() => px(90), P('btc')),
    keep(() => px(1), P('ltc')),
  ])
  const mk = (id: string, symbol: string, network: string, address: string,
              amount: number, priceUsd: number | null) => ({
    id, symbol, name: symbol, network, address,
    amount, priceUsd,
    usd: priceUsd != null ? amount * priceUsd : null,
  })
  const assets = [
    mk('trx', 'TRX', 'Tron', T_TRON, trx, pTrx),
    mk('usdt-trc20', 'USDT', 'Tron · TRC20', T_TRON, tU, 1),
    mk('eth', 'ETH', 'Ethereum', T_EVM, ethN, pEth),
    mk('usdt-erc20', 'USDT', 'Ethereum · ERC20', T_EVM, eU, 1),
    mk('usdc-erc20', 'USDC', 'Ethereum · ERC20', T_EVM, eC, 1),
    mk('bnb', 'BNB', 'BNB Smart Chain', T_EVM, bnbN, pBnb),
    mk('usdt-bep20', 'USDT', 'BNB Smart Chain · BEP20', T_EVM, bU, 1),
    mk('usdc-bep20', 'USDC', 'BNB Smart Chain · BEP20', T_EVM, bC, 1),
    mk('btc', 'BTC', 'Bitcoin', T_BTC, btc, pBtc),
    mk('ltc', 'LTC', 'Litecoin', T_LTC, ltc, pLtc),
  ]
  const totalUsd = assets.reduce((s, a) => s + (a.usd || 0), 0)
  return { assets, totalUsd, ok: true, ts: Date.now() }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  let cached: any = null
  try {
    const { data: row } = await sb.from('app_settings')
      .select('value').eq('key', CACHE_KEY).maybeSingle()
    cached = row?.value
    if (cached && typeof cached === 'object' && cached.ts &&
        Date.now() - cached.ts < CACHE_TTL) {
      return j({ ...cached, cached: true })
    }
    // Build fresh; failed assets fall back to the previous cache.
    const fresh = await build(cached)
    await sb.from('app_settings').upsert(
      { key: CACHE_KEY, value: fresh, updated_at: new Date().toISOString() },
      { onConflict: 'key' },
    )
    return j({ ...fresh, cached: false })
  } catch (e) {
    // Total failure → serve the last good snapshot rather than 0s.
    if (cached && typeof cached === 'object' && cached.assets) {
      return j({ ...cached, cached: true, stale: true })
    }
    return j({ error: String(e).slice(0, 200), ok: false }, 500)
  }
})
