import { useEffect, useState } from 'react'
import useGameStore from '../store/useGameStore'
import { haptic } from '../lib/telegram'
import { translations } from '../lib/i18n'
import './DepositSheet.css'

const STAR_USD = 0.013
const RATES = { RUB: 77, USD: 1, EUR: 0.93 }

const PRESETS = [100, 500, 1000]

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

export default function DepositSheet() {
  const { depositOpen, setDepositOpen, lang, currency } = useGameStore()
  const t = translations[lang]

  const [view, setView] = useState('main') // 'main' | 'stars' | 'crypto'
  const [selected, setSelected] = useState(100)
  const [custom, setCustom] = useState('')

  const activeAmount = custom !== '' ? Number(custom) : selected
  const isCustomValid = custom === '' || Number(custom) >= 100
  const canBuy = activeAmount >= 100 && isCustomValid

  const close = () => {
    haptic('light')
    setDepositOpen(false)
  }

  const goBack = () => {
    haptic('light')
    setView('main')
  }

  useEffect(() => {
    if (!depositOpen) {
      setTimeout(() => { setView('main'); setCustom('') }, 300)
    }
  }, [depositOpen])

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

  function handleBuy() {
    if (!canBuy) return
    haptic('medium')
    // TODO: requestStarsPayment({ amount: activeAmount, ... })
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

        {/* Header */}
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

        {/* Main */}
        {view === 'main' && (
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

        {/* Stars */}
        {view === 'stars' && (
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
                  min={100}
                  onChange={handleCustomChange}
                />
                {custom !== '' && isCustomValid && (
                  <span className="deposit-custom-rub">{toCurrency(Number(custom), currency)}</span>
                )}
              </div>
            </div>

            <button className="deposit-buy-btn" disabled={!canBuy} onClick={handleBuy}>
              {t.depositBuy} {activeAmount >= 100 ? activeAmount : '—'} ⭐
            </button>
          </div>
        )}

        {/* Crypto */}
        {view === 'crypto' && (
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
