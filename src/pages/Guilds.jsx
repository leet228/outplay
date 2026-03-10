import { useState, useEffect } from 'react'
import useGameStore from '../store/useGameStore'
import { translations } from '../lib/i18n'
import './Guilds.css'

function getTimeLeft() {
  const now = new Date()
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1)
  const diff = end - now
  const days = Math.floor(diff / 86400000)
  const hours = Math.floor((diff % 86400000) / 3600000)
  const minutes = Math.floor((diff % 3600000) / 60000)
  return { days, hours, minutes }
}

const MOCK_PRIZE = 50000

export default function Guilds() {
  const { lang, currency } = useGameStore()
  const t = translations[lang]
  const [time, setTime] = useState(getTimeLeft)

  useEffect(() => {
    const id = setInterval(() => setTime(getTimeLeft()), 60000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="guilds page">

      {/* Season timer */}
      <div className="guilds-timer">
        <span className="guilds-timer-label">{t.guildsSeasonEnd}</span>
        <div className="guilds-timer-digits">
          <div className="guilds-timer-block">
            <span className="guilds-timer-num">{String(time.days).padStart(2, '0')}</span>
            <span className="guilds-timer-unit">{t.guildsDays}</span>
          </div>
          <span className="guilds-timer-sep">:</span>
          <div className="guilds-timer-block">
            <span className="guilds-timer-num">{String(time.hours).padStart(2, '0')}</span>
            <span className="guilds-timer-unit">{t.guildsHours}</span>
          </div>
          <span className="guilds-timer-sep">:</span>
          <div className="guilds-timer-block">
            <span className="guilds-timer-num">{String(time.minutes).padStart(2, '0')}</span>
            <span className="guilds-timer-unit">{t.guildsMinutes}</span>
          </div>
        </div>
      </div>

      {/* Prize pool */}
      <div className="guilds-prize">
        <div className="guilds-prize-glow" />
        <div className="guilds-prize-icon">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none">
            <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"
              fill="#F59E0B" stroke="#F59E0B" strokeWidth="1" strokeLinejoin="round"/>
          </svg>
        </div>
        <span className="guilds-prize-label">{t.guildsPrizePool}</span>
        <span className="guilds-prize-amount">
          {currency.symbol}{MOCK_PRIZE.toLocaleString('ru-RU')}
        </span>
      </div>

    </div>
  )
}
