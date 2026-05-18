// ╔══════════════════════════════════════════════════════════════╗
// ║  daily-admin-report — 10:00 MSK Telegram digest             ║
// ╚══════════════════════════════════════════════════════════════╝
//
// Read-only. Once a day collects EVERY wallet balance (TON +
// USDT-TON old wallet, and the HD-0 treasury across BTC/LTC/ETH/
// BNB/TRX + USDT/USDC), the sweep monitor overview, and the
// rebalance picture, then sends one formatted HTML message to the
// admin. Treasury addresses are public constants — no HD mnemonic
// needed (nothing is signed here).

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const BOT_TOKEN            = Deno.env.get('TELEGRAM_BOT_TOKEN')!
const ADMIN_TG_ID          = Deno.env.get('ADMIN_TG_ID') || '945676433'
const NOWNODES_API_KEY     = Deno.env.get('NOWNODES_API_KEY') || ''
const TG = `https://api.telegram.org/bot${BOT_TOKEN}`

// Old TON wallet (deposits TON + USDT-TON).
const TON_ADDRESS = 'UQDsqlvskoZupLe-DFTwffYIqMIXxq6ghYSqh_PjIfOHz_bC'
const USDT_MASTER = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'
// HD-0 treasury (the new chains).
const T_EVM  = '0x71740514b90aC31d0Ba0fF772107Ab5bA8496Ac2'
const T_EVM_LC = T_EVM.toLowerCase().slice(2)
const T_TRON = 'TNLov2u5DuHKiSJpQHziqb8Gcov2GQWZw4'
const T_TRON20HEX = '87b763889b9edeee35caff2ffc56170fca1d10a0' // 20-byte, no 0x41
const T_BTC  = 'bc1qprd6zdx8kv73xup6ed9rypnedxcltm89k8pfzk'
const T_LTC  = 'ltc1qc65xapvmpzqesmvajncddleww3gxuy7z7jku6g'

