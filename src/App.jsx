import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { initTelegram, getTelegramUser } from './lib/telegram'
import { getOrCreateUser, getUserProfile, getPlans, getLeaderboard, getGuildData, getRecentOpponents, getFriendsData, pingOnline } from './lib/supabase'
import useGameStore from './store/useGameStore'
import './App.css'
import BottomNav from './components/BottomNav'
import DepositSheet from './components/DepositSheet'
import SplashScreen from './components/SplashScreen'
import Onboarding from './pages/Onboarding'
import Home from './pages/Home'
import Duel from './pages/Duel'
import Game from './pages/Game'
import Result from './pages/Result'
import Leaderboard from './pages/Leaderboard'
import Guilds from './pages/Guilds'
import Shop from './pages/Shop'
import Profile from './pages/Profile'

// Disable browser scroll restoration globally — SPA handles it manually
if ('scrollRestoration' in history) {
  history.scrollRestoration = 'manual'
}

const CACHE_KEY = 'outplay_data'

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

const NO_NAV = ['/game', '/result']

function Layout() {
  const { pathname } = useLocation()
  const showNav = !NO_NAV.some((p) => pathname.startsWith(p))

  return (
    <>
      <ScrollToTop />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/duel" element={<Duel />} />
        <Route path="/game/:duelId" element={<Game />} />
        <Route path="/result" element={<Result />} />
        <Route path="/leaderboard" element={<Leaderboard />} />
        <Route path="/guilds" element={<Guilds />} />
        <Route path="/shop" element={<Shop />} />
        <Route path="/profile" element={<Profile />} />
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
      {showNav && <BottomNav />}
      <DepositSheet />
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
    return true
  } catch { return false }
}

// Write fresh data to cache
function writeCache(data) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(data))
  } catch { /* quota exceeded — ignore */ }
}

