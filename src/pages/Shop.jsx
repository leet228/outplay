import { useState, useRef, useEffect, useCallback } from 'react'
import useGameStore from '../store/useGameStore'
import { haptic } from '../lib/telegram'
import { translations } from '../lib/i18n'
import './Shop.css'

const PLANS = [
  {
    id: '1m',
    months: 1,
    price: 499,
    perMonth: 499,
    savings: null,
    badge: null,
    gradient: 'linear-gradient(145deg, #1e1b4b 0%, #3730a3 100%)',
    glow: '#6366f1',
    borderColor: '#6366f155',
  },
  {
    id: '6m',
    months: 6,
    price: 2199,
    perMonth: 366,
    savings: 795,
    badge: 'popular',
    gradient: 'linear-gradient(145deg, #3b0764 0%, #7e22ce 100%)',
    glow: '#a855f7',
    borderColor: '#a855f788',
  },
  {
    id: '12m',
    months: 12,
    price: 3499,
    perMonth: 292,
    savings: 2489,
    badge: 'best',
    gradient: 'linear-gradient(145deg, #431407 0%, #c2410c 100%)',
    glow: '#f97316',
    borderColor: '#f9731688',
  },
]

const PRO_FEATURES = [
  { emoji: '📊', key: 'proFeat1' },
  { emoji: '⚡', key: 'proFeat2' },
  { emoji: '🏆', key: 'proFeat3' },
  { emoji: '💰', key: 'proFeat4' },
  { emoji: '🎨', key: 'proFeat5' },
]

