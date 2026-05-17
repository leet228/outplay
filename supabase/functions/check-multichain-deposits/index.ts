// ╔══════════════════════════════════════════════════════════════╗
// ║  check-multichain-deposits — BTC/LTC/ETH/BSC/TRON indexer    ║
// ╚══════════════════════════════════════════════════════════════╝
//
// Step 3 of the deposit pipeline. Each user has their OWN derived
// address per chain (user_deposit_addresses, filled by
// derive-deposit-address). This worker walks those addresses on
// NowNodes, finds confirmed INCOMING transfers and credits the
// balance via the same process_crypto_deposit RPC the TON/USDT
// indexers use — dedup is the RPC's job (idempotent on p_tx_hash),
// so re-scanning recent history never double-credits.
//
// One EVM address serves ETH+BSC native + USDT/USDC ERC20/BEP20;
// the Tron address serves TRX + USDT-TRC20; BTC/LTC their coin.
//
// Endpoints (NowNodes, header `api-key`):
//   Blockbook: btcbook / ltcbook / ethbook / bscbook .nownodes.io
//   Tron:      trx.nownodes.io  (TronGrid-compatible v1)
//
// Scale: addresses are processed in a rotating window (cursor
// app_settings 'mc_deposits_offset') so a run stays inside the
// Edge time / rate budget; with few users it covers everyone.

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const NOWNODES_API_KEY     = Deno.env.get('NOWNODES_API_KEY') || ''

const MIN_RUB        = 200
const BATCH_USERS    = 60          // users scanned per invocation
const OFFSET_KEY     = 'mc_deposits_offset'

// Min confirmations before we credit (reorg safety per chain).
const CONFIRMS = { btc: 1, ltc: 2, eth: 6, bnb: 8, trx: 19 }

// Token contracts (lowercased) → { decimals, chainLabel }.
const EVM_TOKENS: Record<string, Record<string, { dec: number; label: string }>> = {
  eth: {
    '0xdac17f958d2ee523a2206206994597c13d831ec7': { dec: 6, label: 'usdt-erc20' },
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { dec: 6, label: 'usdc-erc20' },
  },
  bsc: {
    '0x55d398326f99059ff775485246999027b3197955': { dec: 18, label: 'usdt-bep20' },
    '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': { dec: 18, label: 'usdc-bep20' },
  },
}
const TRON_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'

// Treasury = HD index 0. The sweep funds user addresses with gas
// FROM the treasury; those inbound transfers must NOT be credited
// as user deposits (self-induced top-up loop). Skip anything sent
// by the treasury on every chain.
const TREASURY_EVM      = '0x71740514b90ac31d0ba0ff772107ab5ba8496ac2'
const TREASURY_TRON_B58 = 'TNLov2u5DuHKiSJpQHziqb8Gcov2GQWZw4'
const TREASURY_TRON_HEX = '4187b763889b9edeee35caff2ffc56170fca1d10a0'

let supabase: ReturnType<typeof createClient>
function getSupabase() {
  if (!supabase) supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  return supabase
}

async function logToAdmin(level: string, message: string, details: Record<string, unknown> = {}) {
  try {
    await getSupabase().rpc('admin_log', {
      p_level: level, p_source: 'edge:check-multichain-deposits',
      p_message: message, p_details: details,
    })
  } catch (e) { console.error('admin_log failed:', e) }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function nnFetch(url: string, label: string): Promise<any | null> {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: { 'api-key': NOWNODES_API_KEY } })
      if (res.ok) return await res.json()
      if (res.status === 429 || res.status >= 500) {
        await sleep(500 * (i + 1) * 2); continue
      }
      console.warn(`${label} HTTP ${res.status}`)
      return null
    } catch (e) {
      if (i === 2) { console.warn(`${label} failed:`, (e as Error).message); return null }
      await sleep(500 * (i + 1))
    }
  }
  return null
}

// ── USD prices (CoinLore) + USD→RUB ──────────────────────────
const PRICE_ID: Record<string, number> = { btc: 90, eth: 80, bnb: 2710, trx: 2713, ltc: 1 }

