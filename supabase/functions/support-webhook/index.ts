/**
 * support-webhook — Supabase Edge Function
 * Handles @outplaysupportbot messages:
 * - User writes → admin receives a compact support card with recent context.
 * - Admin replies to that card or a forwarded message → bot sends reply back to user.
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const BOT_TOKEN = Deno.env.get('SUPPORT_BOT_TOKEN')!
const ADMIN_CHAT_ID = Deno.env.get('ADMIN_TG_ID') || '945676433'
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`

const CONTEXT_LIMIT = 10
const TELEGRAM_TEXT_LIMIT = 3900
const DEFAULT_CLEAR_LIMIT = 120
const MAX_CLEAR_LIMIT = 300

let supabase: ReturnType<typeof createClient> | null = null

type TelegramUser = {
  id: number
  first_name?: string
  last_name?: string
  username?: string
}

type TelegramMessage = {
  message_id: number
  chat: { id: number; username?: string; first_name?: string; last_name?: string; type?: string }
  from?: TelegramUser
  date?: number
  text?: string
  caption?: string
  photo?: unknown[]
  sticker?: { emoji?: string }
  document?: { file_name?: string }
  video?: unknown
  voice?: unknown
  audio?: unknown
  animation?: unknown
  contact?: { phone_number?: string; first_name?: string }
  location?: unknown
  reply_to_message?: TelegramMessage
  forward_from?: TelegramUser
  forward_sender_name?: string
}

type SupportMessage = {
  direction: 'user' | 'admin'
  body: string
  message_type: string
  created_at: string
}

type SupportAdminMessageRef = {
  telegram_id: number
  message_id: number
  root_message_id: number
}

function getSupabase() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null
  if (!supabase) supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  return supabase
}

function htmlEscape(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function formatDisplayName(msg: TelegramMessage) {
  const from = msg.from
  const username = from?.username || msg.chat.username
  const firstName = from?.first_name || msg.chat.first_name || ''
  const lastName = from?.last_name || msg.chat.last_name || ''
  const fullName = `${firstName} ${lastName}`.trim()

  if (username && fullName) return `${htmlEscape(fullName)} (@${htmlEscape(username)})`
  if (username) return `@${htmlEscape(username)}`
  if (fullName) return htmlEscape(fullName)
  return 'Unknown'
}

function formatContextTime(value: string) {
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'Europe/Moscow',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value))
  } catch {
    return value
  }
}

function getMessageType(msg: TelegramMessage) {
  if (msg.text) return 'text'
  if (msg.photo) return 'photo'
  if (msg.sticker) return 'sticker'
  if (msg.document) return 'document'
  if (msg.video) return 'video'
  if (msg.voice) return 'voice'
  if (msg.audio) return 'audio'
  if (msg.animation) return 'animation'
  if (msg.contact) return 'contact'
  if (msg.location) return 'location'
  return 'message'
}

function getMessageBody(msg: TelegramMessage) {
  if (msg.text) return msg.text.trim()
  if (msg.caption) return msg.caption.trim()
  if (msg.photo) return '[photo]'
  if (msg.sticker) return `[sticker${msg.sticker.emoji ? ` ${msg.sticker.emoji}` : ''}]`
  if (msg.document) return `[document${msg.document.file_name ? `: ${msg.document.file_name}` : ''}]`
  if (msg.video) return '[video]'
  if (msg.voice) return '[voice message]'
  if (msg.audio) return '[audio]'
  if (msg.animation) return '[animation]'
  if (msg.contact) return `[contact${msg.contact.first_name ? `: ${msg.contact.first_name}` : ''}]`
  if (msg.location) return '[location]'
  return '[message]'
}

function getTelegramId(msg: TelegramMessage) {
  return msg.from?.id || msg.chat.id
}

function extractTargetTelegramId(reply?: TelegramMessage, depth = 0): number | null {
  if (!reply) return null
  if (reply.forward_from?.id) return reply.forward_from.id

  const sourceText = reply.text || reply.caption || ''
  const match = sourceText.match(/TG ID:\s*([0-9]+)/i)
  if (match) return Number(match[1])

  if (depth < 2) return extractTargetTelegramId(reply.reply_to_message, depth + 1)
  return null
}

function buildContext(history: SupportMessage[]) {
  if (history.length === 0) return 'No previous messages.'

  return history
    .slice()
    .reverse()
    .map((item, index) => {
      const who = item.direction === 'admin' ? 'Support' : 'User'
      const icon = item.direction === 'admin' ? '🛟' : '👤'
      const time = formatContextTime(item.created_at)
      const body = item.body || `[${item.message_type}]`
      return `${index + 1}. ${icon} ${who} · ${time}\n${body}`
    })
    .join('\n\n')
}

function buildAdminCard(msg: TelegramMessage, history: SupportMessage[], includeContext = true) {
  const telegramId = getTelegramId(msg)
  const body = getMessageBody(msg)
  const messageType = getMessageType(msg)
  const context = buildContext(history)

  const lines = [
    '<b>💬 New support message</b>',
    '',
    `<b>TG ID:</b> <code>${telegramId}</code>`,
    `<b>User:</b> ${formatDisplayName(msg)}`,
    `<b>Type:</b> <code>${htmlEscape(messageType)}</code>`,
    '',
    '<b>New message:</b>',
    `<blockquote expandable>${htmlEscape(body)}</blockquote>`,
  ]

  if (includeContext) {
    lines.push(
      '',
      '<b>Context:</b>',
      `<blockquote expandable>${htmlEscape(context)}</blockquote>`,
    )
  } else if (history.length > 0) {
    lines.push('', '<i>Full context is attached below.</i>')
  }

  lines.push('', '<i>Reply to this message to answer the user.</i>')
  return lines.join('\n')
}

function splitContext(context: string) {
  const parts = context.split('\n\n')
  const chunks: string[] = []
  let current = ''

  for (const part of parts) {
    const next = current ? `${current}\n\n${part}` : part
    if (htmlEscape(next).length <= TELEGRAM_TEXT_LIMIT - 300) {
      current = next
      continue
    }

    if (current) chunks.push(current)

    if (htmlEscape(part).length <= TELEGRAM_TEXT_LIMIT - 300) {
      current = part
      continue
    }

    for (let i = 0; i < part.length; i += TELEGRAM_TEXT_LIMIT - 500) {
      chunks.push(part.slice(i, i + TELEGRAM_TEXT_LIMIT - 500))
    }
    current = ''
  }

  if (current) chunks.push(current)
  return chunks
}

function buildContextCard(telegramId: number, chunk: string, index: number, total: number) {
  return [
    `<b>💬 Support context ${index}/${total}</b>`,
    `<b>TG ID:</b> <code>${telegramId}</code>`,
    '',
    `<blockquote expandable>${htmlEscape(chunk)}</blockquote>`,
    '',
    '<i>You can reply to this message too.</i>',
  ].join('\n')
}

function buildAdminPayloads(msg: TelegramMessage, history: SupportMessage[]) {
  const fullCard = buildAdminCard(msg, history, true)
  if (fullCard.length <= TELEGRAM_TEXT_LIMIT) return [fullCard]

  const telegramId = getTelegramId(msg)
  const contextChunks = splitContext(buildContext(history))
  return [
    buildAdminCard(msg, history, false),
    ...contextChunks.map((chunk, index) => buildContextCard(telegramId, chunk, index + 1, contextChunks.length)),
  ]
}

async function sendMessage(chatId: string | number, text: string, replyTo?: number) {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  }
  if (replyTo) body.reply_to_message_id = replyTo

  const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

async function deleteMessage(chatId: string | number, messageId?: number) {
  if (!messageId) return null

  try {
    const res = await fetch(`${TELEGRAM_API}/deleteMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
      }),
    })
    return res.json()
  } catch (e) {
    console.error('deleteMessage exception:', e)
    return null
  }
}

async function deleteMessages(chatId: string | number, messageIds: Array<number | undefined>) {
  const uniqueIds = [...new Set(messageIds.filter((id): id is number => Number.isFinite(id)))]
  for (const messageId of uniqueIds) {
    await deleteMessage(chatId, messageId)
  }
}

function collectAnsweredAdminMessageIds(adminReply: TelegramMessage, repliedTo: TelegramMessage) {
  const ids = [adminReply.message_id, repliedTo.message_id]

  // If admin replies to the forwarded user message/context chunk, also remove
  // the root "New support message" card for that exact answer.
  let cursor = repliedTo.reply_to_message
  let depth = 0
  while (cursor && depth < 3) {
    ids.push(cursor.message_id)
    cursor = cursor.reply_to_message
    depth++
  }

  return ids
}

function parseClearLimit(text?: string) {
  const raw = text?.split(/\s+/)[1]
  const parsed = raw ? Number(raw) : DEFAULT_CLEAR_LIMIT
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_CLEAR_LIMIT
  return Math.min(Math.floor(parsed), MAX_CLEAR_LIMIT)
}

async function clearAdminChat(commandMessage: TelegramMessage) {
  const limit = parseClearLimit(commandMessage.text)
  const newestId = commandMessage.message_id

  // Telegram Bot API does not expose full private-chat history to bots, so we
  // delete a bounded window of recent message ids.
  const ids = Array.from({ length: limit }, (_, index) => newestId - index)
  const chunkSize = 20

  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize)
    await Promise.all(chunk.map((messageId) => deleteMessage(ADMIN_CHAT_ID, messageId)))
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
}

async function saveAdminMessageRef(telegramId: number, messageId?: number, rootMessageId?: number) {
  const sb = getSupabase()
  if (!sb || !messageId || !rootMessageId) return

  try {
    const { error } = await sb
      .from('support_admin_message_refs')
      .upsert({
        telegram_id: telegramId,
        message_id: messageId,
        root_message_id: rootMessageId,
      }, { onConflict: 'message_id' })

    if (error) console.error('Support admin ref save error:', error.message)
  } catch (e) {
    console.error('Support admin ref save exception:', e)
  }
}

async function getAdminMessageRef(messageId?: number): Promise<SupportAdminMessageRef | null> {
  const sb = getSupabase()
  if (!sb || !messageId) return null

  try {
    const { data, error } = await sb
      .from('support_admin_message_refs')
      .select('telegram_id, message_id, root_message_id')
      .eq('message_id', messageId)
      .maybeSingle()

    if (error) {
      console.error('Support admin ref fetch error:', error.message)
      return null
    }

    return data as SupportAdminMessageRef | null
  } catch (e) {
    console.error('Support admin ref fetch exception:', e)
    return null
  }
}

async function getAdminMessageGroup(rootMessageId?: number): Promise<number[]> {
  const sb = getSupabase()
  if (!sb || !rootMessageId) return rootMessageId ? [rootMessageId] : []

  try {
    const { data, error } = await sb
      .from('support_admin_message_refs')
      .select('message_id')
      .eq('root_message_id', rootMessageId)

    if (error) {
      console.error('Support admin group fetch error:', error.message)
      return [rootMessageId]
    }

    const ids = (data ?? []).map((row: { message_id: number }) => row.message_id)
    return ids.length > 0 ? ids : [rootMessageId]
  } catch (e) {
    console.error('Support admin group fetch exception:', e)
    return [rootMessageId]
  }
}

async function deleteAdminMessageRefs(rootMessageId?: number) {
  const sb = getSupabase()
  if (!sb || !rootMessageId) return

  try {
    const { error } = await sb
      .from('support_admin_message_refs')
      .delete()
      .eq('root_message_id', rootMessageId)

    if (error) console.error('Support admin refs delete error:', error.message)
  } catch (e) {
    console.error('Support admin refs delete exception:', e)
  }
}

async function forwardMessage(chatId: string | number, fromChatId: number, messageId: number, replyTo?: number) {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    from_chat_id: fromChatId,
    message_id: messageId,
  }
  if (replyTo) body.reply_to_message_id = replyTo

  const res = await fetch(`${TELEGRAM_API}/forwardMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

async function copyMessage(chatId: string | number, fromChatId: number, messageId: number, replyTo?: number) {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    from_chat_id: fromChatId,
    message_id: messageId,
  }
  if (replyTo) body.reply_to_message_id = replyTo

  const res = await fetch(`${TELEGRAM_API}/copyMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

async function getSupportHistory(telegramId: number): Promise<SupportMessage[]> {
  const sb = getSupabase()
  if (!sb) return []

  try {
    const { data, error } = await sb
      .from('support_messages')
      .select('direction, body, message_type, created_at')
      .eq('telegram_id', telegramId)
      .order('created_at', { ascending: false })
      .limit(CONTEXT_LIMIT)

    if (error) {
      console.error('Support history error:', error.message)
      return []
    }

    return (data ?? []) as SupportMessage[]
  } catch (e) {
    console.error('Support history exception:', e)
    return []
  }
}

async function saveSupportMessage(msg: TelegramMessage, direction: 'user' | 'admin', telegramId?: number) {
  const sb = getSupabase()
  if (!sb) return

  try {
    const targetTelegramId = telegramId || getTelegramId(msg)
    const { error } = await sb.from('support_messages').insert({
      telegram_id: targetTelegramId,
      username: msg.from?.username || msg.chat.username || null,
      first_name: msg.from?.first_name || msg.chat.first_name || null,
      message_id: msg.message_id,
      direction,
      message_type: getMessageType(msg),
      body: getMessageBody(msg),
    })

    if (error) console.error('Support save error:', error.message)
  } catch (e) {
    console.error('Support save exception:', e)
  }
}

serve(async (req) => {
  try {
    const update = await req.json()
    const msg = update.message as TelegramMessage | undefined
    if (!msg) return new Response('ok')

    const chatId = String(msg.chat.id)
    const isAdmin = chatId === ADMIN_CHAT_ID

    if (isAdmin) {
      if (/^\/clear(?:\s|$)/.test(msg.text || '')) {
        await clearAdminChat(msg)
        return new Response('ok')
      }

      const reply = msg.reply_to_message
      if (!reply) {
        await sendMessage(ADMIN_CHAT_ID, '💡 Reply to a user card to send a message.')
        return new Response('ok')
      }

      const adminRef = await getAdminMessageRef(reply.message_id)
      const targetTelegramId = extractTargetTelegramId(reply) || adminRef?.telegram_id
      if (!targetTelegramId) {
        await sendMessage(ADMIN_CHAT_ID, '⚠️ Could not identify the user. Reply to a support card with a TG ID.')
        return new Response('ok')
      }

      const sent = await copyMessage(targetTelegramId, msg.chat.id, msg.message_id)
      if (!sent?.ok) {
        console.error('Support reply delivery failed:', sent)
        await sendMessage(ADMIN_CHAT_ID, '⚠️ Could not send the reply to the user. Please try again.')
        return new Response('ok')
      }

      await saveSupportMessage(msg, 'admin', targetTelegramId)
      const answeredMessageIds = adminRef
        ? [msg.message_id, ...await getAdminMessageGroup(adminRef.root_message_id)]
        : collectAnsweredAdminMessageIds(msg, reply)

      await deleteMessages(ADMIN_CHAT_ID, answeredMessageIds)
      await deleteAdminMessageRefs(adminRef?.root_message_id)
      return new Response('ok')
    }

    if (msg.text === '/start') {
      await sendMessage(chatId,
        '👋 Hi! This is <b>Outplay</b> support.\n\n' +
        'Send your question or issue in one message, and we will reply as soon as possible.'
      )
      return new Response('ok')
    }

    const telegramId = getTelegramId(msg)
    const history = await getSupportHistory(telegramId)
    await saveSupportMessage(msg, 'user', telegramId)

    const adminPayloads = buildAdminPayloads(msg, history)
    const adminCard = await sendMessage(ADMIN_CHAT_ID, adminPayloads[0])
    const adminMessageId = adminCard?.result?.message_id

    if (adminCard?.ok) {
      await saveAdminMessageRef(telegramId, adminMessageId, adminMessageId)

      for (const payload of adminPayloads.slice(1)) {
        const contextMessage = await sendMessage(ADMIN_CHAT_ID, payload, adminMessageId)
        await saveAdminMessageRef(telegramId, contextMessage?.result?.message_id, adminMessageId)
      }
      const forwardedMessage = await forwardMessage(ADMIN_CHAT_ID, msg.chat.id, msg.message_id, adminMessageId)
      await saveAdminMessageRef(telegramId, forwardedMessage?.result?.message_id, adminMessageId)
    }

    await sendMessage(chatId, '💬')

    return new Response('ok')
  } catch (err) {
    console.error('Support webhook error:', err)
    return new Response('ok')
  }
})
