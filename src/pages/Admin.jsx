import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import useGameStore from '../store/useGameStore'
import { haptic } from '../lib/telegram'
import AdminDashboard from './AdminDashboard'
import AdminControl from './AdminControl'
import AdminWallet from './AdminWallet'
import AdminBugReports from './AdminBugReports'
import './Admin.css'

// ── Admin Telegram IDs ──
const ADMIN_IDS = ['dev', 945676433]

const TABS = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 20V10M12 20V4M6 20v-6"/>
      </svg>
    ),
  },
  {
    id: 'control',
    label: 'Control',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/>
        <line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/>
        <line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/>
        <line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/>
        <line x1="17" y1="16" x2="23" y2="16"/>
      </svg>
    ),
  },
  {
    id: 'wallet',
    label: 'Wallet',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/>
        <path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/>
        <path d="M18 12a2 2 0 0 0 0 4h4v-4h-4z"/>
      </svg>
    ),
  },
  {
    id: 'reports',
    label: 'Reports',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
    ),
  },
]

const TAB_TITLES = {
  dashboard: 'Dashboard',
  control: 'Control Panel',
  wallet: 'Wallet Monitor',
  reports: 'Bug Reports',
}

export default function Admin() {
  const navigate = useNavigate()
  const user = useGameStore(s => s.user)
  const [tab, setTab] = useState('dashboard')

  const isAdmin = user && (
    ADMIN_IDS.includes(user.id) ||
    ADMIN_IDS.includes(user.telegram_id) ||
    ADMIN_IDS.includes(Number(user.telegram_id))
  )

  if (!isAdmin) {
    return (
      <div className="admin-page">
        <div className="admin-denied">
          <span className="admin-denied-icon">{'\uD83D\uDEAB'}</span>
          <p>Access Denied</p>
          <button className="admin-btn" onClick={() => navigate('/')}>Go Home</button>
        </div>
      </div>
    )
  }

  return (
    <div className="admin-page">
      {/* Header */}
      <div className="admin-header">
        <button className="admin-back" onClick={() => { haptic('light'); navigate('/') }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18L9 12L15 6" />
          </svg>
        </button>
        <h2>{TAB_TITLES[tab]}</h2>
      </div>

      {/* Content */}
      <div className="admin-content">
        {tab === 'dashboard' && <AdminDashboard />}
        {tab === 'control' && <AdminControl />}
        {tab === 'wallet' && <AdminWallet />}
        {tab === 'reports' && <AdminBugReports />}
      </div>

      {/* Bottom nav */}
      <nav className="admin-nav">
        {TABS.map(t => (
          <button
            key={t.id}
            className={`admin-nav-btn ${tab === t.id ? 'active' : ''}`}
            onClick={() => { haptic('light'); setTab(t.id) }}
          >
            {t.icon}
            <span>{t.label}</span>
          </button>
        ))}
      </nav>
    </div>
  )
}
