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
  const { lastResult } = useGameStore(
    useShallow((state) => ({ lastResult: state.lastResult }))
  )
  const lang = useGameStore((state) => state.lang)
  const currency = useGameStore((state) => state.currency)
  const rates = useGameStore((state) => state.rates)
  const resetGame = useGameStore((state) => state.resetGame)
  const clearDuel = useGameStore((state) => state.clearDuel)
  const tr = translations[lang] || translations.ru
  const soundPlayedRef = useRef(false)
  const won = lastResult?.won
  const myScore = lastResult?.myScore ?? 0
  const oppScore = lastResult?.oppScore
  const total = lastResult?.total ?? 0
  const payout = lastResult?.payout ?? 0
  const stake = lastResult?.stake ?? 0
  const tiebreak = lastResult?.tiebreak
  const timeDiff = lastResult?.timeDiff ?? 0
  const gameType = lastResult?.gameType
  const isBJ = gameType === 'blackjack'
  const isSeq = gameType === 'sequence'
  const isReact = gameType === 'reaction'
  const isHear = gameType === 'hearing'
  const isGrad = gameType === 'gradient'
  const isRace = gameType === 'race'
  const isCap = gameType === 'capitals'
  const isCircle = gameType === 'circle'
  const isWin = won === true

  useEffect(() => {
    if (!lastResult || soundPlayedRef.current || gameType === 'blackjack') return
    soundPlayedRef.current = true
    if (isWin) {
      sound.victory()
      setTimeout(() => sound.coin(), 500)
    } else {
      sound.defeat()
    }
  }, [gameType, isWin, lastResult])

  if (!lastResult) {
    navigate('/')
    return null
  }

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

  function renderScore(value) {
    if (isCap) return `${value < 10 ? value.toFixed(1) : Math.round(value).toLocaleString('ru-RU')} ${tr.capKm || 'км'}`
    if (isRace) return `${(value / 1000).toFixed(2)} s`
    if (isGrad) return `${value} pts`
    if (isHear) return `${value} Hz`
    if (isReact) return `${value} ${tr.reactMs || 'мс'}`
    if (isCircle) return `${value}%`
    if (isBJ) return `${value} ${tr.resultPoints || 'очков'}`
    if (isSeq) return `${value}/${total} ${tr.resultRounds || 'раундов'}`
    return `${value}/${total}`
  }

  const tieTitle = isCircle
    ? (tr.circleTieTitle || 'Одинаковая оценка!')
    : (tr.resultTieTitle || 'Одинаковое количество правильных ответов!')
  const tieDetail = isWin
    ? (isCircle
      ? (tr.circleTieFaster || 'Ты справился быстрее на {s} сек').replace('{s}', timeDiff)
      : (tr.resultTieFaster || 'Вы были быстрее на {s} сек').replace('{s}', timeDiff))
    : (isCircle
      ? (tr.circleTieSlower || 'До победы не хватило {s} сек').replace('{s}', timeDiff)
      : (tr.resultTieSlower || 'Вам не хватило {s} сек до победы').replace('{s}', timeDiff))

  return (
    <div className={`result ${isWin ? 'result-win' : 'result-lose'}`}>
      <div className="result-icon">
        {isWin ? '🏆' : '💀'}
      </div>

      <h1 className="result-title">
        {isWin ? (tr.resultWin || 'Победа!') : (tr.resultLose || 'Поражение')}
      </h1>

      <div className={`result-amount ${isWin ? 'win' : 'lose'}`}>
        {isWin ? `+${formatCurrency(payout)}` : `-${formatCurrency(stake)}`}
      </div>

      {tiebreak && timeDiff > 0 && (
        <div className={`result-tiebreak ${isWin ? 'win' : 'lose'}`}>
          <span className="result-tiebreak-title">{tieTitle}</span>
          <span className="result-tiebreak-detail">{tieDetail}</span>
        </div>
      )}

      <div className="result-score-card">
        <div className="result-score-row">
          <span className="result-score-label">{tr.resultYou || 'Вы'}</span>
          <div className="result-score-dots" />
          <span className="result-score-val">{renderScore(myScore)}</span>
        </div>
        {oppScore !== null && oppScore !== undefined && (
          <div className="result-score-row">
            <span className="result-score-label">{tr.resultOpponent || 'Соперник'}</span>
            <div className="result-score-dots" />
            <span className="result-score-val">{renderScore(oppScore)}</span>
          </div>
        )}
      </div>

      <div className="result-actions">
        <button className="result-btn primary" onClick={handleHome}>
          {tr.resultHome || 'На главную'}
        </button>
      </div>
    </div>
  )
}
