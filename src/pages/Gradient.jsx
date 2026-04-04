import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import useGameStore from '../store/useGameStore'
import { haptic } from '../lib/telegram'
import { translations } from '../lib/i18n'
import { supabase, getGradientDuel, submitGradientResult, calcPayout, heartbeatDuel, forfeitDuel, claimForfeit } from '../lib/supabase'
import { updateLocalStats } from '../lib/gameUtils'
import sound from '../lib/sounds'
import './Gradient.css'

const BOT_USER_ID = '00000000-0000-0000-0000-000000000001'
const TOTAL_ROUNDS = 5
const SHOW_TIME = 2
const GUESS_TIME = 15

function randomColor() {
  return {
    r: Math.floor(Math.random() * 256),
    g: Math.floor(Math.random() * 256),
    b: Math.floor(Math.random() * 256),
  }
}

function startingColor(target) {
  const offset = (v) => {
    const dir = Math.random() < 0.5 ? 1 : -1
    return Math.max(0, Math.min(255, v + dir * (80 + Math.floor(Math.random() * 100))))
  }
  return { r: offset(target.r), g: offset(target.g), b: offset(target.b) }
}

function colorDist(a, b) {
  return Math.round(Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2))
}

function rgbStr(c) { return `rgb(${c.r}, ${c.g}, ${c.b})` }

