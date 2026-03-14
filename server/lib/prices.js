/**
 * Crypto price fetcher — CoinLore free API with 60s cache
 * No API key, no rate limits (рекомендуют 1 req/sec)
 */

let cache = { prices: null, fetchedAt: 0 }
const TTL = 60_000 // 1 minute

// CoinLore IDs: TON=54683, BTC=90, ETH=80, USDT=518
const COINLORE_URL = 'https://api.coinlore.net/api/ticker/?id=54683,90,80,518'

const FALLBACK = { ton: 3.5, usdt: 1, btc: 65000, eth: 3200 }

export async function getCryptoPrices() {
  if (cache.prices && Date.now() - cache.fetchedAt < TTL) {
    return cache.prices
  }

  try {
    const res = await fetch(COINLORE_URL)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()

    const bySymbol = {}
    for (const coin of data) {
      bySymbol[coin.symbol?.toLowerCase()] = parseFloat(coin.price_usd) || 0
    }

    const prices = {
      ton:  bySymbol['ton']  || FALLBACK.ton,
      usdt: bySymbol['usdt'] || FALLBACK.usdt,
      btc:  bySymbol['btc']  || FALLBACK.btc,
      eth:  bySymbol['eth']  || FALLBACK.eth,
    }

    cache = { prices, fetchedAt: Date.now() }
    return prices
  } catch (err) {
    console.warn('getCryptoPrices failed:', err.message)
    // Return stale cache or fallback
    return cache.prices ?? { ...FALLBACK }
  }
}
