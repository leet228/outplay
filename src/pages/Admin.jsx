import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import useGameStore from '../store/useGameStore'
import { haptic } from '../lib/telegram'
import './Admin.css'

// ── Admin Telegram IDs ──
const ADMIN_IDS = ['dev', 945676433]

// ── Wallet config ──
const WALLETS = [
  { chain: 'ton',  name: 'TON',           symbol: 'TON',  color: '#0098EA', gradient: 'linear-gradient(135deg, #0098EA 0%, #00D1FF 100%)' },
  { chain: 'tron', name: 'USDT TRC-20',   symbol: 'USDT', color: '#26A17B', gradient: 'linear-gradient(135deg, #26A17B 0%, #6DD5A0 100%)' },
  { chain: 'btc',  name: 'Bitcoin',        symbol: 'BTC',  color: '#F7931A', gradient: 'linear-gradient(135deg, #F7931A 0%, #FFB84D 100%)' },
  { chain: 'eth',  name: 'Ethereum',       symbol: 'ETH',  color: '#627EEA', gradient: 'linear-gradient(135deg, #627EEA 0%, #9FB0F5 100%)' },
]

const ADDRESSES = {
  ton:  'UQBMTQ2VRSwRbvthtGTIB7Tip37yqueFw8SnVvWB7y18F47t',
  tron: 'TVx8PrnGgqHc7hyE4fZicofS673AzqwjGA',
  btc:  'bc1qu75zk4x2sl3k8s0hhq2pt9793m8lpxyryrvyvv',
  eth:  '0xE20B131dadaf7f9e393b555d14e13aa2CD6034Db',
}

// ── Chain icons (SVG) ──
function TonIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <path d="M12 2L2 8.5L12 22L22 8.5L12 2Z" fill="currentColor" opacity="0.9"/>
      <path d="M12 2L2 8.5H22L12 2Z" fill="currentColor"/>
    </svg>
  )
}
function UsdtIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.8"/>
      <path d="M12 6V18M8 9H16M9.5 12C9.5 12 10 13 12 13C14 13 14.5 12 14.5 12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
    </svg>
  )
}
function BtcIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.8"/>
      <path d="M9 7V17M9 7H13.5C15.43 7 17 8.12 17 9.5C17 10.88 15.43 12 13.5 12H9M9 12H14C15.93 12 17.5 13.12 17.5 14.5C17.5 15.88 15.93 17 14 17H9M11 5V7M11 17V19M13 5V7M13 17V19" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  )
}
function EthIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <path d="M12 2L5 12L12 16L19 12L12 2Z" fill="currentColor" opacity="0.6"/>
      <path d="M12 2L5 12L12 9.5L19 12L12 2Z" fill="currentColor"/>
      <path d="M5 13.5L12 22L19 13.5L12 17.5L5 13.5Z" fill="currentColor" opacity="0.8"/>
    </svg>
  )
}
const CHAIN_ICONS = { ton: TonIcon, tron: UsdtIcon, btc: BtcIcon, eth: EthIcon }

// ── Blockchain API fetchers ──
const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'

async function fetchTonBalance(addr) {
  try {
    const r = await fetch(`https://toncenter.com/api/v2/getAddressBalance?address=${addr}`)
    if (!r.ok) return 0
    const d = await r.json()
    return d.ok ? Number(BigInt(d.result)) / 1e9 : 0
  } catch { return 0 }
}

async function fetchTronBalance(addr) {
  try {
    const r = await fetch(`https://api.trongrid.io/v1/accounts/${addr}`)
    if (!r.ok) return { usdt: 0, trx: 0 }
    const acc = (await r.json()).data?.[0]
    if (!acc) return { usdt: 0, trx: 0 }
    let usdt = 0
    for (const t of acc.trc20 || []) { if (t[USDT_CONTRACT]) usdt = Number(t[USDT_CONTRACT]) / 1e6 }
    return { usdt, trx: (acc.balance || 0) / 1e6 }
  } catch { return { usdt: 0, trx: 0 } }
}

