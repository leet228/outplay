import React, { useRef, useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import useGameStore from '../store/useGameStore'
import { useShallow } from 'zustand/react/shallow'
import { supabase } from '../lib/supabase'
import { findMatch, cancelMatchmaking, createBotDuel } from '../lib/supabase'
import { haptic } from '../lib/telegram'
import { translations } from '../lib/i18n'
import { formatCurrency } from '../lib/currency'
import { searchUsers as searchUsersApi, sendFriendRequest, acceptFriendRequest, rejectFriendRequest, removeFriend, getFriendsData, sendGameInvite, acceptGameInvite, rejectGameInvite, cancelAllPendingInvites, getPendingInvites } from '../lib/supabase'
import './Home.css'

/* ── Icons ── */
function QuizIcon() {
  return (
    <svg width="52" height="52" viewBox="0 0 24 24" fill="none">
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
      <circle cx="12" cy="17" r="1" fill="currentColor"/>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/>
    </svg>
  )
}

function LightningIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
      <path d="M13 2L4.5 13.5H11L10 22L20.5 10H14L13 2Z" fill="currentColor" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
    </svg>
  )
}

function StarIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" fill="currentColor" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
    </svg>
  )
}

function SparkleIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
      <path d="M12 2C12 2 13 8 16 11C19 14 24 12 24 12C24 12 19 13 16 16C13 19 12 24 12 24C12 24 11 19 8 16C5 13 0 12 0 12C0 12 5 11 8 8C11 5 12 2 12 2Z" fill="currentColor"/>
    </svg>
  )
}

function TrophyIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
      <path d="M6 2H18V13C18 16.31 15.31 19 12 19C8.69 19 6 16.31 6 13V2Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/>
      <path d="M6 5H3C3 5 2 11 6 11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
      <path d="M18 5H21C21 5 22 11 18 11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
      <path d="M12 19V22M9 22H15" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
    </svg>
  )
}

function CrownIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M3 17L5.5 8L9.5 13L12 6L14.5 13L18.5 8L21 17H3Z" fill="currentColor" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round"/>
      <rect x="3" y="17" width="18" height="2.5" rx="1.25" fill="currentColor"/>
    </svg>
  )
}

function TargetIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8"/>
      <circle cx="12" cy="12" r="5" stroke="currentColor" strokeWidth="1.8"/>
      <circle cx="12" cy="12" r="2" fill="currentColor"/>
    </svg>
  )
}

function BrainIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none">
      <path d="M9.5 2C7 2 5 4 5 6.5C3.5 7 2 8.5 2 10.5C2 12 2.8 13.3 4 14C4 16.8 6.2 19 9 19H15C17.8 19 20 16.8 20 14C21.2 13.3 22 12 22 10.5C22 8.5 20.5 7 19 6.5C19 4 17 2 14.5 2C13.5 2 12.6 2.4 12 3C11.4 2.4 10.5 2 9.5 2Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/>
      <path d="M12 3V19M9 8C9 8 7 9 7 11M15 8C15 8 17 9 17 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  )
}

function SwordsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none">
      <path d="M14.5 17.5L3 6V3H6L17.5 14.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M13 19L15 17" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
      <path d="M17 21L21 17L20 13L11 4L8 3L3 3L14.5 14.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M5 11L11 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
    </svg>
  )
}

function FireIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none">
      <path d="M8.5 14C8.5 14 8 12.5 9 11C10 9.5 10.5 8 10 6C10 6 12 7 13 9C14 10 14 11.5 14 11.5C14 11.5 15 10 15 8C15 8 17 10 17 13C17 16.3 14.8 19 12 19C9.2 19 7 16.3 7 13C7 12 7.3 11 8.5 14Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/>
    </svg>
  )
}

function GiftIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none">
      <rect x="3" y="8" width="18" height="4" rx="1.5" stroke="currentColor" strokeWidth="1.8"/>
      <path d="M12 8V21M5 12V20C5 20.6 5.4 21 6 21H18C18.6 21 19 20.6 19 20V12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
      <path d="M12 8C12 8 9 8 9 5.5C9 4 10 3 11.5 3C12.5 3 12 8 12 8ZM12 8C12 8 15 8 15 5.5C15 4 14 3 12.5 3C11.5 3 12 8 12 8Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
    </svg>
  )
}

/* ── Banners ── */
const BANNERS = [
  { Icon: BrainIcon,  titleKey: 'banner1Title', subKey: 'banner1Sub', gradient: 'linear-gradient(135deg, #1d4ed8 0%, #3b82f6 100%)' },
  { Icon: TrophyIcon, titleKey: 'banner2Title', subKey: 'banner2Sub', gradient: 'linear-gradient(135deg, #92400e 0%, #f59e0b 100%)' },
  { Icon: FireIcon,   titleKey: 'banner3Title', subKey: 'banner3Sub', gradient: 'linear-gradient(135deg, #5b21b6 0%, #8b5cf6 100%)' },
  { Icon: GiftIcon,   titleKey: 'banner4Title', subKey: 'banner4Sub', gradient: 'linear-gradient(135deg, #065f46 0%, #10b981 100%)' },
]

