// ╔══════════════════════════════════════════════════════════════╗
// ║  rebalance — 03:00 MSK daily treasury rebalancer            ║
// ╚══════════════════════════════════════════════════════════════╝
//
// Goal: keep the swappable treasury hedged. Stablecoin must ALWAYS
// cover platform liabilities (Σ user balances + guild prize pool)
// — that's a HARD floor that protects us from a crypto crash.
// Only the SURPLUS above liabilities is split 30% native / 70%
// stable, per chain. BTC + LTC are never touched. On BNB the
// stable leg is ALWAYS USDC (withdrawals there are USDC-BEP20 only;
// no USDT on BNB ever).
//
// Math (swappable universe = TON, TRX, ETH, BNB only):
//   SwapTotal = Σ(nativeUsd + stableUsd)
//   L         = liabilities in USD
//   f         = clamp( 0.30 · max(0, SwapTotal − L) / SwapTotal , 0 , 0.30 )
//   per chain → targetNativeUsd = f · localTotal
// One global native fraction f applied to every chain ⇒ the sum of
// stable always lands at  L + 0.70·Surplus ≥ L  (floor holds).
// If SwapTotal ≤ L → f = 0 → sell ALL native to stable.
//
// Direction per chain:
//   nativeUsd > target+band → SELL native → stable
//   nativeUsd < target−band → BUY  native ← stable
//   within ±5% band, or under MIN_SWAP_USD → leave it
// Always keep a native gas reserve (can't swap the gas away).
// Order: every SELL first (build stable), then every BUY.
//
// DRY-RUN by default. Goes live only when app_settings key
// 'rebalance_live' = true (toggle from the admin Wallet card).
//
// Actions (POST JSON):
//   {}                              cron run (mode from setting)
//   { action:'status',  user_id }   → last plan + live flag
//   { action:'set_live',user_id,on} → flip live flag
//   { action:'run',     user_id, dry? } → manual run (dry default true)

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
// Anon key = proven-valid JWT for the Functions gateway (service-
// role key can be a non-JWT secret → 'invalid JWT'). dex-swap has
// its own admin gate, so anon here is safe.
const SUPABASE_ANON_KEY    = Deno.env.get('SUPABASE_ANON_KEY') || ''
const BOT_TOKEN            = Deno.env.get('TELEGRAM_BOT_TOKEN')!
const ADMIN_TG_ID          = Deno.env.get('ADMIN_TG_ID') || '945676433'
const NOWNODES_API_KEY     = Deno.env.get('NOWNODES_API_KEY') || ''
const TG = `https://api.telegram.org/bot${BOT_TOKEN}`

// Tunables (env-overridable).
const TARGET_NATIVE = Number(Deno.env.get('REBALANCE_TARGET') || 0.30)
const BAND          = Number(Deno.env.get('REBALANCE_BAND')   || 0.05)
const MIN_SWAP_USD  = Number(Deno.env.get('REBALANCE_MIN_USD') || 25)
const SLIPPAGE      = Number(Deno.env.get('REBALANCE_SLIPPAGE') || 0.01)
// BSC has NO BNB/USDT-BEP20 withdrawals — only USDC-BEP20. So BNB
// is purely a GAS float (keep ~this many BNB for USDC withdrawal/
// swap gas), and any USDT-BEP20 is junk → swept into BNB.
const BNB_GAS_FLOAT = Number(Deno.env.get('REBALANCE_BNB_GAS_FLOAT') || 0.05)
// Native units we never swap away (gas for sweeps/withdrawals/swaps).
const GAS_RESERVE: Record<string, number> = {
  eth: Number(Deno.env.get('REBALANCE_GAS_ETH') || 0.012),
  bnb: Number(Deno.env.get('REBALANCE_GAS_BNB') || 0.012),
  trx: Number(Deno.env.get('REBALANCE_GAS_TRX') || 250),
  ton: Number(Deno.env.get('REBALANCE_GAS_TON') || 1.2),
}

