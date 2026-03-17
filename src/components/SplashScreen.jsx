import './SplashScreen.css'

export default function SplashScreen({ ready, onTap }) {
  return (
    <div
      className={`splash ${ready ? 'splash--ready' : ''}`}
      onClick={ready ? onTap : undefined}
      onTouchStart={ready ? onTap : undefined}
    >
      <span className="splash-logo">OUTPLAY</span>
      {!ready && <div className="splash-spinner" />}
      {ready && <span className="splash-tap">Нажмите чтобы начать</span>}
    </div>
  )
}
