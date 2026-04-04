import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import useGameStore from '../store/useGameStore'
import { haptic } from '../lib/telegram'
import { translations } from '../lib/i18n'
import { calcPayout } from '../lib/supabase'
import { updateLocalStats } from '../lib/gameUtils'
import sound from '../lib/sounds'
import './Race.css'

const BOT_USER_ID = '00000000-0000-0000-0000-000000000001'
const TRACK_SEGMENTS = 300
const SEGMENT_HEIGHT = 4
const BALL_RADIUS = 10
const BASE_SPEED = 1.8
const MAX_SPEED = 3.5
const WALL_STOP_TIME = 500 // ms
const TRACK_START_WIDTH = 0.55 // fraction of canvas width
const TRACK_END_WIDTH = 0.30

// Generate track from seed
function generateTrack(width, segments) {
  const track = []
  let cx = width / 2
  const curves = [
    { freq: 0.02, amp: 0.25 },
    { freq: 0.007, amp: 0.15 },
    { freq: 0.04, amp: 0.1 },
  ]
  for (let i = 0; i < segments; i++) {
    const t = i / segments
    let offset = 0
    curves.forEach(c => { offset += Math.sin(i * c.freq * Math.PI * 2 + c.amp * 10) * c.amp * width })
    cx = width / 2 + offset
    const trackW = width * (TRACK_START_WIDTH + (TRACK_END_WIDTH - TRACK_START_WIDTH) * t)
    track.push({ cx, halfW: trackW / 2 })
  }
  return track
}

