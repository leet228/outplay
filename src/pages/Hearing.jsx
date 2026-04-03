import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import useGameStore from '../store/useGameStore'
import { haptic } from '../lib/telegram'
import { translations } from '../lib/i18n'
import { supabase, getHearingDuel, submitHearingResult, calcPayout, heartbeatDuel, forfeitDuel, claimForfeit } from '../lib/supabase'
import { updateLocalStats } from '../lib/gameUtils'
import sound from '../lib/sounds'
import './Hearing.css'

const BOT_USER_ID = '00000000-0000-0000-0000-000000000001'
const TOTAL_ROUNDS = 5
const LISTEN_TIME = 3 // seconds
const GUESS_TIME = 15 // seconds
const MIN_HZ = 100
const MAX_HZ = 1000
const HZ_SENSITIVITY = 2.5 // Hz per pixel dragged

function randomHz() {
  return Math.round(MIN_HZ + Math.random() * (MAX_HZ - MIN_HZ))
}

export default function Hearing() {
  const { duelId } = useParams()
  const navigate = useNavigate()
  const lang = useGameStore(s => s.lang)
  const user = useGameStore(s => s.user)
  const setLastResult = useGameStore(s => s.setLastResult)
  const setActiveDuel = useGameStore(s => s.setActiveDuel)
  const t = translations[lang] || translations.ru

  const isDevDuel = duelId?.startsWith('dev-')

  // Duel
  const [duel, setDuel] = useState(null)
  const [loading, setLoading] = useState(!duelId?.startsWith('dev-'))
  const isBotGameRef = useRef(false)
  const botShouldWinRef = useRef(false)

  // Game state
  const [phase, setPhase] = useState('countdown') // countdown | listen | guess | result | done
  const [countdown, setCountdown] = useState(3)
  const [roundIndex, setRoundIndex] = useState(0)
  const [listenCountdown, setListenCountdown] = useState(LISTEN_TIME)
  const [guessCountdown, setGuessCountdown] = useState(GUESS_TIME)
  const [targetHz, setTargetHz] = useState(0)
  const [currentHz, setCurrentHz] = useState(550)
  const [results, setResults] = useState([]) // [{target, guess, diff}]
  const [finished, setFinished] = useState(false)
  const [waitingOpponent, setWaitingOpponent] = useState(false)

  // Refs
  const roundIndexRef = useRef(0)
  const resultsRef = useRef([])
  const finishedRef = useRef(false)
  const heartbeatRef = useRef(null)
  const forfeitedRef = useRef(false)
  const audioCtxRef = useRef(null)
  const oscillatorRef = useRef(null)
  const gainRef = useRef(null)
  const filterRef = useRef(null)
  const dragStartY = useRef(null)
  const dragStartHz = useRef(550)
  const canvasRef = useRef(null)
  const animFrameRef = useRef(null)
  const currentHzRef = useRef(550)
  const phaseRef = useRef('countdown')

  useEffect(() => { phaseRef.current = phase }, [phase])
  useEffect(() => { currentHzRef.current = currentHz }, [currentHz])

  // ── Cleanup ──
  useEffect(() => {
    return () => {
      finishedRef.current = false
      stopAudio()
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current)
      if (heartbeatRef.current) clearInterval(heartbeatRef.current)
    }
  }, [])

  // ── Heartbeat ──
  useEffect(() => {
    if (isDevDuel || !duelId || !user?.id || user.id === 'dev' || finished) return
    heartbeatDuel(duelId, user.id)
    heartbeatRef.current = setInterval(() => heartbeatDuel(duelId, user.id), 10000)
    return () => { if (heartbeatRef.current) { clearInterval(heartbeatRef.current); heartbeatRef.current = null } }
  }, [duelId, user?.id, finished, isDevDuel])

  // ── Forfeit on background ──
  useEffect(() => {
    if (isDevDuel || !duelId || !user?.id || user.id === 'dev') return
    function handleVis() {
      if (document.visibilityState === 'hidden' && !finishedRef.current && !forfeitedRef.current) {
        forfeitedRef.current = true
        if (heartbeatRef.current) { clearInterval(heartbeatRef.current); heartbeatRef.current = null }
        forfeitDuel(duelId, user.id)
      }
    }
    document.addEventListener('visibilitychange', handleVis)
    return () => document.removeEventListener('visibilitychange', handleVis)
  }, [duelId, user?.id, isDevDuel])

  // ── Audio helpers ──
  function getAudioCtx() {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)()
    }
    if (audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume()
    }
    return audioCtxRef.current
  }

  function playTone(hz) {
    stopAudio()
    const ctx = getAudioCtx()

    // Low-pass filter for warmth — cuts harsh highs
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 2000
    filter.Q.value = 0.7

    const masterGain = ctx.createGain()
    masterGain.gain.value = 0.22
    filter.connect(masterGain)
    masterGain.connect(ctx.destination)

    // Main tone — sine for clean sound
    const osc1 = ctx.createOscillator()
    const gain1 = ctx.createGain()
    osc1.type = 'sine'
    osc1.frequency.value = hz
    gain1.gain.value = 0.8
    osc1.connect(gain1)
    gain1.connect(filter)
    osc1.start()

    // Soft fifth — adds musical warmth
    const osc2 = ctx.createOscillator()
    const gain2 = ctx.createGain()
    osc2.type = 'sine'
    osc2.frequency.value = hz * 1.5
    gain2.gain.value = 0.08
    osc2.connect(gain2)
    gain2.connect(filter)
    osc2.start()

    // Sub octave — subtle body
    const osc3 = ctx.createOscillator()
    const gain3 = ctx.createGain()
    osc3.type = 'sine'
    osc3.frequency.value = hz * 0.5
    gain3.gain.value = 0.12
    osc3.connect(gain3)
    gain3.connect(filter)
    osc3.start()

    oscillatorRef.current = [osc1, osc2, osc3]
    gainRef.current = masterGain
    filterRef.current = filter
  }

  function updateToneHz(hz) {
    if (oscillatorRef.current && Array.isArray(oscillatorRef.current)) {
      const t = audioCtxRef.current.currentTime
      oscillatorRef.current[0]?.frequency.setValueAtTime(hz, t)
      oscillatorRef.current[1]?.frequency.setValueAtTime(hz * 1.5, t)
      oscillatorRef.current[2]?.frequency.setValueAtTime(hz * 0.5, t)
    }
  }

  function stopAudio() {
    try {
      if (gainRef.current) {
        gainRef.current.gain.setValueAtTime(0, audioCtxRef.current?.currentTime || 0)
      }
      if (oscillatorRef.current && Array.isArray(oscillatorRef.current)) {
        oscillatorRef.current.forEach(osc => { try { osc.stop(); osc.disconnect() } catch {} })
      } else if (oscillatorRef.current) {
        oscillatorRef.current.stop()
        oscillatorRef.current.disconnect()
      }
    } catch {}
    oscillatorRef.current = null
    gainRef.current = null
  }

  // ── Wave animation ──
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    let time = 0

    function draw() {
      const w = canvas.width
      const h = canvas.height
      ctx.clearRect(0, 0, w, h)

      const hz = currentHzRef.current
      const waveFreq = 0.005 + (hz - MIN_HZ) / (MAX_HZ - MIN_HZ) * 0.025
      const amplitude = h * 0.08 + Math.sin(time * 0.02) * 5

      // Draw multiple wave layers
      const layers = [
        { color: 'rgba(0, 255, 200, 0.6)', offset: 0, ampMult: 1 },
        { color: 'rgba(139, 92, 246, 0.4)', offset: 0.5, ampMult: 0.7 },
        { color: 'rgba(236, 72, 153, 0.3)', offset: 1.0, ampMult: 0.5 },
      ]

      layers.forEach(layer => {
        ctx.beginPath()
        ctx.strokeStyle = layer.color
        ctx.lineWidth = 2.5
        ctx.shadowColor = layer.color
        ctx.shadowBlur = 15

        for (let y = 0; y < h; y++) {
          const wave = Math.sin(y * waveFreq + time * 0.03 + layer.offset) * amplitude * layer.ampMult
          const x = w / 2 + wave
          if (y === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.stroke()
        ctx.shadowBlur = 0
      })

      time++
      animFrameRef.current = requestAnimationFrame(draw)
    }

    // Set canvas size
    const rect = canvas.parentElement.getBoundingClientRect()
    canvas.width = rect.width * window.devicePixelRatio
    canvas.height = rect.height * window.devicePixelRatio
    canvas.style.width = rect.width + 'px'
    canvas.style.height = rect.height + 'px'
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio)
    canvas.width = rect.width
    canvas.height = rect.height

    draw()
    return () => { if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current) }
  }, [phase])

  // ── Load duel ──
  useEffect(() => {
    finishedRef.current = false
    if (isDevDuel) {
      const parts = duelId.replace('dev-', '').split('-')
      const stake = parseInt(parts[parts.length - 1]) || 100
      const mockDuel = {
        id: duelId, creator_id: 'dev', opponent_id: BOT_USER_ID,
        stake, status: 'active', is_bot_game: true,
        bot_should_win: Math.random() < 0.5, game_type: 'hearing',
      }
      setDuel(mockDuel)
      setActiveDuel(mockDuel)
      isBotGameRef.current = true
      botShouldWinRef.current = mockDuel.bot_should_win
    } else {
      loadDuel()
    }
  }, [duelId])

  async function loadDuel() {
    let duelData = null
    for (let attempt = 0; attempt < 3; attempt++) {
      duelData = await getHearingDuel(duelId)
      if (duelData) break
      await new Promise(r => setTimeout(r, 1000))
    }
    if (!duelData) { navigate('/'); return }
    setDuel(duelData)
    setActiveDuel(duelData)
    if (duelData.is_bot_game) {
      isBotGameRef.current = true
      botShouldWinRef.current = !!duelData.bot_should_win
    }
    setLoading(false)
  }

  // ── Countdown 3-2-1 ──
  useEffect(() => {
    if (loading || phase !== 'countdown') return
    if (countdown <= 0) {
      startRound()
      return
    }
    const timer = setTimeout(() => setCountdown(c => c - 1), 1000)
    return () => clearTimeout(timer)
  }, [loading, phase, countdown])

  // ── Start round ──
  function startRound() {
    const hz = randomHz()
    // Start guess Hz far from target (at least 200 Hz away)
    let startHz
    if (hz > 550) {
      startHz = MIN_HZ + Math.floor(Math.random() * Math.max(50, hz - 300))
    } else {
      startHz = hz + 200 + Math.floor(Math.random() * (MAX_HZ - hz - 200))
    }
    startHz = Math.max(MIN_HZ, Math.min(MAX_HZ, startHz))
    setTargetHz(hz)
    setCurrentHz(startHz)
    currentHzRef.current = startHz
    setListenCountdown(LISTEN_TIME)
    setGuessCountdown(GUESS_TIME)
    setPhase('listen')
    playTone(hz)
  }

  // ── Listen countdown ──
  useEffect(() => {
    if (phase !== 'listen') return
    if (listenCountdown <= 0) {
      stopAudio()
      setPhase('guess')
      playTone(currentHzRef.current) // start playing guess tone
      return
    }
    const timer = setTimeout(() => setListenCountdown(c => c - 1), 1000)
    return () => clearTimeout(timer)
  }, [phase, listenCountdown])

  // ── Guess countdown (15s) ──
  useEffect(() => {
    if (phase !== 'guess') return
    if (guessCountdown <= 0) {
      confirmGuess() // auto-confirm with current Hz
      return
    }
    const timer = setTimeout(() => setGuessCountdown(c => c - 1), 1000)
    return () => clearTimeout(timer)
  }, [phase, guessCountdown])

  // ── Touch/mouse drag for guess ──
  const handleDragStart = useCallback((clientY) => {
    if (phaseRef.current !== 'guess') return
    dragStartY.current = clientY
    dragStartHz.current = currentHzRef.current
  }, [])

  const handleDragMove = useCallback((clientY) => {
    if (phaseRef.current !== 'guess' || dragStartY.current === null) return
    const delta = dragStartY.current - clientY // up = positive = higher Hz
    const newHz = Math.round(Math.max(MIN_HZ, Math.min(MAX_HZ, dragStartHz.current + delta * HZ_SENSITIVITY)))
    setCurrentHz(newHz)
    currentHzRef.current = newHz
    updateToneHz(newHz)
  }, [])

  const handleDragEnd = useCallback(() => {
    dragStartY.current = null
  }, [])

  // Touch events
  const onTouchStart = useCallback((e) => handleDragStart(e.touches[0].clientY), [handleDragStart])
  const onTouchMove = useCallback((e) => { e.preventDefault(); handleDragMove(e.touches[0].clientY) }, [handleDragMove])
  const onTouchEnd = useCallback(() => handleDragEnd(), [handleDragEnd])

  // Mouse events (desktop)
  const onMouseDown = useCallback((e) => handleDragStart(e.clientY), [handleDragStart])
  const onMouseMove = useCallback((e) => { if (dragStartY.current !== null) handleDragMove(e.clientY) }, [handleDragMove])
  const onMouseUp = useCallback(() => handleDragEnd(), [handleDragEnd])

  // ── Confirm guess ──
  function confirmGuess() {
    if (phase !== 'guess') return
    stopAudio()
    haptic('medium')
    sound.correct()

    const guessRounded = Math.round(currentHz)
    const diff = Math.abs(targetHz - guessRounded)
    const roundResult = { target: targetHz, guess: guessRounded, diff }
    const newResults = [...resultsRef.current, roundResult]
    resultsRef.current = newResults
    setResults(newResults)
    setPhase('result')
  }

  // ── After result, next round or finish ──
  useEffect(() => {
    if (phase !== 'result') return
    const timer = setTimeout(() => {
      const next = roundIndexRef.current + 1
      if (next >= TOTAL_ROUNDS) {
        finishGame()
      } else {
        roundIndexRef.current = next
        setRoundIndex(next)
        startRound()
      }
    }, 2000)
    return () => clearTimeout(timer)
  }, [phase])

  // ── Finish game ──
  async function finishGame() {
    if (finishedRef.current) return
    finishedRef.current = true
    setFinished(true)
    setPhase('done')

    const myResults = resultsRef.current
    const myTotalDiff = myResults.reduce((sum, r) => sum + r.diff, 0)
    const myTime = myTotalDiff / 1000 // store as seconds for DB

    let won = null, oppScore = null, payout = 0, tiebreak = false, timeDiff = 0

    if (isDevDuel) {
      // ═══ DEV MODE ═══
      const botResult = generateBotResult(myTotalDiff)
      oppScore = botResult.totalDiff
      won = myTotalDiff <= botResult.totalDiff
      payout = won ? calcPayout(duel.stake, user?.is_pro) : 0
      timeDiff = Math.abs(myTotalDiff - botResult.totalDiff)

    } else if (isBotGameRef.current) {
      // ═══ BOT GAME ═══
      const botResult = generateBotResult(myTotalDiff)
      oppScore = botResult.totalDiff

      // Submit player result (retry once)
      let submitOk = await submitHearingResult(duelId, user.id, myTotalDiff, myTime)
      if (!submitOk) {
        await new Promise(r => setTimeout(r, 1000))
        submitOk = await submitHearingResult(duelId, user.id, myTotalDiff, myTime)
      }

      // Show waiting while bot "finishes"
      setWaitingOpponent(true)

      // Submit bot result with realistic delay
      const botDelay = 1 + Math.random() * 3
      await new Promise(r => setTimeout(r, botDelay * 1000))
      let botSubmitOk = await submitHearingResult(duelId, BOT_USER_ID, botResult.totalDiff, botResult.totalDiff / 1000)
      if (!botSubmitOk) {
        await new Promise(r => setTimeout(r, 1000))
        await submitHearingResult(duelId, BOT_USER_ID, botResult.totalDiff, botResult.totalDiff / 1000)
      }

      // Fetch final duel state
      await new Promise(r => setTimeout(r, 500))
      let finalDuel = null
      for (let attempt = 0; attempt < 5; attempt++) {
        const { data } = await supabase.from('duels').select('*').eq('id', duelId).single()
        if (data?.status === 'finished') { finalDuel = data; break }
        await new Promise(r => setTimeout(r, 1500))
      }

      setWaitingOpponent(false)

      if (finalDuel?.status === 'finished') {
        won = finalDuel.winner_id === user.id
        const isCreator = duel.creator_id === user.id
        oppScore = isCreator ? finalDuel.opponent_score : finalDuel.creator_score
        tiebreak = finalDuel.creator_score === finalDuel.opponent_score
        timeDiff = Math.abs(myTotalDiff - (oppScore || 0))
      } else {
        won = !botShouldWinRef.current
        timeDiff = Math.abs(myTotalDiff - botResult.totalDiff)
      }
      payout = won ? calcPayout(duel.stake, user?.is_pro) : 0

    } else {
      // ═══ PvP ═══
      setWaitingOpponent(true)
      let pvpSubmitOk = await submitHearingResult(duelId, user.id, myTotalDiff, myTime)
      if (!pvpSubmitOk) {
        await new Promise(r => setTimeout(r, 1000))
        await submitHearingResult(duelId, user.id, myTotalDiff, myTime)
      }

      // Poll for finished state + check opponent heartbeat
      let finalDuel = null
      for (let attempt = 0; attempt < 30; attempt++) {
        const { data } = await supabase.from('duels').select('*').eq('id', duelId).single()
        if (data?.status === 'finished') { finalDuel = data; break }
        if (attempt > 0 && attempt % 5 === 0 && !forfeitedRef.current) {
          const res = await claimForfeit(duelId, user.id)
          if (res?.status === 'forfeited') {
            finalDuel = { status: 'finished', winner_id: user.id, creator_id: duel.creator_id, opponent_id: duel.opponent_id, creator_score: myTotalDiff, opponent_score: null }
            break
          }
        }
        await new Promise(r => setTimeout(r, 2000))
      }

      setWaitingOpponent(false)

      const isCreator = duel.creator_id === user.id
      if (finalDuel?.status === 'finished') {
        oppScore = isCreator ? finalDuel.opponent_score : finalDuel.creator_score
        won = finalDuel.winner_id === user.id
        tiebreak = finalDuel.creator_score === finalDuel.opponent_score
        timeDiff = oppScore != null ? Math.abs(myTotalDiff - oppScore) : 0
      } else {
        won = null
        oppScore = null
      }
      payout = won ? calcPayout(duel.stake, user?.is_pro) : 0
    }

    // Local state updates
    if (!isDevDuel && won !== null) {
      updateLocalStats({ won, stake: duel.stake, userId: user.id })
    }

    setLastResult({
      won,
      myScore: myTotalDiff,
      oppScore: oppScore ?? 0,
      total: TOTAL_ROUNDS,
      payout: payout || 0,
      stake: duel?.stake || 0,
      duelId,
      tiebreak,
      timeDiff,
      gameType: 'hearing',
    })
    navigate('/result')
  }

  function generateBotResult(myTotalDiff) {
    const shouldWin = botShouldWinRef.current
    let totalDiff
    if (shouldWin) {
      totalDiff = Math.max(10, myTotalDiff - 20 - Math.floor(Math.random() * 40))
    } else {
      totalDiff = myTotalDiff + 20 + Math.floor(Math.random() * 60)
    }
    return { totalDiff }
  }

  // ── Render ──

  // Countdown
  // Loading
  if (loading && !isDevDuel) {
    return <div className="hear-page"><span style={{ color: 'rgba(255,255,255,0.5)' }}>{t.gameLoading || 'Loading...'}</span></div>
  }

  if (phase === 'countdown') {
    return (
      <div className="hear-page">
        <div className="hear-progress">
          {Array.from({ length: TOTAL_ROUNDS }, (_, i) => (
            <div key={i} className="hear-progress-dot" />
          ))}
        </div>
        <div className="hear-countdown">
          <span className="hear-countdown-num" key={countdown}>{countdown}</span>
        </div>
      </div>
    )
  }

  // Done summary
  if (phase === 'done') {
    return (
      <div className="hear-page">
        <div className="hear-done">
          <span className="hear-done-title">{t.hearResult || 'Result'}</span>
          <div className="hear-done-rounds">
            {results.map((r, i) => (
              <div key={i} className={`hear-done-round ${r.diff <= 20 ? 'great' : r.diff <= 50 ? 'ok' : 'bad'}`}>
                <span>{t.hearRound || 'Round'} {i + 1}</span>
                <span>{r.target} Hz → {r.guess} Hz</span>
                <span className="hear-done-diff">±{r.diff}</span>
              </div>
            ))}
          </div>
          <div className="hear-done-total">
            {t.hearTotalDiff || 'Total difference'}: <strong>{results.reduce((s, r) => s + r.diff, 0)} Hz</strong>
          </div>

          {waitingOpponent && (
            <div className="hear-waiting">
              <div className="hear-waiting-dots"><span /><span /><span /></div>
              <span>{t.gameWaiting || 'Waiting for opponent...'}</span>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div
      className={`hear-page hear-phase-${phase}`}
      onTouchStart={phase === 'guess' ? onTouchStart : undefined}
      onTouchMove={phase === 'guess' ? onTouchMove : undefined}
      onTouchEnd={phase === 'guess' ? onTouchEnd : undefined}
      onMouseDown={phase === 'guess' ? onMouseDown : undefined}
      onMouseMove={phase === 'guess' ? onMouseMove : undefined}
      onMouseUp={phase === 'guess' ? onMouseUp : undefined}
    >
      {/* Round counter */}
      <div className="hear-round-label">{roundIndex + 1}/{TOTAL_ROUNDS}</div>

      {/* Listen countdown */}
      {phase === 'listen' && (
        <div className="hear-listen-info">
          <span className="hear-listen-seconds">{listenCountdown}</span>
          <span className="hear-listen-text">{t.hearSecondsLeft || 'Seconds to remember'}</span>
        </div>
      )}

      {/* Guess timer + drag hint */}
      {phase === 'guess' && (
        <>
          <div className={`hear-guess-timer ${guessCountdown <= 5 ? 'urgent' : ''}`}>
            {guessCountdown}s
          </div>
          <div className="hear-guess-label">
            <div className="hear-drag-hint">↕</div>
          </div>
        </>
      )}

      {/* Wave canvas */}
      <div className="hear-wave-container">
        <canvas ref={canvasRef} className="hear-wave-canvas" />
      </div>

      {/* Hz display */}
      {phase === 'guess' && (
        <div className="hear-hz-display">
          <span className="hear-hz-value">{Math.round(currentHz)}</span>
          <span className="hear-hz-unit">Hz</span>
        </div>
      )}

      {/* Result overlay */}
      {phase === 'result' && (
        <div className="hear-result-overlay">
          <div className="hear-result-row">
            <span className="hear-result-label">{t.hearTarget || 'Target'}</span>
            <span className="hear-result-val">{targetHz} Hz</span>
          </div>
          <div className="hear-result-row">
            <span className="hear-result-label">{t.hearYour || 'Your answer'}</span>
            <span className="hear-result-val">{currentHz} Hz</span>
          </div>
          <div className={`hear-result-diff ${Math.abs(targetHz - currentHz) <= 20 ? 'great' : Math.abs(targetHz - currentHz) <= 50 ? 'ok' : 'bad'}`}>
            ±{Math.abs(targetHz - currentHz)} Hz
          </div>
        </div>
      )}

      {/* Confirm button */}
      {phase === 'guess' && (
        <button className="hear-confirm-btn" onClick={confirmGuess}>
          <span>→</span>
        </button>
      )}
    </div>
  )
}
