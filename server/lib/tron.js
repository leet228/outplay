/**
 * TRON / USDT (TRC-20) balance & transactions via TronGrid API
 *
 * USDT contract on TRON mainnet: TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t
 */

const BASE = 'https://api.trongrid.io'
const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'

/**
 * Get TRX native balance (for gas) + USDT TRC-20 balance
 */
export async function getTronBalance(address) {
  const result = { trx: 0, usdt: 0 }

  try {
    // TRX native balance
    const res = await fetch(`${BASE}/v1/accounts/${address}`)
    if (res.ok) {
      const data = await res.json()
      if (data.data?.[0]) {
        // balance is in sun (1 TRX = 1e6 sun)
        result.trx = (data.data[0].balance || 0) / 1e6

        // Check TRC-20 balances
        const trc20 = data.data[0].trc20 || []
        for (const token of trc20) {
          if (token[USDT_CONTRACT]) {
            // USDT has 6 decimals
            result.usdt = Number(token[USDT_CONTRACT]) / 1e6
          }
        }
      }
    }
  } catch (err) {
    console.warn('getTronBalance error:', err.message)
  }

  return result
}

/**
 * Get recent USDT (TRC-20) transactions
 */
export async function getTronTransactions(address, limit = 10) {
  try {
    const url = `${BASE}/v1/accounts/${address}/transactions/trc20` +
      `?contract_address=${USDT_CONTRACT}&limit=${limit}&order_by=block_timestamp,desc`

    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()

    return (data.data || []).map(tx => ({
      hash: tx.transaction_id || '',
      from: tx.from || '',
      to: tx.to || '',
      amount: tx.value ? Number(tx.value) / 1e6 : 0,
      token: tx.token_info?.symbol || 'USDT',
      timestamp: tx.block_timestamp
        ? new Date(tx.block_timestamp).toISOString()
        : null,
      type: tx.to?.toLowerCase() === address.toLowerCase() ? 'incoming' : 'outgoing',
    }))
  } catch (err) {
    console.warn('getTronTransactions error:', err.message)
    return []
  }
}
