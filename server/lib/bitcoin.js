/**
 * Bitcoin balance & transactions via Blockstream API (free, no key)
 */

const BASE = 'https://blockstream.info/api'

export async function getBtcBalance(address) {
  try {
    const res = await fetch(`${BASE}/address/${address}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()

    const stats = data.chain_stats || {}
    // Balance in satoshis: funded - spent
    const satoshis =
      (stats.funded_txo_sum || 0) - (stats.spent_txo_sum || 0)
    return satoshis / 1e8 // BTC
  } catch (err) {
    console.warn('getBtcBalance error:', err.message)
    return 0
  }
}

export async function getBtcTransactions(address, limit = 10) {
  try {
    const res = await fetch(`${BASE}/address/${address}/txs`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const txs = await res.json()

    return txs.slice(0, limit).map(tx => {
      // Find output to our address (incoming) or input from our address
      const incoming = tx.vout?.find(
        v => v.scriptpubkey_address === address
      )
      const outgoing = tx.vin?.find(
        v => v.prevout?.scriptpubkey_address === address
      )

      let amount = 0
      let type = 'unknown'
      if (incoming) {
        amount = incoming.value / 1e8
        type = 'incoming'
      } else if (outgoing) {
        amount = outgoing.prevout.value / 1e8
        type = 'outgoing'
      }

      return {
        hash: tx.txid || '',
        amount,
        type,
        confirmations: tx.status?.confirmed ? tx.status.block_height : 0,
        timestamp: tx.status?.block_time
          ? new Date(tx.status.block_time * 1000).toISOString()
          : null,
      }
    })
  } catch (err) {
    console.warn('getBtcTransactions error:', err.message)
    return []
  }
}
