import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

async function logToAdmin(level: string, message: string, details: Record<string, unknown> = {}) {
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    await supabase.rpc('admin_log', {
      p_level: level,
      p_source: 'edge:create-stars-invoice',
      p_message: message,
      p_details: details,
    })
  } catch (e) {
    console.error('Failed to write admin log:', e)
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { amount, user_id, currency_amount, currency_code } = await req.json()

    if (!amount || amount < 1) {
      await logToAdmin('warn', 'Invalid amount', { amount, user_id })
      return new Response(
        JSON.stringify({ error: 'Invalid amount' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!user_id) {
      await logToAdmin('warn', 'Missing user_id', { amount })
      return new Response(
        JSON.stringify({ error: 'Missing user_id' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Generate a single tx_id used by BOTH webhook and client for dedup
    // Payload MUST be ≤128 bytes (Telegram limit) — use short keys
    const txId = crypto.randomUUID()
    const p: Record<string, unknown> = { u: user_id, a: amount, t: txId }
    if (currency_amount != null) p.ca = currency_amount
    if (currency_code) p.cc = currency_code
    const payload = JSON.stringify(p)

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
      await logToAdmin('error', 'Telegram API error: ' + (data.description || 'unknown'), { user_id, amount, response: data })
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
    await logToAdmin('error', 'Unhandled exception: ' + (err as Error).message, { stack: (err as Error).stack })
    return new Response(
      JSON.stringify({ error: 'Internal error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