// Treasury (public) addresses — same wallets dex-swap signs from.
const TON_ADDRESS = 'UQDsqlvskoZupLe-DFTwffYIqMIXxq6ghYSqh_PjIfOHz_bC'
const USDT_MASTER = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'
const T_EVM   = '0x71740514b90aC31d0Ba0fF772107Ab5bA8496Ac2'
const T_EVM_LC = T_EVM.toLowerCase().slice(2)
const T_TRON  = 'TNLov2u5DuHKiSJpQHziqb8Gcov2GQWZw4'
const T_TRON20HEX = '87b763889b9edeee35caff2ffc56170fca1d10a0'
const TRON_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const EVM_TOK = {
  eth: { usdt: '0xdac17f958d2ee523a2206206994597c13d831ec7', usdc: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', dec: 6 },
  bsc: { usdt: '0x55d398326f99059ff775485246999027b3197955', usdc: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', dec: 18 },
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } })
const safe = async <T>(p: Promise<T>, d: T): Promise<T> => { try { return await p } catch { return d } }
const num = (h: string) => { try { return Number(BigInt(h)) } catch { return 0 } }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// ── balance readers (mirror daily-admin-report) ──
async function rpcEvm(net: 'eth' | 'bsc', method: string, params: unknown[]) {
  const r = await fetch(`https://${net}.nownodes.io`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'api-key': NOWNODES_API_KEY },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const j = await r.json()
  if (j.error) throw new Error(j.error.message)
  return j.result as string
}
const evmNative = async (net: 'eth' | 'bsc') =>
  num(await rpcEvm(net, 'eth_getBalance', [T_EVM, 'latest'])) / 1e18
const evmTok = async (net: 'eth' | 'bsc', c: string, d: number) =>
  num(await rpcEvm(net, 'eth_call', [{ to: c, data: '0x70a08231' + '0'.repeat(24) + T_EVM_LC }, 'latest'])) / 10 ** d
