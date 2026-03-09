import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { initTelegram, getTelegramUser } from './lib/telegram'
import { getOrCreateUser } from './lib/supabase'
import useGameStore from './store/useGameStore'
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
import './App.css'

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
    if (!tgUser) {
      setUser({ id: 'dev', first_name: 'Dev', username: 'dev', wins: 3, losses: 1 })
      setBalance(500)
      return
    }
    const user = await getOrCreateUser(tgUser)
    setUser(user)
    setBalance(user.balance ?? 0)
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
