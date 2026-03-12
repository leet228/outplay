import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

serve(async (req) => {
  // Telegram always sends POST, no CORS needed for webhook
  try {
    const update = await req.json()

    // ── pre_checkout_query → MUST answer within 10s or payment fails ──
    if (update.pre_checkout_query) {
      const res = await fetch(`${TELEGRAM_API}/answerPreCheckoutQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pre_checkout_query_id: update.pre_checkout_query.id,
          ok: true,
        }),
      })
      console.log('answerPreCheckoutQuery:', (await res.json()).ok)
      return new Response('ok')
    }

    // ── successful_payment → credit balance in DB ──
    if (update.message?.successful_payment) {
      const payment = update.message.successful_payment

      try {
        const payload = JSON.parse(payment.invoice_payload)
        // Short keys: u=user_id, a=amount, t=tx_id, ca=currency_amount, cc=currency_code
        const user_id = payload.u ?? payload.user_id
        const amount = payload.a ?? payload.amount
        const tx_id = payload.t ?? payload.tx_id
        const currency_amount = payload.ca ?? payload.currency_amount
        const currency_code = payload.cc ?? payload.currency_code

        if (user_id && amount && tx_id) {
          const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

          const params: Record<string, unknown> = {
            p_user_id: user_id,
            p_amount: amount,
            p_tx_id: tx_id,
          }
          if (currency_amount != null) params.p_currency_amt = currency_amount
          if (currency_code) params.p_currency_code = currency_code

          const { data, error } = await supabase.rpc('process_deposit', params)

          console.log('process_deposit:', JSON.stringify(data), error?.message)
        }
      } catch (e) {
        console.error('Webhook deposit error:', e)
      }

      return new Response('ok')
    }

    return new Response('ok')
  } catch (err) {
    console.error('Webhook error:', err)
    return new Response('ok')
  }
})
