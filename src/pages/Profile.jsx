import { useState, useEffect, useCallback, useRef } from 'react'
import useGameStore from '../store/useGameStore'
import { haptic } from '../lib/telegram'
import { translations } from '../lib/i18n'
import './Profile.css'

function getRankDisplay(rank) {
  if (rank === 1) return { label: '#1', color: '#F59E0B', bg: '#F59E0B18' }
  if (rank === 2) return { label: '#2', color: '#9CA3AF', bg: '#9CA3AF18' }
  if (rank === 3) return { label: '#3', color: '#CD7F32', bg: '#CD7F3218' }
  if (rank <= 10) return { label: `#${rank}`, color: '#3B82F6', bg: '#3B82F618' }
  if (rank <= 25) return { label: '10+', color: '#8B5CF6', bg: '#8B5CF618' }
  if (rank <= 50) return { label: '25+', color: '#8B5CF6', bg: '#8B5CF618' }
  if (rank <= 100) return { label: '50+', color: '#6B7280', bg: '#6B728018' }
  if (rank <= 250) return { label: '100+', color: '#6B7280', bg: '#6B728018' }
  if (rank <= 500) return { label: '250+', color: '#4B5563', bg: '#4B556318' }
  return { label: '500+', color: '#4B5563', bg: '#4B556318' }
}

