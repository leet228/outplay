/**
 * support-webhook — Supabase Edge Function
 * Handles @outplaysupportbot messages:
 * - User writes → forwarded to admin with user info header
 * - Admin replies to forwarded msg → bot sends reply back to user
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'

const BOT_TOKEN = Deno.env.get('SUPPORT_BOT_TOKEN')!
const ADMIN_CHAT_ID = Deno.env.get('ADMIN_TG_ID') || '945676433'
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`

async function sendMessage(chatId: string | number, text: string, replyTo?: number) {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
  }
  if (replyTo) body.reply_to_message_id = replyTo

  const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

async function forwardMessage(chatId: string | number, fromChatId: number, messageId: number) {
  const res = await fetch(`${TELEGRAM_API}/forwardMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      from_chat_id: fromChatId,
      message_id: messageId,
    }),
  })
  return res.json()
}

async function copyMessage(chatId: string | number, fromChatId: number, messageId: number) {
  const res = await fetch(`${TELEGRAM_API}/copyMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      from_chat_id: fromChatId,
      message_id: messageId,
    }),
  })
  return res.json()
}

serve(async (req) => {
  try {
    const update = await req.json()
    const msg = update.message
    if (!msg) return new Response('ok')

    const chatId = String(msg.chat.id)
    const isAdmin = chatId === ADMIN_CHAT_ID

    if (isAdmin) {
      // ── Admin replies to a forwarded message → send back to user ──
      const reply = msg.reply_to_message
      if (!reply) {
        // Admin sent a message without replying — ignore or show hint
        await sendMessage(ADMIN_CHAT_ID, '💡 Чтобы ответить пользователю, ответьте реплаем на его сообщение.')
        return new Response('ok')
      }

      // The replied-to message should be a forwarded one — get original sender
      const originalChat = reply.forward_from?.id || reply.forward_sender_name
      if (reply.forward_from?.id) {
        // Forward the admin's reply to the user
        await copyMessage(reply.forward_from.id, msg.chat.id, msg.message_id)
      } else {
        await sendMessage(ADMIN_CHAT_ID, '⚠️ Не удалось определить пользователя. Убедитесь что отвечаете реплаем на пересланное сообщение.')
      }

      return new Response('ok')
    }

    // ── User message → forward to admin ──

    // Handle /start
    if (msg.text === '/start') {
      await sendMessage(chatId,
        '👋 Привет! Это поддержка <b>Outplay</b>.\n\n' +
        'Опиши свою проблему или вопрос — мы ответим как можно скорее!'
      )
      return new Response('ok')
    }

    // Forward user's message to admin
    const result = await forwardMessage(ADMIN_CHAT_ID, msg.chat.id, msg.message_id)

    if (result.ok) {
      // Send confirmation to user
      await sendMessage(chatId,
        '✅ Сообщение получено! Мы ответим в ближайшее время.'
      )
    }

    return new Response('ok')
  } catch (err) {
    console.error('Support webhook error:', err)
    return new Response('ok')
  }
})
