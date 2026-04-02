import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import useGameStore from '../store/useGameStore'
import { haptic } from '../lib/telegram'
import { translations } from '../lib/i18n'
import { supabase, getReactionDuel, submitReactionResult, calcPayout, heartbeatDuel, forfeitDuel, claimForfeit } from '../lib/supabase'
import { updateLocalStats } from '../lib/gameUtils'
import sound from '../lib/sounds'
import './Reaction.css'

const BOT_USER_ID = '00000000-0000-0000-0000-000000000001'
const TOTAL_ROUNDS = 5
const FALSE_START_PENALTY = 500 // ms
const ROUND_TIMEOUT = 5000 // ms max per round
const MIN_DELAY = 1500 // ms before green
const MAX_DELAY = 4500 // ms before green

export default function Reaction() {
  const { duelId } = useParams()
  const navigate = useNavigate()
  const lang = useGameStore(s => s.lang)
  const user = useGameStore(s => s.user)
  const setLastResult = useGameStore(s => s.setLastResult)
  const setActiveDuel = useGameStore(s => s.setActiveDuel)
  const t = translations[lang] || translations.ru

  const isDevDuel = duelId?.startsWith('dev-')

  // Duel data
  const [duel, setDuel] = useState(null)
  const [loading, setLoading] = useState(!isDevDuel)
  const isBotGameRef = useRef(false)
  const botShouldWinRef = useRef(false)

  // Game state
  const [phase, setPhase] = useState('countdown') // countdown | waiting | ready | result | done
  const [countdown, setCountdown] = useState(3)
  const [roundIndex, setRoundIndex] = useState(0)
  const [times, setTimes] = useState([]) // reaction times per round (ms)
  const [finished, setFinished] = useState(false)
  const [waitingOpponent, setWaitingOpponent] = useState(false)
  const [currentTime, setCurrentTime] = useState(null) // ms for current round
  const [falseStart, setFalseStart] = useState(false)

  // Refs
  const timesRef = useRef([])
  const roundIndexRef = useRef(0)
  const finishedRef = useRef(false)
  const greenTimeRef = useRef(0) // timestamp when screen turned green
  const waitTimerRef = useRef(null)
  const roundTimeoutRef = useRef(null) // 5s max per round
  const heartbeatRef = useRef(null)
  const forfeitedRef = useRef(false)
  const phaseRef = useRef('countdown')

  // Keep phaseRef in sync
  useEffect(() => { phaseRef.current = phase }, [phase])

  // ── Cleanup ──
  useEffect(() => {
    return () => {
      finishedRef.current = false
      if (waitTimerRef.current) clearTimeout(waitTimerRef.current)
      if (roundTimeoutRef.current) clearTimeout(roundTimeoutRef.current)
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
        id: duelId,
        creator_id: 'dev',
        opponent_id: BOT_USER_ID,
        stake,
        status: 'active',
        is_bot_game: true,
        bot_should_win: Math.random() < 0.5,
        game_type: 'reaction',
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
      duelData = await getReactionDuel(duelId)
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

  // ── Start a round: enter waiting phase with random delay ──
  function startRound() {
    setFalseStart(false)
    setCurrentTime(null)
    setPhase('waiting')
    if (roundTimeoutRef.current) clearTimeout(roundTimeoutRef.current)
    const delay = MIN_DELAY + Math.random() * (MAX_DELAY - MIN_DELAY)
    waitTimerRef.current = setTimeout(() => {
      greenTimeRef.current = performance.now()
      setPhase('ready')
      // Auto-expire after 5s if player doesn't tap
      roundTimeoutRef.current = setTimeout(() => {
        if (phaseRef.current !== 'ready') return
        setCurrentTime(ROUND_TIMEOUT)
        setPhase('result')
        haptic('error')
        sound.incorrect()
        const newTimes = [...timesRef.current, ROUND_TIMEOUT]
        timesRef.current = newTimes
        setTimes(newTimes)
      }, ROUND_TIMEOUT)
    }, delay)
  }

  // ── Handle screen tap ──
  const handleTap = useCallback(() => {
    const p = phaseRef.current
    if (p === 'waiting') {
      // False start
      if (waitTimerRef.current) clearTimeout(waitTimerRef.current)
      if (roundTimeoutRef.current) clearTimeout(roundTimeoutRef.current)
      setFalseStart(true)
      setCurrentTime(FALSE_START_PENALTY)
      setPhase('result')
      haptic('error')
      sound.incorrect()

      const newTimes = [...timesRef.current, FALSE_START_PENALTY]
      timesRef.current = newTimes
      setTimes(newTimes)
    } else if (p === 'ready') {
      // Valid tap
      if (roundTimeoutRef.current) clearTimeout(roundTimeoutRef.current)
      const reactionMs = Math.round(performance.now() - greenTimeRef.current)
      setCurrentTime(reactionMs)
      setPhase('result')
      haptic('medium')
      sound.correct()

      const newTimes = [...timesRef.current, reactionMs]
      timesRef.current = newTimes
      setTimes(newTimes)
    }
  }, [])

  // ── After result shown, advance to next round or finish ──
  useEffect(() => {
    if (phase !== 'result') return
    const timer = setTimeout(() => {
      const nextRound = roundIndexRef.current + 1
      if (nextRound >= TOTAL_ROUNDS) {
        finishGame()
      } else {
        roundIndexRef.current = nextRound
        setRoundIndex(nextRound)
        startRound()
      }
    }, 1500)
    return () => clearTimeout(timer)
  }, [phase])

  // ── Finish game ──
  async function finishGame() {
    if (finishedRef.current) return
    finishedRef.current = true
    setFinished(true)
    setPhase('done')

    const myTimes = timesRef.current
    const myAvg = Math.round(myTimes.reduce((a, b) => a + b, 0) / myTimes.length)
    const myTime = Math.round((myAvg / 1000) * 1000) / 1000 // seconds for DB, 3 decimal places
    const myScore = TOTAL_ROUNDS // all rounds always complete

    let won = null
    let oppScore = null
    let tiebreak = false
    let timeDiff = 0
    let payout = 0

    if (isDevDuel) {
      // ═══ DEV MODE ═══
      const botResult = generateBotResult(myAvg)
      oppScore = botResult.avg
      const botTime = botResult.avg / 1000

      if (myAvg < botResult.avg) {
        won = true
      } else if (myAvg > botResult.avg) {
        won = false
      } else {
        tiebreak = true
        won = Math.random() < 0.5
      }
      payout = won ? calcPayout(duel.stake, user?.is_pro) : 0
      timeDiff = Math.abs(myAvg - botResult.avg)

    } else if (isBotGameRef.current) {
      // ═══ BOT GAME ═══
      const botResult = generateBotResult(myAvg)
      oppScore = botResult.avg
      const botTime = Math.round((botResult.avg / 1000) * 1000) / 1000

      // Submit player result (retry once)
      let submitOk = await submitReactionResult(duelId, user.id, myScore, myTime)
      if (!submitOk) {
        await new Promise(r => setTimeout(r, 1000))
        submitOk = await submitReactionResult(duelId, user.id, myScore, myTime)
      }

      // Show waiting while bot "finishes"
      setWaitingOpponent(true)

      // Submit bot result with realistic delay
      const botDelay = Math.max(0.5, Math.min(4, (botResult.avg - myAvg) / 1000))
      await new Promise(r => setTimeout(r, Math.max(500, botDelay * 1000)))
      let botSubmitOk = await submitReactionResult(duelId, BOT_USER_ID, myScore, botTime)
      if (!botSubmitOk) {
        await new Promise(r => setTimeout(r, 1000))
        await submitReactionResult(duelId, BOT_USER_ID, myScore, botTime)
      }

      // Fetch final duel state
      await new Promise(r => setTimeout(r, 500))
      let finalDuel = null
      for (let attempt = 0; attempt < 5; attempt++) {
        const { data } = await supabase
          .from('duels').select('*').eq('id', duelId).single()
        if (data?.status === 'finished') { finalDuel = data; break }
        await new Promise(r => setTimeout(r, 1500))
      }

      setWaitingOpponent(false)

      if (finalDuel?.status === 'finished') {
        won = finalDuel.winner_id === user.id
        const isCreator = duel.creator_id === user.id
        const oppTime = isCreator ? finalDuel.opponent_time : finalDuel.creator_time
        oppScore = Math.round((oppTime || botTime) * 1000)
        tiebreak = false
        timeDiff = Math.abs(myAvg - oppScore)
      } else {
        // Fallback — determine locally
        won = !botShouldWinRef.current
        tiebreak = false
        timeDiff = Math.abs(myAvg - botResult.avg)
      }
      payout = won ? calcPayout(duel.stake, user?.is_pro) : 0

    } else {
      // ═══ PvP ═══
      setWaitingOpponent(true)
      let pvpSubmitOk = await submitReactionResult(duelId, user.id, myScore, myTime)
      if (!pvpSubmitOk) {
        await new Promise(r => setTimeout(r, 1000))
        await submitReactionResult(duelId, user.id, myScore, myTime)
      }

      // Poll for finished state + check opponent heartbeat
      let finalDuel = null
      for (let attempt = 0; attempt < 30; attempt++) {
        const { data } = await supabase
          .from('duels').select('*').eq('id', duelId).single()
        if (data?.status === 'finished') { finalDuel = data; break }
        // Every ~10s check opponent heartbeat
        if (attempt > 0 && attempt % 5 === 0 && !forfeitedRef.current) {
          const res = await claimForfeit(duelId, user.id)
          if (res?.status === 'forfeited') {
            finalDuel = {
              status: 'finished',
              winner_id: user.id,
              creator_id: duel.creator_id,
              opponent_id: duel.opponent_id,
              creator_time: myTime,
              opponent_time: null,
            }
            break
          }
        }
        await new Promise(r => setTimeout(r, 2000))
      }

      setWaitingOpponent(false)

      const isCreator = duel.creator_id === user.id
      if (finalDuel?.status === 'finished') {
        const oppTime = isCreator ? finalDuel.opponent_time : finalDuel.creator_time
        oppScore = oppTime ? Math.round(oppTime * 1000) : null
        won = finalDuel.winner_id === user.id
        tiebreak = false
        timeDiff = oppScore ? Math.abs(myAvg - oppScore) : 0
      } else {
        won = null
        oppScore = null
        tiebreak = false
        timeDiff = 0
      }
      payout = won ? calcPayout(duel.stake, user?.is_pro) : 0
    }

    // Local state updates
    if (!isDevDuel && won !== null) {
      updateLocalStats({ won, stake: duel.stake, userId: user.id })
    }

    setLastResult({
      won,
      myScore: myAvg,
      oppScore: oppScore ?? 0,
      total: TOTAL_ROUNDS,
      payout: payout || 0,
      stake: duel?.stake || 0,
      duelId,
      tiebreak,
      timeDiff,
      gameType: 'reaction',
    })
    navigate('/result')
  }

  // ── Bot result ──
  function generateBotResult(myAvg) {
    const shouldWin = botShouldWinRef.current
    let avg
    if (shouldWin) {
      // Bot wins: generate faster time (180-350ms range, adjusted)
      avg = Math.max(150, myAvg - 30 - Math.floor(Math.random() * 60))
    } else {
      // Bot loses: generate slower time
      avg = myAvg + 30 + Math.floor(Math.random() * 80)
    }
    return { avg }
  }

  // ── Avg so far ──
  const avgSoFar = times.length > 0
    ? Math.round(times.reduce((a, b) => a + b, 0) / times.length)
    : 0

  // ── Render ──
  if (loading && !isDevDuel) {
    return <div className="react-page"><div className="react-loading">{t.gameLoading || 'Loading...'}</div></div>
  }

  // Countdown
  if (phase === 'countdown') {
    return (
      <div className="react-page">
        <div className="react-progress">
          {Array.from({ length: TOTAL_ROUNDS }, (_, i) => (
            <div key={i} className="react-progress-dot" />
          ))}
        </div>
        <div className="react-countdown">
          <span className="react-countdown-num" key={countdown}>{countdown}</span>
        </div>
      </div>
    )
  }

  // Done — show summary + waiting for opponent
  if (phase === 'done') {
    return (
      <div className="react-page">
        <div className="react-done">
          <span className="react-done-title">{t.reactResult || 'Result'}</span>
          <div className="react-done-rounds">
            {times.map((ms, i) => (
              <div key={i} className={`react-done-round ${ms >= ROUND_TIMEOUT ? 'timeout' : ms === FALSE_START_PENALTY ? 'penalty' : 'ok'}`}>
                <span>{t.reactRound || 'Round'} {i + 1}</span>
                <span>{ms} {t.reactMs || 'ms'}</span>
              </div>
            ))}
          </div>
          <div className="react-done-avg">
            {t.reactAvg || 'Average'}: <strong>{avgSoFar} {t.reactMs || 'ms'}</strong>
          </div>

          {waitingOpponent && (
            <div className="react-waiting">
              <div className="react-waiting-dots">
                <span /><span /><span />
              </div>
              <span>{t.gameWaiting || 'Waiting for opponent...'}</span>
            </div>
          )}
        </div>
      </div>
    )
  }

  // Main game phases
  return (
    <div
      className={`react-page react-phase-${phase}`}
      onClick={phase === 'waiting' || phase === 'ready' ? handleTap : undefined}
    >
      {/* Progress dots */}
      <div className="react-progress">
        {Array.from({ length: TOTAL_ROUNDS }, (_, i) => (
          <div
            key={i}
            className={`react-progress-dot ${
              i < roundIndex ? 'done' : i === roundIndex && phase !== 'countdown' ? 'active' : ''
            }`}
          />
        ))}
      </div>

      {/* Round indicator */}
      <div className="react-round-label">
        {t.reactRound || 'Round'} {roundIndex + 1}/{TOTAL_ROUNDS}
      </div>

      {/* Center zone */}
      <div className="react-center">
        {phase === 'waiting' && !falseStart && (
          <div className="react-zone react-zone-wait">
            <div className="react-zone-icon">🛑</div>
            <span className="react-zone-text">{t.reactWait || 'Wait...'}</span>
          </div>
        )}

        {phase === 'ready' && (
          <div className="react-zone react-zone-go">
            <div className="react-zone-icon">⚡</div>
            <span className="react-zone-text">{t.reactTap || 'Tap!'}</span>
          </div>
        )}

        {phase === 'result' && (
          <div className="react-zone react-zone-result">
            {falseStart ? (
              <>
                <div className="react-zone-icon react-shake">🚫</div>
                <span className="react-result-text react-result-penalty">{t.reactTooEarly || 'Too early! +500 ms'}</span>
              </>
            ) : currentTime >= ROUND_TIMEOUT ? (
              <>
                <div className="react-zone-icon react-shake">⏰</div>
                <span className="react-result-text react-result-penalty">{t.gameTimeout || 'Time\'s up!'} 5000 {t.reactMs || 'ms'}</span>
              </>
            ) : (
              <>
                <div className="react-zone-icon">✅</div>
                <span className="react-result-time">{currentTime}</span>
                <span className="react-result-ms">{t.reactMs || 'ms'}</span>
              </>
            )}
          </div>
        )}
      </div>

      {/* Average time */}
      {times.length > 0 && phase !== 'done' && (
        <div className="react-avg">
          <span className="react-avg-label">{t.reactAvg || 'Average'}</span>
          <span className="react-avg-value">{avgSoFar} {t.reactMs || 'ms'}</span>
        </div>
      )}
    </div>
  )
}
