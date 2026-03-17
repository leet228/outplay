import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import useGameStore from '../store/useGameStore'
import { haptic } from '../lib/telegram'
import { translations } from '../lib/i18n'
import { supabase, getSequenceDuel, submitSequenceResult } from '../lib/supabase'
import { updateLocalStats } from '../lib/gameUtils'
import sound from '../lib/sounds'
import './Sequence.css'

// ── Constants ──
const BOT_USER_ID = '00000000-0000-0000-0000-000000000001'

const SIMON_COLORS = [
  { id: 0, color: '#EF4444', label: 'Red' },
  { id: 1, color: '#3B82F6', label: 'Blue' },
  { id: 2, color: '#22C55E', label: 'Green' },
  { id: 3, color: '#EAB308', label: 'Yellow' },
]
const SIMON_LENGTH = 5
const CHIMP_COUNT = 6
const PATTERN_COUNT = 6
const GRID_SIZE = 16 // 4x4
const TIME_LIMIT = 15 // seconds per input phase
const CIRCLE_R = 36
const CIRCLE_C = 2 * Math.PI * CIRCLE_R

function shuffleArray(arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function generateSimonSequence(length) {
  return Array.from({ length }, () => Math.floor(Math.random() * 4))
}

function generateChimpPositions(count) {
  const positions = shuffleArray(Array.from({ length: GRID_SIZE }, (_, i) => i))
  return positions.slice(0, count)
}

function generatePattern(count) {
  const positions = shuffleArray(Array.from({ length: GRID_SIZE }, (_, i) => i))
  return new Set(positions.slice(0, count))
}

const ROUND_TYPES = ['simon', 'chimp', 'pattern']

export default function Sequence() {
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

  // Game state — phase drives everything via useEffect
  // countdown → roundIntro → watch → input → feedback → (repeat or done)
  const [phase, setPhase] = useState('countdown')
  const [countdown, setCountdown] = useState(3)
  const [roundIndex, setRoundIndex] = useState(0)
  const [roundTypes] = useState(() => shuffleArray(ROUND_TYPES))
  const [scores, setScores] = useState([])
  const [totalTime, setTotalTime] = useState(0)
  const [finished, setFinished] = useState(false)
  const [waitingOpponent, setWaitingOpponent] = useState(false)

  // Refs — survive closures, always current
  const scoresRef = useRef([])
  const totalTimeRef = useRef(0)
  const roundIndexRef = useRef(0)
  const finishedRef = useRef(false)

  // Round-specific state
  const [simonSequence, setSimonSequence] = useState([])
  const [simonPlayIndex, setSimonPlayIndex] = useState(-1)
  const [simonInputIndex, setSimonInputIndex] = useState(0)
  const [activeButton, setActiveButton] = useState(null)

  const [chimpPositions, setChimpPositions] = useState([])
  const [chimpVisible, setChimpVisible] = useState(true)
  const [chimpInputIndex, setChimpInputIndex] = useState(0)

  const [patternCells, setPatternCells] = useState(new Set())
  const [patternSelected, setPatternSelected] = useState(new Set())
  const [patternShowing, setPatternShowing] = useState(true)

  const [roundFailed, setRoundFailed] = useState(false)
  const [roundPassed, setRoundPassed] = useState(false)
  const [timeLeft, setTimeLeft] = useState(TIME_LIMIT)

  const roundStartTime = useRef(0)
  const inputLocked = useRef(false)

  // ── Load duel ──
  useEffect(() => {
    if (isDevDuel) {
      const parts = duelId.replace('dev-', '').split('-')
      const stake = parseInt(parts[1]) || 100
      const mockDuel = {
        id: duelId,
        creator_id: 'dev',
        opponent_id: BOT_USER_ID,
        stake,
        status: 'active',
        is_bot_game: true,
        bot_should_win: Math.random() < 0.5,
        game_type: 'sequence',
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
    const duelData = await getSequenceDuel(duelId)
    if (!duelData) { navigate('/'); return }
    setDuel(duelData)
    setActiveDuel(duelData)

    if (duelData.is_bot_game) {
      isBotGameRef.current = true
      botShouldWinRef.current = !!duelData.bot_should_win
    }

    setLoading(false)
  }

  // ── Game start sound ──
  useEffect(() => {
    if (!loading && duel) sound.gameStart()
  }, [loading])

  // ── Countdown ──
  useEffect(() => {
    if (loading || phase !== 'countdown') return
    if (countdown <= 0) {
      setPhase('roundIntro')
      return
    }
    const timer = setTimeout(() => setCountdown(c => c - 1), 1000)
    return () => clearTimeout(timer)
  }, [loading, phase, countdown])

  // ── Round intro → watch ──
  useEffect(() => {
    if (phase !== 'roundIntro') return
    console.log('[SEQ] roundIntro, roundIndex:', roundIndex)
    const timer = setTimeout(() => {
      initRound(roundTypes[roundIndex])
      setPhase('watch')
    }, 1500)
    return () => clearTimeout(timer)
  }, [phase, roundIndex])

  // ── Init round data ──
  const initRound = useCallback((type) => {
    console.log('[SEQ] initRound:', type)
    setRoundFailed(false)
    setRoundPassed(false)
    inputLocked.current = false

    if (type === 'simon') {
      const seq = generateSimonSequence(SIMON_LENGTH)
      setSimonSequence(seq)
      setSimonPlayIndex(-1)
      setSimonInputIndex(0)
      setActiveButton(null)
    } else if (type === 'chimp') {
      const positions = generateChimpPositions(CHIMP_COUNT)
      setChimpPositions(positions)
      setChimpVisible(true)
      setChimpInputIndex(0)
    } else if (type === 'pattern') {
      const cells = generatePattern(PATTERN_COUNT)
      setPatternCells(cells)
      setPatternSelected(new Set())
      setPatternShowing(true)
    }
  }, [])

  // ── Watch phase: Simon Says playback ──
  useEffect(() => {
    if (phase !== 'watch' || roundTypes[roundIndex] !== 'simon') return
    let i = 0
    let cancelled = false
    setSimonPlayIndex(-1)

    const timeouts = []

    const startDelay = setTimeout(() => {
      function playNext() {
        if (cancelled) return
        if (i >= simonSequence.length) {
          setSimonPlayIndex(-1)
          setActiveButton(null)
          const t = setTimeout(() => {
            if (cancelled) return
            roundStartTime.current = Date.now()
            setPhase('input')
          }, 400)
          timeouts.push(t)
          return
        }
        setSimonPlayIndex(i)
        setActiveButton(simonSequence[i])
        haptic('light')

        const t1 = setTimeout(() => {
          if (cancelled) return
          setActiveButton(null)
          i++
          const t2 = setTimeout(playNext, 200)
          timeouts.push(t2)
        }, 500)
        timeouts.push(t1)
      }
      playNext()
    }, 500)

    return () => {
      cancelled = true
      clearTimeout(startDelay)
      timeouts.forEach(t => clearTimeout(t))
    }
  }, [phase, roundIndex, simonSequence])

  // ── Watch phase: Chimp Test ──
  useEffect(() => {
    if (phase !== 'watch' || roundTypes[roundIndex] !== 'chimp') return
    setChimpVisible(true)

    const timer = setTimeout(() => {
      setChimpVisible(false)
      roundStartTime.current = Date.now()
      setPhase('input')
    }, 2500)

    return () => clearTimeout(timer)
  }, [phase, roundIndex])

  // ── Watch phase: Pattern Memory ──
  useEffect(() => {
    if (phase !== 'watch' || roundTypes[roundIndex] !== 'pattern') return
    setPatternShowing(true)

    const timer = setTimeout(() => {
      setPatternShowing(false)
      roundStartTime.current = Date.now()
      setPhase('input')
    }, 2500)

    return () => clearTimeout(timer)
  }, [phase, roundIndex])

  // ── Timer during input phase ──
  const timeLeftRef = useRef(TIME_LIMIT)

  useEffect(() => {
    if (phase !== 'input') {
      setTimeLeft(TIME_LIMIT)
      timeLeftRef.current = TIME_LIMIT
      return
    }
    if (inputLocked.current) return

    timeLeftRef.current = TIME_LIMIT
    setTimeLeft(TIME_LIMIT)

    const iv = setInterval(() => {
      timeLeftRef.current -= 1
      const next = timeLeftRef.current
      setTimeLeft(next)
      if (next === 5) sound.timerStart()
      if (next <= 0) {
        clearInterval(iv)
        sound.timerStop()
        endRound(false)
      }
    }, 1000)

    return () => { clearInterval(iv); sound.timerStop() }
  }, [phase, roundIndex])

  // ── End round + auto-transition ──
  const transitionDoneRef = useRef(false)

  function doTransition() {
    if (transitionDoneRef.current) return
    transitionDoneRef.current = true

    try {
      const currentRound = roundIndexRef.current
      console.log('[SEQ] transition. round:', currentRound, 'scores:', scoresRef.current)

      if (currentRound >= 2) {
        finishGame(scoresRef.current)
      } else {
        roundIndexRef.current = currentRound + 1
        setRoundIndex(currentRound + 1)
        setPhase('roundIntro')
      }
    } catch (err) {
      console.error('[SEQ] TRANSITION ERROR:', err)
      // Force next round on error
      roundIndexRef.current += 1
      setRoundIndex(roundIndexRef.current)
      setPhase('roundIntro')
    }
  }

  function endRound(passed) {
    if (inputLocked.current) return
    inputLocked.current = true
    console.log('[SEQ] endRound:', passed, 'round:', roundIndexRef.current)

    const elapsed = (Date.now() - roundStartTime.current) / 1000

    totalTimeRef.current += elapsed
    setTotalTime(totalTimeRef.current)

    scoresRef.current = [...scoresRef.current, passed]
    setScores(scoresRef.current)

    sound.timerStop()
    if (passed) {
      setRoundPassed(true)
      haptic('success')
      sound.correct()
    } else {
      setRoundFailed(true)
      haptic('error')
      sound.incorrect()
    }

    setPhase('feedback')
    transitionDoneRef.current = false

    // Primary: setTimeout
    window.setTimeout(doTransition, 1200)

    // Backup: requestAnimationFrame loop in case setTimeout is throttled
    const start = Date.now()
    function backupCheck() {
      if (transitionDoneRef.current) return
      if (Date.now() - start >= 1500) {
        console.warn('[SEQ] backup rAF triggered — setTimeout did not fire')
        doTransition()
        return
      }
      requestAnimationFrame(backupCheck)
    }
    requestAnimationFrame(backupCheck)
  }

  // ── Finish game — bot logic + backend submission ──
  async function finishGame(finalScores) {
    if (finishedRef.current) return
    finishedRef.current = true
    setFinished(true)
    setPhase('done')
    console.log('[SEQ] finishGame, scores:', finalScores)

    const myScore = finalScores.filter(Boolean).length
    const myTime = Math.round(totalTimeRef.current * 10) / 10

    let won, oppScore, payout, tiebreak, timeDiff

    if (isDevDuel) {
      // Dev mode — compute locally
      const botResult = generateBotResult(myScore, myTime)
      oppScore = botResult.score
      const botTime = botResult.time

      if (myScore > oppScore) {
        won = true
      } else if (oppScore > myScore) {
        won = false
      } else {
        tiebreak = true
        timeDiff = Math.round(Math.abs(myTime - botTime) * 10) / 10
        won = myTime <= botTime
      }
      payout = won ? Math.floor(duel.stake * 2 * 0.95) : 0
      tiebreak = tiebreak || false
      timeDiff = timeDiff || 0

    } else if (isBotGameRef.current) {
      // Bot game — generate bot result and submit both
      const botResult = generateBotResult(myScore, myTime)
      oppScore = botResult.score
      const botTime = botResult.time

      // Submit player result
      await submitSequenceResult(duelId, user.id, myScore, myTime)

      // Show waiting while bot "finishes"
      setWaitingOpponent(true)

      // Submit bot result (with realistic delay)
      const botDelay = Math.max(0.5, Math.min(4, botTime - myTime))
      await new Promise(r => setTimeout(r, Math.max(500, botDelay * 1000)))
      await submitSequenceResult(duelId, BOT_USER_ID, oppScore, botTime)

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
        oppScore = finalDuel.creator_id === user.id ? finalDuel.opponent_score : finalDuel.creator_score
        tiebreak = finalDuel.creator_score === finalDuel.opponent_score
        timeDiff = tiebreak ? Math.round(Math.abs(myTime - botTime) * 10) / 10 : 0
      } else {
        // Fallback — determine locally based on bot_should_win
        won = !botShouldWinRef.current
        tiebreak = false
        timeDiff = 0
      }
      payout = won ? Math.floor(duel.stake * 2 * 0.95) : 0

    } else {
      // PvP — submit own result, wait for opponent
      setWaitingOpponent(true)
      await submitSequenceResult(duelId, user.id, myScore, myTime)

      // Poll for finished state
      let finalDuel = null
      for (let attempt = 0; attempt < 30; attempt++) {
        const { data } = await supabase
          .from('duels').select('*').eq('id', duelId).single()
        if (data?.status === 'finished') { finalDuel = data; break }
        await new Promise(r => setTimeout(r, 2000))
      }

      setWaitingOpponent(false)

      const isCreator = duel.creator_id === user.id
      if (finalDuel?.status === 'finished') {
        oppScore = isCreator ? finalDuel.opponent_score : finalDuel.creator_score
        won = finalDuel.winner_id === user.id
        tiebreak = finalDuel.creator_score === finalDuel.opponent_score
        const oppTime = isCreator ? finalDuel.opponent_time : finalDuel.creator_time
        timeDiff = tiebreak ? Math.round(Math.abs(myTime - (oppTime || 0)) * 10) / 10 : 0
      } else {
        won = null
        oppScore = null
        tiebreak = false
        timeDiff = 0
      }
      payout = won ? Math.floor(duel.stake * 2 * 0.95) : 0
    }

    // Local state updates
    if (!isDevDuel && won !== null) {
      updateLocalStats({ won, stake: duel.stake, userId: user.id })
    }

    setLastResult({
      won,
      myScore,
      oppScore: oppScore ?? 0,
      total: 3,
      payout: payout || 0,
      stake: duel?.stake || 0,
      duelId,
      tiebreak: tiebreak || false,
      timeDiff: timeDiff || 0,
      gameType: 'sequence',
    })
    navigate('/result')
  }

  // ── Bot result generation ──
  function generateBotResult(myScore, myTime) {
    const shouldWin = botShouldWinRef.current
    let score, time

    if (shouldWin) {
      if (myScore < 3) {
        score = Math.min(3, myScore + 1)
        time = 10 + Math.random() * 20
      } else {
        score = 3
        time = Math.max(3, myTime - (0.5 + Math.random() * 2.5))
      }
    } else {
      if (myScore > 0) {
        score = Math.max(0, myScore - 1)
        time = 10 + Math.random() * 20
      } else {
        score = 0
        time = myTime + (1 + Math.random() * 2)
      }
    }

    time = Math.round(time * 10) / 10
    return { score, time }
  }

  // ── Input handlers ──
  function handleSimonTap(colorId) {
    if (phase !== 'input' || roundTypes[roundIndex] !== 'simon' || inputLocked.current) return
    haptic('light')
    setActiveButton(colorId)
    setTimeout(() => setActiveButton(null), 200)

    if (colorId !== simonSequence[simonInputIndex]) {
      endRound(false)
      return
    }

    const nextIndex = simonInputIndex + 1
    setSimonInputIndex(nextIndex)

    if (nextIndex >= simonSequence.length) {
      endRound(true)
    }
  }

  function handleChimpTap(cellIndex) {
    if (phase !== 'input' || roundTypes[roundIndex] !== 'chimp' || inputLocked.current) return
    haptic('light')

    const expectedPos = chimpPositions[chimpInputIndex]
    if (cellIndex !== expectedPos) {
      endRound(false)
      return
    }

    const nextIndex = chimpInputIndex + 1
    setChimpInputIndex(nextIndex)

    if (nextIndex >= chimpPositions.length) {
      endRound(true)
    }
  }

  function handlePatternTap(cellIndex) {
    if (phase !== 'input' || roundTypes[roundIndex] !== 'pattern' || inputLocked.current) return
    haptic('light')

    const newSelected = new Set(patternSelected)
    if (newSelected.has(cellIndex)) {
      newSelected.delete(cellIndex)
    } else {
      newSelected.add(cellIndex)
      if (!patternCells.has(cellIndex)) {
        setPatternSelected(newSelected)
        endRound(false)
        return
      }
    }
    setPatternSelected(newSelected)

    if (newSelected.size === patternCells.size) {
      let allCorrect = true
      for (const c of newSelected) {
        if (!patternCells.has(c)) { allCorrect = false; break }
      }
      if (allCorrect) endRound(true)
    }
  }

  // ── Round type labels ──
  const roundLabels = {
    simon: { ru: 'Цветовая последовательность', en: 'Color Sequence' },
    chimp: { ru: 'Числовая память', en: 'Number Memory' },
    pattern: { ru: 'Запомни паттерн', en: 'Pattern Memory' },
  }

  const roundIcons = {
    simon: '🎨',
    chimp: '🔢',
    pattern: '🧩',
  }

  const currentType = roundTypes[roundIndex] || 'simon'

  // ── Loading ──
  if (loading) {
    return (
      <div className="seq-page">
        <div className="seq-countdown">
          <div className="seq-countdown-num">
            <div className="game-loading-spinner" />
          </div>
        </div>
      </div>
    )
  }

  // ── Render ──
  return (
    <div className="seq-page">
      {/* Countdown */}
      {phase === 'countdown' && (
        <div className="seq-countdown">
          <div className="seq-countdown-num" key={countdown}>
            {countdown || (lang === 'ru' ? 'Начинаем!' : 'Go!')}
          </div>
        </div>
      )}

      {/* Round intro */}
      {phase === 'roundIntro' && (
        <div className="seq-round-intro">
          <span className="seq-round-number">{lang === 'ru' ? 'Раунд' : 'Round'} {roundIndex + 1}/3</span>
          <span className="seq-round-icon">{roundIcons[currentType]}</span>
          <span className="seq-round-name">{roundLabels[currentType][lang] || roundLabels[currentType].en}</span>
        </div>
      )}

      {/* Game area */}
      {(phase === 'watch' || phase === 'input' || phase === 'feedback') && (
        <div className="seq-game-area">
          {/* Progress bar */}
          <div className="seq-progress">
            {[0, 1, 2].map(i => (
              <div
                key={i}
                className={`seq-progress-dot ${i < roundIndex ? (scores[i] ? 'pass' : 'fail') : i === roundIndex ? 'active' : ''}`}
              />
            ))}
          </div>

          <div className="seq-round-header">
            <span className="seq-round-label">{lang === 'ru' ? 'Раунд' : 'Round'} {roundIndex + 1}/3</span>
            <span className="seq-round-type">{roundLabels[currentType][lang] || roundLabels[currentType].en}</span>
          </div>

          {/* Timer ring */}
          {phase === 'input' && !inputLocked.current && (
            <div className="seq-timer">
              <svg className="seq-timer-svg" viewBox="0 0 80 80">
                <circle cx="40" cy="40" r={CIRCLE_R} className="seq-timer-bg" />
                <circle
                  cx="40" cy="40" r={CIRCLE_R}
                  className="seq-timer-ring"
                  style={{
                    strokeDasharray: CIRCLE_C,
                    strokeDashoffset: CIRCLE_C * (1 - timeLeft / TIME_LIMIT),
                    stroke: timeLeft <= 5 ? '#ef4444' : timeLeft <= 10 ? '#f59e0b' : '#22c55e',
                  }}
                />
              </svg>
              <span className={`seq-timer-num ${timeLeft <= 5 ? 'danger' : ''}`}>{timeLeft}</span>
            </div>
          )}

          {phase === 'watch' && (
            <div className="seq-watch-hint">
              {lang === 'ru' ? 'Запоминай!' : 'Watch!'}
            </div>
          )}
          {phase === 'input' && !inputLocked.current && (
            <div className="seq-input-hint">
              {currentType === 'simon' && (lang === 'ru' ? 'Повтори последовательность' : 'Repeat the sequence')}
              {currentType === 'chimp' && (lang === 'ru' ? 'Нажми числа по порядку' : 'Tap numbers in order')}
              {currentType === 'pattern' && (lang === 'ru' ? `Выбери ${PATTERN_COUNT} ячеек` : `Select ${PATTERN_COUNT} cells`)}
            </div>
          )}

          {/* Feedback overlay */}
          {(roundPassed || roundFailed) && (
            <div className={`seq-feedback ${roundPassed ? 'pass' : 'fail'}`}>
              <span className="seq-feedback-icon">{roundPassed ? '✓' : '✗'}</span>
              <span className="seq-feedback-text">
                {roundPassed
                  ? (lang === 'ru' ? 'Отлично!' : 'Perfect!')
                  : (lang === 'ru' ? 'Ошибка!' : 'Wrong!')}
              </span>
            </div>
          )}

          {/* Simon Says */}
          {currentType === 'simon' && (
            <div className="seq-simon-grid">
              {SIMON_COLORS.map(c => (
                <button
                  key={c.id}
                  className={`seq-simon-btn ${activeButton === c.id ? 'lit' : ''}`}
                  style={{ '--btn-color': c.color }}
                  onClick={() => handleSimonTap(c.id)}
                  disabled={phase !== 'input' || inputLocked.current}
                />
              ))}
            </div>
          )}

          {/* Chimp Test */}
          {currentType === 'chimp' && (
            <div className="seq-grid">
              {Array.from({ length: GRID_SIZE }, (_, i) => {
                const numberIndex = chimpPositions.indexOf(i)
                const hasNumber = numberIndex !== -1
                const isRevealed = chimpVisible && hasNumber
                const isFound = hasNumber && numberIndex < chimpInputIndex

                return (
                  <button
                    key={i}
                    className={`seq-cell ${isRevealed ? 'numbered' : ''} ${isFound ? 'found' : ''} ${roundFailed && hasNumber && numberIndex === chimpInputIndex ? 'wrong-target' : ''}`}
                    onClick={() => handleChimpTap(i)}
                    disabled={phase !== 'input' || inputLocked.current || isFound}
                  >
                    {isRevealed && <span className="seq-cell-number">{numberIndex + 1}</span>}
                    {isFound && <span className="seq-cell-check">✓</span>}
                  </button>
                )
              })}
            </div>
          )}

          {/* Pattern Memory */}
          {currentType === 'pattern' && (
            <div className="seq-grid">
              {Array.from({ length: GRID_SIZE }, (_, i) => {
                const isTarget = patternCells.has(i)
                const isSelected = patternSelected.has(i)
                const showAsActive = patternShowing && isTarget

                return (
                  <button
                    key={i}
                    className={`seq-cell ${showAsActive ? 'pattern-active' : ''} ${isSelected ? (isTarget ? 'pattern-correct' : 'pattern-wrong') : ''}`}
                    onClick={() => handlePatternTap(i)}
                    disabled={phase !== 'input' || inputLocked.current}
                  />
                )
              })}
            </div>
          )}

          {/* Simon progress dots */}
          {currentType === 'simon' && phase === 'input' && !inputLocked.current && (
            <div className="seq-simon-progress">
              {simonSequence.map((_, i) => (
                <div key={i} className={`seq-simon-dot ${i < simonInputIndex ? 'done' : i === simonInputIndex ? 'current' : ''}`} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Done — waiting for opponent */}
      {phase === 'done' && (
        <div className="seq-done">
          {/* Score summary */}
          <div className="seq-done-scores">
            <span className="seq-done-title">{lang === 'ru' ? 'Ваш результат' : 'Your result'}</span>
            <div className="seq-done-rounds">
              {scores.map((passed, i) => (
                <div key={i} className={`seq-done-round ${passed ? 'pass' : 'fail'}`}>
                  <span>{lang === 'ru' ? 'Раунд' : 'Round'} {i + 1}</span>
                  <span>{passed ? '✓' : '✗'}</span>
                </div>
              ))}
            </div>
            <div className="seq-done-total">
              {scores.filter(Boolean).length}/3 {lang === 'ru' ? 'раундов' : 'rounds'}
            </div>
          </div>

          {waitingOpponent && (
            <div className="seq-waiting">
              <div className="game-waiting-dots">
                <span /><span /><span />
              </div>
              <span>{lang === 'ru' ? 'Ждём соперника...' : 'Waiting for opponent...'}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
