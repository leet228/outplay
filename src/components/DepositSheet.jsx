import { useEffect, useState, useRef } from 'react'
import useGameStore from '../store/useGameStore'
import { haptic, requestStarsPayment, getTelegramUser } from '../lib/telegram'
import { createStarsInvoice, processDeposit, getUserBalance } from '../lib/supabase'
import { formatCurrency, convertFromRub, fetchTonPrice } from '../lib/currency'
import { translations } from '../lib/i18n'
import { TON_ADDRESS, USDT_ADDRESS } from '../lib/addresses'
import tgStarSrc      from '../assets/star/tgstar.png'
import tonIconSrc     from '../assets/crypto/ton.svg'
import usdtIconSrc    from '../assets/crypto/usdt.svg'
import smallTonSrc    from '../assets/crypto/small_ton.svg'
import smallUsdtSrc   from '../assets/crypto/small_usdt.svg'
import tonBadgeSrc    from '../assets/crypto/small_ton_for_usdt.svg'
import './DepositSheet.css'

const PRESETS = [100, 500, 1000]
const MIN_STARS = 100

// TON / USDT coin icons are user-supplied SVG assets in
// src/assets/crypto/. Rendered as <img> so the SVG is treated
// as a static image (no inline DOM bloat, lighter render).
function TonIcon({ size = 22 }) {
  return <img src={tonIconSrc} width={size} height={size} alt="" draggable="false" />
}

function UsdtIcon({ size = 22 }) {
  return <img src={usdtIconSrc} width={size} height={size} alt="" draggable="false" />
}

// Compact "small TON" used as the detail-screen hero icon.
// Same TON glyph but without the heavy outer stroke that the
// USDT-corner-badge version carries — better for inline use
// where the icon isn't trying to pop against a green disc.
function SmallTonIcon({ size = 22 }) {
  return <img src={smallTonSrc} width={size} height={size} alt="" draggable="false" />
}

// Compact USDT — sister of SmallTonIcon. Clean Tether disc
// without any stacked network badge, used for the USDT detail
// hero so it visually matches the TON detail hero's bare-icon
// style.
function SmallUsdtIcon({ size = 22 }) {
  return <img src={smallUsdtSrc} width={size} height={size} alt="" draggable="false" />
}

// Small TON badge overlay — sits in the bottom-right corner of
// the USDT icon to signal "USDT on the TON network" (matches
// the convention used across TON wallets and exchanges).
function UsdtTonIcon({ size = 22 }) {
  const badgeSize = Math.round(size * 0.42)
  return (
    <span className="deposit-coin-icon-stack" style={{ width: size, height: size }}>
      <img src={usdtIconSrc} width={size} height={size} alt="" draggable="false" />
      <img
        className="deposit-coin-icon-badge"
        src={smallTonSrc}
        width={badgeSize}
        height={badgeSize}
        alt=""
        draggable="false"
      />
    </span>
  )
}

