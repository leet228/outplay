import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const TONCENTER_API_KEY = Deno.env.get('TONCENTER_API_KEY') || ''
const CURSOR_KEY = 'crypto_deposits_cursor_v3'
const PAGE_LIMIT = 100

// TON wallet address (same as in src/lib/addresses.js)
const TON_ADDRESS = 'UQDsqlvskoZupLe-DFTwffYIqMIXxq6ghYSqh_PjIfOHz_bC'

// Minimum deposit in RUB (1 star = 1 RUB)
const MIN_RUB = 200

let supabase: ReturnType<typeof createClient>

function getSupabase() {
  if (!supabase) supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  return supabase
}

async function logToAdmin(level: string, message: string, details: Record<string, unknown> = {}) {
  try {
    await getSupabase().rpc('admin_log', {
      p_level: level,
      p_source: 'edge:check-crypto-deposits',
      p_message: message,
      p_details: details,
    })
  } catch (e) {
    console.error('Failed to write admin log:', e)
  }
}

// ── Fetch with retry ──

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

// ── Helpers ──

async function getUsdRubRate(): Promise<number> {
  try {
    const res = await fetchWithRetry('https://api.exchangerate-api.com/v4/latest/USD')
    if (!res.ok) return 90
    const data = await res.json()
    return data?.rates?.RUB ?? 90
  } catch {
    return 90 // fallback
  }
}

async function getTonPrice(): Promise<number> {
  try {
    // CoinLore: TON id=54683, без лимитов, без API ключа
    const res = await fetchWithRetry('https://api.coinlore.net/api/ticker/?id=54683')
    if (!res.ok) {
      console.error(`CoinLore HTTP ${res.status}`)
      await logToAdmin('warn', `CoinLore HTTP ${res.status}`)
      return 0
    }
    const data = await res.json()
    const usdPrice = parseFloat(data?.[0]?.price_usd)
    if (!usdPrice || usdPrice <= 0) {
      console.error('CoinLore returned invalid price:', data?.[0]?.price_usd)
      await logToAdmin('warn', 'CoinLore invalid price', { raw: data?.[0]?.price_usd })
      return 0
    }
    // Конвертируем USD → RUB
    const rubRate = await getUsdRubRate()
    const rubPrice = usdPrice * rubRate
    console.log(`TON: $${usdPrice} × ${rubRate} = ${rubPrice.toFixed(2)} RUB`)
    return rubPrice
  } catch (e) {
    console.error('CoinLore error:', e)
    await logToAdmin('error', 'CoinLore fetch failed: ' + (e as Error).message)
    return 0
  }
}

interface TonTx {
  hash: string
  lt: string
  in_msg?: TonMessage | null
  now: number
}

interface TonMessageContentDecoded {
  type?: string
  comment?: string
  text?: string
  data?: string | {
    comment?: string
    text?: string
  }
}

interface TonMessageContent {
  body?: string
  decoded?: TonMessageContentDecoded | null
  hash?: string
}

interface TonMessage {
  destination?: string | null
  message_content?: TonMessageContent | null
  source?: string | null
  value?: string
}

interface TonDecodeResponse {
  bodies?: TonMessageContentDecoded[]
}

function extractDecodedComment(decoded: TonMessageContentDecoded | null | undefined): string | null {
  if (!decoded) return null
  if (typeof decoded.comment === 'string' && decoded.comment.trim()) {
    return decoded.comment.trim()
  }
  if (typeof decoded.text === 'string' && decoded.text.trim()) {
    return decoded.text.trim()
  }
  if (typeof decoded.data === 'string' && decoded.data.trim()) {
    return decoded.data.trim()
  }
  if (decoded.data && typeof decoded.data === 'object') {
    if (typeof decoded.data.comment === 'string' && decoded.data.comment.trim()) {
      return decoded.data.comment.trim()
    }
    if (typeof decoded.data.text === 'string' && decoded.data.text.trim()) {
      return decoded.data.text.trim()
    }
  }
  return null
}

interface CursorState {
  last_lt: string
  updated_at: string
}

interface PageProcessResult {
  completed: boolean
  credited: number
  skipped: number
  errors: number
  lastProcessedLt: string | null
}

async function getCursorState(): Promise<CursorState | null> {
  const { data, error } = await getSupabase()
    .from('app_settings')
    .select('value')
    .eq('key', CURSOR_KEY)
    .maybeSingle()

  if (error) {
    throw new Error(`cursor_read_failed:${error.message}`)
  }

  const value = data?.value
  if (!value || typeof value !== 'object') {
    return null
  }

  const lastLt = typeof value.last_lt === 'string' && /^\d+$/.test(value.last_lt) ? value.last_lt : null
  if (!lastLt) {
    return null
  }

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
      value: {
        last_lt: lastLt,
        updated_at: new Date().toISOString(),
      },
    })

  if (error) {
    throw new Error(`cursor_write_failed:${error.message}`)
  }
}

function compareLtAsc(a: TonTx, b: TonTx) {
  const aLt = BigInt(a.lt || '0')
  const bLt = BigInt(b.lt || '0')
  if (aLt === bLt) return 0
  return aLt < bLt ? -1 : 1
}

