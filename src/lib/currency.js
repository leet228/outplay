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

// ── TON price cache ────────────────────────────────────────
// Separate from fiat rates because the source is different
// (CoinGecko, not Frankfurter). USD per 1 TON. USDT-on-TON is
// pegged ~$1 so we treat it as USD for the deposit equivalent.
const TON_PRICE_CACHE_KEY = 'outplay_ton_price'
const TON_PRICE_CACHE_TTL = 5 * 60 * 1000 // 5 min — TON is volatile
const TON_PRICE_FALLBACK  = 3.00          // safe approx, refreshed by fetch

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

/**
 * Fetch TON/USD price from CoinLore. Returns USD per 1 TON.
 * Cached for 5 minutes in localStorage. Falls back to a static
 * approximation if the API is down so the UI never shows "—".
 *
 * CoinLore is the same source used by the admin panel
 * (AdminDashboard, AdminWallet) — keeping it in sync here so
 * the player-facing deposit screen and the admin balance read
 * the SAME number.
 *   id=54683 = Toncoin (TON) on CoinLore's ticker index.
 */
export async function fetchTonPrice() {
  const cached = readTonPriceCache()
  if (cached && cached.fresh) return cached.price

  try {
    const res = await fetch('https://api.coinlore.net/api/ticker/?id=54683')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    const price = parseFloat(data?.[0]?.price_usd)
    if (Number.isFinite(price) && price > 0) {
      writeTonPriceCache(price)
      return price
    }
    throw new Error('no price in response')
  } catch (err) {
    console.warn('fetchTonPrice failed:', err.message)
  }

  if (cached) return cached.price
  return TON_PRICE_FALLBACK
}

// Generic live USD price for any CoinLore-listed coin — same
// source / 5-min cache discipline as fetchTonPrice, just keyed
// per coin id so the deposit sheet's extra chains (BTC/ETH/BNB/
// TRX/LTC) read a real rate exactly like TON does. Returns null
// (never a hardcoded guess) when the API + cache both miss, so
// the UI can hide the "≈ X COIN" line instead of lying.
const COIN_PRICE_CACHE_PREFIX = 'outplay_coin_price_'
const COIN_PRICE_CACHE_TTL = 5 * 60 * 1000 // 5 min, like TON

export async function fetchCoinPriceUsd(coinloreId) {
  if (!coinloreId) return null
  const key = COIN_PRICE_CACHE_PREFIX + coinloreId
  const readCacheEntry = () => {
    try {
      const raw = localStorage.getItem(key)
      if (!raw) return null
      const { price, ts } = JSON.parse(raw)
      if (!price || !ts) return null
      return { price, fresh: Date.now() - ts < COIN_PRICE_CACHE_TTL }
    } catch { return null }
  }

  const cached = readCacheEntry()
  if (cached && cached.fresh) return cached.price

  try {
    const res = await fetch(`https://api.coinlore.net/api/ticker/?id=${coinloreId}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    const price = parseFloat(data?.[0]?.price_usd)
    if (Number.isFinite(price) && price > 0) {
      try { localStorage.setItem(key, JSON.stringify({ price, ts: Date.now() })) } catch { /* quota */ }
      return price
    }
    throw new Error('no price in response')
  } catch (err) {
    console.warn('fetchCoinPriceUsd failed:', err.message)
  }

  if (cached) return cached.price
  return null
}

function readTonPriceCache() {
  try {
    const raw = localStorage.getItem(TON_PRICE_CACHE_KEY)
    if (!raw) return null
    const { price, ts } = JSON.parse(raw)
    if (!price || !ts) return null
    return { price, fresh: Date.now() - ts < TON_PRICE_CACHE_TTL }
  } catch {
    return null
  }
}

function writeTonPriceCache(price) {
  try {
    localStorage.setItem(TON_PRICE_CACHE_KEY, JSON.stringify({ price, ts: Date.now() }))
  } catch { /* quota */ }
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
