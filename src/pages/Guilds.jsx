import { useState, useEffect, useRef, useCallback } from 'react'
import useGameStore from '../store/useGameStore'
import { translations } from '../lib/i18n'
import { haptic } from '../lib/telegram'
import './Guilds.css'

function getTimeLeft() {
  const now = new Date()
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1)
  const diff = end - now
  const days = Math.floor(diff / 86400000)
  const hours = Math.floor((diff % 86400000) / 3600000)
  const minutes = Math.floor((diff % 3600000) / 60000)
  return { days, hours, minutes }
}

const MOCK_PRIZE = 50000
const CREATE_COST = 5000
const EDIT_COST = 100

const GUILD_COLORS = ['#6366f1', '#f59e0b', '#ef4444', '#22c55e', '#3b82f6', '#ec4899', '#a855f7', '#14b8a6']

const mockMembers = [
  { id: 1, first_name: 'Александр', username: 'alex_pro', pnl: 18200 },
  { id: 2, first_name: 'Мария',     username: 'masha_q',  pnl: 14500 },
  { id: 3, first_name: 'Дмитрий',   username: 'dima_iq',  pnl: 12800 },
  { id: 4, first_name: 'Кирилл',    username: 'kirill99', pnl: 9400  },
  { id: 5, first_name: 'Анна',      username: 'anna_win', pnl: 7600  },
  { id: 6, first_name: 'Сергей',    username: 'serg_top', pnl: 5200  },
  { id: 7, first_name: 'Оля',       username: 'olya_q',   pnl: 3100  },
  { id: 8, first_name: 'Максим',    username: 'max_iq',   pnl: 1800  },
]

const mockGuilds = [
  { id: 1, name: 'Alpha Wolves',    tag: 'AW',  members: 48, pnl: 128450, desc: 'Сильнейшая гильдия. Только победы.', creator: 'Виктор' },
  { id: 2, name: 'Brain Storm',     tag: 'BS',  members: 50, pnl: 95200,  desc: 'Мозговой штурм каждый день!', creator: 'Настя' },
  { id: 3, name: 'Quiz Kings',      tag: 'QK',  members: 45, pnl: 87100,  desc: 'Короли викторин. Присоединяйся.', creator: 'Артём' },
  { id: 4, name: 'Нейронка',        tag: 'НР',  members: 42, pnl: 63800,  desc: 'Думаем быстрее всех.', creator: 'Лена' },
  { id: 5, name: 'Эрудиты',         tag: 'ЭР',  members: 38, pnl: 51200,  desc: 'Знания — наша сила.', creator: 'Павел' },
  { id: 6, name: 'Mind Breakers',   tag: 'MB',  members: 50, pnl: 44700,  desc: 'Break minds, take wins.', creator: 'Jake' },
  { id: 7, name: 'Топ Квиз',        tag: 'ТК',  members: 31, pnl: 32100,  desc: 'Лучшие квизеры страны.', creator: 'Иван' },
  { id: 8, name: 'IQ Masters',      tag: 'IQ',  members: 27, pnl: 21500,  desc: 'High IQ only.', creator: 'Dev' },
  { id: 9, name: 'Fast Minds',      tag: 'FM',  members: 19, pnl: 14800,  desc: 'Speed is everything.', creator: 'Mike' },
  { id: 10, name: 'Знатоки',        tag: 'ЗН',  members: 12, pnl: 8300,   desc: 'Клуб знатоков.', creator: 'Олег' },
]

const MY_GUILD = mockGuilds[7] // IQ Masters — user is creator
const MY_GUILD_RANK = mockGuilds.findIndex(g => g.id === MY_GUILD.id) + 1

function guildColor(name) {
  return GUILD_COLORS[name.charCodeAt(0) % GUILD_COLORS.length]
}

