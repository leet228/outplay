import { useEffect, useRef } from 'react'
import { unlockAudio } from '../lib/sounds'
import './SplashScreen.css'

export default function SplashScreen() {
  const audioRef = useRef(null)

  useEffect(() => {
    // Silent audio autoplay trick to unlock AudioContext in WebView
    // A tiny silent play() call "warms up" the audio session
    try {
      const a = new Audio()
      a.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA='
      a.volume = 0.01
      audioRef.current = a
      a.play().then(() => {
        unlockAudio()
      }).catch(() => {})
    } catch {}
    unlockAudio()
  }, [])

  return (
    <div className="splash" onClick={unlockAudio} onTouchStart={unlockAudio}>
      <span className="splash-logo">OUTPLAY</span>
      <div className="splash-spinner" />
    </div>
  )
}
