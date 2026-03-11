import { useState, useRef, useEffect, useCallback } from 'react'
import useGameStore from '../store/useGameStore'
import { getReferralsList } from '../lib/supabase'
import { haptic } from '../lib/telegram'
import { translations } from '../lib/i18n'
import './Shop.css'

// Visual metadata for each plan slot (by position: 0=1m, 1=6m, 2=12m)
const PLAN_META = [
  { badge: null,     gradient: 'linear-gradient(145deg, #1e1b4b 0%, #3730a3 100%)', glow: '#6366f1', borderColor: '#6366f155' },
  { badge: 'popular',gradient: 'linear-gradient(145deg, #3b0764 0%, #7e22ce 100%)', glow: '#a855f7', borderColor: '#a855f788' },
  { badge: 'best',   gradient: 'linear-gradient(145deg, #431407 0%, #c2410c 100%)', glow: '#f97316', borderColor: '#f9731688' },
]

// Merge DB plans with visual metadata
function mergePlans(dbPlans) {
  return dbPlans.map((p, i) => ({
    id:          p.id,
    months:      p.months,
    price:       p.price,
    perMonth:    p.per_month,
    savings:     p.savings || null,
    badge:       PLAN_META[i]?.badge      ?? null,
    gradient:    PLAN_META[i]?.gradient   ?? 'linear-gradient(145deg,#1c1c1e,#2c2c2e)',
    glow:        PLAN_META[i]?.glow       ?? '#3b82f6',
    borderColor: PLAN_META[i]?.borderColor ?? '#3b82f655',
  }))
}

// Fallback static plans (used before DB loads)
const STATIC_PLANS = PLAN_META.map((m, i) => ({
  id: ['1m','6m','12m'][i], months: [1,6,12][i],
  price: [499,2199,3499][i], perMonth: [499,366,292][i],
  savings: [null,795,2489][i], ...m,
}))

const PRO_FEATURES = [
  { emoji: '📊', key: 'proFeat1' },
  { emoji: '⚡', key: 'proFeat2' },
  { emoji: '🏆', key: 'proFeat3' },
  { emoji: '💰', key: 'proFeat4' },
  { emoji: '🎨', key: 'proFeat5' },
]

const REFERRAL_PAGE_SIZE = 20

const AVATAR_COLORS = ['#6366f1', '#a855f7', '#f97316', '#22c55e', '#3b82f6', '#ec4899', '#f59e0b', '#14b8a6']
function avatarColor(name) {
  return AVATAR_COLORS[name.charCodeAt(0) % AVATAR_COLORS.length]
}

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

