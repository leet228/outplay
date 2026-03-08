import { useNavigate } from 'react-router-dom'
import useGameStore from '../store/useGameStore'
import { haptic } from '../lib/telegram'
import { translations } from '../lib/i18n'
import './Home.css'

export default function Home() {
  const navigate = useNavigate()
  const { user, balance, currency, lang, setDepositOpen } = useGameStore()
  const t = translations[lang]

  function handleDuel() {
    haptic('medium')
    navigate('/duel')
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

      <p className="tagline">{t.tagline}</p>

      <div className="home-actions">
        <button className="btn-primary" onClick={handleDuel}>
          {t.findDuel}
        </button>
        <button className="btn-secondary" onClick={() => navigate('/duel')}>
          {t.createDuel}
        </button>
      </div>

      <div className="home-stats">
        <div className="stat">
          <span className="stat-value">{user?.wins ?? 0}</span>
          <span className="stat-label">{t.wins}</span>
        </div>
        <div className="stat">
          <span className="stat-value">{user?.losses ?? 0}</span>
          <span className="stat-label">{t.losses}</span>
        </div>
        <div className="stat">
          <span className="stat-value">
            {user?.wins && user?.losses
              ? Math.round((user.wins / (user.wins + user.losses)) * 100)
              : 0}%
          </span>
          <span className="stat-label">{t.winrate}</span>
        </div>
      </div>
    </div>
  )
}
