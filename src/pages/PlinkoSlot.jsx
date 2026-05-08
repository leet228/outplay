import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useShallow } from 'zustand/react/shallow'
import useGameStore from '../store/useGameStore'
import { translations } from '../lib/i18n'
import { formatCurrency } from '../lib/currency'
import { haptic } from '../lib/telegram'
import { startPlinkoRound, finishPlinkoRound } from '../lib/supabase'
import './PlinkoSlot.css'

// ─────────────────────────────────────────────────────────────
// PLINKO — Stake.com-style 16-row board, multi-ball launches.
//
//   - 16 peg rows, 17 landing slots
//   - 3 risk modes (low / medium / high) — different multiplier tables
//   - Up to 100 balls per click ("balls per launch")
//   - Ball physics: split CSS transitions with ease-in for vertical
//     (gravity) and ease-in-out for lateral (peg redirection)
//   - Slot lights up when a ball lands (pop scale + bright glow)
//   - Currently dev/visual only: no Supabase round, no RTP server
//     enforcement. Math is honest binomial(16, 0.5) on the client.
// ─────────────────────────────────────────────────────────────

const BETS = [10, 25, 50, 100, 250, 500, 1000, 2000, 4000, 8000, 16000, 25000]
const MIN_BALANCE_RUB = 10
const SLOT_ID = 'plinko'

const ROWS = 16
const SLOTS = ROWS + 1            // 17 landing slots
const RISK_LEVELS = ['low', 'medium', 'high']
const BALLS_PER_LAUNCH = [1, 10, 20, 50, 100]

// Multiplier tables for 16-row board. Symmetric around the centre.
// All three risk modes are tuned so the analytic long-run RTP sits at
// ~94 % — under the 95 % design ceiling. Verified by:
//
//     node scripts/plinko-rtp-sim.js
//
//   low      analytic 94.05 %
//   medium   analytic 93.53 %
//   high     analytic 94.00 %
const MULTIPLIERS = {
  low:    [16,    9,   2,   1.4, 1.4, 1.2, 1,   0.9, 0.55, 0.9, 1,   1.2, 1.4, 1.4, 2,   9,   16   ],
  medium: [110,   41,  10,  5,   3,   1.5, 1,   0.4, 0.2,  0.4, 1,   1.5, 3,   5,   10,  41,  110  ],
  high:   [10000, 211, 21,  5,   1.8, 0.8, 0.3, 0.2, 0.1,  0.2, 0.3, 0.8, 1.8, 5,   21,  211, 10000],
}

// Slot tier (0..5) maps to a CSS gradient brightness level. All blues —
// just darker for sub-1× "danger zone" buckets, brighter for jackpot.
function tierFor(mul) {
  if (mul >= 1000) return 5
  if (mul >= 100)  return 4
  if (mul >= 10)   return 3
  if (mul >= 2)    return 2
  if (mul >= 1)    return 1
  return 0
}

// Compact display: 10000 → "10K", 211 → "211", 1.8 → "1.8", 0.1 → "0.1"
function formatMul(mul) {
  if (mul >= 1000) {
    const k = mul / 1000
    return Number.isInteger(k) ? `${k}K` : `${k.toFixed(1)}K`
  }
  if (Number.isInteger(mul)) return `${mul}`
  return `${mul}`
}

// One ball drop — fair coin per row. Returns the column path + landing.
function rollPath() {
  let k = 0
  const path = [k]
  for (let r = 0; r < ROWS; r++) {
    if (Math.random() < 0.5) k++
    path.push(k)
  }
  return { path, landing: k }
}

// ─── Geometry ───────────────────────────────────────────────────
// Peg field is compressed so the funnel stays narrow, but every row
// has r + 3 pegs (so the very top row shows 3 pegs like the spec
// photo, not 2). PEG_HFRAC gives the pegs more breathing room — at
// 0.85 the gaps between pegs in any row are visibly wider than the
// previous tight 0.64 layout.
const PEG_HFRAC  = 1.10   // peg/ball span (overflows game-area for max spread)
const SLOT_HFRAC = 1.10   // slot row span — matches peg field so slots sit in peg gaps

function compressX(local, frac) {
  return 0.5 + (local - 0.5) * frac
}

function ballNormX(r, k) {
  const local = 0.5 + (k - r / 2) / (ROWS + 1)
  return compressX(local, r === ROWS ? SLOT_HFRAC : PEG_HFRAC)
}