function TgStarIcon({ size = 22, className = '' }) {
  return (
    <img
      className={`tg-star-icon ${className}`.trim()}
      src={tgStarSrc}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      draggable="false"
      style={{ width: size, height: size }}
    />
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
  const { depositOpen, setDepositOpen, lang, currency, rates, user, setBalance, setBalanceBounce, appSettings } = useGameStore()
  const t = translations[lang]
  const starsEnabled = appSettings.stars_deposits !== false
  const cryptoEnabled = appSettings.crypto_deposits !== false

  const [view, setView] = useState('main')
  const [selected, setSelected] = useState(100)
  const [custom, setCustom] = useState('')
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState('idle')
  const [copiedField, setCopiedField] = useState(null) // 'address' | 'memo'
  const [tonPrice, setTonPrice] = useState(null)       // USD per 1 TON
  const successAmountRef = useRef(0)
  const invoiceTxRef = useRef(null) // shared tx_id between webhook & client

  // Lazy-fetch the TON price when the user lands on a coin
  // detail view. Cached for 5 min by the currency lib, so
  // re-opening the sheet during that window is a no-op.
  useEffect(() => {
    if (view === 'ton' || view === 'usdt') {
      let cancelled = false
      fetchTonPrice().then(p => {
        if (!cancelled && p > 0) setTonPrice(p)
      })
      return () => { cancelled = true }
    }
  }, [view])

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
      // Coin detail (ton / usdt) → back to main (which now has
      // the TON + USDT cards inline under "Криптовалюта").
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
  const MIN_RUB = 200
  const minFormatted = formatCurrency(MIN_RUB, currency, rates, { approximate: true })

  // Crypto equivalent of 200 ₽:
  //   USDT — pegged to USD, so it equals 200 ₽ → USD via the
  //          existing fiat rate table.
  //   TON  — uses the live CoinGecko price (USD per 1 TON).
  //          200 ₽ → USD / tonPrice.
  // Returns null until tonPrice has resolved on first open.
  const minUsdt = (() => {
    const usd = convertFromRub(MIN_RUB, 'USD', rates)
    return usd > 0 ? usd : null
  })()
  const minTon = (() => {
    if (!tonPrice || tonPrice <= 0) return null
    const usd = convertFromRub(MIN_RUB, 'USD', rates)
    return usd > 0 ? usd / tonPrice : null
  })()

  // 2-decimal display for USDT, 3-decimal for TON (TON values
  // are smaller per unit so 3 decimals reads better).
  const fmtUsdt = minUsdt != null ? `${minUsdt.toFixed(2)} USDT` : null
  const fmtTon  = minTon  != null ? `${minTon.toFixed(3)} TON`  : null

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
              <button
                type="button"
                className="deposit-coin-card deposit-coin-card--stars"
                onClick={() => { haptic('medium'); setView('stars') }}
              >
                {/* Big star icon bleeds out of the top-LEFT
                  * corner (mirror of the crypto cards whose icons
                  * bleed out the bottom-RIGHT). Same dark-gray
                  * card surface ties the row together visually. */}
                <img
                  className="deposit-coin-card-art deposit-coin-card-art--topleft"
                  src={tgStarSrc}
                  alt=""
                  draggable="false"
                />
                <div className="deposit-coin-card-text deposit-coin-card-text--right">
                  <span className="deposit-coin-card-name">{t.depositStars}</span>
                  <span className="deposit-coin-card-sub">{t.depositStarsSub}</span>
                </div>
                <svg
                  className="deposit-coin-card-arrow"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <path d="M9 18l6-6-6-6" />
                </svg>
              </button>
            )}
            {cryptoEnabled && (
              <>
                <span className="deposit-section-heading">{t.depositCrypto}</span>
                <div className="deposit-coin-grid">
                  {/* TON — left.
                    * Layout mirrors the reference design: text
                    * stacked top-left, big icon absolutely
                    * positioned bottom-right and partially clipped
                    * by the card's overflow:hidden. */}
                  <button
                    type="button"
                    className="deposit-coin-card deposit-coin-card--ton"
                    onClick={() => { haptic('medium'); setView('ton') }}
                  >
                    <div className="deposit-coin-card-text">
                      <span className="deposit-coin-card-name">{t.depositCryptoTon}</span>
                      <span className="deposit-coin-card-sub">{t.depositCryptoTonSub}</span>
                    </div>
                    <img
                      className="deposit-coin-card-art"
                      src={tonIconSrc}
                      alt=""
                      draggable="false"
                    />
                  </button>

                  {/* USDT (TON) — right. Same layout; the icon
                    * is the USDT disc + a small TON network
                    * badge in the bottom-right corner of the
                    * USDT disc. */}
                  <button
                    type="button"
                    className="deposit-coin-card deposit-coin-card--usdt"
                    onClick={() => { haptic('medium'); setView('usdt') }}
                  >
                    {/* TON network badge pinned to the CARD's
                      * top-right corner (not to the icon) — so
                      * it sits as a separate "network" marker
                      * above the USDT disc, matching the latest
                      * spec from the user. */}
                    <img
                      className="deposit-coin-card-net-badge"
                      src={tonBadgeSrc}
                      alt=""
                      draggable="false"
                    />
                    <div className="deposit-coin-card-text">
                      <span className="deposit-coin-card-name">{t.depositCryptoUsdt}</span>
                      <span className="deposit-coin-card-sub">{t.depositCryptoUsdtSub}</span>
                    </div>
                    <img
                      className="deposit-coin-card-art"
                      src={usdtIconSrc}
                      alt=""
                      draggable="false"
                    />
                  </button>
                </div>
              </>
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
                  <span className="deposit-preset-stars"><TgStarIcon size={30} /> {amount}</span>
                  <span className="deposit-preset-rub">{formatCurrency(amount, currency, rates, { approximate: true })}</span>
                </button>
              ))}
            </div>

            <div className="deposit-custom-wrap">
              <span className="deposit-custom-label">{t.depositCustom}</span>
              <div className={`deposit-custom-input-wrap ${custom !== '' && !isCustomValid ? 'error' : ''} ${custom !== '' && isCustomValid ? 'filled' : ''}`}>
                <span className="deposit-custom-star"><TgStarIcon size={30} /></span>
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
                <>{t.depositBuy} {activeAmount >= MIN_STARS ? activeAmount : '—'} <TgStarIcon size={32} /></>

              )}
            </button>
          </div>
        )}

        {/* ── TON deposit details ── */}
        {status === 'idle' && view === 'ton' && (
          <div className="deposit-crypto-detail">
            <div className="deposit-crypto-hero deposit-crypto-hero--ton" style={{ '--coin-color': '#0098EA' }}>
              <div className="deposit-crypto-hero-icon">
                {/* Larger TON icon (56 px) — user wanted the TON
                  * hero icon bumped up beyond the default. */}
                <SmallTonIcon size={56} />
              </div>
              <div className="deposit-crypto-hero-text">
                <span className="deposit-crypto-hero-name">TON</span>
                <span className="deposit-crypto-hero-net">{t.depositCryptoTonNet}</span>
              </div>
            </div>

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

            <div className="deposit-crypto-info-block">
              <div className="deposit-crypto-info-row">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
                <span>
                  {t.depositCryptoMin}: <strong>{minFormatted}</strong>
                  {view === 'usdt' && fmtUsdt && <span className="deposit-crypto-min-crypto">{' · ≈ '}{fmtUsdt}</span>}
                  {view === 'ton'  && fmtTon  && <span className="deposit-crypto-min-crypto">{' · ≈ '}{fmtTon}</span>}
                </span>
              </div>
              <div className="deposit-crypto-info-row">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                <span>{t.depositCryptoWarn3}</span>
              </div>
            </div>

            <div className="deposit-crypto-warnings-block">
              <p>{t.depositCryptoWarn1.replace('{coin}', 'TON').replace('{network}', 'Toncoin')}</p>
              <p>{t.depositCryptoWarn2}</p>
            </div>
          </div>
        )}

        {/* ── USDT (TON) deposit details ── */}
        {status === 'idle' && view === 'usdt' && (
          <div className="deposit-crypto-detail">
            <div className="deposit-crypto-hero" style={{ '--coin-color': '#26A17B' }}>
              <div className="deposit-crypto-hero-icon">
                {/* Bare USDT disc — same 56 px size as the TON
                  * detail's SmallTonIcon, no stacked badge or
                  * background card around it. */}
                <SmallUsdtIcon size={56} />
              </div>
              <div className="deposit-crypto-hero-text">
                <span className="deposit-crypto-hero-name">USDT</span>
                <span className="deposit-crypto-hero-net">{t.depositCryptoUsdtNet}</span>
              </div>
            </div>

            <div className="deposit-field" onClick={() => handleCopy(USDT_ADDRESS, 'address')}>
              <span className="deposit-field-label">{t.depositCryptoAddress}</span>
              <div className="deposit-field-row">
                <span className="deposit-field-mono">{USDT_ADDRESS}</span>
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

            <div className="deposit-crypto-info-block">
              <div className="deposit-crypto-info-row">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
                <span>
                  {t.depositCryptoMin}: <strong>{minFormatted}</strong>
                  {view === 'usdt' && fmtUsdt && <span className="deposit-crypto-min-crypto">{' · ≈ '}{fmtUsdt}</span>}
                  {view === 'ton'  && fmtTon  && <span className="deposit-crypto-min-crypto">{' · ≈ '}{fmtTon}</span>}
                </span>
              </div>
              <div className="deposit-crypto-info-row">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                <span>{t.depositCryptoWarn3}</span>
              </div>
            </div>

            <div className="deposit-crypto-warnings-block">
              <p>{t.depositCryptoWarn1Usdt}</p>
              <p>{t.depositCryptoWarn2}</p>
            </div>
          </div>
        )}
      </div>
    </>
  )
}
