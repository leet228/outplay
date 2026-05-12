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

// Memoised single-ball renderer. With 100 balls in flight, animateBall()
// fires a setBalls() per row-step per ball — without React.memo each
// step diffs all 100 nodes. Memoised on (id, row, col), so when one
// ball updates, the other 99 skip reconciliation entirely. Big perf
// win on phones once ballsPerLaunch hits 50+.
const PlinkoBall = React.memo(function PlinkoBall({ row, col }) {
  let topCss
  if (row === 0) {
    topCss = '0px'
  } else if (row === ROWS) {
    topCss = 'calc(100% - var(--plinko-slot-row-h, 4%) / 2)'
  } else {
    const frac = rowNormY(row - 0.5)
    topCss = `calc(${frac} * (100% - var(--plinko-slot-row-h, 4%)))`
  }
  return (
    <span
      className="plinko-ball"
      style={{
        left: `${ballNormX(row, col) * 100}%`,
        top:  topCss,
      }}
      aria-hidden="true"
    />
  )
})

// Single bucket on the multiplier row. Wrapped in React.memo so that
// during a 100-ball landing burst — where setHitSlots flips one slot's
// `ts` at a time — only the slot whose timestamp changed reconciles.
// The other 16 cells return the same vdom and bail out early.
//
// `ts` is the timestamp of the most recent ball-landing on this slot
// (cleared 280 ms later by flashSlot's setTimeout). When it changes:
//   - `.is-hit` toggles on/off — drives the parent block's dip-down
//     animation (plinko-slot-block-jerk)
//   - The pulse child remounts under a fresh key, replaying its
//     scale + downward translate keyframes from frame 0
const SlotCell = React.memo(function SlotCell({ mul, ts }) {
  return (
    <span
      className={`plinko-slot plinko-slot--tier${tierFor(mul)} ${ts ? 'is-hit' : ''}`}
    >
      <span className="plinko-slot-mul">{formatMul(mul)}</span>
      {ts != null && (
        <span
          key={`pulse-${ts}`}
          className="plinko-slot-pulse"
          aria-hidden="true"
        />
      )}
    </span>
  )
})

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

  // ── rAF coalescing ──
  // 100-ball launches land in a tight cluster — without batching that's
  // 100 setBalance + 100 setLaunchWin + 100 setHitSlots within ~1.5 s,
  // each triggering a global Zustand re-render and a slot-row diff.
  // We collect updates per-frame and flush at most once per rAF, which
  // caps the React update rate at 60 Hz regardless of landing density.
  const winFlushRef       = useRef({ pending: 0, scheduled: false })
  const hitFlushRef       = useRef({ pending: [], scheduled: false })
  const removeFlushRef    = useRef({ pending: [], scheduled: false })
  const lastHapticAtRef   = useRef(0)
  const bounceTimerRef    = useRef(null)

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
  // Exit-confirmation dialog. Shown when the user taps the Telegram
  // BackButton while a launch is in progress (balls in flight, finalize
  // pending, or auto-spin armed) — same UX as the other slots so the
  // user can't accidentally walk away mid-round and lose track of their
  // stake. Mirrors Tower Stack / Block Blast / Rocket exit prompts.
  const [exitConfirm, setExitConfirm] = useState(false)
  // True while ANY ball from the active launch is still in flight.
  // Flipped on at dropLaunch start, off only when the last ball of the
  // launch has fully landed (just before finalizeLaunch fires). New
  // launches — manual click OR auto-loop iteration — must wait for this
  // to clear, otherwise balls from two launches would overlap on the
  // board and the landing counter would be poisoned.
  const inFlightRef         = useRef(false)

  useEffect(() => { balanceRef.current        = balance },        [balance])
  useEffect(() => { stakeRef.current          = stake },          [stake])
  useEffect(() => { riskRef.current           = risk },           [risk])
  useEffect(() => { ballsPerLaunchRef.current = ballsPerLaunch }, [ballsPerLaunch])
  useEffect(() => { autoRef.current           = autoSpin },       [autoSpin])
  useEffect(() => () => {
    cancelRef.current = true
    if (bounceTimerRef.current) clearTimeout(bounceTimerRef.current)
  }, [])

  const stakeIndex = BETS.indexOf(stake)
  const mults      = MULTIPLIERS[risk]
  const totalBet   = stake * ballsPerLaunch
  const canAfford  = balance >= totalBet

  // ── Telegram BackButton ──
  // Re-binds when launch-active state changes so the handler captures
  // the latest values. If the user taps Back while balls are still in
  // flight, finalize is pending, or auto-spin is on — show the same
  // exit-confirm dialog the other slots use. Otherwise leave silently.
  useEffect(() => {
    const tg = window.Telegram?.WebApp
    if (!tg) return
    tg.BackButton.show()
    const back = () => {
      haptic('light')
      const launchActive = balls.length > 0 || finalizing || autoSpin || inFlightRef.current
      if (launchActive) setExitConfirm(true)
      else navigate('/')
    }
    tg.BackButton.onClick(back)
    return () => { tg.BackButton.offClick(back); tg.BackButton.hide() }
  }, [navigate, balls.length, finalizing, autoSpin])

  // Confirm exit — cancel auto-spin and tear down the page. cancelRef
  // gates all in-flight async work (animateBall loops, autoLoop, the
  // rAF flushers) so leaving doesn't trigger zombie setBalance calls
  // after the component is gone.
  function confirmExit() {
    haptic('medium')
    cancelRef.current = true
    setAutoSpin(false); autoRef.current = false
    setExitConfirm(false)
    navigate('/')
  }

  // Auto-clamp stake when balance drops.
  useEffect(() => {
    if (autoSpin) return
    if (stake <= balance) return
    for (let i = BETS.length - 1; i >= 0; i--) {
      if (BETS[i] <= balance) { setStake(BETS[i]); return }
    }
  }, [balance, stake, autoSpin])

  // Lock stake / risk / balls-per-launch while a launch is in flight
  // (balls still falling) OR while we're waiting for the server's
  // finalize RPC to commit. Otherwise the user could change parameters
  // mid-launch and the running balls would be cleared by the new
  // dropLaunch() before settling, eating their bonus payout.
  const launchLocked = balls.length > 0 || finalizing || autoSpin

  function changeStake(direction) {
    if (launchLocked) return
    const nextIndex = Math.max(0, Math.min(BETS.length - 1, stakeIndex + direction))
    if (nextIndex === stakeIndex) return
    if (direction > 0 && BETS[nextIndex] > balance) return
    haptic('light')
    setStake(BETS[nextIndex])
  }

  function changeRisk(direction) {
    if (launchLocked) return
    const idx = RISK_LEVELS.indexOf(risk)
    const next = (idx + direction + RISK_LEVELS.length) % RISK_LEVELS.length
    haptic('light')
    setRisk(RISK_LEVELS[next])
  }

  function chooseBalls(n) {
    if (launchLocked) return
    haptic('light')
    setBallsPerLaunch(n)
  }

  // Ping the slot's hit animation. Multiple back-to-back hits are
  // de-duped by timestamp — only the most recent flash holds the
  // class, so a new ball landing in the same slot retriggers the pop.
  // Coalesces multiple hits in the same frame into a single setHitSlots
  // call; without this a 100-ball burst fires 100 separate slot-row
  // re-renders within 1.5 s.
  function flashSlot(idx) {
    hitFlushRef.current.pending.push(idx)
    if (hitFlushRef.current.scheduled) return
    hitFlushRef.current.scheduled = true
    requestAnimationFrame(() => {
      const indices = hitFlushRef.current.pending
      hitFlushRef.current.pending = []
      hitFlushRef.current.scheduled = false
      if (cancelRef.current || indices.length === 0) return
      const ts = Date.now() + Math.random()
      setHitSlots(prev => {
        const next = { ...prev }
        for (const i of indices) next[i] = ts
        return next
      })
      setTimeout(() => {
        setHitSlots(prev => {
          let changed = false
          const next = { ...prev }
          for (const i of indices) {
            if (next[i] === ts) { delete next[i]; changed = true }
          }
          return changed ? next : prev
        })
      }, 280)
    })
  }

  // rAF-batched balance + launchWin commit. Each ball calls commitWin()
  // and we flush the accumulated win once per frame — turns a 100-ball
  // landing burst from ~100 Zustand updates/sec into a steady 60 Hz.
  function commitWin(win) {
    if (win > 0) winFlushRef.current.pending += win
    // launchWin always advances (so a 0× still triggers a re-paint of the
    // win bar, otherwise it'd freeze on a stale value during all-loss
    // launches). But the value only meaningfully changes when win > 0.
    if (winFlushRef.current.scheduled) return
    winFlushRef.current.scheduled = true
    requestAnimationFrame(() => {
      const won = winFlushRef.current.pending
      winFlushRef.current.pending = 0
      winFlushRef.current.scheduled = false
      if (cancelRef.current) return
      if (won > 0) {
        const next = balanceRef.current + won
        balanceRef.current = next
        setBalance(next)
        setLaunchWin(prev => prev + won)
        setBalanceBounce(true)
        if (bounceTimerRef.current) clearTimeout(bounceTimerRef.current)
        bounceTimerRef.current = setTimeout(() => setBalanceBounce(false), 500)
      }
    })
  }

  // Cap haptic rate — 100 vibrations during a 1.5-s burst is jarring on
  // a phone and adds JS work for each call. One per 80 ms keeps the
  // tactile feel without saturating.
  function maybeHaptic(kind) {
    const now = performance.now()
    if (now - lastHapticAtRef.current < 80) return
    lastHapticAtRef.current = now
    haptic(kind)
  }

  // rAF-batched ball removal. 100 balls landing in ~1.5 s previously
  // fired 100 separate setBalls(filter) calls — each one O(N) on the
  // shrinking array. Coalescing per frame turns it into ~16 calls,
  // each removing the batch with one filter.
  function removeBalls(ids) {
    for (const id of ids) removeFlushRef.current.pending.push(id)
    if (removeFlushRef.current.scheduled) return
    removeFlushRef.current.scheduled = true
    requestAnimationFrame(() => {
      const out = removeFlushRef.current.pending
      removeFlushRef.current.pending = []
      removeFlushRef.current.scheduled = false
      if (cancelRef.current || out.length === 0) return
      const drop = new Set(out)
      setBalls(prev => prev.filter(b => !drop.has(b.id)))
    })
  }

  // Animate one ball through the peg field. The ball is already in
  // state (added by dropLaunch's batched spawn) — this just walks it
  // through the row updates, pays out, and queues its removal.
  // Tracks against ballsLandedRef / ballsExpectedRef and triggers the
  // launch finalize once the last ball settles.
  async function animateBall(id, path, landing) {
    if (cancelRef.current) return
    const currentRisk  = riskRef.current
    const currentStake = stakeRef.current

    for (let r = 1; r <= ROWS; r++) {
      if (cancelRef.current) return
      setBalls(prev => prev.map(b => b.id === id ? { ...b, row: r, col: path[r] } : b))
      await sleep(180)
    }
    if (cancelRef.current) return

    // Pay (optimistic local credit — server reconciles at finalize).
    // commitWin() rAF-batches setBalance + setLaunchWin so a 100-ball
    // landing burst settles in ~16 frames instead of 100 React updates.
    const mul = MULTIPLIERS[currentRisk][landing]
    const win = Math.round(currentStake * mul)
    commitWin(win)
    launchTotalWinRef.current += win
    flashSlot(landing)

    if (mul >= 1) maybeHaptic('success')
    else          maybeHaptic('light')

    // Drop the ball IMMEDIATELY on impact — the slot's pop / glow
    // animation (queued by flashSlot above) still plays on the
    // bucket after, so the player sees the multiplier reaction
    // without the ball lingering on top of it. removeBalls is
    // rAF-batched so 100 simultaneous landings still coalesce
    // into ~16 setBalls calls.
    removeBalls([id])

    // Track landings — when the last ball of the launch settles, clear
    // the in-flight flag and fire the server finalize. The flag has to
    // drop BEFORE finalizeLaunch starts because finalizeLaunch awaits a
    // server RPC and the auto-loop is only allowed to start the NEXT
    // launch once balls have stopped falling (finalizingRef guards the
    // RPC window separately).
    ballsLandedRef.current++
    if (ballsLandedRef.current >= ballsExpectedRef.current) {
      inFlightRef.current = false
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
    if (inFlightRef.current) return    // previous launch's balls still falling
    const N = ballsPerLaunchRef.current
    const cost = stakeRef.current * N
    if (balanceRef.current < cost) {
      setAutoSpin(false); autoRef.current = false
      return
    }
    // Reserve the in-flight slot before any awaits so a second
    // dropLaunch() racing on the click can't slip through.
    inFlightRef.current = true

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
      if (cancelRef.current) { inFlightRef.current = false; return }
      if (!res || res.error || !res.ok) {
        console.error('startPlinkoRound failed:', res)
        setAutoSpin(false); autoRef.current = false
        // Release the gate so the user can retry instead of being stuck
        // with a permanently-locked drop button after a server hiccup.
        inFlightRef.current = false
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

    // Pre-roll every ball's path up front so we can spawn them all in a
    // single setBalls() commit. Without this, a 100-ball launch would
    // fire 100 separate "append ball" renders during the spawn window
    // (one every 14 ms) — each diffing the growing balls array.
    const launchSeed = Date.now()
    const newBalls = []
    const meta = []
    for (let i = 0; i < N; i++) {
      const id = `b${launchSeed}-${i}`
      const { path, landing } = rollPath()
      newBalls.push({ id, row: 0, col: 0 })
      meta.push({ id, path, landing })
    }

    // ONE commit — all N balls appear at row 0 simultaneously. Visually
    // they're stacked at top centre; the cascade kicks in 140 ms later
    // as each ball's row-step loop starts on its own staggered timer.
    setBalls(prev => [...prev, ...newBalls])

    // ── Per-launch stagger ──
    // Tuned so each launch finishes draining inside the user-visible
    // budget AND keeps peak ball concurrency manageable.
    //
    //   Total clear time = 140 + (N − 1) × stagger + 16 × 180 + 180
    //                     ≈ (N − 1) × stagger + 3200 ms
    //
    //     N=100 stagger 42 → 99·42 + 3200 ≈ 7360 ms  (budget 7.5 s) ✓
    //     N=50  stagger 35 → 49·35 + 3200 ≈ 4915 ms  (budget 5.0 s) ✓
    //     N=20  stagger 60 → 19·60 + 3200 ≈ 4340 ms
    //     N=10  stagger 80 → 9·80  + 3200 ≈ 3920 ms
    //
    // Wider stagger at N=100 also caps peak concurrent balls at ~73
    // instead of all 100, which lowers per-frame render pressure.
    const stagger = N <= 10 ? 80
                  : N <= 20 ? 60
                  : N <= 50 ? 35
                  : 42
    for (let i = 0; i < N; i++) {
      const m = meta[i]
      setTimeout(() => animateBall(m.id, m.path, m.landing), 140 + i * stagger)
    }
  }

  // Auto-loop: chains launches as long as auto is on and balance allows.
  // Each iteration waits for the previous launch's balls to fully land
  // (inFlightRef = false) AND for the server finalize to commit
  // (finalizingRef = false) before firing the next dropLaunch. Without
  // the inFlight gate, balls from launch N+1 would spawn while N's
  // last balls were still falling, polluting the landing counter.
  async function autoLoop() {
    while (autoRef.current && !cancelRef.current) {
      // Wait for any active launch to drain (balls falling OR server
      // finalize pending). Polling at 60 ms is plenty — this loop
      // only spins between launches, not during them.
      while (
        (inFlightRef.current || finalizingRef.current) &&
        !cancelRef.current && autoRef.current
      ) {
        await sleep(60)
      }
      if (!autoRef.current || cancelRef.current) break
      const cost = stakeRef.current * ballsPerLaunchRef.current
      if (balanceRef.current < cost) {
        setAutoSpin(false); autoRef.current = false
        break
      }
      await dropLaunch()
      // Small breather so the user perceives a gap between launches
      // (the gate above handles the real "are balls done falling"
      // wait on the next iteration).
      await sleep(280)
    }
  }

  function onDropClick() {
    if (autoSpin) {
      setAutoSpin(false); autoRef.current = false
      return
    }
    if (finalizingRef.current) return
    if (inFlightRef.current) return   // wait for previous balls to land
    if (!canAfford) return
    dropLaunch()
  }

  function onAutoClick() {
    if (autoSpin) {
      setAutoSpin(false); autoRef.current = false
      return
    }
    if (finalizingRef.current) return
    if (inFlightRef.current) return
    if (!canAfford) return
    setAutoSpin(true); autoRef.current = true
    autoLoop()
  }

  const stakeUpDisabled   = launchLocked || stakeIndex >= BETS.length - 1 ||
                            (BETS[stakeIndex + 1] !== undefined && BETS[stakeIndex + 1] > balance)
  const stakeDownDisabled = launchLocked || stakeIndex <= 0
  const winLabel = launchWin > 0 ? `+${formatCurrency(launchWin, currency, rates)}` : null

  // ── Memoised pegs ──
  // Static for the life of the component (ROWS is a constant). Without
  // memoisation, every setBalls() during a 100-ball launch causes React
  // to re-diff all 153 peg <span>s. This pins one render and reuses it.
  const pegsJsx = useMemo(() => (
    Array.from({ length: ROWS }).map((_, r) => {
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
    })
  ), [])

  // ── Slot row ──
  // Each cell is its own memoised component keyed on (mul, ts) — so
  // when a single ball lands and setHitSlots flips ONE slot's ts,
  // only that cell re-renders; the other 16 short-circuit through
  // React.memo. Old model used a useMemo over the whole row keyed on
  // [mults, hitSlots], which forced all 17 spans through reconciliation
  // every single hit. With 100-ball bursts producing ~25 hits/sec, that
  // was the main FPS drop the moment balls reached the buckets.
  //
  // Per-hit visible pulse: the slot itself is keyed by `slot-${k}` so
  // it keeps a stable identity, but the `.plinko-slot-pulse` overlay
  // child is keyed by `pulse-${ts}` — a fresh ts on every landing
  // batch. When ts changes React unmounts the old overlay and mounts a
  // new one, which forces the CSS animation to play from frame 0 even
  // if a previous pulse on the same slot is still mid-cycle.
  const slotsJsx = mults.map((mul, k) => (
    <SlotCell key={k} mul={mul} ts={hitSlots[k]} />
  ))

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
             * → slots visually sit "in the gaps" between pegs.
             *
             * The peg array itself is built once (useMemo above) and
             * reused across renders so React doesn't re-diff 153 spans
             * during a 100-ball launch. */}
            <div className="plinko-pegs" aria-hidden="true">{pegsJsx}</div>

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
            {balls.map(ball => (
              <PlinkoBall key={ball.id} row={ball.row} col={ball.col} />
            ))}

            {/* Landing slots — one row of multiplier buckets. The
             * children are memoised on (mults, hitSlots) so they only
             * re-render when the risk changes or a slot is flashed,
             * not on every ball-position update. */}
            <div className="plinko-slots" aria-hidden="true">{slotsJsx}</div>
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
                disabled={launchLocked}
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
              /* Drop is locked while balls from a previous launch are
               * still falling (launchLocked covers that, plus finalize
               * and auto-spin). The autoSpin variant is the "stop"
               * button and must always be clickable. */
              disabled={!autoSpin && (!canAfford || launchLocked)}
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
              disabled={!autoSpin && (!canAfford || launchLocked)}
            >
              {autoSpin ? t.slotPlinkoStop : t.slotPlinkoAuto}
            </button>
          </div>

          <div className="plinko-stake-block">
            <div className="plinko-risk-row">
              <button type="button" className="plinko-risk-step" onClick={() => changeRisk(-1)} disabled={launchLocked} aria-label="risk down">‹</button>
              <span className={`plinko-risk-label plinko-risk-label--${risk}`}>
                <span className="plinko-risk-name">
                  {risk === 'low'  ? t.slotPlinkoRiskLowName
                   : risk === 'high' ? t.slotPlinkoRiskHighName
                   : t.slotPlinkoRiskMediumName}
                </span>
                <span className="plinko-risk-suffix">{t.slotPlinkoRiskWord}</span>
              </span>
              <button type="button" className="plinko-risk-step" onClick={() => changeRisk(1)} disabled={launchLocked} aria-label="risk up">›</button>
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

      {exitConfirm && (
        <div className="plinko-exit-backdrop">
          <div className="plinko-exit-card">
            <h3>{t.slotExitTitle}</h3>
            <p>{t.slotExitText}</p>
            <div className="plinko-exit-actions">
              <button type="button" onClick={() => { haptic('light'); setExitConfirm(false) }}>{t.slotExitStay}</button>
              <button type="button" onClick={confirmExit}>{t.slotExitLeave}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
