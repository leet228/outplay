import React, { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { initTelegram, getTelegramUser, getStartParam } from './lib/telegram'
import { supabase, getOrCreateUser, getUserProfile, getPlans, getLeaderboard, getGuildData, getRecentOpponents, getFriendsData, pingOnline, getUserBalance, getAppSettings, getBootstrapCriticalData, getBootstrapDeferredData } from './lib/supabase'
import { fetchRates } from './lib/currency'
import useGameStore from './store/useGameStore'
import { initSounds, preloadAll } from './lib/sounds'
import { getStoreImageUrls, preloadAppImages, preloadGameCardImages, preloadStoreImages } from './lib/imagePreload'
import './App.css'
import BottomNav from './components/BottomNav'
import DepositSheet from './components/DepositSheet'
import WithdrawalSheet from './components/WithdrawalSheet'
import SplashScreen from './components/SplashScreen'
import NotTelegram from './components/NotTelegram'
import Onboarding from './pages/Onboarding'

import Home from './pages/Home'
// Duel.jsx is legacy — matchmaking fully handled by Home.jsx GameSheet + findMatch RPC
import Game from './pages/Game'
import Result from './pages/Result'
import Leaderboard from './pages/Leaderboard'
import Guilds from './pages/Guilds'
import Shop from './pages/Shop'
import Profile from './pages/Profile'
import Admin from './pages/Admin'
import Blackjack from './pages/Blackjack'
import Sequence from './pages/Sequence'
import Reaction from './pages/Reaction'
import Hearing from './pages/Hearing'
import Gradient from './pages/Gradient'
import Race from './pages/Race'
import Capitals from './pages/Capitals'
import Circle from './pages/Circle'
import TowerStackSlot from './pages/TowerStackSlot'
import TetrisCascadeSlot from './pages/TetrisCascadeSlot'

// Disable browser scroll restoration globally — SPA handles it manually
if ('scrollRestoration' in history) {
  history.scrollRestoration = 'manual'
}

// Block access outside Telegram in production (allow dev on localhost)
const IS_TELEGRAM = !!window.Telegram?.WebApp?.initData
const IS_DEV = import.meta.env.DEV

const CACHE_KEY = 'outplay_data'

function readCache() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}')
  } catch {
    return {}
  }
}

function ScrollToTop() {
  const { pathname } = useLocation()
  useEffect(() => {
    window.scrollTo(0, 0)
    document.documentElement.scrollTop = 0
    document.body.scrollTop = 0
    // Belt-and-suspenders: also reset after browser's async scroll restoration
    const t = setTimeout(() => {
      window.scrollTo(0, 0)
      document.documentElement.scrollTop = 0
      document.body.scrollTop = 0
    }, 0)
    return () => clearTimeout(t)
  }, [pathname])
  return null
}

const NO_NAV = ['/game', '/blackjack', '/sequence', '/reaction', '/hearing', '/gradient', '/race', '/capitals', '/circle', '/slots', '/result', '/admin']

function Layout() {
  const { pathname } = useLocation()
  const showNav = !NO_NAV.some((p) => pathname.startsWith(p))

  return (
    <>
      <ScrollToTop />
      <Routes>
        <Route path="/" element={<Home />} />
        {/* /duel removed: legacy page bypassed balance deduction and matchmaking */}
        <Route path="/game/:duelId" element={<Game />} />
        <Route path="/blackjack/:duelId" element={<Blackjack />} />
        <Route path="/sequence/:duelId" element={<Sequence />} />
        <Route path="/reaction/:duelId" element={<Reaction />} />
        <Route path="/hearing/:duelId" element={<Hearing />} />
        <Route path="/gradient/:duelId" element={<Gradient />} />
        <Route path="/race/:duelId" element={<Race />} />
        <Route path="/capitals/:duelId" element={<Capitals />} />
        <Route path="/circle/:duelId" element={<Circle />} />
        <Route path="/slots/tower-stack" element={<TowerStackSlot />} />
        <Route path="/slots/tetris-cascade" element={<TetrisCascadeSlot />} />
        <Route path="/result" element={<Result />} />
        <Route path="/leaderboard" element={<Leaderboard />} />
        <Route path="/guilds" element={<Guilds />} />
        <Route path="/shop" element={<Shop />} />
        <Route path="/profile" element={<Profile />} />
        <Route path="/admin" element={<Admin />} />
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
      {showNav && <BottomNav />}
      <DepositSheet />
      <WithdrawalSheet />
    </>
  )
}

