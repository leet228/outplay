import useGameStore from '../store/useGameStore'
import { translations } from '../lib/i18n'
import './Shop.css'

export default function Shop() {
  const { lang } = useGameStore()
  const t = translations[lang]

  return (
    <div className="shop page">
      <div className="shop-coming">
        <div className="shop-coming-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none">
            <path d="M6 2L3 6V20C3 21.1 3.9 22 5 22H19C20.1 22 21 21.1 21 20V6L18 2H6Z"
              fill="var(--accent-dim)" stroke="var(--accent)" strokeWidth="1.5" strokeLinejoin="round"/>
            <path d="M3 6H21" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round"/>
            <path d="M16 10C16 12.209 14.209 14 12 14C9.791 14 8 12.209 8 10"
              stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </div>
        <h2 className="shop-coming-title">{t.shop}</h2>
        <p className="shop-coming-sub">{t.shopSoon}</p>
      </div>
    </div>
  )
}