const EVM_TOK = {
  eth: [
    { c: '0xdac17f958d2ee523a2206206994597c13d831ec7', d: 6, n: 'USDT-ERC20' },
    { c: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', d: 6, n: 'USDC-ERC20' },
  ],
  bsc: [
    { c: '0x55d398326f99059ff775485246999027b3197955', d: 18, n: 'USDT-BEP20' },
    { c: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', d: 18, n: 'USDC-BEP20' },
  ],
}
const TRON_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
const safe = async <T>(p: Promise<T>, d: T): Promise<T> => { try { return await p } catch { return d } }
const num = (h: string) => { try { return Number(BigInt(h)) } catch { return 0 } }

async function rpcEvm(net: 'eth' | 'bsc', method: string, params: unknown[]) {
  const r = await fetch(`https://${net === 'eth' ? 'eth' : 'bsc'}.nownodes.io`, {
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
  const j = await r.json()
  return Number(j?.result || 0) / 1e9
}
async function usdtTonBal(): Promise<number> {
  const u = new URL('https://toncenter.com/api/v3/jetton/wallets')
  u.searchParams.set('owner_address', TON_ADDRESS)
  u.searchParams.set('jetton_address', USDT_MASTER)
  const r = await fetch(u.toString())
  const j = await r.json()
  return Number(j?.jetton_wallets?.[0]?.balance || 0) / 1e6
}
async function tronTrx(): Promise<number> {
  const r = await fetch('https://trx.nownodes.io/wallet/getaccount', {
    method: 'POST', headers: { 'content-type': 'application/json', 'api-key': NOWNODES_API_KEY },
    body: JSON.stringify({ address: T_TRON, visible: true }),
  })
  const j = await r.json()
  return Number(j?.balance || 0) / 1e6
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
  const j = await r.json()
  const h = j?.constant_result?.[0]
  return h ? num('0x' + h) / 1e6 : 0
}
async function bbBal(host: string, addr: string): Promise<number> {
  const r = await fetch(`https://${host}/api/v2/address/${addr}`, {
    headers: { 'api-key': NOWNODES_API_KEY },
  })
  const j = await r.json()
  return Number(j?.balance || 0) / 1e8
}
async function px(id: number): Promise<number> {
  try {
    const r = await fetch(`https://api.coinlore.net/api/ticker/?id=${id}`)
    const j = await r.json()
    const p = parseFloat(j?.[0]?.price_usd)
    return Number.isFinite(p) ? p : 0
  } catch { return 0 }
}
async function usdRub(): Promise<number> {
  try {
    const r = await fetch('https://api.exchangerate-api.com/v4/latest/USD')
    const j = await r.json()
    return j?.rates?.RUB ?? 90
  } catch { return 90 }
}

serve(async (_req) => {
  try {
    const [
      ton, ut, ethN, bnbN, eUsdt, eUsdc, bUsdt, bUsdc, trx, tUsdt, btc, ltc,
      pTon, pEth, pBnb, pTrx, pBtc, pLtc, _rate, sweep, rbLast, rbLive,
    ] = await Promise.all([
      safe(tonBal(), 0), safe(usdtTonBal(), 0),
      safe(evmNative('eth'), 0), safe(evmNative('bsc'), 0),
      safe(evmTok('eth', EVM_TOK.eth[0].c, 6), 0), safe(evmTok('eth', EVM_TOK.eth[1].c, 6), 0),
      safe(evmTok('bsc', EVM_TOK.bsc[0].c, 18), 0), safe(evmTok('bsc', EVM_TOK.bsc[1].c, 18), 0),
      safe(tronTrx(), 0), safe(tronUsdt(), 0),
      safe(bbBal('btcbook.nownodes.io', T_BTC), 0),
      safe(bbBal('ltcbook.nownodes.io', T_LTC), 0),
      safe(px(54683), 0), safe(px(80), 0), safe(px(2710), 0),
      safe(px(2713), 0), safe(px(90), 0), safe(px(1), 0),
      safe(usdRub(), 90),
      safe(sb.rpc('admin_sweep_overview').then(r => r.data), null),
      safe(sb.from('app_settings').select('value').eq('key', 'rebalance_last').maybeSingle().then(r => r.data?.value), null),
      safe(sb.from('app_settings').select('value').eq('key', 'rebalance_live').maybeSingle().then(r => r.data?.value), null),
    ])

    const tonU = ton * pTon, ethU = ethN * pEth, bnbU = bnbN * pBnb
    const trxU = trx * pTrx, btcU = btc * pBtc, ltcU = ltc * pLtc
    const stableU = ut + eUsdt + eUsdc + bUsdt + bUsdc + tUsdt
    const totalU = tonU + ethU + bnbU + trxU + btcU + ltcU + stableU
    const $ = (n: number) => '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 })
    const c = (n: number, d = 6) => n.toLocaleString('en-US', { maximumFractionDigits: d })

    // Rebalance: render exactly what the 03:00 run did (or didn't).
    const liveOn = rbLive === true || rbLive === 'true' ||
      (typeof rbLive === 'object' && rbLive?.on === true)
    let rbBlock: string
    if (!rbLast || typeof rbLast !== 'object') {
      rbBlock = `режим: ${liveOn ? '🔴 БОЕВОЙ' : '🟡 DRY-RUN'}\nещё не запускался (нет данных за ночь)`
    } else {
      const rt = new Date((rbLast.ts || Date.now()) + 3 * 3600_000)
      const rts = `${String(rt.getUTCDate()).padStart(2, '0')}.${String(rt.getUTCMonth() + 1).padStart(2, '0')} ${String(rt.getUTCHours()).padStart(2, '0')}:${String(rt.getUTCMinutes()).padStart(2, '0')}`
      // Escape free-text — Telegram parse_mode=HTML chokes on a
      // stray '<' (e.g. an old "< $25" note) and drops the message.
      const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      const acted = (rbLast.plan || []).filter((p: any) => p.action !== 'hold')
      const rows = (rbLast.plan || []).map((p: any) => {
        const r = (rbLast.results || []).find((x: any) => x.chain === p.chain)
        const tag = p.action === 'sell' ? '🔻' : p.action === 'buy' ? '🔺' : '✓'
        return `${tag} ${esc(p.nativeSym)} ${Math.round((p.curPct || 0) * 100)}%→${Math.round((p.targetPct || 0) * 100)}% · ${esc(p.note)}${r ? `\n   ↳ ${esc(r.text)}` : ''}`
      }).join('\n') || '  —'
      const stray = (rbLast.strayBnbUsdt || 0) > 1
        ? `\n⚠ BNB: лежит ${$(rbLast.strayBnbUsdt)} USDT — выводы только USDC, перекинь вручную`
        : ''
      rbBlock =
`прогон ${rts} МСК · <b>${rbLast.mode || (liveOn ? 'LIVE' : 'DRY-RUN')}</b>${liveOn ? '' : ' (свапы выключены)'}
обязательства ${$(rbLast.L || 0)} · казна ${$(rbLast.swapTotal || 0)} · цель монет ${(((rbLast.f) || 0) * 100).toFixed(1)}%
свапов: ${acted.length} из 4 сетей
${rows}${stray}`
    }

    const sc = sweep?.counts || {}
    const byChain = (sweep?.by_chain || [])
      .filter((b: any) => b.swept_count > 0 || b.active_count > 0)
      .map((b: any) => `  ${b.chain}: свипов ${b.swept_count}${b.active_count ? `, в работе ${b.active_count}` : ''}`)
      .join('\n') || '  —'

    const now = new Date(Date.now() + 3 * 3600_000)
    const ts = `${String(now.getUTCDate()).padStart(2, '0')}.${String(now.getUTCMonth() + 1).padStart(2, '0')} ${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')} МСК`

    const text =
`📊 <b>Ежедневный отчёт</b> · ${ts}

💼 <b>Кошельки</b>
TON: ${c(ton, 4)} (${$(tonU)})
USDT(TON): ${c(ut, 2)} (${$(ut)})
ETH: ${c(ethN, 5)} (${$(ethU)})
BNB: ${c(bnbN, 5)} (${$(bnbU)})
TRX: ${c(trx, 2)} (${$(trxU)})
BTC: ${c(btc, 8)} (${$(btcU)})
LTC: ${c(ltc, 6)} (${$(ltcU)})
USDT-ERC20: ${$(eUsdt)} · USDC-ERC20: ${$(eUsdc)}
USDT-BEP20: ${$(bUsdt)} · USDC-BEP20: ${$(bUsdc)}
USDT-TRC20: ${$(tUsdt)}
Стейблы всего: <b>${$(stableU)}</b>
<b>ИТОГО ≈ ${$(totalU)}</b>

🧹 <b>Свип</b>
готово ${sc.swept || 0} · в работе ${(sc.pending || 0) + (sc.needs_gas || 0) + (sc.gassing || 0) + (sc.sweeping || 0)} · ошибки ${sc.failed || 0} · пропуск ${sc.skipped || 0}
старейшая активная: ${sweep?.oldest_active_min ?? 0}м · проблемных: ${(sweep?.problems || []).length}
по сетям:
${byChain}

⚖️ <b>Ребаланс</b> (ночной, 03:00)
${rbBlock}`

    // Send via the proven pg_net + vault path (same as admin_log
    // notifications) — not a Deno env token that may be unset.
    const { data: sent } = await sb.rpc('send_admin_telegram', { p_text: text })
    return new Response(JSON.stringify({ ok: sent === true, total_usd: Math.round(totalU) }), {
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (e) {
    try {
      await sb.rpc('admin_log', {
        p_level: 'error', p_source: 'edge:daily-admin-report',
        p_message: 'failed', p_details: { err: String(e).slice(0, 400) },
      })
    } catch { /* noop */ }
    return new Response(JSON.stringify({ error: String(e).slice(0, 200) }), { status: 500 })
  }
})
