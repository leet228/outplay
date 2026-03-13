import { useState, useEffect, useRef, useCallback } from 'react'
import useGameStore from '../store/useGameStore'
import { translations } from '../lib/i18n'
import { haptic } from '../lib/telegram'
import { formatCurrency } from '../lib/currency'
import { createGuild, joinGuild, kickFromGuild, editGuild, leaveGuild, searchGuilds as searchGuildsApi, getGuildData } from '../lib/supabase'
import './Guilds.css'

function getTimeLeft(endDate) {
  const end = endDate ? new Date(endDate) : new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1)
  const diff = Math.max(0, end - new Date())
  const days = Math.floor(diff / 86400000)
  const hours = Math.floor((diff % 86400000) / 3600000)
  const minutes = Math.floor((diff % 3600000) / 60000)
  return { days, hours, minutes }
}

const CREATE_COST = 5000
const EDIT_COST = 100

const GUILD_COLORS = ['#6366f1', '#f59e0b', '#ef4444', '#22c55e', '#3b82f6', '#ec4899', '#a855f7', '#14b8a6']

function guildColor(name) {
  return GUILD_COLORS[(name || '').charCodeAt(0) % GUILD_COLORS.length]
}

/* ── Guild Detail Sheet ── */
function GuildDetailSheet({ guild, members, onClose, t, currency, rates, isOwner, isMember, user, onKick, onEdit, onLeave, onJoin }) {
  const open = !!guild
  const [kickTarget, setKickTarget] = useState(null)
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [editAvatar, setEditAvatar] = useState(null)
  const [saving, setSaving] = useState(false)
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

  async function handleSaveEdit() {
    if (saving || !guild) return
    haptic('medium')
    setSaving(true)
    await onEdit(editName || null, editDesc || null, editAvatar || null)
    setSaving(false)
    setEditing(false)
  }

  async function handleKick(memberId) {
    haptic('medium')
    await onKick(memberId)
    setKickTarget(null)
  }

  const color = guild ? guildColor(guild.name) : '#888'
  const canJoin = guild && (guild.member_count ?? 0) < 50
  const tag = guild?.tag || (guild?.name ? guild.name.substring(0, 2).toUpperCase() : '??')

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
                {tag[0]}
              </div>
              <div className="gd-header-info">
                <span className="gd-name">{guild.name}</span>
                <span className="gd-meta">{guild.member_count ?? members.length}/50</span>
              </div>
              <span className={`gd-pnl ${(guild.pnl ?? 0) >= 0 ? 'positive' : 'negative'}`}>
                {formatCurrency(guild.pnl ?? 0, currency, rates, { sign: '+' })}
              </span>
            </div>

            {/* Description */}
            <p className="gd-desc">{guild.description || ''}</p>

            {/* Action buttons */}
            {isOwner && (
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
                      placeholder={guild.description || ''}
                      value={editDesc}
                      onChange={e => setEditDesc(e.target.value)}
                      maxLength={120}
                      rows={2}
                    />
                    <div className="gd-edit-cost">
                      <span className="gd-edit-cost-label">{t.guildsEditCost}</span>
                      <span className="gd-edit-cost-amount">{formatCurrency(EDIT_COST, currency, rates)}</span>
                    </div>
                    <button className="gd-edit-save" onClick={handleSaveEdit} disabled={saving}>
                      {t.guildsEditSave}
                    </button>
                  </div>
                )}
              </>
            )}

            {/* Join button (non-member, not already in a guild) */}
            {!isMember && !isOwner && (
              <>
                {canJoin ? (
                  <button className="gd-join" onClick={() => { haptic('medium'); onJoin?.(guild.id) }}>
                    {t.guildsJoin}
                  </button>
                ) : (
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
                  {(guild.creator_name || '?')[0]}
                </div>
                <span className="gd-creator-name">{guild.creator_name || '—'}</span>
              </div>
            </div>

            {/* Leave button (for members who aren't the creator) */}
            {isMember && !isOwner && (
              <button
                className="gd-leave-btn"
                onClick={() => { haptic('medium'); onLeave() }}
              >
                {t.guildsLeave}
              </button>
            )}

            {/* Members list */}
            <div className="gd-members-header">
              <span className="gd-members-title">{t.guildsPlayerList}</span>
              <span className="gd-members-count">{members.length}</span>
            </div>
            <div className="gd-members">
              {members.map((m, i) => {
                const mc = guildColor(m.first_name || '?')
                const pos = (m.pnl ?? 0) >= 0
                const isKickTarget = kickTarget === m.user_id
                const isMe = m.user_id === user?.id
                return (
                  <div
                    key={m.user_id}
                    className={`gd-member ${isOwner && !isMe ? 'gd-member--owner' : ''}`}
                    onClick={() => {
                      if (!isOwner || isMe) return
                      haptic('light')
                      setKickTarget(isKickTarget ? null : m.user_id)
                    }}
                  >
                    <span className="gd-member-rank">{i + 1}</span>
                    <div className="gd-member-avatar" style={{ background: `${mc}22`, color: mc }}>
                      {(m.first_name || '?')[0]}
                    </div>
                    <div className="gd-member-info">
                      <span className="gd-member-name">{m.first_name}</span>
                      {isOwner && <span className="gd-member-username">@{m.username}</span>}
                    </div>
                    {isKickTarget && !isMe ? (
                      <button
                        className="gd-member-kick"
                        onClick={e => { e.stopPropagation(); handleKick(m.user_id) }}
                      >
                        {t.guildsKick}
                      </button>
                    ) : (
                      <span className={`gd-member-pnl ${pos ? 'positive' : 'negative'}`}>
                        {formatCurrency(m.pnl ?? 0, currency, rates, { sign: '+' })}
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
function CreateGuildSheet({ open, onClose, onCreated, t, currency, rates, balance }) {
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [avatar, setAvatar] = useState(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const fileRef = useRef(null)

  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
      setTimeout(() => { setName(''); setDesc(''); setAvatar(null); setError('') }, 300)
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

  async function handleCreate() {
    if (!canCreate || creating) return
    if (balance < CREATE_COST) {
      haptic('light')
      setError(t.guildsNotEnoughBalance)
      setTimeout(() => setError(''), 2500)
      return
    }
    haptic('medium')
    setCreating(true)
    setError('')
    await onCreated(name.trim(), desc.trim(), avatar)
    setCreating(false)
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
            <span className="guilds-sheet-cost-amount">{formatCurrency(CREATE_COST, currency, rates)}</span>
          </div>
          {error && <div className="guilds-sheet-error">{error}</div>}
          <button
            className={`guilds-sheet-submit ${canCreate && !creating ? '' : 'disabled'}`}
            onClick={handleCreate}
            disabled={!canCreate || creating}
          >
            {t.guildsCreateBtn}
          </button>
        </div>
      </div>
    </>
  )
}

/* ── Find Guild Sheet ── */
function FindGuildSheet({ open, onClose, onJoined, t, currency, rates, topGuilds }) {
  const [query, setQuery] = useState('')
  const [joinTarget, setJoinTarget] = useState(null)
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [joining, setJoining] = useState(false)
  const debounceRef = useRef(null)

  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden'
      setResults(topGuilds)
    } else {
      document.body.style.overflow = ''
      setTimeout(() => { setQuery(''); setJoinTarget(null); setResults([]) }, 300)
    }
    return () => { document.body.style.overflow = '' }
  }, [open, topGuilds])

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

  function handleQueryChange(val) {
    setQuery(val)
    setJoinTarget(null)
    clearTimeout(debounceRef.current)

    const q = val.trim()
    if (q.length === 0) {
      setResults(topGuilds)
      return
    }

    setSearching(true)
    debounceRef.current = setTimeout(async () => {
      const data = await searchGuildsApi(q)
      setResults(data)
      setSearching(false)
    }, 300)
  }

  async function handleJoin(guildId) {
    if (joining) return
    haptic('medium')
    setJoining(true)
    await onJoined(guildId)
    setJoining(false)
  }

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
            onChange={e => handleQueryChange(e.target.value)}
            autoFocus
          />
        </div>

        <div className="gf-results">
          {results.length === 0 && !searching && (
            <div className="gf-empty">{t.guildsFindEmpty}</div>
          )}
          {results.map((g, idx) => {
            const color = guildColor(g.name)
            const rank = idx + 1
            const isPositive = (g.pnl ?? 0) >= 0
            const isJoinTarget = joinTarget === g.id
            const canJoin = (g.member_count ?? 0) < (g.max_members ?? 50)
            const tag = g.tag || (g.name ? g.name.substring(0, 2).toUpperCase() : '??')
            return (
              <div
                key={g.id}
                className={`gf-row ${isJoinTarget ? 'gf-row--active' : ''}`}
                onClick={() => { haptic('light'); setJoinTarget(isJoinTarget ? null : g.id) }}
              >
                <span className="gf-rank">{rank}</span>
                <div className="guild-avatar" style={{ background: `${color}22`, color }}>
                  {tag[0]}
                </div>
                <div className="guild-info">
                  <span className="guild-name">{g.name}</span>
                  <span className="guild-members">{g.member_count ?? 0}/50</span>
                </div>
                {isJoinTarget && canJoin ? (
                  <button
                    className="gf-join-btn"
                    onClick={e => { e.stopPropagation(); handleJoin(g.id) }}
                    disabled={joining}
                  >
                    {t.guildsJoin}
                  </button>
                ) : isJoinTarget && !canJoin ? (
                  <span className="gf-full-label">{t.guildsFull}</span>
                ) : (
                  <span className={`guild-pnl ${isPositive ? 'positive' : 'negative'}`}>
                    {formatCurrency(g.pnl ?? 0, currency, rates, { sign: '+' })}
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
  const {
    lang, currency, rates, user, balance,
    guild, guildMembers, topGuilds, guildSeason,
    setGuild, setGuildMembers, setTopGuilds, setGuildSeason, setBalance,
  } = useGameStore()
  const t = translations[lang]
  const [time, setTime] = useState(() => getTimeLeft(guildSeason?.end_date))
  const prizeRef = useRef(null)
  const [prizeVisible, setPrizeVisible] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const [selectedGuild, setSelectedGuild] = useState(null)
  const [toastVisible, setToastVisible] = useState(false)
  const [toastMsg, setToastMsg] = useState('')
  const [howOpen, setHowOpen] = useState(false)

  const closeCreate = useCallback(() => setCreateOpen(false), [])
  const closeFind = useCallback(() => setFindOpen(false), [])
  const closeDetail = useCallback(() => setSelectedGuild(null), [])

  useEffect(() => {
    const id = setInterval(() => setTime(getTimeLeft(guildSeason?.end_date)), 60000)
    return () => clearInterval(id)
  }, [guildSeason?.end_date])

  useEffect(() => {
    const el = prizeRef.current
    if (!el) return
    const obs = new IntersectionObserver(([e]) => setPrizeVisible(e.isIntersecting), { threshold: 0.3 })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  function showToast(msg) {
    setToastMsg(msg)
    setToastVisible(true)
    setTimeout(() => setToastVisible(false), 2000)
  }

  // Refresh guild data from server
  async function refreshGuildData() {
    if (!user?.id || user.id === 'dev') return
    const data = await getGuildData(user.id)
    if (data) {
      setGuild(data.my_guild ?? null)
      setGuildMembers(data.my_guild?.members ?? [])
      setTopGuilds(data.top_guilds ?? [])
      setGuildSeason(data.season ?? null)
    }
  }

  function handleCreateClick() {
    haptic('medium')
    if (guild) {
      showToast(t.guildsAlreadyHave)
      return
    }
    setCreateOpen(true)
  }

  async function handleGuildCreated(name, desc, avatarUrl) {
    if (!user?.id || user.id === 'dev') return
    const result = await createGuild(user.id, name, desc, avatarUrl)
    if (result?.error) {
      showToast(result.error === 'insufficient_balance' ? (t.guildsNotEnoughBalance || 'Not enough balance') : result.error)
      return
    }
    // Deduct balance locally
    setBalance(balance - CREATE_COST)
    // Refresh guild data
    await refreshGuildData()
    setCreateOpen(false)
  }

  async function handleJoinFromFind(guildId) {
    if (!user?.id || user.id === 'dev') return
    const result = await joinGuild(user.id, guildId)
    if (result?.error) {
      showToast(result.error)
      return
    }
    await refreshGuildData()
    setFindOpen(false)
  }

  async function handleKickMember(targetId) {
    if (!user?.id || !guild?.id || user.id === 'dev') return
    const result = await kickFromGuild(user.id, targetId, guild.id)
    if (result?.error) { showToast(result.error); return }
    // Remove from local state
    setGuildMembers(guildMembers.filter(m => m.user_id !== targetId))
  }

  async function handleEditGuild(name, desc, avatarUrl) {
    if (!user?.id || !guild?.id || user.id === 'dev') return
    const result = await editGuild(user.id, guild.id, name, desc, avatarUrl)
    if (result?.error) {
      showToast(result.error === 'insufficient_balance' ? (t.guildsNotEnoughBalance || 'Not enough balance') : result.error)
      return
    }
    setBalance(balance - EDIT_COST)
    await refreshGuildData()
  }

  async function handleJoinFromDetail(guildId) {
    if (!user?.id || user.id === 'dev') return
    if (hasGuild) {
      showToast(t.guildsAlreadyHave)
      return
    }
    const result = await joinGuild(user.id, guildId)
    if (result?.error) { showToast(result.error); return }
    await refreshGuildData()
    setSelectedGuild(null)
  }

  async function handleLeaveGuild() {
    if (!user?.id || user.id === 'dev') return
    const result = await leaveGuild(user.id)
    if (result?.error) { showToast(result.error); return }
    setGuild(null)
    setGuildMembers([])
    setSelectedGuild(null)
  }

  const hasGuild = guild !== null
  const myGuildRank = guild?.rank ?? 999
  const myGuildInTop5 = hasGuild && myGuildRank <= 5
  const myGuildColor = hasGuild ? guildColor(guild.name) : '#888'
  const myGuildPnl = guild?.pnl ?? 0
  const myGuildPositive = myGuildPnl >= 0
  const prizePool = guildSeason?.prize_pool ?? 0
  const myGuildTag = guild?.tag || (guild?.name ? guild.name.substring(0, 2).toUpperCase() : '??')

  // When user taps own guild in the leaderboard list, show detail with their own data
  const isDetailOwner = selectedGuild && hasGuild && selectedGuild.id === guild.id
  const isDetailMember = hasGuild && selectedGuild?.id === guild?.id
  const detailMembers = isDetailOwner ? guildMembers : (selectedGuild?.members ?? [])

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
          {formatCurrency(prizePool, currency, rates)}
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
      {hasGuild && !myGuildInTop5 && (
        <div className="my-guild-card" onClick={() => { haptic('light'); setSelectedGuild(guild) }}>
          <div className="my-guild-label">{t.guildsMyGuild}</div>
          <div className="my-guild-row">
            <span className="my-guild-rank">{myGuildRank}</span>
            <div className="guild-avatar" style={{ background: `${myGuildColor}22`, color: myGuildColor }}>
              {myGuildTag[0]}
            </div>
            <div className="guild-info">
              <span className="guild-name">{guild.name}</span>
              <span className="guild-members">{guild.member_count ?? guildMembers.length}/50</span>
            </div>
            <span className={`guild-pnl ${myGuildPositive ? 'positive' : 'negative'}`}>
              {formatCurrency(myGuildPnl, currency, rates, { sign: '+' })}
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
          {topGuilds.slice(0, 5).map((g, i) => {
            const color = guildColor(g.name)
            const isPositive = (g.pnl ?? 0) >= 0
            const tag = g.tag || (g.name ? g.name.substring(0, 2).toUpperCase() : '??')
            const isMyGuild = hasGuild && g.id === guild.id
            return (
              <div
                key={g.id}
                className={`guild-row ${isMyGuild ? 'guild-row--mine' : ''}`}
                onClick={() => { haptic('light'); setSelectedGuild(isMyGuild ? guild : g) }}
              >
                <span className="guild-rank">{i + 1}</span>
                <div className="guild-avatar" style={{ background: `${color}22`, color }}>
                  {tag[0]}
                </div>
                <div className="guild-info">
                  <span className="guild-name">{g.name}</span>
                  <span className="guild-members">{g.member_count ?? 0}/50</span>
                </div>
                <span className={`guild-pnl ${isPositive ? 'positive' : 'negative'}`}>
                  {formatCurrency(g.pnl ?? 0, currency, rates, { sign: '+' })}
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
        {toastMsg}
      </div>

      {/* Sheets */}
      <CreateGuildSheet open={createOpen} onClose={closeCreate} onCreated={handleGuildCreated} t={t} currency={currency} rates={rates} balance={balance} />
      <FindGuildSheet open={findOpen} onClose={closeFind} onJoined={handleJoinFromFind} t={t} currency={currency} rates={rates} topGuilds={topGuilds} />
      <GuildDetailSheet
        guild={selectedGuild}
        members={detailMembers}
        onClose={closeDetail}
        t={t}
        currency={currency}
        rates={rates}
        isOwner={isDetailOwner}
        isMember={isDetailMember}
        user={user}
        onKick={handleKickMember}
        onEdit={handleEditGuild}
        onLeave={handleLeaveGuild}
        onJoin={handleJoinFromDetail}
      />

    </div>
  )
}
