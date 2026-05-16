import React, { useRef, useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import useGameStore from '../store/useGameStore'
import { useShallow } from 'zustand/react/shallow'
import { supabase } from '../lib/supabase'
import { findMatch, cancelMatchmaking, createBotDuel } from '../lib/supabase'
import { haptic } from '../lib/telegram'
import sound from '../lib/sounds'
import { translations } from '../lib/i18n'
import { formatCurrency } from '../lib/currency'
import { searchUsers as searchUsersApi, sendFriendRequest, acceptFriendRequest, rejectFriendRequest, removeFriend, getFriendsData, sendGameInvite, acceptGameInvite, rejectGameInvite, cancelAllPendingInvites, getPendingInvites, getGameOnlineCounts } from '../lib/supabase'
import { GAME_CARD_ART } from '../lib/gameAssets'
// Pixel Mine card art textures — imported as URL refs so we can drop
// them into inline style.backgroundImage without any CSS animation
// layer promotion (keeps the 16×16 pixel art crisp on mobile).
import pmTexGrass     from '../assets/games/pixel_mine/blocks/grass.png'
import pmTexStone     from '../assets/games/pixel_mine/blocks/stone_block.png'
import pmTexStoneDmg1 from '../assets/games/pixel_mine/block_damage/stone_block (1).png'
import pmTexGold      from '../assets/games/pixel_mine/blocks/gold_block.png'
import pmTexGoldDmg1  from '../assets/games/pixel_mine/block_damage/gold_block (1).png'
import pmTexGoldDmg2  from '../assets/games/pixel_mine/block_damage/gold_block (2).png'
import pmTexGoldDmg3  from '../assets/games/pixel_mine/block_damage/gold_block (3).png'
import pmTexGoldDmg4  from '../assets/games/pixel_mine/block_damage/gold_block (4).png'
import pmTexChest     from '../assets/games/pixel_mine/chests/chest.png'
import pmTexChestOpen from '../assets/games/pixel_mine/chests/opened_chest.png'
// Magnetic card art — pull from the real game's pixel-art assets
// so the home card and preview overlay match what the player sees
// once they open the slot.
import mgTexCoin    from '../assets/games/magnetic/coin.png'
import mgTexBolt    from '../assets/games/magnetic/bolt.png'
import mgTexCompass from '../assets/games/magnetic/compas.png'
import mgTexOrb     from '../assets/games/magnetic/plazm_orb.png'
import mgTexGem     from '../assets/games/magnetic/scatter.png'
import mgTexMagnet  from '../assets/games/magnetic/magnet.png'
// Stardew Spins — the SAME crop sprites the live slot renders, so
// the home card reads as an actual spin of the game (tiny ~400 B
// pixel PNGs, negligible bundle cost).
import sdPotatoe    from '../assets/stardew/symbols/potatoe.png'
import sdCarrot     from '../assets/stardew/symbols/carrot.png'
import sdCorn       from '../assets/stardew/symbols/corn.png'
import sdEggplant   from '../assets/stardew/symbols/eggplant.png'
import sdTomatoe    from '../assets/stardew/symbols/tomatoe.png'
import sdGrape      from '../assets/stardew/symbols/grape.png'
import sdPumpkin    from '../assets/stardew/symbols/pumpkin.png'
import sdWatermelon from '../assets/stardew/symbols/watermelon.png'
import sdLime       from '../assets/stardew/symbols/lime.png'
import './Home.css'
// Imported here so the home-page rocket card art styles ship with Home,
// not just when the player opens the slot itself.
import './RocketSlot.css'
import './PlinkoSlot.css'
import './PixelMineSlot.css'
import './DiceSlot.css'
import LiveFeed from '../components/LiveFeed'

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
  const backupPollStartRef = useRef(null)
  const timerRef = useRef(null)
  const botTimerRef = useRef(null)
  const searchCancelledRef = useRef(false)

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

  // Cancel matchmaking when user leaves the app (visibilitychange / beforeunload)
  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState === 'hidden' && searching && user?.id && user.id !== 'dev') {
        cleanupSearch()
        cancelMatchmaking(user.id)
      }
    }
    function handleBeforeUnload() {
      if (searching && user?.id && user.id !== 'dev') {
        cancelMatchmaking(user.id)
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [searching, user?.id])

  function cleanupSearch() {
    searchCancelledRef.current = true
    if (channelRef.current) { supabase.removeChannel(channelRef.current); channelRef.current = null }
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    if (backupPollStartRef.current) { clearTimeout(backupPollStartRef.current); backupPollStartRef.current = null }
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
    sound.gameStart()
    setTimeout(() => {
      setSearching(false)
      setMatched(false)
      findingRef.current = false
      const route = game?.id === 'blackjack' ? '/blackjack' : game?.id === 'sequence' ? '/sequence' : game?.id === 'reaction' ? '/reaction' : game?.id === 'hearing' ? '/hearing' : game?.id === 'gradient' ? '/gradient' : game?.id === 'race' ? '/race' : game?.id === 'capitals' ? '/capitals' : game?.id === 'circle' ? '/circle' : '/game'
      navigate(`${route}/${duelId}`)
    }, 1500)
  }

  function startBackupMatchPoll(userId) {
    if (pollRef.current) return
    pollRef.current = setInterval(async () => {
      const { data } = await supabase
        .from('duels')
        .select('id')
        .or(`creator_id.eq.${userId},opponent_id.eq.${userId}`)
        .eq('status', 'active')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (data) handleMatchFound(data.id)
    }, 15000)
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
    searchCancelledRef.current = false
    haptic('medium')

    // Dev mode — skip matchmaking, go straight to game
    if (user.id === 'dev') {
      setSearching(true)
      setSearchTime(0)
      setTimeout(() => {
        setSearching(false)
        sound.gameStart()
        const devRoute = game.id === 'blackjack' ? '/blackjack' : game.id === 'sequence' ? '/sequence' : game.id === 'reaction' ? '/reaction' : game.id === 'hearing' ? '/hearing' : game.id === 'gradient' ? '/gradient' : game.id === 'race' ? '/race' : game.id === 'capitals' ? '/capitals' : game.id === 'circle' ? '/circle' : '/game'
        navigate(`${devRoute}/dev-${game.id}-${selectedStakes[0]}`)
      }, 1500)
      return
    }

    // Cancel any pending game invites before searching
    cancelAllPendingInvites(user.id).catch(() => {})

    // Send all selected stakes — backend tries each one
    const gameType = game.id === 'blackjack' ? 'blackjack' : game.id === 'sequence' ? 'sequence' : game.id === 'reaction' ? 'reaction' : game.id === 'hearing' ? 'hearing' : game.id === 'gradient' ? 'gradient' : game.id === 'race' ? 'race' : game.id === 'capitals' ? 'capitals' : game.id === 'circle' ? 'circle' : 'quiz'
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
      findingRef.current = false
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
      .subscribe((status) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          startBackupMatchPoll(user.id)
        }
      })
    channelRef.current = channel

    // Slow emergency backup only if realtime silently misses an event
    backupPollStartRef.current = setTimeout(() => startBackupMatchPoll(user.id), 15000)

    // Bot timer: подключить бота через 10-20 сек если не нашёл человека
    // Если первая попытка не удалась — повтор через 10с
    if (appSettings?.bot_enabled !== false) {
      const botDelay = (10 + Math.floor(Math.random() * 11)) * 1000
      const tryCreateBot = async (retries = 2) => {
        if (matchFoundRef.current || searchCancelledRef.current) return
        try {
          const res = await createBotDuel(user.id, game.id, selectedStakes, gameType)
          if (matchFoundRef.current || searchCancelledRef.current) return
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
    matchFoundRef.current = false
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
              game.id === 'quiz' ? <QuizIcon /> : sheetCfg.svgIcon ? <span className="sheet-icon-svg">{sheetCfg.svgIcon(accent)}</span> : <span className="sheet-icon-emoji">{sheetCfg.icon}</span>
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
    <div className={`friends-avatar-wrap ${user.is_pro ? 'pro-avatar-frame' : ''}`}>
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
  const [carouselIndex, setCarouselIndex] = useState(0)
  const [carouselDrag, setCarouselDrag] = useState(0)
  const [carouselDragging, setCarouselDragging] = useState(false)
  const carouselTouchStartX = useRef(0)
  const carouselTouchStartY = useRef(0)
  const carouselLockedAxis = useRef(null) // 'x' | 'y' | null
  const debounceRef = useRef(null)

  // Available games list (stable order) — memo-free since GAMES is module-level constant
  const carouselGames = GAMES.filter(g => g.available)

  // When invite sheet opens for a new friend, reset to first game and pre-select it
  useEffect(() => {
    if (inviteTarget) {
      setCarouselIndex(0)
      setInviteGame(carouselGames[0]?.id ?? null)
    }
  }, [inviteTarget?.id])

  function goToCarousel(i) {
    const len = carouselGames.length
    if (!len) return
    const next = ((i % len) + len) % len
    setCarouselIndex(next)
    setInviteGame(carouselGames[next].id)
    haptic('light')
  }

  function onCarouselTouchStart(e) {
    carouselTouchStartX.current = e.touches[0].clientX
    carouselTouchStartY.current = e.touches[0].clientY
    carouselLockedAxis.current = null
    setCarouselDrag(0)
    setCarouselDragging(true)
  }
  function onCarouselTouchMove(e) {
    const dx = e.touches[0].clientX - carouselTouchStartX.current
    const dy = e.touches[0].clientY - carouselTouchStartY.current
    if (carouselLockedAxis.current === null) {
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
        carouselLockedAxis.current = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
      }
    }
    if (carouselLockedAxis.current === 'x') {
      e.preventDefault?.()
      setCarouselDrag(dx)
    }
  }
  function onCarouselTouchEnd() {
    setCarouselDragging(false)
    if (carouselLockedAxis.current === 'x') {
      const threshold = 50
      if (carouselDrag > threshold) goToCarousel(carouselIndex - 1)
      else if (carouselDrag < -threshold) goToCarousel(carouselIndex + 1)
    }
    setCarouselDrag(0)
    carouselLockedAxis.current = null
  }

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [])

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
      sound.gameStart()
      const route = inv.game_type === 'blackjack' ? '/blackjack' : inv.game_type === 'sequence' ? '/sequence' : inv.game_type === 'reaction' ? '/reaction' : inv.game_type === 'hearing' ? '/hearing' : inv.game_type === 'gradient' ? '/gradient' : inv.game_type === 'race' ? '/race' : inv.game_type === 'capitals' ? '/capitals' : inv.game_type === 'circle' ? '/circle' : '/game'
      navigate(`${route}/${result.duel_id}`)
    } else if (result?.error) {
      haptic('error')
      // Remove invite from list if it's no longer valid
      if (['invite_expired', 'sender_offline', 'sender_in_game', 'invite_not_pending'].includes(result.error)) {
        setGameInvites(gameInvites.filter(i => i.id !== inv.id))
      }
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
              const gameData = GAMES.find(g => g.id === inv.game_type) || GAMES[0]
              const gameCfg = GAME_SHEETS[inv.game_type] || GAME_SHEETS.quiz
              const gameIcon = gameCfg.svgIcon ? gameCfg.svgIcon(gameData.accent) : gameCfg.icon
              const gameLabel = t[gameData.titleKey] || inv.game_type
              return (
                <div key={inv.id} className="friends-row friends-invite-row" style={{ '--row-accent': gameData.accent }}>
                  <FriendAvatar user={sender || { first_name: '?' }} showOnline />
                  <div className="friends-info">
                    <span className="friends-name">{sender?.first_name || '?'}{sender?.is_pro && <span className="pro-user-badge pro-user-badge--sm">PRO</span>}</span>
                  </div>
                  {!expired ? (
                    <div className="friends-req-actions">
                      {acceptError === inv.id ? (
                        <span className="friends-invite-error">{t.inviteError || 'Ошибка'}</span>
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
                  <div className="invite-meta-wrap">
                    <span className="invite-meta-pill" style={{ '--pill-accent': gameData.accent }}>
                      <span className="invite-meta-icon">{gameIcon}</span>
                      <span className="invite-meta-name">{gameLabel}</span>
                      <span className="invite-meta-sep" />
                      <span className="invite-meta-stake">{formatCurrency(inv.stake, currency, rates)}</span>
                    </span>
                  </div>
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
                  <span className="friends-name">{req.from_user.first_name}{req.from_user.is_pro && <span className="pro-user-badge pro-user-badge--sm">PRO</span>}</span>
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
                          <span className="friends-name">{f.first_name}{f.is_pro && <span className="pro-user-badge pro-user-badge--sm">PRO</span>}</span>
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
                          <span className="friends-name">{f.first_name}{f.is_pro && <span className="pro-user-badge pro-user-badge--sm">PRO</span>}</span>
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
                      <span className="friends-name">{u.first_name}{u.is_pro && <span className="pro-user-badge pro-user-badge--sm">PRO</span>}</span>
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
            <div className="invite-carousel">
              <button
                className="invite-carousel-arrow left"
                onClick={() => goToCarousel(carouselIndex - 1)}
                aria-label="prev"
                type="button"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </button>
              <div
                className="invite-carousel-viewport"
                onTouchStart={onCarouselTouchStart}
                onTouchMove={onCarouselTouchMove}
                onTouchEnd={onCarouselTouchEnd}
                onTouchCancel={onCarouselTouchEnd}
              >
                <div
                  className="invite-carousel-track"
                  style={{
                    transform: `translateX(calc(${-carouselIndex * 100}% + ${carouselDrag}px))`,
                    transition: carouselDragging ? 'none' : 'transform 0.35s cubic-bezier(0.32, 0.72, 0, 1)',
                  }}
                >
                  {carouselGames.map((g, i) => {
                    const cfg = GAME_SHEETS[g.id]
                    const isActive = i === carouselIndex
                    return (
                      <div key={g.id} className="invite-carousel-slide">
                        <div
                          className={`invite-carousel-card ${isActive ? 'active' : ''}`}
                          style={{
                            '--game-accent': g.accent,
                            '--game-shadow': g.shadow,
                          }}
                        >
                          <div className="invite-carousel-glow" />
                          <div className="invite-carousel-icon">
                            {cfg?.svgIcon
                              ? cfg.svgIcon(g.accent)
                              : <span className="invite-carousel-emoji">{cfg?.icon}</span>}
                          </div>
                          <div className="invite-carousel-title">{t[g.titleKey]}</div>
                          {t[g.subKey] && <div className="invite-carousel-sub">{t[g.subKey]}</div>}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
              <button
                className="invite-carousel-arrow right"
                onClick={() => goToCarousel(carouselIndex + 1)}
                aria-label="next"
                type="button"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </button>
            </div>
            <div className="invite-carousel-dots">
              {carouselGames.map((g, i) => (
                <button
                  key={g.id}
                  type="button"
                  className={`invite-carousel-dot ${i === carouselIndex ? 'active' : ''}`}
                  style={i === carouselIndex ? { background: g.accent, boxShadow: `0 0 8px ${g.accent}80` } : undefined}
                  onClick={() => goToCarousel(i)}
                  aria-label={t[g.titleKey]}
                />
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
    svgIcon: (color) => <svg width="28" height="28" viewBox="0 0 24 24" fill="none"><path d="M9 21h6M12 17v4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M10 12h4M12 10v4" stroke={color} strokeWidth="1.5" strokeLinecap="round"/></svg>,
    stats: [
      { val: '3', lblKey: 'sheetSeqRounds' },
      { val: '10', lblKey: 'sheetSeqTime' },
      { val: '1v1', lblKey: 'sheetStatMode' },
    ],
    ruleKeys: ['sheetSeqRule1', 'sheetSeqRule2', 'sheetSeqRule3'],
  },
  blackjack: {
    icon: '🃏',
    svgIcon: (color) => <svg width="28" height="28" viewBox="0 0 24 24" fill="none"><rect x="3" y="2" width="18" height="20" rx="3" stroke={color} strokeWidth="2"/><path d="M8 6h2M14 18h2" stroke={color} strokeWidth="2" strokeLinecap="round"/><path d="M12 9l-2 3h4l-2 3" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>,
    stats: [
      { val: '16', lblKey: 'sheetBjCards' },
      { val: '21', lblKey: 'sheetBjTarget' },
      { val: '1v1', lblKey: 'sheetStatMode' },
    ],
    ruleKeys: ['sheetBjRule1', 'sheetBjRule2', 'sheetBjRule3'],
  },
  reaction: {
    icon: '⚡',
    svgIcon: (color) => <svg width="28" height="28" viewBox="0 0 24 24" fill="none"><path d="M13 2L4 14h7l-2 8 9-12h-7l2-8z" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>,
    stats: [
      { val: '5', lblKey: 'sheetReactRounds' },
      { val: '~3', lblKey: 'sheetReactTime' },
      { val: '1v1', lblKey: 'sheetStatMode' },
    ],
    ruleKeys: ['sheetReactRule1', 'sheetReactRule2', 'sheetReactRule3'],
  },
  hearing: {
    icon: '🎶',
    svgIcon: (color) => <svg width="28" height="28" viewBox="0 0 24 24" fill="none"><path d="M9 18V5l12-2v13" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><circle cx="6" cy="18" r="3" stroke={color} strokeWidth="2"/><circle cx="18" cy="16" r="3" stroke={color} strokeWidth="2"/></svg>,
    stats: [
      { val: '5', lblKey: 'sheetHearRounds' },
      { val: '3', lblKey: 'sheetHearTime' },
      { val: '1v1', lblKey: 'sheetStatMode' },
    ],
    ruleKeys: ['sheetHearRule1', 'sheetHearRule2', 'sheetHearRule3'],
  },
  gradient: {
    icon: '🌈',
    svgIcon: (color) => <svg width="28" height="28" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke={color} strokeWidth="2"/><circle cx="9" cy="10" r="3" stroke={color} strokeWidth="1.5" opacity="0.6"/><circle cx="15" cy="10" r="3" stroke={color} strokeWidth="1.5" opacity="0.6"/><circle cx="12" cy="15" r="3" stroke={color} strokeWidth="1.5" opacity="0.6"/></svg>,
    stats: [
      { val: '5', lblKey: 'sheetGradRounds' },
      { val: '2', lblKey: 'sheetGradTime' },
      { val: '1v1', lblKey: 'sheetStatMode' },
    ],
    ruleKeys: ['sheetGradRule1', 'sheetGradRule2', 'sheetGradRule3'],
  },
  race: {
    icon: '🏎',
    svgIcon: (color) => <svg width="28" height="28" viewBox="0 0 24 24" fill="none"><path d="M4 15l2-6h12l2 6" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/><path d="M2 15h20v2a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-2z" stroke={color} strokeWidth="2"/><circle cx="7" cy="19" r="2" stroke={color} strokeWidth="1.5"/><circle cx="17" cy="19" r="2" stroke={color} strokeWidth="1.5"/><path d="M14 9V6M10 9V7" stroke={color} strokeWidth="1.5" strokeLinecap="round"/></svg>,
    stats: [
      { val: '1', lblKey: 'sheetRaceRounds' },
      { val: '~15', lblKey: 'sheetRaceTime' },
      { val: '1v1', lblKey: 'sheetStatMode' },
    ],
    ruleKeys: ['sheetRaceRule1', 'sheetRaceRule2', 'sheetRaceRule3'],
  },
  capitals: {
    icon: '🌍',
    svgIcon: (color) => <svg width="28" height="28" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="13" r="8" stroke={color} strokeWidth="2"/><path d="M3 13h16" stroke={color} strokeWidth="1.3" opacity="0.65"/><path d="M11 5a11 11 0 0 1 0 16a11 11 0 0 1 0-16z" stroke={color} strokeWidth="1.3" opacity="0.65"/><path d="M18 2c1.7 0 3 1.3 3 3s-3 5-3 5-3-3.3-3-5 1.3-3 3-3z" fill={color} stroke={color} strokeWidth="1.5" strokeLinejoin="round"/><circle cx="18" cy="5" r="1" fill="#fff"/></svg>,
    stats: [
      { val: '3', lblKey: 'sheetCapRounds' },
      { val: '15', lblKey: 'sheetCapTime' },
      { val: '1v1', lblKey: 'sheetStatMode' },
    ],
    ruleKeys: ['sheetCapRule1', 'sheetCapRule2', 'sheetCapRule3'],
  },
  circle: {
    icon: '⭕',
    svgIcon: (color) => <svg width="28" height="28" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke={color} strokeWidth="2" strokeDasharray="3 3"/><circle cx="12" cy="12" r="5" stroke={color} strokeWidth="1.5" opacity="0.55"/><circle cx="12" cy="12" r="1.6" fill={color}/></svg>,
    stats: [
      { val: '3', lblKey: 'sheetCircleRounds' },
      { val: '10', lblKey: 'sheetCircleTime' },
      { val: '1v1', lblKey: 'sheetStatMode' },
    ],
    ruleKeys: ['sheetCircleRule1', 'sheetCircleRule2', 'sheetCircleRule3'],
  },
}

const GAMES = [
  { id: 'quiz', titleKey: 'gameQuizTitle', subKey: 'gameQuizSub', available: true, accent: '#3B82F6', shadow: '#1d3461', art: GAME_CARD_ART.quiz },
  { id: 'sequence', titleKey: 'gameSequenceTitle', subKey: 'gameSequenceSub', available: true, accent: '#8B5CF6', shadow: '#2d1b69', art: GAME_CARD_ART.sequence },
  { id: 'blackjack', titleKey: 'gameBlackjackTitle', subKey: 'gameBlackjackSub', available: true, accent: '#F59E0B', shadow: '#78350f', art: GAME_CARD_ART.blackjack },
  { id: 'reaction', titleKey: 'gameReactionTitle', subKey: 'gameReactionSub', available: true, accent: '#10B981', shadow: '#064e3b', art: GAME_CARD_ART.reaction },
  { id: 'hearing', titleKey: 'gameHearingTitle', subKey: 'gameHearingSub', available: true, accent: '#EC4899', shadow: '#831843', art: GAME_CARD_ART.hearing },
  { id: 'gradient', titleKey: 'gameGradientTitle', subKey: 'gameGradientSub', available: true, accent: '#F43F5E', shadow: '#881337', art: GAME_CARD_ART.gradient },
  { id: 'capitals', titleKey: 'gameCapitalsTitle', subKey: 'gameCapitalsSub', available: true, accent: '#06B6D4', shadow: '#0e4a63', art: GAME_CARD_ART.capitals },
  { id: 'circle', titleKey: 'gameCircleTitle', subKey: 'gameCircleSub', available: true, accent: '#A855F7', shadow: '#581c87', art: GAME_CARD_ART.circle },
]

// Per-game ranges for the "fake" online boost so the displayed counter
// always feels alive even when matchmaking is empty. Quiz tops the list
// because it's the flagship game; less popular ones get a smaller crowd.
const FAKE_ONLINE_RANGES = {
  quiz:      [55, 110],
  sequence:  [30, 70],
  blackjack: [35, 75],
  reaction:  [40, 85],
  hearing:   [25, 60],
  gradient:  [25, 55],
  race:      [30, 65],
  capitals:  [25, 55],
  circle:    [20, 50],
}

function strHash32(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

// One slot rolls every 3 minutes — matches the front-end refresh cadence
// so each refresh shows a fresh number (the "+52 → +39 → +64" feel the
// user described), without flicker between refreshes.
function fakeOnlineFor(gameId, now = Date.now()) {
  const range = FAKE_ONLINE_RANGES[gameId] || [20, 50]
  const span = range[1] - range[0]
  const slot = Math.floor(now / 180000) // 3 minutes
  const seed = strHash32(`${gameId}|${slot}`)
  return range[0] + (seed % span)
}

const SLOTS = [
  {
    id: 'tower-stack',
    category: 'quick',
    titleKey: 'slotTowerTitle',
    subKey: 'slotTowerSub',
    route: '/slots/tower-stack',
    accent: '#f59e0b',
    shadow: '#7c2d12',
  },
  {
    id: 'rocket',
    category: 'quick',
    titleKey: 'slotRocketTitle',
    subKey: 'slotRocketSub',
    route: '/slots/rocket',
    accent: '#ec4899',
    shadow: '#581c87',
  },
  {
    id: 'plinko',
    category: 'quick',
    titleKey: 'slotPlinkoTitle',
    subKey: 'slotPlinkoSub',
    route: '/slots/plinko',
    accent: '#a855f7',
    shadow: '#4c1d95',
  },
  {
    id: 'stardew-spins',
    category: 'popular',
    titleKey: 'slotStardewTitle',
    subKey: 'slotStardewSub',
    route: '/slots/stardew-spins',
    // Stardew Valley palette — sunlit pasture green over an
    // earthy tilled-soil brown for the shadow.
    accent: '#7CB342',
    shadow: '#4A2F1A',
  },
  {
    id: 'pixel-mine',
    category: 'popular',
    titleKey: 'slotPixelMineTitle',
    subKey: 'slotPixelMineSub',
    route: '/slots/pixel-mine',
    accent: '#84cc16',
    shadow: '#3f6212',
  },
  {
    id: 'dice',
    category: 'quick',
    titleKey: 'slotDiceTitle',
    subKey: 'slotDiceSub',
    route: '/slots/dice',
    accent: '#22c55e',
    shadow: '#14532d',
  },
  {
    id: 'magnetic',
    category: 'popular',
    titleKey: 'slotMagneticTitle',
    subKey: 'slotMagneticSub',
    route: '/slots/magnetic',
    accent: '#a78bfa',
    shadow: '#4c1d95',
  },
  {
    id: 'tetris-cascade',
    category: 'popular',
    titleKey: 'slotTetrisTitle',
    subKey: 'slotTetrisSub',
    route: '/slots/tetris-cascade',
    accent: '#6366f1',
    shadow: '#312e81',
  },
]

function TowerSlotArtwork({ large = false, animated = false }) {
  return (
    <div className={`tower-slot-card-art ${large ? 'tower-slot-card-art--large' : ''} ${animated ? 'tower-slot-card-art--animated' : ''}`} aria-hidden="true">
      <span className="tower-slot-art-sun" />
      <span className="tower-slot-art-cloud tower-slot-art-cloud--one" />
      <span className="tower-slot-art-cloud tower-slot-art-cloud--two" />
      <span className="tower-slot-art-cloud tower-slot-art-cloud--three" />

      <span className="tower-slot-art-rail" />
      <span className="tower-slot-art-crane">
        <span className="tower-slot-art-crane-window" />
      </span>
      <span className="tower-slot-art-cable" />
      <span className="tower-slot-art-hook" />

      {/* Hanging house (the one the crane is dropping) */}
      <span className="tower-slot-art-house tower-slot-art-house--drop tower-slot-art-house--cottage tower-slot-art-house--amber">
        <span className="tower-slot-art-roof tower-slot-art-roof--peaked" />
        <span className="tower-slot-art-house-body">
          <span className="tower-slot-art-window" />
          <span className="tower-slot-art-door" />
        </span>
      </span>

      {/* Stack of two houses on the ground */}
      <span className="tower-slot-art-stack">
        <span className="tower-slot-art-house tower-slot-art-house--base tower-slot-art-house--apartment tower-slot-art-house--blue">
          <span className="tower-slot-art-roof tower-slot-art-roof--flat" />
          <span className="tower-slot-art-house-body">
            <span className="tower-slot-art-window tower-slot-art-window--apt tower-slot-art-window--tl" />
            <span className="tower-slot-art-window tower-slot-art-window--apt tower-slot-art-window--tr" />
            <span className="tower-slot-art-window tower-slot-art-window--apt tower-slot-art-window--bl" />
            <span className="tower-slot-art-window tower-slot-art-window--apt tower-slot-art-window--br" />
          </span>
        </span>
        <span className="tower-slot-art-house tower-slot-art-house--mid tower-slot-art-house--cottage tower-slot-art-house--green">
          <span className="tower-slot-art-roof tower-slot-art-roof--peaked tower-slot-art-roof--green" />
          <span className="tower-slot-art-house-body">
            <span className="tower-slot-art-window" />
            <span className="tower-slot-art-door" />
          </span>
        </span>
      </span>

      <span className="tower-slot-art-grass" />
    </div>
  )
}

function TetrisSlotArtwork({ large = false, animated = false }) {
  // Static "frozen mid-cascade" snapshot — 10x6 grid with a few tetromino
  // colors filling the lower half so the card immediately reads as Tetris.
  // Cells are addressed left-to-right, bottom-to-top via grid-area helpers.
  const cells = [
    // bottom row — almost-full line about to clear
    { c: 'cyan',   x: 0, y: 5, w: 4, h: 1 },     // I horizontal
    { c: 'orange', x: 4, y: 5, w: 1, h: 1 },
    { c: 'orange', x: 5, y: 5, w: 1, h: 1 },
    { c: 'green',  x: 6, y: 5, w: 1, h: 1 },
    { c: 'green',  x: 7, y: 5, w: 1, h: 1 },
    { c: 'red',    x: 8, y: 5, w: 1, h: 1 },
    // 2nd from bottom
    { c: 'yellow', x: 0, y: 4, w: 2, h: 1 },
    { c: 'yellow', x: 2, y: 4, w: 2, h: 1 },
    { c: 'purple', x: 5, y: 4, w: 1, h: 1 },
    { c: 'purple', x: 6, y: 4, w: 1, h: 1 },
    { c: 'red',    x: 7, y: 4, w: 1, h: 1 },
    // 3rd row, scattered
    { c: 'blue',   x: 1, y: 3, w: 1, h: 1 },
    { c: 'green',  x: 4, y: 3, w: 1, h: 1 },
    { c: 'orange', x: 8, y: 3, w: 1, h: 1 },
    // falling pieces near top
    { c: 'cyan',   x: 3, y: 1, w: 1, h: 1 },
    { c: 'purple', x: 7, y: 0, w: 2, h: 1 },
  ]
  return (
    <div className={`tetris-slot-card-art ${large ? 'tetris-slot-card-art--large' : ''} ${animated ? 'tetris-slot-card-art--animated' : ''}`} aria-hidden="true">
      <span className="tetris-slot-art-glow" />
      <div className="tetris-slot-art-grid">
        {/* Empty grid background — 60 faint cells showing the playfield. */}
        {Array.from({ length: 60 }).map((_, i) => (
          <span
            key={`bg-${i}`}
            className="tetris-slot-art-bg-cell"
            style={{
              gridColumn: (i % 10) + 1,
              gridRow: Math.floor(i / 10) + 1,
            }}
          />
        ))}
        {/* Colored tetromino cells. In animated mode each one gets a
            staggered delay so the playfield slowly fills, holds, then
            flashes a clear and starts over. */}
        {cells.map((c, i) => (
          <span
            key={i}
            className={`tetris-slot-art-cell tetris-slot-art-cell--${c.c}`}
            style={{
              gridColumn: `${c.x + 1} / span ${c.w}`,
              gridRow: `${c.y + 1} / span ${c.h}`,
              ...(animated ? { animationDelay: `${i * 0.22}s` } : {}),
            }}
          />
        ))}
      </div>
    </div>
  )
}

// Rocket Slot — Aviator-style crash card art. Static "frozen mid-flight"
// scene: night sky with moon and planet, dense star field, curved exhaust
// trail rising from the planet to the rocket in the upper-right corner.
// Animated variant adds slow rocket bob + flame flicker + trail pulse
// for the preview modal.
function RocketSlotArtwork({ large = false, animated = false }) {
  return (
    <div className={`rocket-slot-card-art ${large ? 'rocket-slot-card-art--large' : ''} ${animated ? 'rocket-slot-card-art--animated' : ''}`} aria-hidden="true">
      {/* Sky / nebula glow */}
      <span className="rocket-slot-art-nebula" />

      {/* Moon top-right */}
      <span className="rocket-slot-art-moon">
        <span className="rocket-slot-art-moon-crater rocket-slot-art-moon-crater--a" />
        <span className="rocket-slot-art-moon-crater rocket-slot-art-moon-crater--b" />
        <span className="rocket-slot-art-moon-crater rocket-slot-art-moon-crater--c" />
      </span>

      {/* Star field — mix of sizes for depth */}
      <span className="rocket-slot-art-stars">
        <span className="rocket-slot-art-star rocket-slot-art-star--1" />
        <span className="rocket-slot-art-star rocket-slot-art-star--2" />
        <span className="rocket-slot-art-star rocket-slot-art-star--3" />
        <span className="rocket-slot-art-star rocket-slot-art-star--4" />
        <span className="rocket-slot-art-star rocket-slot-art-star--5" />
        <span className="rocket-slot-art-star rocket-slot-art-star--6" />
        <span className="rocket-slot-art-star rocket-slot-art-star--7" />
        <span className="rocket-slot-art-star rocket-slot-art-star--8" />
        <span className="rocket-slot-art-star rocket-slot-art-star--9" />
      </span>

      {/* Planet at bottom-left — the world the rocket is leaving behind. */}
      <span className="rocket-slot-art-planet">
        <span className="rocket-slot-art-planet-stripe" />
      </span>

      {/* Rocket — sits between the planet (bottom-left) and the moon
          (top-right), tilted so its nose points up-right toward the
          moon. Animated bob in the preview modal keeps the rotation. */}
      <span className="rocket-slot-art-rocket">
        <span className="rocket-slot-art-flame" />
        <svg viewBox="0 0 28 40" width="100%" height="100%" aria-hidden="true">
          <defs>
            <linearGradient id="rkt-art-body" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"  stopColor="#fef3c7" />
              <stop offset="100%" stopColor="#fb7185" />
            </linearGradient>
          </defs>
          <path d="M14 1.5 C20 7 22 14 22 22 L22 30 L6 30 L6 22 C6 14 8 7 14 1.5 Z"
                fill="url(#rkt-art-body)" stroke="#9f1239" strokeWidth="1.1" />
          <circle cx="14" cy="14.5" r="3.4" fill="#0ea5e9" stroke="#082f49" strokeWidth="1" />
          <circle cx="13" cy="13.5" r="0.9" fill="#bae6fd" />
          <path d="M6 24 L1 33 L6 31 Z" fill="#fb7185" stroke="#9f1239" strokeWidth="0.7" />
          <path d="M22 24 L27 33 L22 31 Z" fill="#fb7185" stroke="#9f1239" strokeWidth="0.7" />
          <rect x="6" y="28" width="16" height="2" fill="#9f1239" />
        </svg>
      </span>
    </div>
  )
}

// Plinko card art — triangular peg field with a "frozen mid-flight" ball
// and a row of multiplier slots at the bottom. Animated variant adds a
// soft pulse on the ball + slot lights.
function PlinkoSlotArtwork({ large = false, animated = false }) {
  // 6 visible peg rows for the card preview (real game uses 12 rows).
  const ROWS_PREVIEW = 6
  const pegs = []
  for (let r = 0; r < ROWS_PREVIEW; r++) {
    const pegsInRow = r + 2
    for (let p = 0; p < pegsInRow; p++) {
      // x in 0..1 across the card, centred
      const x = 0.5 + (p - (r + 1) / 2) / (ROWS_PREVIEW + 1)
      const y = (r + 1) / (ROWS_PREVIEW + 2.5)
      pegs.push({ key: `${r}-${p}`, x, y })
    }
  }
  // 7 multiplier slots at bottom (representative subset)
  const slots = ['×9', '×2', '×1', '×0.5', '×1', '×2', '×9']
  return (
    <div className={`plinko-slot-card-art ${large ? 'plinko-slot-card-art--large' : ''} ${animated ? 'plinko-slot-card-art--animated' : ''}`} aria-hidden="true">
      <span className="plinko-card-glow" />
      <div className="plinko-card-pegs">
        {pegs.map((p, i) => (
          <span
            key={p.key}
            className="plinko-card-peg"
            style={{
              left: `${p.x * 100}%`,
              top:  `${p.y * 100}%`,
              ...(animated ? { animationDelay: `${(i % 9) * 0.12}s` } : {}),
            }}
          />
        ))}
      </div>
      {/* Frozen ball mid-bounce, slightly off-centre to suggest motion */}
      <span className="plinko-card-ball" />
      <div className="plinko-card-slots">
        {slots.map((s, i) => {
          // Tone class (hot/warm/cold) mirrors the in-game palette.
          // Slot 6 (rightmost ×9) is also flagged as the bounce
          // animation's landing target so its pop stays in sync
          // with the ball's arrival.
          const tone = i === 0 || i === slots.length - 1
            ? 'hot'
            : (Math.abs(i - 3) <= 1 ? 'cold' : 'warm')
          const isTarget = i === slots.length - 1
          return (
            <span
              key={i}
              className={
                'plinko-card-slot' +
                ' plinko-card-slot--' + tone +
                (isTarget ? ' plinko-card-slot--target' : '')
              }
            >
              {s}
            </span>
          )
        })}
      </div>
    </div>
  )
}

// Pixel Mine card art — mirrors the actual Mine Slot:
//   - Minecraft sky-blue background with a single drifting cloud
//   - 3-cell reel strip on top showing a wood pickaxe + TNT + Eye
//     of Ender (the iconic symbols)
//   - 4-block mining column underneath: grass → stone → diamond →
//     obsidian (the "skyline" that makes the slot read at a glance)
//   - Wooden chest at the bottom
//   - "PIXEL MINE" label across the very bottom
// The animated variant runs a wood-pickaxe drop loop above the grid
// (rotates + falls + bounces) so the card flickers with motion when
// hovered or shown in the preview modal.
// 8-second loop driven by JS state (NOT CSS keyframes) so
// background-image swaps go through React re-render → DOM raster
// path. CSS @keyframes on `background-image` was triggering layer
// promotion in some browsers (the LEFT-column textures looked
// blurry while the right-column static blocks stayed crisp). The
// in-game slot uses the exact same approach — JS state drives
// inline style.backgroundImage, no CSS animation involved.
//
// Times are in milliseconds within the 0..8000 ms loop:
const PM_LOOP = 8000
// Strike landing times (each = pickaxe hits a block at that ms)
const PM_STRIKES = {
  grass:  320,
  stone1: 960,
  stone2: 1600,
  gold1:  2080,
  gold2:  2560,
  gold3:  3040,
  gold4:  3520,
  gold5:  4000,
}
// Chest + 100x reveal timings
const PM_CHEST_OPEN_AT = 4800   // chest swaps to opened texture
const PM_MUL_POP_AT    = 5120   // "100x" text starts rising
const PM_MUL_HOLD_AT   = 5440   // settled position
const PM_MUL_FADE_AT   = 7040   // start fading out
const PM_MUL_GONE_AT   = 7600   // fully gone

// Hand-drawn fluffy cloud silhouettes. Each `shape` is a multi-
// bump SVG path designed to read as an actual cloud — multiple
// rounded humps along the top, flat-ish base, soft side curves.
// viewBox 120 × 50 → the parent CSS sets the cloud's % size /
// position on the card and SVG scales the path to fit.
const PM_CLOUD_SHAPES = {
  // Three bumps, medium silhouette.
  medium: 'M 14 44 C 2 44 2 28 14 26 C 14 8 32 6 38 22 C 46 6 64 6 70 22 C 80 14 100 18 100 30 C 112 30 114 44 102 44 Z',
  // Four bumps, longer/wider silhouette.
  wide:   'M 10 44 C 0 44 0 28 10 26 C 8 12 26 8 32 22 C 38 4 56 4 62 22 C 68 6 86 8 90 24 C 100 18 116 24 116 36 C 116 44 108 44 100 44 Z',
  // Two bumps, smaller / chunkier cloud.
  small:  'M 18 42 C 4 42 4 24 18 22 C 22 6 44 6 50 22 C 60 14 78 18 82 30 C 96 28 96 42 84 42 Z',
}

function CardCloud({ variant, shape }) {
  return (
    <svg
      className={`pixel-mine-card-cloud pixel-mine-card-cloud--${variant}`}
      viewBox="0 0 120 50"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path d={PM_CLOUD_SHAPES[shape]} fill="#fff" />
    </svg>
  )
}

function PixelMineSlotArtwork({ large = false, animated = false }) {
  // Single ms-based phase counter (0..PM_LOOP). Updated via rAF when
  // animated; stays at 0 otherwise. Re-renders update inline style
  // properties only (no DOM structure changes), which React batches
  // efficiently.
  const [phase, setPhase] = useState(0)

  useEffect(() => {
    if (!animated) return
    const start = Date.now()
    let raf
    const tick = () => {
      setPhase((Date.now() - start) % PM_LOOP)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [animated])

  // ── Derive every visual state from `phase` ──
  // Block textures: each block holds its base texture until the
  // strike that destroys / damages it lands. After the killing
  // strike the bg goes to `null` (sky shows through).
  const showStaticGrass = !animated || phase < PM_STRIKES.grass + 160
  const grassTex = showStaticGrass ? pmTexGrass : null

  let stoneTex
  if (!animated || phase < PM_STRIKES.stone1) stoneTex = pmTexStone
  else if (phase < PM_STRIKES.stone2 + 160) stoneTex = pmTexStoneDmg1
  else stoneTex = null

  let goldTex
  if (!animated || phase < PM_STRIKES.gold1) goldTex = pmTexGold
  else if (phase < PM_STRIKES.gold2) goldTex = pmTexGoldDmg1
  else if (phase < PM_STRIKES.gold3) goldTex = pmTexGoldDmg2
  else if (phase < PM_STRIKES.gold4) goldTex = pmTexGoldDmg3
  else if (phase < PM_STRIKES.gold5 + 160) goldTex = pmTexGoldDmg4
  else goldTex = null

  // Chest texture — closed until the reveal point.
  const chestTex = (!animated || phase < PM_CHEST_OPEN_AT)
    ? pmTexChest
    : pmTexChestOpen

  // 100x multiplier text — opacity / position / scale.
  let mulOpacity = 0
  let mulY = 20      // % shift down at rest
  let mulScale = 0.5
  if (animated) {
    if (phase >= PM_MUL_POP_AT && phase < PM_MUL_HOLD_AT) {
      // pop in
      const t = (phase - PM_MUL_POP_AT) / (PM_MUL_HOLD_AT - PM_MUL_POP_AT)
      mulOpacity = t
      mulY = 20 - 35 * t       // 20 → -15
      mulScale = 0.5 + 0.65 * t // 0.5 → 1.15
    } else if (phase >= PM_MUL_HOLD_AT && phase < PM_MUL_FADE_AT) {
      // hold steady
      mulOpacity = 1
      mulY = -25
      mulScale = 1
    } else if (phase >= PM_MUL_FADE_AT && phase < PM_MUL_GONE_AT) {
      // fade out
      const t = (phase - PM_MUL_FADE_AT) / (PM_MUL_GONE_AT - PM_MUL_FADE_AT)
      mulOpacity = 1 - t
      mulY = -25 - 25 * t
      mulScale = 1
    }
  }

  // Pickaxe: outer translateY (0 = parked in reel cell, positive =
  // dropping into grid), inner rotation continuous.
  // Every strike has a ~160 ms drop + ~160 ms bounce-up cadence,
  // landing at one of three target Y positions.
  let pickaxeY = 0
  let pickaxeOpacity = 1
  if (animated) {
    // Build a chronological list of [t, y] keypoints and lerp.
    // Y values are % of pickaxe own height (matches the old
    // CSS keyframe; tuned for the top:7% start position).
    //   0   = parked (in reel cell)
    //   110 = grass row hit
    //   220 = stone row hit
    //   330 = gold row hit
    //   -100= off-screen above
    const keys = [
      [0,    0],
      [160,  0],
      [320,  110],   // strike grass
      [640,  0],     // bounce
      [960,  220],   // strike stone 1
      [1280, 110],   // bounce
      [1600, 220],   // strike stone 2
      [1840, 110],   // bounce
      [2080, 330],   // strike gold 1
      [2320, 220],
      [2560, 330],   // strike gold 2
      [2800, 220],
      [3040, 330],   // strike gold 3
      [3280, 220],
      [3520, 330],   // strike gold 4
      [3760, 220],
      [4000, 330],   // strike gold 5
      [4480, -100],  // rise + fade
      [PM_LOOP - 1, -100],
    ]
    // Find the segment containing `phase` and lerp.
    for (let i = 0; i < keys.length - 1; i++) {
      const [t0, y0] = keys[i]
      const [t1, y1] = keys[i + 1]
      if (phase >= t0 && phase <= t1) {
        const t = t1 === t0 ? 0 : (phase - t0) / (t1 - t0)
        pickaxeY = y0 + (y1 - y0) * t
        break
      }
    }
    // Opacity: visible until 4480 ms (start of off-screen rise),
    // fades out 4480→4640.
    if (phase < 4480) pickaxeOpacity = 1
    else if (phase < 4640) pickaxeOpacity = 1 - (phase - 4480) / 160
    else pickaxeOpacity = 0
  }
  // Continuous rotation — 1 turn per second through the whole loop.
  const pickaxeRot = animated ? (phase * 0.36) % 360 : 0

  // Reel cell wood texture: only visible while pickaxe is parked
  // (phase < 240) so it looks like the slot "fired" the pickaxe out.
  const woodCellVisible = !animated || phase < 240

  return (
    <div className={`pixel-mine-slot-card-art ${large ? 'pixel-mine-slot-card-art--large' : ''} ${animated ? 'pixel-mine-slot-card-art--animated' : ''}`} aria-hidden="true">
      <span className="pixel-mine-card-sky" />

      {/* Pixel-art sun in the top-right corner. */}
      <span className="pixel-mine-card-sun" />

      {/* Five hand-drawn fluffy clouds scattered across the sky.
       * Each is an inline SVG path with multiple bumps so the
       * silhouette reads as a real cloud (not a pill with dots
       * stapled on top). Static on the thumbnail; the drift
       * keyframes only fire under `--animated`. */}
      <CardCloud variant="a" shape="medium" />
      <CardCloud variant="b" shape="wide" />
      <CardCloud variant="c" shape="small" />
      <CardCloud variant="d" shape="wide" />
      <CardCloud variant="e" shape="medium" />

      {/* Ground strip at the very bottom — grass + dirt, sits behind
       * the chests row so the chests read as standing on real soil. */}
      <span className="pixel-mine-card-ground" />

      {/* Inventory-slot reel strip — 3 square cells with the slot's
       * iconic symbols. The wood cell goes empty when the pickaxe
       * leaves it (drops out of the slot). */}
      <div className="pixel-mine-card-reels">
        <span
          className="pixel-mine-card-reel-cell"
          data-sym="wood"
          style={{ backgroundImage: woodCellVisible ? undefined : 'none' }}
        />
        <span className="pixel-mine-card-reel-cell" data-sym="tnt" />
        <span className="pixel-mine-card-reel-cell" data-sym="ender" />
      </div>

      {/* Wood pickaxe — drops from the LEFT reel cell into the LEFT
       * column. Outer wrapper handles vertical position + opacity,
       * inner sprite handles the rotation. Same two-element split
       * as the in-game .pixel-mine-falling-pickaxe so the bitmap
       * stays pixel-aligned through the drop. */}
      {animated && (
        <span
          className="pixel-mine-card-pickaxe-fly"
          style={{
            transform: `translateY(${pickaxeY}%)`,
            opacity: pickaxeOpacity,
          }}
        >
          <span
            className="pixel-mine-card-pickaxe-spin"
            style={{ transform: `rotate(${pickaxeRot}deg)` }}
          />
        </span>
      )}

      <div className="pixel-mine-card-stack-wrap">
        {/* 3×3 mining grid. The LEFT column is the one the pickaxe
         * works through: grass(1HP) → stone(2HP) → gold(5HP), 8
         * strikes total. Other columns stay decorative. When a
         * left-column block is destroyed (texture goes to null),
         * we also drop the inset box-shadow inline so the cell
         * goes fully empty — no ghost border outline left behind. */}
        <div className="pixel-mine-card-grid">
          {/* Row 0 — surface */}
          <span
            className="pixel-mine-card-block"
            data-block="grass"
            style={{
              backgroundImage: grassTex ? `url("${grassTex}")` : 'none',
              boxShadow: grassTex ? undefined : 'none',
            }}
          />
          <span className="pixel-mine-card-block" data-block="grass" />
          <span className="pixel-mine-card-block" data-block="grass" />
          {/* Row 1 — stone band */}
          <span
            className="pixel-mine-card-block"
            data-block="stone"
            style={{
              backgroundImage: stoneTex ? `url("${stoneTex}")` : 'none',
              boxShadow: stoneTex ? undefined : 'none',
            }}
          />
          <span className="pixel-mine-card-block" data-block="redstone" />
          <span className="pixel-mine-card-block" data-block="stone" />
          {/* Row 2 — jackpot tier */}
          <span
            className="pixel-mine-card-block"
            data-block="gold"
            style={{
              backgroundImage: goldTex ? `url("${goldTex}")` : 'none',
              boxShadow: goldTex ? undefined : 'none',
            }}
          />
          <span className="pixel-mine-card-block" data-block="diamond" />
          <span className="pixel-mine-card-block" data-block="obsidian" />
        </div>

        {/* One chest per column; left one opens via inline-style swap. */}
        <div className="pixel-mine-card-chests">
          <span
            className="pixel-mine-card-chest"
            style={{ backgroundImage: `url("${chestTex}")` }}
          />
          <span className="pixel-mine-card-chest" />
          <span className="pixel-mine-card-chest" />
        </div>
      </div>

      {/* "100x" multiplier badge — direct child of the card-art root
       * (NOT inside stack-wrap) so its `top` percentage resolves
       * against the card-art's full height and we can pin it
       * directly above the LEFT chest. The chests row sits at
       * roughly top: 63 % of the card; the badge floats above it
       * at top: 58 % so it reads as "popping out of the chest".
       * Position + opacity driven by inline style from JS phase. */}
      {animated && (
        <span
          className="pixel-mine-card-chest-mul"
          style={{
            opacity: mulOpacity,
            transform: `translate(-50%, ${mulY}%) scale(${mulScale})`,
          }}
        >
          100x
        </span>
      )}
    </div>
  )
}

function DiceSlotArtwork({ large = false, animated = false }) {
  return (
    <div className={`dice-slot-card-art ${large ? 'dice-slot-card-art--large' : ''} ${animated ? 'dice-slot-card-art--animated' : ''}`} aria-hidden="true">
      {/* Scale 0..100 above the bar — small muted numbers like the
       * real slot has. */}
      <div className="dice-card-scale">
        <span>0</span>
        <span>25</span>
        <span>50</span>
        <span>75</span>
        <span>100</span>
      </div>

      {/* Slider bar — dark pill with gray border, thin red/green
       * stripe through the middle, white square handle floating
       * over it. Animated variant rolls the handle back and forth. */}
      <div className="dice-card-bar">
        <span className="dice-card-bar-red" />
        <span className="dice-card-bar-green" />
        <span className="dice-card-handle">
          <span className="dice-card-handle-grip">
            <span /><span /><span />
          </span>
        </span>
      </div>

      {/* Hex 3D cube above the bar. In the animated variant four
       * stacked numbers crossfade so the cube reads as a single
       * cube changing its face every couple of seconds while
       * sliding along the bar. */}
      <div className="dice-card-cube">
        <span className="dice-card-cube-num dice-card-cube-num--1 is-win">62</span>
        {animated && (
          <>
            <span className="dice-card-cube-num dice-card-cube-num--2 is-loss">15</span>
            <span className="dice-card-cube-num dice-card-cube-num--3 is-win">88</span>
            <span className="dice-card-cube-num dice-card-cube-num--4 is-loss">9</span>
          </>
        )}
      </div>
    </div>
  )
}

// Magnetic Slot card art — compact 3-column variant for the home
// card + preview overlay (the real in-game grid is 5×3, but the
// card distills it down so it reads at thumbnail size):
//   - 3 magnets row on top (with mult labels + real magnet.png)
//   - tier ladder behind (2 dashed cells per column: 75 / 50 %)
//   - 3×2 reel grid at the bottom with real pixel-art textures
//
// In the animated variant THREE individual symbols fly out of
// their reel cells and land EXACTLY on a tier badge — col 1
// sends both its symbols (top → 75 %, bottom → 50 %), col 2
// sends only its top symbol → 75 %. They stagger one after
// another and the loop repeats. Col 3 stays static.
function MagneticSlotArtwork({ large = false, animated = false }) {
  const magnets = [25, 100, 50]
  // Each column: 2 symbols top→bottom.
  const cols = [
    { reels: [mgTexBolt,    mgTexCoin]    },
    { reels: [mgTexOrb,     mgTexCompass] },
    { reels: [mgTexGem,     mgTexBolt]    },
  ]
  // Two tier rows packed into the upper half of the column.
  const tiers = [75, 50]
  // Per-symbol flight script. Each entry: which column, which
  // reel cell (ri: 0 = top, 1 = bottom), which texture, which
  // tier %, and when to start (s) within the loop.
  const flies = [
    { col: 0, ri: 0, tex: mgTexBolt, target: 75, delay: 0.0 },
    { col: 0, ri: 1, tex: mgTexCoin, target: 50, delay: 0.5 },
    { col: 1, ri: 0, tex: mgTexOrb,  target: 75, delay: 1.0 },
  ]

  return (
    <div
      className={
        'magnetic-slot-card-art' +
        (large    ? ' magnetic-slot-card-art--large'    : '') +
        (animated ? ' magnetic-slot-card-art--animated' : '')
      }
      aria-hidden="true"
    >
      <span className="magnetic-card-glow" />

      {/* Magnet row — real magnet texture + mult labels. */}
      <div className="magnetic-card-magnets">
        {magnets.map((mult, i) => (
          <div
            key={i}
            className={'magnetic-card-magnet' + (mult >= 50 ? ' magnetic-card-magnet--hot' : '')}
          >
            <span className="magnetic-card-magnet-mult">×{mult}</span>
            <span
              className="magnetic-card-magnet-body"
              style={{ backgroundImage: `url("${mgTexMagnet}")` }}
            />
          </div>
        ))}
      </div>

      {/* Play board: tier ladder behind, static reels at the
        * bottom, and (in the animated variant) per-symbol flying
        * ghosts overlaid on top. */}
      <div className="magnetic-card-board">
        {cols.map((col, ci) => (
          <div key={ci} className="magnetic-card-col">
            {/* Tier ladder — 2 dashed landing cells per column. */}
            <div className="magnetic-card-tiers" aria-hidden="true">
              {tiers.map(pct => (
                <span
                  key={pct}
                  className="magnetic-card-tier"
                  style={{ '--tier-pct': `${pct}%` }}
                >
                  {pct}
                </span>
              ))}
            </div>

            {/* Reel — 2 cells stacked at the bottom. Cells whose
              * symbol is currently in flight fade to opacity 0
              * while the ghost is rising/held/returning, then
              * fade back in once the ghost re-merges with them. */}
            <div className="magnetic-card-reel">
              {col.reels.map((tex, ri) => {
                const fly = animated
                  ? flies.find(f => f.col === ci && f.ri === ri)
                  : null
                return (
                  <span key={ri} className="magnetic-card-cell">
                    {tex && (
                      <span
                        className={
                          'magnetic-card-symbol' +
                          (fly ? ' magnetic-card-symbol--releasing' : '')
                        }
                        style={{
                          backgroundImage: `url("${tex}")`,
                          ...(fly ? { '--fly-delay': `${fly.delay}s` } : {}),
                        }}
                      />
                    )}
                  </span>
                )
              })}
            </div>

            {/* Flying overlays — only mounted when animated, and
              * only for cells listed in the `flies` script. Each
              * one takes off from the EXACT cell position (so the
              * source cell appears to lift off), rises to the
              * target tier line, holds, returns and merges back
              * into its cell. --row-from-bottom selects which
              * reel cell (0 = bottom, 1 = top) the ghost takes
              * off from. */}
            {animated && flies
              .filter(f => f.col === ci)
              .map((fly, fi) => (
                <span
                  key={'fly' + fi}
                  className="magnetic-card-flying"
                  style={{
                    '--target-pct': `${fly.target}%`,
                    '--fly-delay': `${fly.delay}s`,
                    '--row-from-bottom': fly.ri === 0 ? 1 : 0,
                    backgroundImage: `url("${fly.tex}")`,
                  }}
                />
              ))
            }
          </div>
        ))}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// STARDEW SPINS — card artwork.
//
// 6×5 grid of tilled dirt cells inside a wooden fence frame.
// Sky strip on top with a sun + a couple of clouds (the sky tints
// per season once we wire the live game; the home card freezes
// it on Summer so the card always reads as the "warm farm" mood).
// A handful of pixel crops are scattered across the field so the
// card immediately communicates the slot's symbol set without
// shipping any PNG sprites. Animated variant pulses one row of
// crops (the "winning line") and floats a +mult chip above it,
// hinting at the Pay-Anywhere → tumble loop.
// ─────────────────────────────────────────────────────────────
// Card crop id → real slot sprite. Same PNGs the live game grid
// uses, so the card IS a frozen spin of Stardew Spins.
const SD_CARD_SPRITE = {
  potatoe:    sdPotatoe,
  carrot:     sdCarrot,
  corn:       sdCorn,
  eggplant:   sdEggplant,
  tomatoe:    sdTomatoe,
  grape:      sdGrape,
  pumpkin:    sdPumpkin,
  watermelon: sdWatermelon,
  lime:       sdLime,
}

function StardewSlotArtwork({ large = false, animated = false }) {
  // 6 columns × 5 rows — a real-looking Pay-Anywhere spin. A fat
  // pumpkin cluster (10 of them, scattered anywhere) is the "8+
  // anywhere" win the animated variant flashes; a couple of lime
  // scatters dot the field like a near-bonus tease, and the rest
  // is a healthy mix so every crop tier shows up on the card.
  const cells = [
    // row 0
    'pumpkin', 'pumpkin', 'grape',    'pumpkin',  'watermelon', 'corn',
    // row 1
    'tomatoe', 'pumpkin', 'pumpkin',  'eggplant', 'pumpkin',    'grape',
    // row 2
    'carrot',  'lime',    'potatoe',  'pumpkin',  'corn',       'pumpkin',
    // row 3
    'grape',   'watermelon', 'tomatoe','pumpkin', 'lime',       'eggplant',
    // row 4
    'corn',    'potatoe', 'grape',    'carrot',   'pumpkin',    'tomatoe',
  ]

  // The Pay-Anywhere winning symbol — every pumpkin lights up.
  const winning = new Set(
    cells.flatMap((c, i) => (c === 'pumpkin' ? [i] : []))
  )

  return (
    <div
      className={
        'stardew-slot-card-art' +
        (large    ? ' stardew-slot-card-art--large'    : '') +
        (animated ? ' stardew-slot-card-art--animated' : '')
      }
      aria-hidden="true"
    >
      {/* Seasonal sky strip — fixed on Summer for the card. */}
      <div className="stardew-slot-art-sky">
        <span className="stardew-slot-art-sun" />
        <span className="stardew-slot-art-cloud stardew-slot-art-cloud--one" />
        <span className="stardew-slot-art-cloud stardew-slot-art-cloud--two" />
        {/* Tiny seasonal-wheel cue in the top-right corner — a
          * pixel disc divided into 4 quadrants (spring / summer
          * / fall / winter) with the indicator dot on summer. */}
        <span className="stardew-slot-art-season-wheel">
          <span className="stardew-slot-art-season-q stardew-slot-art-season-q--spring" />
          <span className="stardew-slot-art-season-q stardew-slot-art-season-q--summer" />
          <span className="stardew-slot-art-season-q stardew-slot-art-season-q--fall" />
          <span className="stardew-slot-art-season-q stardew-slot-art-season-q--winter" />
          <span className="stardew-slot-art-season-needle" />
        </span>
      </div>

      {/* Wooden frame around the grid + sunflower decoration. */}
      <div className="stardew-slot-art-frame">
        <span className="stardew-slot-art-sunflower" />

        <div className="stardew-slot-art-grid">
          {cells.map((crop, i) => (
            <span
              key={i}
              className={
                'stardew-slot-art-cell' +
                (crop ? ' stardew-slot-art-cell--has-crop' : '') +
                (crop === 'lime' ? ' stardew-slot-art-cell--scatter' : '') +
                (animated && winning.has(i) ? ' stardew-slot-art-cell--winning' : '')
              }
            >
              {crop && SD_CARD_SPRITE[crop] && (
                <span
                  className="stardew-slot-art-crop"
                  style={{ backgroundImage: `url("${SD_CARD_SPRITE[crop]}")` }}
                />
              )}
            </span>
          ))}
        </div>

        {/* Floating +mult chip — only shown in the animated
          * variant; pretends to celebrate the carrot combo. */}
        {animated && (
          <span className="stardew-slot-art-mult-chip">×24</span>
        )}
      </div>

      {/* Grass tuft footer to anchor the frame in the field. */}
      <span className="stardew-slot-art-grass" />
    </div>
  )
}

function renderSlotArtwork(slot, opts = {}) {
  if (slot.id === 'tetris-cascade') return <TetrisSlotArtwork {...opts} />
  if (slot.id === 'rocket')         return <RocketSlotArtwork {...opts} />
  if (slot.id === 'plinko')         return <PlinkoSlotArtwork {...opts} />
  if (slot.id === 'pixel-mine')     return <PixelMineSlotArtwork {...opts} />
  if (slot.id === 'dice')           return <DiceSlotArtwork {...opts} />
  if (slot.id === 'magnetic')       return <MagneticSlotArtwork {...opts} />
  if (slot.id === 'stardew-spins')  return <StardewSlotArtwork {...opts} />
  return <TowerSlotArtwork {...opts} />
}

function slotKickerKey(id) {
  if (id === 'tetris-cascade') return 'slotTetrisKicker'
  if (id === 'rocket')         return 'slotRocketKicker'
  if (id === 'plinko')         return 'slotPlinkoKicker'
  if (id === 'pixel-mine')     return 'slotPixelMineKicker'
  if (id === 'dice')           return 'slotDiceKicker'
  if (id === 'magnetic')       return 'slotMagneticKicker'
  if (id === 'stardew-spins')  return 'slotStardewKicker'
  return 'slotTowerKicker'
}

function slotPreviewKey(id) {
  if (id === 'tetris-cascade') return 'slotTetrisPreview'
  if (id === 'rocket')         return 'slotRocketPreview'
  if (id === 'plinko')         return 'slotPlinkoPreview'
  if (id === 'pixel-mine')     return 'slotPixelMinePreview'
  if (id === 'dice')           return 'slotDicePreview'
  if (id === 'magnetic')       return 'slotMagneticPreview'
  if (id === 'stardew-spins')  return 'slotStardewPreview'
  return 'slotTowerPreview'
}

function SlotPreview({ slot, t, onClose }) {
  const navigate = useNavigate()

  useEffect(() => {
    if (slot) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => { document.body.style.overflow = '' }
  }, [slot])

  useEffect(() => {
    const tg = window.Telegram?.WebApp
    if (!tg) return
    if (slot) {
      tg.BackButton.show()
      tg.BackButton.onClick(onClose)
    } else {
      tg.BackButton.hide()
      tg.BackButton.offClick(onClose)
    }
    return () => {
      tg.BackButton.offClick(onClose)
      tg.BackButton.hide()
    }
  }, [slot, onClose])

  if (!slot) return null

  function handlePlay() {
    haptic('medium')
    onClose()
    navigate(slot.route)
  }

  return (
    <div className="slot-preview-backdrop" onClick={onClose}>
      <div className="slot-preview-card" onClick={(e) => e.stopPropagation()}>
        <button className="slot-preview-close" type="button" onClick={onClose} aria-label={t.close || 'Close'}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M6 6L18 18M18 6L6 18" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
          </svg>
        </button>
        <div className="slot-preview-visual">
          {renderSlotArtwork(slot, { large: true, animated: true })}
        </div>
        <div className="slot-preview-copy">
          <span className="slot-preview-kicker">{t[slotKickerKey(slot.id)]}</span>
          <h3>{t[slot.titleKey]}</h3>
          <p>{t[slotPreviewKey(slot.id)]}</p>
        </div>
        <button className="slot-preview-play" type="button" onClick={handlePlay}>
          {t.slotPlay}
        </button>
      </div>
    </div>
  )
}

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
  const [slotPreview, setSlotPreview] = useState(null)
  const [friendsOpen, setFriendsOpen] = useState(false)
  const [gameSection, setGameSection] = useState('duels')

  // Real online counts per game type (refreshed every 30s) plus a
  // monotonic clock tick so fakeOnlineFor recomputes when slow/jitter
  // slots roll over.
  const [onlineCounts, setOnlineCounts] = useState({})
  const [onlineTick, setOnlineTick] = useState(() => Date.now())

  const isAdmin = user && (
    ADMIN_IDS.includes(user.id) ||
    ADMIN_IDS.includes(user.telegram_id) ||
    ADMIN_IDS.includes(Number(user.telegram_id))
  )

  const closeSheet = useCallback(() => {
    haptic('light')
    setSheetGame(null)
  }, [])

  const closeSlotPreview = useCallback(() => {
    haptic('light')
    setSlotPreview(null)
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
      sound.gameStart()
      const route = gameType === 'blackjack' ? '/blackjack' : gameType === 'sequence' ? '/sequence' : gameType === 'reaction' ? '/reaction' : gameType === 'hearing' ? '/hearing' : gameType === 'gradient' ? '/gradient' : gameType === 'race' ? '/race' : gameType === 'capitals' ? '/capitals' : gameType === 'circle' ? '/circle' : '/game'
      navigate(`${route}/${duelId}`)
    }
  }, [pendingGameNav])

  // Real online counts + fake-boost tick — both refresh on the same
  // 3-minute cadence so a single network round-trip drives the visible
  // badge value.
  useEffect(() => {
    let cancelled = false
    async function load() {
      const counts = await getGameOnlineCounts()
      if (!cancelled) {
        setOnlineCounts(counts || {})
        setOnlineTick(Date.now())
      }
    }
    load()
    const id = setInterval(load, 180000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  function handleGameTap(game) {
    if (!game.available) return
    haptic('medium')
    setSheetGame(game)
  }

  function handleSlotTap(slot) {
    haptic('medium')
    setSlotPreview(slot)
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
        <div className="games-tabs" role="tablist" aria-label={t.gamesLabel}>
          <button
            type="button"
            className={`games-tab ${gameSection === 'duels' ? 'active' : ''}`}
            role="tab"
            aria-selected={gameSection === 'duels'}
            onClick={() => { haptic('light'); setGameSection('duels') }}
          >
            {t.gamesDuelTab}
          </button>
          <button
            type="button"
            className={`games-tab ${gameSection === 'slots' ? 'active' : ''}`}
            role="tab"
            aria-selected={gameSection === 'slots'}
            onClick={() => { haptic('light'); setGameSection('slots') }}
          >
            {t.gamesSlotsTab}
          </button>
        </div>

        {gameSection === 'duels' ? (
          <div className="games-grid">

            {(() => {
              const g = GAMES[0]
              const onlineDisplay = (onlineCounts[g.id] || 0) + fakeOnlineFor(g.id, onlineTick)
              return (
                <button
                  className="game-card game-card--main game-card--with-art"
                  style={{ '--card-accent': g.accent, '--card-shadow': g.shadow }}
                  onClick={() => handleGameTap(g)}
                >
                  <img className="game-card-art" src={g.art} alt="" loading="eager" decoding="async" aria-hidden="true" />
                  <div className="game-card-art-overlay" />
                  <div className="game-card-glow" />
                  <span className="game-card-title">{t[g.titleKey]}</span>
                  <span className="game-card-online" aria-label="online">
                    <span className="game-card-online-dot" />
                    <span className="game-card-online-count">{onlineDisplay}</span>
                    <span className="game-card-online-label">{t.online || 'online'}</span>
                  </span>
                </button>
              )
            })()}

            {/* Render secondary games in rows of 2 */}
            {Array.from({ length: Math.ceil((GAMES.length - 1) / 2) }, (_, rowIdx) => {
              const rowGames = GAMES.slice(1 + rowIdx * 2, 1 + rowIdx * 2 + 2)
              return (
                <div className="games-row" key={rowIdx}>
                  {rowGames.map(g => {
                    const onlineDisplay = (onlineCounts[g.id] || 0) + fakeOnlineFor(g.id, onlineTick)
                    return (
                    <button
                      key={g.id}
                      className={`game-card game-card--small game-card--${g.id} ${g.art ? 'game-card--with-art' : ''} ${!g.available ? 'game-card--soon' : ''}`}
                      style={{ '--card-accent': g.accent, '--card-shadow': g.shadow }}
                      onClick={() => handleGameTap(g)}
                      disabled={!g.available}
                    >
                      {g.art ? (
                        <>
                          <img className="game-card-art" src={g.art} alt="" loading="eager" decoding="async" aria-hidden="true" />
                          <div className="game-card-art-overlay" />
                          <div className="game-card-glow" />
                          <span className="game-card-title">{t[g.titleKey]}</span>
                        </>
                      ) : (
                        <>
                          <div className="game-card-glow" />
                          <span className="game-card-emoji">{GAME_SHEETS[g.id]?.svgIcon ? GAME_SHEETS[g.id].svgIcon(g.accent) : GAME_SHEETS[g.id]?.icon}</span>
                          <div className="game-card-info">
                            <span className="game-card-title">{t[g.titleKey]}</span>
                            <span className="game-card-sub">{t[g.subKey]}</span>
                          </div>
                        </>
                      )}
                      {g.available && (
                        <span className="game-card-online" aria-label="online">
                          <span className="game-card-online-dot" />
                          <span className="game-card-online-count">{onlineDisplay}</span>
                          <span className="game-card-online-label">{t.online || 'online'}</span>
                        </span>
                      )}
                      {!g.available && <div className="game-card-badge">{t.soon}</div>}
                    </button>
                  )})}
                  {rowGames.length === 1 && <div className="game-card-placeholder" />}
                </div>
              )
            })}

            <div className="games-more-soon">
              <span>{t.moreGamesSoon}</span>
            </div>

          </div>
        ) : (
          <div className="slots-section">
            <div className="slots-block slots-block--quick">
              <h3 className="slots-section-title">{t.slotsQuickHeader}</h3>
              <div className="slots-row">
                {SLOTS.filter(s => s.category === 'quick').map(slot => (
                  <button
                    key={slot.id}
                    type="button"
                    className="slot-card slot-card--scroll"
                    style={{ '--slot-accent': slot.accent, '--slot-shadow': slot.shadow }}
                    onClick={() => handleSlotTap(slot)}
                  >
                    {renderSlotArtwork(slot)}
                    <span className="slot-card-title">{t[slot.titleKey]}</span>
                  </button>
                ))}
                {/* Quick games row no longer pads with "coming soon"
                 * placeholders — the four real fast slots (Tower
                 * Stack / Rocket / Plinko / Dice) fill the row. */}
              </div>
            </div>

            <div className="slots-block slots-block--popular">
              <h3 className="slots-section-title">{t.slotsPopularHeader}</h3>
              <div className="slots-row">
                {SLOTS.filter(s => s.category === 'popular').map(slot => (
                  <button
                    key={slot.id}
                    type="button"
                    className="slot-card slot-card--scroll"
                    style={{ '--slot-accent': slot.accent, '--slot-shadow': slot.shadow }}
                    onClick={() => handleSlotTap(slot)}
                  >
                    {renderSlotArtwork(slot)}
                    <span className="slot-card-title">{t[slot.titleKey]}</span>
                  </button>
                ))}
                {/* Popular row no longer pads with "coming soon"
                 * placeholders — the real popular slots fill it. */}
              </div>
            </div>

            {/* Live activity ribbon — wins/losses across all slots,
                real bets mixed with seeded fake events from the
                server's pg_cron job so the feed always feels alive. */}
            <LiveFeed />
          </div>
        )}

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
      <SlotPreview slot={slotPreview} t={t} onClose={closeSlotPreview} />
    </div>
  )
}
