import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import useGameStore from '../store/useGameStore'
import './Admin.css'

// ── Admin Telegram IDs (add yours here) ──
const ADMIN_IDS = ['dev', 945676433]

// ── Wallet addresses (from .env, but we read from import.meta.env or hardcode) ──
const WALLETS = [
  {
    chain: 'ton',
    name: 'TON',
    symbol: 'TON',
    color: '#0098EA',
    address: 'UQBMTQ2VRSwRbvthtGTIB7Tip37yqueFw8SnVvWB7y18F47t',
  },
  {
    chain: 'tron',
    name: 'USDT (TRC-20)',
    symbol: 'USDT',
    color: '#26A17B',
    address: 'TVx8PrnGgqHc7hyE4fZicofS673AzqwjGA',
  },
  {
    chain: 'btc',
    name: 'Bitcoin',
    symbol: 'BTC',
    color: '#F7931A',
    address: 'bc1qu75zk4x2sl3k8s0hhq2pt9793m8lpxyryrvyvv',
  },
  {
    chain: 'eth',
    name: 'Ethereum',
    symbol: 'ETH',
    color: '#627EEA',
    address: '0xE20B131dadaf7f9e393b555d14e13aa2CD6034Db',
  },
]

// ── Blockchain API fetchers (direct, no server) ──

const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'

async function fetchTonBalance(address) {
  try {
    const res = await fetch(`https://toncenter.com/api/v2/getAddressBalance?address=${address}`)
    if (!res.ok) return 0
    const data = await res.json()
    if (!data.ok) return 0
    return Number(BigInt(data.result)) / 1e9
  } catch { return 0 }
}

async function fetchTronBalance(address) {
  try {
    const res = await fetch(`https://api.trongrid.io/v1/accounts/${address}`)
    if (!res.ok) return { usdt: 0, trx: 0 }
    const data = await res.json()
    const acc = data.data?.[0]
    if (!acc) return { usdt: 0, trx: 0 }
    const trx = (acc.balance || 0) / 1e6
    let usdt = 0
    for (const token of acc.trc20 || []) {
      if (token[USDT_CONTRACT]) usdt = Number(token[USDT_CONTRACT]) / 1e6
    }
    return { usdt, trx }
  } catch { return { usdt: 0, trx: 0 } }
}

async function fetchBtcBalance(address) {
  try {
    const res = await fetch(`https://blockstream.info/api/address/${address}`)
    if (!res.ok) return 0
    const data = await res.json()
    const s = data.chain_stats || {}
    return ((s.funded_txo_sum || 0) - (s.spent_txo_sum || 0)) / 1e8
  } catch { return 0 }
}

async function fetchEthBalance(address) {
  try {
    const res = await fetch('https://eth.llamarpc.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_getBalance',
        params: [address, 'latest'],
      }),
    })
    if (!res.ok) return 0
    const data = await res.json()
    return Number(BigInt(data.result || '0')) / 1e18
  } catch { return 0 }
}

async function fetchPrices() {
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=the-open-network,tether,bitcoin,ethereum&vs_currencies=usd'
    )
    if (!res.ok) return { ton: 3, usdt: 1, btc: 65000, eth: 3000 }
    const d = await res.json()
    return {
      ton: d['the-open-network']?.usd ?? 3,
      usdt: d['tether']?.usd ?? 1,
      btc: d['bitcoin']?.usd ?? 65000,
      eth: d['ethereum']?.usd ?? 3000,
    }
  } catch { return { ton: 3, usdt: 1, btc: 65000, eth: 3000 } }
}

// ── Helpers ──

