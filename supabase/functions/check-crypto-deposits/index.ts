import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// TON wallet address (same as in src/lib/addresses.js)
const TON_ADDRESS = 'UQBMTQ2VRSwRbvthtGTIB7Tip37yqueFw8SnVvWB7y18F47t'

// Minimum deposit in RUB (1 star = 1 RUB)
const MIN_RUB = 200

// ── Helpers ──

async function getTonPrice(): Promise<number> {
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=rub'
    )
    const data = await res.json()
    return data['the-open-network']?.rub ?? 0
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
    const res = await fetch(
      `https://toncenter.com/api/v2/getTransactions?address=${TON_ADDRESS}&limit=20`
    )
    const data = await res.json()
    if (!data.ok) {
      console.error('TonCenter error:', data)
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

serve(async (req) => {
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

    // 1. Get TON price in RUB
    const tonPriceRub = await getTonPrice()
    if (tonPriceRub <= 0) {
      console.error('Cannot get TON price, skipping')
      return new Response(JSON.stringify({ error: 'no price' }), { status: 200 })
    }

    console.log(`TON price: ${tonPriceRub} RUB`)

    // 2. Get recent transactions
    const txs = await getTonTransactions()
    console.log(`Found ${txs.length} transactions`)

    let credited = 0
    let skipped = 0

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

      // Parse telegram_id from comment
      const telegramId = parseInt(comment, 10)
      if (isNaN(telegramId) || telegramId <= 0) { skipped++; continue }

      // Find user by telegram_id
      const { data: user } = await supabase
        .from('users')
        .select('id')
        .eq('telegram_id', telegramId)
        .single()

      if (!user) {
        console.log(`No user for telegram_id=${telegramId}, skipping tx ${txHash.slice(0, 16)}...`)
        skipped++
        continue
      }

      // Credit deposit (deduplication inside RPC)
      const stars = Math.round(rubAmount) // 1 star = 1 RUB
      const { data: result, error } = await supabase.rpc('process_crypto_deposit', {
        p_user_id: user.id,
        p_stars: stars,
        p_tx_hash: txHash,
        p_chain: 'ton',
        p_crypto_amt: tonAmount,
        p_rub_amount: rubAmount,
      })

      if (error) {
        console.error(`RPC error for tx ${txHash.slice(0, 16)}:`, error.message)
      } else if (result?.duplicate) {
        // Already processed, skip silently
      } else if (result?.credited) {
        console.log(`Credited ${stars} stars to user ${user.id} (${tonAmount} TON = ${rubAmount.toFixed(0)} RUB)`)
        credited++
      }
    }

    const summary = { credited, skipped, total: txs.length, ton_price_rub: tonPriceRub }
    console.log('Summary:', JSON.stringify(summary))

    return new Response(JSON.stringify(summary), {
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('Worker error:', err)
    return new Response(JSON.stringify({ error: 'internal error' }), { status: 500 })
  }
})