/* ── Plan Sheet ── */
function PlanSheet({ plan, t, currency, onClose }) {
  useEffect(() => {
    if (plan) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => { document.body.style.overflow = '' }
  }, [plan])

  useEffect(() => {
    const tg = window.Telegram?.WebApp
    if (!tg) return
    if (plan) {
      tg.BackButton.show()
      tg.BackButton.onClick(onClose)
    } else {
      tg.BackButton.hide()
      tg.BackButton.offClick(onClose)
    }
    return () => tg.BackButton.offClick(onClose)
  }, [plan, onClose])

  function handleSubscribe() {
    haptic('medium')
    // TODO: Telegram Stars payment
  }

  const periodLabel = plan
    ? plan.months === 1 ? t.pro1Month : plan.months === 6 ? t.pro6Month : t.pro12Month
    : ''

  return (
    <>
      <div className={`sheet-overlay ${plan ? 'visible' : ''}`} onClick={onClose} />
      <div className={`plan-sheet ${plan ? 'open' : ''}`}>
        <div className="sheet-handle" />

        {/* Plan header */}
        <div className="plan-sheet-header">
          <div className="plan-sheet-crown" style={{ background: plan?.gradient }}>
            <span>👑</span>
          </div>
          <div className="plan-sheet-titles">
            <span className="plan-sheet-pro">PRO</span>
            <span className="plan-sheet-period">{periodLabel}</span>
          </div>
          {plan?.badge && (
            <div className="plan-sheet-badge" style={{ color: plan.glow, background: `${plan.glow}18`, borderColor: `${plan.glow}44` }}>
              {plan.badge === 'popular' ? t.proPopular : t.proBest}
            </div>
          )}
        </div>

        {/* Price block */}
        <div className="plan-sheet-price-block" style={{ '--plan-glow': plan?.glow }}>
          <div className="plan-sheet-price-orb" />
          <span className="plan-sheet-price">
            {currency.symbol}{plan?.price.toLocaleString('ru-RU')}
          </span>
          <span className="plan-sheet-per">
            {currency.symbol}{plan?.perMonth} {t.proPerMonth}
          </span>
          {plan?.savings && (
            <span className="plan-sheet-savings">
              {t.proSave} {currency.symbol}{plan.savings.toLocaleString('ru-RU')}
            </span>
          )}
        </div>

        {/* Features */}
        <div className="plan-sheet-features">
          <span className="sheet-label">{t.proWhatsIncluded}</span>
          {PRO_FEATURES.map(f => (
            <div key={f.key} className="plan-feature-row">
              <span className="plan-feature-check" style={{ color: plan?.glow }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path d="M20 6L9 17l-5-5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </span>
              <span className="plan-feature-emoji">{f.emoji}</span>
              <span className="plan-feature-text">{t[f.key]}</span>
            </div>
          ))}
        </div>

        {/* CTA */}
        <button
          className="plan-subscribe-btn"
          style={{ background: plan?.gradient, '--plan-glow': plan?.glow }}
          onClick={handleSubscribe}
        >
          {t.proSubscribe} · {currency.symbol}{plan?.price.toLocaleString('ru-RU')}
        </button>
      </div>
    </>
  )
}

/* ── Shop ── */
export default function Shop() {
  const { lang, currency } = useGameStore()
  const t = translations[lang]
  const [active, setActive] = useState(1)
  const [sheetPlan, setSheetPlan] = useState(null)
  const trackRef = useRef(null)

  useEffect(() => {
    if (!trackRef.current) return
    const card = trackRef.current.children[1]
    if (card) card.scrollIntoView({ block: 'nearest', inline: 'center' })
  }, [])

  function handleScroll() {
    if (!trackRef.current) return
    const { scrollLeft, offsetWidth } = trackRef.current
    let closest = 0, closestDist = Infinity
    Array.from(trackRef.current.children).forEach((child, i) => {
      const center = child.offsetLeft + child.offsetWidth / 2 - scrollLeft
      const dist = Math.abs(center - offsetWidth / 2)
      if (dist < closestDist) { closestDist = dist; closest = i }
    })
    setActive(closest)
  }

  function goTo(i) {
    if (!trackRef.current) return
    const card = trackRef.current.children[i]
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
    setActive(i)
  }

  function handleCardClick(i) {
    if (i !== active) {
      goTo(i)
      return
    }
    haptic('medium')
    setSheetPlan(PLANS[i])
  }

  const closeSheet = useCallback(() => {
    haptic('light')
    setSheetPlan(null)
  }, [])

  return (
    <div className="shop page">

      {/* PRO Header */}
      <div className="pro-header">
        <div className="pro-crown-wrap">
          <span className="pro-crown-emoji">👑</span>
        </div>
        <h1 className="pro-title">Outplay <span className="pro-title-accent">PRO</span></h1>
        <p className="pro-subtitle">{t.proSubtitle}</p>
      </div>

      {/* Plans carousel */}
      <div className="pro-carousel-wrap">
        <div className="pro-track" ref={trackRef} onScroll={handleScroll}>
          {PLANS.map((p, i) => {
            const isActive = i === active
            const periodLabel = p.months === 1 ? t.pro1Month : p.months === 6 ? t.pro6Month : t.pro12Month
            return (
              <div
                key={p.id}
                className={`pro-card ${isActive ? 'pro-card--active' : ''}`}
                style={{ background: p.gradient, '--plan-glow': p.glow, '--plan-border': p.borderColor }}
                onClick={() => handleCardClick(i)}
              >
                <div className="pro-card-orb" />
                {p.badge && (
                  <div className={`pro-badge ${p.badge === 'popular' ? 'pro-badge--purple' : 'pro-badge--orange'}`}>
                    {p.badge === 'popular' ? t.proPopular : t.proBest}
                  </div>
                )}
                <div className="pro-card-period">{periodLabel}</div>
                <div className="pro-card-price">{currency.symbol}{p.price.toLocaleString('ru-RU')}</div>
                <div className="pro-card-per">{currency.symbol}{p.perMonth} {t.proPerMonth}</div>
                {p.savings && (
                  <div className="pro-card-savings">
                    {t.proSave} {currency.symbol}{p.savings.toLocaleString('ru-RU')}
                  </div>
                )}
                {isActive && (
                  <div className="pro-card-tap-hint">{t.proTapToSubscribe}</div>
                )}
              </div>
            )
          })}
        </div>

        <div className="pro-dots">
          {PLANS.map((p, i) => (
            <button
              key={i}
              className={`pro-dot ${i === active ? 'active' : ''}`}
              style={i === active ? { background: p.glow, width: '20px' } : {}}
              onClick={() => goTo(i)}
            />
          ))}
        </div>
      </div>

      {/* Plan Sheet */}
      <PlanSheet
        plan={sheetPlan}
        t={t}
        currency={currency}
        onClose={closeSheet}
      />
    </div>
  )
}
