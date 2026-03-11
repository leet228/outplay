import { useEffect, useState, useRef } from 'react'
import useGameStore from '../store/useGameStore'
import { haptic, requestStarsPayment, getTelegramUser } from '../lib/telegram'
import { createStarsInvoice, processDeposit, getUserBalance } from '../lib/supabase'
import { translations } from '../lib/i18n'
import './DepositSheet.css'

const STAR_USD = 0.013
const RATES = { RUB: 77, USD: 1, EUR: 0.93 }

const PRESETS = [100, 500, 1000]
const MIN_STARS = 1 // для тестирования (потом поднять)

const COINS = [
  { id: 'ton',  name: 'TON',         sub: 'TON Network',  color: '#0098EA' },
  { id: 'usdt', name: 'USDT',        sub: 'TRC-20',       color: '#26A17B' },
  { id: 'btc',  name: 'Bitcoin',     sub: 'BTC',          color: '#F7931A' },
  { id: 'eth',  name: 'Ethereum',    sub: 'ERC-20',       color: '#627EEA' },
]

function CoinIcon({ id, color }) {
  if (id === 'ton') return (
    <svg width="22" height="22" viewBox="0 0 56 56" fill="none">
      <path d="M28 4L52 16V40L28 52L4 40V16L28 4Z" fill={color} opacity="0.15"/>
      <path d="M20 20H36L28 38L20 20Z" fill={color}/>
      <path d="M20 20L28 38" stroke={color} strokeWidth="2.5" strokeLinecap="round"/>
      <path d="M36 20L28 38" stroke={color} strokeWidth="2.5" strokeLinecap="round"/>
      <line x1="19" y1="20" x2="37" y2="20" stroke={color} strokeWidth="2.5" strokeLinecap="round"/>
    </svg>
  )
  if (id === 'usdt') return (
    <svg width="22" height="22" viewBox="0 0 32 32" fill="none">
      <circle cx="16" cy="16" r="16" fill={color} fillOpacity="0.15"/>
      <text x="16" y="21" textAnchor="middle" fontSize="16" fontWeight="800" fill={color}>₮</text>
    </svg>
  )
  if (id === 'btc') return (
    <svg width="22" height="22" viewBox="0 0 32 32" fill="none">
      <circle cx="16" cy="16" r="16" fill={color} fillOpacity="0.15"/>
      <text x="16" y="21" textAnchor="middle" fontSize="14" fontWeight="800" fill={color}>₿</text>
    </svg>
  )
  if (id === 'eth') return (
    <svg width="22" height="22" viewBox="0 0 32 32" fill="none">
      <circle cx="16" cy="16" r="16" fill={color} fillOpacity="0.15"/>
      <path d="M16 6L10 16.5L16 20L22 16.5L16 6Z" fill={color}/>
      <path d="M10 18L16 26L22 18L16 21.5L10 18Z" fill={color} opacity="0.6"/>
    </svg>
  )
}

function toCurrency(stars, currency) {
  const usd = stars * STAR_USD
  const amount = usd * (RATES[currency.code] ?? 1)
  if (currency.code === 'RUB') return `≈ ${Math.round(amount)} ${currency.symbol}`
  return `≈ ${currency.symbol}${amount.toFixed(2)}`
}

function BackButton({ label, onClick }) {
  return (
    <button className="deposit-back" onClick={onClick}>
      <div className="deposit-back-icon">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round">
          <path d="M15 18l-6-6 6-6" />
        </svg>
      </div>
      {label}
    </button>
  )
}

function SuccessCheckmark() {
  return (
    <div className="deposit-success-circle">
      <svg className="deposit-success-check" width="48" height="48" viewBox="0 0 48 48" fill="none">
        <path d="M12 25L20 33L36 15" stroke="#22c55e" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  )
}

