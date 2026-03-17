import { useEffect } from 'react'
import { unlockAudio } from '../lib/sounds'
import './SplashScreen.css'

export default function SplashScreen() {
  // Try to unlock audio ASAP — Telegram WebView may allow it without gesture
  useEffect(() => {
    unlockAudio()
  }, [])

  return (
    <div className="splash" onClick={unlockAudio} onTouchStart={unlockAudio}>
      <span className="splash-logo">OUTPLAY</span>
      <div className="splash-spinner" />
    </div>
  )
}