/* ── Guild Detail Sheet ── */
function GuildDetailSheet({ guild, onClose, t, currency, isOwner }) {
  const open = !!guild
  const [kickTarget, setKickTarget] = useState(null)
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [editAvatar, setEditAvatar] = useState(null)
  const editFileRef = useRef(null)

  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
      setKickTarget(null)
      setEditing(false)
      setEditName('')
      setEditDesc('')
      setEditAvatar(null)
    }
    return () => { document.body.style.overflow = '' }
  }, [open])

  useEffect(() => {
    const tg = window.Telegram?.WebApp
    if (!tg) return
    if (open) {
      tg.BackButton.show()
      tg.BackButton.onClick(onClose)
    } else {
      tg.BackButton.hide()
      tg.BackButton.offClick(onClose)
    }
    return () => tg.BackButton.offClick(onClose)
  }, [open, onClose])

  function handleEditAvatar(e) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => setEditAvatar(ev.target.result)
    reader.readAsDataURL(file)
  }

  const color = guild ? guildColor(guild.name) : '#888'
  const canJoin = guild && guild.members < 50

  return (
    <>
      <div className={`guilds-sheet-overlay ${open ? 'visible' : ''}`} onClick={onClose} />
      <div className={`guilds-sheet ${open ? 'open' : ''}`}>
        <div className="guilds-sheet-handle" />

        {guild && (
          <>
            {/* Guild header */}
            <div className="gd-header">
              <div className="gd-avatar" style={{ background: `${color}22`, color }}>
                {guild.tag[0]}
              </div>
              <div className="gd-header-info">
                <span className="gd-name">{guild.name}</span>
                <span className="gd-meta">{guild.members}/50</span>
              </div>
              <span className={`gd-pnl ${guild.pnl >= 0 ? 'positive' : 'negative'}`}>
                {guild.pnl >= 0 ? '+' : ''}{currency.symbol}{guild.pnl.toLocaleString('ru-RU')}
              </span>
            </div>

            {/* Description */}
            <p className="gd-desc">{guild.desc}</p>

            {/* Action button */}
            {isOwner ? (
              <>
                <button
                  className="gd-edit-btn"
                  onClick={() => { haptic('light'); setEditing(v => !v) }}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                    <path d="M12 15.5A3.5 3.5 0 1 0 12 8.5a3.5 3.5 0 0 0 0 7z" stroke="currentColor" strokeWidth="1.8"/>
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" stroke="currentColor" strokeWidth="1.8"/>
                  </svg>
                  {t.guildsEdit}
                </button>

                {editing && (
                  <div className="gd-edit-form">
                    <button className="gd-edit-avatar-btn" onClick={() => editFileRef.current?.click()}>
                      {editAvatar ? (
                        <img src={editAvatar} alt="" className="gd-edit-avatar-img" />
                      ) : (
                        <div className="gd-edit-avatar-placeholder">
                          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"
                              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                            <circle cx="12" cy="13" r="4" stroke="currentColor" strokeWidth="1.5"/>
                          </svg>
                        </div>
                      )}
                      <input
                        ref={editFileRef}
                        type="file"
                        accept="image/*"
                        style={{ display: 'none' }}
                        onChange={handleEditAvatar}
                      />
                    </button>
                    <input
                      className="guilds-sheet-input gd-edit-name"
                      type="text"
                      placeholder={guild.name}
                      value={editName}
                      onChange={e => setEditName(e.target.value)}
                      maxLength={24}
                    />
                    <textarea
                      className="guilds-sheet-input gd-edit-desc"
                      placeholder={guild.desc}
                      value={editDesc}
                      onChange={e => setEditDesc(e.target.value)}
                      maxLength={120}
                      rows={2}
                    />
                    <div className="gd-edit-cost">
                      <span className="gd-edit-cost-label">{t.guildsEditCost}</span>
                      <span className="gd-edit-cost-amount">{currency.symbol}{EDIT_COST.toLocaleString('ru-RU')}</span>
                    </div>
                    <button className="gd-edit-save" onClick={() => haptic('medium')}>
                      {t.guildsEditSave}
                    </button>
                  </div>
                )}
              </>
            ) : (
              <>
                {canJoin && (
                  <button className="gd-join" onClick={() => haptic('medium')}>
                    {t.guildsJoin}
                  </button>
                )}
                {!canJoin && (
                  <div className="gd-full">{t.guildsFull}</div>
                )}
              </>
            )}

            {/* Creator */}
            <div className="gd-creator">
              <span className="gd-creator-label">
                <svg className="gd-creator-crown" width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path d="M2 20h20V18H2v2zM4 17l2-8 4 4 2-6 2 6 4-4 2 8H4z" fill="#fbbf24"/>
                </svg>
                {t.guildsCreator}
              </span>
              <div className="gd-creator-row">
                <div className="gd-creator-avatar" style={{ background: `${color}22`, color }}>
                  {guild.creator[0]}
                </div>
                <span className="gd-creator-name">{guild.creator}</span>
              </div>
            </div>

            {/* Members list */}
            <div className="gd-members-header">
              <span className="gd-members-title">{t.guildsPlayerList}</span>
              <span className="gd-members-count">{mockMembers.length}</span>
            </div>
            <div className="gd-members">
              {mockMembers.map((m, i) => {
                const mc = guildColor(m.first_name)
                const pos = m.pnl >= 0
                const isKickTarget = kickTarget === m.id
                return (
                  <div
                    key={m.id}
                    className={`gd-member ${isOwner ? 'gd-member--owner' : ''}`}
                    onClick={() => {
                      if (!isOwner) return
                      haptic('light')
                      setKickTarget(isKickTarget ? null : m.id)
                    }}
                  >
                    <span className="gd-member-rank">{i + 1}</span>
                    <div className="gd-member-avatar" style={{ background: `${mc}22`, color: mc }}>
                      {m.first_name[0]}
                    </div>
                    <div className="gd-member-info">
                      <span className="gd-member-name">{m.first_name}</span>
                      {isOwner && <span className="gd-member-username">@{m.username}</span>}
                    </div>
                    {isKickTarget ? (
                      <button
                        className="gd-member-kick"
                        onClick={e => { e.stopPropagation(); haptic('medium') }}
                      >
                        {t.guildsKick}
                      </button>
                    ) : (
                      <span className={`gd-member-pnl ${pos ? 'positive' : 'negative'}`}>
                        {pos ? '+' : ''}{currency.symbol}{m.pnl.toLocaleString('ru-RU')}
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>
    </>
  )
}

/* ── Create Guild Sheet ── */
function CreateGuildSheet({ open, onClose, t, currency }) {
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [avatar, setAvatar] = useState(null)
  const fileRef = useRef(null)

  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
      setTimeout(() => { setName(''); setDesc(''); setAvatar(null) }, 300)
    }
    return () => { document.body.style.overflow = '' }
  }, [open])

  useEffect(() => {
    const tg = window.Telegram?.WebApp
    if (!tg) return
    if (open) {
      tg.BackButton.show()
      tg.BackButton.onClick(onClose)
    } else {
      tg.BackButton.hide()
      tg.BackButton.offClick(onClose)
    }
    return () => tg.BackButton.offClick(onClose)
  }, [open, onClose])

  function handleAvatar(e) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => setAvatar(ev.target.result)
    reader.readAsDataURL(file)
  }

  const canCreate = name.trim().length >= 2

  return (
    <>
      <div className={`guilds-sheet-overlay ${open ? 'visible' : ''}`} onClick={onClose} />
      <div className={`guilds-sheet ${open ? 'open' : ''}`}>
        <div className="guilds-sheet-handle" />

        <h2 className="guilds-sheet-title">{t.guildsCreateTitle}</h2>

        {/* Avatar upload */}
        <button className="guilds-sheet-avatar" onClick={() => fileRef.current?.click()}>
          {avatar ? (
            <img src={avatar} alt="" className="guilds-sheet-avatar-img" />
          ) : (
            <div className="guilds-sheet-avatar-placeholder">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"
                  stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                <circle cx="12" cy="13" r="4" stroke="currentColor" strokeWidth="1.5"/>
              </svg>
            </div>
          )}
          <span className="guilds-sheet-avatar-label">{t.guildsAvatar}</span>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={handleAvatar}
          />
        </button>

        {/* Name input */}
        <div className="guilds-sheet-field">
          <label className="guilds-sheet-field-label">{t.guildsName}</label>
          <input
            className="guilds-sheet-input"
            type="text"
            placeholder={t.guildsNamePlaceholder}
            value={name}
            onChange={e => setName(e.target.value)}
            maxLength={24}
          />
        </div>

        {/* Description input */}
        <div className="guilds-sheet-field">
          <label className="guilds-sheet-field-label">{t.guildsDesc}</label>
          <textarea
            className="guilds-sheet-input guilds-sheet-textarea"
            placeholder={t.guildsDescPlaceholder}
            value={desc}
            onChange={e => setDesc(e.target.value)}
            maxLength={120}
            rows={3}
          />
        </div>

        {/* Cost + Create button */}
        <div className="guilds-sheet-footer">
          <div className="guilds-sheet-cost">
            <span className="guilds-sheet-cost-label">{t.guildsCost}</span>
            <span className="guilds-sheet-cost-amount">{currency.symbol}{CREATE_COST.toLocaleString('ru-RU')}</span>
          </div>
          <button
            className={`guilds-sheet-submit ${canCreate ? '' : 'disabled'}`}
            onClick={() => { if (canCreate) haptic('medium') }}
            disabled={!canCreate}
          >
            {t.guildsCreateBtn}
          </button>
        </div>
      </div>
    </>
  )
}

/* ── Find Guild Sheet ── */
function FindGuildSheet({ open, onClose, t, currency }) {
  const [query, setQuery] = useState('')
  const [joinTarget, setJoinTarget] = useState(null)

  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
      setTimeout(() => { setQuery(''); setJoinTarget(null) }, 300)
    }
    return () => { document.body.style.overflow = '' }
  }, [open])

  useEffect(() => {
    const tg = window.Telegram?.WebApp
    if (!tg) return
    if (open) {
      tg.BackButton.show()
      tg.BackButton.onClick(onClose)
    } else {
      tg.BackButton.hide()
      tg.BackButton.offClick(onClose)
    }
    return () => tg.BackButton.offClick(onClose)
  }, [open, onClose])

  const q = query.trim().toLowerCase()
  const results = q.length >= 1
    ? mockGuilds.filter(g => g.name.toLowerCase().includes(q))
    : mockGuilds

  return (
    <>
      <div className={`guilds-sheet-overlay ${open ? 'visible' : ''}`} onClick={onClose} />
      <div className={`guilds-sheet ${open ? 'open' : ''}`}>
        <div className="guilds-sheet-handle" />

        <h2 className="guilds-sheet-title">{t.guildsFindTitle}</h2>

        <div className="gf-search">
          <svg className="gf-search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none">
            <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2"/>
            <path d="M16 16l4.5 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          <input
            className="gf-search-input"
            type="text"
            placeholder={t.guildsFindPlaceholder}
            value={query}
            onChange={e => { setQuery(e.target.value); setJoinTarget(null) }}
            autoFocus
          />
        </div>

        <div className="gf-results">
          {results.length === 0 && (
            <div className="gf-empty">{t.guildsFindEmpty}</div>
          )}
          {results.map(g => {
            const color = guildColor(g.name)
            const rank = mockGuilds.indexOf(g) + 1
            const isPositive = g.pnl >= 0
            const isJoinTarget = joinTarget === g.id
            const canJoin = g.members < 50
            return (
              <div
                key={g.id}
                className={`gf-row ${isJoinTarget ? 'gf-row--active' : ''}`}
                onClick={() => { haptic('light'); setJoinTarget(isJoinTarget ? null : g.id) }}
              >
                <span className="gf-rank">{rank}</span>
                <div className="guild-avatar" style={{ background: `${color}22`, color }}>
                  {g.tag[0]}
                </div>
                <div className="guild-info">
                  <span className="guild-name">{g.name}</span>
                  <span className="guild-members">{g.members}/50</span>
                </div>
                {isJoinTarget && canJoin ? (
                  <button
                    className="gf-join-btn"
                    onClick={e => { e.stopPropagation(); haptic('medium') }}
                  >
                    {t.guildsJoin}
                  </button>
                ) : isJoinTarget && !canJoin ? (
                  <span className="gf-full-label">{t.guildsFull}</span>
                ) : (
                  <span className={`guild-pnl ${isPositive ? 'positive' : 'negative'}`}>
                    {isPositive ? '+' : ''}{currency.symbol}{g.pnl.toLocaleString('ru-RU')}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </>
  )
}

/* ── Main Page ── */
export default function Guilds() {
  const { lang, currency } = useGameStore()
  const t = translations[lang]
  const [time, setTime] = useState(getTimeLeft)
  const prizeRef = useRef(null)
  const [prizeVisible, setPrizeVisible] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const [selectedGuild, setSelectedGuild] = useState(null)
  const [toastVisible, setToastVisible] = useState(false)
  const [howOpen, setHowOpen] = useState(false)

  const closeCreate = useCallback(() => setCreateOpen(false), [])
  const closeFind = useCallback(() => setFindOpen(false), [])
  const closeDetail = useCallback(() => setSelectedGuild(null), [])

  useEffect(() => {
    const id = setInterval(() => setTime(getTimeLeft()), 60000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    const el = prizeRef.current
    if (!el) return
    const obs = new IntersectionObserver(([e]) => setPrizeVisible(e.isIntersecting), { threshold: 0.3 })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  function handleCreateClick() {
    haptic('medium')
    if (MY_GUILD) {
      setToastVisible(true)
      setTimeout(() => setToastVisible(false), 2000)
      return
    }
    setCreateOpen(true)
  }

  const myGuildInTop5 = MY_GUILD_RANK <= 5
  const myGuildColor = guildColor(MY_GUILD.name)
  const myGuildPositive = MY_GUILD.pnl >= 0

  return (
    <div className="guilds page">

      {/* Season timer */}
      <div className="guilds-timer">
        <span className="guilds-timer-label">{t.guildsSeasonEnd}</span>
        <div className="guilds-timer-digits">
          <div className="guilds-timer-block">
            <span className="guilds-timer-num">{String(time.days).padStart(2, '0')}</span>
            <span className="guilds-timer-unit">{t.guildsDays}</span>
          </div>
          <span className="guilds-timer-sep">:</span>
          <div className="guilds-timer-block">
            <span className="guilds-timer-num">{String(time.hours).padStart(2, '0')}</span>
            <span className="guilds-timer-unit">{t.guildsHours}</span>
          </div>
          <span className="guilds-timer-sep">:</span>
          <div className="guilds-timer-block">
            <span className="guilds-timer-num">{String(time.minutes).padStart(2, '0')}</span>
            <span className="guilds-timer-unit">{t.guildsMinutes}</span>
          </div>
        </div>
      </div>

      {/* Prize pool */}
      <div className={`guilds-prize ${prizeVisible ? 'guilds-prize--visible' : ''}`} ref={prizeRef}>
        <div className="guilds-prize-glow" />
        <div className="guilds-prize-glow guilds-prize-glow--bottom" />
        <div className="guilds-prize-sparkle guilds-prize-sparkle--1" />
        <div className="guilds-prize-sparkle guilds-prize-sparkle--2" />
        <div className="guilds-prize-sparkle guilds-prize-sparkle--3" />
        <div className="guilds-prize-icon">
          <svg width="44" height="44" viewBox="0 0 24 24" fill="none">
            <path d="M5 3H3L5.5 9H8.5L5 3Z" fill="#FBBF24"/>
            <path d="M19 3H21L18.5 9H15.5L19 3Z" fill="#FBBF24"/>
            <path d="M12 2L14.5 8H9.5L12 2Z" fill="#FDE68A"/>
            <path d="M6 9H18V10C18 14.418 15.314 18 12 18C8.686 18 6 14.418 6 10V9Z" fill="url(#trophy-grad)"/>
            <path d="M9 18H15V21H9V18Z" fill="#D97706"/>
            <path d="M7 21H17V22.5C17 22.776 16.776 23 16.5 23H7.5C7.224 23 7 22.776 7 22.5V21Z" fill="#FBBF24"/>
            <defs>
              <linearGradient id="trophy-grad" x1="12" y1="9" x2="12" y2="18">
                <stop offset="0%" stopColor="#FDE68A"/>
                <stop offset="100%" stopColor="#F59E0B"/>
              </linearGradient>
            </defs>
          </svg>
        </div>
        <span className="guilds-prize-label">{t.guildsPrizePool}</span>
        <span className="guilds-prize-amount">
          {currency.symbol}{MOCK_PRIZE.toLocaleString('ru-RU')}
        </span>
      </div>

      {/* Action buttons */}
      <div className="guilds-actions">
        <button className="guilds-create" onClick={handleCreateClick}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/>
          </svg>
          {t.guildsCreate}
        </button>
        <button className="guilds-find" onClick={() => { haptic('light'); setFindOpen(true) }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2"/>
            <path d="M16 16l4.5 4.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          {t.guildsFind}
        </button>
      </div>

      {/* My guild (if not in top 5) */}
      {!myGuildInTop5 && (
        <div className="my-guild-card" onClick={() => { haptic('light'); setSelectedGuild(MY_GUILD) }}>
          <div className="my-guild-label">{t.guildsMyGuild}</div>
          <div className="my-guild-row">
            <span className="my-guild-rank">{MY_GUILD_RANK}</span>
            <div className="guild-avatar" style={{ background: `${myGuildColor}22`, color: myGuildColor }}>
              {MY_GUILD.tag[0]}
            </div>
            <div className="guild-info">
              <span className="guild-name">{MY_GUILD.name}</span>
              <span className="guild-members">{MY_GUILD.members}/50</span>
            </div>
            <span className={`guild-pnl ${myGuildPositive ? 'positive' : 'negative'}`}>
              {myGuildPositive ? '+' : ''}{currency.symbol}{MY_GUILD.pnl.toLocaleString('ru-RU')}
            </span>
          </div>
        </div>
      )}

      {/* Guild leaderboard */}
      <div className="guilds-list-card">
        <div className="guilds-list-header">
          <span className="guilds-list-title">{t.guildsTop}</span>
        </div>

        <div className="guilds-rows">
          {mockGuilds.slice(0, 5).map((g, i) => {
            const color = guildColor(g.name)
            const isPositive = g.pnl >= 0
            return (
              <div key={g.id} className="guild-row" onClick={() => { haptic('light'); setSelectedGuild(g) }}>
                <span className="guild-rank">{i + 1}</span>
                <div className="guild-avatar" style={{ background: `${color}22`, color }}>
                  {g.tag[0]}
                </div>
                <div className="guild-info">
                  <span className="guild-name">{g.name}</span>
                  <span className="guild-members">{g.members}/50</span>
                </div>
                <span className={`guild-pnl ${isPositive ? 'positive' : 'negative'}`}>
                  {isPositive ? '+' : ''}{currency.symbol}{g.pnl.toLocaleString('ru-RU')}
                </span>
              </div>
            )
          })}
        </div>
      </div>

      {/* How it works */}
      <button className="guilds-how-toggle" onClick={() => { haptic('light'); setHowOpen(v => !v) }}>
        <span>{t.guildsHowTitle}</span>
        <svg className={`guilds-how-chevron ${howOpen ? 'open' : ''}`} width="18" height="18" viewBox="0 0 24 24" fill="none">
          <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>

      {howOpen && (
        <div className="guilds-how">
          <div className="guilds-how-item">
            <div className="guilds-how-icon">🏆</div>
            <div className="guilds-how-content">
              <span className="guilds-how-item-title">{t.guildsHow1Title}</span>
              <p className="guilds-how-item-text">{t.guildsHow1Text}</p>
            </div>
          </div>
          <div className="guilds-how-item">
            <div className="guilds-how-icon">👑</div>
            <div className="guilds-how-content">
              <span className="guilds-how-item-title">{t.guildsHow2Title}</span>
              <p className="guilds-how-item-text">{t.guildsHow2Text}</p>
            </div>
          </div>
          <div className="guilds-how-item">
            <div className="guilds-how-icon">📊</div>
            <div className="guilds-how-content">
              <span className="guilds-how-item-title">{t.guildsHow3Title}</span>
              <p className="guilds-how-item-text">{t.guildsHow3Text}</p>
            </div>
          </div>
          <div className="guilds-how-item">
            <div className="guilds-how-icon">⚔️</div>
            <div className="guilds-how-content">
              <span className="guilds-how-item-title">{t.guildsHow4Title}</span>
              <p className="guilds-how-item-text">{t.guildsHow4Text}</p>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      <div className={`guilds-toast ${toastVisible ? 'visible' : ''}`}>
        {t.guildsAlreadyHave}
      </div>

      {/* Sheets */}
      <CreateGuildSheet open={createOpen} onClose={closeCreate} t={t} currency={currency} />
      <FindGuildSheet open={findOpen} onClose={closeFind} t={t} currency={currency} />
      <GuildDetailSheet
        guild={selectedGuild}
        onClose={closeDetail}
        t={t}
        currency={currency}
        isOwner={selectedGuild?.id === MY_GUILD.id}
      />

    </div>
  )
}
