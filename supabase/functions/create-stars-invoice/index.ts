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
    const { amount, user_id } = await req.json()

    if (!amount || amount < 1) {
      return new Response(
        JSON.stringify({ error: 'Invalid amount' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!user_id) {
      return new Response(
        JSON.stringify({ error: 'Missing user_id' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Generate a single tx_id used by BOTH webhook and client for dedup
    const txId = crypto.randomUUID()
    const payload = JSON.stringify({ user_id, amount, tx_id: txId })

    const res = await fetch(`${TELEGRAM_API}/createInvoiceLink`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: `${amount} Stars`,
        description: `Top up balance with ${amount} Telegram Stars`,
        payload,
        provider_token: '',
        currency: 'XTR',
        prices: [{ label: 'Stars', amount }],
      }),
    })

    const data = await res.json()

    if (!data.ok) {
      console.error('Telegram API error:', data)
      return new Response(
        JSON.stringify({ error: data.description || 'Failed to create invoice' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Return invoice URL + tx_id so client can also call process_deposit as backup
    return new Response(
      JSON.stringify({ url: data.result, tx_id: txId }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    console.error('Edge function error:', err)
    return new Response(
      JSON.stringify({ error: 'Internal error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
