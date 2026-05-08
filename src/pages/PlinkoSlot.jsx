import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useShallow } from 'zustand/react/shallow'
import useGameStore from '../store/useGameStore'
import { translations } from '../lib/i18n'
import { formatCurrency } from '../lib/currency'
import { haptic } from '../lib/telegram'
import './PlinkoSlot.css'

// ─────────────────────────────────────────────────────────────
// PLINKO — pure dev/visual build (no RTP enforcement yet).
//
// Mechanic:
//   - Ball drops from the top centre.
//   - At each of ROWS peg rows, ball bounces left (k stays) or right
//     (k increments) — 50 / 50 per peg.
//   - After ROWS bounces, ball lands in slot k ∈ [0, ROWS]. There are
//     SLOTS = ROWS + 1 slots at the bottom, each with a fixed payout
//     multiplier (symmetric — middle = small, edges = huge).
//   - Payout = stake × MULTIPLIERS[k].
//
// Distribution is binomial(ROWS, 0.5) so the ball lands in the centre
// most of the time — matches real Plinko machines / Stake.com.
//
// For dev mode the math is honest fair coin per peg; we'll bolt on the
// RTP-shaped weighting + deficit breaker later (same way Tetris &
// Tower Stack do it).
// ─────────────────────────────────────────────────────────────

const BETS = [10, 25, 50, 100, 250, 500, 1000, 2000, 4000, 8000, 16000, 25000]
const MIN_BALANCE_RUB = 10
const SLOT_ID = 'plinko'

const ROWS = 12
const SLOTS = ROWS + 1                  // 13 landing slots
const RISK_LEVELS = ['low', 'medium', 'high']

// Multiplier tables borrowed from Stake.com 12-row Plinko (industry
// reference). Symmetric around the centre. Centre slot is the most
// probable (~22 %) and pays the lowest mul; edges are super rare
// (~0.024 %) and pay the jackpot tier.
const MULTIPLIERS = {
  low:    [10,  3,   1.6, 1.4, 1.1, 1,   0.5, 1,   1.1, 1.4, 1.6, 3,  10 ],
  medium: [24,  5,   2,   1.4, 1.1, 1,   0.5, 1,   1.1, 1.4, 2,   5,  24 ],
  high:   [110, 41,  10,  5,   3,   1.5, 0.3, 1.5, 3,   5,   10,  41, 110],
}

// Slot colour tier, used by CSS to colour each landing bucket.
// Higher tier = more saturated / hotter colour. Tiers based on mul
// magnitude relative to 1× stake.
function tierFor(mul) {
  if (mul >= 25) return 5
  if (mul >= 10) return 4
  if (mul >= 3)  return 3
  if (mul >= 1.4) return 2
  if (mul >= 1)   return 1
  return 0   // sub-1× = "danger zone"
}

// Run a single ball drop using fair coin per row. Returns:
//   path    — array of column indices (length ROWS + 1, starting at 0)
//   landing — final slot index ∈ [0, ROWS]
function rollPath() {
  let k = 0
  const path = [k]
  for (let r = 0; r < ROWS; r++) {
    if (Math.random() < 0.5) k++
    path.push(k)
  }
  return { path, landing: k }
}

// Geometry helpers — ball / peg positions are computed in board-space
// percentages (0..1) and multiplied by the measured stage box at render
// time. Lets the layout fluidly resize across phones / desktop.
//
// Ball at row r in column k:        x = 0.5 + (k − r/2) / (ROWS + 1)
// Peg in row r at column p ∈ [0..r+1]:  same formula with k = p
// Row r vertical position:           y = (r + 1) / (ROWS + 2)
function ballNormX(r, k)        { return 0.5 + (k - r / 2) / (ROWS + 1) }
function rowNormY(r)            { return (r + 1) / (ROWS + 2) }
function pegNormX(r, p)         { return 0.5 + (p - r / 2) / (ROWS + 1) }

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

