import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// TON wallet address (same as in src/lib/addresses.js)
const TON_ADDRESS = 'UQBMTQ2VRSwRbvthtGTIB7Tip37yqueFw8SnVvWB7y18F47t'

// Minimum deposit in RUB (1 star = 1 RUB)
const MIN_RUB = 200

// ── Fetch with retry ──

async function fetchWithRetry(url: string, retries = 3, delayMs = 500): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url)
      if (res.ok || res.status < 500) return res
      console.warn(`Fetch ${url} returned ${res.status}, retry ${i + 1}/${retries}`)
    } catch (e) {
      if (i === retries - 1) throw e
      console.warn(`Fetch ${url} failed, retry ${i + 1}/${retries}:`, (e as Error).message)
    }
    await new Promise(r => setTimeout(r, delayMs * (i + 1)))
  }
  throw new Error(`Failed to fetch ${url} after ${retries} retries`)
}

// ── Helpers ──

async function getTonPrice(): Promise<number> {
  try {
    const res = await fetchWithRetry(
      'https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=rub'
    )
    if (!res.ok) {
      console.error(`CoinGecko HTTP ${res.status}`)
      return 0
    }
    const data = await res.json()
    const price = data['the-open-network']?.rub
    if (typeof price !== 'number' || price <= 0) {
      console.error('CoinGecko returned invalid price:', price)
      return 0
    }
    return price
  } catch (e) {
    console.error('CoinGecko error:', e)
    return 0
  }
}

interface TonTx {
  transaction_id: { hash: string }
  in_msg: {
    value: string // nanotons
    message: string // comment (base64 or plain text)
    source: string
    msg_data?: { '@type': string; text?: string }
  }
  utime: number
}

async function getTonTransactions(): Promise<TonTx[]> {
  try {
    const res = await fetchWithRetry(
      `https://toncenter.com/api/v2/getTransactions?address=${TON_ADDRESS}&limit=100`
    )
    if (!res.ok) {
      console.error(`TonCenter HTTP ${res.status}`)
      return []
    }
    const data = await res.json()
    if (!data.ok) {
      console.error('TonCenter API error:', data.error)
      return []
    }
    return data.result ?? []
  } catch (e) {
    console.error('TonCenter fetch error:', e)
    return []
  }
}

function extractComment(tx: TonTx): string | null {
  const msg = tx.in_msg
  if (!msg) return null

  // Try msg_data.text (base64 encoded)
  if (msg.msg_data?.['@type'] === 'msg.dataText' && msg.msg_data.text) {
    try {
      return atob(msg.msg_data.text).trim()
    } catch {
      return msg.msg_data.text.trim()
    }
  }

  // Fallback to message field
  if (msg.message) {
    try {
      return atob(msg.message).trim()
    } catch {
      return msg.message.trim()
    }
  }

  return null
}

// ── Main ──

serve(async (_req) => {
  const startTime = Date.now()

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    // 1. Get TON price in RUB
    const tonPriceRub = await getTonPrice()
    if (tonPriceRub <= 0) {
      console.error('Cannot get TON price, skipping run')
      return new Response(JSON.stringify({ error: 'no_price' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    console.log(`TON price: ${tonPriceRub} RUB`)

    // 2. Get recent transactions
    const txs = await getTonTransactions()
    if (txs.length === 0) {
      return new Response(JSON.stringify({ credited: 0, total: 0, ton_price_rub: tonPriceRub }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    console.log(`Found ${txs.length} transactions`)

    let credited = 0
    let skipped = 0
    let errors = 0

    for (const tx of txs) {
      const txHash = tx.transaction_id?.hash
      if (!txHash) continue

      // Only incoming transactions with value
      const valueNano = BigInt(tx.in_msg?.value ?? '0')
      if (valueNano <= 0n) { skipped++; continue }

      const tonAmount = Number(valueNano) / 1e9
      const rubAmount = tonAmount * tonPriceRub

      // Check minimum
      if (rubAmount < MIN_RUB) { skipped++; continue }

      // Extract memo/comment
      const comment = extractComment(tx)
      if (!comment) { skipped++; continue }

      // Parse telegram_id from comment (must be positive integer)
      const telegramId = parseInt(comment, 10)
      if (isNaN(telegramId) || telegramId <= 0 || String(telegramId) !== comment) {
        skipped++
        continue
      }

      // Find user by telegram_id
      const { data: user, error: userErr } = await supabase
        .from('users')
        .select('id')
        .eq('telegram_id', telegramId)
        .single()

      if (userErr || !user) {
        console.log(`No user for telegram_id=${telegramId}, tx ${txHash.slice(0, 16)}…`)
        skipped++
        continue
      }

      // Credit deposit (atomic dedup inside RPC)
      const stars = Math.round(rubAmount)
      const { data: result, error } = await supabase.rpc('process_crypto_deposit', {
        p_user_id: user.id,
        p_stars: stars,
        p_tx_hash: txHash,
        p_chain: 'ton',
        p_crypto_amt: tonAmount,
        p_rub_amount: rubAmount,
      })

      if (error) {
        console.error(`RPC error tx ${txHash.slice(0, 16)}:`, error.message)
        errors++
      } else if (result?.duplicate) {
        // Already processed — silent skip
      } else if (result?.credited) {
        console.log(`✅ +${stars}⭐ user=${user.id.slice(0, 8)} (${tonAmount.toFixed(4)} TON = ${rubAmount.toFixed(0)}₽)`)
        credited++
      }
    }

    const elapsed = Date.now() - startTime
    const summary = { credited, skipped, errors, total: txs.length, ton_price_rub: tonPriceRub, elapsed_ms: elapsed }
    console.log('Summary:', JSON.stringify(summary))

    return new Response(JSON.stringify(summary), {
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('Worker error:', err)
    return new Response(JSON.stringify({ error: 'internal_error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