// Fill missing days with zeros for chart rendering
function buildChartData(dailyStats, days = 7) {
  const statsMap = new Map()
  for (const s of dailyStats) statsMap.set(s.date, s)
  const result = []
  const today = new Date()
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    const key = d.toISOString().slice(0, 10)
    const label = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`
    const stat = statsMap.get(key)
    result.push({ date: label, pnl: stat?.pnl ?? 0 })
  }
  return result
}

const W = 320
const H = 130

export default function Profile() {
  const { user, balance, currency, setCurrency, lang, setLang, setDepositOpen, rank, dailyStats, totalPnl } = useGameStore()
  const t = translations[lang]
  const photoUrl = window.Telegram?.WebApp?.initDataUnsafe?.user?.photo_url
  const [tooltip, setTooltip] = useState(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [langOpen, setLangOpen] = useState(false)
  const [withdrawError, setWithdrawError] = useState(false)
  const withdrawTimer = useRef(null)

  const MIN_WITHDRAW = 2000
  const canWithdraw = balance >= MIN_WITHDRAW

  function handleWithdraw() {
    haptic('light')
    if (!canWithdraw) {
      clearTimeout(withdrawTimer.current)
      setWithdrawError(true)
      withdrawTimer.current = setTimeout(() => setWithdrawError(false), 2000)
      return
    }
    // TODO: withdrawal flow
  }

  const closeSettings = useCallback(() => {
    haptic('light')
    setSettingsOpen(false)
  }, [])

  // Telegram BackButton
  useEffect(() => {
    const tg = window.Telegram?.WebApp
    if (!tg) return
    if (settingsOpen) {
      tg.BackButton.show()
      tg.BackButton.onClick(closeSettings)
    } else {
      tg.BackButton.hide()
      tg.BackButton.offClick(closeSettings)
    }
    return () => {
      tg.BackButton.offClick(closeSettings)
    }
  }, [settingsOpen, closeSettings])

  function openSettings() {
    haptic('medium')
    setSettingsOpen(true)
  }

  const winrate =
    user?.wins + user?.losses > 0
      ? Math.round((user.wins / (user.wins + user.losses)) * 100)
      : 0

  const chartData = buildChartData(dailyStats, 7)
  const startBalance = balance - totalPnl
  const totalPct = startBalance > 0
    ? ((totalPnl / startBalance) * 100).toFixed(1)
    : '0.0'
  const isPositive = totalPnl >= 0

  const maxAbs = Math.max(...chartData.map(d => Math.abs(d.pnl)), 1)
  const barW = W / chartData.length
  const midY = H / 2

  function handleBarClick(e, i) {
    e.stopPropagation()
    haptic('light')
    setTooltip(prev => (prev?.index === i ? null : { index: i }))
  }

  return (
    <div className="profile page" onClick={() => setTooltip(null)}>
      <div className="profile-header">
        <div className="profile-avatar-row">
          <div className="profile-avatar-wrap">
            {photoUrl
              ? <img className="profile-avatar" src={photoUrl} alt="" />
              : <div className="profile-avatar">{user?.first_name?.[0] ?? '?'}</div>
            }
          </div>
          <button className="settings-btn" onClick={openSettings} aria-label="Настройки">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
          </button>
        </div>
        <div className="profile-name-block">
          <div className="profile-name-row">
            <h2 className="profile-name">{user?.first_name ?? 'Игрок'}</h2>
            {rank != null && (() => {
              const rd = getRankDisplay(rank)
              return (
                <span className="rank-badge" style={{ color: rd.color, background: rd.bg, borderColor: rd.color }}>
                  {rd.label}
                </span>
              )
            })()}
          </div>
          {user?.username && <span className="profile-username">@{user.username}</span>}
        </div>
      </div>

      <div className="balance-card">
        <span className="balance-label">{t.balance}</span>
        <span className="balance-amount">{currency.symbol} {Number(balance).toFixed(2)}</span>
        <div className="balance-actions">
          <button className="balance-btn deposit" onClick={() => { haptic('light'); setDepositOpen(true) }}>
            {t.deposit}
          </button>
          <button
            className={`balance-btn withdraw ${!canWithdraw ? 'withdraw--locked' : ''}`}
            onClick={handleWithdraw}
          >
            {t.withdraw}
          </button>
        </div>
        <div className={`withdraw-error ${withdrawError ? 'visible' : ''}`}>
          {t.withdrawMin.replace('{sym}', currency.symbol)}
        </div>
      </div>

      <div className="stats-grid">
        <div className="stat-card">
          <span className="stat-val">{user?.wins ?? 0}</span>
          <span className="stat-lbl">{t.wins}</span>
        </div>
        <div className="stat-card">
          <span className="stat-val">{user?.losses ?? 0}</span>
          <span className="stat-lbl">{t.losses}</span>
        </div>
        <div className="stat-card">
          <span className="stat-val">{winrate}%</span>
          <span className="stat-lbl">{t.winrate}</span>
        </div>
        <div className="stat-card">
          <span className="stat-val">{(user?.wins ?? 0) + (user?.losses ?? 0)}</span>
          <span className="stat-lbl">{t.games}</span>
        </div>
      </div>

      <div className="pnl-card" onClick={e => e.stopPropagation()}>
        <div className="pnl-header">
          <div className="pnl-numbers">
            <span className={`pnl-amount ${isPositive ? 'positive' : 'negative'}`}>
              {isPositive ? '+' : ''}{currency.symbol}{totalPnl.toFixed(2)}
            </span>
            <span className={`pnl-pct ${isPositive ? 'positive' : 'negative'}`}>
              {isPositive ? '+' : ''}{totalPct}%
            </span>
          </div>
          <span className="pnl-timeframe">{t.allTime}</span>
        </div>

        <div className="pnl-chart-wrap">
          <svg
            width="100%"
            viewBox={`0 0 ${W} ${H}`}
            className="pnl-chart"
            onClick={() => setTooltip(null)}
          >
            <line x1="0" y1={midY} x2={W} y2={midY} stroke="var(--border)" strokeWidth="1" />

            {chartData.map((d, i) => {
              const barH = Math.max((Math.abs(d.pnl) / maxAbs) * (midY - 10), 3)
              const isPos = d.pnl >= 0
              const x = i * barW + barW * 0.22
              const bw = barW * 0.56
              const y = isPos ? midY - barH : midY
              const isActive = tooltip?.index === i

              return (
                <rect
                  key={i}
                  x={x} y={y} width={bw} height={barH}
                  rx="3"
                  fill={isPos ? '#22c55e' : '#ef4444'}
                  opacity={isActive ? 1 : 0.65}
                  onClick={(e) => handleBarClick(e, i)}
                  style={{ cursor: 'pointer' }}
                />
              )
            })}

            {tooltip !== null && (() => {
              const d = chartData[tooltip.index]
              const isPos = d.pnl >= 0
              const barH = Math.max((Math.abs(d.pnl) / maxAbs) * (midY - 10), 3)
              const centerX = tooltip.index * barW + barW * 0.5
              const tooltipW = 96
              const tooltipH = 42
              const tx = Math.min(Math.max(centerX - tooltipW / 2, 2), W - tooltipW - 2)
              const tyRaw = isPos ? midY - barH - tooltipH - 6 : midY + barH + 6
              const ty = Math.min(Math.max(tyRaw, 2), H - tooltipH - 2)

              return (
                <g onClick={e => e.stopPropagation()} style={{ cursor: 'default' }}>
                  <rect
                    x={tx} y={ty}
                    width={tooltipW} height={tooltipH}
                    rx="9"
                    fill="var(--surface2)"
                    stroke="var(--border)"
                    strokeWidth="1"
                  />
                  <text
                    x={tx + tooltipW / 2} y={ty + 16}
                    textAnchor="middle"
                    fontSize="12"
                    fontWeight="700"
                    fill={isPos ? '#22c55e' : '#ef4444'}
                  >
                    {isPos ? '+' : ''}{currency.symbol}{d.pnl.toFixed(2)}
                  </text>
                  <text
                    x={tx + tooltipW / 2} y={ty + 31}
                    textAnchor="middle"
                    fontSize="10"
                    fill="var(--text-muted)"
                  >
                    {d.date}
                  </text>
                </g>
              )
            })()}
          </svg>
        </div>
      </div>

      {/* Settings overlay */}
      <div
        className={`settings-overlay ${settingsOpen ? 'visible' : ''}`}
        onClick={closeSettings}
      />

      {/* Settings panel */}
      <div className={`settings-panel ${settingsOpen ? 'open' : ''}`} onClick={e => e.stopPropagation()}>
        <div className="settings-panel-header">
          <span className="settings-panel-title">{t.settings}</span>
        </div>

        <div className="settings-section">
          <span className="settings-section-label">{t.account}</span>
          <div className="settings-item">
            <span className="settings-item-label">{t.name}</span>
            <span className="settings-item-value">{user?.first_name ?? '—'}</span>
          </div>
          <div className="settings-item">
            <span className="settings-item-label">{t.username}</span>
            <span className="settings-item-value">{user?.username ? `@${user.username}` : '—'}</span>
          </div>
        </div>

        <div className="settings-section">
          <span className="settings-section-label">{t.app}</span>
          <div className="settings-item settings-item--currency">
            <span className="settings-item-label">{t.currency}</span>
            <div className="currency-picker">
              {[
                { symbol: '₽', code: 'RUB' },
                { symbol: '$', code: 'USD' },
                { symbol: '€', code: 'EUR' },
              ].map(c => (
                <button
                  key={c.code}
                  className={`currency-btn ${currency.code === c.code ? 'active' : ''}`}
                  onClick={() => { haptic('light'); setCurrency(c) }}
                >
                  {c.symbol} {c.code}
                </button>
              ))}
            </div>
          </div>

          <div className="settings-item settings-item--lang" onClick={() => { haptic('light'); setLangOpen(o => !o) }}>
            <span className="settings-item-label">{t.language}</span>
            <div className="lang-trigger">
              <span className="settings-item-value">{lang === 'ru' ? t.langRu : t.langEn}</span>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className={`lang-chevron ${langOpen ? 'open' : ''}`}>
                <path d="M6 9l6 6 6-6"/>
              </svg>
            </div>
          </div>
          {langOpen && (
            <div className="lang-dropdown">
              {[{ code: 'ru', label: t.langRu }, { code: 'en', label: t.langEn }].map(l => (
                <button
                  key={l.code}
                  className={`lang-option ${lang === l.code ? 'active' : ''}`}
                  onClick={() => { haptic('light'); setLang(l.code); setLangOpen(false) }}
                >
                  {l.code === 'ru' ? '🇷🇺' : '🇬🇧'} {l.label}
                  {lang === l.code && (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                      <path d="M20 6L9 17l-5-5"/>
                    </svg>
                  )}
                </button>
              ))}
            </div>
          )}

          <div className="settings-item">
            <span className="settings-item-label">{t.notifications}</span>
            <span className="settings-item-value settings-soon">{t.soon}</span>
          </div>
          <div className="settings-item">
            <span className="settings-item-label">{t.version}</span>
            <span className="settings-item-value">0.1.0</span>
          </div>
        </div>

        <div className="settings-actions">
          <button className="settings-action-btn" onClick={() => haptic('light')}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
            {t.support}
          </button>
          <button className="settings-action-btn" onClick={() => haptic('light')}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="8" x2="12" y2="12"/>
              <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            {t.reportBug}
          </button>
        </div>
      </div>
    </div>
  )
}