async function decodeTonBodies(bodies: string[]): Promise<Map<string, TonMessageContentDecoded> | null> {
  const uniqueBodies = [...new Set(bodies.filter(Boolean))]
  if (uniqueBodies.length === 0) {
    return new Map()
  }

  const headers: HeadersInit = {
    'Content-Type': 'application/json',
  }
  if (TONCENTER_API_KEY) {
    headers['X-API-Key'] = TONCENTER_API_KEY
  }

  const res = await fetchWithRetry(
    'https://toncenter.com/api/v3/decode',
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ bodies: uniqueBodies }),
    },
    4,
    700,
    'TonCenter v3 decode bodies',
  )

  if (!res.ok) {
    console.error(`TonCenter decode HTTP ${res.status}`)
    await logToAdmin('warn', `TonCenter decode HTTP ${res.status}`, {
      has_api_key: Boolean(TONCENTER_API_KEY),
      bodies: uniqueBodies.length,
    })
    return null
  }

  const data: TonDecodeResponse = await res.json()
  const decodedBodies = Array.isArray(data?.bodies) ? data.bodies : []
  const result = new Map<string, TonMessageContentDecoded>()

  uniqueBodies.forEach((body, index) => {
    const decoded = decodedBodies[index]
    if (decoded) {
      result.set(body, decoded)
    }
  })

  return result
}

async function getTonTransactions({
  startLt,
  limit = PAGE_LIMIT,
  offset = 0,
  sort = 'desc',
}: {
  startLt?: string
  limit?: number
  offset?: number
  sort?: 'asc' | 'desc'
} = {}): Promise<TonTx[]> {
  try {
    const url = new URL('https://toncenter.com/api/v3/transactions')
    url.searchParams.append('account', TON_ADDRESS)
    url.searchParams.set('limit', String(limit))
    url.searchParams.set('offset', String(offset))
    url.searchParams.set('sort', sort)
    if (startLt) {
      url.searchParams.set('start_lt', startLt)
    }

    const headers: HeadersInit = {}
    if (TONCENTER_API_KEY) {
      headers['X-API-Key'] = TONCENTER_API_KEY
    }

    const res = await fetchWithRetry(url.toString(), { headers }, 4, 700, 'TonCenter v3 transactions')
    if (!res.ok) {
      console.error(`TonCenter HTTP ${res.status}`)
      await logToAdmin('warn', `TonCenter HTTP ${res.status}`, {
        has_api_key: Boolean(TONCENTER_API_KEY),
      })
      return []
    }
    const data = await res.json()
    if (!Array.isArray(data?.transactions)) {
      console.error('TonCenter v3 malformed response')
      await logToAdmin('error', 'TonCenter v3 malformed response', {
        has_transactions: Array.isArray(data?.transactions),
      })
      return []
    }
    return data.transactions
  } catch (e) {
    console.error('TonCenter fetch error:', e)
    await logToAdmin('error', 'TonCenter fetch failed: ' + (e as Error).message)
    return []
  }
}

function extractComment(tx: TonTx, decodedBodies: Map<string, TonMessageContentDecoded>): string | null {
  const msg = tx.in_msg
  if (!msg) return null

  const directComment = extractDecodedComment(msg.message_content?.decoded)
  if (directComment) {
    return directComment
  }

  const body = msg.message_content?.body
  if (body) {
    const decodedComment = extractDecodedComment(decodedBodies.get(body))
    if (decodedComment) {
      return decodedComment
    }
  }

  return null
}