// rowNormY — fraction of the PEGS container height (the upper strip
// of game-area, minus the slot row strip pinned to its bottom).
function rowNormY(r) { return r / (ROWS - 1) }

function pegNormX(pegArg, p) {
  const local = 0.5 + (p - pegArg / 2) / (ROWS + 1)
  return compressX(local, PEG_HFRAC)
}

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

  const [stake, setStake]                   = useState(initialStake)
  const [risk, setRisk]                     = useState('medium')
  const [ballsPerLaunch, setBallsPerLaunch] = useState(1)
  const [autoSpin, setAutoSpin]             = useState(false)
  // Each in-flight ball: { id, row, col }. May contain many at once
  // when ballsPerLaunch > 1.
  const [balls, setBalls]                   = useState([])
  // Slot index → timestamp of last ball landing in it. Cleared by
  // a setTimeout after each flash so multiple balls can hit the same
  // slot in succession and re-trigger the animation.
  const [hitSlots, setHitSlots]             = useState({})
  // Total winnings of the current launch (sum across all balls).
  const [launchWin, setLaunchWin]           = useState(0)

  const balanceRef        = useRef(balance)
  const stakeRef          = useRef(stake)
  const riskRef           = useRef(risk)
  const ballsPerLaunchRef = useRef(ballsPerLaunch)
  const autoRef           = useRef(autoSpin)
  const cancelRef         = useRef(false)

  // Server-round bookkeeping. currentRoundRef holds the server's
  // round descriptor for the active launch; ballsLandedRef counts
  // how many of the launch's N balls have completed their fall so we
  // know when to finalize. finalizingRef gates new launches while a
  // finishPlinkoRound RPC is mid-flight (otherwise a fast click could
  // start a new round before the previous one's payout is committed).
  const currentRoundRef     = useRef(null)
  const ballsLandedRef      = useRef(0)
  const ballsExpectedRef    = useRef(0)
  const launchTotalWinRef   = useRef(0)
  const finalizingRef       = useRef(false)
  const [finalizing, setFinalizing] = useState(false)

  useEffect(() => { balanceRef.current        = balance },        [balance])
  useEffect(() => { stakeRef.current          = stake },          [stake])
  useEffect(() => { riskRef.current           = risk },           [risk])
  useEffect(() => { ballsPerLaunchRef.current = ballsPerLaunch }, [ballsPerLaunch])
  useEffect(() => { autoRef.current           = autoSpin },       [autoSpin])
  useEffect(() => () => { cancelRef.current   = true }, [])

  const stakeIndex = BETS.indexOf(stake)
  const mults      = MULTIPLIERS[risk]
  const totalBet   = stake * ballsPerLaunch
  const canAfford  = balance >= totalBet

  // ── Telegram BackButton ──
  useEffect(() => {
    const tg = window.Telegram?.WebApp
    if (!tg) return
    tg.BackButton.show()
    const back = () => { haptic('light'); navigate('/') }
    tg.BackButton.onClick(back)
    return () => { tg.BackButton.offClick(back); tg.BackButton.hide() }
  }, [navigate])

  // Auto-clamp stake when balance drops.
  useEffect(() => {
    if (autoSpin) return
    if (stake <= balance) return
    for (let i = BETS.length - 1; i >= 0; i--) {
      if (BETS[i] <= balance) { setStake(BETS[i]); return }
    }
  }, [balance, stake, autoSpin])

  function changeStake(direction) {
    if (autoSpin) return
    const nextIndex = Math.max(0, Math.min(BETS.length - 1, stakeIndex + direction))
    if (nextIndex === stakeIndex) return
    if (direction > 0 && BETS[nextIndex] > balance) return
    haptic('light')
    setStake(BETS[nextIndex])
  }

  function changeRisk(direction) {
    if (autoSpin) return
    const idx = RISK_LEVELS.indexOf(risk)
    const next = (idx + direction + RISK_LEVELS.length) % RISK_LEVELS.length
    haptic('light')
    setRisk(RISK_LEVELS[next])
  }

  function chooseBalls(n) {
    if (autoSpin) return
    haptic('light')
    setBallsPerLaunch(n)
  }

  // Ping the slot's hit animation. Multiple back-to-back hits are
  // de-duped by timestamp — only the most recent flash holds the
  // class, so a new ball landing in the same slot retriggers the pop.
  function flashSlot(idx) {
    const ts = Date.now() + Math.random()
    setHitSlots(prev => ({ ...prev, [idx]: ts }))
    // Match the 0.28 s CSS animation duration on .plinko-slot.is-hit.
    setTimeout(() => {
      setHitSlots(prev => {
        if (prev[idx] !== ts) return prev
        const next = { ...prev }
        delete next[idx]
        return next
      })
    }, 280)
  }

  // Animate one ball through the peg field. Self-cleans on landing.
  // Tracks against ballsLandedRef / ballsExpectedRef and triggers the
  // launch finalize once the last ball settles.
  async function animateBall() {
    if (cancelRef.current) return
    const id = `b${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const { path, landing } = rollPath()
    const currentRisk  = riskRef.current
    const currentStake = stakeRef.current

    setBalls(prev => [...prev, { id, row: 0, col: 0 }])
    await sleep(140)

    for (let r = 1; r <= ROWS; r++) {
      if (cancelRef.current) return
      setBalls(prev => prev.map(b => b.id === id ? { ...b, row: r, col: path[r] } : b))
      await sleep(180)
    }
    if (cancelRef.current) return

    // Pay (optimistic local credit — server reconciles at finalize).
    const mul = MULTIPLIERS[currentRisk][landing]
    const win = Math.round(currentStake * mul)
    if (win > 0) {
      const next = balanceRef.current + win
      balanceRef.current = next
      setBalance(next)
      setBalanceBounce(true)
      setTimeout(() => setBalanceBounce(false), 500)
    }
    setLaunchWin(prev => prev + win)
    launchTotalWinRef.current += win
    flashSlot(landing)

    if (mul >= 1) haptic('success')
    else          haptic('light')

    // Briefly hold the ball at the slot, then remove from grid.
    await sleep(180)
    setBalls(prev => prev.filter(b => b.id !== id))

    // Track landings — when the last ball of the launch settles, fire
    // the server finalize.
    ballsLandedRef.current++
    if (ballsLandedRef.current >= ballsExpectedRef.current) {
      finalizeLaunch()
    }
  }

  // Finalize the active launch on the server (real users only).
  // Reconciles the client's optimistic balance with the server's
  // authoritative number — server caps the payout and applies the
  // deficit breaker, so the credited amount may be less than the
  // client claimed.
  async function finalizeLaunch() {
    const round = currentRoundRef.current
    if (!round) return
    currentRoundRef.current = null
    const total = launchTotalWinRef.current
    launchTotalWinRef.current = 0
    ballsLandedRef.current = 0
    ballsExpectedRef.current = 0

    const rid = round.round_id
    if (typeof rid !== 'string' || rid.startsWith('dev-')) return

    finalizingRef.current = true
    setFinalizing(true)
    try {
      const res = await finishPlinkoRound(rid, total)
      if (res && typeof res.balance === 'number' && !cancelRef.current) {
        setBalance(res.balance)
        balanceRef.current = res.balance
      }
    } finally {
      finalizingRef.current = false
      setFinalizing(false)
    }
  }

  // One launch = ballsPerLaunch independent balls dropped with a small
  // spawn stagger. Server flow:
  //   real user → start_plinko_round debits stake×N, returns round_id
  //   dev user  → mock round_id, balance handled locally
  // Each ball animates independently and credits its win optimistically;
  // finalizeLaunch runs after the LAST ball lands.
  async function dropLaunch() {
    if (cancelRef.current) return
    if (finalizingRef.current) return  // wait for previous finalize
    const N = ballsPerLaunchRef.current
    const cost = stakeRef.current * N
    if (balanceRef.current < cost) {
      setAutoSpin(false); autoRef.current = false
      return
    }

    const isDev = !user || user.id === 'dev'
    let round
    if (isDev) {
      // Local — debit balance, fake a round id.
      const next = balanceRef.current - cost
      balanceRef.current = next
      setBalance(next)
      round = {
        ok: true,
        round_id: `dev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        balance: next,
        balls_count: N,
        deficit_active: false,
      }
    } else {
      const res = await startPlinkoRound(user.id, stakeRef.current, N)
      if (cancelRef.current) return
      if (!res || res.error || !res.ok) {
        console.error('startPlinkoRound failed:', res)
        setAutoSpin(false); autoRef.current = false
        return
      }
      round = res
      setBalance(round.balance)
      balanceRef.current = round.balance
    }

    currentRoundRef.current = round
    ballsLandedRef.current  = 0
    ballsExpectedRef.current = N
    launchTotalWinRef.current = 0
    setLaunchWin(0)
    haptic('light')

    const stagger = N <= 10 ? 80 : N <= 50 ? 35 : 14
    for (let i = 0; i < N; i++) {
      setTimeout(() => animateBall(), i * stagger)
    }
  }

  // Auto-loop: chains launches as long as auto is on and balance allows.
  async function autoLoop() {
    while (autoRef.current && !cancelRef.current) {
      // Wait out any in-flight finalize before firing the next launch
      // so previous round's payout is committed first.
      while (finalizingRef.current && !cancelRef.current && autoRef.current) {
        await sleep(60)
      }
      if (!autoRef.current || cancelRef.current) break
      const cost = stakeRef.current * ballsPerLaunchRef.current
      if (balanceRef.current < cost) {
        setAutoSpin(false); autoRef.current = false
        break
      }
      await dropLaunch()
      const N = ballsPerLaunchRef.current
      const stagger = N <= 10 ? 80 : N <= 50 ? 35 : 14
      const launchSpawnTime = N * stagger
      await sleep(Math.max(420, launchSpawnTime + 220))
    }
  }

  function onDropClick() {
    if (autoSpin) {
      setAutoSpin(false); autoRef.current = false
      return
    }
    if (finalizingRef.current) return
    if (!canAfford) return
    dropLaunch()
  }

  function onAutoClick() {
    if (autoSpin) {
      setAutoSpin(false); autoRef.current = false
      return
    }
    if (finalizingRef.current) return
    if (!canAfford) return
    setAutoSpin(true); autoRef.current = true
    autoLoop()
  }

  const stakeUpDisabled   = autoSpin || stakeIndex >= BETS.length - 1 ||
                            (BETS[stakeIndex + 1] !== undefined && BETS[stakeIndex + 1] > balance)
  const stakeDownDisabled = autoSpin || stakeIndex <= 0
  const winLabel = launchWin > 0 ? `+${formatCurrency(launchWin, currency, rates)}` : null

  return (
    <div className={`plinko-slot-page plinko-slot-page--${balls.length ? 'dropping' : 'idle'}`}>
      <div className="plinko-game-window">
        <main className="plinko-stage" aria-label="Plinko">
          <div className="plinko-bg" />
          <div className="plinko-board">
           {/* Compact game-area — sized in CSS to ~72 % of the board so
            * the peg field stays a small triangle in the middle of the
            * stage with empty space around it (matching the reference
            * spec photo). All inside coordinates use the game-area as
            * the 0..1 reference, no further compression needed. */}
           <div className="plinko-game-area">
            {/* Pegs — triangular grid. Row r has r+2 pegs, EXCEPT the
             * last row which gets r+3 (= ROWS+2 = 18) pegs spread across
             * the full game-area width at p / (ROWS + 1) positions. With
             * 18 pegs in the last row, each pair frames exactly one slot
             * → slots visually sit "in the gaps" between pegs. */}
            <div className="plinko-pegs" aria-hidden="true">
              {Array.from({ length: ROWS }).map((_, r) => {
                // Every row has r + 3 pegs so row 0 shows 3 pegs (the
                // spec photo opens with a 3-dot top row, not 2).
                const pegsInRow = r + 3
                const pegArg    = pegsInRow - 1
                return (
                  <React.Fragment key={`prow-${r}`}>
                    {Array.from({ length: pegsInRow }).map((__, p) => (
                      <span
                        key={`peg-${r}-${p}`}
                        className="plinko-peg"
                        style={{
                          left: `${pegNormX(pegArg, p) * 100}%`,
                          top:  `${rowNormY(r) * 100}%`,
                        }}
                      />
                    ))}
                  </React.Fragment>
                )
              })}
            </div>

            {/* Balls — many can be in flight at once when ballsPerLaunch > 1.
             *
             * Ball y is computed as a fraction of the pegs-container
             * height via calc(): pegs container is the board minus the
             * slot-row strip at bottom, so calc(frac × (100% − slot-h))
             * keeps the ball in lock-step with the peg rows.
             *
             * On the final row (r = ROWS), the ball is positioned
             * IN the slot row (calc(100% − slot-h / 2)) — a nice
             * "drop into slot" landing once the funnel has done its job. */}
            {balls.map(ball => {
              let topCss
              if (ball.row === 0) {
                topCss = '0px'
              } else if (ball.row === ROWS) {
                topCss = 'calc(100% - var(--plinko-slot-row-h, 4%) / 2)'
              } else {
                const frac = rowNormY(ball.row - 0.5)
                topCss = `calc(${frac} * (100% - var(--plinko-slot-row-h, 4%)))`
              }
              return (
                <span
                  key={ball.id}
                  className="plinko-ball"
                  style={{
                    left: `${ballNormX(ball.row, ball.col) * 100}%`,
                    top:  topCss,
                  }}
                  aria-hidden="true"
                />
              )
            })}

            {/* Landing slots — one row of multiplier buckets. */}
            <div className="plinko-slots" aria-hidden="true">
              {mults.map((mul, k) => (
                <span
                  key={`slot-${k}`}
                  className={`plinko-slot plinko-slot--tier${tierFor(mul)} ${hitSlots[k] ? 'is-hit' : ''}`}
                >
                  <span className="plinko-slot-mul">{formatMul(mul)}</span>
                </span>
              ))}
            </div>
           </div>
          </div>
        </main>

        {/* Win bar — sits directly above the launch selector so the win
            number is the user's first focal point after the stage. */}
        <div className={`plinko-winbar ${launchWin > 0 ? 'is-win' : ''}`}>
          <span className="plinko-winbar-label">{t.slotPotential}</span>
          <strong className="plinko-winbar-value">
            {winLabel ?? formatCurrency(0, currency, rates)}
          </strong>
        </div>

        {/* Balls-per-launch selector — choose how many balls per drop. */}
        <div className="plinko-launch-row">
          <div className="plinko-launch-row-head">
            <span className="plinko-launch-label">{t.slotPlinkoBallsPerLaunch}</span>
            <span className="plinko-launch-total">
              {t.slotPlinkoTotalBet} <strong>{formatCurrency(totalBet, currency, rates)}</strong>
            </span>
          </div>
          <div className="plinko-launch-buttons">
            {BALLS_PER_LAUNCH.map(n => (
              <button
                key={n}
                type="button"
                className={`plinko-launch-btn ${ballsPerLaunch === n ? 'is-active' : ''}`}
                onClick={() => chooseBalls(n)}
                disabled={autoSpin}
              >
                {n}
              </button>
            ))}
          </div>
        </div>

        <section className="plinko-controls">
          <div className="plinko-balance">
            <span>{t.balance || 'Balance'}</span>
            <strong>{formatCurrency(balance, currency, rates)}</strong>
          </div>

          <div className="plinko-center">
            <button
              type="button"
              className={`plinko-drop-btn ${autoSpin ? 'is-auto' : ''}`}
              onClick={onDropClick}
              disabled={!canAfford && !autoSpin}
              aria-label={autoSpin ? t.slotPlinkoStop : t.slotPlinkoDrop}
            >
              {autoSpin ? (
                <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="5" width="4" height="14" rx="1.2" />
                  <rect x="14" y="5" width="4" height="14" rx="1.2" />
                </svg>
              ) : (
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
                  <path d="M12 4 L12 18 M6 12 L12 18 L18 12" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
            <button
              type="button"
              className={`plinko-auto-btn ${autoSpin ? 'is-on' : ''}`}
              onClick={onAutoClick}
              disabled={!canAfford && !autoSpin}
            >
              {autoSpin ? t.slotPlinkoStop : t.slotPlinkoAuto}
            </button>
          </div>

          <div className="plinko-stake-block">
            <div className="plinko-risk-row">
              <button type="button" className="plinko-risk-step" onClick={() => changeRisk(-1)} disabled={autoSpin} aria-label="risk down">‹</button>
              <span className={`plinko-risk-label plinko-risk-label--${risk}`}>
                <span className="plinko-risk-name">
                  {risk === 'low'  ? t.slotPlinkoRiskLowName
                   : risk === 'high' ? t.slotPlinkoRiskHighName
                   : t.slotPlinkoRiskMediumName}
                </span>
                <span className="plinko-risk-suffix">{t.slotPlinkoRiskWord}</span>
              </span>
              <button type="button" className="plinko-risk-step" onClick={() => changeRisk(1)} disabled={autoSpin} aria-label="risk up">›</button>
            </div>
            <div className="plinko-stake-row">
              <button type="button" className="plinko-stake-step" onClick={() => changeStake(-1)} disabled={stakeDownDisabled} aria-label="stake down">−</button>
              <div className="plinko-stake">
                <span>{t.slotBet}</span>
                <strong>{formatCurrency(stake, currency, rates)}</strong>
              </div>
              <button type="button" className="plinko-stake-step" onClick={() => changeStake(1)} disabled={stakeUpDisabled} aria-label="stake up">+</button>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
