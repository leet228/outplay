import React, { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useShallow } from 'zustand/react/shallow'
import useGameStore from '../store/useGameStore'
import { translations } from '../lib/i18n'
import { formatCurrency } from '../lib/currency'
import { haptic } from '../lib/telegram'
import './MagneticSlot.css'

// ─────────────────────────────────────────────────────────────
// MAGNETIC — popular slot.
//
//   - 5 magnets on the top row, each with a RANDOM multiplier per
//     spin (pulled from MAGNET_POOL with weighted probabilities).
//   - 5 reels × 3 symbols below. Symbols have a "pull strength":
//       🔩 bolt    3
//       🪙 coin    8
//       🏆 trophy  18
//       💎 gem     35
//       ⚡ lightning 60
//       blank      0
//   - After a spin each reel's TOTAL strength decides how high the
//     reel's symbols float upward toward their magnet:
//       reach = clamp(totalStrength / STRENGTH_FULL, 0, 1)
//     reach=1 → full magnet multiplier paid; reach=0.5 → half; etc.
//
// Dev-only for now: balance is debited locally with no server
// round. RTP isn't tuned yet — math will be balanced via Monte-
// Carlo once the visuals lock in.
// ─────────────────────────────────────────────────────────────

const BETS = [10, 25, 50, 100, 250, 500, 1000, 2000, 4000, 8000, 16000, 25000]
const SLOT_ID = 'magnetic'

const REELS = 5
const ROWS  = 3

const MAGNET_POOL    = [2,   5,   10,  25,  50, 100]
const MAGNET_WEIGHTS = [38,  26,  16,  10,  6,  4]
const MAGNET_WEIGHT_SUM = MAGNET_WEIGHTS.reduce((s, w) => s + w, 0)

function pickMagnet() {
  let r = Math.random() * MAGNET_WEIGHT_SUM
  for (let i = 0; i < MAGNET_POOL.length; i++) {
    if (r < MAGNET_WEIGHTS[i]) return MAGNET_POOL[i]
    r -= MAGNET_WEIGHTS[i]
  }
  return MAGNET_POOL[0]
}

const SYMBOLS = [
  { id: 'blank', emoji: '·',  strength: 0,  weight: 30 },
  { id: 'bolt',  emoji: '🔩', strength: 3,  weight: 32 },
  { id: 'coin',  emoji: '🪙', strength: 8,  weight: 20 },
  { id: 'troph', emoji: '🏆', strength: 18, weight: 11 },
  { id: 'gem',   emoji: '💎', strength: 35, weight: 5  },
  { id: 'volt',  emoji: '⚡', strength: 60, weight: 2  },
]
const SYM_WEIGHT_SUM = SYMBOLS.reduce((s, x) => s + x.weight, 0)

function pickSymbol() {
  let r = Math.random() * SYM_WEIGHT_SUM
  for (const s of SYMBOLS) {
    if (r < s.weight) return s
    r -= s.weight
  }
  return SYMBOLS[0]
}

const STRENGTH_FULL = 100
function strengthToReach(s) {
  if (s <= 0) return 0
  return Math.min(1, s / STRENGTH_FULL)
}