export default function App() {
  const { setUser, setBalance } = useGameStore()
  // 'splash' | 'onboarding' | 'app'
  const [phase, setPhase] = useState('splash')

  useEffect(() => {
    const tg = initTelegram()
    applyTelegramTheme(tg)

    const isOnboarded = localStorage.getItem('outplay_onboarded')
    const SPLASH_MIN = 1400 // ms
    const hasCached = hydrateFromCache()

    if (hasCached) {
      // Cache exists → show app after splash, refresh data in background
      bootstrap().catch(() => {})
      setTimeout(() => {
        setPhase(isOnboarded ? 'app' : 'onboarding')
      }, SPLASH_MIN)
    } else {
      // No cache → wait for bootstrap to finish
      const splashStart = Date.now()
      bootstrap().then(() => {
        const elapsed = Date.now() - splashStart
        const delay = Math.max(0, SPLASH_MIN - elapsed)
        setTimeout(() => {
          setPhase(isOnboarded ? 'app' : 'onboarding')
        }, delay)
      })
    }
  }, [])

  // Ping online every 2 min so friends see us as online
  useEffect(() => {
    const id = setInterval(() => {
      const uid = useGameStore.getState().user?.id
      if (uid && uid !== 'dev') pingOnline(uid)
    }, 2 * 60 * 1000)
    return () => clearInterval(id)
  }, [])

  async function bootstrap() {
    const tgUser = getTelegramUser()
    const store = useGameStore.getState()

    if (!tgUser) {
      // ── Dev fallback ──
      setUser({ id: 'dev', first_name: 'Dev', username: 'dev', wins: 3, losses: 1 })
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
        { id: '1',  first_name: 'Александр', username: 'alex_trade', balance: 4850, wins: 24, losses: 6 },
        { id: '2',  first_name: 'Мария',     username: 'masha_win',  balance: 2130, wins: 18, losses: 9 },
        { id: '3',  first_name: 'Дмитрий',   username: 'dmitry_x',   balance: 1740, wins: 21, losses: 8 },
        { id: '4',  first_name: 'Кирилл',    username: 'kirill_up',  balance: 1220, wins: 15, losses: 7 },
        { id: '5',  first_name: 'Анна',      username: 'anna_pro',   balance: 980,  wins: 12, losses: 5 },
        { id: '6',  first_name: 'Сергей',    username: 'serg_bet',   balance: 760,  wins: 10, losses: 6 },
        { id: '7',  first_name: 'Оля',       username: 'olya_q',     balance: 530,  wins: 9,  losses: 8 },
        { id: '8',  first_name: 'Максим',    username: 'max_mm',     balance: 390,  wins: 8,  losses: 7 },
        { id: '9',  first_name: 'Лера',      username: 'lera_win',   balance: 210,  wins: 7,  losses: 9 },
        { id: '10', first_name: 'Паша',      username: 'pasha_ok',   balance: 95,   wins: 5,  losses: 6 },
      ])
      store.setGuild({
        id: 'g1', name: 'IQ Masters', description: 'High IQ only.',
        avatar_url: null, creator_id: 'dev', rank: 8,
        member_count: 8, pnl: 21500, creator_name: 'Dev',
      })
      store.setGuildMembers([
        { user_id: 'dev', first_name: 'Dev',       username: 'dev',      role: 'creator', pnl: 8200 },
        { user_id: '2',   first_name: 'Мария',     username: 'masha_q',  role: 'member',  pnl: 5400 },
        { user_id: '3',   first_name: 'Дмитрий',   username: 'dima_iq',  role: 'member',  pnl: 3800 },
        { user_id: '4',   first_name: 'Кирилл',    username: 'kirill99', role: 'member',  pnl: 2100 },
        { user_id: '5',   first_name: 'Анна',      username: 'anna_win', role: 'member',  pnl: 1200 },
        { user_id: '6',   first_name: 'Сергей',    username: 'serg_top', role: 'member',  pnl: 500  },
        { user_id: '7',   first_name: 'Оля',       username: 'olya_q',   role: 'member',  pnl: 200  },
        { user_id: '8',   first_name: 'Максим',    username: 'max_iq',   role: 'member',  pnl: 100  },
      ])
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
        { id: '1', first_name: 'Александр', username: 'alex_trade', avatar_url: null, last_seen: new Date().toISOString() },
        { id: '2', first_name: 'Мария',     username: 'masha_win',  avatar_url: null, last_seen: new Date(Date.now() - 120000).toISOString() },
        { id: '5', first_name: 'Анна',      username: 'anna_pro',   avatar_url: null, last_seen: new Date(Date.now() - 7200000).toISOString() },
      ])
      store.setFriendRequests([
        { request_id: 'req1', from_user: { id: '3', first_name: 'Дмитрий', username: 'dmitry_x', avatar_url: null }, created_at: new Date(Date.now() - 3600000).toISOString() },
        { request_id: 'req2', from_user: { id: '6', first_name: 'Сергей',  username: 'serg_bet', avatar_url: null }, created_at: new Date(Date.now() - 7200000).toISOString() },
      ])
      store.setSentRequestIds(['4'])
      return
    }

    // ── Real user ──
    const user = await getOrCreateUser(tgUser)
    setUser(user)
    setBalance(user.balance ?? 0)

    // 6 parallel fetches — all data for the entire app
    const [profile, plans, leaderboard, guildData, opponents, friendsData] = await Promise.all([
      getUserProfile(user.id),
      getPlans(),
      getLeaderboard(50),
      getGuildData(user.id),
      getRecentOpponents(user.id),
      getFriendsData(user.id),
    ])

    // Profile
    if (profile && !profile.error) {
      store.setRank(profile.rank)
      store.setDailyStats(profile.daily_stats ?? [])
      store.setTotalPnl(profile.total_pnl ?? 0)
      store.setRefEarnings(profile.ref_earnings ?? { day: 0, week: 0, month: 0, all: 0 })
    }
    if (plans.length > 0) store.setPlans(plans)

    // Leaderboard
    store.setLeaderboard(leaderboard)

    // Guilds
    if (guildData) {
      store.setGuild(guildData.my_guild ?? null)
      store.setGuildMembers(guildData.my_guild?.members ?? [])
      store.setTopGuilds(guildData.top_guilds ?? [])
      store.setGuildSeason(guildData.season ?? null)
    }

    // Recent opponents
    store.setRecentOpponents(opponents ?? [])

    // Friends
    if (friendsData) {
      store.setFriends(friendsData.friends ?? [])
      store.setFriendRequests(friendsData.incoming_requests ?? [])
      store.setSentRequestIds(friendsData.outgoing_request_ids ?? [])
    }

    // Write cache for instant load next time
    writeCache({
      leaderboard,
      topGuilds:       guildData?.top_guilds ?? [],
      guild:           guildData?.my_guild ?? null,
      guildMembers:    guildData?.my_guild?.members ?? [],
      guildSeason:     guildData?.season ?? null,
      recentOpponents: opponents ?? [],
      friends:         friendsData?.friends ?? [],
      friendRequests:  friendsData?.incoming_requests ?? [],
      sentRequestIds:  friendsData?.outgoing_request_ids ?? [],
    })

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