async function tonBal(): Promise<number> {
  const r = await fetch(`https://toncenter.com/api/v2/getAddressBalance?address=${TON_ADDRESS}`)
  return Number((await r.json())?.result || 0) / 1e9
}
async function usdtTonBal(): Promise<number> {
  const u = new URL('https://toncenter.com/api/v3/jetton/wallets')
  u.searchParams.set('owner_address', TON_ADDRESS)
  u.searchParams.set('jetton_address', USDT_MASTER)
  const r = await fetch(u.toString())
  return Number((await r.json())?.jetton_wallets?.[0]?.balance || 0) / 1e6
}
async function tronTrx(): Promise<number> {
  const r = await fetch('https://trx.nownodes.io/wallet/getaccount', {
    method: 'POST', headers: { 'content-type': 'application/json', 'api-key': NOWNODES_API_KEY },
    body: JSON.stringify({ address: T_TRON, visible: true }),
  })
  return Number((await r.json())?.balance || 0) / 1e6
}
async function tronUsdt(): Promise<number> {
  const r = await fetch('https://trx.nownodes.io/wallet/triggerconstantcontract', {
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

async function adminUserId(): Promise<string | null> {
  const { data } = await sb.from('users')
    .select('id').eq('telegram_id', ADMIN_TG_ID).maybeSingle()
  return data?.id ?? null
}
async function isAdmin(userId: string): Promise<boolean> {
  if (!userId) return false
  const { data } = await sb.from('users')
    .select('telegram_id').eq('id', userId).maybeSingle()
  return !!data && String(data.telegram_id) === String(ADMIN_TG_ID)
}
async function liveFlag(): Promise<boolean> {
  const { data } = await sb.from('app_settings')
    .select('value').eq('key', 'rebalance_live').maybeSingle()
  const v = data?.value
  return v === true || v === 'true' || (typeof v === 'object' && v?.on === true)
}
async function callDexSwap(userId: string, dir: string, amount: number) {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/dex-swap`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ user_id: userId, dir, amount, slippage: SLIPPAGE }),
  })
  return r.json().catch(() => ({ error: `http_${r.status}` }))
}

interface ChainState {
  chain: string                 // ton | trx | eth | bnb
  nativeSym: string
  stableSym: string             // USDT | USDC
  nativeAmt: number             // native units
  nativeUsd: number
  stableUsd: number             // managed stable on this chain
  price: number
  localTotal: number
}

function fmt(n: number, d = 2) {
  return n.toLocaleString('en-US', { maximumFractionDigits: d })
}
const $ = (n: number) => '$' + fmt(n)

async function buildSnapshot() {
  const [
    ton, ut, ethN, bnbN, eUsdt, eUsdc, bUsdt, bUsdc, trx, tUsdt,
    pTon, pEth, pBnb, pTrx, rate, statsRes,
  ] = await Promise.all([
    safe(tonBal(), 0), safe(usdtTonBal(), 0),
    safe(evmNative('eth'), 0), safe(evmNative('bsc'), 0),
    safe(evmTok('eth', EVM_TOK.eth.usdt, 6), 0), safe(evmTok('eth', EVM_TOK.eth.usdc, 6), 0),
    safe(evmTok('bsc', EVM_TOK.bsc.usdt, 18), 0), safe(evmTok('bsc', EVM_TOK.bsc.usdc, 18), 0),
    safe(tronTrx(), 0), safe(tronUsdt(), 0),
    safe(px(54683), 0), safe(px(80), 0), safe(px(2710), 0), safe(px(2713), 0),
    safe(usdRub(), 90),
    safe(sb.rpc('get_admin_stats').then(r => r.data), null),
  ])

  const userRub  = Number(statsRes?.total_user_balances ?? 0)
  const prizeRub = Number(statsRes?.guild_prize_pool ?? 0)
  const L = rate > 0 ? (userRub + prizeRub) / rate : 0

  const chains: ChainState[] = [
    { chain: 'ton', nativeSym: 'TON', stableSym: 'USDT', nativeAmt: ton,  nativeUsd: ton * pTon,  stableUsd: ut,            price: pTon, localTotal: 0 },
    { chain: 'trx', nativeSym: 'TRX', stableSym: 'USDT', nativeAmt: trx,  nativeUsd: trx * pTrx,  stableUsd: tUsdt,         price: pTrx, localTotal: 0 },
    { chain: 'eth', nativeSym: 'ETH', stableSym: 'USDT', nativeAmt: ethN, nativeUsd: ethN * pEth, stableUsd: eUsdt + eUsdc, price: pEth, localTotal: 0 },
    { chain: 'bnb', nativeSym: 'BNB', stableSym: 'USDC', nativeAmt: bnbN, nativeUsd: bnbN * pBnb, stableUsd: bUsdc,         price: pBnb, localTotal: 0 },
  ]
  for (const c of chains) c.localTotal = c.nativeUsd + c.stableUsd

  const swapTotal = chains.reduce((s, c) => s + c.localTotal, 0)
  const surplus   = Math.max(0, swapTotal - L)
  const f = swapTotal > 0
    ? Math.max(0, Math.min(TARGET_NATIVE, TARGET_NATIVE * surplus / swapTotal))
    : 0

  // Per-chain plan.
  const plan: any[] = []
  for (const c of chains) {
    // ── BSC special case ───────────────────────────────────────
    // No BNB or USDT-BEP20 withdrawals — only USDC-BEP20. So BNB
    // is NOT a 30/70 value reserve, it's a GAS float: keep
    // ~BNB_GAS_FLOAT, sell the excess into USDC, top it back up
    // from USDC if it runs low (so USDC withdrawals never lack
    // gas). Separately, sweep any USDT-BEP20 → BNB (it's junk:
    // there are no USDT-BEP20 withdrawals).
    if (c.chain === 'bnb') {
      const floatUsd = BNB_GAS_FLOAT * c.price
      const devGas   = c.nativeUsd - floatUsd        // >0 excess gas
      let action: 'sell' | 'buy' | 'hold' = 'hold'
      let amount = 0, usd = 0, dir = '', note = ''
      if (c.price <= 0) { note = 'нет цены BNB' }
      else if (devGas >= MIN_SWAP_USD) {
        const amt = devGas / c.price
        action = 'sell'; amount = amt; usd = devGas; dir = 'bnb_to_usdc'
        note = `излишек газа: продать ${fmt(amt, 6)} BNB → ${$(usd)} USDC`
      } else if (-devGas >= MIN_SWAP_USD) {
        const need = Math.min(-devGas, Math.max(0, c.stableUsd * 0.99))
        if (need >= MIN_SWAP_USD) {
          action = 'buy'; amount = need; usd = need; dir = 'usdc_to_bnb'
          note = `мало газа: докупить BNB на ${$(need)} USDC`
        } else { note = '⚠ мало газа BNB, нет USDC на докупку' }
      } else { note = `газ-флоат BNB в норме (~${fmt(BNB_GAS_FLOAT, 4)})` }
      plan.push({
        chain: 'bnb', nativeSym: 'BNB', stableSym: 'USDC',
        nativeUsd: c.nativeUsd, stableUsd: c.stableUsd, localTotal: c.localTotal,
        curPct: c.localTotal > 0 ? c.nativeUsd / c.localTotal : 0,
        targetPct: c.localTotal > 0 ? floatUsd / c.localTotal : 0,
        action, dir, amount, usd, note,
      })
      // USDT-BEP20 → BNB (no USDT-BEP20 withdrawals exist).
      if (bUsdt >= MIN_SWAP_USD) {
        plan.push({
          chain: 'bnb-usdt', nativeSym: 'USDT→BNB', stableSym: 'USDT',
          nativeUsd: 0, stableUsd: bUsdt, localTotal: bUsdt,
          curPct: 0, targetPct: 0,
          action: 'sell', dir: 'usdt_to_bnb', amount: bUsdt, usd: bUsdt,
          note: `USDT-BEP20 → BNB (нет выводов USDT): ${$(bUsdt)}`,
        })
      }
      continue
    }

    // ── Generic 30/70 (ton / trx / eth) ────────────────────────
    const target = f * c.localTotal
    const dev    = c.nativeUsd - target            // >0 too much native
    const devPct = c.localTotal > 0 ? Math.abs(dev) / c.localTotal : 0
    let action: 'sell' | 'buy' | 'hold' = 'hold'
    let amount = 0          // input units for dex-swap
    let usd = 0
    let dir = ''
    let note = ''

    if (c.localTotal <= 0) { note = 'пусто'; }
    else if (devPct < BAND) { note = `в норме (±${(BAND * 100)}%)` }
    else if (dev > 0) {
      // SELL native → stable. Keep gas reserve.
      const sellable = Math.max(0, c.nativeAmt - (GAS_RESERVE[c.chain] || 0))
      const amt = Math.min(dev / c.price, sellable)
      usd = amt * c.price
      if (sellable <= 0) { note = '⚠ только газовый резерв' }
      else if (usd < MIN_SWAP_USD) { note = `менее $${MIN_SWAP_USD} — пропуск` }
      else {
        action = 'sell'; amount = amt; dir = `${c.chain}_to_${c.stableSym.toLowerCase()}`
        note = `продать ${fmt(amt, 6)} ${c.nativeSym} → ${$(usd)} ${c.stableSym}`
      }
    } else {
      // BUY native ← stable. Need stable on this chain + gas to swap.
      const want = -dev
      const spendable = Math.max(0, c.stableUsd * 0.99)   // keep tiny buffer
      usd = Math.min(want, spendable)
      const hasGas = c.nativeAmt >= (GAS_RESERVE[c.chain] || 0) * 0.5
      if (spendable <= 0) { note = '⚠ нет стейбла для докупки' }
      else if (!hasGas) { note = `⚠ мало ${c.nativeSym} на газ — докупка пропущена` }
      else if (usd < MIN_SWAP_USD) { note = `менее $${MIN_SWAP_USD} — пропуск` }
      else {
        action = 'buy'; amount = usd; dir = `${c.stableSym.toLowerCase()}_to_${c.chain}`
        const capped = usd < want ? ' (ограничено стейблом)' : ''
        note = `докупить на ${$(usd)} ${c.stableSym} → ${c.nativeSym}${capped}`
      }
    }
    plan.push({
      chain: c.chain, nativeSym: c.nativeSym, stableSym: c.stableSym,
      nativeUsd: c.nativeUsd, stableUsd: c.stableUsd, localTotal: c.localTotal,
      curPct: c.localTotal > 0 ? c.nativeUsd / c.localTotal : 0,
      targetPct: f, action, dir, amount, usd, note,
    })
  }

  return {
    ts: Date.now(),
    L, userRub, prizeRub, rate, swapTotal, surplus, f,
    strayBnbUsdt: bUsdt,
    chains: chains.map(c => ({ chain: c.chain, nativeUsd: c.nativeUsd, stableUsd: c.stableUsd })),
    plan,
  }
}

function renderReport(snap: any, mode: 'DRY-RUN' | 'LIVE', results: any[]) {
  const now = new Date(Date.now() + 3 * 3600_000)
  const ts = `${String(now.getUTCDate()).padStart(2, '0')}.${String(now.getUTCMonth() + 1).padStart(2, '0')} ${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')} МСК`
  const head =
`⚖️ <b>Ребаланс</b> · ${ts}  ·  <b>${mode}</b>

Обязательства (юзеры+фонд): <b>${$(snap.L)}</b>
Свап-казна: <b>${$(snap.swapTotal)}</b> · излишек ${$(snap.surplus)}
Цель монет = <b>${(snap.f * 100).toFixed(1)}%</b> (стейбл пол ${$(snap.L)} ≥ обязательств)`
  // Telegram parse_mode=HTML: escape free-text so a stray '<' in a
  // note/result can't blow up the whole message.
  const esc = (s: any) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const lines = snap.plan.map((p: any) => {
    const r = results.find(x => x.chain === p.chain)
    const tail = r ? `\n   ↳ ${esc(r.text)}` : ''
    const tag = p.action === 'sell' ? '🔻' : p.action === 'buy' ? '🔺' : '✓'
    return `${tag} <b>${esc(p.nativeSym)}</b> ${(p.curPct * 100).toFixed(0)}%→${(p.targetPct * 100).toFixed(0)}% · ${esc(p.note)}${tail}`
  }).join('\n')
  const stray = snap.strayBnbUsdt > 1
    ? `\n\nℹ️ USDT-BEP20 на BNB: ${$(snap.strayBnbUsdt)} → свопится в BNB автоматически`
    : ''
  return `${head}\n\n${lines}${stray}`
}

async function tg(text: string) {
  // Proven pg_net + vault path (same as admin_log notifications),
  // not a Deno env token that may be unset in the function.
  await safe(sb.rpc('send_admin_telegram', { p_text: text }).then(() => true), false)
}

async function runRebalance(live: boolean) {
  const snap = await buildSnapshot()
  const results: any[] = []

  if (live) {
    const uid = await adminUserId()
    if (!uid) {
      await tg(renderReport(snap, 'LIVE', [{ chain: '-', text: '❌ admin user not found — свапы не выполнены' }]))
      return { ok: false, error: 'no_admin_user', snap }
    }
    // SELLs first (build stable), then BUYs.
    const ordered = [
      ...snap.plan.filter((p: any) => p.action === 'sell'),
      ...snap.plan.filter((p: any) => p.action === 'buy'),
    ]
    for (const p of ordered) {
      try {
        let res = await callDexSwap(uid, p.dir, p.amount)
        // Token-in swaps (stable→native) need an allowance first;
        // dex-swap returns step:'approved' — wait and retry once.
        if (res?.step === 'approved') {
          await sleep(25_000)
          res = await callDexSwap(uid, p.dir, p.amount)
        }
        if (res?.ok && res?.step === 'swap') {
          results.push({ chain: p.chain, text: `✅ ${res.txid?.slice(0, 14)}… (~${fmt(Number(res.expected_out) / 10 ** (res.out_dec || 6), 4)} ${res.out_sym})` })
        } else if (res?.step === 'approved') {
          results.push({ chain: p.chain, text: `⏳ approve отправлен — свап в след. прогон` })
        } else {
          results.push({ chain: p.chain, text: `❌ ${String(res?.error || JSON.stringify(res)).slice(0, 80)}` })
        }
      } catch (e) {
        results.push({ chain: p.chain, text: `❌ ${String(e).slice(0, 80)}` })
      }
      await sleep(4_000)
    }
  }

  await sb.from('app_settings').upsert(
    { key: 'rebalance_last', value: { ...snap, mode: live ? 'LIVE' : 'DRY-RUN', results }, updated_at: new Date().toISOString() },
    { onConflict: 'key' },
  )
  await safe(sb.rpc('admin_log', {
    p_level: 'info', p_source: 'edge:rebalance',
    p_message: live ? 'live run' : 'dry run',
    p_details: { L: Math.round(snap.L), swapTotal: Math.round(snap.swapTotal), f: snap.f, acted: results.length },
  }).then(() => true), false)
  await tg(renderReport(snap, live ? 'LIVE' : 'DRY-RUN', results))
  return { ok: true, mode: live ? 'LIVE' : 'DRY-RUN', snap, results }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const body = await req.json().catch(() => ({}))
    const action = body?.action

    if (action === 'status') {
      if (!(await isAdmin(body.user_id))) return json({ error: 'forbidden' }, 403)
      const { data } = await sb.from('app_settings')
        .select('value').eq('key', 'rebalance_last').maybeSingle()
      return json({ ok: true, live: await liveFlag(), last: data?.value ?? null })
    }
    if (action === 'set_live') {
      if (!(await isAdmin(body.user_id))) return json({ error: 'forbidden' }, 403)
      await sb.from('app_settings').upsert(
        { key: 'rebalance_live', value: body.on === true, updated_at: new Date().toISOString() },
        { onConflict: 'key' },
      )
      return json({ ok: true, live: body.on === true })
    }
    if (action === 'run') {
      if (!(await isAdmin(body.user_id))) return json({ error: 'forbidden' }, 403)
      const live = body.dry === false ? await liveFlag() : false
      const out = await runRebalance(live)
      return json(out)
    }

    // Default: cron invocation. Mode from the persisted setting.
    const out = await runRebalance(await liveFlag())
    return json(out)
  } catch (e) {
    await safe(sb.rpc('admin_log', {
      p_level: 'error', p_source: 'edge:rebalance',
      p_message: 'failed', p_details: { err: String(e).slice(0, 400) },
    }).then(() => true), false)
    return json({ error: String(e).slice(0, 200) }, 500)
  }
})
