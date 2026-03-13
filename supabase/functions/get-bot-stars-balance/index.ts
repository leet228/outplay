import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'

const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Fetch all star transactions and sum them up to get balance
    let balance = 0
    let offset = 0
    const limit = 100

    while (true) {
      const res = await fetch(`${TELEGRAM_API}/getStarTransactions?offset=${offset}&limit=${limit}`)
      const data = await res.json()

      if (!data.ok || !data.result?.transactions?.length) break

      for (const tx of data.result.transactions) {
        balance += tx.amount // positive = incoming, negative = outgoing
      }

      // If fewer than limit returned, we've fetched all
      if (data.result.transactions.length < limit) break
      offset += limit
    }

    return new Response(
      JSON.stringify({ balance }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    console.error('get-bot-stars-balance error:', err)
    return new Response(
      JSON.stringify({ error: 'internal_error', balance: 0 }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
