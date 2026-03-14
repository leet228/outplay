import { useNavigate } from 'react-router-dom'
import useGameStore from '../store/useGameStore'
import { haptic } from '../lib/telegram'
import { translations } from '../lib/i18n'
import './Result.css'

export default function Result() {
  const navigate = useNavigate()
  const { lastResult, resetGame } = useGameStore()
  const lang = useGameStore((s) => s.lang)
  const currency = useGameStore((s) => s.currency)
  const rates = useGameStore((s) => s.rates)
  const tr = translations[lang] || translations.ru

  if (!lastResult) {
    navigate('/')
    return null
  }

  const { won, myScore, oppScore, total, payout, stake, tiebreak, timeDiff } = lastResult

  const isWin = won === true

  function formatCurrency(amount) {
    const rate = rates[currency?.code] || 1
    const converted = Math.round(amount * rate)
    return `${converted} ${currency?.symbol || '⭐'}`
  }

  function handleHome() {
    haptic('light')
    resetGame()
    navigate('/')
  }

  function handlePlayAgain() {
    haptic('medium')
    resetGame()
    navigate('/')
  }

  return (
    <div className={`result ${isWin ? 'result-win' : 'result-lose'}`}>
      {/* Icon */}
      <div className="result-icon">
        {isWin ? '🏆' : '💀'}
      </div>

      {/* Title */}
      <h1 className="result-title">
        {isWin ? (tr.resultWin || 'Победа!') : (tr.resultLose || 'Поражение')}
      </h1>

      {/* Amount */}
      <div className={`result-amount ${isWin ? 'win' : 'lose'}`}>
        {isWin ? `+${formatCurrency(payout)}` : `-${formatCurrency(stake)}`}
      </div>

      {/* Tiebreak info */}
      {tiebreak && timeDiff > 0 && (
        <div className={`result-tiebreak ${isWin ? 'win' : 'lose'}`}>
          <span className="result-tiebreak-title">
            Одинаковое количество правильных ответов!
          </span>
          <span className="result-tiebreak-detail">
            {isWin
              ? `Вы были быстрее на ${timeDiff} сек ⚡`
              : `Вам не хватило ${timeDiff} сек до победы ⏱️`
            }
          </span>
        </div>
      )}

      {/* Score */}
      <div className="result-score-card">
        <div className="result-score-row">
          <span className="result-score-label">Вы</span>
          <div className="result-score-dots" />
          <span className="result-score-val">{myScore}/{total}</span>
        </div>
        {oppScore !== null && oppScore !== undefined && (
          <div className="result-score-row">
            <span className="result-score-label">Соперник</span>
            <div className="result-score-dots" />
            <span className="result-score-val">{oppScore}/{total}</span>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="result-actions">
        <button className="result-btn primary" onClick={handlePlayAgain}>
          ⚔️ {tr.resultPlayAgain || 'Играть снова'}
        </button>
        <button className="result-btn secondary" onClick={handleHome}>
          {tr.resultHome || 'На главную'}
        </button>
      </div>
    </div>
  )
}
