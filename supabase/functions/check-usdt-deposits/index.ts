// ╔══════════════════════════════════════════════════════════════╗
// ║  check-usdt-deposits — USDT-on-TON deposit indexer           ║
// ╚══════════════════════════════════════════════════════════════╝
//
// Mirrors `check-crypto-deposits` (the TON-native indexer) but
// targets USDT jettons on the Toncoin network. Key differences:
//   - Polls `/api/v3/jetton/transfers` (not /transactions) so
//     TonCenter does the jetton-transfer-notification parsing
//     for us — no manual Cell decoding needed.
//   - Filters by jetton_master = USDT to ignore any other
//     jettons that might land on our wallet.
//   - The `forward_payload` Cell carries the comment with the
//     user's telegram_id; we decode it via TonCenter's /decode.
//   - USDT has 6 decimals (vs TON's 9). Price ≈ $1 (peg), so
//     we convert micro-USDT → USDT → RUB via USD-RUB rate only.
//   - chain = 'usdt-ton' in process_crypto_deposit RPC so the
//     ledger can distinguish USDT vs TON entries cleanly.
//
// Cursor: app_settings key 'usdt_deposits_cursor_v1' (separate
// from the TON cursor so each indexer runs at its own pace).

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL          = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const TONCENTER_API_KEY     = Deno.env.get('TONCENTER_API_KEY') || ''
const CURSOR_KEY            = 'usdt_deposits_cursor_v1'
const PAGE_LIMIT            = 100

// Our public highload wallet (the address user sends USDT to).
const TON_ADDRESS  = 'UQDsqlvskoZupLe-DFTwffYIqMIXxq6ghYSqh_PjIfOHz_bC'
// USDT (Tether) master contract on TON.
const USDT_MASTER  = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'

// Minimum deposit in RUB.
const MIN_RUB = 200

let supabase: ReturnType<typeof createClient>

function getSupabase() {
  if (!supabase) supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  return supabase
}

async function logToAdmin(level: string, message: string, details: Record<string, unknown> = {}) {
  try {
    await getSupabase().rpc('admin_log', {
      p_level:   level,
      p_source:  'edge:check-usdt-deposits',
      p_message: message,
      p_details: details,
    })
  } catch (e) {
    console.error('Failed to write admin log:', e)
  }
}

// ── Fetch with retry ─────────────────────────────────────────

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  retries = 3,
  delayMs = 500,
  label = url,
): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, init)
      if (res.ok) return res

      const retryAfterHeader = res.headers.get('retry-after')
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : NaN
      const waitMs = Number.isFinite(retryAfterMs) && retryAfterMs > 0
        ? retryAfterMs
        : delayMs * (i + 1) * 2

      if (res.status === 429) {
        if (i === retries - 1) return res
        console.warn(`Fetch ${label} returned 429, retry ${i + 1}/${retries}`)
        await sleep(waitMs)
        continue
      }

      if (res.status >= 500) {
        if (i === retries - 1) return res
        console.warn(`Fetch ${label} returned ${res.status}, retry ${i + 1}/${retries}`)
        await sleep(delayMs * (i + 1))
        continue
      }

      return res
    } catch (e) {
      if (i === retries - 1) throw e
      console.warn(`Fetch ${label} failed, retry ${i + 1}/${retries}:`, (e as Error).message)
    }
    await sleep(delayMs * (i + 1))
  }
  throw new Error(`Failed to fetch ${label} after ${retries} retries`)
}

// ── USD → RUB rate ───────────────────────────────────────────

async function getUsdRubRate(): Promise<number> {
  try {
    const res = await fetchWithRetry('https://api.exchangerate-api.com/v4/latest/USD')
    if (!res.ok) return 90
    const data = await res.json()
    return data?.rates?.RUB ?? 90
  } catch {
    return 90
  }
}

// ── TonCenter v3: list incoming USDT transfers ──────────────

interface JettonTransfer {
  query_id: string
  source: string                  // sender's main address
  destination: string             // our main address
  amount: string                  // raw micro-USDT
  source_wallet?: string
  jetton_master?: string
  transaction_hash: string
  transaction_lt: string
  transaction_aborted?: boolean
  transaction_now?: number
  trace_id?: string
  response_destination?: string | null
  custom_payload?: string | null
  forward_payload?: string | null  // base64 Cell (BoC) containing comment
  forward_ton_amount?: string
}

