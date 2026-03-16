/**
 * notify-admin — Supabase Edge Function
 * Sends Telegram messages to admin on error/warn logs and new bug reports.
 * Called by SQL triggers via pg_net.
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'

const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!
const ADMIN_TG_ID = Deno.env.get('ADMIN_TG_ID') || '945676433'
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function formatLogMessage(data: Record<string, unknown>): string {
  const level = data.level as string
  const icon = level === 'error' ? '🔴' : '🟡'
  const source = escapeHtml(String(data.source || ''))
  const message = escapeHtml(String(data.message || ''))

  let text = `${icon} <b>${level.toUpperCase()}</b> | <code>${source}</code>\n${message}`

  if (data.details && typeof data.details === 'object' && Object.keys(data.details as object).length > 0) {
    const detailsStr = JSON.stringify(data.details, null, 2)
    if (detailsStr.length <= 500) {
      text += `\n<pre>${escapeHtml(detailsStr)}</pre>`
    } else {
      text += `\n<pre>${escapeHtml(detailsStr.substring(0, 500))}...</pre>`
    }
  }

  return text
}

function formatBugReportMessage(data: Record<string, unknown>): string {
  const username = data.username ? `@${escapeHtml(String(data.username))}` : 'unknown'
  const desc = escapeHtml(String(data.description || '').substring(0, 300))
  const photos = Number(data.photos_count) || 0
  const device = escapeHtml(String(data.device_info || '—'))

  let text = `🐛 <b>Новый баг-репорт</b>\n`
  text += `👤 ${username}\n`
  text += `📝 ${desc}\n`
  if (photos > 0) text += `📎 Фото: ${photos}\n`
  if (device && device !== '—') text += `📱 ${device}`

  return text
}

async function sendTelegramMessage(chatId: string, text: string) {
  const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  })

  const result = await res.json()
  if (!result.ok) {
    console.error('Telegram sendMessage failed:', result)
  }
  return result
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    if (!BOT_TOKEN) {
      console.error('TELEGRAM_BOT_TOKEN not set')
      return new Response(JSON.stringify({ error: 'bot_token_missing' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const body = await req.json()
    const { type, data } = body

    if (!type || !data) {
      return new Response(JSON.stringify({ error: 'missing_type_or_data' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    let message: string

    if (type === 'log') {
      message = formatLogMessage(data)
    } else if (type === 'bug_report') {
      message = formatBugReportMessage(data)
    } else {
      return new Response(JSON.stringify({ error: 'unknown_type' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const result = await sendTelegramMessage(ADMIN_TG_ID, message)

    return new Response(JSON.stringify({ ok: result.ok }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('notify-admin error:', err)
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
