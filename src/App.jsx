import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { initTelegram, getTelegramUser } from './lib/telegram'
import { getOrCreateUser, getUserProfile } from './lib/supabase'
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

export default function App() {
  const { setUser, setBalance } = useGameStore()
  // 'splash' | 'onboarding' | 'app'
  const [phase, setPhase] = useState('splash')

  useEffect(() => {
    const tg = initTelegram()
    applyTelegramTheme(tg)

    const isOnboarded = localStorage.getItem('outplay_onboarded')
    const SPLASH_MIN = 1400 // ms — минимальное время сплэша

    const splashStart = Date.now()

    bootstrap().then(() => {
      const elapsed = Date.now() - splashStart
      const delay = Math.max(0, SPLASH_MIN - elapsed)
      setTimeout(() => {
        setPhase(isOnboarded ? 'app' : 'onboarding')
      }, delay)
    })
  }, [])

  async function bootstrap() {
    const tgUser = getTelegramUser()
    const store = useGameStore.getState()

    if (!tgUser) {
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
      return
    }

    const user = await getOrCreateUser(tgUser)
    setUser(user)
    setBalance(user.balance ?? 0)

    // Single RPC: rank + daily stats + total PnL
    const profile = await getUserProfile(user.id)
    if (profile && !profile.error) {
      store.setRank(profile.rank)
      store.setDailyStats(profile.daily_stats ?? [])
      store.setTotalPnl(profile.total_pnl ?? 0)
    }

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
