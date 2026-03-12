import { useState, useEffect, useCallback } from 'react'
import { haptic } from '../lib/telegram'
import { TON_ADDRESS } from '../lib/addresses'

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
function truncAddr(a) { return !a || a.length < 16 ? a || '—' : `${a.slice(0, 8)}...${a.slice(-6)}` }
function copyText(t) { navigator.clipboard.writeText(t).catch(() => {}) }

function fmtFiat(v, cur) {
  if (cur === 'rub') {
    const rounded = Math.round(v)
    return rounded.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '\u00A0') + ' \u20BD'
  }
  return '$' + v.toFixed(2)
}

export default function AdminWallet() {
  const [tonBalance, setTonBalance] = useState(null)
  const [prices, setPrices] = useState(null)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [lastRefresh, setLastRefresh] = useState(null)
  const [fiatCur, setFiatCur] = useState(localStorage.getItem('admin_fiat') || 'usd')

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
      console.error('AdminWallet fetch error:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchAll() }, [fetchAll])
  useEffect(() => {
    const iv = setInterval(fetchAll, 30_000)
    return () => clearInterval(iv)
  }, [fetchAll])

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

  const fiatVal = tonBalance != null && prices ? tonBalance * prices.ton[fiatCur] : 0

  return (
    <div className="admin-wallet">
      {/* Top controls */}
      <div className="admin-wallet-controls">
        <button className="admin-fiat-toggle" onClick={toggleFiat}>
          {fiatCur === 'usd' ? '$ USD' : '\u20BD RUB'}
        </button>
        <button
          className={`admin-btn-refresh ${loading ? 'spinning' : ''}`}
          onClick={() => { haptic('medium'); fetchAll() }}
          disabled={loading}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 4v6h6M23 20v-6h-6"/>
            <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10M23 14l-4.64 4.36A9 9 0 0 1 3.51 15"/>
          </svg>
        </button>
      </div>

      {lastRefresh && (
        <div className="admin-refresh-time">
          {'Updated '}
          {lastRefresh.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          {' \u00B7 CoinGecko'}
        </div>
      )}

      {/* Total balance card */}
      {tonBalance != null && (
        <div className="admin-total-card">
          <span className="admin-total-label">TON Balance</span>
          <span className="admin-total-value">{fmtFiat(fiatVal, fiatCur)}</span>
          {tonBalance === 0 && (
            <span className="admin-total-empty">Wallet is empty</span>
          )}
        </div>
      )}

      {/* Skeleton while loading */}
      {tonBalance == null && loading && (
        <div className="admin-skeleton-list">
          <div className="admin-skeleton-card" />
        </div>
      )}

      {/* Wallet detail card */}
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

      {/* Price chip */}
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
