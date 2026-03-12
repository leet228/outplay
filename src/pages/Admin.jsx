import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import useGameStore from '../store/useGameStore'
import { haptic } from '../lib/telegram'
import { TON_ADDRESS } from '../lib/addresses'
import './Admin.css'

// ── Admin Telegram IDs ──
const ADMIN_IDS = ['dev', 945676433]

// ── Chain icon ──
function TonIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <path d="M12 2L2 8.5L12 22L22 8.5L12 2Z" fill="currentColor" opacity="0.9"/>
      <path d="M12 2L2 8.5H22L12 2Z" fill="currentColor"/>
    </svg>
  )
}

// ── Blockchain API fetchers ──

async function fetchTonBalance(addr) {
  try {
    const r = await fetch(`https://toncenter.com/api/v2/getAddressBalance?address=${addr}`)
    if (!r.ok) return 0
    const d = await r.json()
    return d.ok ? Number(BigInt(d.result)) / 1e9 : 0
  } catch { return 0 }
}

// CoinGecko — TON price in USD + RUB
let _priceCache = null
async function fetchPrices() {
  try {
    const r = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd,rub'
    )
    if (!r.ok) throw new Error()
    const d = await r.json()
    _priceCache = {
      ton: { usd: d['the-open-network']?.usd ?? 3, rub: d['the-open-network']?.rub ?? 270 },
    }
    return _priceCache
  } catch {
    if (_priceCache) return _priceCache
    return { ton: { usd: 3, rub: 270 } }
  }
}

// ── Helpers ──
function truncAddr(a) { return !a || a.length < 16 ? a || '—' : `${a.slice(0, 8)}…${a.slice(-6)}` }
function copyText(t) { navigator.clipboard.writeText(t).catch(() => {}) }

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

  const [tonBalance, setTonBalance] = useState(null)
  const [prices, setPrices] = useState(null)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)
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
      const [bal, priceData] = await Promise.all([
        fetchTonBalance(TON_ADDRESS),
        fetchPrices(),
      ])
      setPrices(priceData)
      setTonBalance(bal)
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

  function handleCopy() {
    haptic('light')
    copyText(TON_ADDRESS)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
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

  const fiatVal = tonBalance != null && prices ? tonBalance * prices.ton[fiatCur] : 0

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
      {tonBalance != null && (
        <div className="admin-total-card">
          <span className="admin-total-label">Баланс TON</span>
          <span className="admin-total-value">{fmtFiat(fiatVal, fiatCur)}</span>
          {tonBalance === 0 && (
            <span className="admin-total-empty">Кошелёк пуст</span>
          )}
        </div>
      )}

      {/* Skeleton while loading */}
      {tonBalance == null && loading && (
        <div className="admin-skeleton-list">
          <div className="admin-skeleton-card" />
        </div>
      )}

      {/* Wallet card */}
      {tonBalance != null && (
        <div className="admin-wallet-list">
          <div className="admin-wallet-card">
            <div className="admin-wallet-accent" style={{ background: 'linear-gradient(135deg, #0098EA 0%, #00D1FF 100%)' }} />

            <div className="admin-wallet-top">
              <div className="admin-wallet-icon-wrap" style={{ background: 'linear-gradient(135deg, #0098EA 0%, #00D1FF 100%)' }}>
                <TonIcon />
              </div>
              <div className="admin-wallet-title">
                <span className="admin-wallet-name">TON</span>
                <span className="admin-wallet-fiat">{fmtFiat(fiatVal, fiatCur)}</span>
              </div>
            </div>

            <div className="admin-wallet-balance-row">
              <span className="admin-wallet-balance">{tonBalance.toFixed(4)}</span>
              <span className="admin-wallet-symbol">TON</span>
            </div>

            <div className="admin-wallet-addr-row">
              <code className="admin-wallet-addr">{truncAddr(TON_ADDRESS)}</code>
              <button className="admin-copy-btn" onClick={handleCopy}>
                {copied ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Price bar */}
      {prices && (
        <div className="admin-prices-bar">
          <div className="admin-price-chip">
            <span className="admin-price-dot" style={{ background: '#0098EA' }} />
            <span>TON</span>
            <span className="admin-price-val">{fmtFiat(prices.ton[fiatCur], fiatCur)}</span>
          </div>
        </div>
      )}
    </div>
  )
}
