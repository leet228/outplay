import { useState, useEffect, useCallback } from 'react'
import { getAppSettings, updateAppSetting, getRecentCryptoDeposits, getAdminServerInfo } from '../lib/supabase'
import useGameStore from '../store/useGameStore'
import { haptic } from '../lib/telegram'

const TOGGLES = [
  { key: 'stars_deposits',  icon: '⭐', label: 'Пополнение звёздами' },
  { key: 'crypto_deposits', icon: '💎', label: 'Пополнение криптой' },
  { key: 'withdrawals',     icon: '💸', label: 'Выводы' },
  { key: 'game_creation',   icon: '🎮', label: 'Создание игр' },
  { key: 'subscriptions',   icon: '👑', label: 'Подписки' },
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

function formatDateTime(dateStr) {
  if (!dateStr) return '—'
  return new Date(dateStr).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

function truncId(id) {
  if (!id) return '—'
  const s = String(id)
  return s.length > 10 ? s.slice(0, 6) + '...' : s
}

function formatUptime(seconds) {
  if (!seconds) return '—'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function getEdgeStatusColor(lastCall) {
  if (!lastCall) return '#ef4444'
  const diff = Date.now() - new Date(lastCall).getTime()
  const hours = diff / 3600000
  if (hours < 1) return '#22c55e'
  if (hours < 24) return '#eab308'
  return '#ef4444'
}

function getLogLevelColor(level) {
  if (level === 'error') return '#ef4444'
  if (level === 'warn') return '#eab308'
  return '#3b82f6'
}

const APP_VERSION = '0.1.0'

export default function AdminControl() {
  const [settings, setSettings] = useState(null)
  const [loading, setLoading] = useState(true)
  const [deposits, setDeposits] = useState([])
  const [updating, setUpdating] = useState({})
  const [serverInfo, setServerInfo] = useState(null)
  const [serverLoading, setServerLoading] = useState(true)
  const [expandedSection, setExpandedSection] = useState({})
  const setAppSettings = useGameStore(s => s.setAppSettings)

  const toggleSection = (key) => {
    haptic('light')
    setExpandedSection(prev => ({ ...prev, [key]: !prev[key] }))
  }

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

  const loadServerInfo = useCallback(async () => {
    setServerLoading(true)
    const start = performance.now()
    try {
      const data = await getAdminServerInfo()
      const latency = Math.round(performance.now() - start)
      if (data) {
        setServerInfo({ ...data, latency })
      }
    } catch (err) {
      console.error('Server info error:', err)
    } finally {
      setServerLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData()
    loadServerInfo()
  }, [loadData, loadServerInfo])

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

  const tc = serverInfo?.table_counts || {}
  const db = serverInfo?.db_stats || {}
  const logs = serverInfo?.recent_logs || []
  const rpcStats = serverInfo?.rpc_stats || []
  const edgeStats = serverInfo?.edge_stats || {}
  const errorLogs = logs.filter(l => l.level === 'error')
  const warnLogs = logs.filter(l => l.level === 'warn')

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

      {/* Crypto Deposits */}
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
                    +{dep.stars ?? '?'} {'⭐'}
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

      {/* ═══ SERVER & DB INFO ═══ */}

      {/* 1. Supabase Connection */}
      <div className="admin-server-section">
        <h3 className="admin-section-title">
          Supabase Connection
          <span className="admin-status-dot" style={{ background: serverInfo ? '#22c55e' : serverLoading ? '#eab308' : '#ef4444' }} />
        </h3>

        <div className="admin-server-card">
          <div className="admin-server-row">
            <span>Status</span>
            <span style={{ color: serverInfo ? '#22c55e' : '#ef4444', fontWeight: 600 }}>
              {serverInfo ? 'Connected' : serverLoading ? 'Connecting...' : 'Error'}
            </span>
          </div>
          <div className="admin-server-row">
            <span>Latency</span>
            <span style={{ color: serverInfo?.latency < 300 ? '#22c55e' : serverInfo?.latency < 1000 ? '#eab308' : '#ef4444', fontWeight: 600 }}>
              {serverInfo?.latency ? `${serverInfo.latency}ms` : '—'}
            </span>
          </div>
          <div className="admin-server-row">
            <span>DB Size</span>
            <span>{serverInfo?.db_size || '—'}</span>
          </div>
          <div className="admin-server-row">
            <span>Connections</span>
            <span>{db.active_connections ?? '—'} active / {db.total_connections ?? '—'} total</span>
          </div>
          <div className="admin-server-row">
            <span>Uptime</span>
            <span>{formatUptime(serverInfo?.uptime_seconds)}</span>
          </div>
        </div>

        {serverInfo?.pg_version && (
          <div className="admin-info-mono">
            {serverInfo.pg_version.split(',')[0]}
          </div>
        )}
      </div>

      {/* 2. Database Stats */}
      <div className="admin-server-section">
        <h3 className="admin-section-title" onClick={() => toggleSection('db')} style={{ cursor: 'pointer' }}>
          Database Tables
          <svg className={`admin-chevron ${expandedSection.db ? 'open' : ''}`} width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </h3>

        <div className="admin-db-grid">
          {[
            { key: 'users', icon: '👤', label: 'Users' },
            { key: 'duels', icon: '⚔️', label: 'Duels' },
            { key: 'questions', icon: '❓', label: 'Questions' },
            { key: 'guilds', icon: '🏰', label: 'Guilds' },
            { key: 'transactions', icon: '💰', label: 'Transactions' },
            { key: 'friends', icon: '🤝', label: 'Friends' },
          ].map(({ key, icon, label }) => (
            <div key={key} className="admin-db-card">
              <span className="admin-db-icon">{icon}</span>
              <span className="admin-db-count">{tc[key] ?? '—'}</span>
              <span className="admin-db-label">{label}</span>
            </div>
          ))}
        </div>

        {expandedSection.db && (
          <div className="admin-server-card" style={{ marginTop: 10 }}>
            {[
              ['guild_members', 'Guild Members'],
              ['friend_requests', 'Friend Requests'],
              ['referrals', 'Referrals'],
              ['subscriptions', 'Subscriptions'],
              ['crypto_processed_txs', 'Crypto Txs'],
            ].map(([key, label]) => (
              <div key={key} className="admin-server-row">
                <span>{label}</span>
                <span>{tc[key] ?? '—'}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 3. Error Log */}
      <div className="admin-server-section">
        <h3 className="admin-section-title">
          Error Log
          {errorLogs.length > 0 && (
            <span className="admin-error-badge">{errorLogs.length}</span>
          )}
          {warnLogs.length > 0 && (
            <span className="admin-warn-badge">{warnLogs.length}</span>
          )}
        </h3>

        {logs.length === 0 && !serverLoading && (
          <div className="admin-log-empty">
            <span className="admin-log-empty-icon">✅</span>
            <span>No errors or warnings</span>
          </div>
        )}

        {logs.length > 0 && (
          <div className="admin-log-list">
            {logs.slice(0, expandedSection.logs ? 30 : 5).map((log) => (
              <div key={log.id} className={`admin-log-item admin-log-item--${log.level}`}>
                <div className="admin-log-header">
                  <span className="admin-log-level" style={{ color: getLogLevelColor(log.level) }}>
                    {log.level.toUpperCase()}
                  </span>
                  <span className="admin-log-source">{log.source}</span>
                  <span className="admin-log-time">{timeAgo(log.created_at)}</span>
                </div>
                <div className="admin-log-message">{log.message}</div>
                {log.details && Object.keys(log.details).length > 0 && (
                  <div className="admin-log-details">{JSON.stringify(log.details)}</div>
                )}
              </div>
            ))}
            {logs.length > 5 && !expandedSection.logs && (
              <button className="admin-log-more" onClick={() => toggleSection('logs')}>
                Show all ({logs.length})
              </button>
            )}
          </div>
        )}
      </div>

      {/* 4. Edge Functions */}
      <div className="admin-server-section">
        <h3 className="admin-section-title">Edge Functions</h3>

        <div className="admin-server-card">
          {[
            { key: 'create_stars_invoice', label: 'create-stars-invoice', icon: '⭐' },
            { key: 'check_crypto_deposits', label: 'check-crypto-deposits', icon: '💎' },
            { key: 'telegram_webhook', label: 'telegram-webhook', icon: '🤖' },
          ].map(({ key, label, icon }) => {
            const stat = edgeStats[key] || {}
            const color = getEdgeStatusColor(stat.last_call)
            return (
              <div key={key} className="admin-edge-row">
                <div className="admin-edge-left">
                  <span className="admin-status-dot" style={{ background: color }} />
                  <span className="admin-edge-icon">{icon}</span>
                  <span className="admin-edge-name">{label}</span>
                </div>
                <div className="admin-edge-right">
                  <span className="admin-edge-calls">{stat.calls_today ?? 0} today</span>
                  <span className="admin-edge-last">{stat.last_call ? timeAgo(stat.last_call) : 'never'}</span>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* 5. RPC Functions */}
      <div className="admin-server-section">
        <h3 className="admin-section-title" onClick={() => toggleSection('rpc')} style={{ cursor: 'pointer' }}>
          RPC Functions ({rpcStats.length})
          <svg className={`admin-chevron ${expandedSection.rpc ? 'open' : ''}`} width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </h3>

        {(expandedSection.rpc ? rpcStats : rpcStats.slice(0, 5)).map((fn) => (
          <div key={fn.name} className="admin-rpc-row">
            <div className="admin-rpc-name">{fn.name}</div>
            <div className="admin-rpc-stats">
              <span className="admin-rpc-calls">{fn.calls} calls</span>
              <span className="admin-rpc-avg">{fn.avg_ms}ms avg</span>
            </div>
          </div>
        ))}

        {rpcStats.length > 5 && !expandedSection.rpc && (
          <button className="admin-log-more" onClick={() => toggleSection('rpc')}>
            Show all ({rpcStats.length})
          </button>
        )}

        {rpcStats.length === 0 && !serverLoading && (
          <div className="admin-deposits-empty">
            No RPC stats available (enable pg_stat_statements)
          </div>
        )}
      </div>

      {/* 6. System Info */}
      <div className="admin-server-section">
        <h3 className="admin-section-title">System Info</h3>

        <div className="admin-server-card">
          <div className="admin-server-row">
            <span>App Version</span>
            <span className="admin-version-badge">v{APP_VERSION}</span>
          </div>
          <div className="admin-server-row">
            <span>Stack</span>
            <span>React + Vite + Supabase</span>
          </div>
          <div className="admin-server-row">
            <span>Deploy</span>
            <span>Vercel</span>
          </div>
          <div className="admin-server-row">
            <span>Edge Runtime</span>
            <span>Supabase Deno</span>
          </div>
          <div className="admin-server-row">
            <span>DB Uptime</span>
            <span>{formatUptime(serverInfo?.uptime_seconds)}</span>
          </div>
        </div>
      </div>

      {/* Refresh button */}
      <button className="admin-refresh-all" onClick={() => { haptic('medium'); loadServerInfo() }} disabled={serverLoading}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className={serverLoading ? 'spinning' : ''}>
          <path d="M1 4v6h6M23 20v-6h-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        {serverLoading ? 'Loading...' : 'Refresh Server Info'}
      </button>
    </div>
  )
}