async function getUsdRubRate(): Promise<number> {
  try {
    const r = await fetch('https://api.exchangerate-api.com/v4/latest/USD')
    if (!r.ok) return 90
    const d = await r.json()
    const rate = d?.rates?.RUB ?? 90
    try {
      await getSupabase().from('app_settings').upsert(
        { key: 'usd_rub_rate', value: rate, updated_at: new Date().toISOString() },
        { onConflict: 'key' },
      )
    } catch { /* non-fatal */ }
    return rate
  } catch { return 90 }
}

async function getCoinUsd(id: number): Promise<number | null> {
  try {
    const r = await fetch(`https://api.coinlore.net/api/ticker/?id=${id}`)
    if (!r.ok) return null
    const d = await r.json()
    const p = parseFloat(d?.[0]?.price_usd)
    return Number.isFinite(p) && p > 0 ? p : null
  } catch { return null }
}

// ── Credit one deposit (idempotent via RPC p_tx_hash) ────────
async function credit(
  sb: ReturnType<typeof createClient>,
  userId: string,
  chainLabel: string,
  txKey: string,
  cryptoAmt: number,
  rubAmount: number,
): Promise<'credited' | 'dup' | 'skip' | 'error'> {
  if (!(rubAmount >= MIN_RUB) || !(cryptoAmt > 0)) return 'skip'
  const stars = Math.round(rubAmount)
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data, error } = await sb.rpc('process_crypto_deposit', {
      p_user_id: userId,
      p_stars: stars,
      p_tx_hash: txKey,
      p_chain: chainLabel,
      p_crypto_amt: cryptoAmt,
      p_rub_amount: rubAmount,
    })
    if (!error) return data?.credited ? 'credited' : 'dup'
    if (attempt < 2 && /connection|fetch|reset/i.test(error.message || '')) {
      await sleep(700 * (attempt + 1)); continue
    }
    await logToAdmin('error', 'process_crypto_deposit failed: ' + error.message,
      { txKey, userId, chainLabel, stars })
    return 'error'
  }
  return 'error'
}

// ── Blockbook (BTC / LTC / ETH / BSC) ────────────────────────
// One /address call returns recent txs; for UTXO we sum vout to
// our address, for EVM we read native value + tokenTransfers.
async function scanBlockbook(
  sb: ReturnType<typeof createClient>,
  host: string,
  kind: 'utxo-btc' | 'utxo-ltc' | 'evm-eth' | 'evm-bsc',
  addr: string,
  userId: string,
  prices: Record<string, number | null>,
  usdRub: number,
  stats: { credited: number; errors: number },
) {
  const data = await nnFetch(
    `https://${host}/api/v2/address/${addr}?details=txs&pageSize=50`,
    `${host}/${addr.slice(0, 10)}`,
  )
  const txs = data?.transactions
  if (!Array.isArray(txs)) return

  const lc = addr.toLowerCase()

  for (const tx of txs) {
    const conf = Number(tx.confirmations || 0)
    const txid = tx.txid || tx.hash
    if (!txid) continue

    if (kind === 'utxo-btc' || kind === 'utxo-ltc') {
      const need = kind === 'utxo-btc' ? CONFIRMS.btc : CONFIRMS.ltc
      if (conf < need) continue
      // sum outputs paying our address
      let sats = 0n
      for (const o of (tx.vout || [])) {
        const outs: string[] = o.addresses || o.scriptPubKey?.addresses || []
        if (outs.some(x => String(x).toLowerCase() === lc)) {
          try { sats += BigInt(o.value) } catch { /* ignore */ }
        }
      }
      if (sats <= 0n) continue
      const sym = kind === 'utxo-btc' ? 'btc' : 'ltc'
      const px = prices[sym]
      if (px == null) continue
      const amt = Number(sats) / 1e8
      const r = await credit(sb, userId, sym, `mc:${sym}:${txid}`, amt, amt * px * usdRub)
      if (r === 'credited') stats.credited++
      else if (r === 'error') stats.errors++
      continue
    }

    // EVM (ETH / BSC)
    const need = kind === 'evm-eth' ? CONFIRMS.eth : CONFIRMS.bnb
    if (conf < need) continue
    const sym = kind === 'evm-eth' ? 'eth' : 'bnb'

    // Skip our own treasury→user gas top-ups (not real deposits).
    const evmFrom: string[] = (tx.vin?.[0]?.addresses) || []
    const fromTreasury = evmFrom.some(x => String(x).toLowerCase() === TREASURY_EVM)

    // native incoming
    const toAddrs: string[] = (tx.vout?.[0]?.addresses) || []
    const isToUs = toAddrs.some(x => String(x).toLowerCase() === lc)
    if (!fromTreasury && isToUs && tx.value && tx.value !== '0') {
      const px = prices[sym]
      if (px != null) {
        const amt = Number(BigInt(tx.value)) / 1e18
        const r = await credit(sb, userId, sym, `mc:${sym}:${txid}`, amt, amt * px * usdRub)
        if (r === 'credited') stats.credited++
        else if (r === 'error') stats.errors++
      }
    }

    // token transfers (USDT/USDC ERC20/BEP20)
    const tokenMap = kind === 'evm-eth' ? EVM_TOKENS.eth : EVM_TOKENS.bsc
    const transfers = tx.tokenTransfers || []
    for (let ti = 0; ti < transfers.length; ti++) {
      const tr = transfers[ti]
      const to = String(tr.to || '').toLowerCase()
      if (to !== lc) continue
      if (String(tr.from || '').toLowerCase() === TREASURY_EVM) continue // our gas/sweep move
      const contract = String(tr.contract || tr.token || '').toLowerCase()
      const meta = tokenMap[contract]
      if (!meta) continue
      let raw: bigint
      try { raw = BigInt(tr.value) } catch { continue }
      if (raw <= 0n) continue
      const dec = Number(tr.decimals ?? meta.dec)
      const amt = Number(raw) / 10 ** dec       // USDT/USDC ≈ $1
      const r = await credit(
        sb, userId, meta.label, `mc:${meta.label}:${txid}:${ti}`, amt, amt * usdRub,
      )
      if (r === 'credited') stats.credited++
      else if (r === 'error') stats.errors++
    }
  }
}

