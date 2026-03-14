import { useEffect, useState, useRef } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import useGameStore from '../store/useGameStore'
import { supabase, submitAnswer } from '../lib/supabase'
import { haptic } from '../lib/telegram'
import { translations } from '../lib/i18n'
import './Game.css'

const QUESTION_COUNT = 5
const TIME_PER_QUESTION = 15
const CIRCLE_R = 36
const CIRCLE_C = 2 * Math.PI * CIRCLE_R

export default function Game() {
  const { duelId } = useParams()
  const navigate = useNavigate()
  const {
    user, setLastResult, setActiveDuel, setBalance,
    setUser, dailyStats, setDailyStats, totalPnl, setTotalPnl,
    leaderboard, setLeaderboard,
    guild, setGuild, guildMembers, setGuildMembers, topGuilds, setTopGuilds,
    guildSeason, setGuildSeason,
  } = useGameStore()
  const lang = useGameStore((s) => s.lang)
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
  const pollRef = useRef(null)
  const submittingRef = useRef(false)
  const advancingRef = useRef(false)

  useEffect(() => {
    loadDuel()
    return () => cleanupAll()
  }, [duelId])

  // Timer countdown — keeps running even after confirm (both players see same timer)
  useEffect(() => {
    if (loading || finished) return
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
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
  }

  async function loadDuel() {
    const { data: duelData } = await supabase
      .from('duels').select('*').eq('id', duelId).single()

    if (!duelData) { navigate('/'); return }
    setDuel(duelData)
    setActiveDuel(duelData)

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

    await submitAnswer(duelId, user.id, qIndex, selected, isCorrect, timeSpent)

    setWaitingOpponent(true)
    startWaitingForOpponent(qIndex)
  }

  function handleTimeout() {
    if (submittingRef.current) return
    submittingRef.current = true
    setConfirmed(true)
    setSelected(null)
    haptic('light')

    setMyAnswers(prev => [...prev, { questionIndex: qIndex, isCorrect: false, timeSpent: TIME_PER_QUESTION }])

    submitAnswer(duelId, user.id, qIndex, null, false, TIME_PER_QUESTION).then(() => {
      setWaitingOpponent(true)
      startWaitingForOpponent(qIndex)
    })
  }

  function startWaitingForOpponent(qi) {
    // Cleanup previous listeners
    if (channelRef.current) { supabase.removeChannel(channelRef.current); channelRef.current = null }
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }

    // Check immediately
    checkBothAnswered(qi)

    // Realtime
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

    // Fallback poll
    pollRef.current = setInterval(() => checkBothAnswered(qi), 2000)
  }

  async function checkBothAnswered(qi) {
    const { count } = await supabase
      .from('duel_answers')
      .select('*', { count: 'exact', head: true })
      .eq('duel_id', duelId)
      .eq('question_index', qi)

    if (count >= 2) {
      onBothAnswered()
      return true
    }
    return false
  }

  function onBothAnswered() {
    // Guard: prevent double-fire from realtime + poll race condition
    if (advancingRef.current) return
    advancingRef.current = true

    // Cleanup listeners
    if (channelRef.current) { supabase.removeChannel(channelRef.current); channelRef.current = null }
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }

    setWaitingOpponent(false)
    setShowResult(true)

    const q = questions[qIndex]
    haptic(selected !== null && q?.correct_index === selected ? 'medium' : 'light')

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

    // Wait for finalize_duel to complete on server
    await new Promise(r => setTimeout(r, 500))

    let finalDuel = null
    for (let attempt = 0; attempt < 3; attempt++) {
      const { data } = await supabase
        .from('duels').select('*').eq('id', duelId).single()
      if (data?.status === 'finished') { finalDuel = data; break }
      await new Promise(r => setTimeout(r, 1500))
    }

    const isCreator = duel.creator_id === user.id
    const finalMyScore = myAnswers.filter(a => a.isCorrect).length
    let won = null
    let payout = 0
    let oppScore = null
    let tiebreak = false
    let timeDiff = 0

    if (finalDuel?.status === 'finished') {
      oppScore = isCreator ? finalDuel.opponent_score : finalDuel.creator_score
      const scoresEqual = finalDuel.creator_score === finalDuel.opponent_score

      if (finalDuel.winner_id === user.id) {
        won = true
        payout = Math.floor(duel.stake * 2 * 0.95)
      } else {
        won = false
        payout = 0
      }

      // Если одинаковый счёт — загружаем время для тайбрейка
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

    // Refresh balance
    const { data: userData } = await supabase
      .from('users').select('balance, wins, losses').eq('id', user.id).single()
    if (userData) {
      setBalance(userData.balance)
      // Update local user wins/losses
      setUser({ ...user, wins: userData.wins, losses: userData.losses })
    }

    // --- Local state updates ---
    // pnl must match DB: winner gets (payout - stake), loser gets (-stake)
    const pnlChange = won ? (payout - duel.stake) : -duel.stake

    // 1. Update dailyStats (profile chart)
    const today = new Date().toISOString().slice(0, 10)
    const updatedDailyStats = [...dailyStats]
    const todayIdx = updatedDailyStats.findIndex(d => d.date === today)
    if (todayIdx >= 0) {
      updatedDailyStats[todayIdx] = {
        ...updatedDailyStats[todayIdx],
        pnl: updatedDailyStats[todayIdx].pnl + pnlChange,
        games: (updatedDailyStats[todayIdx].games || 0) + 1,
        wins: (updatedDailyStats[todayIdx].wins || 0) + (won ? 1 : 0),
      }
    } else {
      updatedDailyStats.push({
        date: today,
        pnl: pnlChange,
        games: 1,
        wins: won ? 1 : 0,
      })
    }
    setDailyStats(updatedDailyStats)

    // 2. Update totalPnl
    setTotalPnl(totalPnl + pnlChange)

    // 3. Update leaderboard (find current user and update their PnL)
    if (leaderboard.length > 0) {
      const updatedLb = leaderboard.map(p =>
        p.id === user.id
          ? {
              ...p,
              total_pnl: (p.total_pnl || 0) + pnlChange,
              wins: won ? (p.wins || 0) + 1 : (p.wins || 0),
              losses: won ? (p.losses || 0) : (p.losses || 0) + 1,
            }
          : p
      ).sort((a, b) => (b.total_pnl || 0) - (a.total_pnl || 0))
      setLeaderboard(updatedLb)
    }

    // 4. Update guild PnL (if user is in a guild)
    if (guild) {
      setGuild({ ...guild, pnl: (guild.pnl || 0) + pnlChange })

      // Update current user's member PnL
      if (guildMembers.length > 0) {
        const updatedMembers = guildMembers.map(m =>
          m.user_id === user.id
            ? { ...m, pnl: (m.pnl || 0) + pnlChange }
            : m
        ).sort((a, b) => (b.pnl || 0) - (a.pnl || 0))
        setGuildMembers(updatedMembers)
      }

      // Update topGuilds list
      if (topGuilds.length > 0) {
        const updatedTopGuilds = topGuilds.map(g =>
          g.id === guild.id
            ? { ...g, pnl: (g.pnl || 0) + pnlChange }
            : g
        ).sort((a, b) => (b.pnl || 0) - (a.pnl || 0))
        setTopGuilds(updatedTopGuilds)
      }
    }

    // 5. Update guild season prize pool (0.5% of total pot goes to prize pool)
    if (guildSeason) {
      const guildFee = Math.floor(duel.stake * 2 * 0.005)
      setGuildSeason({ ...guildSeason, prize_pool: (guildSeason.prize_pool || 0) + guildFee })
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
