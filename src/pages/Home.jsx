import { useRef, useState, useEffect, useCallback } from 'react'
import useGameStore from '../store/useGameStore'
import { haptic } from '../lib/telegram'
import { translations } from '../lib/i18n'
import './Home.css'

/* ── Icons ── */
function QuizIcon() {
  return (
    <svg width="52" height="52" viewBox="0 0 24 24" fill="none">
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
      <circle cx="12" cy="17" r="1" fill="currentColor"/>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/>
    </svg>
  )
}

function LightningIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
      <path d="M13 2L4.5 13.5H11L10 22L20.5 10H14L13 2Z" fill="currentColor" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
    </svg>
  )
}

function StarIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" fill="currentColor" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
    </svg>
  )
}

function SparkleIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
      <path d="M12 2C12 2 13 8 16 11C19 14 24 12 24 12C24 12 19 13 16 16C13 19 12 24 12 24C12 24 11 19 8 16C5 13 0 12 0 12C0 12 5 11 8 8C11 5 12 2 12 2Z" fill="currentColor"/>
    </svg>
  )
}

function TrophyIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
      <path d="M6 2H18V13C18 16.31 15.31 19 12 19C8.69 19 6 16.31 6 13V2Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/>
      <path d="M6 5H3C3 5 2 11 6 11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
      <path d="M18 5H21C21 5 22 11 18 11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
      <path d="M12 19V22M9 22H15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
    </svg>
  )
}

function CrownIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M3 17L5.5 8L9.5 13L12 6L14.5 13L18.5 8L21 17H3Z" fill="currentColor" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round"/>
      <rect x="3" y="17" width="18" height="2.5" rx="1.25" fill="currentColor"/>
    </svg>
  )
}

function TargetIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8"/>
      <circle cx="12" cy="12" r="5" stroke="currentColor" strokeWidth="1.8"/>
      <circle cx="12" cy="12" r="2" fill="currentColor"/>
    </svg>
  )
}

function BrainIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none">
      <path d="M9.5 2C7 2 5 4 5 6.5C3.5 7 2 8.5 2 10.5C2 12 2.8 13.3 4 14C4 16.8 6.2 19 9 19H15C17.8 19 20 16.8 20 14C21.2 13.3 22 12 22 10.5C22 8.5 20.5 7 19 6.5C19 4 17 2 14.5 2C13.5 2 12.6 2.4 12 3C11.4 2.4 10.5 2 9.5 2Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/>
      <path d="M12 3V19M9 8C9 8 7 9 7 11M15 8C15 8 17 9 17 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  )
}

function SwordsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none">
      <path d="M14.5 17.5L3 6V3H6L17.5 14.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M13 19L15 17" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
      <path d="M17 21L21 17L20 13L11 4L8 3L3 3L14.5 14.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M5 11L11 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
    </svg>
  )
}

function FireIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none">
      <path d="M8.5 14C8.5 14 8 12.5 9 11C10 9.5 10.5 8 10 6C10 6 12 7 13 9C14 10 14 11.5 14 11.5C14 11.5 15 10 15 8C15 8 17 10 17 13C17 16.3 14.8 19 12 19C9.2 19 7 16.3 7 13C7 12 7.3 11 8.5 14Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/>
    </svg>
  )
}

function GiftIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none">
      <rect x="3" y="8" width="18" height="4" rx="1.5" stroke="currentColor" strokeWidth="1.8"/>
      <path d="M12 8V21M5 12V20C5 20.6 5.4 21 6 21H18C18.6 21 19 20.6 19 20V12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
      <path d="M12 8C12 8 9 8 9 5.5C9 4 10 3 11.5 3C12.5 3 12 8 12 8ZM12 8C12 8 15 8 15 5.5C15 4 14 3 12.5 3C11.5 3 12 8 12 8Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
    </svg>
  )
}

/* ── Banners ── */
const BANNERS = [
  { Icon: BrainIcon,  titleKey: 'banner1Title', subKey: 'banner1Sub', gradient: 'linear-gradient(135deg, #1d4ed8 0%, #3b82f6 100%)' },
  { Icon: TrophyIcon, titleKey: 'banner2Title', subKey: 'banner2Sub', gradient: 'linear-gradient(135deg, #92400e 0%, #f59e0b 100%)' },
  { Icon: FireIcon,   titleKey: 'banner3Title', subKey: 'banner3Sub', gradient: 'linear-gradient(135deg, #5b21b6 0%, #8b5cf6 100%)' },
  { Icon: GiftIcon,   titleKey: 'banner4Title', subKey: 'banner4Sub', gradient: 'linear-gradient(135deg, #065f46 0%, #10b981 100%)' },
]

