import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import useGameStore from '../store/useGameStore'
import { haptic } from '../lib/telegram'
import { translations } from '../lib/i18n'
import {
  supabase,
  BOT_USER_ID,
  calcPayout,
  getCircleDuel,
  submitCircleResult,
  heartbeatDuel,
  forfeitDuel,
  claimForfeit,
} from '../lib/supabase'
import { updateLocalStats } from '../lib/gameUtils'
import sound from '../lib/sounds'
import './Circle.css'

const TOTAL_ROUNDS = 3
const ROUND_TIME_MS = 10000
const MIN_POINTS = 20
const MIN_RADIUS = 32
const ACCENT = '#A855F7'
const PERCENT_SCALE = 100

function createDevDuel(duelId) {
  const parts = duelId.replace('dev-', '').split('-')
  const stake = parseInt(parts[parts.length - 1], 10) || 100

  return {
    id: duelId,
    creator_id: 'dev',
    opponent_id: BOT_USER_ID,
    stake,
    status: 'active',
    is_bot_game: true,
    bot_should_win: Math.random() < 0.5,
    game_type: 'circle',
  }
}

function computeCircularityScore(points) {
  if (!points || points.length < MIN_POINTS) {
    return { score: 0, reason: 'short', center: null, radius: 0 }
  }

  let totalLen = 0
  for (let i = 1; i < points.length; i++) {
    totalLen += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
  }
  if (totalLen < 120) {
    return { score: 0, reason: 'short', center: null, radius: 0 }
  }

  const sampleCount = 64
  const step = totalLen / (sampleCount - 1)
  const sampled = [points[0]]
  let acc = 0

  for (let i = 1; i < points.length && sampled.length < sampleCount; i++) {
    const prev = points[i - 1]
    const cur = points[i]
    const segLen = Math.hypot(cur.x - prev.x, cur.y - prev.y)
    if (!segLen) continue

    const segmentEnd = acc + segLen
    while (segmentEnd >= step * sampled.length && sampled.length < sampleCount) {
      const need = step * sampled.length - acc
      const t = need / segLen
      sampled.push({
        x: prev.x + (cur.x - prev.x) * t,
        y: prev.y + (cur.y - prev.y) * t,
      })
    }
    acc += segLen
  }

  while (sampled.length < sampleCount) {
    sampled.push(points[points.length - 1])
  }

  const cx = sampled.reduce((sum, point) => sum + point.x, 0) / sampled.length
  const cy = sampled.reduce((sum, point) => sum + point.y, 0) / sampled.length

  const radii = sampled.map((point) => Math.hypot(point.x - cx, point.y - cy))
  const meanR = radii.reduce((sum, radius) => sum + radius, 0) / radii.length
  if (meanR < MIN_RADIUS) {
    return { score: 0, reason: 'short', center: { x: cx, y: cy }, radius: meanR }
  }

  const variance = radii.reduce((sum, radius) => sum + (radius - meanR) ** 2, 0) / radii.length
  const stdDev = Math.sqrt(variance)
  const cv = stdDev / meanR

  const first = points[0]
  const last = points[points.length - 1]
  const gap = Math.hypot(first.x - last.x, first.y - last.y)
  const circumference = 2 * Math.PI * meanR
  const gapRatio = Math.min(1, gap / circumference)

  const angles = sampled.map((point) => Math.atan2(point.y - cy, point.x - cx)).sort((a, b) => a - b)
  let maxGap = 0
  for (let i = 1; i < angles.length; i++) {
    maxGap = Math.max(maxGap, angles[i] - angles[i - 1])
  }
  maxGap = Math.max(maxGap, (angles[0] + Math.PI * 2) - angles[angles.length - 1])
  const coverage = Math.max(0, Math.min(1, 1 - maxGap / (Math.PI * 2)))

  const roundness = Math.max(0, 1 - cv * 2.8)
  const closure = Math.max(0, 1 - gapRatio * 2.2)
  const coverageBonus = 0.82 + 0.18 * coverage
  const raw = roundness * 0.75 + closure * 0.25
  const score = Math.max(0, Math.min(10000, Math.round(raw * coverageBonus * 100 * PERCENT_SCALE)))

  return { score, reason: 'ok', center: { x: cx, y: cy }, radius: meanR }
}