async function processTransactionsPage(
  sb: ReturnType<typeof createClient>,
  txs: TonTx[],
  tonPriceRub: number,
): Promise<PageProcessResult> {
  const sortedTxs = [...txs].sort(compareLtAsc)
  const bodiesToDecode = sortedTxs
    .filter(tx =>
      BigInt(tx.in_msg?.value ?? '0') > 0n &&
      !extractDecodedComment(tx.in_msg?.message_content?.decoded) &&
      Boolean(tx.in_msg?.message_content?.body)
    )
    .map(tx => tx.in_msg?.message_content?.body || '')

  const decodedBodies = await decodeTonBodies(bodiesToDecode)
  if (decodedBodies === null) {
    return {
      completed: false,
      credited: 0,
      skipped: 0,
      errors: 1,
      lastProcessedLt: null,
    }
  }

  let credited = 0
  let skipped = 0
  let errors = 0
  let lastProcessedLt: string | null = null

  for (const tx of sortedTxs) {
    const txHash = tx.hash
    if (!txHash) continue

    const valueNano = BigInt(tx.in_msg?.value ?? '0')
    if (valueNano <= 0n) {
      skipped++
      lastProcessedLt = tx.lt
      continue
    }

    const tonAmount = Number(valueNano) / 1e9
    const rubAmount = tonAmount * tonPriceRub
    if (rubAmount < MIN_RUB) {
      skipped++
      lastProcessedLt = tx.lt
      continue
    }

    const comment = extractComment(tx, decodedBodies)
    if (!comment) {
      skipped++
      lastProcessedLt = tx.lt
      continue
    }

    const telegramId = parseInt(comment, 10)
    if (isNaN(telegramId) || telegramId <= 0 || String(telegramId) !== comment) {
      skipped++
      lastProcessedLt = tx.lt
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
        tx_hash: txHash,
        telegram_id: telegramId,
      })
      errors++
      return { completed: false, credited, skipped, errors, lastProcessedLt }
    }

    if (!user) {
      console.log(`No user for telegram_id=${telegramId}, tx ${txHash.slice(0, 16)}…`)
      skipped++
      lastProcessedLt = tx.lt
      continue
    }

    const stars = Math.round(rubAmount)
    let result: Record<string, unknown> | null = null
    let rpcError: { message: string } | null = null

    for (let attempt = 0; attempt < 3; attempt++) {
      const { data, error: err } = await sb.rpc('process_crypto_deposit', {
        p_user_id: user.id,
        p_stars: stars,
        p_tx_hash: txHash,
        p_chain: 'ton',
        p_crypto_amt: tonAmount,
        p_rub_amount: rubAmount,
      })
      if (!err) { result = data; rpcError = null; break }
      if (attempt < 2 && (err.message?.includes('connection') || err.message?.includes('fetch') || err.message?.includes('reset'))) {
        console.warn(`RPC retry ${attempt + 1}/3 for tx ${txHash.slice(0, 16)}: ${err.message}`)
        await new Promise(r => setTimeout(r, 800 * (attempt + 1)))
        continue
      }
      rpcError = err
      break
    }

    if (rpcError) {
      console.error(`RPC error tx ${txHash.slice(0, 16)}:`, rpcError.message)
      await logToAdmin('error', 'process_crypto_deposit failed: ' + rpcError.message, {
        tx_hash: txHash,
        user_id: user.id,
        stars,
      })
      errors++
      return { completed: false, credited, skipped, errors, lastProcessedLt }
    }

    if (result?.credited) {
      console.log(`✅ +${stars}⭐ user=${user.id.slice(0, 8)} (${tonAmount.toFixed(4)} TON = ${rubAmount.toFixed(0)}₽)`)
      credited++
    }

    lastProcessedLt = tx.lt
  }

  return {
    completed: true,
    credited,
    skipped,
    errors,
    lastProcessedLt,
  }
}

// ── Main ──

serve(async (_req) => {
  const startTime = Date.now()

  try {
    const sb = getSupabase()

    // 1. Get TON price in RUB
    const tonPriceRub = await getTonPrice()
    if (tonPriceRub <= 0) {
      console.error('Cannot get TON price, skipping run')
      return new Response(JSON.stringify({ error: 'no_price' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const tonPriceRubDisplay = Number(tonPriceRub.toFixed(2))

    console.log(`TON price: ${tonPriceRubDisplay} RUB`)

    let credited = 0
    let skipped = 0
    let errors = 0
    let totalFetched = 0
    const cursorState = await getCursorState()

    if (!cursorState) {
      const bootstrapTxs = await getTonTransactions({ limit: PAGE_LIMIT, sort: 'desc' })
      if (bootstrapTxs.length === 0) {
        return new Response(JSON.stringify({ credited: 0, total: 0, ton_price_rub: tonPriceRubDisplay }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }

      totalFetched += bootstrapTxs.length
      console.log(`Bootstrap mode: found ${bootstrapTxs.length} recent transactions`)

      const pageResult = await processTransactionsPage(sb, bootstrapTxs, tonPriceRub)
      credited += pageResult.credited
      skipped += pageResult.skipped
      errors += pageResult.errors

      if (pageResult.lastProcessedLt) {
        await saveCursorState(pageResult.lastProcessedLt)
      }
    } else {
      let nextStartLt = (BigInt(cursorState.last_lt) + 1n).toString()

      while (true) {
        const pageTxs = await getTonTransactions({
          startLt: nextStartLt,
          limit: PAGE_LIMIT,
          sort: 'asc',
        })

        if (pageTxs.length === 0) {
          break
        }

        totalFetched += pageTxs.length
        console.log(`Incremental mode: fetched ${pageTxs.length} transactions from lt ${nextStartLt}`)

        const pageResult = await processTransactionsPage(sb, pageTxs, tonPriceRub)
        credited += pageResult.credited
        skipped += pageResult.skipped
        errors += pageResult.errors

        if (pageResult.lastProcessedLt) {
          await saveCursorState(pageResult.lastProcessedLt)
          nextStartLt = (BigInt(pageResult.lastProcessedLt) + 1n).toString()
        }

        if (!pageResult.completed || pageTxs.length < PAGE_LIMIT) {
          break
        }
      }
    }

    const elapsed = Date.now() - startTime
    const summary = { credited, skipped, errors, total: totalFetched, ton_price_rub: tonPriceRubDisplay, elapsed_ms: elapsed }
    console.log('Summary:', JSON.stringify(summary))

    // Log errors summary if any occurred
    if (errors > 0) {
      await logToAdmin('warn', `Crypto deposit run completed with ${errors} errors`, summary)
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