// Hydrate store from localStorage cache (instant UI on repeat visits)
function hydrateFromCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return false
    const cache = JSON.parse(raw)
    const store = useGameStore.getState()
    if (cache.leaderboard)      store.setLeaderboard(cache.leaderboard)
    if (cache.topGuilds)        store.setTopGuilds(cache.topGuilds)
    if (cache.guild !== undefined) store.setGuild(cache.guild)
    if (cache.guildMembers)     store.setGuildMembers(cache.guildMembers)
    if (cache.guildSeason)      store.setGuildSeason(cache.guildSeason)
    if (cache.recentOpponents)  store.setRecentOpponents(cache.recentOpponents)
    if (cache.friends)          store.setFriends(cache.friends)
    if (cache.friendRequests)   store.setFriendRequests(cache.friendRequests)
    if (cache.sentRequestIds)   store.setSentRequestIds(cache.sentRequestIds)
    if (cache.appSettings)      store.setAppSettings(cache.appSettings)
    return true
  } catch { return false }
}

// Write fresh data to cache
function writeCache(data) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(data))
  } catch { /* quota exceeded — ignore */ }
}

function mergeCache(partial) {
  writeCache({
    ...readCache(),
    ...partial,
  })
}

async function loadCriticalBootstrap(userId) {
  const data = await getBootstrapCriticalData(userId)
  if (data) return data

  console.warn('Falling back to legacy critical bootstrap requests')

  const results = await Promise.allSettled([
    getFriendsData(userId),
    getAppSettings(),
  ])

  const [friendsData, settings] = results.map(r => r.status === 'fulfilled' ? r.value : null)

  return {
    friends_data: friendsData ?? null,
    app_settings: settings ?? null,
  }
}

async function loadDeferredBootstrap(userId) {
  const data = await getBootstrapDeferredData(userId)
  if (data) return data

  console.warn('Falling back to legacy deferred bootstrap requests')

  const results = await Promise.allSettled([
    getUserProfile(userId),
    getPlans(),
    getLeaderboard(10),
    getGuildData(userId),
    getRecentOpponents(userId),
  ])

  const [profile, plans, leaderboard, guildData, opponents] =
    results.map(r => r.status === 'fulfilled' ? r.value : null)

  return {
    profile,
    plans: plans ?? [],
    leaderboard: leaderboard ?? [],
    guild_data: guildData ?? null,
    recent_opponents: opponents ?? [],
  }
}

function applyCriticalBootstrapData(store, data) {
  if (!data) return

  const friendsData = data.friends_data ?? null
  const settings = data.app_settings ?? null

  if (settings) store.setAppSettings(settings)

  if (friendsData) {
    store.setFriends(friendsData.friends ?? [])
    store.setFriendRequests(friendsData.incoming_requests ?? [])
    store.setSentRequestIds(friendsData.outgoing_request_ids ?? [])
  }
}

function applyDeferredBootstrapData(store, data, rates) {
  if (rates) store.setRates(rates)
  if (!data) return

  const profile = data.profile ?? null
  const plans = data.plans
  const leaderboard = data.leaderboard
  const guildData = data.guild_data ?? null
  const opponents = data.recent_opponents

  if (profile && !profile.error) {
    store.setRank(profile.rank ?? 0)
    store.setDailyStats(profile.daily_stats ?? [])
    store.setTotalPnl(profile.total_pnl ?? 0)
    store.setRefEarnings(profile.ref_earnings ?? { day: 0, week: 0, month: 0, all: 0 })
  }

  if (Array.isArray(plans)) store.setPlans(plans)
  if (Array.isArray(leaderboard)) store.setLeaderboard(leaderboard)

  if (guildData) {
    store.setGuild(guildData.my_guild ?? null)
    store.setGuildMembers(guildData.my_guild?.members ?? [])
    store.setTopGuilds(guildData.top_guilds ?? [])
    store.setGuildSeason(guildData.season ?? null)
  }

  if (Array.isArray(opponents)) store.setRecentOpponents(opponents)
}

