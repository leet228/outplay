import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { feature } from 'topojson-client'
import topoData from 'world-atlas/countries-110m.json'
import useGameStore from '../store/useGameStore'
import { haptic } from '../lib/telegram'
import { translations } from '../lib/i18n'
import {
  supabase,
  getCapitalsDuel,
  submitCapitalsResult,
  calcPayout,
  heartbeatDuel,
  forfeitDuel,
  waitForFinishedDuelState,
} from '../lib/supabase'
import { updateLocalStats } from '../lib/gameUtils'
import { botLower, botHigher, enforceDirection } from '../lib/botScore'
import sound from '../lib/sounds'
import './Capitals.css'

const BOT_USER_ID = '00000000-0000-0000-0000-000000000001'
const TOTAL_ROUNDS = 3
const ROUND_TIME = 15
const MAX_PENALTY_KM = 5000
const REVEAL_MS = 2600

const ACCENT = '#06B6D4'
const CORRECT = '#22C55E'
const MIN_ZOOM = 1
const MAX_ZOOM = 6
const DRAG_THRESHOLD = 6

const VB_W = 1000
const VB_H = 500

const CAPITALS = [
  { city: 'Париж', cityEn: 'Paris', lat: 48.8566, lng: 2.3522 },
  { city: 'Лондон', cityEn: 'London', lat: 51.5074, lng: -0.1278 },
  { city: 'Токио', cityEn: 'Tokyo', lat: 35.6762, lng: 139.6503 },
  { city: 'Москва', cityEn: 'Moscow', lat: 55.7558, lng: 37.6173 },
  { city: 'Вашингтон', cityEn: 'Washington', lat: 38.9072, lng: -77.0369 },
  { city: 'Пекин', cityEn: 'Beijing', lat: 39.9042, lng: 116.4074 },
  { city: 'Берлин', cityEn: 'Berlin', lat: 52.52, lng: 13.405 },
  { city: 'Рим', cityEn: 'Rome', lat: 41.9028, lng: 12.4964 },
  { city: 'Мадрид', cityEn: 'Madrid', lat: 40.4168, lng: -3.7038 },
  { city: 'Каир', cityEn: 'Cairo', lat: 30.0444, lng: 31.2357 },
  { city: 'Оттава', cityEn: 'Ottawa', lat: 45.4215, lng: -75.6972 },
  { city: 'Бразилиа', cityEn: 'Brasilia', lat: -15.7939, lng: -47.8828 },
  { city: 'Буэнос-Айрес', cityEn: 'Buenos Aires', lat: -34.6037, lng: -58.3816 },
  { city: 'Канберра', cityEn: 'Canberra', lat: -35.2809, lng: 149.13 },
  { city: 'Претория', cityEn: 'Pretoria', lat: -25.7479, lng: 28.2293 },
  { city: 'Нью-Дели', cityEn: 'New Delhi', lat: 28.6139, lng: 77.209 },
  { city: 'Сеул', cityEn: 'Seoul', lat: 37.5665, lng: 126.978 },
  { city: 'Бангкок', cityEn: 'Bangkok', lat: 13.7563, lng: 100.5018 },
  { city: 'Джакарта', cityEn: 'Jakarta', lat: -6.2088, lng: 106.8456 },
  { city: 'Анкара', cityEn: 'Ankara', lat: 39.9334, lng: 32.8597 },
  { city: 'Тегеран', cityEn: 'Tehran', lat: 35.6892, lng: 51.389 },
  { city: 'Найроби', cityEn: 'Nairobi', lat: -1.2864, lng: 36.8172 },
  { city: 'Киев', cityEn: 'Kyiv', lat: 50.4501, lng: 30.5234 },
  { city: 'Варшава', cityEn: 'Warsaw', lat: 52.2297, lng: 21.0122 },
  { city: 'Стокгольм', cityEn: 'Stockholm', lat: 59.3293, lng: 18.0686 },
]

const WORLD_GEOJSON = feature(topoData, topoData.objects.countries)

function projLng(lng) {
  return ((lng + 180) / 360) * VB_W
}