export default function Race() {
  const { duelId } = useParams()
  const navigate = useNavigate()
  const lang = useGameStore(s => s.lang)
  const user = useGameStore(s => s.user)
  const setLastResult = useGameStore(s => s.setLastResult)
  const setActiveDuel = useGameStore(s => s.setActiveDuel)
  const t = translations[lang] || translations.ru

  const isDevDuel = duelId?.startsWith('dev-')

  const [duel, setDuel] = useState(null)
  const isBotGameRef = useRef(false)
  const botShouldWinRef = useRef(false)

  const [phase, setPhase] = useState('countdown')
  const [countdown, setCountdown] = useState(3)
  const [finished, setFinished] = useState(false)
  const [finishTime, setFinishTime] = useState(0)
  const [wallHit, setWallHit] = useState(false)
  const [progress, setProgress] = useState(0)

  const canvasRef = useRef(null)
  const phaseRef = useRef('countdown')
  const finishedRef = useRef(false)
  const animRef = useRef(null)
  const trackRef = useRef([])
  const scrollPosRef = useRef(0)
  const ballXRef = useRef(0.5) // 0-1 fraction of canvas width
  const inputXRef = useRef(0.5)
  const speedRef = useRef(0)
  const startTimeRef = useRef(0)
  const wallStopUntilRef = useRef(0)
  const useGyroRef = useRef(false)
  const gyroDetectedRef = useRef(false)
  const gyroTimeoutRef = useRef(null)

  useEffect(() => { phaseRef.current = phase }, [phase])

  // ── Load duel ──
  useEffect(() => {
    finishedRef.current = false
    if (isDevDuel) {
      const parts = duelId.replace('dev-', '').split('-')
      const stake = parseInt(parts[parts.length - 1]) || 100
      const mockDuel = {
        id: duelId, creator_id: 'dev', opponent_id: BOT_USER_ID,
        stake, status: 'active', is_bot_game: true,
        bot_should_win: Math.random() < 0.5, game_type: 'race',
      }
      setDuel(mockDuel)
      setActiveDuel(mockDuel)
      isBotGameRef.current = true
      botShouldWinRef.current = mockDuel.bot_should_win
    }
  }, [duelId])

  // ── Cleanup ──
  useEffect(() => {
    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current)
      if (gyroTimeoutRef.current) clearTimeout(gyroTimeoutRef.current)
      window.removeEventListener('deviceorientation', handleGyro)
    }
  }, [])

  // ── Countdown ──
  useEffect(() => {
    if (phase !== 'countdown') return
    if (countdown <= 0) { startRace(); return }
    const timer = setTimeout(() => setCountdown(c => c - 1), 1000)
    return () => clearTimeout(timer)
  }, [phase, countdown])

  // ── Gyro handler ──
  const handleGyro = useCallback((e) => {
    if (!gyroDetectedRef.current) {
      gyroDetectedRef.current = true
      useGyroRef.current = true
    }
    // gamma: -90 to 90, left/right tilt
    const gamma = e.gamma || 0
    // Map -45..45 to 0..1
    inputXRef.current = Math.max(0, Math.min(1, (gamma + 45) / 90))
  }, [])

  // ── Mouse/touch handlers ──
  const handlePointerMove = useCallback((clientX) => {
    if (useGyroRef.current) return
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    inputXRef.current = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
  }, [])

  // ── Start race ──
  function startRace() {
    const canvas = canvasRef.current
    if (!canvas) return

    // Size canvas
    const parent = canvas.parentElement
    const w = parent.clientWidth
    const h = parent.clientHeight
    const dpr = window.devicePixelRatio || 1
    canvas.width = w * dpr
    canvas.height = h * dpr
    canvas.style.width = w + 'px'
    canvas.style.height = h + 'px'

    // Generate track
    trackRef.current = generateTrack(w, TRACK_SEGMENTS)
    scrollPosRef.current = 0
    ballXRef.current = w / 2
    inputXRef.current = 0.5
    speedRef.current = BASE_SPEED
    wallStopUntilRef.current = 0
    startTimeRef.current = performance.now()

    // Try gyroscope
    if (window.DeviceOrientationEvent) {
      window.addEventListener('deviceorientation', handleGyro)
      gyroTimeoutRef.current = setTimeout(() => {
        if (!gyroDetectedRef.current) {
          useGyroRef.current = false
        }
      }, 1500)
    }

    setPhase('racing')
    gameLoop()
  }

  // ── Game loop ──
  function gameLoop() {
    if (finishedRef.current) return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const dpr = window.devicePixelRatio || 1
    const w = canvas.width / dpr
    const h = canvas.height / dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const now = performance.now()
    const track = trackRef.current

    // ── Get current track segment ──
    const segIdx = Math.min(Math.floor(scrollPosRef.current / SEGMENT_HEIGHT), TRACK_SEGMENTS - 1)
    const seg = track[segIdx]

    if (seg) {
      // ── Map input (0-1) to position WITHIN track ──
      const leftWall = seg.cx - seg.halfW
      const rightWall = seg.cx + seg.halfW
      const trackW = seg.halfW * 2
      const targetX = leftWall + BALL_RADIUS + inputXRef.current * (trackW - BALL_RADIUS * 2)

      // Smooth lerp
      ballXRef.current += (targetX - ballXRef.current) * 0.15

      // ── Check wall stop ──
      const isStopped = now < wallStopUntilRef.current

      if (!isStopped) {
        const bx = ballXRef.current

        // ── Collision (edge of input range) ──
        if (bx - BALL_RADIUS < leftWall || bx + BALL_RADIUS > rightWall) {
          wallStopUntilRef.current = now + WALL_STOP_TIME
          setWallHit(true)
          haptic('error')
          setTimeout(() => setWallHit(false), 300)
          // Clamp
          if (bx - BALL_RADIUS < leftWall) ballXRef.current = leftWall + BALL_RADIUS + 2
          if (bx + BALL_RADIUS > rightWall) ballXRef.current = rightWall - BALL_RADIUS - 2
        } else {
          // ── Speed based on distance from center ──
          const distFromCenter = Math.abs(bx - seg.cx) / seg.halfW // 0=center, 1=wall
          const speedMult = 1 - distFromCenter * 0.7 // center=1, wall=0.3
          speedRef.current = BASE_SPEED + (MAX_SPEED - BASE_SPEED) * speedMult

          // ── Advance scroll ──
          scrollPosRef.current += speedRef.current
        }
      }
    }

    // ── Check finish ──
    const totalDist = TRACK_SEGMENTS * SEGMENT_HEIGHT
    const prog = Math.min(1, scrollPosRef.current / totalDist)
    setProgress(prog)

    if (scrollPosRef.current >= totalDist && !finishedRef.current) {
      finishedRef.current = true
      const elapsed = Math.round(now - startTimeRef.current)
      setFinishTime(elapsed)
      setFinished(true)
      setPhase('done')
      haptic('heavy')
      sound.correct()
      window.removeEventListener('deviceorientation', handleGyro)

      // Finish game after brief delay
      setTimeout(() => finishGame(elapsed), 1500)
      // Don't request next frame
      renderFrame(ctx, w, h, track)
      return
    }

    // ── Render ──
    renderFrame(ctx, w, h, track)
    animRef.current = requestAnimationFrame(gameLoop)
  }

  function renderFrame(ctx, w, h, track) {
    ctx.clearRect(0, 0, w, h)

    const scrollY = scrollPosRef.current
    const ballScreenY = h * 0.65 // ball at 65% from top

    // Draw track segments
    const startSeg = Math.max(0, Math.floor((scrollY - ballScreenY) / SEGMENT_HEIGHT))
    const endSeg = Math.min(TRACK_SEGMENTS, Math.ceil((scrollY + h) / SEGMENT_HEIGHT))

    // Track fill
    ctx.beginPath()
    for (let i = startSeg; i < endSeg; i++) {
      const seg = track[i]
      const screenY = h - ((i * SEGMENT_HEIGHT) - scrollY + ballScreenY)
      const left = seg.cx - seg.halfW
      const right = seg.cx + seg.halfW

      if (i === startSeg) {
        ctx.moveTo(left, screenY)
      } else {
        ctx.lineTo(left, screenY)
      }
    }
    for (let i = endSeg - 1; i >= startSeg; i--) {
      const seg = track[i]
      const screenY = h - ((i * SEGMENT_HEIGHT) - scrollY + ballScreenY)
      ctx.lineTo(seg.cx + seg.halfW, screenY)
    }
    ctx.closePath()
    ctx.fillStyle = 'rgba(6, 182, 212, 0.08)'
    ctx.fill()

    // Track walls (neon lines)
    // Left wall
    ctx.beginPath()
    ctx.strokeStyle = 'rgba(6, 182, 212, 0.7)'
    ctx.lineWidth = 2
    ctx.shadowColor = '#06B6D4'
    ctx.shadowBlur = 10
    for (let i = startSeg; i < endSeg; i++) {
      const seg = track[i]
      const screenY = h - ((i * SEGMENT_HEIGHT) - scrollY + ballScreenY)
      if (i === startSeg) ctx.moveTo(seg.cx - seg.halfW, screenY)
      else ctx.lineTo(seg.cx - seg.halfW, screenY)
    }
    ctx.stroke()

    // Right wall
    ctx.beginPath()
    for (let i = startSeg; i < endSeg; i++) {
      const seg = track[i]
      const screenY = h - ((i * SEGMENT_HEIGHT) - scrollY + ballScreenY)
      if (i === startSeg) ctx.moveTo(seg.cx + seg.halfW, screenY)
      else ctx.lineTo(seg.cx + seg.halfW, screenY)
    }
    ctx.stroke()
    ctx.shadowBlur = 0

    // Center line (dashed)
    ctx.beginPath()
    ctx.strokeStyle = 'rgba(6, 182, 212, 0.15)'
    ctx.lineWidth = 1
    ctx.setLineDash([8, 12])
    for (let i = startSeg; i < endSeg; i++) {
      const seg = track[i]
      const screenY = h - ((i * SEGMENT_HEIGHT) - scrollY + ballScreenY)
      if (i === startSeg) ctx.moveTo(seg.cx, screenY)
      else ctx.lineTo(seg.cx, screenY)
    }
    ctx.stroke()
    ctx.setLineDash([])

    // Ball
    const bx = ballXRef.current
    const isStopped = performance.now() < wallStopUntilRef.current

    ctx.beginPath()
    ctx.arc(bx, ballScreenY, BALL_RADIUS, 0, Math.PI * 2)
    ctx.fillStyle = isStopped ? '#EF4444' : '#06B6D4'
    ctx.shadowColor = isStopped ? '#EF4444' : '#06B6D4'
    ctx.shadowBlur = isStopped ? 20 : 15
    ctx.fill()
    ctx.shadowBlur = 0

    // Ball inner glow
    ctx.beginPath()
    ctx.arc(bx, ballScreenY, BALL_RADIUS * 0.5, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(255,255,255,0.6)'
    ctx.fill()
  }

  // ── Finish game ──
  async function finishGame(elapsed) {
    const myTime = Math.round(elapsed) // ms

    let won = null, oppScore = null, payout = 0

    if (isDevDuel) {
      const botResult = generateBotResult(myTime)
      oppScore = botResult.time
      won = myTime <= botResult.time
      payout = won ? calcPayout(duel.stake, user?.is_pro) : 0
    }

    if (!isDevDuel && won !== null) {
      updateLocalStats({ won, stake: duel.stake, userId: user.id })
    }

    setLastResult({
      won, myScore: myTime, oppScore: oppScore ?? 0,
      total: 1, payout: payout || 0, stake: duel?.stake || 0,
      duelId, tiebreak: false,
      timeDiff: Math.abs(myTime - (oppScore || 0)),
      gameType: 'race',
    })
    navigate('/result')
  }

  function generateBotResult(myTime) {
    const shouldWin = botShouldWinRef.current
    let time
    if (shouldWin) {
      time = Math.max(5000, myTime - 500 - Math.floor(Math.random() * 1500))
    } else {
      time = myTime + 500 + Math.floor(Math.random() * 2000)
    }
    return { time }
  }

  // ── Render ──
  return (
    <div
      className={`race-page ${wallHit ? 'race-wall-flash' : ''}`}
      onMouseMove={phase === 'racing' ? e => handlePointerMove(e.clientX) : undefined}
      onTouchMove={phase === 'racing' ? e => { e.preventDefault(); handlePointerMove(e.touches[0].clientX) } : undefined}
      onTouchStart={phase === 'racing' ? e => handlePointerMove(e.touches[0].clientX) : undefined}
    >
      {/* Canvas — always in DOM */}
      <div className="race-canvas-wrap">
        <canvas ref={canvasRef} className="race-canvas" />
      </div>

      {/* Countdown overlay */}
      {phase === 'countdown' && (
        <div className="race-countdown-overlay">
          <span className="race-countdown-num" key={countdown}>{countdown}</span>
        </div>
      )}

      {/* Racing UI */}
      {phase === 'racing' && (
        <>
          <div className="race-progress-bar">
            <div className="race-progress-fill" style={{ width: `${progress * 100}%` }} />
          </div>
          <div className="race-timer">
            {(Math.round((performance.now() - startTimeRef.current) / 10) / 100).toFixed(2)}s
          </div>
        </>
      )}

      {/* Finish overlay */}
      {(phase === 'done' || finished) && (
        <div className="race-finish-overlay">
          <span className="race-finish-text">{t.raceFinish || 'Finish!'}</span>
          <span className="race-finish-time">{(finishTime / 1000).toFixed(2)}s</span>
        </div>
      )}
    </div>
  )
}
