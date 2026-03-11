/**
 * Currency module — real exchange rates with caching + formatting
 *
 * RUB = base currency. 1 Star ≈ 1 RUB.
 * All prices/amounts stored in RUB, converted on display.
 *
 * Rates format: { RUB: 1, USD: 0.0127, EUR: 0.0109 }
 * Usage:  rubAmount * rates[code] → amount in target currency
 */

const CACHE_KEY = 'outplay_rates'
const CACHE_TTL = 60 * 60 * 1000 // 1 hour

// Hardcoded fallback (approximate, updated manually)
const FALLBACK_RATES = { RUB: 1, USD: 0.0127, EUR: 0.0109 }

/**
 * Fetch live rates from Frankfurter API.
 * Returns { RUB: 1, USD: x, EUR: y } or cached/fallback.
 */
export async function fetchRates() {
  // 1. Try fresh cache
  const cached = readCache()
  if (cached && cached.fresh) return cached.rates

  // 2. Fetch from API (open.er-api.com — free, supports RUB, no key)
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/RUB')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    if (data.result !== 'success') throw new Error('API error')
    const rates = {
      RUB: 1,
      USD: data.rates?.USD ?? FALLBACK_RATES.USD,
      EUR: data.rates?.EUR ?? FALLBACK_RATES.EUR,
    }
    writeCache(rates)
    return rates
  } catch (err) {
    console.warn('fetchRates failed:', err.message)
  }

  // 3. Stale cache
  if (cached) return cached.rates

  // 4. Hardcoded fallback
  return { ...FALLBACK_RATES }
}

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const { rates, ts } = JSON.parse(raw)
    if (!rates || !ts) return null
    return { rates, fresh: Date.now() - ts < CACHE_TTL }
  } catch {
    return null
  }
}

function writeCache(rates) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ rates, ts: Date.now() }))
  } catch { /* quota */ }
}

/**
 * Convert RUB amount to target currency.
 * @param {number} rubAmount — amount in RUB (= Stars)
 * @param {string} code — 'RUB' | 'USD' | 'EUR'
 * @param {object} rates — { RUB: 1, USD: x, EUR: y }
 * @returns {number}
 */
export function convertFromRub(rubAmount, code, rates) {
  if (!rates || code === 'RUB') return rubAmount
  return rubAmount * (rates[code] ?? 1)
}

/**
 * Format RUB amount as a display string in the target currency.
 *
 * @param {number} rubAmount — amount in RUB (= Stars)
 * @param {{ symbol: string, code: string }} currency
 * @param {object} rates — { RUB: 1, USD: x, EUR: y }
 * @param {object} [opts]
 * @param {string} [opts.sign] — '+' to prepend on positive values
 * @param {boolean} [opts.approximate] — prefix with ≈
 * @param {boolean} [opts.abs] — use absolute value
 * @returns {string}
 */
export function formatCurrency(rubAmount, currency, rates, opts = {}) {
  const { sign, approximate, abs: useAbs } = opts
  let amount = convertFromRub(rubAmount, currency.code, rates)
  if (useAbs) amount = Math.abs(amount)

  let prefix = ''
  if (approximate) prefix += '≈ '
  if (sign === '+' && rubAmount > 0) prefix += '+'
  else if (rubAmount < 0 && !useAbs) prefix += '' // minus is part of the number

  if (currency.code === 'RUB') {
    // RUB: целое число, пробел как разделитель, символ после
    const rounded = Math.round(amount)
    const formatted = formatWithSpaces(Math.abs(rounded))
    const neg = rounded < 0 && !useAbs ? '-' : ''
    return `${prefix}${neg}${formatted} ${currency.symbol}`
  }

  // USD / EUR: 2 decimal places, symbol before
  const fixed = Math.abs(amount).toFixed(2)
  const neg = amount < 0 && !useAbs ? '-' : ''
  return `${prefix}${neg}${currency.symbol}${fixed}`
}

/**
 * Format number with space as thousands separator: 5000 → "5 000"
 */
function formatWithSpaces(num) {
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '\u00A0')
}