async function getUsdtTransfers({
  startLt,
  limit = PAGE_LIMIT,
  sort = 'asc',
}: {
  startLt?: string
  limit?: number
  sort?: 'asc' | 'desc'
} = {}): Promise<JettonTransfer[]> {
  try {
    const url = new URL('https://toncenter.com/api/v3/jetton/transfers')
    url.searchParams.set('address', TON_ADDRESS)
    url.searchParams.set('direction', 'in')
    url.searchParams.set('jetton_master', USDT_MASTER)
    url.searchParams.set('limit', String(limit))
    url.searchParams.set('sort', sort)
    if (startLt) {
      url.searchParams.set('start_lt', startLt)
    }

    const headers: HeadersInit = {}
    if (TONCENTER_API_KEY) {
      headers['X-API-Key'] = TONCENTER_API_KEY
    }

    const res = await fetchWithRetry(url.toString(), { headers }, 4, 700, 'TonCenter v3 jetton/transfers')
    if (!res.ok) {
      console.error(`TonCenter HTTP ${res.status}`)
      await logToAdmin('warn', `TonCenter HTTP ${res.status}`, {
        has_api_key: Boolean(TONCENTER_API_KEY),
      })
      return []
    }
    const data = await res.json()
    if (!Array.isArray(data?.jetton_transfers)) {
      console.error('TonCenter v3 malformed response')
      await logToAdmin('error', 'TonCenter v3 malformed response', {
        has_transfers: Array.isArray(data?.jetton_transfers),
      })
      return []
    }
    return data.jetton_transfers
  } catch (e) {
    console.error('TonCenter fetch error:', e)
    await logToAdmin('error', 'TonCenter fetch failed: ' + (e as Error).message)
    return []
  }
}

// ── Forward-payload decoder ──────────────────────────────────
//
// TonCenter returns the forward_payload as a base64-encoded BoC
// (Cell). For a standard text comment the layout is:
//   - 32 bits: op = 0 (signals "text comment")
//   - rest:    UTF-8 bytes of the comment
//
// We send the BoC to TonCenter's /decode endpoint which returns
// `{ type: "comment", comment: "..." }` if it's a text comment.
// More robust than manual Cell parsing in Deno and uses the
// same decoder pipeline as the TON-native indexer.

interface DecodedPayload {
  type?: string
  comment?: string
  text?: string
}

async function decodeForwardPayloads(payloads: string[]): Promise<Map<string, DecodedPayload>> {
  const unique = [...new Set(payloads.filter(Boolean))]
  if (unique.length === 0) return new Map()

  const headers: HeadersInit = { 'Content-Type': 'application/json' }
  if (TONCENTER_API_KEY) headers['X-API-Key'] = TONCENTER_API_KEY

  try {
    const res = await fetchWithRetry(
      'https://toncenter.com/api/v3/decode',
      { method: 'POST', headers, body: JSON.stringify({ bodies: unique }) },
      4, 700, 'TonCenter v3 decode forward_payload',
    )

    if (!res.ok) {
      console.error(`TonCenter decode HTTP ${res.status}`)
      await logToAdmin('warn', `TonCenter decode HTTP ${res.status}`, { payloads: unique.length })
      return new Map()
    }

    const data = await res.json()
    const decodedBodies = Array.isArray(data?.bodies) ? data.bodies : []
    const result = new Map<string, DecodedPayload>()
    unique.forEach((payload, idx) => {
      const decoded = decodedBodies[idx]
      if (decoded) result.set(payload, decoded)
    })
    return result
  } catch (e) {
    console.error('TonCenter decode error:', e)
    await logToAdmin('error', 'TonCenter decode failed: ' + (e as Error).message)
    return new Map()
  }
}

function extractComment(decoded: DecodedPayload | undefined): string | null {
  if (!decoded) return null
  if (typeof decoded.comment === 'string' && decoded.comment.trim()) return decoded.comment.trim()
  if (typeof decoded.text    === 'string' && decoded.text.trim())    return decoded.text.trim()
  return null
}

// ── Cursor (app_settings) ────────────────────────────────────

interface CursorState {
  last_lt: string
  updated_at: string
}

