/**
 * TON balance & transactions via TonCenter API (free, no key for low volume)
 */

const BASE = 'https://toncenter.com/api/v2'

export async function getTonBalance(address) {
  try {
    const res = await fetch(`${BASE}/getAddressBalance?address=${address}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    if (!data.ok) throw new Error(data.error || 'API error')
    // result is in nanoTON (string)
    const nanoTon = BigInt(data.result)
    return Number(nanoTon) / 1e9
  } catch (err) {
    console.warn('getTonBalance error:', err.message)
    return 0
  }
}

export async function getTonTransactions(address, limit = 10) {
  try {
    const res = await fetch(
      `${BASE}/getTransactions?address=${address}&limit=${limit}&archival=false`
    )
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    if (!data.ok) return []

    return (data.result || []).map(tx => ({
      hash: tx.transaction_id?.hash || '',
      from: tx.in_msg?.source || '',
      to: tx.in_msg?.destination || '',
      amount: tx.in_msg?.value ? Number(tx.in_msg.value) / 1e9 : 0,
      timestamp: tx.utime ? new Date(tx.utime * 1000).toISOString() : null,
      type: tx.in_msg?.source ? 'incoming' : 'outgoing',
    }))
  } catch (err) {
    console.warn('getTonTransactions error:', err.message)
    return []
  }
}
