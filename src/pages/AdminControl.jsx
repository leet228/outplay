import { useState, useEffect, useCallback } from 'react'
import { getAppSettings, updateAppSetting, getRecentCryptoDeposits } from '../lib/supabase'
import useGameStore from '../store/useGameStore'
import { haptic } from '../lib/telegram'

const TOGGLES = [
  { key: 'stars_deposits',  icon: '\u2B50', label: '\u041F\u043E\u043F\u043E\u043B\u043D\u0435\u043D\u0438\u0435 \u0437\u0432\u0451\u0437\u0434\u0430\u043C\u0438' },
  { key: 'crypto_deposits', icon: '\uD83D\uDC8E', label: '\u041F\u043E\u043F\u043E\u043B\u043D\u0435\u043D\u0438\u0435 \u043A\u0440\u0438\u043F\u0442\u043E\u0439' },
  { key: 'withdrawals',     icon: '\uD83D\uDCB8', label: '\u0412\u044B\u0432\u043E\u0434\u044B' },
  { key: 'game_creation',   icon: '\uD83C\uDFAE', label: '\u0421\u043E\u0437\u0434\u0430\u043D\u0438\u0435 \u0438\u0433\u0440' },
  { key: 'subscriptions',   icon: '\uD83D\uDC51', label: '\u041F\u043E\u0434\u043F\u0438\u0441\u043A\u0438' },
]

function timeAgo(dateStr) {
  if (!dateStr) return 'never'
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function getStatusColor(lastDepositTime) {
  if (!lastDepositTime) return '#ef4444'
  const diff = Date.now() - new Date(lastDepositTime).getTime()
  const mins = diff / 60000
  if (mins < 10) return '#22c55e'
  if (mins < 60) return '#eab308'
  return '#ef4444'
}

function formatTime(dateStr) {
  if (!dateStr) return '—'
  return new Date(dateStr).toLocaleTimeString('ru-RU', {
    hour: '2-digit', minute: '2-digit',
  })
}

function truncId(id) {
  if (!id) return '—'
  const s = String(id)
  return s.length > 10 ? s.slice(0, 6) + '...' : s
}

export default function AdminControl() {
  const [settings, setSettings] = useState(null)
  const [loading, setLoading] = useState(true)
  const [deposits, setDeposits] = useState([])
  const [updating, setUpdating] = useState({})
  const setAppSettings = useGameStore(s => s.setAppSettings)

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [settingsData, depositsData] = await Promise.all([
        getAppSettings(),
        getRecentCryptoDeposits(5),
      ])
      if (settingsData) {
        setSettings(settingsData)
        setAppSettings(settingsData)
      }
      setDeposits(depositsData || [])
    } catch (err) {
      console.error('AdminControl load error:', err)
    } finally {
      setLoading(false)
    }
  }, [setAppSettings])

  useEffect(() => { loadData() }, [loadData])

  const handleToggle = useCallback(async (key) => {
    if (!settings) return
    haptic('light')

    const currentVal = settings[key] ?? true
    const newVal = !currentVal

    // Optimistic update
    setSettings(prev => ({ ...prev, [key]: newVal }))
    setAppSettings({ ...settings, [key]: newVal })
    setUpdating(prev => ({ ...prev, [key]: true }))

    const success = await updateAppSetting(key, newVal)
    if (!success) {
      // Revert on failure
      setSettings(prev => ({ ...prev, [key]: currentVal }))
      setAppSettings({ ...settings, [key]: currentVal })
    }

    setUpdating(prev => ({ ...prev, [key]: false }))
  }, [settings, setAppSettings])

  // Compute deposit stats
  const today = new Date().toISOString().split('T')[0]
  const depositsToday = deposits.filter(d => d.created_at?.startsWith(today)).length
  const lastDepositTime = deposits[0]?.created_at || null
  const statusColor = getStatusColor(lastDepositTime)

  return (
    <div className="admin-control">
      {/* Feature toggles */}
      <div className="admin-toggle-section">
        <h3 className="admin-section-title">Feature Toggles</h3>

        {loading && (
          <div className="admin-toggle-skeleton">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="admin-skeleton-row" />
            ))}
          </div>
        )}

        {settings && !loading && TOGGLES.map(({ key, icon, label }) => (
          <div key={key} className="admin-toggle-row">
            <div className="admin-toggle-label">
              <span className="admin-toggle-icon">{icon}</span>
              <span>{label}</span>
            </div>
            <label className="admin-toggle-switch">
              <input
                type="checkbox"
                checked={settings[key] ?? true}
                onChange={() => handleToggle(key)}
                disabled={updating[key]}
              />
              <span className="admin-toggle-slider" />
            </label>
          </div>
        ))}
      </div>

      {/* Server info */}
      <div className="admin-server-section">
        <h3 className="admin-section-title">
          Crypto Deposits
          <span className="admin-status-dot" style={{ background: statusColor }} />
        </h3>

        <div className="admin-server-card">
          <div className="admin-server-row">
            <span>Status</span>
            <span style={{ color: statusColor, fontWeight: 600 }}>
              {statusColor === '#22c55e' ? 'Active' : statusColor === '#eab308' ? 'Idle' : 'Inactive'}
            </span>
          </div>
          <div className="admin-server-row">
            <span>Last Deposit</span>
            <span>{lastDepositTime ? timeAgo(lastDepositTime) : 'No deposits'}</span>
          </div>
          <div className="admin-server-row">
            <span>Deposits Today</span>
            <span>{depositsToday}</span>
          </div>
        </div>

        {deposits.length > 0 && (
          <div className="admin-deposits-list">
            <h4 className="admin-deposits-title">Recent Deposits</h4>
            {deposits.map((dep, i) => (
              <div key={dep.tx_hash || i} className="admin-deposit-item">
                <div className="admin-deposit-left">
                  <span className="admin-deposit-time">{formatTime(dep.created_at)}</span>
                  <span className="admin-deposit-user">User {truncId(dep.user_id)}</span>
                </div>
                <div className="admin-deposit-right">
                  <span className="admin-deposit-amount">
                    +{dep.stars ?? '?'} {'\u2B50'}
                  </span>
                  <span className="admin-deposit-crypto">
                    {Number(dep.crypto_amt).toFixed(4)} TON
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}

        {deposits.length === 0 && !loading && (
          <div className="admin-deposits-empty">
            No recent crypto deposits
          </div>
        )}
      </div>
    </div>
  )
}