async function fetchBtcBalance(addr) {
  try {
    const r = await fetch(`https://blockstream.info/api/address/${addr}`)
    if (!r.ok) return 0
    const s = (await r.json()).chain_stats || {}
    return ((s.funded_txo_sum || 0) - (s.spent_txo_sum || 0)) / 1e8
  } catch { return 0 }
}

async function fetchEthBalance(addr) {
  try {
    const r = await fetch('https://cloudflare-eth.com', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [addr, 'latest'] }),
    })
    if (!r.ok) return 0
    return Number(BigInt((await r.json()).result || '0')) / 1e18
  } catch { return 0 }
}

// CoinGecko — real prices in USD + RUB
async function fetchPrices() {
  try {
    const r = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=the-open-network,tether,bitcoin,ethereum&vs_currencies=usd,rub'
    )
    if (!r.ok) throw new Error()
    const d = await r.json()
    return {
      ton:  { usd: d['the-open-network']?.usd ?? 3,     rub: d['the-open-network']?.rub ?? 270 },
      usdt: { usd: d['tether']?.usd ?? 1,               rub: d['tether']?.rub ?? 90 },
      btc:  { usd: d['bitcoin']?.usd ?? 65000,           rub: d['bitcoin']?.rub ?? 5850000 },
      eth:  { usd: d['ethereum']?.usd ?? 3000,            rub: d['ethereum']?.rub ?? 270000 },
    }
  } catch {
    return {
      ton:  { usd: 3, rub: 270 },
      usdt: { usd: 1, rub: 90 },
      btc:  { usd: 65000, rub: 5850000 },
      eth:  { usd: 3000, rub: 270000 },
    }
  }
}

// ── Helpers ──
function truncAddr(a) { return !a || a.length < 16 ? a || '—' : `${a.slice(0, 8)}…${a.slice(-6)}` }
function copyText(t) { navigator.clipboard.writeText(t).catch(() => {}) }

function fmtBal(v, chain) {
  if (chain === 'btc') return v.toFixed(8)
  if (chain === 'eth') return v.toFixed(6)
  return v.toFixed(2)
}

function fmtFiat(v, cur) {
  if (cur === 'rub') {
    const rounded = Math.round(v)
    return rounded.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '\u00A0') + ' ₽'
  }
  return '$' + v.toFixed(2)
}

