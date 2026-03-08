import { useNavigate } from 'react-router-dom'
import useGameStore from '../store/useGameStore'
import { haptic } from '../lib/telegram'
import './Result.css'

export default function Result() {
  const navigate = useNavigate()
  const { lastResult, resetGame } = useGameStore()

  if (!lastResult) {
    navigate('/')
    return null
  }

  const { score, total } = lastResult
  const pct = Math.round((score / total) * 100)
  const isGood = pct >= 70

  function handleHome() {
    haptic('light')
    resetGame()
    navigate('/')
  }

  function handleRematch() {
    haptic('medium')
    resetGame()
    navigate('/duel')
  }

  return (
    <div className="result">
      <div className="result-icon">{isGood ? '🏆' : '💀'}</div>
      <h1 className="result-title">{isGood ? 'Отличный результат!' : 'Не повезло...'}</h1>

      <div className="score-circle">
        <span className="score-num">{score}</span>
        <span className="score-total">/ {total}</span>
      </div>

      <p className="score-pct">{pct}% правильных ответов</p>

      <p className="result-note">
        {isGood
          ? 'Ждём результата соперника — Stars начислятся автоматически'
          : 'Ждём результата соперника — итог появится в профиле'}
      </p>

      <div className="result-actions">
        <button className="btn-primary" onClick={handleRematch}>
          ⚔️ Ещё дуэль
        </button>
        <button className="btn-secondary" onClick={handleHome}>
          На главную
        </button>
      </div>
    </div>
  )
}
