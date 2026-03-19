import { useEffect, useState, useRef } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import useGameStore from '../store/useGameStore'
import { supabase, submitAnswer, BOT_USER_ID, calcPayout } from '../lib/supabase'
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
  const [waitingOpponent, setWaitingOpponent] = useState(false)
  const [showResult, setShowResult] = useState(false)
  const [slideClass, setSlideClass] = useState('')
  const [finished, setFinished] = useState(false)
  const [myAnswers, setMyAnswers] = useState([])

  const timerRef = useRef(null)
  const channelRef = useRef(null)
  const pollIntervalRef = useRef(null)
  const submittingRef = useRef(false)
  const advancingRef = useRef(false)
  const botAnswersRef = useRef([])       // трекинг ответов бота
  const botShouldWinRef = useRef(false)
  const isBotGameRef = useRef(false)

  const isDevDuel = duelId?.startsWith('dev-')

  useEffect(() => {
    if (isDevDuel) {
      loadDevDuel()
    } else {
      loadDuel()
    }
    return () => cleanupAll()
  }, [duelId])

  // Timer countdown — keeps running even after confirm (both players see same timer)
  useEffect(() => {
    if (loading || finished) return

    // Start timer tick sound at exactly 5 seconds
    if (timeLeft === 5 && !confirmed) sound.timerStart()
    // Stop timer sound if answered or time ran out
    if (timeLeft <= 0 || confirmed) sound.timerStop()

    if (timeLeft <= 0) {
      if (!submittingRef.current) {
        // Not yet answered — auto-submit timeout
        handleTimeout()
      }
      // If already submitted and timer ran out — do nothing,
      // onBothAnswered will handle advancing via realtime/poll
      return
    }
    timerRef.current = setTimeout(() => setTimeLeft(s => s - 1), 1000)
    return () => clearTimeout(timerRef.current)
  }, [timeLeft, loading, finished])

  function cleanupAll() {
    clearTimeout(timerRef.current)
    if (channelRef.current) { supabase.removeChannel(channelRef.current); channelRef.current = null }
    if (pollIntervalRef.current) { clearInterval(pollIntervalRef.current); pollIntervalRef.current = null }
  }

  function loadDevDuel() {
    // Parse dev-{gameType}-{stake}
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
      id: duelId,
      creator_id: 'dev',
      opponent_id: BOT_USER_ID,
      category: gameType,
      stake,
      status: 'active',
      question_ids: mockQuestions.map(q => q.id),
      is_bot_game: true,
      bot_should_win: Math.random() < 0.5,
      creator_score: null,
      opponent_score: null,
    }

    setDuel(mockDuel)
    setActiveDuel(mockDuel)
    isBotGameRef.current = true
    botShouldWinRef.current = mockDuel.bot_should_win
    botAnswersRef.current = []
    setQuestions(mockQuestions)
    setLoading(false)
  }

  async function loadDuel() {
    const { data: duelData } = await supabase
      .from('duels').select('*').eq('id', duelId).single()

    if (!duelData) { navigate('/'); return }
    setDuel(duelData)
    setActiveDuel(duelData)

    // Detect bot game
    if (duelData.is_bot_game) {
      isBotGameRef.current = true
      botShouldWinRef.current = !!duelData.bot_should_win
      botAnswersRef.current = []
    }

    let qs = []
    if (duelData.question_ids?.length > 0) {
      const { data } = await supabase
        .from('questions').select('*').in('id', duelData.question_ids)
      qs = data ?? []
      // Sort in question_ids order
      const order = duelData.question_ids
      qs.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
    }

    setQuestions(qs)
    setLoading(false)
  }

  // ── Bot logic ──
  function generateBotAnswer(qi, question, humanTimeSpent, humanIsCorrect) {
    const botShouldWin = botShouldWinRef.current
    const humanCorrect = myAnswers.filter(a => a.isCorrect).length + (humanIsCorrect ? 1 : 0)
    const botCorrect = botAnswersRef.current.filter(a => a.isCorrect).length
    const remaining = QUESTION_COUNT - qi - 1 // questions left after this one
    const isLast = remaining === 0

    let shouldBeCorrect
    if (isLast) {
      // Last question — guarantee outcome by SCORE (avoid tiebreaks)
      const botFinal = botCorrect + 1
      const botFinalWrong = botCorrect
      if (botShouldWin) {
        // Bot needs to win — prefer winning by score, not tiebreak
        if (botFinal > humanCorrect) {
          shouldBeCorrect = true // win by score
        } else if (botFinalWrong > humanCorrect) {
          shouldBeCorrect = false // already ahead, can afford wrong
        } else {
          // Best we can do is tie or behind — answer correctly
          shouldBeCorrect = true
        }
      } else {
        // Bot needs to lose — must have fewer correct
        shouldBeCorrect = botFinal < humanCorrect // only correct if still behind
      }
    } else {
      // Not last — probabilistic
      const diff = humanCorrect - botCorrect
      if (botShouldWin) {
        // Base ~75%, boost if falling behind
        const prob = Math.min(0.95, Math.max(0.2, 0.75 + diff * 0.12))
        shouldBeCorrect = Math.random() < prob
      } else {
        // Base ~35%, reduce if getting ahead
        const prob = Math.min(0.8, Math.max(0.05, 0.35 - diff * 0.1))
        shouldBeCorrect = Math.random() < prob
      }
    }

    // Pick answer index
    const answerIndex = shouldBeCorrect
      ? question.correct_index
      : [0, 1, 2, 3].filter(i => i !== question.correct_index)[Math.floor(Math.random() * 3)]

    // Time — realistic
    let timeSpent
    if (shouldBeCorrect) {
      timeSpent = 2 + Math.random() * 6 // 2-8s
    } else {
      timeSpent = 5 + Math.random() * 8 // 5-13s
    }
    // Tiebreak: if last q and scores will be equal
    if (isLast && (botCorrect + (shouldBeCorrect ? 1 : 0)) === humanCorrect) {
      if (botShouldWin) {
        timeSpent = Math.min(timeSpent, humanTimeSpent - 0.5) // faster
        timeSpent = Math.max(1, timeSpent)
      } else {
        timeSpent = Math.max(timeSpent, humanTimeSpent + 1) // slower
        timeSpent = Math.min(14.5, timeSpent)
      }
    }

    timeSpent = Math.round(timeSpent * 10) / 10

    const result = { questionIndex: qi, isCorrect: shouldBeCorrect, timeSpent, answerIndex }
    botAnswersRef.current.push(result)
    return result
  }

  async function submitBotAnswer(qi, question, humanTimeSpent, humanIsCorrect) {
    const ba = generateBotAnswer(qi, question, humanTimeSpent, humanIsCorrect)
    // Realistic delay: bot appears to "think"
    const delay = Math.max(0.5, Math.min(ba.timeSpent - humanTimeSpent, 4))
    await new Promise(r => setTimeout(r, delay * 1000))
    try {
      await submitAnswer(duelId, BOT_USER_ID, qi, ba.answerIndex, ba.isCorrect, ba.timeSpent)
    } catch (e) {
      console.error('Bot submitAnswer failed:', e)
    }
  }

  function handleSelect(index) {
    if (confirmed || showResult || finished) return
    haptic('light')
    setSelected(index)
  }

  async function handleConfirm() {
    if (selected === null || confirmed || submittingRef.current) return
    submittingRef.current = true
    setConfirmed(true)
    haptic('medium')

    const timeSpent = Math.round((TIME_PER_QUESTION - timeLeft) * 10) / 10
    const q = questions[qIndex]
    const isCorrect = selected === q.correct_index

    setMyAnswers(prev => [...prev, { questionIndex: qIndex, isCorrect, timeSpent }])

    if (!isDevDuel) {
      try {
        await submitAnswer(duelId, user.id, qIndex, selected, isCorrect, timeSpent)
      } catch (e) {
        console.error('submitAnswer failed:', e)
      }
    }

    if (isBotGameRef.current) {
      // Bot game: submit bot answer then advance directly — no polling needed
      setWaitingOpponent(true)
      if (!isDevDuel) {
        await submitBotAnswer(qIndex, q, timeSpent, isCorrect)
      } else {
        // Dev mode: just generate bot answer locally (no RPC)
        generateBotAnswer(qIndex, q, timeSpent, isCorrect)
        await new Promise(r => setTimeout(r, 500))
      }
      onBothAnswered()
    } else {
      setWaitingOpponent(true)
      startWaitingForOpponent(qIndex)
    }
  }

  function handleTimeout() {
    if (submittingRef.current) return
    submittingRef.current = true
    setConfirmed(true)
    setSelected(null)
    haptic('light')

    const q = questions[qIndex]
    setMyAnswers(prev => [...prev, { questionIndex: qIndex, isCorrect: false, timeSpent: TIME_PER_QUESTION }])

    const doSubmit = isDevDuel
      ? Promise.resolve()
      : submitAnswer(duelId, user.id, qIndex, null, false, TIME_PER_QUESTION)

    doSubmit.then(async () => {
      if (isBotGameRef.current && q) {
        setWaitingOpponent(true)
        if (!isDevDuel) {
          await submitBotAnswer(qIndex, q, TIME_PER_QUESTION, false)
        } else {
          generateBotAnswer(qIndex, q, TIME_PER_QUESTION, false)
          await new Promise(r => setTimeout(r, 500))
        }
        onBothAnswered()
      } else {
        setWaitingOpponent(true)
        startWaitingForOpponent(qIndex)
      }
    }).catch(e => {
      console.error('Timeout submitAnswer failed:', e)
      if (isBotGameRef.current) {
        onBothAnswered()
      } else {
        setWaitingOpponent(true)
        startWaitingForOpponent(qIndex)
      }
    })
  }

  function startWaitingForOpponent(qi) {
    // Cleanup previous listeners
    if (channelRef.current) { supabase.removeChannel(channelRef.current); channelRef.current = null }
    if (pollIntervalRef.current) { clearInterval(pollIntervalRef.current); pollIntervalRef.current = null }

    // Check immediately — opponent might have already answered
    checkBothAnswered(qi)

    // Realtime subscription
    const channel = supabase
      .channel(`duel-q-${duelId}-${qi}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'duel_answers',
        filter: `duel_id=eq.${duelId}`,
      }, (payload) => {
        if (payload.new?.question_index === qi && payload.new?.user_id !== user.id) {
          onBothAnswered()
        }
      })
      .subscribe()
    channelRef.current = channel

    // Periodic polling fallback every 2s — covers realtime failures
    pollIntervalRef.current = setInterval(() => {
      checkBothAnswered(qi)
    }, 2000)
  }

  async function checkBothAnswered(qi) {
    try {
      const { count } = await supabase
        .from('duel_answers')
        .select('*', { count: 'exact', head: true })
        .eq('duel_id', duelId)
        .eq('question_index', qi)

      if (count >= 2) {
        onBothAnswered()
        return true
      }

      // Also check if duel is already finished (opponent may have answered all questions)
      const { data: duelCheck } = await supabase
        .from('duels').select('status').eq('id', duelId).single()
      if (duelCheck?.status === 'finished') {
        onBothAnswered()
        return true
      }
    } catch (e) {
      console.error('checkBothAnswered error:', e)
    }
    return false
  }

  function onBothAnswered() {
    // Guard: prevent double-fire from realtime + poll race condition
    if (advancingRef.current) return
    advancingRef.current = true

    // Cleanup listeners + polling
    if (channelRef.current) { supabase.removeChannel(channelRef.current); channelRef.current = null }
    if (pollIntervalRef.current) { clearInterval(pollIntervalRef.current); pollIntervalRef.current = null }

    setWaitingOpponent(false)
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

  async function finishGame() {
    setFinished(true)
    cleanupAll()

    let finalMyScore, won, payout, oppScore, tiebreak, timeDiff

    if (isDevDuel) {
      // Dev mode — compute result locally
      finalMyScore = myAnswers.filter(a => a.isCorrect).length
      oppScore = botAnswersRef.current.filter(a => a.isCorrect).length
      tiebreak = false
      timeDiff = 0

      if (finalMyScore > oppScore) {
        won = true
      } else if (oppScore > finalMyScore) {
        won = false
      } else {
        // Tiebreak by time
        tiebreak = true
        const myTime = myAnswers.reduce((s, a) => s + a.timeSpent, 0)
        const botTime = botAnswersRef.current.reduce((s, a) => s + a.timeSpent, 0)
        timeDiff = Math.round(Math.abs(myTime - botTime) * 10) / 10
        won = myTime <= botTime
      }
      payout = won ? calcPayout(duel.stake, user?.is_pro) : 0
    } else {
      // Production — fetch from DB, wait for finalization
      await new Promise(r => setTimeout(r, 500))

      let finalDuel = null
      for (let attempt = 0; attempt < 8; attempt++) {
        const { data } = await supabase
          .from('duels').select('*').eq('id', duelId).single()
        if (data?.status === 'finished') { finalDuel = data; break }

        // On 4th attempt, try to manually trigger finalize_duel
        // (both scores should be set by submit_answer auto-finalize, but as fallback)
        if (attempt === 3 && data?.creator_score != null && data?.opponent_score != null) {
          try { await supabase.rpc('finalize_duel', { p_duel_id: duelId }) } catch (e) { console.error('Manual finalize error:', e) }
        }

        await new Promise(r => setTimeout(r, 1500))
      }

      const isCreator = duel.creator_id === user.id
      finalMyScore = finalDuel
        ? (isCreator ? finalDuel.creator_score : finalDuel.opponent_score)
        : myAnswers.filter(a => a.isCorrect).length
      won = null
      payout = 0
      oppScore = null
      tiebreak = false
      timeDiff = 0

      if (finalDuel?.status === 'finished') {
        oppScore = isCreator ? finalDuel.opponent_score : finalDuel.creator_score
        const scoresEqual = finalDuel.creator_score === finalDuel.opponent_score

        if (finalDuel.winner_id === user.id) {
          won = true
          payout = calcPayout(duel.stake, user?.is_pro)
        } else {
          won = false
          payout = 0
        }

        if (scoresEqual) {
          tiebreak = true
          const { data: allAnswers } = await supabase
            .from('duel_answers')
            .select('user_id, time_spent')
            .eq('duel_id', duelId)

          if (allAnswers) {
            const myTime = allAnswers
              .filter(a => a.user_id === user.id)
              .reduce((sum, a) => sum + a.time_spent, 0)
            const oppTime = allAnswers
              .filter(a => a.user_id !== user.id)
              .reduce((sum, a) => sum + a.time_spent, 0)
            timeDiff = Math.round(Math.abs(myTime - oppTime) * 10) / 10
          }
        }
      }

    }

    // Local state updates (balance, wins/losses, PnL, rank, guild — skip in dev mode)
    if (!isDevDuel && won !== null) {
      updateLocalStats({ won, stake: duel.stake, userId: user.id })
    }

    setLastResult({
      won,
      myScore: finalMyScore,
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

  const q = questions[qIndex]
  if (!q) return null

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

        {/* Waiting for opponent */}
        {waitingOpponent && (
          <div className="game-waiting">
            <div className="game-waiting-dots">
              <span /><span /><span />
            </div>
            <span>{tr.gameWaiting || 'Ждём ответа соперника...'}</span>
          </div>
        )}
      </div>
    </div>
  )
}