async function getCursorState(): Promise<CursorState | null> {
  const { data, error } = await getSupabase()
    .from('app_settings')
    .select('value')
    .eq('key', CURSOR_KEY)
    .maybeSingle()

  if (error) throw new Error(`cursor_read_failed:${error.message}`)

  const value = data?.value
  if (!value || typeof value !== 'object') return null

  const lastLt = typeof value.last_lt === 'string' && /^\d+$/.test(value.last_lt) ? value.last_lt : null
  if (!lastLt) return null

  return {
    last_lt: lastLt,
    updated_at: typeof value.updated_at === 'string' ? value.updated_at : '',
  }
}

async function saveCursorState(lastLt: string): Promise<void> {
  const { error } = await getSupabase()
    .from('app_settings')
    .upsert({
      key: CURSOR_KEY,
      value: { last_lt: lastLt, updated_at: new Date().toISOString() },
    })

  if (error) throw new Error(`cursor_write_failed:${error.message}`)
}

function compareLtAsc(a: JettonTransfer, b: JettonTransfer) {
  const aLt = BigInt(a.transaction_lt || '0')
  const bLt = BigInt(b.transaction_lt || '0')
  if (aLt === bLt) return 0
  return aLt < bLt ? -1 : 1
}

// ── Page processor ───────────────────────────────────────────

interface PageProcessResult {
  completed: boolean
  credited: number
  skipped: number
  errors: number
  lastProcessedLt: string | null
}

async function processTransfersPage(
  sb: ReturnType<typeof createClient>,
  transfers: JettonTransfer[],
  usdRubRate: number,
): Promise<PageProcessResult> {
  const sortedTransfers = [...transfers].sort(compareLtAsc)

  // Bulk-decode all forward_payloads up front so we hit
  // TonCenter once per page instead of once per transfer.
  const payloads = sortedTransfers
    .map(t => t.forward_payload || '')
    .filter(Boolean)
  const decoded = await decodeForwardPayloads(payloads)

  let credited = 0
  let skipped  = 0
  let errors   = 0
  let lastProcessedLt: string | null = null

  for (const t of sortedTransfers) {
    const txHash = t.transaction_hash
    if (!txHash) { lastProcessedLt = t.transaction_lt; continue }

    // Aborted transactions don't actually credit USDT.
    if (t.transaction_aborted) {
      skipped++
      lastProcessedLt = t.transaction_lt
      continue
    }

    const amountRaw = BigInt(t.amount ?? '0')
    if (amountRaw <= 0n) {
      skipped++
      lastProcessedLt = t.transaction_lt
      continue
    }

    // USDT has 6 decimals.
    const usdtAmount = Number(amountRaw) / 1e6
    // USDT is pegged ~$1 — convert directly via USD-RUB rate.
    const rubAmount  = usdtAmount * usdRubRate

    if (rubAmount < MIN_RUB) {
      skipped++
      lastProcessedLt = t.transaction_lt
      continue
    }

    // Comment lives inside the forward_payload Cell.
    const payload = t.forward_payload || ''
    const comment = payload ? extractComment(decoded.get(payload)) : null
    if (!comment) {
      skipped++
      lastProcessedLt = t.transaction_lt
      continue
    }

    const telegramId = parseInt(comment, 10)
    if (isNaN(telegramId) || telegramId <= 0 || String(telegramId) !== comment) {
      skipped++
      lastProcessedLt = t.transaction_lt
      continue
    }

    const { data: user, error: userErr } = await sb
      .from('users')
      .select('id')
      .eq('telegram_id', telegramId)
      .maybeSingle()

    if (userErr) {
      console.error(`User lookup failed for telegram_id=${telegramId}:`, userErr.message)
      await logToAdmin('error', 'User lookup failed: ' + userErr.message, {
        tx_hash: txHash, telegram_id: telegramId,
      })
      errors++
      return { completed: false, credited, skipped, errors, lastProcessedLt }
    }

    if (!user) {
      console.log(`No user for telegram_id=${telegramId}, tx ${txHash.slice(0, 16)}…`)
      skipped++
      lastProcessedLt = t.transaction_lt
      continue
    }

    const stars = Math.round(rubAmount)
    let result: Record<string, unknown> | null = null
    let rpcError: { message: string } | null = null

    for (let attempt = 0; attempt < 3; attempt++) {
      const { data, error: err } = await sb.rpc('process_crypto_deposit', {
        p_user_id:    user.id,
        p_stars:      stars,
        p_tx_hash:    txHash,
        p_chain:      'usdt-ton',
        p_crypto_amt: usdtAmount,
        p_rub_amount: rubAmount,
      })
      if (!err) { result = data; rpcError = null; break }
      if (attempt < 2 && (
        err.message?.includes('connection') ||
        err.message?.includes('fetch') ||
        err.message?.includes('reset')
      )) {
        console.warn(`RPC retry ${attempt + 1}/3 for tx ${txHash.slice(0, 16)}: ${err.message}`)
        await sleep(800 * (attempt + 1))
        continue
      }
      rpcError = err
      break
    }

    if (rpcError) {
      console.error(`RPC error tx ${txHash.slice(0, 16)}:`, rpcError.message)
      await logToAdmin('error', 'process_crypto_deposit (usdt-ton) failed: ' + rpcError.message, {
        tx_hash: txHash, user_id: user.id, stars,
      })
      errors++
      return { completed: false, credited, skipped, errors, lastProcessedLt }
    }

    if (result?.credited) {
      console.log(`✅ +${stars}⭐ user=${user.id.slice(0, 8)} (${usdtAmount.toFixed(2)} USDT = ${rubAmount.toFixed(0)}₽)`)
      credited++
    }

    lastProcessedLt = t.transaction_lt
  }

  return { completed: true, credited, skipped, errors, lastProcessedLt }
}

