import { useLocation, useNavigate } from 'react-router-dom'
import { haptic } from '../lib/telegram'
import './BottomNav.css'

const TABS = [
  {
    path: '/',
    icon: (active) => (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
        <path d="M3 12L12 3L21 12V21H15V15H9V21H3V12Z"
          fill={active ? 'var(--accent)' : 'none'}
          stroke={active ? 'var(--accent)' : 'var(--text-muted)'}
          strokeWidth="2" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    path: '/leaderboard',
    icon: (active) => (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
        <rect x="2" y="14" width="5" height="8" rx="1"
          fill={active ? 'var(--accent)' : 'none'}
          stroke={active ? 'var(--accent)' : 'var(--text-muted)'}
          strokeWidth="2" />
        <rect x="9.5" y="8" width="5" height="14" rx="1"
          fill={active ? 'var(--accent)' : 'none'}
          stroke={active ? 'var(--accent)' : 'var(--text-muted)'}
          strokeWidth="2" />
        <rect x="17" y="2" width="5" height="20" rx="1"
          fill={active ? 'var(--accent)' : 'none'}
          stroke={active ? 'var(--accent)' : 'var(--text-muted)'}
          strokeWidth="2" />
      </svg>
    ),
  },
  {
    path: '/guilds',
    icon: (active) => (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
        <circle cx="9" cy="7" r="3"
          fill={active ? 'var(--accent)' : 'none'}
          stroke={active ? 'var(--accent)' : 'var(--text-muted)'}
          strokeWidth="2" />
        <path d="M3 20C3 17.239 5.686 15 9 15C12.314 15 15 17.239 15 20"
          stroke={active ? 'var(--accent)' : 'var(--text-muted)'}
          strokeWidth="2" strokeLinecap="round" />
        <circle cx="17" cy="7" r="2.5"
          fill={active ? 'var(--accent)' : 'none'}
          stroke={active ? 'var(--accent)' : 'var(--text-muted)'}
          strokeWidth="2" />
        <path d="M15.5 15.2C16 15.07 16.49 15 17 15C19.761 15 22 16.79 22 19"
          stroke={active ? 'var(--accent)' : 'var(--text-muted)'}
          strokeWidth="2" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    path: '/shop',
    icon: (active) => (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
        <path d="M6 2L3 6V20C3 21.1 3.9 22 5 22H19C20.1 22 21 21.1 21 20V6L18 2H6Z"
          fill={active ? 'var(--accent)' : 'none'}
          stroke={active ? 'var(--accent)' : 'var(--text-muted)'}
          strokeWidth="2" strokeLinejoin="round" />
        <path d="M3 6H21" stroke={active ? 'var(--accent)' : 'var(--text-muted)'} strokeWidth="2" strokeLinecap="round" />
        <path d="M16 10C16 12.209 14.209 14 12 14C9.791 14 8 12.209 8 10"
          stroke={active ? 'var(--accent)' : 'var(--text-muted)'} strokeWidth="2" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    path: '/profile',
    icon: (active) => (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="8" r="4"
          fill={active ? 'var(--accent)' : 'none'}
          stroke={active ? 'var(--accent)' : 'var(--text-muted)'}
          strokeWidth="2" />
        <path d="M4 20C4 16.686 7.582 14 12 14C16.418 14 20 16.686 20 20"
          stroke={active ? 'var(--accent)' : 'var(--text-muted)'}
          strokeWidth="2" strokeLinecap="round" />
      </svg>
    ),
  },
]

export default function BottomNav() {
  const { pathname } = useLocation()
  const navigate = useNavigate()

  function go(path) {
    if (pathname === path) return
    haptic('light')
    navigate(path)
  }

  return (
    <nav className="bottom-nav">
      {TABS.map(({ path, icon }) => {
        const active = pathname === path
        return (
          <button key={path} className="nav-item" onClick={() => go(path)}>
            <div className={`nav-icon-box ${active ? 'active' : ''}`}>
              {icon(active)}
            </div>
          </button>
        )
      })}
    </nav>
  )
}