function cacheCriticalBootstrapData(data) {
  if (!data) return

  const friendsData = data.friends_data ?? null

  mergeCache({
    friends: friendsData?.friends ?? [],
    friendRequests: friendsData?.incoming_requests ?? [],
    sentRequestIds: friendsData?.outgoing_request_ids ?? [],
    appSettings: data.app_settings ?? {},
  })
}

function cacheDeferredBootstrapData(data) {
  if (!data) return

  const guildData = data.guild_data ?? null

  mergeCache({
    leaderboard: Array.isArray(data.leaderboard) ? data.leaderboard : [],
    topGuilds: guildData?.top_guilds ?? [],
    guild: guildData?.my_guild ?? null,
    guildMembers: guildData?.my_guild?.members ?? [],
    guildSeason: guildData?.season ?? null,
    recentOpponents: Array.isArray(data.recent_opponents) ? data.recent_opponents : [],
  })
}

function startDeferredBootstrap(userId, store) {
  Promise.allSettled([
    loadDeferredBootstrap(userId),
    fetchRates(),
  ]).then(([bootstrapResult, ratesResult]) => {
    const deferredData = bootstrapResult.status === 'fulfilled' ? bootstrapResult.value : null
    const rates = ratesResult.status === 'fulfilled' ? ratesResult.value : null

    applyDeferredBootstrapData(store, deferredData, rates)
    cacheDeferredBootstrapData(deferredData)
  })
}

