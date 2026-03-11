import { Router } from 'express'
import { getCryptoPrices } from '../lib/prices.js'
import { getTonBalance, getTonTransactions } from '../lib/ton.js'
import { getTronBalance, getTronTransactions } from '../lib/tron.js'
import { getBtcBalance, getBtcTransactions } from '../lib/bitcoin.js'
import { getEthBalance, getEthTransactions } from '../lib/ethereum.js'

const router = Router()

// Wallet config from env
function getWalletConfig() {
  return {
    ton:  { address: process.env.WALLET_TON_ADDRESS  || '' },
    tron: { address: process.env.WALLET_TRON_ADDRESS || '' },
    btc:  { address: process.env.WALLET_BTC_ADDRESS  || '' },
    eth:  { address: process.env.WALLET_ETH_ADDRESS  || '' },
  }
}

// Chain-specific balance fetchers
const balanceFetchers = {
  ton:  async (addr) => {
    const balance = await getTonBalance(addr)
    return { balance, symbol: 'TON' }
  },
  tron: async (addr) => {
    const { usdt, trx } = await getTronBalance(addr)
    return { balance: usdt, symbol: 'USDT', extra: { trx } }
  },
  btc:  async (addr) => {
    const balance = await getBtcBalance(addr)
    return { balance, symbol: 'BTC' }
  },
  eth:  async (addr) => {
    const balance = await getEthBalance(addr)
    return { balance, symbol: 'ETH' }
  },
}

// Chain-specific tx fetchers
const txFetchers = {
  ton:  (addr, limit) => getTonTransactions(addr, limit),
  tron: (addr, limit) => getTronTransactions(addr, limit),
  btc:  (addr, limit) => getBtcTransactions(addr, limit),
  eth:  (addr, limit) => getEthTransactions(addr, limit),
}

// Price keys for USD conversion
const priceKeys = { ton: 'ton', tron: 'usdt', btc: 'btc', eth: 'eth' }

/**
 * GET /api/wallets/status — all wallets summary
 */
router.get('/status', async (_req, res) => {
  try {
    const config = getWalletConfig()
    const prices = await getCryptoPrices()

    const wallets = await Promise.all(
      Object.entries(config).map(async ([chain, { address }]) => {
        if (!address) {
          return { chain, address: '', balance: 0, balanceUsd: 0, symbol: '', configured: false }
        }

        const fetcher = balanceFetchers[chain]
        const result = await fetcher(address)
        const priceUsd = prices[priceKeys[chain]] || 0
        const balanceUsd = result.balance * priceUsd

        return {
          chain,
          address,
          balance: result.balance,
          balanceUsd: Math.round(balanceUsd * 100) / 100,
          symbol: result.symbol,
          configured: true,
          ...(result.extra ? { extra: result.extra } : {}),
        }
      })
    )

    const totalUsd = wallets.reduce((sum, w) => sum + w.balanceUsd, 0)

    res.json({
      wallets,
      totalUsd: Math.round(totalUsd * 100) / 100,
      prices,
      fetchedAt: new Date().toISOString(),
    })
  } catch (err) {
    console.error('GET /status error:', err)
    res.status(500).json({ error: 'Failed to fetch wallet status' })
  }
})

/**
 * GET /api/wallets/:chain/balance — single chain balance
 */
router.get('/:chain/balance', async (req, res) => {
  const { chain } = req.params
  const config = getWalletConfig()

  if (!config[chain]) {
    return res.status(400).json({ error: `Unknown chain: ${chain}` })
  }

  const { address } = config[chain]
  if (!address) {
    return res.status(404).json({ error: `${chain} wallet not configured` })
  }

  try {
    const fetcher = balanceFetchers[chain]
    const result = await fetcher(address)
    const prices = await getCryptoPrices()
    const priceUsd = prices[priceKeys[chain]] || 0

    res.json({
      chain,
      address,
      balance: result.balance,
      balanceUsd: Math.round(result.balance * priceUsd * 100) / 100,
      symbol: result.symbol,
      ...(result.extra ? { extra: result.extra } : {}),
    })
  } catch (err) {
    console.error(`GET /${chain}/balance error:`, err)
    res.status(500).json({ error: 'Failed to fetch balance' })
  }
})

/**
 * GET /api/wallets/:chain/transactions — recent txs
 */
router.get('/:chain/transactions', async (req, res) => {
  const { chain } = req.params
  const limit = Math.min(parseInt(req.query.limit) || 10, 50)
  const config = getWalletConfig()

  if (!config[chain]) {
    return res.status(400).json({ error: `Unknown chain: ${chain}` })
  }

  const { address } = config[chain]
  if (!address) {
    return res.status(404).json({ error: `${chain} wallet not configured` })
  }

  try {
    const fetcher = txFetchers[chain]
    const transactions = await fetcher(address, limit)

    res.json({ chain, address, transactions })
  } catch (err) {
    console.error(`GET /${chain}/transactions error:`, err)
    res.status(500).json({ error: 'Failed to fetch transactions' })
  }
})

export default router