function emptyGrid() {
  return Array.from({ length: REELS }, () =>
    Array.from({ length: ROWS }, () => SYMBOLS[0])
  )
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

export default function MagneticSlot() {
  const navigate = useNavigate()
  const { balance, setBalance, currency, rates, lang, user, setBalanceBounce } = useGameStore(
    useShallow(s => ({
      balance: s.balance,
      setBalance: s.setBalance,
      currency: s.currency,
      rates: s.rates,
      lang: s.lang,
      user: s.user,
      setBalanceBounce: s.setBalanceBounce,
    }))
  )
  const t = translations[lang] || translations.ru

  // Pick a sensible starting stake based on balance (mirrors Dice).
  const initialStake = (() => {
    const defaults = [50, 25, 10]
    for (const v of defaults) if (balance >= v) return v
    return BETS[0]
  })()

  const [stake, setStake]       = useState(initialStake)
  const [magnets, setMagnets]   = useState(() =>
    Array.from({ length: REELS }, pickMagnet)
  )
  const [grid, setGrid]         = useState(emptyGrid)
  const [reaches, setReaches]   = useState(() => Array(REELS).fill(null))
  const [reelPayouts, setReelPayouts] = useState(() => Array(REELS).fill(0))
  const [lastWin, setLastWin]   = useState(0)
  const [phase, setPhase]       = useState('idle')   // idle | spinning | pulling | settled
  const [spinning, setSpinning] = useState(false)
  const [autoSpin, setAutoSpin] = useState(false)
  const [exitConfirm, setExitConfirm] = useState(false)

  const balanceRef    = useRef(balance)
  const stakeRef      = useRef(stake)
  const spinningRef   = useRef(false)
  const autoRef       = useRef(false)
  const cancelRef     = useRef(false)
  const spinTickRef   = useRef(null)
  const magnetTickRef = useRef(null)

  useEffect(() => { balanceRef.current = balance }, [balance])
  useEffect(() => { stakeRef.current   = stake },   [stake])
  useEffect(() => { autoRef.current    = autoSpin }, [autoSpin])
  useEffect(() => () => {
    cancelRef.current = true
    if (spinTickRef.current) clearInterval(spinTickRef.current)
    if (magnetTickRef.current) clearInterval(magnetTickRef.current)
  }, [])

  // ── Telegram BackButton ──
  useEffect(() => {
    const tg = window.Telegram?.WebApp
    if (!tg) return
    tg.BackButton.show()
    const back = () => {
      haptic('light')
      if (spinning || autoSpin) setExitConfirm(true)
      else navigate('/')
    }
    tg.BackButton.onClick(back)
    return () => { tg.BackButton.offClick(back); tg.BackButton.hide() }
  }, [navigate, spinning, autoSpin])

  function confirmExit() {
    haptic('medium')
    cancelRef.current = true
    setAutoSpin(false); autoRef.current = false
    setExitConfirm(false)
    navigate('/')
  }

  const stakeIndex = BETS.indexOf(stake)
  const canAfford  = balance >= stake
  const stakeUpDisabled   = spinning || stakeIndex >= BETS.length - 1 ||
                            (BETS[stakeIndex + 1] !== undefined && BETS[stakeIndex + 1] > balance)
  const stakeDownDisabled = spinning || stakeIndex <= 0
  const winLabel = lastWin > 0 ? `+${formatCurrency(lastWin, currency, rates)}` : null

  function changeStake(dir) {
    if (spinning) return
    const next = BETS[stakeIndex + dir]
    if (next == null) return
    if (dir > 0 && next > balance) return
    haptic('light')
    setStake(next)
  }

  async function spin() {
    if (spinningRef.current) return
    if (balanceRef.current < stakeRef.current) return

    spinningRef.current = true
    setSpinning(true)
    haptic('light')

    setPhase('spinning')
    setReaches(Array(REELS).fill(null))
    setReelPayouts(Array(REELS).fill(0))
    setLastWin(0)

    // Debit stake locally (dev-only).
    const next = balanceRef.current - stakeRef.current
    balanceRef.current = next
    setBalance(next)

    const finalMagnets = Array.from({ length: REELS }, pickMagnet)
    const finalGrid    = Array.from({ length: REELS }, () =>
      Array.from({ length: ROWS }, pickSymbol)
    )

    // Magnets shuffle — flashes ~9 times then settles.
    let shuffles = 0
    magnetTickRef.current = setInterval(() => {
      shuffles++
      if (shuffles >= 9 || cancelRef.current) {
        clearInterval(magnetTickRef.current)
        magnetTickRef.current = null
        setMagnets(finalMagnets)
        return
      }
      setMagnets(Array.from({ length: REELS }, pickMagnet))
    }, 90)

    // Reel blur — random emoji every 70ms.
    spinTickRef.current = setInterval(() => {
      if (cancelRef.current) return
      setGrid(Array.from({ length: REELS }, () =>
        Array.from({ length: ROWS }, pickSymbol)
      ))
    }, 70)

    // Cascade stop left → right.
    const settled = emptyGrid()
    for (let r = 0; r < REELS; r++) {
      await sleep(r === 0 ? 700 : 220)
      if (cancelRef.current) {
        if (spinTickRef.current) { clearInterval(spinTickRef.current); spinTickRef.current = null }
        if (magnetTickRef.current) { clearInterval(magnetTickRef.current); magnetTickRef.current = null }
        spinningRef.current = false
        setSpinning(false)
        setPhase('idle')
        return
      }
      settled[r] = finalGrid[r]
      setGrid(prev => prev.map((col, ci) => settled[ci] || col))
    }

    if (spinTickRef.current) {
      clearInterval(spinTickRef.current)
      spinTickRef.current = null
    }
    setGrid(finalGrid)

    await sleep(220)
    if (cancelRef.current) {
      spinningRef.current = false
      setSpinning(false)
      setPhase('idle')
      return
    }

    // Magnetism pass.
    const newReaches = finalGrid.map(reel => {
      const total = reel.reduce((s, sym) => s + sym.strength, 0)
      return strengthToReach(total)
    })
    const payouts = newReaches.map((reach, ri) =>
      Math.round((reach * finalMagnets[ri] * stakeRef.current) / REELS)
    )
    const winTotal = payouts.reduce((s, p) => s + p, 0)

    setReaches(newReaches)
    setReelPayouts(payouts)
    setLastWin(winTotal)
    setPhase('pulling')

    await sleep(900)
    if (cancelRef.current) return

    if (winTotal > 0) {
      const nb = balanceRef.current + winTotal
      balanceRef.current = nb
      setBalance(nb)
      if (typeof setBalanceBounce === 'function') {
        setBalanceBounce(true)
        setTimeout(() => setBalanceBounce(false), 540)
      }
      haptic('success')
    } else {
      haptic('light')
    }

    setPhase('settled')
    spinningRef.current = false
    setSpinning(false)
  }

  async function autoLoop() {
    while (autoRef.current && !cancelRef.current) {
      if (balanceRef.current < stakeRef.current) {
        setAutoSpin(false); autoRef.current = false
        break
      }
      await spin()
      await sleep(420)
    }
  }

  function onSpinClick() {
    if (autoSpin) {
      setAutoSpin(false); autoRef.current = false
      return
    }
    if (!canAfford || spinning) return
    spin()
  }

  function onAutoClick() {
    if (autoSpin) {
      setAutoSpin(false); autoRef.current = false
      return
    }
    if (!canAfford || spinning) return
    setAutoSpin(true); autoRef.current = true
    autoLoop()
  }

  return (
    <div className={`magnetic-slot-page magnetic-slot-page--${phase}`}>
      <div className="magnetic-game-window">
        <main className="magnetic-stage" aria-label="Magnetic">
          {/* ── Magnets row ── */}
          <div className="magnetic-magnets">
            {magnets.map((mult, i) => {
              const isHot = mult >= 50
              const captured = reaches[i] === 1
              return (
                <div
                  key={i}
                  className={
                    'magnetic-magnet' +
                    (isHot ? ' magnetic-magnet--hot' : '') +
                    (captured ? ' is-captured' : '')
                  }
                >
                  <span className="magnetic-magnet-body">🧲</span>
                  <span className="magnetic-magnet-mult">×{mult}</span>
                </div>
              )
            })}
          </div>

          {/* ── Pull zone ── */}
          <div className="magnetic-pull-zone">
            {grid.map((reel, ri) => {
              const reach = reaches[ri]
              const isPulling = phase === 'pulling' || phase === 'settled'
              const reachPct = reach == null ? 0 : Math.round(reach * 100)
              const payout = reelPayouts[ri]
              return (
                <div
                  key={ri}
                  className={'magnetic-pull-col' + (isPulling ? ' is-pulling' : '')}
                  style={{ '--reach': `${reachPct}%` }}
                >
                  {isPulling && reach != null && (
                    <div className="magnetic-pulled-stack">
                      {reel.map((sym, ci) => (
                        <span key={ci} className="magnetic-pulled-symbol">
                          {sym.emoji}
                        </span>
                      ))}
                      {payout > 0 && (
                        <span className="magnetic-reel-payout">
                          +{formatCurrency(payout, currency, rates)}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* ── Reels (fade out when pulling) ── */}
          <div className={'magnetic-reels' + (phase === 'pulling' || phase === 'settled' ? ' is-cleared' : '')}>
            {grid.map((reel, ri) => (
              <div key={ri} className="magnetic-reel">
                {reel.map((sym, ci) => (
                  <span key={ci} className="magnetic-cell">{sym.emoji}</span>
                ))}
              </div>
            ))}
          </div>

          {/* ── Win bar ── */}
          <div className={'magnetic-winbar ' + (lastWin > 0 ? 'is-win' : '')}>
            <span className="magnetic-winbar-label">{t.slotPotential || 'Выигрыш'}</span>
            <strong className="magnetic-winbar-value">
              {winLabel ?? formatCurrency(0, currency, rates)}
            </strong>
          </div>
        </main>

        {/* ── Controls: balance / spin / stake ── */}
        <section className="magnetic-controls">
          <div className="magnetic-balance">
            <span>{t.balance || 'Баланс'}</span>
            <strong>{formatCurrency(balance, currency, rates)}</strong>
          </div>

          <div className="magnetic-center">
            <button
              type="button"
              className={'magnetic-spin-btn' + (autoSpin ? ' is-auto' : '')}
              onClick={onSpinClick}
              disabled={!autoSpin && (!canAfford || spinning)}
              aria-label={autoSpin ? (t.slotPlinkoStop || 'Стоп') : 'Spin'}
            >
              {autoSpin ? (
                <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <rect x="6" y="5" width="4" height="14" rx="1.2" />
                  <rect x="14" y="5" width="4" height="14" rx="1.2" />
                </svg>
              ) : (
                <svg width="34" height="34" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M12 5v14M5 12l7-7 7 7" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              )}
            </button>
            <button
              type="button"
              className={'magnetic-auto-btn' + (autoSpin ? ' is-on' : '')}
              onClick={onAutoClick}
              disabled={!autoSpin && (!canAfford || spinning)}
            >
              {autoSpin ? (t.slotPlinkoStop || 'СТОП') : (t.slotPlinkoAuto || 'АВТО')}
            </button>
          </div>

          <div className="magnetic-stake-block">
            <div className="magnetic-stake-row">
              <button
                type="button"
                className="magnetic-stake-step"
                onClick={() => changeStake(-1)}
                disabled={stakeDownDisabled}
                aria-label="stake down"
              >−</button>
              <div className="magnetic-stake">
                <span>{t.slotBet || 'Ставка'}</span>
                <strong>{formatCurrency(stake, currency, rates)}</strong>
              </div>
              <button
                type="button"
                className="magnetic-stake-step"
                onClick={() => changeStake(1)}
                disabled={stakeUpDisabled}
                aria-label="stake up"
              >+</button>
            </div>
          </div>
        </section>
      </div>

      {exitConfirm && (
        <div className="magnetic-exit-backdrop">
          <div className="magnetic-exit-card">
            <h3>{t.slotExitTitle || 'Выйти из игры?'}</h3>
            <p>{t.slotExitText || 'Если автоспин активен — он остановится.'}</p>
            <div className="magnetic-exit-actions">
              <button type="button" onClick={() => { haptic('light'); setExitConfirm(false) }}>
                {t.slotExitStay || 'Остаться'}
              </button>
              <button type="button" onClick={confirmExit}>
                {t.slotExitLeave || 'Выйти'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
