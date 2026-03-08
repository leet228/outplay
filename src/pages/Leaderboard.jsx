import useGameStore from '../store/useGameStore'
import { translations } from '../lib/i18n'
import './Leaderboard.css'

const mockLeaders = [
  { id: 1,  first_name: 'Александр', username: 'alex_trade', wins: 24, losses: 6,  pnl: 4850 },
  { id: 2,  first_name: 'Мария',     username: 'masha_win',  wins: 18, losses: 9,  pnl: 2130 },
  { id: 3,  first_name: 'Дмитрий',   username: 'dmitry_x',   wins: 21, losses: 8,  pnl: 1740 },
  { id: 4,  first_name: 'Кирилл',    username: 'kirill_up',  wins: 15, losses: 7,  pnl: 1220 },
  { id: 5,  first_name: 'Анна',      username: 'anna_pro',   wins: 12, losses: 5,  pnl: 980  },
  { id: 6,  first_name: 'Сергей',    username: 'serg_bet',   wins: 10, losses: 6,  pnl: 760  },
  { id: 7,  first_name: 'Оля',       username: 'olya_q',     wins: 9,  losses: 8,  pnl: 530  },
  { id: 8,  first_name: 'Максим',    username: 'max_mm',     wins: 8,  losses: 7,  pnl: 390  },
  { id: 9,  first_name: 'Лера',      username: 'lera_win',   wins: 7,  losses: 9,  pnl: 210  },
  { id: 10, first_name: 'Паша',      username: 'pasha_ok',   wins: 5,  losses: 6,  pnl: 95   },
]

// Заглушка — позиция текущего пользователя вне топа
const mockUserRank = 247

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
  const { user, currency, lang } = useGameStore()
  const t = translations[lang]
  const photoUrl = window.Telegram?.WebApp?.initDataUnsafe?.user?.photo_url

  const sorted = [...mockLeaders].sort((a, b) => b.pnl - a.pnl)
  const userInTop = sorted.some(p => p.id === user?.id)

  return (
    <div className="leaderboard page" style={{ paddingTop: '180px' }}>
      <h2 style={{
        color: '#ffffff',
        fontSize: '22px',
        fontWeight: 800,
        margin: 0,
        textAlign: 'center',
        width: '100%',
        display: 'block',
        lineHeight: '1.3',
        touchAction: 'auto',
      }}>{t.leaderboard}</h2>

      {/* Top 3 podium */}
      <div className="lb-podium">
        {sorted.slice(0, 3).map((p, i) => {
          const isPos = p.pnl >= 0
          const wr = p.wins + p.losses > 0
            ? Math.round((p.wins / (p.wins + p.losses)) * 100)
            : 0
          return (
            <div key={p.id} className={`lb-podium-card lb-podium-card--${i + 1}`}>
              <div className="lb-podium-icon">
                <PodiumRankIcon rank={i + 1} />
              </div>
              <div className="lb-podium-avatar" style={{ borderColor: RANK_COLORS[i] }}>
                {p.first_name[0]}
              </div>
              <span className="lb-podium-name">{p.first_name}</span>
              <span className={`lb-podium-pnl ${isPos ? 'positive' : 'negative'}`}>
                {isPos ? '+' : ''}{currency.symbol}{Math.abs(p.pnl).toLocaleString()}
              </span>
              <span className="lb-podium-wr">{wr}% WR</span>
            </div>
          )
        })}
      </div>

      {/* Full list */}
      <div className="lb-list">
        {sorted.map((p, i) => {
          const isPos = p.pnl >= 0
          const wr = p.wins + p.losses > 0
            ? Math.round((p.wins / (p.wins + p.losses)) * 100)
            : 0
          const isMe = p.id === user?.id
          return (
            <div key={p.id} className={`lb-row ${isMe ? 'lb-row--mine' : ''}`}>
              <div className="lb-rank-wrap">
                <ListRankBadge rank={i + 1} />
              </div>
              <div className="lb-avatar">{p.first_name[0]}</div>
              <div className="lb-info">
                <span className="lb-name">{p.first_name}</span>
                {p.username && <span className="lb-username">@{p.username}</span>}
              </div>
              <div className="lb-right">
                <span className={`lb-pnl ${isPos ? 'positive' : 'negative'}`}>
                  {isPos ? '+' : ''}{currency.symbol}{Math.abs(p.pnl).toLocaleString()}
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
              <span className="lb-rank-num lb-rank-approx">{approxRank(mockUserRank)}</span>
            </div>
            {photoUrl
              ? <img className="lb-avatar" src={photoUrl} alt="" style={{ objectFit: 'cover' }} />
              : <div className="lb-avatar">{user.first_name?.[0] ?? '?'}</div>
            }
            <div className="lb-info">
              <span className="lb-name">{user.first_name ?? '—'}</span>
              {user.username && <span className="lb-username">@{user.username}</span>}
            </div>
            <div className="lb-right">
              <span className="lb-pnl positive">+{currency.symbol}0</span>
              <span className="lb-wr">0% WR</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