/* ── Referral Section ── */
function ReferralSection({ t, currency, user }) {
  const { refEarnings, referrals, referralsLoading, setReferrals, setReferralsLoading } = useGameStore()
  const [copied, setCopied] = useState(false)
  const [period, setPeriod] = useState('all')
  const [visible, setVisible] = useState(REFERRAL_PAGE_SIZE)
  const copyTimer = useRef(null)

  // Lazy load referrals list on first Shop visit, then cache in store
  useEffect(() => {
    if (referrals !== null || referralsLoading || !user?.id || user.id === 'dev') return
    setReferralsLoading(true)
    getReferralsList(user.id, 50, 0)
      .then((result) => {
        setReferrals({
          total: result.total ?? 0,
          items: (result.items ?? []).map(r => ({
            ...r,
            earned: {
              day:   r.earned_day   ?? 0,
              week:  r.earned_week  ?? 0,
              month: r.earned_month ?? 0,
              all:   r.earned_all   ?? 0,
            },
          })),
        })
      })
      .catch(() => setReferrals({ total: 0, items: [] }))
      .finally(() => setReferralsLoading(false))
  }, [user?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const refLink = `https://t.me/outplay_bot?start=ref_${user?.id ?? 'dev'}`
  const shortLink = `t.me/outplay_bot?start=ref_${user?.id ?? 'dev'}`

  function handleCopyLink() {
    haptic('light')
    navigator.clipboard?.writeText(refLink).catch(() => {})
    clearTimeout(copyTimer.current)
    setCopied(true)
    copyTimer.current = setTimeout(() => setCopied(false), 2000)
  }

  function handleShare() {
    haptic('medium')
    const tg = window.Telegram?.WebApp
    if (tg) {
      tg.openTelegramLink(
        `https://t.me/share/url?url=${encodeURIComponent(refLink)}&text=${encodeURIComponent(t.refShareText)}`
      )
    } else if (navigator.share) {
      navigator.share({ title: 'Outplay', text: t.refShareText, url: refLink })
    }
  }

  const periods = [
    { key: 'day',   label: t.refDay },
    { key: 'week',  label: t.refWeek },
    { key: 'month', label: t.refMonth },
    { key: 'all',   label: t.refAll },
  ]

  // Dev mock: use store refEarnings (set at bootstrap); real users also use store
  const earnings = refEarnings ? (refEarnings[period] ?? 0) : 0
  const items = referrals?.items ?? []
  const total = referrals?.total ?? 0
  const sorted = [...items].sort((a, b) => b.earned[period] - a.earned[period])
  const displayed = sorted.slice(0, visible)
  const hasMore = visible < items.length

  return (
    <div className="ref-section">

      {/* Divider */}
      <div className="ref-divider" />

      {/* Header */}
      <div className="ref-header">
        <h2 className="ref-title">{t.refTitle}</h2>
        <p className="ref-subtitle">{t.refSubtitle}</p>
      </div>

      {/* Link card */}
      <div className="ref-link-card">
        <span className="ref-link-label">{t.refLink}</span>
        <div className="ref-link-row">
          <button
            className={`ref-link-btn ${copied ? 'ref-link-btn--copied' : ''}`}
            onClick={handleCopyLink}
          >
            {copied ? (
              <span className="ref-copied-text">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path d="M20 6L9 17l-5-5" stroke="#22c55e" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                {t.refCopied}
              </span>
            ) : (
              <>
                <span className="ref-link-text">{shortLink}</span>
                <span className="ref-link-copy-icon">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                    <rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" strokeWidth="2"/>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" stroke="currentColor" strokeWidth="2"/>
                  </svg>
                </span>
              </>
            )}
          </button>
          <button className="ref-share-btn" onClick={handleShare}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
              <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
              <polyline points="16 6 12 2 8 6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
              <line x1="12" y1="2" x2="12" y2="15" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            {t.refShare}
          </button>
        </div>
      </div>

      {/* Earnings card */}
      <div className="ref-earnings-card">
        <div className="ref-earnings-top">
          <span className="ref-earnings-label">{t.refEarnings}</span>
        </div>
        <div className="ref-earnings-periods">
          {periods.map(p => (
            <button
              key={p.key}
              className={`ref-period-btn ${period === p.key ? 'active' : ''}`}
              onClick={() => { haptic('light'); setPeriod(p.key) }}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="ref-earnings-amount">
          <span className="ref-earnings-value">
            {currency.symbol}{earnings.toLocaleString('ru-RU')}
          </span>
          <span className="ref-earnings-period-label">
            {periods.find(p => p.key === period)?.label.toLowerCase()}
          </span>
        </div>
      </div>

      {/* Referrals list */}
      <div className="ref-list-card">
        <div className="ref-list-header">
          <span className="ref-list-title">{t.refCount}</span>
          <span className="ref-list-count">{referralsLoading && referrals === null ? '…' : total}</span>
        </div>

        {referralsLoading && referrals === null ? (
          /* Skeleton rows while loading */
          <div className="ref-rows-wrap">
            {[0,1,2].map(i => (
              <div key={i} className="ref-row ref-row--skeleton">
                <div className="ref-avatar ref-skeleton-box" style={{ width: 36, height: 36, borderRadius: '50%' }} />
                <div className="ref-info">
                  <div className="ref-skeleton-box" style={{ width: 90, height: 13, borderRadius: 6, marginBottom: 4 }} />
                  <div className="ref-skeleton-box" style={{ width: 60, height: 11, borderRadius: 6 }} />
                </div>
                <div className="ref-skeleton-box" style={{ width: 50, height: 13, borderRadius: 6 }} />
              </div>
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="ref-empty">{t.refEmpty}</div>
        ) : (
          <>
            <div className="ref-rows-wrap">
              {displayed.map(r => {
                const color = avatarColor(r.first_name)
                return (
                  <div key={r.id} className="ref-row">
                    <div className="ref-avatar" style={{ background: `${color}22`, color }}>
                      {r.first_name[0]}
                    </div>
                    <div className="ref-info">
                      <span className="ref-name">{r.first_name}</span>
                      <span className="ref-username">@{r.username}</span>
                    </div>
                    <div className="ref-earned">
                      <span className="ref-earned-value">+{currency.symbol}{r.earned[period].toLocaleString('ru-RU')}</span>
                      <span className="ref-earned-label">{t.refEarned}</span>
                    </div>
                  </div>
                )
              })}
            </div>
            {hasMore && (
              <button
                className="ref-show-more"
                tabIndex={-1}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => { haptic('light'); setVisible(v => v + REFERRAL_PAGE_SIZE) }}
              >
                {t.refShowMore}
              </button>
            )}
          </>
        )}
      </div>

    </div>
  )
}

/* ── Shop ── */
export default function Shop() {
  const { lang, currency, user, plans } = useGameStore()
  const t = translations[lang]
  const PLANS = plans.length > 0 ? mergePlans(plans) : STATIC_PLANS
  const [active, setActive] = useState(1)
  const [sheetPlan, setSheetPlan] = useState(null)
  const trackRef = useRef(null)

  useEffect(() => {
    // Immediate reset — fires right after paint
    window.scrollTo(0, 0)
    document.documentElement.scrollTop = 0
    document.body.scrollTop = 0
    // Deferred reset — fires after browser's async scroll restoration (if any)
    const t = setTimeout(() => {
      window.scrollTo(0, 0)
      document.documentElement.scrollTop = 0
      document.body.scrollTop = 0
    }, 0)
    return () => clearTimeout(t)
  }, [])

  useEffect(() => {
    if (!trackRef.current) return
    const track = trackRef.current
    const card = track.children[1]
    if (!card) return
    track.scrollLeft = card.offsetLeft - (track.offsetWidth - card.offsetWidth) / 2
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
    const track = trackRef.current
    const card = track.children[i]
    if (!card) return
    const target = card.offsetLeft - (track.offsetWidth - card.offsetWidth) / 2
    track.scrollTo({ left: target, behavior: 'smooth' })
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

      {/* Referral Section */}
      <ReferralSection t={t} currency={currency} user={user} />

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
