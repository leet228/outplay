import React, { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import useGameStore from '../store/useGameStore'
import { translations } from '../lib/i18n'
import { haptic } from '../lib/telegram'
import './StardewSpinsSlot.css'

// ─────────────────────────────────────────────────────────────
// STARDEW SPINS — placeholder page.
//
// Real slot is a 6×5 Pay-Anywhere tumble with a seasonal wheel
// modifier (Spring / Summer / Fall / Winter rotate every N spins
// and bias which symbol payouts get juiced). Building the engine
// in a follow-up — for now this stub owns the route + window
// geometry so the home-card click lands somewhere coherent.
// ─────────────────────────────────────────────────────────────

export default function StardewSpinsSlot() {
  const navigate = useNavigate()
  const lang = useGameStore(s => s.lang)
  const t = translations[lang]

  // Standard slot back-button wiring: Telegram BackButton +
  // browser back both go to /home.
  useEffect(() => {
    const tg = window.Telegram?.WebApp
    const back = () => {
      haptic('light')
      navigate('/home')
    }
    if (tg) {
      tg.BackButton.show()
      tg.BackButton.onClick(back)
    }
    return () => {
      if (tg) { tg.BackButton.offClick(back); tg.BackButton.hide() }
    }
  }, [navigate])

  return (
    <div className="stardew-slot-page">
      <div className="stardew-game-window">
        <span className="stardew-game-window-soon">{lang === 'ru' ? 'СКОРО' : 'SOON'}</span>
        <h2 className="stardew-game-window-title">{t.slotStardewTitle}</h2>
        <p className="stardew-game-window-sub">{t.slotStardewPreview}</p>
        <button className="stardew-game-window-back" onClick={() => { haptic('light'); navigate('/home') }}>
          ← {lang === 'ru' ? 'Назад' : 'Back'}
        </button>
      </div>
    </div>
  )
}
