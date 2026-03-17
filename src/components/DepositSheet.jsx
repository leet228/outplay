import { useEffect, useState, useRef } from 'react'
import useGameStore from '../store/useGameStore'
import { haptic, requestStarsPayment, getTelegramUser } from '../lib/telegram'
import { createStarsInvoice, processDeposit, getUserBalance } from '../lib/supabase'
import { formatCurrency, convertFromRub } from '../lib/currency'
import { translations } from '../lib/i18n'
import { TON_ADDRESS } from '../lib/addresses'
import './DepositSheet.css'

const PRESETS = [100, 500, 1000]
const MIN_STARS = 100

function TonIcon({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 56 56" fill="none">
      <path d="M28 4L52 16V40L28 52L4 40V16L28 4Z" fill="#0098EA" opacity="0.15"/>
      <path d="M20 20H36L28 38L20 20Z" fill="#0098EA"/>
      <path d="M20 20L28 38" stroke="#0098EA" strokeWidth="2.5" strokeLinecap="round"/>
      <path d="M36 20L28 38" stroke="#0098EA" strokeWidth="2.5" strokeLinecap="round"/>
      <line x1="19" y1="20" x2="37" y2="20" stroke="#0098EA" strokeWidth="2.5" strokeLinecap="round"/>
    </svg>
  )
}

function TgStarIcon({ size = 22 }) {
  const id = `tgs${Math.random().toString(36).slice(2, 6)}`
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" fill="none" style={{ display: 'inline-block', verticalAlign: 'middle', flexShrink: 0 }}>
      <defs>
        <linearGradient id={`${id}-b`} x1="20" y1="10" x2="100" y2="110" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#F5A623"/>
          <stop offset="100%" stopColor="#E8780A"/>
        </linearGradient>
        <linearGradient id={`${id}-f`} x1="30" y1="15" x2="90" y2="105" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFDA44"/>
          <stop offset="50%" stopColor="#FFC933"/>
          <stop offset="100%" stopColor="#F5B731"/>
        </linearGradient>
      </defs>
      {/* Orange border */}
      <path d="M60 5 C62 5 64 6 65 8 L76 34 C77 36 79 38 81 38 L109 42 C113 42 115 47 112 50 L91 70 C89 72 88 74 89 77 L95 104 C96 108 92 111 88 109 L64 96 C62 95 59 95 57 96 L33 109 C29 111 25 108 26 104 L32 77 C32 74 32 72 30 70 L9 50 C6 47 8 42 12 42 L40 38 C42 38 44 36 45 34 L56 8 C57 6 59 5 60 5Z" fill={`url(#${id}-b)`}/>
      {/* Golden body */}
      <path d="M60 14 C61 14 63 15 63.5 16 L73 38 C74 40 76 42 78 42 L103 45 C106 46 107 49 105 51 L87 68 C85 70 85 72 85 74 L90 98 C91 101 88 103 85 102 L63 90 C61 89 59 89 57 90 L36 102 C33 103 30 101 31 98 L36 74 C36 72 36 70 34 68 L16 51 C14 49 15 46 18 45 L43 42 C45 42 47 40 48 38 L57.5 16 C58 15 59.5 14 60 14Z" fill={`url(#${id}-f)`}/>
    </svg>
  )
}