export default function PlinkoSlot() {
  const navigate = useNavigate()
  const { balance, currency, rates, lang, user, setBalance, setBalanceBounce } = useGameStore(useShallow((s) => ({
    balance: s.balance, currency: s.currency, rates: s.rates, lang: s.lang,
    user: s.user, setBalance: s.setBalance, setBalanceBounce: s.setBalanceBounce,
  })))
  const t = translations[lang] ?? translations.ru

  const initialStake = useMemo(() => {
    const defaults = [50, 25, 10]
    for (const v of defaults) if (balance >= v) return v
    return BETS[0]
  }, [])

  const [stake, setStake] = useState(initialStake)
  const [risk, setRisk] = useState('medium')
  const [dropping, setDropping] = useState(false)
  const [autoSpin, setAutoSpin] = useState(false)
  const [ball, setBall] = useState(null) // { row, col, justLanded?: boolean } | null
  const [highlightSlot, setHighlightSlot] = useState(null)
  const [lastWin, setLastWin] = useState(0)
  const [recentResults, setRecentResults] = useState([]) // last few mul × stake values for the side rail

  const balanceRef = useRef(balance)
  const stakeRef = useRef(stake)
  const autoRef = useRef(autoSpin)
  const cancelRef = useRef(false)
  useEffect(() => { balanceRef.current = balance }, [balance])
  useEffect(() => { stakeRef.current = stake }, [stake])
  useEffect(() => { autoRef.current = autoSpin }, [autoSpin])
  useEffect(() => () => { cancelRef.current = true }, [])

  const stakeIndex = BETS.indexOf(stake)
  const mults = MULTIPLIERS[risk]
  const isBusy = dropping
  const canPlay = balance >= MIN_BALANCE_RUB && balance >= stake

  // ── Telegram BackButton ──
  useEffect(() => {
    const tg = window.Telegram?.WebApp
    if (!tg) return
    tg.BackButton.show()
    const back = () => {
      haptic('light')
      navigate('/')
    }
    tg.BackButton.onClick(back)
    return () => {
      tg.BackButton.offClick(back)
      tg.BackButton.hide()
    }
  }, [navigate])

  // Auto-clamp stake to max affordable when balance drops.
  useEffect(() => {
    if (isBusy) return
    if (stake <= balance) return
    for (let i = BETS.length - 1; i >= 0; i--) {
      if (BETS[i] <= balance) { setStake(BETS[i]); return }
    }
  }, [balance, stake, isBusy])

  function changeStake(direction) {
    if (isBusy) return
    const nextIndex = Math.max(0, Math.min(BETS.length - 1, stakeIndex + direction))
    if (nextIndex === stakeIndex) return
    if (direction > 0 && BETS[nextIndex] > balance) return
    haptic('light')
    setStake(BETS[nextIndex])
  }

  function changeRisk(direction) {
    if (isBusy || autoSpin) return
    const idx = RISK_LEVELS.indexOf(risk)
    const next = (idx + direction + RISK_LEVELS.length) % RISK_LEVELS.length
    haptic('light')
    setRisk(RISK_LEVELS[next])
  }

  // ── Drop one ball ──
  async function dropOne() {
    if (cancelRef.current) return
    if (balanceRef.current < stakeRef.current) {
      setAutoSpin(false); autoRef.current = false
      return
    }

    const currentStake = stakeRef.current
    const currentMults = MULTIPLIERS[risk]

    // Charge the stake immediately (dev-mode local).
    setBalance(balanceRef.current - currentStake)
    balanceRef.current -= currentStake

    setDropping(true)
    setHighlightSlot(null)
    setLastWin(0)

    const { path, landing } = rollPath()

    // Animate the ball through the path. CSS transitions handle the
    // smooth movement between waypoints; we just step the ball state.
    // The 220 ms-per-step pacing matches the .plinko-ball CSS transition
    // duration so the ball reaches each peg before the next waypoint
    // is set — the cubic-bezier ease-in on `top` makes the visual fall
    // accelerate like real gravity.
    setBall({ row: 0, col: 0 })
    haptic('light')
    // Slight delay so the ball appears at the spawn point before the
    // first row dispatch — gives the entry "drop in" feel.
    await sleep(180)

    for (let r = 1; r <= ROWS; r++) {
      if (cancelRef.current) return
      setBall({ row: r, col: path[r] })
      // gentle haptic kick on every other peg — feels like real bounces
      if (r % 2 === 0) haptic('light')
      await sleep(220)
    }

    // Settle into the slot
    if (cancelRef.current) return
    const mul = currentMults[landing]
    const win = Math.round(currentStake * mul)
    setHighlightSlot(landing)
    setLastWin(win)

    if (mul >= 1) haptic('success')
    else          haptic('medium')

    if (win > 0) {
      setBalance(balanceRef.current + win)
      balanceRef.current += win
      setBalanceBounce(true)
      setTimeout(() => setBalanceBounce(false), 600)
    }

    setRecentResults(prev => [{ mul, win, key: `${Date.now()}-${Math.random()}` }, ...prev].slice(0, 8))

    await sleep(550)
    if (cancelRef.current) return
    setBall(null)
    setDropping(false)

    // Auto-drop chain
    if (autoRef.current && balanceRef.current >= stakeRef.current && !cancelRef.current) {
      await sleep(220)
      if (autoRef.current && !cancelRef.current && balanceRef.current >= stakeRef.current) {
        dropOne()
      } else {
        setAutoSpin(false); autoRef.current = false
      }
    } else if (autoRef.current && balanceRef.current < stakeRef.current) {
      setAutoSpin(false); autoRef.current = false
    }
  }

  function onDropClick() {
    // Auto-stop toggle is ALWAYS allowed, even while a ball is mid-air.
    // The auto-chain only schedules another drop when autoRef.current is
    // still true at the check point in dropOne().
    if (autoSpin) {
      setAutoSpin(false); autoRef.current = false
      return
    }
    if (isBusy) return
    if (!canPlay) return
    dropOne()
  }

  function onAutoClick() {
    // Always allow stopping the auto chain — even mid-flight.
    if (autoSpin) {
      setAutoSpin(false); autoRef.current = false
      return
    }
    if (isBusy) return
    if (!canPlay) return
    setAutoSpin(true); autoRef.current = true
    dropOne()
  }

  const stakeUpDisabled = isBusy || stakeIndex >= BETS.length - 1 ||
                          (BETS[stakeIndex + 1] !== undefined && BETS[stakeIndex + 1] > balance)
  const stakeDownDisabled = isBusy || stakeIndex <= 0
  const winLabel = lastWin > 0 ? `+${formatCurrency(lastWin, currency, rates)}` : null

  return (
    <div className={`plinko-slot-page plinko-slot-page--${dropping ? 'dropping' : 'idle'}`}>
      <div className="plinko-game-window">
        <main className="plinko-stage" aria-label="Plinko">
          <div className="plinko-bg" />
          <div className="plinko-board">
            {/* Pegs — triangular grid, rows 0..ROWS-1, row r has r+2 pegs */}
            <div className="plinko-pegs" aria-hidden="true">
              {Array.from({ length: ROWS }).map((_, r) => {
                const pegsInRow = r + 2
                return (
                  <React.Fragment key={`prow-${r}`}>
                    {Array.from({ length: pegsInRow }).map((__, p) => (
                      <span
                        key={`peg-${r}-${p}`}
                        className="plinko-peg"
                        style={{
                          left:  `${pegNormX(r + 1, p) * 100}%`,
                          top:   `${rowNormY(r) * 100}%`,
                        }}
                      />
                    ))}
                  </React.Fragment>
                )
              })}
            </div>

            {/* Ball (only mounted while dropping). CSS transition handles
                the smooth move between waypoints set in dropOne(). */}
            {ball && (
              <span
                className="plinko-ball"
                style={{
                  left: `${ballNormX(ball.row, ball.col) * 100}%`,
                  top:  `${ball.row === 0 ? 0 : rowNormY(ball.row - 0.5) * 100}%`,
                }}
                aria-hidden="true"
              />
            )}

            {/* Landing slots — bottom row of multiplier buckets */}
            <div className="plinko-slots" aria-hidden="true">
              {mults.map((mul, k) => {
                const tier = tierFor(mul)
                const isHit = highlightSlot === k
                return (
                  <span
                    key={`slot-${k}`}
                    className={`plinko-slot plinko-slot--tier${tier} ${isHit ? 'is-hit' : ''}`}
                  >
                    <span className="plinko-slot-mul">×{mul}</span>
                  </span>
                )
              })}
            </div>
          </div>

          {/* Recent results rail — last 8 mul × stake outcomes */}
          {recentResults.length > 0 && (
            <ul className="plinko-recent" aria-hidden="true">
              {recentResults.map(r => (
                <li
                  key={r.key}
                  className={`plinko-recent-item plinko-recent-item--tier${tierFor(r.mul)}`}
                >
                  ×{r.mul}
                </li>
              ))}
            </ul>
          )}
        </main>

        <div className={`plinko-winbar ${lastWin > 0 ? 'is-win' : ''}`}>
          <span className="plinko-winbar-label">{t.slotPotential}</span>
          <strong className="plinko-winbar-value">
            {winLabel ?? formatCurrency(0, currency, rates)}
          </strong>
        </div>

        <section className="plinko-controls">
          <div className="plinko-balance">
            <span>{t.balance || 'Balance'}</span>
            <strong>{formatCurrency(balance, currency, rates)}</strong>
          </div>

          <div className="plinko-center">
            <button
              type="button"
              className={`plinko-drop-btn ${isBusy ? 'is-busy' : ''} ${autoSpin ? 'is-auto' : ''}`}
              onClick={onDropClick}
              disabled={(!canPlay && !autoSpin) || (isBusy && !autoSpin)}
              aria-label={autoSpin ? t.slotPlinkoStop : t.slotPlinkoDrop}
            >
              {isBusy ? (
                <svg className="plinko-drop-icon spinning" width="36" height="36" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" strokeDasharray="40 60" strokeLinecap="round"/>
                </svg>
              ) : autoSpin ? (
                <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="5" width="4" height="14" rx="1.2" />
                  <rect x="14" y="5" width="4" height="14" rx="1.2" />
                </svg>
              ) : (
                <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 4 L12 18 M6 12 L12 18 L18 12" stroke="currentColor" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
            <button
              type="button"
              className={`plinko-auto-btn ${autoSpin ? 'is-on' : ''}`}
              onClick={onAutoClick}
              disabled={isBusy && !autoSpin}
            >
              {autoSpin ? t.slotPlinkoStop : t.slotPlinkoAuto}
            </button>
          </div>

          <div className="plinko-stake-block">
            <div className="plinko-risk-row">
              <button
                type="button"
                className="plinko-risk-step"
                onClick={() => changeRisk(-1)}
                disabled={isBusy || autoSpin}
                aria-label="risk down"
              >‹</button>
              <span className={`plinko-risk-label plinko-risk-label--${risk}`}>
                {risk === 'low' ? t.slotPlinkoRiskLow
                 : risk === 'high' ? t.slotPlinkoRiskHigh
                 : t.slotPlinkoRiskMedium}
              </span>
              <button
                type="button"
                className="plinko-risk-step"
                onClick={() => changeRisk(1)}
                disabled={isBusy || autoSpin}
                aria-label="risk up"
              >›</button>
            </div>
            <div className="plinko-stake-row">
              <button
                type="button"
                className="plinko-stake-step"
                onClick={() => changeStake(-1)}
                disabled={stakeDownDisabled}
                aria-label="stake down"
              >−</button>
              <div className="plinko-stake">
                <span>{t.slotBet}</span>
                <strong>{formatCurrency(stake, currency, rates)}</strong>
              </div>
              <button
                type="button"
                className="plinko-stake-step"
                onClick={() => changeStake(1)}
                disabled={stakeUpDisabled}
                aria-label="stake up"
              >+</button>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