export default function App() {
  const setUser = useGameStore(s => s.setUser)
  const setBalance = useGameStore(s => s.setBalance)
  // 'splash' | 'onboarding' | 'app'
  const [phase, setPhase] = useState('splash')

  useEffect(() => {
    const tg = initTelegram()
    applyTelegramTheme(tg)

    // Init sound system + preload all sounds in background
    initSounds()
    preloadAll()
    preloadAppImages()
    preloadGameCardImages()

    const isOnboarded = localStorage.getItem('outplay_onboarded')
    const SPLASH_MIN = 1400 // ms — minimum splash duration (brand moment)
    const SPLASH_MAX = 8000 // ms — hard ceiling so dead network never wedges splash

    // Hydrate cached secondary data so screens show instantly once splash hides.
    // We still WAIT for bootstrap to finish (user + balance) before transitioning.
    hydrateFromCache()

    const splashStart = Date.now()
    let advanced = false
    const advance = () => {
      if (advanced) return
      advanced = true
      const elapsed = Date.now() - splashStart
      const delay = Math.max(0, SPLASH_MIN - elapsed)
      setTimeout(() => {
        setPhase(isOnboarded ? 'app' : 'onboarding')
      }, delay)
    }

    // Safety net: if network is dead and bootstrap hangs, advance anyway.
    const maxTimer = setTimeout(advance, SPLASH_MAX)

    bootstrap()
      .catch(err => { console.error('Bootstrap failed:', err) })
      .finally(() => {
        clearTimeout(maxTimer)
        advance()
      })
  }, [])

  // Warm already-known remote avatars without adding extra DB/API requests.
  useEffect(() => {
    let lastSignature = ''

    const warmStoreImages = (state = useGameStore.getState()) => {
      const urls = getStoreImageUrls(state)
      const signature = urls.join('|')
      if (signature === lastSignature) return
      lastSignature = signature
      preloadStoreImages(state)
    }

    warmStoreImages()
    const unsubscribe = useGameStore.subscribe(warmStoreImages)
    return unsubscribe
  }, [])

  // Ping online every 2 min so friends see us as online
  useEffect(() => {
    const id = setInterval(() => {
      const uid = useGameStore.getState().user?.id
      if (uid && uid !== 'dev') pingOnline(uid)
    }, 2 * 60 * 1000)
    return () => clearInterval(id)
  }, [])

  // App settings realtime — replaces 60s polling
  useEffect(() => {
    const settingsCh = supabase
      .channel('app-settings')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'app_settings' }, () => {
        getAppSettings().then(s => { if (s) useGameStore.getState().setAppSettings(s) })
      })
      .subscribe()
    return () => supabase.removeChannel(settingsCh)
  }, [])

  // Realtime: listen for new deposits → bounce balance
  const userId = useGameStore(s => s.user?.id)
  useEffect(() => {
    if (!userId || userId === 'dev') return

    const channel = supabase
      .channel(`deposits-${userId}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'transactions',
        filter: `user_id=eq.${userId}`,
      }, (payload) => {
        if (payload.new?.type === 'deposit') {
          getUserBalance(userId).then(bal => {
            if (bal != null) {
              useGameStore.getState().setBalance(bal)
              useGameStore.getState().setBalanceBounce(true)
              setTimeout(() => useGameStore.getState().setBalanceBounce(false), 700)
            }
          })
        }
      })
      .subscribe((status) => {
        if (status === 'CHANNEL_ERROR') {
          console.warn('Realtime deposit channel error for user', userId)
        }
      })

    return () => {
      supabase.removeChannel(channel)
    }
  }, [userId])

  // Realtime: game invites
  useEffect(() => {
    if (!userId || userId === 'dev') return

    const ch = supabase
      .channel(`invites-${userId}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'game_invites',
        filter: `to_id=eq.${userId}`,
      }, (payload) => {
        const store = useGameStore.getState()
        if (payload.eventType === 'INSERT' && payload.new?.status === 'pending') {
          store.setGameInvites([...store.gameInvites, payload.new])
        } else if (payload.eventType === 'UPDATE' && payload.new?.status !== 'pending') {
          store.setGameInvites(store.gameInvites.filter(i => i.id !== payload.new.id))
        }
      })
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'game_invites',
        filter: `from_id=eq.${userId}`,
      }, (payload) => {
        const store = useGameStore.getState()
        const inv = payload.new
        if (inv.status === 'accepted' && inv.duel_id) {
          store.setPendingGameNav({ duelId: inv.duel_id, gameType: inv.game_type })
        }
        store.setSentInvites(store.sentInvites.filter(i => i.id !== inv.id))
      })
      .subscribe()

    return () => {
      supabase.removeChannel(ch)
    }
  }, [userId])

  async function bootstrap() {
    const tgUser = getTelegramUser()
    const store = useGameStore.getState()

    if (!tgUser) {
      // ── Try cached user from localStorage ──
      const cached = localStorage.getItem('outplay_user')
      if (cached) {
        try {
          const cachedUser = JSON.parse(cached)
          if (cachedUser?.telegram_id) {
            const user = await getOrCreateUser({ id: cachedUser.telegram_id, first_name: cachedUser.first_name, username: cachedUser.username })
            if (user && user.id !== 'dev') {
              setUser(user)
              setBalance(user.balance ?? 0)
              localStorage.setItem('outplay_user', JSON.stringify({ telegram_id: user.telegram_id, first_name: user.first_name, username: user.username }))
              const criticalData = await loadCriticalBootstrap(user.id)
              applyCriticalBootstrapData(store, criticalData)
              cacheCriticalBootstrapData(criticalData)
              startDeferredBootstrap(user.id, store)
              return
            }
          }
        } catch (e) { console.warn('Cached user parse error:', e) }
      }
      // ── Dev fallback ──
      setUser({ id: 'dev', first_name: 'Dev', username: 'dev', wins: 3, losses: 1, is_pro: true, pro_expires: new Date(Date.now() + 25 * 86400000).toISOString() })
      setBalance(500)
      store.setRank(1)
      store.setTotalPnl(575)
      store.setDailyStats([
        { date: '2026-03-05', pnl: -45, games: 2, wins: 0 },
        { date: '2026-03-06', pnl: 200, games: 3, wins: 2 },
        { date: '2026-03-07', pnl: -80, games: 1, wins: 0 },
        { date: '2026-03-08', pnl: 350, games: 4, wins: 3 },
        { date: '2026-03-09', pnl: -120, games: 2, wins: 0 },
        { date: '2026-03-10', pnl: 180, games: 3, wins: 2 },
        { date: '2026-03-11', pnl: 90, games: 1, wins: 1 },
      ])
      store.setRefEarnings({ day: 35, week: 210, month: 780, all: 1367 })
      store.setPlans([
        { id: '1m',  months: 1,  price: 499,  per_month: 499, savings: 0    },
        { id: '6m',  months: 6,  price: 2199, per_month: 366, savings: 795  },
        { id: '12m', months: 12, price: 3499, per_month: 292, savings: 2489 },
      ])
      store.setLeaderboard([
        { id: '1',  first_name: 'Александр', username: 'alex_trade', balance: 4850, wins: 24, losses: 6, is_pro: true },
        { id: '2',  first_name: 'Мария',     username: 'masha_win',  balance: 2130, wins: 18, losses: 9, is_pro: true },
        { id: '3',  first_name: 'Дмитрий',   username: 'dmitry_x',   balance: 1740, wins: 21, losses: 8 },
        { id: '4',  first_name: 'Кирилл',    username: 'kirill_up',  balance: 1220, wins: 15, losses: 7 },
        { id: '5',  first_name: 'Анна',      username: 'anna_pro',   balance: 980,  wins: 12, losses: 5, is_pro: true },
        { id: '6',  first_name: 'Сергей',    username: 'serg_bet',   balance: 760,  wins: 10, losses: 6 },
        { id: '7',  first_name: 'Оля',       username: 'olya_q',     balance: 530,  wins: 9,  losses: 8 },
        { id: '8',  first_name: 'Максим',    username: 'max_mm',     balance: 390,  wins: 8,  losses: 7 },
        { id: '9',  first_name: 'Лера',      username: 'lera_win',   balance: 210,  wins: 7,  losses: 9 },
        { id: '10', first_name: 'Паша',      username: 'pasha_ok',   balance: 95,   wins: 5,  losses: 6 },
      ])
      store.setGuild(null)
      store.setGuildMembers([])
      store.setTopGuilds([
        { id: 'tg1', name: 'Alpha Wolves',  tag: 'AL', member_count: 48, pnl: 128450, creator_name: 'Виктор' },
        { id: 'tg2', name: 'Brain Storm',   tag: 'BR', member_count: 50, pnl: 95200,  creator_name: 'Настя'  },
        { id: 'tg3', name: 'Quiz Kings',    tag: 'QU', member_count: 45, pnl: 87100,  creator_name: 'Артём'  },
        { id: 'tg4', name: 'Нейронка',      tag: 'НЕ', member_count: 42, pnl: 63800,  creator_name: 'Лена'   },
        { id: 'tg5', name: 'Эрудиты',       tag: 'ЭР', member_count: 38, pnl: 51200,  creator_name: 'Павел'  },
      ])
      store.setGuildSeason({ prize_pool: 50000, end_date: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1).toISOString() })
      store.setRecentOpponents([
        { id: '1', first_name: 'Александр', username: 'alex_trade', last_seen: new Date().toISOString() },
        { id: '2', first_name: 'Мария',     username: 'masha_win',  last_seen: new Date(Date.now() - 120000).toISOString() },
        { id: '3', first_name: 'Дмитрий',   username: 'dmitry_x',   last_seen: new Date(Date.now() - 3600000).toISOString() },
        { id: '4', first_name: 'Кирилл',    username: 'kirill_up',  last_seen: new Date(Date.now() - 86400000).toISOString() },
        { id: '5', first_name: 'Анна',      username: 'anna_pro',   last_seen: new Date(Date.now() - 7200000).toISOString() },
      ])
      store.setFriends([
        { id: '1', first_name: 'Александр', username: 'alex_trade', avatar_url: null, last_seen: new Date().toISOString(), is_pro: true },
        { id: '2', first_name: 'Мария',     username: 'masha_win',  avatar_url: null, last_seen: new Date(Date.now() - 120000).toISOString() },
        { id: '5', first_name: 'Анна',      username: 'anna_pro',   avatar_url: null, last_seen: new Date(Date.now() - 7200000).toISOString(), is_pro: true },
      ])
      store.setFriendRequests([
        { request_id: 'req1', from_user: { id: '3', first_name: 'Дмитрий', username: 'dmitry_x', avatar_url: null }, created_at: new Date(Date.now() - 3600000).toISOString() },
        { request_id: 'req2', from_user: { id: '6', first_name: 'Сергей',  username: 'serg_bet', avatar_url: null }, created_at: new Date(Date.now() - 7200000).toISOString() },
      ])
      store.setSentRequestIds(['4'])
      store.setGameInvites([
        { id: 'inv1', from_id: '1', game_type: 'quiz',      stake: 100, expires_at: new Date(Date.now() + 300000).toISOString() },
        { id: 'inv2', from_id: '2', game_type: 'blackjack', stake: 50,  expires_at: new Date(Date.now() + 180000).toISOString() },
      ])
      // Dev defaults
      store.setAppSettings({ stars_deposits: true, crypto_deposits: true, withdrawals: true, game_creation: true, subscriptions: true })
      fetchRates().then(r => store.setRates(r)).catch(() => {})
      return
    }

    // ── Real user ──
    const startParam = getStartParam()
    let referrerId = null
    if (startParam && startParam.startsWith('ref_')) {
      referrerId = startParam.slice(4)
    }
    const user = await getOrCreateUser(tgUser, referrerId)
    setUser(user)
    setBalance(user.balance ?? 0)
    // Cache user for fallback if Telegram SDK fails on next load
    try {
      localStorage.setItem('outplay_user', JSON.stringify({ telegram_id: user.telegram_id, first_name: user.first_name, username: user.username }))
    } catch (_error) {
      // Ignore cache write issues; app bootstrap should continue.
    }


    // 8 parallel fetches — all data for the entire app
    const criticalData = await loadCriticalBootstrap(user.id)
    applyCriticalBootstrapData(store, criticalData)
    cacheCriticalBootstrapData(criticalData)
    startDeferredBootstrap(user.id, store)

    // Sync currency/lang from DB → localStorage (DB is source of truth for cross-device)
    const currencyMap = {
      RUB: { symbol: '₽', code: 'RUB' },
      USD: { symbol: '$', code: 'USD' },
      EUR: { symbol: '€', code: 'EUR' },
    }
    if (user.currency && currencyMap[user.currency]) {
      const stored = JSON.parse(localStorage.getItem('outplay_currency') || 'null')
      if (!stored || stored.code !== user.currency) {
        const c = currencyMap[user.currency]
        localStorage.setItem('outplay_currency', JSON.stringify(c))
        useGameStore.setState({ currency: c })
      }
    }
    if (user.lang) {
      const storedLang = localStorage.getItem('outplay_lang')
      if (user.lang !== storedLang) {
        localStorage.setItem('outplay_lang', user.lang)
        useGameStore.setState({ lang: user.lang })
      }
    }
  }

  if (phase === 'splash') return <SplashScreen />

  // Block non-Telegram users in production
  if (!IS_DEV && !IS_TELEGRAM) return <NotTelegram />

  if (phase === 'onboarding') {
    return <Onboarding onComplete={() => setPhase('app')} />
  }

  return (
    <BrowserRouter>
      <Layout />
    </BrowserRouter>
  )
}

function applyTelegramTheme(tg) {
  if (!tg) return
  const root = document.documentElement.style
  const c = tg.themeParams
  if (c.bg_color) root.setProperty('--bg', c.bg_color)
  if (c.text_color) root.setProperty('--text', c.text_color)
  if (c.hint_color) root.setProperty('--text-muted', c.hint_color)
  if (c.secondary_bg_color) root.setProperty('--surface', c.secondary_bg_color)

  const safeTop = (tg.safeAreaInsets?.top ?? 0) + (tg.contentSafeAreaInsets?.top ?? 0)
  if (safeTop > 0) root.setProperty('--safe-top', `${safeTop}px`)

  const safeBottom = (tg.safeAreaInsets?.bottom ?? 0) + (tg.contentSafeAreaInsets?.bottom ?? 0)
  if (safeBottom > 0) root.setProperty('--safe-bottom', `${safeBottom}px`)
}
