import useGameStore from '../store/useGameStore'
import { translations } from '../lib/i18n'
import './Guilds.css'

export default function Guilds() {
  const { lang } = useGameStore()
  const t = translations[lang]

  return (
    <div className="guilds page">
      <div className="guilds-coming">
        <div className="guilds-coming-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none">
            <path d="M12 2L4 6V12C4 16.418 7.582 20 12 22C16.418 20 20 16.418 20 12V6L12 2Z"
              fill="var(--accent-dim)" stroke="var(--accent)" strokeWidth="1.5" strokeLinejoin="round"/>
            <path d="M9 12l2 2 4-4" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
        <h2 className="guilds-coming-title">{t.guilds}</h2>
        <p className="guilds-coming-sub">{t.guildsSoon}</p>
      </div>
    </div>
  )
}
