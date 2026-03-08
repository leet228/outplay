import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import useGameStore from '../store/useGameStore'
import { supabase } from '../lib/supabase'
import { haptic } from '../lib/telegram'
import './Game.css'

const QUESTION_COUNT = 10
const TIME_PER_QUESTION = 15 // seconds

export default function Game() {
  const { duelId } = useParams()
  const navigate = useNavigate()
  const { user, questions, currentIndex, setQuestions, answerQuestion, setLastResult, setActiveDuel } = useGameStore()

  const [duel, setDuel] = useState(null)
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(null) // chosen answer index
  const [revealed, setRevealed] = useState(false)
  const [timeLeft, setTimeLeft] = useState(TIME_PER_QUESTION)
  const [finished, setFinished] = useState(false)

  useEffect(() => {
    loadDuelAndQuestions()
  }, [duelId])

  // Timer
  useEffect(() => {
    if (loading || finished || revealed) return
    if (timeLeft <= 0) {
      handleAnswer(null) // timeout = wrong
      return
    }
    const t = setTimeout(() => setTimeLeft((s) => s - 1), 1000)
    return () => clearTimeout(t)
  }, [timeLeft, loading, finished, revealed])

  async function loadDuelAndQuestions() {
    const { data: duelData } = await supabase
      .from('duels')
      .select('*')
      .eq('id', duelId)
      .single()

    if (!duelData) { navigate('/'); return }
    setDuel(duelData)
    setActiveDuel(duelData)

    const { data: qs } = await supabase
      .from('questions')
      .select('*')
      .eq('category', duelData.category)
      .limit(QUESTION_COUNT)
      .order('RANDOM()')

    setQuestions(qs ?? [])
    setLoading(false)
  }

  function handleAnswer(index) {
    if (revealed) return
    setSelected(index)
    setRevealed(true)
    const isCorrect = index !== null ? answerQuestion(index) : (() => { answerQuestion(-1); return false })()
    haptic(isCorrect ? 'medium' : 'light')

    setTimeout(() => {
      setRevealed(false)
      setSelected(null)
      setTimeLeft(TIME_PER_QUESTION)

      if (currentIndex + 1 >= questions.length) {
        submitResult()
      }
    }, 1000)
  }

  async function submitResult() {
    setFinished(true)
    const { answers } = useGameStore.getState()
    const score = answers.filter((a) => a.isCorrect).length

    // Save my score
    const field = duel.creator_id === user.id ? 'creator_score' : 'opponent_score'
    await supabase
      .from('duels')
      .update({ [field]: score })
      .eq('id', duelId)

    // Check if both submitted
    const { data: updated } = await supabase
      .from('duels')
      .select('*')
      .eq('id', duelId)
      .single()

    const bothDone =
      updated.creator_score !== null && updated.opponent_score !== null

    if (bothDone) {
      const iWon =
        duel.creator_id === user.id
          ? updated.creator_score > updated.opponent_score
          : updated.opponent_score > updated.creator_score

      await supabase
        .from('duels')
        .update({ status: 'finished', winner_id: iWon ? user.id : null })
        .eq('id', duelId)

      const delta = iWon ? duel.stake : -duel.stake
      await supabase.rpc('increment_balance', { user_id: user.id, amount: delta })
    }

    setLastResult({ score, total: questions.length, duelId })
    navigate('/result')
  }

  if (loading) return <div className="game-loading">Загружаем вопросы...</div>

  const q = questions[currentIndex]
  if (!q) return null

  const progress = currentIndex / questions.length

  return (
    <div className="game">
      <div className="game-header">
        <div className="progress-bar">
          <div className="progress-fill" style={{ width: `${progress * 100}%` }} />
        </div>
        <div className="game-meta">
          <span>{currentIndex + 1} / {questions.length}</span>
          <span className={`timer ${timeLeft <= 5 ? 'danger' : ''}`}>{timeLeft}с</span>
        </div>
      </div>

      <div className="question-card">
        <p className="question-text">{q.question}</p>
      </div>

      <div className="answers">
        {q.options.map((opt, i) => {
          let cls = 'answer-btn'
          if (revealed) {
            if (i === q.correct_index) cls += ' correct'
            else if (i === selected) cls += ' wrong'
          }
          return (
            <button
              key={i}
              className={cls}
              onClick={() => handleAnswer(i)}
              disabled={revealed}
            >
              <span className="answer-letter">{String.fromCharCode(65 + i)}</span>
              {opt}
            </button>
          )
        })}
      </div>
    </div>
  )
}