// ── Tron (TRX native + USDT-TRC20) via TronGrid-compatible ───
async function scanTron(
  sb: ReturnType<typeof createClient>,
  addr: string,
  userId: string,
  trxUsd: number | null,
  usdRub: number,
  stats: { credited: number; errors: number },
) {
  // USDT-TRC20 incoming. NowNodes' trx.nownodes.io is a java-tron
  // node (no TronGrid /v1 indexer routes), so address-tx listing
  // uses TronGrid directly — the canonical Tron indexer (free
  // tier is fine for our once-a-minute windowed polling).
  const trc = await nnFetch(
    `https://api.trongrid.io/v1/accounts/${addr}/transactions/trc20?limit=40&only_to=true&contract_address=${TRON_USDT}`,
    `trx-trc20/${addr.slice(0, 8)}`,
  )
  for (const t of (trc?.data || [])) {
    if (String(t.to) !== addr) continue
    // Skip treasury→user gas top-ups (not real deposits).
    const tfrom = String(t.from || '')
    if (tfrom === TREASURY_TRON_B58 || tfrom.toLowerCase() === TREASURY_TRON_HEX) continue
    const txid = t.transaction_id
    if (!txid) continue
    const dec = Number(t.token_info?.decimals ?? 6)
    let raw: bigint
    try { raw = BigInt(t.value) } catch { continue }
    if (raw <= 0n) continue
    const amt = Number(raw) / 10 ** dec
    const r = await credit(sb, userId, 'usdt-trc20', `mc:usdt-trc20:${txid}`, amt, amt * usdRub)
    if (r === 'credited') stats.credited++
    else if (r === 'error') stats.errors++
  }

  // Native TRX incoming
  if (trxUsd == null) return
  const nat = await nnFetch(
    `https://api.trongrid.io/v1/accounts/${addr}/transactions?limit=40&only_to=true`,
    `trx-native/${addr.slice(0, 8)}`,
  )
  for (const t of (nat?.data || [])) {
    const c = t.raw_data?.contract?.[0]
    if (!c || c.type !== 'TransferContract') continue
    const v = c.parameter?.value
    if (!v || typeof v.amount !== 'number') continue
    // Skip treasury→user gas top-ups (not real deposits).
    const owner = String(v.owner_address || '').toLowerCase()
    if (owner === TREASURY_TRON_HEX || owner === TREASURY_TRON_B58.toLowerCase()) continue
    const txid = t.txID
    if (!txid) continue
    // TronGrid marks success in `ret`
    const ok = Array.isArray(t.ret) && t.ret.some((x: any) => x.contractRet === 'SUCCESS')
    if (!ok) continue
    const amt = v.amount / 1e6
    const r = await credit(sb, userId, 'trx', `mc:trx:${txid}`, amt, amt * trxUsd * usdRub)
    if (r === 'credited') stats.credited++
    else if (r === 'error') stats.errors++
  }
}

