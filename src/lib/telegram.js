// Telegram WebApp SDK helper
export const tg = window.Telegram?.WebApp

export function initTelegram() {
  if (!tg) return null
  tg.ready()
  tg.expand()
  try { tg.requestFullscreen?.() } catch {}
  try { tg.disableVerticalSwipes?.() } catch {}
  return tg
}

export function getTelegramUser() {
  return tg?.initDataUnsafe?.user ?? null
}

export function getStartParam() {
  return tg?.initDataUnsafe?.start_param ?? null
}

export function haptic(style = 'light') {
  tg?.HapticFeedback?.impactOccurred(style)
}

// Telegram Stars payment
export function requestStarsPayment({ title, description, payload, amount, onSuccess, onFail }) {
  if (!tg) return
  tg.openInvoice(payload, (status) => {
    if (status === 'paid') onSuccess?.()
    else onFail?.(status)
  })
}

export function closeMiniApp() {
  tg?.close()
}

export const isTelegram = !!window.Telegram?.WebApp
