import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import useGameStore from '../store/useGameStore'
import { useShallow } from 'zustand/react/shallow'
import { haptic } from '../lib/telegram'
import { translations } from '../lib/i18n'
import sound from '../lib/sounds'
import './Result.css'

export default function Result() {
  const navigate = useNavigate()
  const { lastResult, user } = useGameStore(
    useShallow(s => ({ lastResult: s.lastResult, user: s.user }))
  )
  const lang = useGameStore(s => s.lang)
  const currency = useGameStore(s => s.currency)
  const rates = useGameStore(s => s.rates)
  const resetGame = useGameStore(s => s.resetGame)
  const clearDuel = useGameStore(s => s.clearDuel)
  const tr = translations[lang] || translations.ru

  if (!lastResult) {
    navigate('/')
    return null
  }

  const { won, myScore, oppScore, total, payout, stake, tiebreak, timeDiff, gameType } = lastResult
  const isBJ = gameType === 'blackjack'
  const isSeq = gameType === 'sequence'
  const isReact = gameType === 'reaction'
  const isHear = gameType === 'hearing'
  const isGrad = gameType === 'gradient'
  const isRace = gameType === 'race'

  const isWin = won === true

  // Play victory/defeat + coin sounds on mount (skip for blackjack — it plays its own)
  const soundPlayedRef = useRef(false)
  useEffect(() => {
    if (soundPlayedRef.current || gameType === 'blackjack') return
    soundPlayedRef.current = true
    if (isWin) {
      sound.victory()
      setTimeout(() => sound.coin(), 500)
    } else {
      sound.defeat()
    }
  }, [])

  function formatCurrency(amount) {
    const rate = rates[currency?.code] || 1
    const converted = Math.round(amount * rate)
    return `${converted} ${currency?.symbol || '⭐'}`
  }

  function handleHome() {
    haptic('light')
    resetGame()
    clearDuel()
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
            {tr.resultTieTitle || 'Одинаковое количество правильных ответов!'}
          </span>
          <span className="result-tiebreak-detail">
            {isWin
              ? (tr.resultTieFaster || 'Вы были быстрее на {s} сек ⚡').replace('{s}', timeDiff)
              : (tr.resultTieSlower || 'Вам не хватило {s} сек до победы ⏱️').replace('{s}', timeDiff)
            }
          </span>
        </div>
      )}

      {/* Score */}
      <div className="result-score-card">
        <div className="result-score-row">
          <span className="result-score-label">{tr.resultYou || 'Вы'}</span>
          <div className="result-score-dots" />
          <span className="result-score-val">{isRace ? `${(myScore / 1000).toFixed(2)} s` : isGrad ? `${myScore} pts` : isHear ? `${myScore} Hz` : isReact ? `${myScore} ${tr.reactMs || 'мс'}` : isBJ ? `${myScore} ${tr.resultPoints || 'очков'}` : isSeq ? `${myScore}/${total} ${tr.resultRounds || 'раундов'}` : `${myScore}/${total}`}</span>
        </div>
        {oppScore !== null && oppScore !== undefined && (
          <div className="result-score-row">
            <span className="result-score-label">{tr.resultOpponent || 'Соперник'}</span>
            <div className="result-score-dots" />
            <span className="result-score-val">{isRace ? `${(oppScore / 1000).toFixed(2)} s` : isGrad ? `${oppScore} pts` : isHear ? `${oppScore} Hz` : isReact ? `${oppScore} ${tr.reactMs || 'мс'}` : isBJ ? `${oppScore} ${tr.resultPoints || 'очков'}` : isSeq ? `${oppScore}/${total} ${tr.resultRounds || 'раундов'}` : `${oppScore}/${total}`}</span>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="result-actions">
        <button className="result-btn primary" onClick={handleHome}>
          {tr.resultHome || 'На главную'}
        </button>
      </div>
    </div>
  )
}