function truncAddr(addr) {
  if (!addr || addr.length < 16) return addr || '—'
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`
}

function copyText(text) {
  navigator.clipboard.writeText(text).catch(() => {})
}

function fmtBalance(val, chain) {
  if (chain === 'btc') return val.toFixed(8)
  if (chain === 'eth') return val.toFixed(6)
  return val.toFixed(2)
}

// ── Component ──

export default function Admin() {
  const navigate = useNavigate()
  const user = useGameStore(s => s.user)

  const [wallets, setWallets] = useState(null)
  const [prices, setPrices] = useState(null)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(null)
  const [lastRefresh, setLastRefresh] = useState(null)

  // ── Access check ──
  const isAdmin = user && (
    ADMIN_IDS.includes(user.id) ||
    ADMIN_IDS.includes(user.telegram_id) ||
    ADMIN_IDS.includes(Number(user.telegram_id))
  )

  const fetchAll = useCallback(async () => {
    setLoading(true)
    try {
      const [tonBal, tronBal, btcBal, ethBal, priceData] = await Promise.all([
        fetchTonBalance(WALLETS[0].address),
        fetchTronBalance(WALLETS[1].address),
        fetchBtcBalance(WALLETS[2].address),
        fetchEthBalance(WALLETS[3].address),
        fetchPrices(),
      ])

      setPrices(priceData)

      const priceMap = { ton: priceData.ton, tron: priceData.usdt, btc: priceData.btc, eth: priceData.eth }
      const balances = {
        ton: tonBal,
        tron: tronBal.usdt,
        btc: btcBal,
        eth: ethBal,
      }

      setWallets(WALLETS.map(w => ({
        ...w,
        balance: balances[w.chain],
        balanceUsd: Math.round(balances[w.chain] * priceMap[w.chain] * 100) / 100,
        ...(w.chain === 'tron' ? { trxGas: tronBal.trx } : {}),
      })))

      setLastRefresh(new Date())
    } catch (err) {
      console.error('Admin fetch error:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (isAdmin) fetchAll()
  }, [isAdmin, fetchAll])

  // Auto-refresh every 30s
  useEffect(() => {
    if (!isAdmin) return
    const iv = setInterval(fetchAll, 30_000)
    return () => clearInterval(iv)
  }, [isAdmin, fetchAll])

  function handleCopy(chain, address) {
    copyText(address)
    setCopied(chain)
    setTimeout(() => setCopied(null), 2000)
  }

  // ── Not admin → redirect ──
  if (!isAdmin) {
    return (
      <div className="admin-page">
        <div className="admin-denied">
          <span className="admin-denied-icon">🚫</span>
          <p>Нет доступа</p>
          <button className="admin-btn" onClick={() => navigate('/')}>На главную</button>
        </div>
      </div>
    )
  }

  const totalUsd = wallets?.reduce((s, w) => s + w.balanceUsd, 0) ?? 0

  return (
    <div className="admin-page">
      {/* Header */}
      <div className="admin-header">
        <button className="admin-back" onClick={() => navigate('/')}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18L9 12L15 6" />
          </svg>
        </button>
        <h2>Wallet Monitor</h2>
        <button className="admin-btn-icon" onClick={fetchAll} disabled={loading}>
          {loading ? '⏳' : '🔄'}
        </button>
      </div>

      {lastRefresh && (
        <div className="admin-refresh-time">
          Обновлено: {lastRefresh.toLocaleTimeString()}
        </div>
      )}

      {/* Total USD */}
      {wallets && (
        <div className="admin-total-card">
          <span className="admin-total-label">Общий баланс</span>
          <span className="admin-total-value">${totalUsd.toFixed(2)}</span>
        </div>
      )}

      {/* Wallet cards */}
      {wallets?.map((w) => (
        <div
          key={w.chain}
          className="admin-wallet-card"
          style={{ borderLeftColor: w.color }}
        >
          <div className="admin-wallet-header">
            <span className="admin-wallet-dot" style={{ background: w.color }} />
            <span className="admin-wallet-name">{w.name}</span>
          </div>

          <div className="admin-wallet-address-row">
            <code className="admin-wallet-address">
              {truncAddr(w.address)}
            </code>
            <button
              className="admin-btn-copy"
              onClick={() => handleCopy(w.chain, w.address)}
            >
              {copied === w.chain ? '✓' : '📋'}
            </button>
          </div>

          <div className="admin-wallet-balances">
            <span className="admin-wallet-balance">
              {fmtBalance(w.balance, w.chain)} {w.symbol}
            </span>
            <span className="admin-wallet-usd">
              ≈ ${w.balanceUsd.toFixed(2)}
            </span>
          </div>

          {w.trxGas !== undefined && (
            <div className="admin-wallet-extra">
              TRX (gas): {w.trxGas.toFixed(2)} TRX
            </div>
          )}
        </div>
      ))}

      {/* Prices */}
      {prices && (
        <div className="admin-prices">
          <span className="admin-prices-label">Курсы:</span>
          <span>TON ${prices.ton?.toFixed(2)}</span>
          <span>BTC ${prices.btc?.toLocaleString()}</span>
          <span>ETH ${prices.eth?.toFixed(0)}</span>
        </div>
      )}
    </div>
  )
}