function projLat(lat) {
  return ((90 - lat) / 180) * VB_H
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function clampPan(pan, zoom) {
  const minX = VB_W - VB_W * zoom
  const minY = VB_H - VB_H * zoom
  return {
    x: clamp(pan.x, minX, 0),
    y: clamp(pan.y, minY, 0),
  }
}

function fitPoints(points, targetZoom = 2.2) {
  if (!points.length) return { zoom: MIN_ZOOM, pan: { x: 0, y: 0 } }

  if (points.length === 1) {
    const point = points[0]
    const zoom = clamp(targetZoom, MIN_ZOOM, MAX_ZOOM)
    return {
      zoom,
      pan: clampPan({
        x: VB_W / 2 - point.x * zoom,
        y: VB_H / 2 - point.y * zoom,
      }, zoom),
    }
  }

  const padding = 96
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const width = Math.max(72, maxX - minX)
  const height = Math.max(72, maxY - minY)
  const zoom = clamp(
    Math.min((VB_W - padding * 2) / width, (VB_H - padding * 2) / height),
    MIN_ZOOM,
    3.2
  )
  const centerX = (minX + maxX) / 2
  const centerY = (minY + maxY) / 2
  return {
    zoom,
    pan: clampPan({
      x: VB_W / 2 - centerX * zoom,
      y: VB_H / 2 - centerY * zoom,
    }, zoom),
  }
}

const COUNTRY_PATHS = (() => {
  function ringToPath(ring) {
    if (!ring || ring.length < 2) return ''
    let d = ''
    let prevLng = null

    for (let i = 0; i < ring.length; i++) {
      const pt = ring[i]
      if (!pt || pt.length < 2) continue
      const [lng, lat] = pt
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue

      const x = projLng(lng).toFixed(1)
      const y = projLat(lat).toFixed(1)
      if (prevLng === null || Math.abs(lng - prevLng) > 180) d += `M${x} ${y}`
      else d += `L${x} ${y}`
      prevLng = lng
    }

    return d
  }

  return WORLD_GEOJSON.features.map((featureItem) => {
    const geometry = featureItem.geometry
    if (!geometry) return ''
    if (geometry.type === 'Polygon') return geometry.coordinates.map(ringToPath).join(' ')
    if (geometry.type === 'MultiPolygon') return geometry.coordinates.flatMap((poly) => poly.map(ringToPath)).join(' ')
    return ''
  })
})()

function kmBetween(a, b) {
  const R = 6371
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const s = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2)
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)))
}

function formatKm(km) {
  if (km < 10) return km.toFixed(1)
  return Math.round(km).toLocaleString('ru-RU')
}