function BannerCarousel({ t }) {
  const [active, setActive] = useState(0)
  const trackRef = useRef(null)
  const activeRef = useRef(0)

  function goTo(index) {
    if (!trackRef.current) return
    trackRef.current.scrollTo({ left: index * trackRef.current.offsetWidth, behavior: 'smooth' })
    setActive(index)
    activeRef.current = index
  }

  useEffect(() => {
    const timerRef = { id: null }

    function start() {
      timerRef.id = setInterval(() => {
        const next = (activeRef.current + 1) % BANNERS.length
        goTo(next)
      }, 7000)
    }

    function stop() {
      clearInterval(timerRef.id)
    }

    function onVisibility() {
      document.hidden ? stop() : start()
    }

    start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  function handleScroll() {
    if (!trackRef.current) return
    const index = Math.round(trackRef.current.scrollLeft / trackRef.current.offsetWidth)
    setActive(index)
    activeRef.current = index
  }

  return (
    <div className="banner-carousel">
      <div className="banner-track" ref={trackRef} onScroll={handleScroll}>
        {BANNERS.map((b, i) => (
          <div key={i} className="banner-slide" style={{ background: b.gradient }}>
            <div className="banner-icon-wrap"><b.Icon /></div>
            <div className="banner-text">
              <span className="banner-title">{t[b.titleKey]}</span>
              <span className="banner-sub">{t[b.subKey]}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="banner-dots">
        {BANNERS.map((_, i) => (
          <button key={i} className={`banner-dot ${i === active ? 'active' : ''}`} onClick={() => goTo(i)} />
        ))}
      </div>
    </div>
  )
}

/* ── Game Sheet ── */
const STAKES = [100, 300, 500, 1000]

function GameSheet({ game, t, balance, currency, onClose }) {
  const [selectedStakes, setSelectedStakes] = useState([])
  const [error, setError] = useState(false)
  const errorTimer = useRef(null)

  useEffect(() => {
    setSelectedStakes([])
    setError(false)
  }, [game?.id])

  useEffect(() => {
    const tg = window.Telegram?.WebApp
    if (!tg) return
    if (game) {
      tg.BackButton.show()
      tg.BackButton.onClick(onClose)
    } else {
      tg.BackButton.hide()
      tg.BackButton.offClick(onClose)
    }
    return () => tg.BackButton.offClick(onClose)
  }, [game, onClose])

  function toggleStake(amount) {
    if (amount > balance) {
      haptic('light')
      clearTimeout(errorTimer.current)
      setError(true)
      errorTimer.current = setTimeout(() => setError(false), 2000)
      return
    }
    haptic('light')
    setSelectedStakes(prev =>
      prev.includes(amount) ? prev.filter(s => s !== amount) : [...prev, amount]
    )
  }

  function handlePlay() {
    if (selectedStakes.length === 0) return
    haptic('medium')
    // TODO: navigate to matchmaking
  }

  const accent = game?.accent ?? '#3B82F6'

  return (
    <>
      <div className={`sheet-overlay ${game ? 'visible' : ''}`} onClick={onClose} />
      <div className={`game-sheet ${game ? 'open' : ''}`}>
        <div className="sheet-handle" />

        {/* Header */}
        <div className="sheet-header">
          <div className="sheet-icon-wrap" style={{ '--sa': accent }}>
            <QuizIcon />
          </div>
          <h2 className="sheet-title" style={{ color: accent }}>
            {game ? t[game.titleKey] : ''}
          </h2>
          <span className="sheet-subtitle">1 vs 1</span>
        </div>

        {/* Stats row */}
        <div className="sheet-stats-row">
          <div className="sheet-stat">
            <span className="sheet-stat-val">5</span>
            <span className="sheet-stat-lbl">{t.sheetStatQ}</span>
          </div>
          <div className="sheet-stat-div" />
          <div className="sheet-stat">
            <span className="sheet-stat-val">30</span>
            <span className="sheet-stat-lbl">{t.sheetStatSec}</span>
          </div>
          <div className="sheet-stat-div" />
          <div className="sheet-stat">
            <span className="sheet-stat-val">1v1</span>
            <span className="sheet-stat-lbl">{t.sheetStatMode}</span>
          </div>
        </div>

        {/* Rules */}
        <div className="sheet-rules">
          <div className="sheet-rule">
            <div className="sheet-rule-dot" style={{ background: accent }} />
            <span>{t.sheetRule1}</span>
          </div>
          <div className="sheet-rule">
            <div className="sheet-rule-dot" style={{ background: accent }} />
            <span>{t.sheetRule2}</span>
          </div>
          <div className="sheet-rule">
            <div className="sheet-rule-dot" style={{ background: accent }} />
            <span>{t.sheetRule3}</span>
          </div>
        </div>

        {/* Stakes */}
        <div className="sheet-stakes-section">
          <span className="sheet-label">{t.sheetStakeLabel}</span>
          <span className="sheet-stake-hint">{t.sheetStakeHint}</span>
          <div className="sheet-stakes-row">
            {STAKES.map(amount => {
              const canAfford = amount <= balance
              const isActive = selectedStakes.includes(amount)
              return (
                <button
                  key={amount}
                  className={`sheet-stake ${isActive ? 'active' : ''} ${!canAfford ? 'locked' : ''}`}
                  onClick={() => toggleStake(amount)}
                >
                  {currency.symbol}{amount}
                </button>
              )
            })}
          </div>
          <div className={`sheet-error ${error ? 'visible' : ''}`}>
            {t.sheetInsufficientBalance}
          </div>
        </div>

        {/* CTA */}
        <button
          className="sheet-play-btn"
          disabled={selectedStakes.length === 0}
          onClick={handlePlay}
        >
          {t.sheetPlay}
        </button>
      </div>
    </>
  )
}

/* ── Games ── */
const GAMES = [
  { id: 'quiz', titleKey: 'gameQuizTitle', subKey: 'gameQuizSub', available: true,  accent: '#3B82F6', shadow: '#1d3461' },
  { id: 'speed', titleKey: 'gameSpeedTitle', subKey: 'gameSpeedSub', available: false, accent: '#8B5CF6', shadow: '#2d1b69' },
  { id: 'blitz', titleKey: 'gameBlitzTitle', subKey: 'gameBlitzSub', available: false, accent: '#F59E0B', shadow: '#78350f' },
]

/* ── Home ── */
export default function Home() {
  const { balance, currency, lang, setDepositOpen } = useGameStore()
  const t = translations[lang]
  const [sheetGame, setSheetGame] = useState(null)

  const closeSheet = useCallback(() => {
    haptic('light')
    setSheetGame(null)
  }, [])

  function handleGameTap(game) {
    if (!game.available) return
    haptic('medium')
    setSheetGame(game)
  }

  return (
    <div className="home page">
      <div className="home-topbar">
        <span className="topbar-logo">OUTPLAY</span>
        <div className="topbar-balance">
          <span className="topbar-currency">{currency.symbol}</span>
          <span className="topbar-amount">{Number(balance).toFixed(2)}</span>
          <button className="topbar-plus" onClick={() => { haptic('light'); setDepositOpen(true) }}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path d="M8 2V14M2 8H14" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
      </div>

      <BannerCarousel t={t} />

      <div className="games-section">
        <span className="games-label">{t.gamesLabel}</span>
        <div className="games-grid">

          <button
            className="game-card game-card--main"
            style={{ '--card-accent': GAMES[0].accent, '--card-shadow': GAMES[0].shadow }}
            onClick={() => handleGameTap(GAMES[0])}
          >
            <div className="game-card-glow" />
            <div className="game-card-deco" style={{ top: '12%', left: '28px', transform: 'rotate(-18deg)' }}><LightningIcon /></div>
            <div className="game-card-deco" style={{ top: '44%', left: '6px', transform: 'rotate(6deg)' }}><SparkleIcon /></div>
            <div className="game-card-deco" style={{ bottom: '12%', left: '28px', transform: 'rotate(-8deg)' }}><StarIcon /></div>
            <div className="game-card-deco" style={{ top: '12%', right: '28px', transform: 'rotate(16deg)' }}><TrophyIcon /></div>
            <div className="game-card-deco" style={{ top: '44%', right: '6px', transform: 'rotate(-10deg)' }}><CrownIcon /></div>
            <div className="game-card-deco" style={{ bottom: '12%', right: '28px', transform: 'rotate(6deg)' }}><TargetIcon /></div>
            <div className="game-card-icon game-card-icon--center">
              <QuizIcon />
            </div>
            <span className="game-card-title">{t.gameQuizTitle}</span>
          </button>

          <div className="games-row">
            {GAMES.slice(1).map(g => (
              <button
                key={g.id}
                className="game-card game-card--small game-card--soon"
                style={{ '--card-accent': g.accent, '--card-shadow': g.shadow }}
                disabled
              >
                <div className="game-card-glow" />
                <div className="game-card-info">
                  <span className="game-card-title">{t[g.titleKey]}</span>
                  <span className="game-card-sub">{t[g.subKey]}</span>
                </div>
                <div className="game-card-badge">{t.soon}</div>
              </button>
            ))}
          </div>

        </div>
      </div>

      <GameSheet
        game={sheetGame}
        t={t}
        balance={balance}
        currency={currency}
        onClose={closeSheet}
      />
    </div>
  )
}