// ── Main entrypoint ──────────────────────────────────────────

serve(async (_req) => {
  const startTime = Date.now()

  try {
    const sb = getSupabase()
    const usdRubRate = await getUsdRubRate()
    const usdRubDisplay = Number(usdRubRate.toFixed(2))
    console.log(`USD-RUB rate: ${usdRubDisplay}`)

    let credited = 0
    let skipped  = 0
    let errors   = 0
    let totalFetched = 0
    const cursorState = await getCursorState()

    if (!cursorState) {
      // Bootstrap: pull the most recent page in DESC order, set
      // the cursor to the latest LT we saw. Subsequent runs read
      // forward from there in ASC order.
      const bootstrap = await getUsdtTransfers({ limit: PAGE_LIMIT, sort: 'desc' })
      if (bootstrap.length === 0) {
        return new Response(JSON.stringify({
          credited: 0, total: 0, usd_rub: usdRubDisplay,
        }), { headers: { 'Content-Type': 'application/json' } })
      }

      totalFetched += bootstrap.length
      console.log(`Bootstrap mode: found ${bootstrap.length} recent transfers`)

      const pageResult = await processTransfersPage(sb, bootstrap, usdRubRate)
      credited += pageResult.credited
      skipped  += pageResult.skipped
      errors   += pageResult.errors

      if (pageResult.lastProcessedLt) {
        await saveCursorState(pageResult.lastProcessedLt)
      }
    } else {
      // Incremental: ASC-walk from cursor.last_lt + 1.
      let nextStartLt = (BigInt(cursorState.last_lt) + 1n).toString()

      while (true) {
        const page = await getUsdtTransfers({ startLt: nextStartLt, limit: PAGE_LIMIT, sort: 'asc' })
        if (page.length === 0) break

        totalFetched += page.length
        console.log(`Incremental: ${page.length} transfers from lt ${nextStartLt}`)

        const pageResult = await processTransfersPage(sb, page, usdRubRate)
        credited += pageResult.credited
        skipped  += pageResult.skipped
        errors   += pageResult.errors

        if (pageResult.lastProcessedLt) {
          await saveCursorState(pageResult.lastProcessedLt)
          nextStartLt = (BigInt(pageResult.lastProcessedLt) + 1n).toString()
        }

        if (!pageResult.completed || page.length < PAGE_LIMIT) break
      }
    }

    const elapsed = Date.now() - startTime
    const summary = { credited, skipped, errors, total: totalFetched, usd_rub: usdRubDisplay, elapsed_ms: elapsed }
    console.log('Summary:', JSON.stringify(summary))

    if (errors > 0) {
      await logToAdmin('warn', `USDT deposit run completed with ${errors} errors`, summary)
    }

    return new Response(JSON.stringify(summary), {
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('Worker error:', err)
    await logToAdmin('error', 'Unhandled exception: ' + (err as Error).message, { stack: (err as Error).stack })
    return new Response(JSON.stringify({ error: 'internal_error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
