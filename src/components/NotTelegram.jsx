import './NotTelegram.css'

export default function NotTelegram() {
  return (
    <div className="not-tg">
      <div className="not-tg-content">
        <div className="not-tg-emoji">🤖</div>
        <h1 className="not-tg-title">Упс, ты не в Telegram!</h1>
        <p className="not-tg-text">
          Outplay живёт только внутри Telegram.<br />
          Открой бота и нажми <strong>«Играть»</strong> — там всё самое интересное!
        </p>
        <a
          className="not-tg-btn"
          href="https://t.me/outplaymoneybot"
          target="_blank"
          rel="noopener noreferrer"
        >
          🚀 Открыть в Telegram
        </a>
        <p className="not-tg-hint">
          Если ты уже в Telegram и видишь это — попробуй перезапустить мини-приложение
        </p>
      </div>
    </div>
  )
}