function average(values) {
  if (!values?.length) return 0
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
}

function formatPercent(score) {
  return `${(score / PERCENT_SCALE).toFixed(2)}%`
}

function toProgressPercent(score) {
  return Math.max(0, Math.min(100, score / PERCENT_SCALE))
}

function verdictKey(score, t) {
  if (score >= 9000) return t.circlePerfect
  if (score >= 7500) return t.circleGreat
  if (score >= 5500) return t.circleGood
  return t.circleWeak
}

function getScoreTone(score, reason) {
  if (reason === 'short') {
    return {
      color: '#FB7185',
      glow: 'rgba(251, 113, 133, 0.42)',
      track: 'linear-gradient(90deg, #FB7185 0%, #EF4444 100%)',
      badgeClass: 'bad',
    }
  }

  if (score >= 8500) {
    return {
      color: '#34D399',
      glow: 'rgba(52, 211, 153, 0.42)',
      track: 'linear-gradient(90deg, #34D399 0%, #10B981 100%)',
      badgeClass: 'great',
    }
  }

  if (score >= 6000) {
    return {
      color: '#FBBF24',
      glow: 'rgba(251, 191, 36, 0.42)',
      track: 'linear-gradient(90deg, #FBBF24 0%, #F59E0B 100%)',
      badgeClass: 'ok',
    }
  }

  return {
    color: '#FB7185',
    glow: 'rgba(251, 113, 133, 0.42)',
    track: 'linear-gradient(90deg, #FB7185 0%, #EF4444 100%)',
    badgeClass: 'bad',
  }
}

function clampScore(score) {
  return Math.max(1500, Math.min(9999, Math.round(score)))
}

function generateBotResult(myAvg, myTime, shouldWin) {
  const target = shouldWin
    ? Math.min(9600, Math.max(myAvg + 500 + Math.random() * 700, 5800))
    : Math.max(2600, Math.min(myAvg - 500 - Math.random() * 700, 9000))

  const scores = Array.from({ length: TOTAL_ROUNDS }, () => clampScore(target + (Math.random() - 0.5) * 1200))
  let avg = average(scores)

  if (shouldWin && avg <= myAvg) {
    scores[scores.length - 1] = clampScore(scores[scores.length - 1] + (myAvg - avg) + 200)
    avg = average(scores)
  }

  if (!shouldWin && avg >= myAvg) {
    scores[scores.length - 1] = clampScore(scores[scores.length - 1] - ((avg - myAvg) + 200))
    avg = average(scores)
  }

  let time
  if (avg === myAvg) {
    time = shouldWin ? myTime - (0.7 + Math.random() * 1.6) : myTime + (0.7 + Math.random() * 1.6)
  } else if (shouldWin) {
    time = myTime - (0.2 + Math.random() * 1.2)
  } else {
    time = myTime + (0.2 + Math.random() * 1.4)
  }

  return {
    scores,
    avg,
    time: Math.max(8, Math.round(time * 10) / 10),
  }
}

