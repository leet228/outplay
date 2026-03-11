/**
 * Crypto price fetcher — CoinGecko free API with 60s cache
 */

let cache = { prices: null, fetchedAt: 0 }
const TTL = 60_000 // 1 minute

const IDS = 'the-open-network,tether,bitcoin,ethereum'
const URL = `https://api.coingecko.com/api/v3/simple/price?ids=${IDS}&vs_currencies=usd`

const FALLBACK = { ton: 3.5, usdt: 1, btc: 65000, eth: 3200 }

export async function getCryptoPrices() {
  if (cache.prices && Date.now() - cache.fetchedAt < TTL) {
    return cache.prices
  }

  try {
    const res = await fetch(URL)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()

    const prices = {
      ton:  data['the-open-network']?.usd ?? FALLBACK.ton,
      usdt: data['tether']?.usd ?? FALLBACK.usdt,
      btc:  data['bitcoin']?.usd ?? FALLBACK.btc,
      eth:  data['ethereum']?.usd ?? FALLBACK.eth,
    }

    cache = { prices, fetchedAt: Date.now() }
    return prices
  } catch (err) {
    console.warn('getCryptoPrices failed:', err.message)
    // Return stale cache or fallback
    return cache.prices ?? { ...FALLBACK }
  }
}
