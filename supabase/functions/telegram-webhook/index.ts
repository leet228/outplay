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

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const update = await req.json()
    console.log('Telegram update:', JSON.stringify(update))

    // ── Handle pre_checkout_query ──
    // Telegram sends this BEFORE charging the user.
    // We MUST answer within 10 seconds or payment fails.
    if (update.pre_checkout_query) {
      const queryId = update.pre_checkout_query.id

      // Always approve (for Stars, no additional validation needed)
      const res = await fetch(`${TELEGRAM_API}/answerPreCheckoutQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pre_checkout_query_id: queryId,
          ok: true,
        }),
      })

      const result = await res.json()
      console.log('answerPreCheckoutQuery result:', JSON.stringify(result))

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── Handle successful_payment ──
    // Telegram sends this AFTER payment is confirmed.
    // We credit the balance server-side as a safety net.
    if (update.message?.successful_payment) {
      const payment = update.message.successful_payment
      const payloadStr = payment.invoice_payload

      try {
        const payload = JSON.parse(payloadStr)
        const userId = payload.user_id
        const amount = payload.amount

        if (userId && amount) {
          const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

          // Use telegram_provider_charge_id as unique tx id for dedup
          const txId = payment.telegram_payment_charge_id || crypto.randomUUID()

          const { data, error } = await supabase.rpc('process_deposit', {
            p_user_id: userId,
            p_amount: amount,
            p_tx_id: txId,
          })

          console.log('process_deposit result:', JSON.stringify(data), 'error:', error)
        }
      } catch (e) {
        console.error('Failed to parse payload or process deposit:', e)
      }

      return new Response(JSON.stringify({ ok: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Other updates — ignore
    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (err) {
    console.error('Webhook error:', err)
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
