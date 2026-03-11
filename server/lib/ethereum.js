/**
 * Ethereum balance via ethers.js + free public RPC
 * Transactions via Etherscan-like API (limited without key)
 */

import { JsonRpcProvider, formatEther } from 'ethers'

// Free public RPCs (rotate on failure)
const RPC_URLS = [
  'https://eth.llamarpc.com',
  'https://rpc.ankr.com/eth',
  'https://1rpc.io/eth',
]

let currentRpcIndex = 0

function getProvider() {
  return new JsonRpcProvider(RPC_URLS[currentRpcIndex])
}

function rotateRpc() {
  currentRpcIndex = (currentRpcIndex + 1) % RPC_URLS.length
}

export async function getEthBalance(address) {
  for (let attempt = 0; attempt < RPC_URLS.length; attempt++) {
    try {
      const provider = getProvider()
      const balance = await provider.getBalance(address)
      return Number(formatEther(balance))
    } catch (err) {
      console.warn(`getEthBalance RPC ${RPC_URLS[currentRpcIndex]} failed:`, err.message)
      rotateRpc()
    }
  }
  return 0
}

/**
 * Get recent ETH transactions via Etherscan public API
 * Note: without API key, limited to 1 req/5sec. For phase 1 this is fine.
 */
export async function getEthTransactions(address, limit = 10) {
  try {
    const url = `https://api.etherscan.io/api` +
      `?module=account&action=txlist&address=${address}` +
      `&startblock=0&endblock=99999999&page=1&offset=${limit}` +
      `&sort=desc`

    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()

    if (data.status !== '1' || !Array.isArray(data.result)) return []

    return data.result.map(tx => ({
      hash: tx.hash || '',
      from: tx.from || '',
      to: tx.to || '',
      amount: tx.value ? Number(formatEther(BigInt(tx.value))) : 0,
      timestamp: tx.timeStamp
        ? new Date(Number(tx.timeStamp) * 1000).toISOString()
        : null,
      type: tx.to?.toLowerCase() === address.toLowerCase() ? 'incoming' : 'outgoing',
    }))
  } catch (err) {
    console.warn('getEthTransactions error:', err.message)
    return []
  }
}