function resolveWinner(myScore, myTime, oppScore, oppTime) {
  if (myScore > oppScore) {
    return { won: true, tiebreak: false, timeDiff: 0 }
  }
  if (myScore < oppScore) {
    return { won: false, tiebreak: false, timeDiff: 0 }
  }

  const timeDiff = Math.round(Math.abs(myTime - oppTime) * 10) / 10
  return {
    won: myTime <= oppTime,
    tiebreak: true,
    timeDiff,
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export default function Circle() {
  const { duelId } = useParams()
  const navigate = useNavigate()
  const lang = useGameStore((state) => state.lang)
  const user = useGameStore((state) => state.user)
  const setLastResult = useGameStore((state) => state.setLastResult)
  const setActiveDuel = useGameStore((state) => state.setActiveDuel)
  const t = translations[lang] || translations.ru

  const isDevDuel = duelId?.startsWith('dev-')

  const [duel, setDuel] = useState(() => (duelId?.startsWith('dev-') ? createDevDuel(duelId) : null))
  const [loading, setLoading] = useState(() => !duelId?.startsWith('dev-'))
  const [phase, setPhase] = useState('countdown')
  const [countdown, setCountdown] = useState(3)
  const [roundIndex, setRoundIndex] = useState(0)
  const [scores, setScores] = useState([])
  const [lastScore, setLastScore] = useState(null)
  const [drawing, setDrawing] = useState(false)
  const [timeLeft, setTimeLeft] = useState(ROUND_TIME_MS)
  const [matchSummary, setMatchSummary] = useState(null)
  const [waitingOpponent, setWaitingOpponent] = useState(false)
  const [finished, setFinished] = useState(false)

  const canvasRef = useRef(null)
  const overlayCanvasRef = useRef(null)
  const containerRef = useRef(null)
  const pointsRef = useRef([])
  const drawingRef = useRef(false)
  const phaseRef = useRef('countdown')
  const scoresRef = useRef([])
  const totalTimeRef = useRef(0)
  const roundStartTimeRef = useRef(0)
  const finishedRef = useRef(false)
  const heartbeatRef = useRef(null)
  const forfeitedRef = useRef(false)
  const roundTimerRef = useRef(null)
  const tickIntervalRef = useRef(null)
  const isBotGameRef = useRef(isDevDuel)
  const botShouldWinRef = useRef(duel?.bot_should_win ?? false)

  useEffect(() => {
    phaseRef.current = phase
  }, [phase])

  const clearRoundTimers = useCallback(() => {
    if (roundTimerRef.current) {
      clearTimeout(roundTimerRef.current)
      roundTimerRef.current = null
    }
    if (tickIntervalRef.current) {
      clearInterval(tickIntervalRef.current)
      tickIntervalRef.current = null
    }
  }, [])

  useEffect(() => {
    return () => {
      clearRoundTimers()
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current)
        heartbeatRef.current = null
      }
    }
  }, [clearRoundTimers])

  useEffect(() => {
    if (!duel) return
    isBotGameRef.current = !!duel.is_bot_game
    botShouldWinRef.current = !!duel.bot_should_win
    setActiveDuel(duel)
  }, [duel, setActiveDuel])

  useEffect(() => {
    let alive = true
    finishedRef.current = false
    forfeitedRef.current = false
    clearRoundTimers()

    if (isDevDuel) {
      isBotGameRef.current = true
      botShouldWinRef.current = !!duel?.bot_should_win
      return () => {
        alive = false
      }
    }

    async function loadDuel() {
      let duelData = null
      for (let attempt = 0; attempt < 3; attempt++) {
        duelData = await getCircleDuel(duelId)
        if (duelData) break
        await sleep(1000)
      }

      if (!alive) return

      if (!duelData) {
        navigate('/')
        return
      }

      setDuel(duelData)
      setLoading(false)
    }

    loadDuel()

    return () => {
      alive = false
    }
  }, [clearRoundTimers, duel?.bot_should_win, duelId, isDevDuel, navigate])

  useEffect(() => {
    if (loading || !duel || isDevDuel || !duelId || !user?.id || user.id === 'dev' || finished) return
    heartbeatDuel(duelId, user.id)
    heartbeatRef.current = setInterval(() => {
      heartbeatDuel(duelId, user.id)
    }, 10000)

    return () => {
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current)
        heartbeatRef.current = null
      }
    }
  }, [duel, duelId, finished, isDevDuel, loading, user?.id])

  useEffect(() => {
    if (loading || !duel || isDevDuel || !duelId || !user?.id || user.id === 'dev') return

    function handleVisibilityChange() {
      if (document.visibilityState === 'hidden' && !finishedRef.current && !forfeitedRef.current) {
        forfeitedRef.current = true
        if (heartbeatRef.current) {
          clearInterval(heartbeatRef.current)
          heartbeatRef.current = null
        }
        forfeitDuel(duelId, user.id)
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [duel, duelId, isDevDuel, loading, user?.id])

  useEffect(() => {
    function resize() {
      const container = containerRef.current
      const canvas = canvasRef.current
      const overlay = overlayCanvasRef.current
      if (!container || !canvas || !overlay) return

      const width = container.clientWidth
      const height = container.clientHeight
      const dpr = Math.min(window.devicePixelRatio || 1, 2)

      ;[canvas, overlay].forEach((node) => {
        node.width = width * dpr
        node.height = height * dpr
        node.style.width = `${width}px`
        node.style.height = `${height}px`
        const ctx = node.getContext('2d')
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      })
    }

    resize()
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [loading, phase])

  const clearCanvases = useCallback(() => {
    const canvas = canvasRef.current
    const overlay = overlayCanvasRef.current

    if (canvas) {
      const ctx = canvas.getContext('2d')
      ctx.clearRect(0, 0, canvas.width, canvas.height)
    }

    if (overlay) {
      const ctx = overlay.getContext('2d')
      ctx.clearRect(0, 0, overlay.width, overlay.height)
    }
  }, [])

  const finishAttempt = useCallback((points) => {
    if (phaseRef.current !== 'draw') return

    clearRoundTimers()

    const elapsed = Math.min(ROUND_TIME_MS, Math.max(0, performance.now() - roundStartTimeRef.current))
    totalTimeRef.current += elapsed / 1000

    const result = computeCircularityScore(points)
    setLastScore({ ...result, points: [...points] })

    if (result.center && result.radius > 0 && points.length >= MIN_POINTS) {
      const overlay = overlayCanvasRef.current
      if (overlay) {
        const ctx = overlay.getContext('2d')
        ctx.clearRect(0, 0, overlay.width, overlay.height)
        ctx.lineWidth = 2.4
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.48)'
        ctx.setLineDash([6, 7])
        ctx.beginPath()
        ctx.arc(result.center.x, result.center.y, result.radius, 0, Math.PI * 2)
        ctx.stroke()
        ctx.setLineDash([])
      }
    }

    if (result.score >= 8500) {
      haptic('heavy')
      sound.correct?.()
    } else if (result.score >= 6000) {
      haptic('medium')
      sound.correct?.()
    } else {
      haptic('light')
      sound.incorrect?.()
    }

    const nextScores = [...scoresRef.current, result.score]
    scoresRef.current = nextScores
    setScores(nextScores)
    setPhase('result')
  }, [clearRoundTimers])

  const startRound = useCallback(() => {
    setLastScore(null)
    setDrawing(false)
    drawingRef.current = false
    pointsRef.current = []
    clearCanvases()
    clearRoundTimers()
    setTimeLeft(ROUND_TIME_MS)
    roundStartTimeRef.current = performance.now()
    setPhase('draw')

    let remaining = ROUND_TIME_MS
    tickIntervalRef.current = setInterval(() => {
      remaining = Math.max(0, remaining - 50)
      setTimeLeft(remaining)
      if (remaining <= 0) {
        if (tickIntervalRef.current) {
          clearInterval(tickIntervalRef.current)
          tickIntervalRef.current = null
        }
        setDrawing(false)
        drawingRef.current = false
      }
    }, 50)

    roundTimerRef.current = setTimeout(() => {
      const timedOutPoints = drawingRef.current ? pointsRef.current : []
      drawingRef.current = false
      setDrawing(false)
      clearRoundTimers()
      finishAttempt(timedOutPoints)
    }, ROUND_TIME_MS + 30)
  }, [clearCanvases, clearRoundTimers, finishAttempt])

  useEffect(() => {
    if (loading || phase !== 'countdown') return undefined
    if (countdown <= 0) {
      const timer = setTimeout(() => startRound(), 0)
      return () => clearTimeout(timer)
    }

    haptic('light')
    sound.tick?.()
    const timer = setTimeout(() => setCountdown((value) => value - 1), 900)
    return () => clearTimeout(timer)
  }, [countdown, loading, phase, startRound])

  const submitWithRetry = useCallback(async (targetUserId, score, time) => {
    let result = await submitCircleResult(duelId, targetUserId, score, time)
    if (!result) {
      await sleep(1000)
      result = await submitCircleResult(duelId, targetUserId, score, time)
    }
    return result
  }, [duelId])

  const waitForFinishedDuel = useCallback(async (attempts, delayMs, allowForfeitCheck = false, myScore = 0) => {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const { data } = await supabase
        .from('duels')
        .select('*')
        .eq('id', duelId)
        .single()

      if (data?.status === 'finished') {
        return data
      }

      if (allowForfeitCheck && attempt > 0 && attempt % 5 === 0 && !forfeitedRef.current) {
        const res = await claimForfeit(duelId, user.id)
        if (res?.status === 'forfeited') {
          return {
            status: 'finished',
            winner_id: user.id,
            creator_id: duel.creator_id,
            opponent_id: duel.opponent_id,
            creator_score: duel.creator_id === user.id ? myScore : 0,
            opponent_score: duel.creator_id === user.id ? 0 : myScore,
            creator_time: duel.creator_id === user.id ? totalTimeRef.current : null,
            opponent_time: duel.creator_id === user.id ? null : totalTimeRef.current,
          }
        }
      }

      await sleep(delayMs)
    }

    return null
  }, [duel, duelId, user])

  const finishGame = useCallback(async () => {
    if (!duel || finishedRef.current) return

    finishedRef.current = true
    setFinished(true)
    setPhase('done')

    const myScores = [...scoresRef.current]
    const myScore = average(myScores)
    const myTime = Math.round(totalTimeRef.current * 10) / 10

    let won = null
    let oppScore = 0
    let payout = 0
    let tiebreak = false
    let timeDiff = 0
    let opponentScores = []

    if (isDevDuel) {
      const botResult = generateBotResult(myScore, myTime, botShouldWinRef.current)
      const resolved = resolveWinner(myScore, myTime, botResult.avg, botResult.time)
      won = resolved.won
      oppScore = botResult.avg
      payout = won ? calcPayout(duel.stake, user?.is_pro) : 0
      tiebreak = resolved.tiebreak
      timeDiff = resolved.timeDiff
      opponentScores = botResult.scores
    } else if (isBotGameRef.current) {
      const botResult = generateBotResult(myScore, myTime, botShouldWinRef.current)
      opponentScores = botResult.scores

      await submitWithRetry(user.id, myScore, myTime)
      setWaitingOpponent(true)

      const botDelay = Math.max(700, Math.min(4000, Math.round(Math.abs(botResult.time - myTime) * 1000)))
      await sleep(botDelay)
      await submitWithRetry(BOT_USER_ID, botResult.avg, botResult.time)

      const finalDuel = await waitForFinishedDuel(6, 1500)
      setWaitingOpponent(false)

      if (finalDuel?.status === 'finished') {
        const isCreator = finalDuel.creator_id === user.id
        won = finalDuel.winner_id === user.id
        oppScore = isCreator ? finalDuel.opponent_score : finalDuel.creator_score
        tiebreak = finalDuel.creator_score === finalDuel.opponent_score
        const oppTime = isCreator ? finalDuel.opponent_time : finalDuel.creator_time
        timeDiff = tiebreak ? Math.round(Math.abs(myTime - (oppTime || 0)) * 10) / 10 : 0
      } else {
        const resolved = resolveWinner(myScore, myTime, botResult.avg, botResult.time)
        won = resolved.won
        oppScore = botResult.avg
        tiebreak = resolved.tiebreak
        timeDiff = resolved.timeDiff
      }

      payout = won ? calcPayout(duel.stake, user?.is_pro) : 0
    } else {
      await submitWithRetry(user.id, myScore, myTime)
      setWaitingOpponent(true)

      const finalDuel = await waitForFinishedDuel(30, 2000, true, myScore)
      setWaitingOpponent(false)

      if (finalDuel?.status === 'finished') {
        const isCreator = duel.creator_id === user.id
        oppScore = isCreator ? finalDuel.opponent_score : finalDuel.creator_score
        won = finalDuel.winner_id === user.id
        tiebreak = finalDuel.creator_score === finalDuel.opponent_score
        const oppTime = isCreator ? finalDuel.opponent_time : finalDuel.creator_time
        timeDiff = tiebreak ? Math.round(Math.abs(myTime - (oppTime || 0)) * 10) / 10 : 0
      } else {
        oppScore = 0
        won = null
      }

      payout = won ? calcPayout(duel.stake, user?.is_pro) : 0
    }

    setMatchSummary({
      won,
      myAvg: myScore,
      opponentAvg: oppScore,
      myScores,
      opponentScores,
    })

    if (!isDevDuel && won !== null) {
      updateLocalStats({ won, stake: duel.stake, userId: user?.id })
    }

    setLastResult({
      won,
      myScore,
      oppScore,
      total: 100,
      payout,
      stake: duel.stake,
      duelId,
      tiebreak,
      timeDiff,
      gameType: 'circle',
    })
    navigate('/result')
  }, [duel, duelId, isDevDuel, navigate, setLastResult, submitWithRetry, user, waitForFinishedDuel])

  useEffect(() => {
    if (phase !== 'result') return undefined

    const timer = setTimeout(() => {
      const nextRound = roundIndex + 1
      if (nextRound >= TOTAL_ROUNDS) {
        finishGame()
      } else {
        setRoundIndex(nextRound)
        startRound()
      }
    }, 1900)

    return () => clearTimeout(timer)
  }, [finishGame, phase, roundIndex, startRound])

  function addPoint(clientX, clientY) {
    const canvas = canvasRef.current
    if (!canvas) return

    const rect = canvas.getBoundingClientRect()
    const x = clientX - rect.left
    const y = clientY - rect.top
    pointsRef.current.push({ x, y })

    const ctx = canvas.getContext('2d')
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.lineWidth = 5
    ctx.strokeStyle = ACCENT
    ctx.shadowColor = ACCENT
    ctx.shadowBlur = 16

    const pts = pointsRef.current
    if (pts.length >= 2) {
      const from = pts[pts.length - 2]
      const to = pts[pts.length - 1]
      ctx.beginPath()
      ctx.moveTo(from.x, from.y)
      ctx.lineTo(to.x, to.y)
      ctx.stroke()
    }
  }

  const onPointerDown = useCallback((event) => {
    if (phaseRef.current !== 'draw') return
    if (event.button != null && event.button !== 0) return

    event.preventDefault()
    drawingRef.current = true
    setDrawing(true)
    haptic('light')
    clearCanvases()
    pointsRef.current = []

    const touch = event.touches?.[0]
    addPoint(touch ? touch.clientX : event.clientX, touch ? touch.clientY : event.clientY)
  }, [clearCanvases])

  const onPointerMove = useCallback((event) => {
    if (!drawingRef.current || phaseRef.current !== 'draw') return
    event.preventDefault()
    const touch = event.touches?.[0]
    addPoint(touch ? touch.clientX : event.clientX, touch ? touch.clientY : event.clientY)
  }, [])

  const onPointerUp = useCallback((event) => {
    if (!drawingRef.current) return
    event.preventDefault()
    drawingRef.current = false
    setDrawing(false)
    finishAttempt(pointsRef.current)
  }, [finishAttempt])

  if (loading) {
    return (
      <div className="circle-page">
        <div className="circle-loading">
          <div className="game-loading-spinner" />
        </div>
      </div>
    )
  }

  const attemptIdx = Math.min(roundIndex, TOTAL_ROUNDS - 1)
  const avgScore = average(scores)
  const timePct = Math.max(0, (timeLeft / ROUND_TIME_MS) * 100)
  const scoreTone = getScoreTone(lastScore?.score ?? 0, lastScore?.reason)
  const stageStatus = phase === 'draw'
    ? (drawing ? t.circleDrawing : t.circleReady)
    : phase === 'result'
      ? t.circleScoreLabel
      : phase === 'done'
        ? t.circleFinish
        : t.circleReady
  const roundLabel = `${attemptIdx + 1}/${TOTAL_ROUNDS}`
  const lastRoundScore = scores.length ? formatPercent(scores[scores.length - 1]) : '--'
  const urgentTime = timeLeft <= 2500

  if (phase === 'done' && matchSummary) {
    return (
      <div className="circle-page circle-page--done">
        <div className="circle-done-shell">
          <div className="circle-done">
            <span className="circle-done-title">{t.circleScoreLabel || 'Result'}</span>

            <div className="circle-done-rounds">
              {matchSummary.myScores.map((score, index) => {
                const tone = score >= 8500 ? 'great' : score >= 6000 ? 'ok' : 'bad'
                return (
                  <div key={index} className={`circle-done-round ${tone}`}>
                    <span>{t.circleAttempt} {index + 1}</span>
                    <span>{formatPercent(score)}</span>
                  </div>
                )
              })}
            </div>

            <div className="circle-done-total">
              {t.circleAvgLabel}: <strong>{formatPercent(matchSummary.myAvg)}</strong>
            </div>

            {waitingOpponent && (
              <div className="circle-waiting">
                <div className="game-waiting-dots">
                  <span /><span /><span />
                </div>
                <span>{t.circleWaitingOpponent}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={`circle-page ${drawing ? 'is-drawing' : ''} ${phase === 'done' ? 'is-finished' : ''}`}>
      <div className="circle-shell">
        <div className="circle-head">
          <div className="circle-title-wrap">
            <h1 className="circle-title">{t.gameCircleTitle || 'Circle'}</h1>
            <p className="circle-subtitle">{t.circleDrawHint}</p>
          </div>

          <div className="circle-meta">
            <div className="circle-meta-card">
              <span className="circle-meta-label">{t.circleAttempt}</span>
              <span className="circle-meta-value">{roundLabel}</span>
            </div>
            <div className="circle-meta-card">
              <span className="circle-meta-label">{t.circleAvgLabel}</span>
              <span className="circle-meta-value">{scores.length ? formatPercent(avgScore) : '--'}</span>
            </div>
            <div className="circle-meta-card">
              <span className="circle-meta-label">{t.circleScoreLabel}</span>
              <span className="circle-meta-value">{lastRoundScore}</span>
            </div>
          </div>
        </div>

        <div className={`circle-stage circle-stage--${phase}`} ref={containerRef}>
          <div className="circle-stage-head">
            <div className="circle-stage-badge">
              <span>{stageStatus}</span>
            </div>
            <div className={`circle-stage-clock ${urgentTime && phase === 'draw' ? 'urgent' : ''}`}>
              {phase === 'draw' ? `${(timeLeft / 1000).toFixed(1)}s` : scores.length ? formatPercent(avgScore) : 'Ready'}
            </div>
          </div>

          {phase === 'countdown' && (
            <div className="circle-countdown">
              <div key={countdown} className="circle-countdown-num">{countdown}</div>
              <div className="circle-countdown-hint">{t.circleDrawHint}</div>
            </div>
          )}

          <canvas ref={canvasRef} className="circle-canvas" />
          <canvas ref={overlayCanvasRef} className="circle-overlay-canvas" />

          {phase === 'draw' && !drawing && (
            <div className="circle-hint-overlay">
              <div className="circle-hint-card">
                {t.circleDrawHint}
              </div>
            </div>
          )}

          {phase === 'result' && lastScore && (
            <div className="circle-result-overlay">
              <div
                className="circle-result-card"
                style={{
                  borderColor: scoreTone.color,
                  boxShadow: `0 20px 52px -24px ${scoreTone.glow}, 0 18px 40px -24px rgba(0, 0, 0, 0.84)`,
                }}
              >
                <div className="circle-result-score" style={{ color: scoreTone.color }}>
                  {formatPercent(lastScore.score)}
                </div>
                <div className="circle-result-verdict">
                  {lastScore.reason === 'short' ? t.circleTooShort : verdictKey(lastScore.score, t)}
                </div>
                <div className="circle-result-meter">
                  <span style={{ width: `${toProgressPercent(lastScore.score)}%`, background: scoreTone.track }} />
                </div>
                <div className="circle-result-meta">
                  <div className="circle-result-meta-item">
                    <span className="circle-result-meta-label">{t.circleAvgLabel}</span>
                    <span className="circle-result-meta-value">{formatPercent(avgScore)}</span>
                  </div>
                  <div className={`circle-result-badge ${scoreTone.badgeClass}`}>
                    {scores.length}/{TOTAL_ROUNDS}
                  </div>
                </div>
              </div>
            </div>
          )}

          {phase === 'draw' && (
            <div
              className="circle-capture"
              onTouchStart={onPointerDown}
              onTouchMove={onPointerMove}
              onTouchEnd={onPointerUp}
              onTouchCancel={onPointerUp}
              onMouseDown={onPointerDown}
              onMouseMove={onPointerMove}
              onMouseUp={onPointerUp}
              onMouseLeave={onPointerUp}
            />
          )}
        </div>

        <div className="circle-footer">
          {phase === 'draw' && (
            <>
              <div className="circle-timer">
                <div className="circle-timer-fill" style={{ width: `${timePct}%` }} />
              </div>
              <div className="circle-caption-row">
                <span className="circle-caption">{t.circleDrawHint}</span>
                <span className={`circle-caption-time ${urgentTime ? 'urgent' : ''}`}>{(timeLeft / 1000).toFixed(1)}s</span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