/** Raw numeric currency amount for DB (e.g. 100.10) — 1 Star = 1 RUB */
function toCurrencyRaw(stars, curCode, rates) {
  const amount = convertFromRub(stars, curCode, rates)
  return Math.round(amount * 100) / 100
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

/** Poll balance from DB with retries (webhook may need a moment) */
async function pollBalance(userId, prevBalance, maxRetries = 4) {
  for (let i = 0; i < maxRetries; i++) {
    await new Promise(r => setTimeout(r, 600 + i * 400))
    try {
      const bal = await getUserBalance(userId)
      if (bal > prevBalance) return bal
    } catch { /* retry */ }
  }
  return null // webhook didn't process in time
}

export default function DepositSheet() {
  const { depositOpen, setDepositOpen, lang, currency, rates, user, balance, setBalance, setBalanceBounce, appSettings } = useGameStore()
  const t = translations[lang]
  const starsEnabled = appSettings.stars_deposits !== false
  const cryptoEnabled = appSettings.crypto_deposits !== false

  const [view, setView] = useState('main')
  const [selected, setSelected] = useState(100)
  const [custom, setCustom] = useState('')
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState('idle')
  const [copiedField, setCopiedField] = useState(null) // 'address' | 'memo'
  const successAmountRef = useRef(0)
  const invoiceTxRef = useRef(null) // shared tx_id between webhook & client

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
      setCopiedField(null)
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
        setCopiedField(null)
        invoiceTxRef.current = null
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
    const prevBalance = useGameStore.getState().balance

    // ── Dev mode ──
    if (!getTelegramUser()) {
      await new Promise(r => setTimeout(r, 500))
      setBalance(prevBalance + activeAmount)
      setLoading(false)
      setStatus('success')
      haptic('heavy')
      return
    }

    // ── Real Telegram: create invoice → open → process ──
    try {
      const curAmt = toCurrencyRaw(activeAmount, currency.code, rates)
      const invoice = await createStarsInvoice(userId, activeAmount, curAmt, currency.code)
      if (!invoice?.url || !invoice?.tx_id) {
        setLoading(false)
        setStatus('error')
        haptic('heavy')
        return
      }

      invoiceTxRef.current = invoice.tx_id

      requestStarsPayment({
        payload: invoice.url,
        onSuccess: async () => {
          const polled = await pollBalance(userId, prevBalance)

          if (polled != null) {
            setBalance(polled)
          } else {
            try {
              const curAmt = toCurrencyRaw(activeAmount, currency.code, rates)
              const result = await processDeposit(userId, activeAmount, invoiceTxRef.current, curAmt, currency.code)
              if (result?.new_balance != null) {
                setBalance(result.new_balance)
              } else {
                const fresh = await getUserBalance(userId)
                setBalance(fresh ?? prevBalance)
              }
            } catch {
              try {
                const fresh = await getUserBalance(userId)
                setBalance(fresh ?? prevBalance)
              } catch { /* keep prev balance, Realtime will catch up */ }
            }
          }

          setLoading(false)
          setStatus('success')
          haptic('heavy')
        },
        onFail: (failStatus) => {
          setLoading(false)
          if (failStatus !== 'cancelled') {
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

  function handleCopy(text, field) {
    navigator.clipboard.writeText(text).then(() => {
      haptic('light')
      setCopiedField(field)
      setTimeout(() => setCopiedField(null), 2000)
    })
  }

  const memoTag = user?.telegram_id || user?.id || 'dev'
  const minFormatted = formatCurrency(200, currency, rates, { approximate: true })

  return (
    <>
      <div className={`deposit-overlay ${depositOpen ? 'visible' : ''}`} onClick={close} />

      <div className={`deposit-sheet ${depositOpen ? 'open' : ''}`}>
        <div className="deposit-handle" />

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

        {/* ── Success ── */}
        {status === 'success' && (
          <div className="deposit-success">
            <SuccessCheckmark />
            <span className="deposit-success-title">{t.depositSuccess}</span>
            <span className="deposit-success-amount">
              {formatCurrency(successAmountRef.current, currency, rates, { sign: '+' })}
            </span>
          </div>
        )}

        {/* ── Error ── */}
        {status === 'error' && (
          <div className="deposit-error">
            <div className="deposit-error-icon">✕</div>
            <span className="deposit-error-title">{t.depositError}</span>
            <button className="deposit-buy-btn" onClick={() => setStatus('idle')}>
              {t.depositRetry || t.depositBack}
            </button>
          </div>
        )}

        {/* ── Main ── */}
        {status === 'idle' && view === 'main' && (
          <div className="deposit-options">
            {!starsEnabled && !cryptoEnabled && (
              <div className="deposit-unavailable">
                <span>{lang === 'ru' ? 'Пополнение временно недоступно' : 'Deposits temporarily unavailable'}</span>
              </div>
            )}
            {starsEnabled && (
              <button className="deposit-option deposit-option--stars" onClick={() => { haptic('medium'); setView('stars') }}>
                <div className="deposit-option-icon">
                  <TgStarIcon size={28} />
                </div>
                <div className="deposit-option-info">
                  <span className="deposit-option-title">{t.depositStars}</span>
                  <span className="deposit-option-sub">{t.depositStarsSub}</span>
                </div>
                <svg className="deposit-option-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M9 18l6-6-6-6" />
                </svg>
              </button>
            )}
            {cryptoEnabled && (
              <button className="deposit-option deposit-option--crypto" onClick={() => { haptic('medium'); setView('crypto') }}>
                <div className="deposit-option-icon">
                  <TonIcon size={28} />
                </div>
                <div className="deposit-option-info">
                  <span className="deposit-option-title">{t.depositCrypto}</span>
                  <span className="deposit-option-sub">{t.depositCryptoSub}</span>
                </div>
                <svg className="deposit-option-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <path d="M9 18l6-6-6-6" />
                </svg>
              </button>
            )}
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
                  <span className="deposit-preset-stars"><TgStarIcon size={16} /> {amount}</span>
                  <span className="deposit-preset-rub">{formatCurrency(amount, currency, rates, { approximate: true })}</span>
                </button>
              ))}
            </div>

            <div className="deposit-custom-wrap">
              <span className="deposit-custom-label">{t.depositCustom}</span>
              <div className={`deposit-custom-input-wrap ${custom !== '' && !isCustomValid ? 'error' : ''} ${custom !== '' && isCustomValid ? 'filled' : ''}`}>
                <span className="deposit-custom-star"><TgStarIcon size={16} /></span>
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
                  <span className="deposit-custom-rub">{formatCurrency(Number(custom), currency, rates, { approximate: true })}</span>
                )}
              </div>
            </div>

            <button className={`deposit-buy-btn ${loading ? 'loading' : ''}`} disabled={!canBuy} onClick={handleBuy}>
              {loading ? (
                <div className="deposit-btn-spinner" />
              ) : (
                <>{t.depositBuy} {activeAmount >= MIN_STARS ? activeAmount : '—'} <TgStarIcon size={18} /></>

              )}
            </button>
          </div>
        )}

        {/* ── Crypto (TON only) ── */}
        {status === 'idle' && view === 'crypto' && (
          <div className="deposit-crypto-detail">
            {/* Coin header */}
            <div className="deposit-crypto-hero" style={{ '--coin-color': '#0098EA' }}>
              <div className="deposit-crypto-hero-icon">
                <TonIcon />
              </div>
              <div className="deposit-crypto-hero-text">
                <span className="deposit-crypto-hero-name">TON</span>
                <span className="deposit-crypto-hero-net">TON Network</span>
              </div>
            </div>

            {/* Address */}
            <div className="deposit-field" onClick={() => handleCopy(TON_ADDRESS, 'address')}>
              <span className="deposit-field-label">{t.depositCryptoAddress}</span>
              <div className="deposit-field-row">
                <span className="deposit-field-mono">{TON_ADDRESS}</span>
                <span className={`deposit-field-copy ${copiedField === 'address' ? 'copied' : ''}`}>
                  {copiedField === 'address' ? t.depositCryptoCopied : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="9" y="9" width="13" height="13" rx="2" />
                      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                    </svg>
                  )}
                </span>
              </div>
            </div>

            {/* Memo / Tag */}
            <div className="deposit-field" onClick={() => handleCopy(String(memoTag), 'memo')}>
              <span className="deposit-field-label">{t.depositCryptoMemo}</span>
              <div className="deposit-field-row">
                <span className="deposit-field-memo">{memoTag}</span>
                <span className={`deposit-field-copy ${copiedField === 'memo' ? 'copied' : ''}`}>
                  {copiedField === 'memo' ? t.depositCryptoCopied : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="9" y="9" width="13" height="13" rx="2" />
                      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                    </svg>
                  )}
                </span>
              </div>
            </div>

            {/* Info block */}
            <div className="deposit-crypto-info-block">
              <div className="deposit-crypto-info-row">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
                <span>{t.depositCryptoMin}: <strong>{minFormatted}</strong></span>
              </div>
              <div className="deposit-crypto-info-row">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                <span>{t.depositCryptoWarn3}</span>
              </div>
            </div>

            {/* Warnings */}
            <div className="deposit-crypto-warnings-block">
              <p>{t.depositCryptoWarn1.replace('{coin}', 'TON').replace('{network}', 'TON Network')}</p>
              <p>{t.depositCryptoWarn2}</p>
            </div>
          </div>
        )}
      </div>
    </>
  )
}