serve(async (_req) => {
  const t0 = Date.now()
  try {
    if (!NOWNODES_API_KEY) {
      await logToAdmin('error', 'NOWNODES_API_KEY not set')
      return new Response(JSON.stringify({ error: 'no_api_key' }), { status: 500 })
    }
    const sb = getSupabase()

    // Rotating window over ready addresses.
    const { data: offRow } = await sb.from('app_settings')
      .select('value').eq('key', OFFSET_KEY).maybeSingle()
    let offset = Number(offRow?.value ?? 0)
    if (!Number.isInteger(offset) || offset < 0) offset = 0

    const { data: rows, error: rowsErr } = await sb
      .from('user_deposit_addresses')
      .select('user_id, evm_address, tron_address, btc_address, ltc_address')
      .eq('ready', true)
      .order('derivation_index', { ascending: true })
      .range(offset, offset + BATCH_USERS - 1)

    if (rowsErr) {
      await logToAdmin('error', 'address load failed: ' + rowsErr.message)
      return new Response(JSON.stringify({ error: 'load_failed' }), { status: 500 })
    }

    const users = rows || []
    // Advance / wrap the window.
    let nextOffset = offset + users.length
    if (users.length < BATCH_USERS) nextOffset = 0
    await sb.from('app_settings').upsert(
      { key: OFFSET_KEY, value: nextOffset, updated_at: new Date().toISOString() },
      { onConflict: 'key' },
    )

    if (users.length === 0) {
      return new Response(JSON.stringify({ credited: 0, scanned: 0, offset, nextOffset }),
        { headers: { 'Content-Type': 'application/json' } })
    }

    const usdRub = await getUsdRubRate()
    const prices: Record<string, number | null> = {}
    for (const [sym, id] of Object.entries(PRICE_ID)) prices[sym] = await getCoinUsd(id)

    const stats = { credited: 0, errors: 0 }

    for (const u of users) {
      const uid = u.user_id as string
      if (u.btc_address)
        await scanBlockbook(sb, 'btcbook.nownodes.io', 'utxo-btc', u.btc_address, uid, prices, usdRub, stats)
      if (u.ltc_address)
        await scanBlockbook(sb, 'ltcbook.nownodes.io', 'utxo-ltc', u.ltc_address, uid, prices, usdRub, stats)
      if (u.evm_address) {
        await scanBlockbook(sb, 'eth-blockbook.nownodes.io', 'evm-eth', u.evm_address, uid, prices, usdRub, stats)
        await scanBlockbook(sb, 'bsc-blockbook.nownodes.io', 'evm-bsc', u.evm_address, uid, prices, usdRub, stats)
      }
      if (u.tron_address)
        await scanTron(sb, u.tron_address, uid, prices.trx, usdRub, stats)
    }

    const summary = {
      credited: stats.credited, errors: stats.errors,
      scanned: users.length, offset, nextOffset,
      usd_rub: Number(usdRub.toFixed(2)), elapsed_ms: Date.now() - t0,
    }
    console.log('Summary:', JSON.stringify(summary))
    if (stats.errors > 0) await logToAdmin('warn', 'multichain run had errors', summary)
    return new Response(JSON.stringify(summary), { headers: { 'Content-Type': 'application/json' } })
  } catch (err) {
    console.error('Worker error:', err)
    await logToAdmin('error', 'Unhandled: ' + (err as Error).message, { stack: (err as Error).stack })
    return new Response(JSON.stringify({ error: 'internal' }), { status: 500 })
  }
})