export default function DepositSheet() {
  const { depositOpen, setDepositOpen, lang, currency, user, setBalance, setBalanceBounce } = useGameStore()
  const t = translations[lang]

  const [view, setView] = useState('main') // 'main' | 'stars' | 'crypto'
  const [selected, setSelected] = useState(100)
  const [custom, setCustom] = useState('')
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState('idle') // 'idle' | 'success' | 'error'
  const successAmountRef = useRef(0)

  const activeAmount = custom !== '' ? Number(custom) : selected
  const isCustomValid = custom === '' || Number(custom) >= MIN_STARS
  const canBuy = activeAmount >= MIN_STARS && isCustomValid && !loading

  const close = () => {
    haptic('light')
    setDepositOpen(false)
  }

  const goBack = () => {
    haptic('light')
    if (status !== 'idle') {
      setStatus('idle')
      setView('stars')
    } else {
      setView('main')
    }
  }

  // Reset on close
  useEffect(() => {
    if (!depositOpen) {
      setTimeout(() => {
        setView('main')
        setCustom('')
        setSelected(100)
        setLoading(false)
        setStatus('idle')
      }, 300)
    }
  }, [depositOpen])

  // Telegram BackButton
  useEffect(() => {
    const tg = window.Telegram?.WebApp
    if (!tg) return
    if (depositOpen) {
      tg.BackButton.show()
      const handler = () => {
        if (view !== 'main') goBack()
        else close()
      }
      tg.BackButton.onClick(handler)
      return () => { tg.BackButton.offClick(handler) }
    } else {
      tg.BackButton.hide()
    }
  }, [depositOpen, view])

  // Auto-close after success
  useEffect(() => {
    if (status === 'success') {
      const timer = setTimeout(() => {
        setDepositOpen(false)
        // Trigger balance bounce after sheet closes
        setTimeout(() => {
          setBalanceBounce(true)
          setTimeout(() => setBalanceBounce(false), 700)
        }, 350)
      }, 1500)
      return () => clearTimeout(timer)
    }
  }, [status])

  function handlePreset(amount) {
    haptic('light')
    setSelected(amount)
    setCustom('')
  }

  function handleCustomChange(e) {
    const val = e.target.value.replace(/\D/g, '')
    setCustom(val)
    if (val !== '') setSelected(null)
  }

  async function handleBuy() {
    if (!canBuy) return
    haptic('medium')
    setLoading(true)
    successAmountRef.current = activeAmount

    const userId = user?.id

    // ── Dev mode: simulate success (no real Telegram user) ──
    const isRealTelegram = !!getTelegramUser()
    if (!isRealTelegram) {
      await new Promise(r => setTimeout(r, 500))
      const newBalance = useGameStore.getState().balance + activeAmount
      setBalance(newBalance)
      setLoading(false)
      setStatus('success')
      haptic('heavy')
      return
    }

    // ── Real Telegram: create invoice → open → process ──
    try {
      // 1. Create invoice
      const invoice = await createStarsInvoice(userId, activeAmount)
      if (!invoice?.url) {
        setLoading(false)
        setStatus('error')
        haptic('heavy')
        return
      }

      // 2. Open Telegram invoice
      requestStarsPayment({
        payload: invoice.url,
        onSuccess: async () => {
          // Webhook already credited balance via process_deposit.
          // Just fetch fresh balance from DB to sync UI.
          try {
            const freshBalance = await getUserBalance(userId)
            setBalance(freshBalance)
          } catch {
            // Fallback: add locally
            const s = useGameStore.getState()
            setBalance(s.balance + activeAmount)
          }
          setLoading(false)
          setStatus('success')
          haptic('heavy')
        },
        onFail: (failStatus) => {
          console.log('Payment cancelled/failed:', failStatus)
          setLoading(false)
          if (failStatus === 'cancelled') {
            // User cancelled — just go back
          } else {
            setStatus('error')
          }
          haptic('medium')
        },
      })
    } catch (err) {
      console.error('Payment error:', err)
      setLoading(false)
      setStatus('error')
      haptic('heavy')
    }
  }

  function handleCoinSelect(coin) {
    haptic('medium')
    // TODO: показать адрес кошелька для coin.id
  }

  return (
    <>
      <div className={`deposit-overlay ${depositOpen ? 'visible' : ''}`} onClick={close} />

      <div className={`deposit-sheet ${depositOpen ? 'open' : ''}`}>
        <div className="deposit-handle" />

        {/* Header — hidden during success */}
        {status !== 'success' && (
          <div className="deposit-header">
            {view !== 'main'
              ? <BackButton label={t.depositBack} onClick={goBack} />
              : <span className="deposit-title">{t.depositTitle}</span>
            }
            <button className="deposit-close" onClick={close}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}

        {/* ── Success View ── */}
        {status === 'success' && (
          <div className="deposit-success">
            <SuccessCheckmark />
            <span className="deposit-success-title">{t.depositSuccess}</span>
            <span className="deposit-success-amount">+{successAmountRef.current} ⭐</span>
          </div>
        )}

        {/* ── Error View ── */}
        {status === 'error' && (
          <div className="deposit-error">
            <div className="deposit-error-icon">✕</div>
            <span className="deposit-error-title">{t.depositError}</span>
            <button className="deposit-buy-btn" onClick={() => setStatus('idle')}>
              {t.depositBack}
            </button>
          </div>
        )}

        {/* ── Main ── */}
        {status === 'idle' && view === 'main' && (
          <div className="deposit-options">
            <button className="deposit-option deposit-option--stars" onClick={() => { haptic('medium'); setView('stars') }}>
              <div className="deposit-option-icon">⭐</div>
              <div className="deposit-option-info">
                <span className="deposit-option-title">{t.depositStars}</span>
                <span className="deposit-option-sub">{t.depositStarsSub}</span>
              </div>
              <svg className="deposit-option-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M9 18l6-6-6-6" />
              </svg>
            </button>

            <button className="deposit-option deposit-option--crypto" onClick={() => { haptic('medium'); setView('crypto') }}>
              <div className="deposit-option-icon">₿</div>
              <div className="deposit-option-info">
                <span className="deposit-option-title">{t.depositCrypto}</span>
                <span className="deposit-option-sub">{t.depositCryptoSub}</span>
              </div>
              <svg className="deposit-option-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M9 18l6-6-6-6" />
              </svg>
            </button>
          </div>
        )}

        {/* ── Stars ── */}
        {status === 'idle' && view === 'stars' && (
          <div className="deposit-stars-view">
            <p className="deposit-stars-subtitle">{t.depositStarsTitle}</p>

            <div className="deposit-presets">
              {PRESETS.map(amount => (
                <button
                  key={amount}
                  className={`deposit-preset ${selected === amount && custom === '' ? 'active' : ''}`}
                  onClick={() => handlePreset(amount)}
                >
                  <span className="deposit-preset-stars">⭐ {amount}</span>
                  <span className="deposit-preset-rub">{toCurrency(amount, currency)}</span>
                </button>
              ))}
            </div>

            <div className="deposit-custom-wrap">
              <span className="deposit-custom-label">{t.depositCustom}</span>
              <div className={`deposit-custom-input-wrap ${custom !== '' && !isCustomValid ? 'error' : ''} ${custom !== '' && isCustomValid ? 'filled' : ''}`}>
                <span className="deposit-custom-star">⭐</span>
                <input
                  className="deposit-custom-input"
                  type="number"
                  inputMode="numeric"
                  placeholder={t.depositCustomPlaceholder}
                  value={custom}
                  min={MIN_STARS}
                  onChange={handleCustomChange}
                />
                {custom !== '' && isCustomValid && (
                  <span className="deposit-custom-rub">{toCurrency(Number(custom), currency)}</span>
                )}
              </div>
            </div>

            <button className={`deposit-buy-btn ${loading ? 'loading' : ''}`} disabled={!canBuy} onClick={handleBuy}>
              {loading ? (
                <div className="deposit-btn-spinner" />
              ) : (
                <>{t.depositBuy} {activeAmount >= MIN_STARS ? activeAmount : '—'} ⭐</>
              )}
            </button>
          </div>
        )}

        {/* ── Crypto ── */}
        {status === 'idle' && view === 'crypto' && (
          <div className="deposit-crypto-view">
            <p className="deposit-stars-subtitle">{t.depositCryptoTitle}</p>

            <div className="deposit-coins">
              {COINS.map(coin => (
                <button key={coin.id} className="deposit-coin" onClick={() => handleCoinSelect(coin)}>
                  <div className="deposit-coin-icon" style={{ background: `${coin.color}18`, border: `1.5px solid ${coin.color}30` }}>
                    <CoinIcon id={coin.id} color={coin.color} />
                  </div>
                  <div className="deposit-coin-info">
                    <span className="deposit-coin-name">{coin.name}</span>
                    <span className="deposit-coin-sub">{coin.sub}</span>
                  </div>
                  <svg className="deposit-option-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <path d="M9 18l6-6-6-6" />
                  </svg>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  )
}