// ── Component ──
export default function Admin() {
  const navigate = useNavigate()
  const user = useGameStore(s => s.user)

  const [walletData, setWalletData] = useState(null)
  const [prices, setPrices] = useState(null)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(null)
  const [lastRefresh, setLastRefresh] = useState(null)
  const [fiatCur, setFiatCur] = useState(localStorage.getItem('admin_fiat') || 'usd')

  const isAdmin = user && (
    ADMIN_IDS.includes(user.id) ||
    ADMIN_IDS.includes(user.telegram_id) ||
    ADMIN_IDS.includes(Number(user.telegram_id))
  )

  const fetchAll = useCallback(async () => {
    setLoading(true)
    try {
      const [tonBal, tronBal, btcBal, ethBal, priceData] = await Promise.all([
        fetchTonBalance(ADDRESSES.ton),
        fetchTronBalance(ADDRESSES.tron),
        fetchBtcBalance(ADDRESSES.btc),
        fetchEthBalance(ADDRESSES.eth),
        fetchPrices(),
      ])
      setPrices(priceData)
      setWalletData({ ton: tonBal, tron: tronBal, btc: btcBal, eth: ethBal })
      setLastRefresh(new Date())
    } catch (err) {
      console.error('Admin fetch error:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { if (isAdmin) fetchAll() }, [isAdmin, fetchAll])
  useEffect(() => {
    if (!isAdmin) return
    const iv = setInterval(fetchAll, 30_000)
    return () => clearInterval(iv)
  }, [isAdmin, fetchAll])

  function handleCopy(chain, address) {
    haptic('light')
    copyText(address)
    setCopied(chain)
    setTimeout(() => setCopied(null), 2000)
  }

  function toggleFiat() {
    const next = fiatCur === 'usd' ? 'rub' : 'usd'
    setFiatCur(next)
    localStorage.setItem('admin_fiat', next)
    haptic('light')
  }

  // ── Not admin ──
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

  // Build wallet list with fiat values
  const wallets = walletData && prices ? WALLETS.map(w => {
    const bal = w.chain === 'tron' ? walletData.tron.usdt : walletData[w.chain]
    const priceKey = w.chain === 'tron' ? 'usdt' : w.chain
    const fiatVal = bal * prices[priceKey][fiatCur]
    return {
      ...w,
      address: ADDRESSES[w.chain],
      balance: bal,
      fiatVal,
      trxGas: w.chain === 'tron' ? walletData.tron.trx : null,
    }
  }) : null

  const totalFiat = wallets?.reduce((s, w) => s + w.fiatVal, 0) ?? 0

  return (
    <div className="admin-page">
      {/* Header */}
      <div className="admin-header">
        <button className="admin-back" onClick={() => { haptic('light'); navigate('/') }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18L9 12L15 6" />
          </svg>
        </button>
        <h2>Wallet Monitor</h2>
        <div className="admin-header-actions">
          <button className="admin-fiat-toggle" onClick={toggleFiat}>
            {fiatCur === 'usd' ? '$ USD' : '₽ RUB'}
          </button>
          <button className={`admin-btn-refresh ${loading ? 'spinning' : ''}`} onClick={() => { haptic('medium'); fetchAll() }} disabled={loading}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1 4v6h6M23 20v-6h-6"/>
              <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10M23 14l-4.64 4.36A9 9 0 0 1 3.51 15"/>
            </svg>
          </button>
        </div>
      </div>

      {lastRefresh && (
        <div className="admin-refresh-time">
          Обновлено {lastRefresh.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          {' · '}CoinGecko
        </div>
      )}

      {/* Total balance */}
      {wallets && (
        <div className="admin-total-card">
          <span className="admin-total-label">Общий баланс</span>
          <span className="admin-total-value">{fmtFiat(totalFiat, fiatCur)}</span>
          {wallets.every(w => w.balance === 0) && (
            <span className="admin-total-empty">Кошельки пусты</span>
          )}
        </div>
      )}

      {/* Skeleton while loading */}
      {!wallets && loading && (
        <div className="admin-skeleton-list">
          {[1,2,3,4].map(i => <div key={i} className="admin-skeleton-card" />)}
        </div>
      )}

      {/* Wallet cards */}
      <div className="admin-wallet-list">
        {wallets?.map((w) => {
          const Icon = CHAIN_ICONS[w.chain]
          return (
            <div key={w.chain} className="admin-wallet-card">
              <div className="admin-wallet-accent" style={{ background: w.gradient }} />

              <div className="admin-wallet-top">
                <div className="admin-wallet-icon-wrap" style={{ background: w.gradient }}>
                  <Icon />
                </div>
                <div className="admin-wallet-title">
                  <span className="admin-wallet-name">{w.name}</span>
                  <span className="admin-wallet-fiat">{fmtFiat(w.fiatVal, fiatCur)}</span>
                </div>
              </div>

              <div className="admin-wallet-balance-row">
                <span className="admin-wallet-balance">{fmtBal(w.balance, w.chain)}</span>
                <span className="admin-wallet-symbol">{w.symbol}</span>
              </div>

              {w.trxGas !== null && (
                <div className="admin-wallet-gas">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                  Gas: {w.trxGas.toFixed(2)} TRX
                </div>
              )}

              <div className="admin-wallet-addr-row">
                <code className="admin-wallet-addr">{truncAddr(w.address)}</code>
                <button className="admin-copy-btn" onClick={() => handleCopy(w.chain, w.address)}>
                  {copied === w.chain ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                  )}
                </button>
              </div>
            </div>
          )
        })}
      </div>

      {/* Prices bar */}
      {prices && (
        <div className="admin-prices-bar">
          {WALLETS.map(w => {
            const pk = w.chain === 'tron' ? 'usdt' : w.chain
            return (
              <div key={w.chain} className="admin-price-chip">
                <span className="admin-price-dot" style={{ background: w.color }} />
                <span>{w.symbol}</span>
                <span className="admin-price-val">{fmtFiat(prices[pk][fiatCur], fiatCur)}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