export default function Gradient() {
  const { duelId } = useParams()
  const navigate = useNavigate()
  const lang = useGameStore(s => s.lang)
  const user = useGameStore(s => s.user)
  const setLastResult = useGameStore(s => s.setLastResult)
  const setActiveDuel = useGameStore(s => s.setActiveDuel)
  const t = translations[lang] || translations.ru

  const isDevDuel = duelId?.startsWith('dev-')

  const [duel, setDuel] = useState(null)
  const [loading, setLoading] = useState(!duelId?.startsWith('dev-'))
  const isBotGameRef = useRef(false)
  const botShouldWinRef = useRef(false)

  const [phase, setPhase] = useState('countdown')
  const [countdown, setCountdown] = useState(3)
  const [roundIndex, setRoundIndex] = useState(0)
  const [showCountdown, setShowCountdown] = useState(SHOW_TIME)
  const [guessCountdown, setGuessCountdown] = useState(GUESS_TIME)
  const [target, setTarget] = useState({ r: 128, g: 128, b: 128 })
  const [color, setColor] = useState({ r: 128, g: 128, b: 128 })
  const [results, setResults] = useState([])
  const [finished, setFinished] = useState(false)
  const [waitingOpponent, setWaitingOpponent] = useState(false)

  const roundIndexRef = useRef(0)
  const resultsRef = useRef([])
  const finishedRef = useRef(false)
  const heartbeatRef = useRef(null)
  const forfeitedRef = useRef(false)

  // ── Cleanup ──
  useEffect(() => {
    return () => {
      finishedRef.current = false
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

  // ── Load duel ──
  useEffect(() => {
    finishedRef.current = false
    if (isDevDuel) {
      const parts = duelId.replace('dev-', '').split('-')
      const stake = parseInt(parts[parts.length - 1]) || 100
      const mockDuel = {
        id: duelId, creator_id: 'dev', opponent_id: BOT_USER_ID,
        stake, status: 'active', is_bot_game: true,
        bot_should_win: Math.random() < 0.5, game_type: 'gradient',
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
      duelData = await getGradientDuel(duelId)
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
    if (countdown <= 0) { startRound(); return }
    const timer = setTimeout(() => setCountdown(c => c - 1), 1000)
    return () => clearTimeout(timer)
  }, [loading, phase, countdown])

  // ── Start round ──
  function startRound() {
    const tgt = randomColor()
    const start = startingColor(tgt)
    setTarget(tgt)
    setColor(start)
    setShowCountdown(SHOW_TIME)
    setGuessCountdown(GUESS_TIME)
    setPhase('show')
  }

  // ── Show countdown ──
  useEffect(() => {
    if (phase !== 'show') return
    if (showCountdown <= 0) { setPhase('guess'); return }
    const timer = setTimeout(() => setShowCountdown(c => c - 1), 1000)
    return () => clearTimeout(timer)
  }, [phase, showCountdown])

  // ── Guess countdown ──
  useEffect(() => {
    if (phase !== 'guess') return
    if (guessCountdown <= 0) { confirmGuess(); return }
    const timer = setTimeout(() => setGuessCountdown(c => c - 1), 1000)
    return () => clearTimeout(timer)
  }, [phase, guessCountdown])

  // ── Slider change ──
  const setR = useCallback((v) => setColor(c => ({ ...c, r: v })), [])
  const setG = useCallback((v) => setColor(c => ({ ...c, g: v })), [])
  const setB = useCallback((v) => setColor(c => ({ ...c, b: v })), [])

  // ── Confirm ──
  function confirmGuess() {
    if (phase !== 'guess') return
    haptic('medium')
    sound.correct()

    const diff = colorDist(target, color)
    const roundResult = { target: { ...target }, guess: { ...color }, diff }
    const newResults = [...resultsRef.current, roundResult]
    resultsRef.current = newResults
    setResults(newResults)
    setPhase('result')
  }

  // ── After result → next or finish ──
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

  // ── Finish ──
  async function finishGame() {
    if (finishedRef.current) return
    finishedRef.current = true
    setFinished(true)
    setPhase('done')

    const myTotalDiff = resultsRef.current.reduce((s, r) => s + r.diff, 0)
    const myTime = myTotalDiff / 100 // arbitrary time value for DB

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

      let submitOk = await submitGradientResult(duelId, user.id, myTotalDiff, myTime)
      if (!submitOk) {
        await new Promise(r => setTimeout(r, 1000))
        submitOk = await submitGradientResult(duelId, user.id, myTotalDiff, myTime)
      }

      setWaitingOpponent(true)

      const botDelay = 1 + Math.random() * 3
      await new Promise(r => setTimeout(r, botDelay * 1000))
      let botSubmitOk = await submitGradientResult(duelId, BOT_USER_ID, botResult.totalDiff, botResult.totalDiff / 100)
      if (!botSubmitOk) {
        await new Promise(r => setTimeout(r, 1000))
        await submitGradientResult(duelId, BOT_USER_ID, botResult.totalDiff, botResult.totalDiff / 100)
      }

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
      let pvpSubmitOk = await submitGradientResult(duelId, user.id, myTotalDiff, myTime)
      if (!pvpSubmitOk) {
        await new Promise(r => setTimeout(r, 1000))
        await submitGradientResult(duelId, user.id, myTotalDiff, myTime)
      }

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

    if (!isDevDuel && won !== null) {
      updateLocalStats({ won, stake: duel.stake, userId: user.id })
    }

    setLastResult({
      won, myScore: myTotalDiff, oppScore: oppScore ?? 0,
      total: TOTAL_ROUNDS, payout: payout || 0, stake: duel?.stake || 0,
      duelId, tiebreak, timeDiff, gameType: 'gradient',
    })
    navigate('/result')
  }

  function generateBotResult(myTotalDiff) {
    const shouldWin = botShouldWinRef.current
    let totalDiff
    if (shouldWin) {
      totalDiff = Math.max(15, myTotalDiff - 20 - Math.floor(Math.random() * 50))
    } else {
      totalDiff = myTotalDiff + 20 + Math.floor(Math.random() * 60)
    }
    return { totalDiff }
  }

  // ── Render ──

  if (loading && !isDevDuel) {
    return <div className="grad-page"><span style={{ color: 'rgba(255,255,255,0.5)' }}>{t.gameLoading || 'Loading...'}</span></div>
  }

  if (phase === 'countdown') {
    return (
      <div className="grad-page">
        <div className="grad-countdown">
          <span className="grad-countdown-num" key={countdown}>{countdown}</span>
        </div>
      </div>
    )
  }

  if (phase === 'done') {
    return (
      <div className="grad-page">
        <div className="grad-done">
          <span className="grad-done-title">{t.gradResult || 'Result'}</span>
          <div className="grad-done-rounds">
            {results.map((r, i) => (
              <div key={i} className={`grad-done-round ${r.diff <= 30 ? 'great' : r.diff <= 80 ? 'ok' : 'bad'}`}>
                <span>{t.gradRound || 'Round'} {i + 1}</span>
                <div className="grad-done-colors">
                  <div className="grad-done-swatch" style={{ background: rgbStr(r.target) }} />
                  <span>→</span>
                  <div className="grad-done-swatch" style={{ background: rgbStr(r.guess) }} />
                </div>
                <span className="grad-done-diff">±{r.diff}</span>
              </div>
            ))}
          </div>
          <div className="grad-done-total">
            {t.gradTotalDiff || 'Total difference'}: <strong>{results.reduce((s, r) => s + r.diff, 0)}</strong>
          </div>

          {waitingOpponent && (
            <div className="grad-waiting">
              <div className="grad-waiting-dots"><span /><span /><span /></div>
              <span>{t.gameWaiting || 'Waiting for opponent...'}</span>
            </div>
          )}
        </div>
      </div>
    )
  }

  // Show phase — full screen target color
  if (phase === 'show') {
    return (
      <div className="grad-page grad-phase-show" style={{ background: rgbStr(target) }}>
        <div className="grad-round-label">{roundIndex + 1}/{TOTAL_ROUNDS}</div>
        <div className="grad-show-center">
          <span className="grad-show-countdown" key={showCountdown}>{showCountdown}</span>
          <span className="grad-show-text">{t.gradRemember || 'Remember!'}</span>
        </div>
      </div>
    )
  }

  // Result phase — split comparison
  if (phase === 'result') {
    const lastResult = results[results.length - 1]
    return (
      <div className="grad-page grad-phase-result">
        <div className="grad-round-label">{roundIndex + 1}/{TOTAL_ROUNDS}</div>
        <div className="grad-result-split">
          <div className="grad-result-half" style={{ background: rgbStr(target) }}>
            <span className="grad-result-label">{t.gradTarget || 'Target'}</span>
          </div>
          <div className="grad-result-half" style={{ background: rgbStr(color) }}>
            <span className="grad-result-label">{t.gradYours || 'Your color'}</span>
          </div>
        </div>
        <div className={`grad-result-diff ${lastResult?.diff <= 30 ? 'great' : lastResult?.diff <= 80 ? 'ok' : 'bad'}`}>
          ±{lastResult?.diff}
        </div>
      </div>
    )
  }

  // Guess phase — sliders on colored background
  return (
    <div className="grad-page grad-phase-guess" style={{ background: rgbStr(color) }}>
      <div className="grad-round-label">{roundIndex + 1}/{TOTAL_ROUNDS}</div>
      <div className={`grad-guess-timer ${guessCountdown <= 5 ? 'urgent' : ''}`}>{guessCountdown}s</div>

      <div className="grad-sliders">
        <SliderChannel label="R" value={color.r} onChange={setR} channelColor="#ef4444" />
        <SliderChannel label="G" value={color.g} onChange={setG} channelColor="#22c55e" />
        <SliderChannel label="B" value={color.b} onChange={setB} channelColor="#3b82f6" />
      </div>

      <div className="grad-rgb-display">
        <span style={{ color: '#ef4444' }}>{color.r}</span>
        <span style={{ color: '#22c55e' }}>{color.g}</span>
        <span style={{ color: '#3b82f6' }}>{color.b}</span>
      </div>

      <button className="grad-confirm-btn" onClick={confirmGuess}>
        <span>→</span>
      </button>
    </div>
  )
}

// ── Vertical slider component ──
function SliderChannel({ label, value, onChange, channelColor }) {
  const trackRef = useRef(null)
  const dragging = useRef(false)

  const updateValue = useCallback((clientY) => {
    const track = trackRef.current
    if (!track) return
    const rect = track.getBoundingClientRect()
    const pct = 1 - Math.max(0, Math.min(1, (clientY - rect.top) / rect.height))
    onChange(Math.round(pct * 255))
  }, [onChange])

  const onStart = useCallback((clientY) => { dragging.current = true; updateValue(clientY) }, [updateValue])
  const onMove = useCallback((clientY) => { if (dragging.current) updateValue(clientY) }, [updateValue])
  const onEnd = useCallback(() => { dragging.current = false }, [])

  return (
    <div className="grad-slider">
      <span className="grad-slider-label">{label}</span>
      <div
        className="grad-slider-track"
        ref={trackRef}
        onTouchStart={e => { e.preventDefault(); onStart(e.touches[0].clientY) }}
        onTouchMove={e => { e.preventDefault(); onMove(e.touches[0].clientY) }}
        onTouchEnd={onEnd}
        onMouseDown={e => onStart(e.clientY)}
        onMouseMove={e => onMove(e.clientY)}
        onMouseUp={onEnd}
        onMouseLeave={onEnd}
      >
        <div className="grad-slider-fill" style={{
          height: `${(value / 255) * 100}%`,
          background: channelColor,
          boxShadow: `0 0 12px ${channelColor}`,
        }} />
        <div className="grad-slider-thumb" style={{
          bottom: `${(value / 255) * 100}%`,
          borderColor: channelColor,
        }} />
      </div>
      <span className="grad-slider-val">{value}</span>
    </div>
  )
}
