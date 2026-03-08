import { useState, useEffect } from 'react'
import useGameStore from '../store/useGameStore'
import './Onboarding.css'

const LANGUAGES = [
  { code: 'en', label: 'English', flag: '🇬🇧' },
  { code: 'ru', label: 'Русский', flag: '🇷🇺' },
]

const CURRENCIES = [
  { symbol: '₽', code: 'RUB', label: 'Рубль · RUB' },
  { symbol: '$', code: 'USD', label: 'Dollar · USD' },
  { symbol: '€', code: 'EUR', label: 'Euro · EUR' },
]

// Currency step labels based on chosen language
const LABELS = {
  en: { currencyTitle: 'Choose your currency', continueBtn: 'Continue' },
  ru: { currencyTitle: 'Выберите валюту',       continueBtn: 'Продолжить' },
}

export default function Onboarding({ onComplete }) {
  const { setLang, setCurrency } = useGameStore()

  const [logoPhase, setLogoPhase] = useState('center') // center | header | finishing
  const [contentReady, setContentReady] = useState(false)
  const [step, setStep] = useState('lang') // lang | currency
  const [exiting, setExiting] = useState(false)
  const [finishing, setFinishing] = useState(false)

  const [selLang, setSelLang] = useState('en')
  const [selCurrency, setSelCurrency] = useState({ symbol: '₽', code: 'RUB' })

  // Logo entrance → shrink to header
  useEffect(() => {
    const t1 = setTimeout(() => setLogoPhase('header'), 900)
    const t2 = setTimeout(() => setContentReady(true), 1300)
    return () => { clearTimeout(t1); clearTimeout(t2) }
  }, [])

  function goNext() {
    setLang(selLang)
    setExiting(true)
    setTimeout(() => {
      setStep('currency')
      setExiting(false)
    }, 380)
  }

  function goContinue() {
    setCurrency(selCurrency)
    setExiting(true)
    setTimeout(() => {
      setLogoPhase('finishing')
      setFinishing(true)
      setTimeout(() => {
        localStorage.setItem('outplay_onboarded', '1')
        onComplete()
      }, 1800)
    }, 380)
  }

  const lbl = LABELS[selLang]

  return (
    <div className="onboarding">
      {/* Logo */}
      <div className={`ob-logo-wrap ob-logo-wrap--${logoPhase}`}>
        <span className="ob-logo">OUTPLAY</span>
      </div>

      {/* Content (lang / currency) */}
      {contentReady && !finishing && (
        <div className={`ob-content ${exiting ? 'ob-content--exit' : 'ob-content--enter'}`}>
          {step === 'lang' && (
            <>
              <h2 className="ob-title">Choose your language</h2>
              <div className="ob-options">
                {LANGUAGES.map(l => (
                  <button
                    key={l.code}
                    className={`ob-option ${selLang === l.code ? 'active' : ''}`}
                    onClick={() => setSelLang(l.code)}
                  >
                    <span className="ob-option-flag">{l.flag}</span>
                    <span className="ob-option-label">{l.label}</span>
                    {selLang === l.code && (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                        <path d="M20 6L9 17l-5-5" />
                      </svg>
                    )}
                  </button>
                ))}
              </div>
              <button className="ob-btn" onClick={goNext}>Next</button>
            </>
          )}

          {step === 'currency' && (
            <>
              <h2 className="ob-title">{lbl.currencyTitle}</h2>
              <div className="ob-options">
                {CURRENCIES.map(c => (
                  <button
                    key={c.code}
                    className={`ob-option ${selCurrency.code === c.code ? 'active' : ''}`}
                    onClick={() => setSelCurrency(c)}
                  >
                    <span className="ob-option-flag ob-option-symbol">{c.symbol}</span>
                    <span className="ob-option-label">{c.label}</span>
                    {selCurrency.code === c.code && (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                        <path d="M20 6L9 17l-5-5" />
                      </svg>
                    )}
                  </button>
                ))}
              </div>
              <button className="ob-btn" onClick={goContinue}>{lbl.continueBtn}</button>
            </>
          )}
        </div>
      )}

      {/* Finishing spinner */}
      {finishing && <div className="ob-spinner" />}
    </div>
  )
}
