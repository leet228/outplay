import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const MINI_APP_URL = Deno.env.get('MINI_APP_URL') || 'https://t.me/outplaymoneybot/app'

// Welcome image attached to /start. Set to a Telegram file_id (preferred —
// cached on TG side) or a public https URL. If empty, /start falls back to
// a plain text message.
const WELCOME_PHOTO = Deno.env.get('WELCOME_PHOTO_FILE_ID') || ''

// Webhook secret token (set via setWebhook API: secret_token param)
const WEBHOOK_SECRET = Deno.env.get('TELEGRAM_WEBHOOK_SECRET') || ''

async function logToAdmin(level: string, message: string, details: Record<string, unknown> = {}) {
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    await supabase.rpc('admin_log', {
      p_level: level,
      p_source: 'edge:telegram-webhook',
      p_message: message,
      p_details: details,
    })
  } catch (e) {
    console.error('Failed to write admin log:', e)
  }
}

serve(async (req) => {
  // ── Security: verify Telegram signature ──
  if (WEBHOOK_SECRET) {
    const signature = req.headers.get('x-telegram-bot-api-secret-token')
    if (signature !== WEBHOOK_SECRET) {
      console.warn('Invalid webhook signature, rejecting')
      await logToAdmin('warn', 'Invalid webhook signature rejected')
      return new Response('unauthorized', { status: 401 })
    }
  }

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
      const result = await res.json()
      console.log('answerPreCheckoutQuery:', result.ok)
      if (!result.ok) {
        await logToAdmin('error', 'answerPreCheckoutQuery failed', { result })
      }
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

          if (error) {
            console.error('process_deposit RPC error:', error.message, { user_id, amount, tx_id })
            await logToAdmin('error', 'process_deposit RPC failed: ' + error.message, { user_id, amount, tx_id })
          } else {
            console.log('process_deposit OK:', JSON.stringify(data))
            if (data?.duplicate) {
              await logToAdmin('warn', 'Duplicate deposit detected', { user_id, amount, tx_id })
            }
          }
        } else {
          console.warn('Missing required payload fields:', { user_id, amount, tx_id })
          await logToAdmin('warn', 'Missing payload fields in successful_payment', { user_id, amount, tx_id, raw_payload: payment.invoice_payload })
        }
      } catch (e) {
        console.error('Webhook deposit error:', e)
        await logToAdmin('error', 'Webhook deposit processing error: ' + (e as Error).message, { payment_payload: payment.invoice_payload })
      }

      return new Response('ok')
    }

    // ── /start command → open Mini App (with referral param if present) ──
    if (update.message?.text?.startsWith('/start')) {
      const chatId = update.message.chat.id
      const parts = update.message.text.split(' ')
      const startParam = parts[1] || '' // e.g. "ref_UUID"

      const appUrl = startParam
        ? `${MINI_APP_URL}?startapp=${startParam}`
        : MINI_APP_URL

      const text = startParam.startsWith('ref_')
        ? [
          '<b>Your friend invited you to Outplay!</b>',
          '',
          '<blockquote>Start bonus:',
          '⭐ Join through this invite and get your welcome reward.',
          '🎮 Play fast 1v1 duels: Quiz, Blackjack, Reaction and more.',
          '🏆 Choose a game and take the bank.',
          '👥 Invite friends and earn referral rewards too.',
          '💎 Climb leaderboards, join guilds and become PRO.</blockquote>',
          '',
          '<b>Outplay — accept the invite and outplay everyone.</b>',
        ].join('\n')
        : [
          '<b>Outplay — mini-games with real stakes!</b>',
          '',
          '<blockquote>Your bonuses:',
          '⭐ Bonus rewards for active players.',
          '🎮 1v1 duels: Quiz, Blackjack, Reaction and more.',
          '🏆 Choose a game and take the bank.',
          '👥 Invite friends and get referral rewards.',
          '💎 Join guilds, climb leaderboards, become PRO.',
          '⚡ Fast top-ups and smooth Telegram gameplay.</blockquote>',
          '',
          '<b>Outplay — choose a game and outplay everyone.</b>',
        ].join('\n')

      const replyMarkup = {
        inline_keyboard: [[
          { text: 'Play', url: appUrl }
        ]]
      }

      if (WELCOME_PHOTO) {
        // Photo mode — caption limit is 1024 chars, current copy is well under.
        const photoRes = await fetch(`${TELEGRAM_API}/sendPhoto`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            photo: WELCOME_PHOTO,
            caption: text,
            parse_mode: 'HTML',
            reply_markup: replyMarkup,
          }),
        })

        // If the photo failed (e.g. invalid file_id after env change), fall
        // back to plain text so /start never returns nothing.
        if (!photoRes.ok) {
          await logToAdmin('warn', 'sendPhoto failed on /start, falling back to text', {
            status: photoRes.status,
            body: await photoRes.text(),
          })
          await fetch(`${TELEGRAM_API}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text,
              parse_mode: 'HTML',
              reply_markup: replyMarkup,
            }),
          })
        }
      } else {
        await fetch(`${TELEGRAM_API}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: 'HTML',
            reply_markup: replyMarkup,
          }),
        })
      }

      return new Response('ok')
    }

    return new Response('ok')
  } catch (err) {
    console.error('Webhook error:', err)
    await logToAdmin('error', 'Unhandled webhook exception: ' + (err as Error).message, { stack: (err as Error).stack })
    return new Response('ok')
  }
})