// Stable fallback: derive a 32-bit seed from a UUID string (FNV-1a hash)
function uuidToSeed(uuid) {
  if (!uuid) return 1
  let hash = 2166136261 >>> 0
  for (let i = 0; i < uuid.length; i++) {
    hash ^= uuid.charCodeAt(i)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash || 1
}

// Deterministic PRNG — Mulberry32 (32-bit, good enough for shuffle)
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Fisher-Yates shuffle driven by a seeded RNG (or Math.random for dev fallback)
function pickCapitals(n, seed) {
  const rng = seed != null ? mulberry32(seed | 0) : Math.random
  const arr = [...CAPITALS]
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr.slice(0, n)
}

function generateBotTotal(myTotal, shouldWin) {
  // lower total km = better. Guarantee strict direction vs myTotal.
  const raw = shouldWin
    ? botLower(myTotal, 100, 900, 0)
    : botHigher(myTotal, 80, 850, 15000)
  return enforceDirection(raw, myTotal, shouldWin, 'lower', { floor: 0, ceiling: 15000 })
}

export default function Capitals() {
  const { duelId } = useParams()
  const navigate = useNavigate()
  const lang = useGameStore((s) => s.lang)
  const user = useGameStore((s) => s.user)
  const setLastResult = useGameStore((s) => s.setLastResult)
  const setActiveDuel = useGameStore((s) => s.setActiveDuel)
  const t = translations[lang] || translations.ru

  const isDevDuel = duelId?.startsWith('dev-')

  const [duel, setDuel] = useState(null)
  const [loading, setLoading] = useState(!isDevDuel)
  const [phase, setPhase] = useState('countdown')
  const [countdown, setCountdown] = useState(3)
  const [roundIndex, setRoundIndex] = useState(0)
  const [timeLeft, setTimeLeft] = useState(ROUND_TIME)
  const [myPin, setMyPin] = useState(null)
  const [rounds, setRounds] = useState([])
  const [capitalsList, setCapitalsList] = useState(null)
  const [waitingOpponent, setWaitingOpponent] = useState(false)
  const [zoom, setZoom] = useState(MIN_ZOOM)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [hasInteracted, setHasInteracted] = useState(false)
  const [isInteracting, setIsInteracting] = useState(false)

  const phaseRef = useRef('countdown')
  const myPinRef = useRef(null)
  const submittedRef = useRef(false)
  const advanceRef = useRef(null)
  const timerRef = useRef(null)
  const svgRef = useRef(null)
  const panRef = useRef({ x: 0, y: 0 })
  const zoomRef = useRef(MIN_ZOOM)
  const pointersRef = useRef(new Map())
  const gestureRef = useRef({
    mode: null,
    pointerId: null,
    startPoint: null,
    startPan: { x: 0, y: 0 },
    moved: false,
    pinchWorld: null,
    pinchStartDistance: 0,
    pinchStartZoom: MIN_ZOOM,
  })
  const roundsRef = useRef([])
  const roundIndexRef = useRef(0)
  const totalTimeRef = useRef(0)
  const heartbeatRef = useRef(null)
  const forfeitedRef = useRef(false)
  const finishedRef = useRef(false)
  const isBotGameRef = useRef(false)
  const botShouldWinRef = useRef(false)

  useEffect(() => {
    phaseRef.current = phase
  }, [phase])

  useEffect(() => {
    myPinRef.current = myPin
  }, [myPin])

  useEffect(() => {
    panRef.current = pan
  }, [pan])

  useEffect(() => {
    zoomRef.current = zoom
  }, [zoom])

  useEffect(() => {
    roundsRef.current = rounds
  }, [rounds])

  useEffect(() => {
    roundIndexRef.current = roundIndex
  }, [roundIndex])

  const currentCapital = capitalsList?.[roundIndex]
  const lastRound = rounds[rounds.length - 1]

  useEffect(() => {
    finishedRef.current = false
    if (isDevDuel) {
      const parts = duelId.replace('dev-', '').split('-')
      const stake = parseInt(parts[parts.length - 1], 10) || 100
      const seed = 1 + Math.floor(Math.random() * 2147483646)
      const mockDuel = {
        id: duelId,
        creator_id: 'dev',
        opponent_id: BOT_USER_ID,
        stake,
        status: 'active',
        is_bot_game: true,
        bot_should_win: Math.random() < 0.5,
        game_type: 'capitals',
        capitals_seed: seed,
      }
      setDuel(mockDuel)
      setActiveDuel(mockDuel)
      setCapitalsList(pickCapitals(TOTAL_ROUNDS, seed))
      isBotGameRef.current = true
      botShouldWinRef.current = mockDuel.bot_should_win
      setLoading(false)
      return
    }
    loadDuel()
  }, [duelId])

  async function loadDuel() {
    let duelData = null
    for (let attempt = 0; attempt < 3; attempt++) {
      duelData = await getCapitalsDuel(duelId)
      if (duelData) break
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    if (!duelData) {
      navigate('/')
      return
    }
    setDuel(duelData)
    setActiveDuel(duelData)
    // Fallback: older duels (or race with uncommitted seed) — derive a seed
    // from the duel UUID so both clients still produce the same list.
    const seed = duelData.capitals_seed ?? uuidToSeed(duelData.id)
    setCapitalsList(pickCapitals(TOTAL_ROUNDS, seed))
    if (duelData.is_bot_game) {
      isBotGameRef.current = true
      botShouldWinRef.current = !!duelData.bot_should_win
    }
    setLoading(false)
  }

  useEffect(() => () => {
    finishedRef.current = false
    if (advanceRef.current) clearTimeout(advanceRef.current)
    if (timerRef.current) clearTimeout(timerRef.current)
    if (heartbeatRef.current) clearInterval(heartbeatRef.current)
  }, [])

  useEffect(() => {
    if (isDevDuel || !duelId || !user?.id || user.id === 'dev' || finishedRef.current) return
    heartbeatDuel(duelId, user.id)
    heartbeatRef.current = setInterval(() => heartbeatDuel(duelId, user.id), 10000)
    return () => {
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current)
        heartbeatRef.current = null
      }
    }
  }, [duelId, user?.id, isDevDuel])

  useEffect(() => {
    if (isDevDuel || !duelId || !user?.id || user.id === 'dev') return
    function handleVis() {
      if (document.visibilityState === 'hidden' && !finishedRef.current && !forfeitedRef.current) {
        forfeitedRef.current = true
        if (heartbeatRef.current) {
          clearInterval(heartbeatRef.current)
          heartbeatRef.current = null
        }
        forfeitDuel(duelId, user.id)
      }
    }
    document.addEventListener('visibilitychange', handleVis)
    return () => document.removeEventListener('visibilitychange', handleVis)
  }, [duelId, user?.id, isDevDuel])

  useEffect(() => {
    if (loading || !capitalsList || phase !== 'countdown') return
    if (countdown <= 0) {
      startRound()
      return
    }
    const id = setTimeout(() => setCountdown((value) => value - 1), 900)
    return () => clearTimeout(id)
  }, [loading, capitalsList, phase, countdown])

  useEffect(() => {
    if (phase !== 'round') return
    if (timeLeft <= 0) {
      submitAnswer()
      return
    }
    timerRef.current = setTimeout(() => setTimeLeft((value) => value - 1), 1000)
    return () => clearTimeout(timerRef.current)
  }, [phase, timeLeft])

  function resetView() {
    setZoom(MIN_ZOOM)
    setPan({ x: 0, y: 0 })
  }

  function animateView(nextView) {
    setZoom(nextView.zoom)
    setPan(nextView.pan)
  }

  function startRound() {
    submittedRef.current = false
    setMyPin(null)
    setTimeLeft(ROUND_TIME)
    resetView()
    setPhase('round')
  }

  function focusReveal(round) {
    const points = [{ x: projLng(round.capital.lng), y: projLat(round.capital.lat) }]
    if (round.myPin) {
      points.push({ x: projLng(round.myPin.lng), y: projLat(round.myPin.lat) })
    }
    animateView(fitPoints(points, round.myPin ? 1.8 : 2.3))
  }

  function submitAnswer() {
    if (submittedRef.current) return
    submittedRef.current = true
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }

    const cap = currentCapital
    const pin = myPinRef.current
    const myKm = pin ? kmBetween(pin, cap) : MAX_PENALTY_KM
    const timeSpent = pin ? Math.max(0, ROUND_TIME - timeLeft) : ROUND_TIME
    totalTimeRef.current += timeSpent

    const round = { capital: cap, myPin: pin, myKm, timeSpent }
    const nextRounds = [...roundsRef.current, round]
    roundsRef.current = nextRounds
    setRounds(nextRounds)
    haptic('medium')
    if (!pin) sound.incorrect?.()
    else if (myKm < 150) sound.correct?.()
    else sound.incorrect?.()

    setPhase('reveal')
    focusReveal(round)

    if (advanceRef.current) clearTimeout(advanceRef.current)
    advanceRef.current = setTimeout(() => {
      const nextIdx = roundIndexRef.current + 1
      if (nextIdx >= TOTAL_ROUNDS) {
        finishGame()
      } else {
        setRoundIndex(nextIdx)
        startRound()
      }
    }, REVEAL_MS)
  }

  function getLocalPoint(e) {
    const svg = svgRef.current
    if (!svg) return null
    const pt = svg.createSVGPoint()
    pt.x = e.clientX
    pt.y = e.clientY
    const ctm = svg.getScreenCTM()
    if (!ctm) return null
    return pt.matrixTransform(ctm.inverse())
  }

  function placePinFromLocal(local) {
    const currentPan = panRef.current
    const currentZoom = zoomRef.current
    const svgX = (local.x - currentPan.x) / currentZoom
    const svgY = (local.y - currentPan.y) / currentZoom
    const clampedX = clamp(svgX, 0, VB_W)
    const clampedY = clamp(svgY, 0, VB_H)
    const lng = (clampedX / VB_W) * 360 - 180
    const lat = 90 - (clampedY / VB_H) * 180
    haptic('light')
    setMyPin({ lat, lng })
  }

  function handleSvgPointerDown(e) {
    if (phaseRef.current !== 'round') return
    const svg = svgRef.current
    const local = getLocalPoint(e)
    if (!svg || !local) return

    svg.setPointerCapture?.(e.pointerId)
    pointersRef.current.set(e.pointerId, local)
    setHasInteracted(true)
    setIsInteracting(true)

    if (pointersRef.current.size === 1) {
      gestureRef.current = {
        mode: 'drag',
        pointerId: e.pointerId,
        startPoint: local,
        startPan: panRef.current,
        moved: false,
        pinchWorld: null,
        pinchStartDistance: 0,
        pinchStartZoom: zoomRef.current,
      }
      return
    }

    if (pointersRef.current.size === 2) {
      const [a, b] = [...pointersRef.current.values()]
      const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      const currentPan = panRef.current
      const currentZoom = zoomRef.current
      gestureRef.current = {
        mode: 'pinch',
        pointerId: null,
        startPoint: null,
        startPan: currentPan,
        moved: true,
        pinchWorld: {
          x: (center.x - currentPan.x) / currentZoom,
          y: (center.y - currentPan.y) / currentZoom,
        },
        pinchStartDistance: Math.hypot(a.x - b.x, a.y - b.y),
        pinchStartZoom: currentZoom,
      }
    }
  }

  function handleSvgPointerMove(e) {
    if (!pointersRef.current.has(e.pointerId)) return
    const local = getLocalPoint(e)
    if (!local) return
    pointersRef.current.set(e.pointerId, local)

    const gesture = gestureRef.current
    if (gesture.mode === 'pinch' && pointersRef.current.size >= 2) {
      const [a, b] = [...pointersRef.current.values()]
      const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      const distance = Math.hypot(a.x - b.x, a.y - b.y)
      if (!distance || !gesture.pinchStartDistance || !gesture.pinchWorld) return
      const nextZoom = clamp(
        gesture.pinchStartZoom * (distance / gesture.pinchStartDistance),
        MIN_ZOOM,
        MAX_ZOOM
      )
      const nextPan = clampPan({
        x: center.x - gesture.pinchWorld.x * nextZoom,
        y: center.y - gesture.pinchWorld.y * nextZoom,
      }, nextZoom)
      setZoom(nextZoom)
      setPan(nextPan)
      return
    }

    if (gesture.mode === 'drag' && gesture.pointerId === e.pointerId && gesture.startPoint) {
      const dx = local.x - gesture.startPoint.x
      const dy = local.y - gesture.startPoint.y
      if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
        gestureRef.current.moved = true
      }
      setPan(clampPan({
        x: gesture.startPan.x + dx,
        y: gesture.startPan.y + dy,
      }, zoomRef.current))
    }
  }

  function handleSvgWheel(e) {
    if (phaseRef.current !== 'round') return
    e.preventDefault()
    const local = getLocalPoint(e)
    if (!local) return
    setHasInteracted(true)

    const currentZoom = zoomRef.current
    const currentPan = panRef.current
    const zoomFactor = e.deltaY < 0 ? 1.18 : 1 / 1.18
    const nextZoom = clamp(currentZoom * zoomFactor, MIN_ZOOM, MAX_ZOOM)
    if (nextZoom === currentZoom) return

    const worldX = (local.x - currentPan.x) / currentZoom
    const worldY = (local.y - currentPan.y) / currentZoom
    const nextPan = clampPan({
      x: local.x - worldX * nextZoom,
      y: local.y - worldY * nextZoom,
    }, nextZoom)

    setZoom(nextZoom)
    setPan(nextPan)
  }

  function handleSvgPointerUp(e) {
    const local = getLocalPoint(e)
    const gesture = gestureRef.current
    const wasTap =
      gesture.mode === 'drag' &&
      gesture.pointerId === e.pointerId &&
      !gesture.moved &&
      phaseRef.current === 'round'

    pointersRef.current.delete(e.pointerId)
    svgRef.current?.releasePointerCapture?.(e.pointerId)

    if (wasTap && local) {
      placePinFromLocal(local)
    }

    if (pointersRef.current.size === 1) {
      const [pointerId, point] = [...pointersRef.current.entries()][0]
      gestureRef.current = {
        mode: 'drag',
        pointerId,
        startPoint: point,
        startPan: panRef.current,
        moved: true,
        pinchWorld: null,
        pinchStartDistance: 0,
        pinchStartZoom: zoomRef.current,
      }
      return
    }

    if (pointersRef.current.size === 0) {
      setIsInteracting(false)
      gestureRef.current = {
        mode: null,
        pointerId: null,
        startPoint: null,
        startPan: panRef.current,
        moved: false,
        pinchWorld: null,
        pinchStartDistance: 0,
        pinchStartZoom: zoomRef.current,
      }
    }
  }

  function handleSvgPointerCancel(e) {
    pointersRef.current.delete(e.pointerId)
    svgRef.current?.releasePointerCapture?.(e.pointerId)
    if (pointersRef.current.size === 0) {
      setIsInteracting(false)
      gestureRef.current.mode = null
    }
  }

  function handleAnswerClick() {
    if (phase !== 'round' || !myPin) return
    haptic('medium')
    submitAnswer()
  }

  async function finishGame() {
    if (finishedRef.current) return
    finishedRef.current = true
    setPhase('done')

    const myTotal = Math.round(roundsRef.current.reduce((sum, round) => sum + round.myKm, 0))
    const myTime = Math.round(totalTimeRef.current * 100) / 100

    let won = null
    let oppScore = null
    let payout = 0
    let tiebreak = false
    let timeDiff = 0

    if (isDevDuel) {
      const botTotal = generateBotTotal(myTotal, botShouldWinRef.current)
      oppScore = botTotal
      won = myTotal <= botTotal
      payout = won ? calcPayout(duel.stake, user?.is_pro) : 0
      timeDiff = Math.abs(myTotal - botTotal)
    } else if (isBotGameRef.current) {
      // Re-fetch bot_should_win right before generating score — protects against
      // stale client state (e.g. if duel row was updated or initial load was off).
      try {
        const fresh = await getCapitalsDuel(duelId)
        if (fresh && typeof fresh.bot_should_win === 'boolean') {
          botShouldWinRef.current = fresh.bot_should_win
        }
      } catch {}

      const botTotal = generateBotTotal(myTotal, botShouldWinRef.current)
      oppScore = botTotal

      let submitOk = await submitCapitalsResult(duelId, user.id, myTotal, myTime)
      if (!submitOk) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        submitOk = await submitCapitalsResult(duelId, user.id, myTotal, myTime)
      }

      setWaitingOpponent(true)
      const botDelay = 1 + Math.random() * 3
      await new Promise((resolve) => setTimeout(resolve, botDelay * 1000))
      let botSubmitOk = await submitCapitalsResult(duelId, BOT_USER_ID, botTotal, botTotal / 1000)
      if (!botSubmitOk) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        await submitCapitalsResult(duelId, BOT_USER_ID, botTotal, botTotal / 1000)
      }

      const finalDuel = await waitForFinishedDuelState({
        duelId,
        columns: '*',
        timeoutMs: 12000,
      })
      setWaitingOpponent(false)

      if (finalDuel?.status === 'finished') {
        won = finalDuel.winner_id === user.id
        const isCreator = duel.creator_id === user.id
        oppScore = isCreator ? finalDuel.opponent_score : finalDuel.creator_score
        tiebreak = finalDuel.creator_score === finalDuel.opponent_score
        timeDiff = Math.abs(myTotal - (oppScore || 0))
      } else {
        won = !botShouldWinRef.current
        timeDiff = Math.abs(myTotal - botTotal)
      }
      payout = won ? calcPayout(duel.stake, user?.is_pro) : 0
    } else {
      setWaitingOpponent(true)
      let pvpSubmitOk = await submitCapitalsResult(duelId, user.id, myTotal, myTime)
      if (!pvpSubmitOk) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        await submitCapitalsResult(duelId, user.id, myTotal, myTime)
      }

      const finalDuel = await waitForFinishedDuelState({
        duelId,
        userId: user.id,
        columns: '*',
        timeoutMs: 90000,
        forfeitCheckMs: 10000,
      })
      setWaitingOpponent(false)

      const isCreator = duel.creator_id === user.id
      if (finalDuel?.status === 'finished') {
        oppScore = isCreator ? finalDuel.opponent_score : finalDuel.creator_score
        won = finalDuel.winner_id === user.id
        tiebreak = finalDuel.creator_score === finalDuel.opponent_score
        timeDiff = oppScore != null ? Math.abs(myTotal - oppScore) : 0
      } else {
        won = null
        oppScore = null
      }
      payout = won ? calcPayout(duel.stake, user?.is_pro) : 0
    }

    if (!isDevDuel && won !== null) {
      updateLocalStats({ won, stake: duel.stake, userId: user.id })
    }

    setLastResult({
      won,
      myScore: myTotal,
      oppScore: oppScore ?? 0,
      total: TOTAL_ROUNDS,
      payout: payout || 0,
      stake: duel?.stake || 0,
      duelId,
      tiebreak,
      timeDiff,
      gameType: 'capitals',
    })
    navigate('/result')
  }

  const myTotalSoFar = rounds.reduce((sum, round) => sum + round.myKm, 0)
  const timerLow = timeLeft <= 5
  const cityName = lang === 'ru' ? currentCapital?.city : currentCapital?.cityEn
  const revealBadge = (() => {
    if (phase !== 'reveal' || lastRound?.myKm == null) return null
    if (!lastRound?.myPin) return t.capMaxPenalty || 'Штраф 5000 км'
    if (lastRound.myKm < 50) return `${t.capPerfect || 'Идеально!'} · ${formatKm(lastRound.myKm)} км`
    return `${formatKm(lastRound.myKm)} ${t.capKmAway || 'км до цели'}`
  })()

  const displayPin = phase === 'reveal' ? lastRound?.myPin ?? myPin : myPin
  const myPinXY = displayPin ? { x: projLng(displayPin.lng), y: projLat(displayPin.lat) } : null
  const correctXY = currentCapital ? { x: projLng(currentCapital.lng), y: projLat(currentCapital.lat) } : null

  if ((loading && !isDevDuel) || !capitalsList) {
    return <div className="cap-page"><div className="cap-shell"><span style={{ color: 'rgba(255,255,255,0.5)', textAlign: 'center' }}>{t.gameLoading || 'Loading...'}</span></div></div>
  }

  if (phase === 'done') {
    return (
      <div className="cap-page cap-page--done">
        <div className="cap-shell">
          <div className="cap-done">
            <span className="cap-done-title">{t.capTotal || 'Итого'}</span>
            <div className="cap-done-rounds">
              {rounds.map((round, i) => (
                <div key={i} className={`cap-done-round ${!round.myPin ? 'penalty' : round.myKm < 100 ? 'ok' : ''}`}>
                  <span>{t.capRoundOf || 'Раунд'} {i + 1}</span>
                  <span>{formatKm(round.myKm)} км</span>
                </div>
              ))}
            </div>
            <div className="cap-done-total">
              <span>{t.capTotal || 'Итого'}:</span>
              <strong>{formatKm(myTotalSoFar)} км</strong>
            </div>

            {waitingOpponent && (
              <div className="cap-done-waiting">
                <div className="cap-done-dots"><span /><span /><span /></div>
                <span>{t.gameWaiting || t.capWaitingOpponent || 'Ждём соперника...'}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="cap-page">
      <div className="cap-shell">
        <div className="cap-top">
          <div className="cap-round-pill">
            <span className="cap-round-label">{t.capRoundOf || 'Раунд'}</span>
            <span className="cap-round-num">{Math.min(roundIndex + 1, TOTAL_ROUNDS)}/{TOTAL_ROUNDS}</span>
          </div>
          {phase === 'round' && (
            <div className={`cap-timer ${timerLow ? 'low' : ''}`}>
              <svg width="36" height="36" viewBox="0 0 36 36" aria-hidden>
                <circle cx="18" cy="18" r="15" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="2.5" />
                <circle
                  cx="18"
                  cy="18"
                  r="15"
                  fill="none"
                  stroke={timerLow ? '#ef4444' : ACCENT}
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeDasharray={`${2 * Math.PI * 15}`}
                  strokeDashoffset={`${2 * Math.PI * 15 * (1 - timeLeft / ROUND_TIME)}`}
                  transform="rotate(-90 18 18)"
                  style={{ transition: 'stroke-dashoffset 1s linear' }}
                />
              </svg>
              <span className="cap-timer-num">{timeLeft}</span>
            </div>
          )}
          <div className="cap-score-chip">
            <span className="cap-score-lbl">{t.capYou || 'Ты'}</span>
            <span className="cap-score-val">{formatKm(myTotalSoFar)} км</span>
          </div>
        </div>

        <div className="cap-prompt" key={`prompt-${roundIndex}-${phase}`}>
          <div className="cap-prompt-eyebrow">{t.capFindCapitalOf || 'Найди столицу'}</div>
          <div className="cap-prompt-city">{cityName || '—'}</div>
        </div>

        <div className="cap-map-wrap">
          <svg
            ref={svgRef}
            className="cap-map-svg"
            viewBox={`0 0 ${VB_W} ${VB_H}`}
            preserveAspectRatio="xMidYMid meet"
            onPointerDown={handleSvgPointerDown}
            onPointerMove={handleSvgPointerMove}
            onPointerUp={handleSvgPointerUp}
            onPointerCancel={handleSvgPointerCancel}
            onWheel={handleSvgWheel}
          >
            <rect x="0" y="0" width={VB_W} height={VB_H} fill="#111820" />

            <g
              className={`cap-map-viewport ${isInteracting ? 'is-interacting' : ''}`}
              style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
            >
              <g className="cap-countries">
                {COUNTRY_PATHS.map((d, i) => (
                  <path key={i} d={d} fill="#f0ece4" stroke="#101820" strokeWidth="0.7" strokeLinejoin="round" />
                ))}
              </g>

              {phase === 'reveal' && lastRound?.myPin && (
                <line
                  x1={projLng(lastRound.myPin.lng)}
                  y1={projLat(lastRound.myPin.lat)}
                  x2={projLng(lastRound.capital.lng)}
                  y2={projLat(lastRound.capital.lat)}
                  stroke={ACCENT}
                  strokeWidth="2"
                  strokeDasharray="5 6"
                  strokeLinecap="round"
                  className="cap-line"
                />
              )}

              {(phase === 'round' || phase === 'reveal') && myPinXY && (
                <g className="cap-pin cap-pin--me" transform={`translate(${myPinXY.x}, ${myPinXY.y})`}>
                  <circle r="14" fill={ACCENT} opacity="0.25" className="cap-pin-wave" />
                  <circle r="8" fill={ACCENT} stroke="#fff" strokeWidth="2.5" className="cap-pin-me-dot" />
                </g>
              )}

              {phase === 'reveal' && correctXY && (
                <g className="cap-pin cap-pin--correct" transform={`translate(${correctXY.x}, ${correctXY.y})`}>
                  <circle r="18" fill={CORRECT} opacity="0.25" className="cap-pin-glow" />
                  <circle r="10" fill={CORRECT} stroke="#fff" strokeWidth="2.5" />
                  <path d="M-4,0 L-1.5,2.5 L4,-3" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </g>
              )}
            </g>
          </svg>

          {!hasInteracted && phase === 'round' && (
            <div className="cap-map-hint">
              {t.capMapHint || 'Тяни карту, увеличивай пальцами и ставь метку коротким тапом'}
            </div>
          )}

          {phase === 'countdown' && (
            <div className="cap-countdown-overlay">
              <div className="cap-countdown-num" key={countdown}>{countdown > 0 ? countdown : 'GO'}</div>
            </div>
          )}

          {revealBadge && (
            <div className="cap-reveal-badge" key={`rev-${roundIndex}`}>
              <span
                className="cap-reveal-dot"
                style={{ background: !lastRound?.myPin ? '#ef4444' : lastRound.myKm < 50 ? CORRECT : ACCENT }}
              />
              <span className="cap-reveal-text">{revealBadge}</span>
            </div>
          )}
        </div>

        <div className="cap-answer-row">
          <button
            className={`cap-answer-btn ${phase === 'round' && myPin ? 'active' : 'disabled'}`}
            onClick={handleAnswerClick}
            disabled={phase !== 'round' || !myPin}
          >
            {t.capAnswer || 'Ответить'}
          </button>
        </div>
      </div>
    </div>
  )
}