function BannerCarousel({ t }) {
  const [active, setActive] = useState(0)
  const trackRef = useRef(null)
  const activeRef = useRef(0)

  function goTo(index) {
    if (!trackRef.current) return
    trackRef.current.scrollTo({ left: index * trackRef.current.offsetWidth, behavior: 'smooth' })
    setActive(index)
    activeRef.current = index
  }

  useEffect(() => {
    const timerRef = { id: null }

    function start() {
      timerRef.id = setInterval(() => {
        const next = (activeRef.current + 1) % BANNERS.length
        goTo(next)
      }, 7000)
    }

    function stop() {
      clearInterval(timerRef.id)
    }

    function onVisibility() {
      document.hidden ? stop() : start()
    }

    start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  function handleScroll() {
    if (!trackRef.current) return
    const index = Math.round(trackRef.current.scrollLeft / trackRef.current.offsetWidth)
    setActive(index)
    activeRef.current = index
  }

  return (
    <div className="banner-carousel">
      <div className="banner-track" ref={trackRef} onScroll={handleScroll}>
        {BANNERS.map((b, i) => (
          <div key={i} className="banner-slide" style={{ background: b.gradient }}>
            <div className="banner-icon-wrap"><b.Icon /></div>
            <div className="banner-text">
              <span className="banner-title">{t[b.titleKey]}</span>
              <span className="banner-sub">{t[b.subKey]}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="banner-dots">
        {BANNERS.map((_, i) => (
          <button key={i} className={`banner-dot ${i === active ? 'active' : ''}`} onClick={() => goTo(i)} />
        ))}
      </div>
    </div>
  )
}

/* ── Game Sheet ── */
const STAKES = [50, 100, 300, 500, 1000]
const MAX_SEARCH_TIME = 120

function GameSheet({ game, t, balance, currency, rates, onClose }) {
  const navigate = useNavigate()
  const { user, appSettings } = useGameStore(useShallow(s => ({ user: s.user, appSettings: s.appSettings })))
  const [selectedStakes, setSelectedStakes] = useState([])
  const [error, setError] = useState(null) // null | 'balance' | 'server'
  const [searching, setSearching] = useState(false)
  const [matched, setMatched] = useState(false)
  const [searchTime, setSearchTime] = useState(0)
  const findingRef = useRef(false)
  const errorTimer = useRef(null)
  const channelRef = useRef(null)
  const pollRef = useRef(null)
  const timerRef = useRef(null)
  const botTimerRef = useRef(null)

  useEffect(() => {
    setSelectedStakes([])
    setError(null)
    setSearching(false)
    setMatched(false)
    setSearchTime(0)
    cleanupSearch()
  }, [game?.id])

  // Lock body scroll when sheet is open
  useEffect(() => {
    if (game) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => { document.body.style.overflow = '' }
  }, [game])

  useEffect(() => {
    const tg = window.Telegram?.WebApp
    if (!tg) return
    if (game) {
      tg.BackButton.show()
      const handler = searching ? () => handleCancel(false) : onClose
      tg.BackButton.onClick(handler)
      return () => tg.BackButton.offClick(handler)
    } else {
      tg.BackButton.hide()
      tg.BackButton.offClick(onClose)
    }
    return () => tg.BackButton.offClick(onClose)
  }, [game, onClose, searching])

  // Search timer
  useEffect(() => {
    if (!searching) return
    timerRef.current = setInterval(() => {
      setSearchTime(prev => {
        if (prev + 1 >= MAX_SEARCH_TIME) {
          handleCancel(true)
          return prev
        }
        return prev + 1
      })
    }, 1000)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [searching])

  // Cleanup on unmount
  useEffect(() => { return () => cleanupSearch() }, [])

  function cleanupSearch() {
    if (channelRef.current) { supabase.removeChannel(channelRef.current); channelRef.current = null }
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
    if (botTimerRef.current) { clearTimeout(botTimerRef.current); botTimerRef.current = null }
  }

  const matchFoundRef = useRef(false)

  function handleMatchFound(duelId) {
    // Guard: prevent double-fire from realtime + poll + bot timer
    if (matchFoundRef.current) return
    matchFoundRef.current = true
    cleanupSearch()
    setMatched(true)
    haptic('heavy')
    setTimeout(() => {
      setSearching(false)
      setMatched(false)
      const route = game?.id === 'blackjack' ? '/blackjack' : game?.id === 'sequence' ? '/sequence' : '/game'
      navigate(`${route}/${duelId}`)
    }, 1500)
  }

  function toggleStake(amount) {
    if (searching) return
    if (amount > balance) {
      haptic('light')
      clearTimeout(errorTimer.current)
      setError('balance')
      errorTimer.current = setTimeout(() => setError(null), 2000)
      return
    }
    haptic('light')
    setSelectedStakes(prev =>
      prev.includes(amount) ? prev.filter(s => s !== amount) : [...prev, amount]
    )
  }

  async function handlePlay() {
    if (selectedStakes.length === 0) return
    if (findingRef.current || searching) return // Защита от двойного нажатия
    if (appSettings?.game_creation === false) {
      setError('maintenance')
      setTimeout(() => setError(null), 3000)
      return
    }
    findingRef.current = true
    matchFoundRef.current = false
    haptic('medium')

    // Dev mode — skip matchmaking, go straight to game
    if (user.id === 'dev') {
      setSearching(true)
      setSearchTime(0)
      setTimeout(() => {
        setSearching(false)
        const devRoute = game.id === 'blackjack' ? '/blackjack' : game.id === 'sequence' ? '/sequence' : '/game'
        navigate(`${devRoute}/dev-${game.id}-${selectedStakes[0]}`)
      }, 1500)
      return
    }

    // Cancel any pending game invites before searching
    cancelAllPendingInvites(user.id).catch(() => {})

    // Send all selected stakes — backend tries each one
    const gameType = game.id === 'blackjack' ? 'blackjack' : game.id === 'sequence' ? 'sequence' : 'quiz'
    const result = await findMatch(user.id, game.id, selectedStakes, gameType)

    if (!result || result.status === 'error') {
      findingRef.current = false
      if (result?.error === 'insufficient_balance') {
        setError('balance')
        setTimeout(() => setError(null), 2000)
        return
      }
      if (result?.error === 'not_enough_questions') {
        setError('maintenance')
        setTimeout(() => setError(null), 3000)
        return
      }
      // Любая другая ошибка — показываем и не ретраим бесконечно
      setError('server')
      setTimeout(() => setError(null), 2000)
      return
    }

    if (result.status === 'matched') {
      handleMatchFound(result.duel_id)
      return
    }

    // Queued — show searching UI
    setSearching(true)
    setSearchTime(0)

    // Realtime subscription
    const channel = supabase
      .channel(`matchmaking-${user.id}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'duels',
        filter: `creator_id=eq.${user.id}`,
      }, (payload) => {
        if (payload.new?.status === 'active') {
          handleMatchFound(payload.new.id)
        }
      })
      .subscribe()
    channelRef.current = channel

    // Fallback polling
    pollRef.current = setInterval(async () => {
      const { data } = await supabase
        .from('duels')
        .select('id')
        .or(`creator_id.eq.${user.id},opponent_id.eq.${user.id}`)
        .eq('status', 'active')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (data) handleMatchFound(data.id)
    }, 3000)

    // Bot timer: подключить бота через 30-60 сек если не нашёл человека
    // Если первая попытка не удалась — повтор через 10с
    if (appSettings?.bot_enabled !== false) {
      const botDelay = (30 + Math.floor(Math.random() * 31)) * 1000
      const tryCreateBot = async (retries = 2) => {
        if (matchFoundRef.current) return
        try {
          const res = await createBotDuel(user.id, game.id, selectedStakes, gameType)
          if (matchFoundRef.current) return
          if (res?.status === 'matched') {
            handleMatchFound(res.duel_id)
          } else if (retries > 0 && res?.status !== 'error') {
            // null response or unexpected — retry after 10s
            botTimerRef.current = setTimeout(() => tryCreateBot(retries - 1), 10000)
          } else if (res?.status === 'error' && res?.error !== 'not_in_queue' && retries > 0) {
            botTimerRef.current = setTimeout(() => tryCreateBot(retries - 1), 10000)
          }
        } catch (e) {
          console.error('Bot duel creation failed:', e)
          if (retries > 0) {
            botTimerRef.current = setTimeout(() => tryCreateBot(retries - 1), 10000)
          }
        }
      }
      botTimerRef.current = setTimeout(() => tryCreateBot(2), botDelay)
    }
  }

  async function handleCancel(timeout = false) {
    cleanupSearch()
    if (user?.id) await cancelMatchmaking(user.id)
    setSearching(false)
    setSearchTime(0)
    findingRef.current = false
    haptic('light')
  }

  const sheetCfg = game ? GAME_SHEETS[game.id] : null
  const accent = game?.accent ?? '#3B82F6'
  const mm = String(Math.floor(searchTime / 60)).padStart(2, '0')
  const ss = String(searchTime % 60).padStart(2, '0')

  return (
    <>
      <div className={`sheet-overlay ${game ? 'visible' : ''}`} onClick={searching ? undefined : onClose} />
      <div className={`game-sheet ${game ? 'open' : ''}`}>
        <div className="sheet-handle" />

        {/* Header */}
        <div className="sheet-header">
          <div className="sheet-icon-wrap" style={{ '--sa': accent }}>
            {sheetCfg ? (
              game.id === 'quiz' ? <QuizIcon /> : <span className="sheet-icon-emoji">{sheetCfg.icon}</span>
            ) : <QuizIcon />}
          </div>
          <h2 className="sheet-title" style={{ color: accent }}>
            {game ? t[game.titleKey] : ''}
          </h2>
          <span className="sheet-subtitle">1 vs 1</span>
        </div>

        {/* Stats row + Rules — hide when searching */}
        <div className={`sheet-collapsible ${searching ? 'collapsed' : ''}`}>
          {sheetCfg && (
            <div className="sheet-stats-row">
              {sheetCfg.stats.map((s, i) => (
                <React.Fragment key={i}>
                  {i > 0 && <div className="sheet-stat-div" />}
                  <div className="sheet-stat">
                    <span className="sheet-stat-val">{s.val}</span>
                    <span className="sheet-stat-lbl">{t[s.lblKey] || s.lblKey}</span>
                  </div>
                </React.Fragment>
              ))}
            </div>
          )}

          {sheetCfg && (
            <div className="sheet-rules">
              {sheetCfg.ruleKeys.map((rk, i) => (
                <div className="sheet-rule" key={i}>
                  <div className="sheet-rule-dot" style={{ background: accent }} />
                  <span>{t[rk] || rk}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Stakes */}
        <div className={`sheet-stakes-section ${searching ? 'sheet-stakes-searching' : ''}`}>
          {!searching && <span className="sheet-label">{t.sheetStakeLabel}</span>}
          {!searching && <span className="sheet-stake-hint">{t.sheetStakeHint}</span>}
          <div className="sheet-stakes-row">
            {STAKES.map(amount => {
              const canAfford = amount <= balance
              const isActive = selectedStakes.includes(amount)
              if (searching && !isActive) return null
              return (
                <button
                  key={amount}
                  className={`sheet-stake ${isActive ? 'active' : ''} ${!canAfford ? 'locked' : ''} ${searching ? 'sheet-stake-big' : ''}`}
                  onClick={() => toggleStake(amount)}
                  disabled={searching}
                >
                  {formatCurrency(amount, currency, rates)}
                </button>
              )
            })}
          </div>
          {!searching && (
            <div className={`sheet-error ${error ? 'visible' : ''}`}>
              {error === 'balance'
                ? t.sheetInsufficientBalance
                : error === 'maintenance'
                  ? (t.sheetMaintenance || 'Игры временно недоступны ⚙️')
                  : (t.sheetServerError || 'Ошибка сервера, попробуйте позже')}
            </div>
          )}
        </div>

        {/* Search state */}
        {searching && (
          <div className="sheet-search-state">
            <div className="sheet-search-timer">{mm}:{ss}</div>
            <div className={`sheet-search-pulse ${matched ? 'matched' : ''}`}>
              {matched ? (t.sheetMatchFound || 'Соперник найден! Готовим вопросы...') : (t.sheetSearching || 'Ищем соперника...')}
            </div>
            {!matched && (
              <div className="sheet-search-dots">
                <span className="sheet-dot" />
                <span className="sheet-dot" />
                <span className="sheet-dot" />
              </div>
            )}
          </div>
        )}

        {/* CTA */}
        {searching ? (
          <button
            className={`sheet-cancel-btn ${matched ? 'disabled' : ''}`}
            onClick={() => !matched && handleCancel(false)}
            disabled={matched}
          >
            {t.sheetCancel || 'Отменить'}
          </button>
        ) : (
          <button
            className="sheet-play-btn"
            disabled={selectedStakes.length === 0}
            onClick={handlePlay}
          >
            {t.sheetPlay}
          </button>
        )}
      </div>
    </>
  )
}

/* ── Friends Panel ── */
const ONLINE_THRESHOLD = 5 * 60 * 1000 // 5 minutes

function FriendAvatar({ user, showOnline }) {
  return (
    <div className="friends-avatar-wrap">
      {user.avatar_url
        ? <img className="friends-avatar" src={user.avatar_url} alt="" style={{ objectFit: 'cover' }} />
        : <div className="friends-avatar">{user.first_name?.[0] ?? '?'}</div>}
      {showOnline && <span className="friends-status-dot online" />}
    </div>
  )
}

function FriendsPanel({ open, onClose, t, user, navigate, balance, currency, rates }) {
  const { friends, friendRequests, sentRequestIds, gameInvites, sentInvites } = useGameStore(useShallow(s => ({
    friends: s.friends, friendRequests: s.friendRequests, sentRequestIds: s.sentRequestIds,
    gameInvites: s.gameInvites, sentInvites: s.sentInvites,
  })))
  const setFriends = useGameStore(s => s.setFriends)
  const setFriendRequests = useGameStore(s => s.setFriendRequests)
  const setSentRequestIds = useGameStore(s => s.setSentRequestIds)
  const setGameInvites = useGameStore(s => s.setGameInvites)
  const setSentInvites = useGameStore(s => s.setSentInvites)

  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState(null)
  const [searchMode, setSearchMode] = useState(false)
  const [searchResults, setSearchResults] = useState([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [actionLoading, setActionLoading] = useState(null)
  const [confirmRemoveId, setConfirmRemoveId] = useState(null)
  const [inviteTarget, setInviteTarget] = useState(null)
  const [inviteGame, setInviteGame] = useState(null)
  const [inviteStake, setInviteStake] = useState('')
  const [inviteSending, setInviteSending] = useState(false)
  const [inviteMsg, setInviteMsg] = useState(null) // 'sent' | 'error' | 'balance' | 'offline'
  const [acceptError, setAcceptError] = useState(null) // invite id with balance error
  const debounceRef = useRef(null)

  // Refresh friends + invites on open
  useEffect(() => {
    if (open && user?.id && user.id !== 'dev') {
      getFriendsData(user.id).then(data => {
        if (data) {
          setFriends(data.friends ?? [])
          setFriendRequests(data.incoming_requests ?? [])
          setSentRequestIds(data.outgoing_request_ids ?? [])
        }
      })
      getPendingInvites(user.id).then(invites => {
        setGameInvites(invites)
      })
    }
  }, [open])

  // Reset on close
  useEffect(() => {
    if (!open) {
      setQuery('')
      setActiveId(null)
      setSearchMode(false)
      setSearchResults([])
      setConfirmRemoveId(null)
      setInviteTarget(null)
    }
  }, [open])

  // Telegram BackButton
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

  // ── Search handlers ──
  function handleSearchQuery(val) {
    setQuery(val)
    if (!searchMode) return // local filter only
    clearTimeout(debounceRef.current)
    const q = val.trim().replace(/^@/, '')
    if (q.length < 2) { setSearchResults([]); setSearchLoading(false); return }
    setSearchLoading(true)
    debounceRef.current = setTimeout(async () => {
      const results = await searchUsersApi(user?.id, q)
      setSearchResults(results)
      setSearchLoading(false)
    }, 300)
  }

  function enterSearchMode() {
    haptic('light')
    setSearchMode(true)
    setQuery('')
    setSearchResults([])
    setActiveId(null)
  }

  function exitSearchMode() {
    haptic('light')
    setSearchMode(false)
    setQuery('')
    setSearchResults([])
  }

  // ── Action handlers ──
  async function handleAccept(req) {
    if (actionLoading) return
    haptic('medium')
    setActionLoading(req.request_id)
    const result = await acceptFriendRequest(user.id, req.request_id)
    if (!result?.error) {
      setFriendRequests(friendRequests.filter(r => r.request_id !== req.request_id))
      setFriends([...friends, {
        id: req.from_user.id,
        first_name: req.from_user.first_name,
        username: req.from_user.username,
        avatar_url: req.from_user.avatar_url,
        last_seen: new Date().toISOString(),
      }])
    }
    setActionLoading(null)
  }

  async function handleDecline(req) {
    if (actionLoading) return
    haptic('light')
    setActionLoading(req.request_id)
    const result = await rejectFriendRequest(user.id, req.request_id)
    if (!result?.error) {
      setFriendRequests(friendRequests.filter(r => r.request_id !== req.request_id))
    }
    setActionLoading(null)
  }

  function handleRemoveFriend(friendId) {
    haptic('medium')
    setConfirmRemoveId(friendId)
  }

  async function confirmRemove() {
    if (actionLoading || !confirmRemoveId) return
    haptic('heavy')
    setActionLoading(confirmRemoveId)
    const result = await removeFriend(user.id, confirmRemoveId)
    if (!result?.error) {
      setFriends(friends.filter(f => f.id !== confirmRemoveId))
    }
    setActionLoading(null)
    setActiveId(null)
    setConfirmRemoveId(null)
  }

  function cancelRemove() {
    haptic('light')
    setConfirmRemoveId(null)
  }

  async function handleSendRequest(targetUser) {
    if (actionLoading) return
    haptic('medium')
    setActionLoading(targetUser.id)
    const result = await sendFriendRequest(user.id, targetUser.id)
    if (result?.result === 'auto_accepted') {
      setFriends([...friends, {
        id: targetUser.id, first_name: targetUser.first_name,
        username: targetUser.username, avatar_url: targetUser.avatar_url,
        last_seen: new Date().toISOString(),
      }])
      setSearchResults(prev => prev.map(r =>
        r.id === targetUser.id ? { ...r, is_friend: true } : r
      ))
    } else if (!result?.error) {
      setSentRequestIds([...sentRequestIds, targetUser.id])
      setSearchResults(prev => prev.map(r =>
        r.id === targetUser.id ? { ...r, request_pending: true } : r
      ))
    }
    setActionLoading(null)
  }

  // ── Invite handlers ──
  async function handleSendInvite() {
    if (!inviteTarget || !inviteGame || !inviteStake || inviteSending) return
    const stakeNum = parseInt(inviteStake)
    if (!stakeNum || stakeNum < 50) {
      setInviteMsg('minStake')
      setTimeout(() => setInviteMsg(null), 2000)
      return
    }
    if (stakeNum > balance) {
      setInviteMsg('balance')
      setTimeout(() => setInviteMsg(null), 2000)
      return
    }
    setInviteSending(true)
    haptic('medium')
    const result = await sendGameInvite(user.id, inviteTarget.id, inviteGame, stakeNum)
    setInviteSending(false)
    if (result?.invite_id) {
      setSentInvites([...sentInvites, { id: result.invite_id, to_id: inviteTarget.id, game_type: inviteGame, stake: stakeNum }])
      setInviteMsg('sent')
      setTimeout(() => { setInviteMsg(null); setInviteTarget(null); setInviteGame(null); setInviteStake('') }, 1500)
    } else if (result?.error === 'friend_offline') {
      setInviteMsg('offline')
      setTimeout(() => setInviteMsg(null), 2000)
    } else {
      setInviteMsg('error')
      setTimeout(() => setInviteMsg(null), 2000)
    }
  }

  async function handleAcceptInvite(inv) {
    // Check balance before accepting
    if (balance < inv.stake) {
      haptic('error')
      setAcceptError(inv.id)
      setTimeout(() => setAcceptError(null), 2500)
      return
    }
    haptic('medium')
    setActionLoading(inv.id)
    const result = await acceptGameInvite(inv.id, user.id)
    setActionLoading(null)
    if (result?.duel_id) {
      setGameInvites(gameInvites.filter(i => i.id !== inv.id))
      onClose()
      const route = inv.game_type === 'blackjack' ? '/blackjack' : inv.game_type === 'sequence' ? '/sequence' : '/game'
      navigate(`${route}/${result.duel_id}`)
    } else if (result?.error === 'insufficient_balance' || result?.error === 'sender_insufficient_balance') {
      haptic('error')
      setAcceptError(inv.id)
      setTimeout(() => setAcceptError(null), 2500)
    }
  }

  async function handleRejectInvite(inv) {
    haptic('light')
    setActionLoading(inv.id)
    await rejectGameInvite(inv.id, user.id)
    setGameInvites(gameInvites.filter(i => i.id !== inv.id))
    setActionLoading(null)
  }

  // ── Friends list data ──
  const now = Date.now()
  const withOnline = (friends ?? []).map(f => ({
    ...f,
    online: f.last_seen ? (now - new Date(f.last_seen).getTime()) < ONLINE_THRESHOLD : false,
  }))
  const onlineFriends = withOnline.filter(f => f.online)
  const offlineFriends = withOnline.filter(f => !f.online)

  return (
    <>
      <div className={`friends-overlay ${open ? 'visible' : ''}`} onClick={onClose} />
      <div className={`friends-panel ${open ? 'open' : ''}`} onClick={e => e.stopPropagation()}>
        <div className="friends-header">
          <span className="friends-title">{t.friends}</span>
          <button className="friends-close" onClick={onClose}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>

        {/* Incoming game invites */}
        {!searchMode && gameInvites.length > 0 && (
          <div className="friends-invites">
            <span className="friends-group-label">
              <span className="friends-invite-dot" />
              {t.gameInvites} · {gameInvites.length}
            </span>
            {gameInvites.map(inv => {
              const sender = friends.find(f => f.id === inv.from_id)
              const expired = new Date(inv.expires_at) < new Date()
              const gameIcon = inv.game_type === 'blackjack' ? '🃏' : inv.game_type === 'sequence' ? '🧠' : '❓'
              const gameLabel = inv.game_type === 'blackjack' ? 'Блэкджек' : inv.game_type === 'sequence' ? 'Sequence' : 'Викторина'
              return (
                <div key={inv.id} className="friends-row friends-invite-row">
                  <FriendAvatar user={sender || { first_name: '?' }} showOnline />
                  <div className="friends-info">
                    <span className="friends-name">{sender?.first_name || '?'}</span>
                    <span className="friends-invite-meta">{gameIcon} {gameLabel} · {formatCurrency(inv.stake, currency, rates)}</span>
                  </div>
                  {!expired ? (
                    <div className="friends-req-actions">
                      {acceptError === inv.id ? (
                        <span className="friends-invite-error">{t.inviteInsufficientBalance}</span>
                      ) : (
                        <>
                          <button className="friends-action-btn accept" disabled={actionLoading === inv.id} onClick={e => { e.stopPropagation(); handleAcceptInvite(inv) }}>{t.invitePlay}</button>
                          <button className="friends-action-btn decline" disabled={actionLoading === inv.id} onClick={e => { e.stopPropagation(); handleRejectInvite(inv) }}>{t.inviteDecline}</button>
                        </>
                      )}
                    </div>
                  ) : (
                    <span className="friends-badge friends-badge--pending">Expired</span>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* Incoming requests (only in friends mode) */}
        {!searchMode && friendRequests.length > 0 && (
          <div className="friends-requests">
            <span className="friends-group-label">
              <span className="friends-request-dot" />
              {t.friendsRequests} · {friendRequests.length}
            </span>
            {friendRequests.map(req => (
              <div key={req.request_id} className="friends-row friends-request-row">
                <FriendAvatar user={req.from_user} />
                <div className="friends-info">
                  <span className="friends-name">{req.from_user.first_name}</span>
                  {req.from_user.username && <span className="friends-username">@{req.from_user.username}</span>}
                </div>
                <div className="friends-req-actions">
                  <button
                    className="friends-action-btn accept"
                    disabled={actionLoading === req.request_id}
                    onClick={e => { e.stopPropagation(); handleAccept(req) }}
                  >{t.friendsAccept}</button>
                  <button
                    className="friends-action-btn decline"
                    disabled={actionLoading === req.request_id}
                    onClick={e => { e.stopPropagation(); handleDecline(req) }}
                  >{t.friendsDecline}</button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Search bar (only in search mode) / Find friends button */}
        {!searchMode ? (
          <button className="friends-find-btn" onClick={enterSearchMode}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
              <circle cx="9" cy="7" r="4"/>
              <line x1="19" y1="8" x2="19" y2="14"/>
              <line x1="22" y1="11" x2="16" y2="11"/>
            </svg>
            {t.friendsFind}
          </button>
        ) : (
          <>
            <div className="friends-search-wrap">
              <svg className="friends-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
              </svg>
              <input
                className="friends-search"
                placeholder={t.friendsSearch}
                value={query}
                onChange={e => handleSearchQuery(e.target.value)}
                autoFocus
              />
            </div>
            <button className="friends-find-btn friends-back-btn" onClick={exitSearchMode}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 12H5M12 19l-7-7 7-7"/>
              </svg>
              {t.friendsBack}
            </button>
          </>
        )}

        {/* Content */}
        <div className="friends-list">
          {!searchMode ? (
            <>
              {/* Friends list */}
              {withOnline.length === 0 && friendRequests.length === 0 && (
                <span className="friends-empty">{t.friendsEmpty}</span>
              )}

              {onlineFriends.length > 0 && (
                <>
                  <span className="friends-group-label">
                    <span className="friends-online-dot" />
                    {t.friendsOnline} · {onlineFriends.length}
                  </span>
                  {onlineFriends.map(f => (
                    <div key={f.id} className={`friends-row-wrap ${confirmRemoveId === f.id ? 'confirming' : ''}`}>
                      <div className={`friends-row ${activeId === f.id ? 'active' : ''}`} onClick={() => { haptic('light'); setActiveId(prev => prev === f.id ? null : f.id); setConfirmRemoveId(null) }}>
                        <FriendAvatar user={f} showOnline />
                        <div className="friends-info">
                          <span className="friends-name">{f.first_name}</span>
                          {f.username && <span className="friends-username">@{f.username}</span>}
                        </div>
                        {activeId === f.id && (() => {
                          const hasPendingInvite = sentInvites.some(si => si.to_id === f.id)
                          return (
                            <div className="friends-actions">
                              <button className={`friends-action-btn invite ${hasPendingInvite ? 'disabled' : ''}`} disabled={hasPendingInvite} onClick={e => { e.stopPropagation(); haptic('light'); setInviteTarget(f); setInviteGame(null); setInviteStake(''); setInviteMsg(null) }}>{hasPendingInvite ? t.inviteSent : t.friendsInvite}</button>
                              <button className="friends-action-btn remove" onClick={e => { e.stopPropagation(); handleRemoveFriend(f.id) }}>{t.friendsRemove}</button>
                            </div>
                          )
                        })()}
                      </div>
                      {confirmRemoveId === f.id && (
                        <div className="friends-confirm-inline">
                          <span className="friends-confirm-text">{t.friendsRemoveConfirm}</span>
                          <div className="friends-confirm-actions">
                            <button className="friends-confirm-btn cancel" onClick={cancelRemove}>{t.friendsRemoveCancel}</button>
                            <button className="friends-confirm-btn confirm" disabled={actionLoading === f.id} onClick={confirmRemove}>{t.friendsRemoveYes}</button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </>
              )}

              {offlineFriends.length > 0 && (
                <>
                  <span className="friends-group-label">
                    {t.friendsOffline} · {offlineFriends.length}
                  </span>
                  {offlineFriends.map(f => (
                    <div key={f.id} className={`friends-row-wrap ${confirmRemoveId === f.id ? 'confirming' : ''}`}>
                      <div className={`friends-row ${activeId === f.id ? 'active' : ''}`} onClick={() => { haptic('light'); setActiveId(prev => prev === f.id ? null : f.id); setConfirmRemoveId(null) }}>
                        <FriendAvatar user={f} />
                        <div className="friends-info">
                          <span className="friends-name">{f.first_name}</span>
                          {f.username && <span className="friends-username">@{f.username}</span>}
                        </div>
                        {activeId === f.id && (
                          <div className="friends-actions">
                            <button className="friends-action-btn remove" onClick={e => { e.stopPropagation(); handleRemoveFriend(f.id) }}>{t.friendsRemove}</button>
                          </div>
                        )}
                      </div>
                      {confirmRemoveId === f.id && (
                        <div className="friends-confirm-inline">
                          <span className="friends-confirm-text">{t.friendsRemoveConfirm}</span>
                          <div className="friends-confirm-actions">
                            <button className="friends-confirm-btn cancel" onClick={cancelRemove}>{t.friendsRemoveCancel}</button>
                            <button className="friends-confirm-btn confirm" disabled={actionLoading === f.id} onClick={confirmRemove}>{t.friendsRemoveYes}</button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </>
              )}
            </>
          ) : (
            <>
              {/* Global search results */}
              {searchLoading && (
                <div className="friends-search-loading">
                  <div className="friends-spinner" />
                </div>
              )}
              {!searchLoading && searchResults.length === 0 && query.trim().length >= 2 && (
                <span className="friends-empty">{t.friendsSearchEmpty}</span>
              )}
              {searchResults.map(u => {
                const isFriend = u.is_friend || friends.some(f => f.id === u.id)
                const isPending = u.request_pending || sentRequestIds.includes(u.id)
                return (
                  <div key={u.id} className="friends-row">
                    <FriendAvatar user={u} />
                    <div className="friends-info">
                      <span className="friends-name">{u.first_name}</span>
                      {u.username && <span className="friends-username">@{u.username}</span>}
                    </div>
                    <div className="friends-search-action">
                      {isFriend ? (
                        <span className="friends-badge friends-badge--friend">✓</span>
                      ) : isPending ? (
                        <span className="friends-badge friends-badge--pending">{t.friendsPending}</span>
                      ) : (
                        <button
                          className="friends-action-btn add"
                          disabled={actionLoading === u.id}
                          onClick={e => { e.stopPropagation(); handleSendRequest(u) }}
                        >{t.friendsAdd}</button>
                      )}
                    </div>
                  </div>
                )
              })}
            </>
          )}
        </div>

      </div>

      {/* Invite Sheet (bottom overlay inside friends panel) */}
      {inviteTarget && (
        <>
          <div className="invite-overlay" onClick={() => setInviteTarget(null)} />
          <div className="invite-sheet">
            <div className="invite-sheet-handle" />
            <h3 className="invite-sheet-title">{t.inviteTitle} {inviteTarget.first_name}</h3>

            <span className="invite-sheet-label">{t.inviteSelectGame}</span>
            <div className="invite-game-cards">
              {[
                { id: 'quiz', icon: '❓', label: 'Викторина' },
                { id: 'blackjack', icon: '🃏', label: 'Блэкджек' },
              ].map(g => (
                <button
                  key={g.id}
                  className={`invite-game-card ${inviteGame === g.id ? 'active' : ''}`}
                  onClick={() => { haptic('light'); setInviteGame(g.id) }}
                >
                  <span className="invite-game-icon">{g.icon}</span>
                  <span className="invite-game-label">{g.label}</span>
                </button>
              ))}
            </div>

            <span className="invite-sheet-label">{t.inviteStake}</span>
            <input
              type="number"
              className="invite-stake-input"
              placeholder={t.inviteStakePlaceholder}
              value={inviteStake}
              onChange={e => setInviteStake(e.target.value)}
              min="50"
              inputMode="numeric"
            />

            <div className={`invite-msg ${inviteMsg ? 'visible' : ''}`}>
              {inviteMsg === 'sent' ? t.inviteSent
                : inviteMsg === 'minStake' ? t.inviteMinStake
                : inviteMsg === 'balance' ? t.inviteInsufficientBalance
                : inviteMsg === 'offline' ? t.inviteFriendOffline
                : inviteMsg === 'error' ? t.inviteError : ''}
            </div>

            <button
              className="invite-send-btn"
              disabled={!inviteGame || !inviteStake || inviteSending || inviteMsg === 'sent'}
              onClick={handleSendInvite}
            >
              {inviteSending ? '...' : t.inviteSend}
            </button>
          </div>
        </>
      )}
    </>
  )
}

/* ── Games ── */
const GAME_SHEETS = {
  quiz: {
    icon: '❓',
    stats: [
      { val: '5', lblKey: 'sheetStatQ' },
      { val: '15', lblKey: 'sheetStatSec' },
      { val: '1v1', lblKey: 'sheetStatMode' },
    ],
    ruleKeys: ['sheetRule1', 'sheetRule2', 'sheetRule3'],
  },
  sequence: {
    icon: '🧠',
    stats: [
      { val: '3', lblKey: 'sheetSeqRounds' },
      { val: '10', lblKey: 'sheetSeqTime' },
      { val: '1v1', lblKey: 'sheetStatMode' },
    ],
    ruleKeys: ['sheetSeqRule1', 'sheetSeqRule2', 'sheetSeqRule3'],
  },
  blackjack: {
    icon: '🃏',
    stats: [
      { val: '16', lblKey: 'sheetBjCards' },
      { val: '21', lblKey: 'sheetBjTarget' },
      { val: '1v1', lblKey: 'sheetStatMode' },
    ],
    ruleKeys: ['sheetBjRule1', 'sheetBjRule2', 'sheetBjRule3'],
  },
}

const GAMES = [
  { id: 'quiz', titleKey: 'gameQuizTitle', subKey: 'gameQuizSub', available: true, accent: '#3B82F6', shadow: '#1d3461' },
  { id: 'sequence', titleKey: 'gameSequenceTitle', subKey: 'gameSequenceSub', available: true, accent: '#8B5CF6', shadow: '#2d1b69' },
  { id: 'blackjack', titleKey: 'gameBlackjackTitle', subKey: 'gameBlackjackSub', available: true, accent: '#F59E0B', shadow: '#78350f' },
]

/* ── Home ── */
// Admin Telegram IDs — same list as in Admin.jsx
const ADMIN_IDS = ['dev', 945676433]

export default function Home() {
  const { balance, currency, rates, lang, user, friendRequests, balanceBounce, gameInvites, pendingGameNav } = useGameStore(useShallow(s => ({
    balance: s.balance, currency: s.currency, rates: s.rates, lang: s.lang,
    user: s.user, friendRequests: s.friendRequests, balanceBounce: s.balanceBounce,
    gameInvites: s.gameInvites, pendingGameNav: s.pendingGameNav,
  })))
  const setDepositOpen = useGameStore(s => s.setDepositOpen)
  const setPendingGameNav = useGameStore(s => s.setPendingGameNav)
  const navigate = useNavigate()
  const t = translations[lang]
  const [sheetGame, setSheetGame] = useState(null)
  const [friendsOpen, setFriendsOpen] = useState(false)

  const isAdmin = user && (
    ADMIN_IDS.includes(user.id) ||
    ADMIN_IDS.includes(user.telegram_id) ||
    ADMIN_IDS.includes(Number(user.telegram_id))
  )

  const closeSheet = useCallback(() => {
    haptic('light')
    setSheetGame(null)
  }, [])

  const closeFriends = useCallback(() => {
    haptic('light')
    setFriendsOpen(false)
  }, [])

  // Sender navigation: when opponent accepts invite, navigate to game
  useEffect(() => {
    if (pendingGameNav) {
      const { duelId, gameType } = pendingGameNav
      setPendingGameNav(null)
      const route = gameType === 'blackjack' ? '/blackjack' : gameType === 'sequence' ? '/sequence' : '/game'
      navigate(`${route}/${duelId}`)
    }
  }, [pendingGameNav])

  function handleGameTap(game) {
    if (!game.available) return
    haptic('medium')
    setSheetGame(game)
  }

  return (
    <div className="home page">
      <div className="home-topbar">
        <div className="topbar-left">
          <span className="topbar-logo">OUTPLAY</span>
          {isAdmin && (
            <button className="topbar-admin" onClick={() => { haptic('light'); navigate('/admin') }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3"/>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
              </svg>
            </button>
          )}
        </div>
        <div className="topbar-row">
          <button className="topbar-friends" onClick={() => { haptic('medium'); setFriendsOpen(true) }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
              <circle cx="8.5" cy="7" r="4"/>
              <line x1="20" y1="8" x2="20" y2="14"/>
              <line x1="23" y1="11" x2="17" y2="11"/>
            </svg>
            {(friendRequests.length + gameInvites.length) > 0 && (
              <span className="topbar-friends-badge">{friendRequests.length + gameInvites.length}</span>
            )}
          </button>
          <div className={`topbar-balance ${balanceBounce ? 'bounce' : ''}`}>
            <span className="topbar-amount">{formatCurrency(balance, currency, rates)}</span>
            <button className="topbar-plus" onClick={() => { haptic('light'); setDepositOpen(true) }}>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                <path d="M8 2V14M2 8H14" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/>
              </svg>
            </button>
          </div>
        </div>
      </div>

      <BannerCarousel t={t} />

      <div className="games-section">
        <span className="games-label">{t.gamesLabel}</span>
        <div className="games-grid">

          <button
            className="game-card game-card--main"
            style={{ '--card-accent': GAMES[0].accent, '--card-shadow': GAMES[0].shadow }}
            onClick={() => handleGameTap(GAMES[0])}
          >
            <div className="game-card-glow" />
            <div className="game-card-deco" style={{ top: '12%', left: '28px', transform: 'rotate(-18deg)' }}><LightningIcon /></div>
            <div className="game-card-deco" style={{ top: '44%', left: '6px', transform: 'rotate(6deg)' }}><SparkleIcon /></div>
            <div className="game-card-deco" style={{ bottom: '12%', left: '28px', transform: 'rotate(-8deg)' }}><StarIcon /></div>
            <div className="game-card-deco" style={{ top: '12%', right: '28px', transform: 'rotate(16deg)' }}><TrophyIcon /></div>
            <div className="game-card-deco" style={{ top: '44%', right: '6px', transform: 'rotate(-10deg)' }}><CrownIcon /></div>
            <div className="game-card-deco" style={{ bottom: '12%', right: '28px', transform: 'rotate(6deg)' }}><TargetIcon /></div>
            <div className="game-card-icon game-card-icon--center">
              <QuizIcon />
            </div>
            <span className="game-card-title">{t.gameQuizTitle}</span>
          </button>

          <div className="games-row">
            {GAMES.slice(1).map(g => (
              <button
                key={g.id}
                className={`game-card game-card--small ${!g.available ? 'game-card--soon' : ''}`}
                style={{ '--card-accent': g.accent, '--card-shadow': g.shadow }}
                onClick={() => handleGameTap(g)}
                disabled={!g.available}
              >
                <div className="game-card-glow" />
                <span className="game-card-emoji">{GAME_SHEETS[g.id]?.icon}</span>
                <div className="game-card-info">
                  <span className="game-card-title">{t[g.titleKey]}</span>
                  <span className="game-card-sub">{t[g.subKey]}</span>
                </div>
                {!g.available && <div className="game-card-badge">{t.soon}</div>}
              </button>
            ))}
          </div>

          <div className="games-more-soon">
            <span>{t.moreGamesSoon}</span>
          </div>

        </div>
      </div>

      <FriendsPanel open={friendsOpen} onClose={closeFriends} t={t} user={user} navigate={navigate} balance={balance} currency={currency} rates={rates} />

      <GameSheet
        game={sheetGame}
        t={t}
        balance={balance}
        currency={currency}
        rates={rates}
        onClose={closeSheet}
      />
    </div>
  )
}
