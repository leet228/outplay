import useGameStore from '../store/useGameStore'
import { translations } from '../lib/i18n'
import { formatCurrency } from '../lib/currency'
import './Leaderboard.css'

function approxRank(rank) {
  if (rank > 1000) return '1000+'
  if (rank > 500)  return '500+'
  if (rank > 100)  return '100+'
  if (rank > 50)   return '50+'
  return `#${rank}`
}

const RANK_COLORS = ['#f59e0b', '#94a3b8', '#b07040']

function CrownIcon() {
  return (
    <svg width="28" height="24" viewBox="0 0 28 24" fill="none">
      <path d="M2 19L6 6L12 14L14 3L16 14L22 6L26 19H2Z"
        fill="#f59e0b" stroke="#fcd34d" strokeWidth="1.2"
        strokeLinejoin="round" strokeLinecap="round" />
      <rect x="2" y="19" width="24" height="4" rx="2" fill="#f59e0b" />
      <circle cx="14" cy="3" r="2" fill="#fde68a" />
      <circle cx="2.5" cy="6.5" r="1.8" fill="#fde68a" />
      <circle cx="25.5" cy="6.5" r="1.8" fill="#fde68a" />
    </svg>
  )
}

function SilverIcon() {
  return (
    <svg width="22" height="26" viewBox="0 0 22 26" fill="none">
      <path d="M11 2L13.5 8H20L14.5 12L16.5 19L11 15L5.5 19L7.5 12L2 8H8.5L11 2Z"
        fill="#94a3b8" stroke="#cbd5e1" strokeWidth="1" strokeLinejoin="round" />
    </svg>
  )
}

function BronzeIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
      <path d="M11 1L13.2 7.5H20L14.4 11.5L16.6 18L11 14L5.4 18L7.6 11.5L2 7.5H8.8L11 1Z"
        fill="#b07040" stroke="#cd8a5a" strokeWidth="1" strokeLinejoin="round" />
    </svg>
  )
}

function PodiumRankIcon({ rank }) {
  if (rank === 1) return <CrownIcon />
  if (rank === 2) return <SilverIcon />
  return <BronzeIcon />
}

function ListRankBadge({ rank }) {
  if (rank > 3) return <span className="lb-rank-num">#{rank}</span>
  const gradients = [
    'linear-gradient(135deg, #d97706, #fbbf24)',
    'linear-gradient(135deg, #64748b, #94a3b8)',
    'linear-gradient(135deg, #7c4a1e, #b07040)',
  ]
  return (
    <span className="lb-rank-badge" style={{ background: gradients[rank - 1] }}>
      {rank}
    </span>
  )
}

export default function Leaderboard() {
  const { user, currency, rates, lang, leaderboard, rank, totalPnl } = useGameStore()
  const t = translations[lang]
  const photoUrl = window.Telegram?.WebApp?.initDataUnsafe?.user?.photo_url

  const sorted = [...leaderboard].sort((a, b) => b.balance - a.balance)
  const userInTop = sorted.some(p => p.id === user?.id)

  // User's own WR for "my position" card
  const myWins = user?.wins ?? 0
  const myLosses = user?.losses ?? 0
  const myWr = myWins + myLosses > 0 ? Math.round((myWins / (myWins + myLosses)) * 100) : 0
  const myPnl = totalPnl ?? 0
  const myPnlPositive = myPnl >= 0

  return (
    <div className="leaderboard page">
      <div className="lb-header">
        <h2 className="lb-title">{t.leaderboard}</h2>
      </div>

      {/* Top 3 podium */}
      <div className="lb-podium">
        {sorted.slice(0, 3).map((p, i) => {
          const isPos = p.balance >= 0
          const wr = p.wins + p.losses > 0
            ? Math.round((p.wins / (p.wins + p.losses)) * 100)
            : 0
          return (
            <div key={p.id} className={`lb-podium-card lb-podium-card--${i + 1}`}>
              <div className="lb-podium-icon">
                <PodiumRankIcon rank={i + 1} />
              </div>
              <div className="lb-podium-avatar" style={{ borderColor: RANK_COLORS[i], padding: 0, overflow: 'hidden' }}>
                {p.avatar_url
                  ? <img src={p.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} />
                  : p.first_name[0]}
              </div>
              <span className="lb-podium-name">{p.first_name}</span>
              <span className={`lb-podium-pnl ${isPos ? 'positive' : 'negative'}`}>
                {formatCurrency(p.balance, currency, rates, { sign: '+' })}
              </span>
              <span className="lb-podium-wr">{wr}% WR</span>
            </div>
          )
        })}
      </div>

      {/* Full list */}
      <div className="lb-list">
        {sorted.map((p, i) => {
          const isPos = p.balance >= 0
          const wr = p.wins + p.losses > 0
            ? Math.round((p.wins / (p.wins + p.losses)) * 100)
            : 0
          const isMe = p.id === user?.id
          return (
            <div key={p.id} className={`lb-row ${isMe ? 'lb-row--mine' : ''}`}>
              <div className="lb-rank-wrap">
                <ListRankBadge rank={i + 1} />
              </div>
              <div className="lb-avatar" style={{ padding: 0, overflow: 'hidden' }}>
                {p.avatar_url
                  ? <img src={p.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }} />
                  : p.first_name[0]}
              </div>
              <div className="lb-info">
                <span className="lb-name">{p.first_name}</span>
              </div>
              <div className="lb-right">
                <span className={`lb-pnl ${isPos ? 'positive' : 'negative'}`}>
                  {formatCurrency(p.balance, currency, rates, { sign: '+' })}
                </span>
                <span className="lb-wr">{wr}% WR</span>
              </div>
            </div>
          )
        })}
      </div>

      {/* My position card (если не в топе) */}
      {!userInTop && user && (
        <div className="lb-my-position">
          <div className="lb-my-position-divider">
            <span className="lb-my-position-label">{t.myPosition}</span>
          </div>
          <div className="lb-row lb-row--mine lb-row--my-card">
            <div className="lb-rank-wrap">
              <span className="lb-rank-num lb-rank-approx">{approxRank(rank ?? 999)}</span>
            </div>
            {photoUrl
              ? <img className="lb-avatar" src={photoUrl} alt="" style={{ objectFit: 'cover' }} />
              : <div className="lb-avatar">{user.first_name?.[0] ?? '?'}</div>
            }
            <div className="lb-info">
              <span className="lb-name">{user.first_name ?? '—'}</span>
            </div>
            <div className="lb-right">
              <span className={`lb-pnl ${myPnlPositive ? 'positive' : 'negative'}`}>
                {formatCurrency(myPnl, currency, rates, { sign: '+' })}
              </span>
              <span className="lb-wr">{myWr}% WR</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
