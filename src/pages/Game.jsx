import { useEffect, useState, useRef } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import useGameStore from '../store/useGameStore'
import { supabase, submitQuizResult, BOT_USER_ID, calcPayout, heartbeatDuel, forfeitDuel, waitForFinishedDuelState } from '../lib/supabase'
import { haptic } from '../lib/telegram'
import { translations } from '../lib/i18n'
import { updateLocalStats } from '../lib/gameUtils'
import sound from '../lib/sounds'
import './Game.css'

const QUESTION_COUNT = 5
const TIME_PER_QUESTION = 15
const CIRCLE_R = 36
const CIRCLE_C = 2 * Math.PI * CIRCLE_R

export default function Game() {
  const { duelId } = useParams()
  const navigate = useNavigate()
  const user = useGameStore(s => s.user)
  const lang = useGameStore(s => s.lang)
  const setLastResult = useGameStore(s => s.setLastResult)
  const setActiveDuel = useGameStore(s => s.setActiveDuel)
  const tr = translations[lang] || translations.ru

  const [duel, setDuel] = useState(null)
  const [questions, setQuestions] = useState([])
  const [loading, setLoading] = useState(true)
  const [qIndex, setQIndex] = useState(0)
  const [selected, setSelected] = useState(null)
  const [confirmed, setConfirmed] = useState(false)
  const [timeLeft, setTimeLeft] = useState(TIME_PER_QUESTION)
  const [showResult, setShowResult] = useState(false)
  const [slideClass, setSlideClass] = useState('')
  const [finished, setFinished] = useState(false)
  const [waitingOpponent, setWaitingOpponent] = useState(false)

  const timerRef = useRef(null)
  const submittingRef = useRef(false)
  const advancingRef = useRef(false)
  const finishedRef = useRef(false)
  const heartbeatRef = useRef(null)
  const forfeitedRef = useRef(false)

  // Local score accumulation (no DB writes during game)
  const myAnswersRef = useRef([])   // [{questionIndex, isCorrect, timeSpent}]
  const botAnswersRef = useRef([])
  const botShouldWinRef = useRef(false)
  const isBotGameRef = useRef(false)

  const isDevDuel = duelId?.startsWith('dev-')

  useEffect(() => {
    finishedRef.current = false
    if (isDevDuel) {
      loadDevDuel()
    } else {
      loadDuel()
    }
    return () => cleanupAll()
  }, [duelId])

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

  // Timer countdown
  useEffect(() => {
    if (loading || finished || waitingOpponent) return

    if (timeLeft === 5 && !confirmed) sound.timerStart()
    if (timeLeft <= 0 || confirmed) sound.timerStop()

    if (timeLeft <= 0) {
      if (!submittingRef.current) handleTimeout()
      return
    }
    timerRef.current = setTimeout(() => setTimeLeft(s => s - 1), 1000)
    return () => clearTimeout(timerRef.current)
  }, [timeLeft, loading, finished, waitingOpponent])

  function cleanupAll() {
    clearTimeout(timerRef.current)
    submittingRef.current = false
    advancingRef.current = false
    sound.timerStop()
    if (heartbeatRef.current) { clearInterval(heartbeatRef.current); heartbeatRef.current = null }
  }

  function loadDevDuel() {
    const parts = duelId.split('-')
    const gameType = parts[1] || 'quiz'
    const stake = parseInt(parts[2]) || 100

    const mockQuestions = Array.from({ length: QUESTION_COUNT }, (_, i) => ({
      id: `dev-q-${i}`,
      category: gameType,
      question: `Dev вопрос #${i + 1} (${gameType})`,
      options: ['Вариант A', 'Вариант B', 'Вариант C', 'Вариант D'],
      correct_index: Math.floor(Math.random() * 4),
    }))

    const mockDuel = {
      id: duelId, creator_id: 'dev', opponent_id: BOT_USER_ID,
      category: gameType, stake, status: 'active',
      question_ids: mockQuestions.map(q => q.id),
      is_bot_game: true, bot_should_win: Math.random() < 0.5,
    }

    setDuel(mockDuel)
    setActiveDuel(mockDuel)
    isBotGameRef.current = true
    botShouldWinRef.current = mockDuel.bot_should_win
    botAnswersRef.current = []
    myAnswersRef.current = []
    setQuestions(mockQuestions)
    setLoading(false)
  }

  async function loadDuel() {
    let duelData = null
    for (let attempt = 0; attempt < 3; attempt++) {
      const { data } = await supabase.from('duels').select('*').eq('id', duelId).single()
      if (data) { duelData = data; break }
      await new Promise(r => setTimeout(r, 1000))
    }
    if (!duelData) { navigate('/'); return }
    setDuel(duelData)
    setActiveDuel(duelData)

    if (duelData.is_bot_game) {
      isBotGameRef.current = true
      botShouldWinRef.current = !!duelData.bot_should_win
      botAnswersRef.current = []
    }
    myAnswersRef.current = []

    let qs = []
    if (duelData.question_ids?.length > 0) {
      const { data } = await supabase.from('questions').select('*').in('id', duelData.question_ids)
      qs = data ?? []
      const order = duelData.question_ids
      qs.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
    }
    setQuestions(qs)
    setLoading(false)
  }

  // ── Bot logic (local only, no DB writes) ──
  function generateBotAnswer(qi, question, humanTimeSpent, humanIsCorrect) {
    const botShouldWin = botShouldWinRef.current
    const humanCorrect = myAnswersRef.current.filter(a => a.isCorrect).length + (humanIsCorrect ? 1 : 0)
    const botCorrect = botAnswersRef.current.filter(a => a.isCorrect).length
    const remaining = QUESTION_COUNT - qi - 1
    const isLast = remaining === 0

    let shouldBeCorrect
    if (isLast) {
      const botFinal = botCorrect + 1
      if (botShouldWin) {
        if (botFinal > humanCorrect) shouldBeCorrect = true
        else if (botCorrect > humanCorrect) shouldBeCorrect = false
        else shouldBeCorrect = true
      } else {
        shouldBeCorrect = botFinal < humanCorrect
      }
    } else {
      const diff = humanCorrect - botCorrect
      if (botShouldWin) {
        shouldBeCorrect = Math.random() < Math.min(0.95, Math.max(0.2, 0.75 + diff * 0.12))
      } else {
        shouldBeCorrect = Math.random() < Math.min(0.8, Math.max(0.05, 0.35 - diff * 0.1))
      }
    }

    let timeSpent = shouldBeCorrect ? 2 + Math.random() * 6 : 5 + Math.random() * 8
    if (isLast && (botCorrect + (shouldBeCorrect ? 1 : 0)) === humanCorrect) {
      if (botShouldWin) {
        timeSpent = Math.max(1, Math.min(timeSpent, humanTimeSpent - 0.5))
      } else {
        timeSpent = Math.min(14.5, Math.max(timeSpent, humanTimeSpent + 1))
      }
    }
    timeSpent = Math.round(timeSpent * 10) / 10

    const result = { questionIndex: qi, isCorrect: shouldBeCorrect, timeSpent }
    botAnswersRef.current.push(result)
    return result
  }

  function handleSelect(index) {
    if (confirmed || showResult || finished) return
    haptic('light')
    setSelected(index)
  }

  function handleConfirm() {
    if (selected === null || confirmed || submittingRef.current) return
    submittingRef.current = true
    setConfirmed(true)
    haptic('medium')

    const timeSpent = Math.round((TIME_PER_QUESTION - timeLeft) * 10) / 10
    const q = questions[qIndex]
    const isCorrect = selected === q.correct_index

    // Store locally — no DB call
    myAnswersRef.current.push({ questionIndex: qIndex, isCorrect, timeSpent })

    // Generate bot answer locally (if bot game)
    if (isBotGameRef.current) {
      generateBotAnswer(qIndex, q, timeSpent, isCorrect)
    }

    // Show answer feedback
    showAnswerFeedback()
  }

  function handleTimeout() {
    if (submittingRef.current) return
    submittingRef.current = true
    setConfirmed(true)
    setSelected(null)
    haptic('light')

    const q = questions[qIndex]
    myAnswersRef.current.push({ questionIndex: qIndex, isCorrect: false, timeSpent: TIME_PER_QUESTION })

    if (isBotGameRef.current && q) {
      generateBotAnswer(qIndex, q, TIME_PER_QUESTION, false)
    }

    showAnswerFeedback()
  }

  function showAnswerFeedback() {
    if (advancingRef.current) return
    advancingRef.current = true

    setShowResult(true)
    sound.timerStop()

    const q = questions[qIndex]
    const isCorrect = selected !== null && q?.correct_index === selected
    haptic(isCorrect ? 'medium' : 'light')
    if (isCorrect) sound.correct(); else sound.incorrect()

    setTimeout(() => {
      if (qIndex + 1 >= questions.length) {
        finishGame()
      } else {
        slideToNext()
      }
    }, 1200)
  }

  function slideToNext() {
    setSlideClass('slide-out')
    setTimeout(() => {
      setQIndex(prev => prev + 1)
      setSelected(null)
      setConfirmed(false)
      setShowResult(false)
      setTimeLeft(TIME_PER_QUESTION)
      submittingRef.current = false
      advancingRef.current = false
      setSlideClass('slide-in')
      setTimeout(() => setSlideClass(''), 400)
    }, 350)
  }

  // ── Finish game: submit once at end ──
  async function finishGame() {
    if (finishedRef.current) return
    finishedRef.current = true
    setFinished(true)
    cleanupAll()

    const myScore = myAnswersRef.current.filter(a => a.isCorrect).length
    const myTime = Math.round(myAnswersRef.current.reduce((s, a) => s + a.timeSpent, 0) * 10) / 10

    let won = null, oppScore = null, payout = 0, tiebreak = false, timeDiff = 0

    if (isDevDuel) {
      // ═══ DEV MODE ═══
      oppScore = botAnswersRef.current.filter(a => a.isCorrect).length
      if (myScore > oppScore) {
        won = true
      } else if (oppScore > myScore) {
        won = false
      } else {
        tiebreak = true
        const botTime = botAnswersRef.current.reduce((s, a) => s + a.timeSpent, 0)
        timeDiff = Math.round(Math.abs(myTime - botTime) * 10) / 10
        won = myTime <= botTime
      }
      payout = won ? calcPayout(duel.stake, user?.is_pro) : 0

    } else if (isBotGameRef.current) {
      // ═══ BOT GAME ═══
      oppScore = botAnswersRef.current.filter(a => a.isCorrect).length
      const botTime = Math.round(botAnswersRef.current.reduce((s, a) => s + a.timeSpent, 0) * 10) / 10

      // Submit player result (retry once)
      let submitOk = await submitQuizResult(duelId, user.id, myScore, myTime)
      if (!submitOk) {
        await new Promise(r => setTimeout(r, 1000))
        submitOk = await submitQuizResult(duelId, user.id, myScore, myTime)
      }

      // Show waiting while bot "finishes"
      setWaitingOpponent(true)

      // Submit bot result with realistic delay
      const botDelay = Math.max(0.5, Math.min(4, botTime - myTime))
      await new Promise(r => setTimeout(r, Math.max(500, botDelay * 1000)))
      let botSubmitOk = await submitQuizResult(duelId, BOT_USER_ID, oppScore, botTime)
      if (!botSubmitOk) {
        await new Promise(r => setTimeout(r, 1000))
        await submitQuizResult(duelId, BOT_USER_ID, oppScore, botTime)
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
        if (tiebreak) {
          const oppTime = isCreator ? finalDuel.opponent_time : finalDuel.creator_time
          timeDiff = Math.round(Math.abs(myTime - (oppTime || 0)) * 10) / 10
        }
      } else {
        won = !botShouldWinRef.current
        tiebreak = false
      }
      payout = won ? calcPayout(duel.stake, user?.is_pro) : 0

    } else {
      // ═══ PvP ═══
      setWaitingOpponent(true)
      let pvpSubmitOk = await submitQuizResult(duelId, user.id, myScore, myTime)
      if (!pvpSubmitOk) {
        await new Promise(r => setTimeout(r, 1000))
        await submitQuizResult(duelId, user.id, myScore, myTime)
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
        if (tiebreak) {
          const oppTime = isCreator ? finalDuel.opponent_time : finalDuel.creator_time
          timeDiff = Math.round(Math.abs(myTime - (oppTime || 0)) * 10) / 10
        }
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
      myScore,
      oppScore,
      total: questions.length,
      payout,
      stake: duel.stake,
      duelId,
      tiebreak,
      timeDiff,
    })
    navigate('/result')
  }

  // ─── Render ───

  if (loading) {
    return (
      <div className="game-loading">
        <div className="game-loading-spinner" />
        <span>{tr.gameLoading || 'Загружаем вопросы...'}</span>
      </div>
    )
  }

  // Waiting for opponent after all questions
  if (waitingOpponent && finished) {
    return (
      <div className="game">
        <div className="game-content">
          <div className="game-waiting">
            <div className="game-waiting-dots">
              <span /><span /><span />
            </div>
            <span>{tr.gameWaiting || 'Ждём ответа соперника...'}</span>
          </div>
        </div>
      </div>
    )
  }

  const qRaw = questions[qIndex]
  if (!qRaw) return null
  const q = {
    ...qRaw,
    question: (lang === 'en' && qRaw.question_en) ? qRaw.question_en : qRaw.question,
    options: (lang === 'en' && qRaw.options_en) ? qRaw.options_en : qRaw.options,
  }

  const timerFrac = timeLeft / TIME_PER_QUESTION
  const dashOffset = CIRCLE_C * (1 - timerFrac)
  const timerColor = timeLeft <= 5 ? '#ef4444' : timeLeft <= 10 ? '#f59e0b' : '#22c55e'

  return (
    <div className="game">
      <div className={`game-content ${slideClass}`}>
        {/* Circular Timer */}
        <div className="game-timer-wrap">
          <svg className="game-timer-svg" viewBox="0 0 80 80">
            <circle
              className="game-timer-bg"
              cx="40" cy="40" r={CIRCLE_R}
              fill="none" stroke="var(--surface)" strokeWidth="5"
            />
            <circle
              className="game-timer-ring"
              cx="40" cy="40" r={CIRCLE_R}
              fill="none" stroke={timerColor} strokeWidth="5"
              strokeLinecap="round"
              strokeDasharray={CIRCLE_C}
              strokeDashoffset={dashOffset}
              transform="rotate(-90 40 40)"
            />
          </svg>
          <span className="game-timer-text" style={{ color: timerColor }}>
            {timeLeft}
          </span>
        </div>

        {/* Progress */}
        <div className="game-progress">
          {tr.gameQuestion || 'Вопрос'} {qIndex + 1} {tr.gameOf || 'из'} {questions.length}
        </div>

        {/* Question Card */}
        <div className="game-question-card">
          <p className="game-question-text">{q.question}</p>
        </div>

        {/* Answer Options */}
        <div className="game-answers">
          {q.options.map((opt, i) => {
            let cls = 'game-answer'
            if (selected === i && !showResult) cls += ' selected'
            if (showResult) {
              if (i === q.correct_index) cls += ' correct'
              else if (i === selected && i !== q.correct_index) cls += ' wrong'
            }
            if (confirmed) cls += ' locked'
            return (
              <button
                key={i}
                className={cls}
                onClick={() => handleSelect(i)}
                disabled={confirmed}
              >
                <span className="game-answer-letter">{String.fromCharCode(65 + i)}</span>
                <span className="game-answer-text">{opt}</span>
              </button>
            )
          })}
        </div>

        {/* Submit Button */}
        {!confirmed && (
          <button
            className="game-submit-btn"
            disabled={selected === null}
            onClick={handleConfirm}
          >
            {tr.gameAnswer || 'Ответить'}
          </button>
        )}
      </div>
    </div>
  )
}
