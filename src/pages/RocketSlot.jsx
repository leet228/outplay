import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useShallow } from 'zustand/react/shallow'
import useGameStore from '../store/useGameStore'
import { translations } from '../lib/i18n'
import { formatCurrency } from '../lib/currency'
import { haptic } from '../lib/telegram'
import {
  getOrCreateCurrentRocketRound,
  getRocketHistory,
  placeRocketBet,
  cashoutRocketBet,
  subscribeRocketRounds,
  getServerNow,
} from '../lib/supabase'
import './RocketSlot.css'

const BETS = [10, 25, 50, 100, 250, 500, 1000, 2000, 4000, 8000, 16000, 25000]
const HISTORY_SIZE = 5
// Preset auto-cash multipliers — toggle pills below the controls.
// One can be active at a time; clicking the active one again clears it.
const AUTO_CASH_OPTIONS = [1.5, 2, 2.5, 3, 5, 10]

const GROWTH_BASE = 1.06          // multiplier(t) = 1.06^t (t in seconds)
// Frame interval for the multiplier readout / auto-cash check. 10fps
// is plenty for digit changes — going higher just burns React renders.
const FRAME_INTERVAL_MS = 100
// Backstop poll — fires only if no Realtime INSERT has been seen for a
// long while AND the current round is well past its hold window. This
// is purely defensive; the normal flow is event-driven (Realtime +
// per-round setTimeout to fetch the next round once the hold expires).
const BACKSTOP_POLL_MS = 30_000
// Visual reference for the betting progress bar — server's window is
// also 5s, kept in sync with migration_rocket_slot.sql.
const BETTING_DURATION_MS = 5000

// Aviator-style crash distribution for DEV mode only — real users get
// the server-side RTP-controlled value via place_rocket_bet. Mirrors
// the SQL: crash = clamp(0.95 / (1 - U), 1, 100).
function generateCrashPointDev() {
  const u = Math.random()
  const raw = 0.95 / Math.max(0.0001, 1 - u)
  return Math.max(1.00, Math.min(100.00, Math.round(raw * 100) / 100))
}

// Convert a round row (server timestamps as ISO strings) into a frame
// snapshot the rest of the component renders from.
function snapshotFromRound(round, now = Date.now()) {
  if (!round) return null
  const bettingUntil   = new Date(round.betting_until).getTime()
  const flyingStart    = new Date(round.flying_started_at).getTime()
  const crashedAt      = new Date(round.crashed_at).getTime()
  const holdUntil      = new Date(round.hold_until).getTime()
  let phase, multiplier
  if (now < bettingUntil) {
    phase = 'betting'
    multiplier = 1.0
  } else if (now < crashedAt) {
    phase = 'flying'
    multiplier = Math.pow(GROWTH_BASE, (now - flyingStart) / 1000)
  } else if (now < holdUntil) {
    phase = 'crashed'
    multiplier = Number(round.crash_at_mul)
  } else {
    phase = 'idle'  // hold expired; will trigger a poll for the next round
    multiplier = Number(round.crash_at_mul)
  }
  return {
    id: round.id,
    crashAt: Number(round.crash_at_mul),
    bettingTimeLeft: Math.max(0, bettingUntil - now),
    phase,
    multiplier,
  }
}

function fmtMul(m) {
  return `×${(Math.round(m * 100) / 100).toFixed(2)}`
}

function colorClassFor(m) {
  if (m < 2) return 'rocket-chip--low'
  if (m < 10) return 'rocket-chip--mid'
  return 'rocket-chip--high'
}

// Map a multiplier to a position on the stage (% of 0..100 viewport).
// Logarithmic so the rocket reads progress at every scale: m=1 → bottom-
// left, m=50 → top-right corner. Beyond 50× the rocket pins at the top.
function rocketPosForM(m) {
  const safe = Math.max(1, m)
  const p = Math.min(1, Math.log(safe) / Math.log(50))
  return {
    rx: 6 + p * 88,
    ry: 90 - p * 78,
  }
}

export default function RocketSlot() {
  const navigate = useNavigate()
  const { balance, currency, rates, lang, user, setBalance, setBalanceBounce } = useGameStore(useShallow((s) => ({
    balance: s.balance,
    currency: s.currency,
    rates: s.rates,
    lang: s.lang,
    user: s.user,
    setBalance: s.setBalance,
    setBalanceBounce: s.setBalanceBounce,
  })))
  const t = translations[lang] ?? translations.ru
  // Dev mode (no real Supabase user) keeps the local cycle so the slot
  // is playable without applying the migration.
  const isDev = !user || user.id === 'dev'

  const initialStake = useMemo(() => {
    const defaults = [50, 25, 10]
    for (const v of defaults) if (balance >= v) return v
    return BETS[0]
  }, []) // run once

  // ── Game state ──
  const [stake, setStake] = useState(initialStake)
  const [autoCash, setAutoCash] = useState(null)      // selected multiplier or null
  const [phase, setPhase] = useState('betting')       // 'betting' | 'flying' | 'crashed'
  const [multiplier, setMultiplier] = useState(1.0)
  const [bettingTimeLeft, setBettingTimeLeft] = useState(5000)
  const [history, setHistory] = useState([])
  const [bet, setBet] = useState(null)                // server bet { id, stake } / dev { stake }
  const [cashedAt, setCashedAt] = useState(null)
  const [cashedWin, setCashedWin] = useState(0)
  const [crashedAt, setCrashedAt] = useState(null)
  const [exitConfirm, setExitConfirm] = useState(false)
  // Monotonic counter bumped on every frame tick — guarantees a fresh
  // re-render even when none of the other state values changed by
  // enough to register (React skips identical state updates). The
  // curve recomputes on every render so this keeps it perfectly in
  // sync with the rocket and the multiplier readout.
  const [renderTick, setRenderTick] = useState(0)

  // ── Refs (avoid stale closures inside the long-lived loop) ──
  const phaseRef = useRef(phase)
  const betRef = useRef(bet)
  const cashedAtRef = useRef(cashedAt)
  const balanceRef = useRef(balance)
  const stakeRef = useRef(stake)
  const autoCashRef = useRef(autoCash)
  const cancelRef = useRef(false)
  // Dev-mode locals (mirror what the server tracks for real users).
  const crashTargetRef = useRef(1.0)
  const flyingStartRef = useRef(0)
  // Server-mode: latest known round row + the round id whose crash we
  // already pushed into history (dedup against rapid polls).
  const roundRef = useRef(null)
  const lastHistoryIdRef = useRef(null)
  const cashingOutRef = useRef(false)  // prevents double cash-out RPCs
  // Clock skew — serverNow − Date.now() at mount. All phase / multiplier
  // math uses (Date.now() + clockOffsetMs) so a desktop with sloppy
  // clock still sees the right countdown.
  const clockOffsetRef = useRef(0)

  useEffect(() => { phaseRef.current = phase }, [phase])
  useEffect(() => { betRef.current = bet }, [bet])
  useEffect(() => { cashedAtRef.current = cashedAt }, [cashedAt])
  useEffect(() => { balanceRef.current = balance }, [balance])
  useEffect(() => { stakeRef.current = stake }, [stake])
  useEffect(() => { autoCashRef.current = autoCash }, [autoCash])

  const stakeIndex = BETS.indexOf(stake)

  // Telegram BackButton — same UX as Tower / Tetris: prompt for
  // confirmation only if a bet is on the table that hasn't paid out
  // yet. Otherwise leaving is silent.
  useEffect(() => {
    const tg = window.Telegram?.WebApp
    if (!tg) return
    tg.BackButton.show()
    const back = () => {
      haptic('light')
      if (bet && cashedAt === null) setExitConfirm(true)
      else navigate('/')
    }
    tg.BackButton.onClick(back)
    return () => { tg.BackButton.offClick(back); tg.BackButton.hide() }
  }, [navigate, bet, cashedAt])

  useEffect(() => () => { cancelRef.current = true }, [])

  // Auto-clamp stake when balance drops mid-cycle (between rounds).
  useEffect(() => {
    if (bet) return
    if (balance >= stake) return
    for (let i = BETS.length - 1; i >= 0; i--) {
      if (BETS[i] <= balance) { setStake(BETS[i]); return }
    }
  }, [balance, stake, bet])

  // ── Core game loop ──
  // DEV mode (no Supabase user): purely local. Mirrors the server timing
  //   so the visual flow is identical to production.
  // SERVER mode (real user): poll get_or_create_current_rocket_round,
  //   subscribe to rocket_rounds INSERT broadcasts, render multiplier
  //   from server timestamps. Bets and cashouts go through RPCs.
  useEffect(() => {
    let timeoutId = null
    let rafId = null

    if (isDev) {
      // Forward references resolve at call-time via closure over `let`.
      let startBetting, startFlying, crash
      startBetting = () => {
        crashTargetRef.current = generateCrashPointDev()
        setMultiplier(1.0)
        setCashedAt(null); cashedAtRef.current = null
        setCashedWin(0)
        setCrashedAt(null)
        setPhase('betting'); phaseRef.current = 'betting'
        const start = performance.now()
        const tick = () => {
          if (cancelRef.current) return
          const left = Math.max(0, 5000 - (performance.now() - start))
          setBettingTimeLeft(left)
          if (left <= 0) startFlying()
          else timeoutId = setTimeout(tick, 80)
        }
        tick()
      }
      startFlying = () => {
        setPhase('flying'); phaseRef.current = 'flying'
        const target = crashTargetRef.current
        flyingStartRef.current = performance.now()
        const animate = () => {
          if (cancelRef.current) return
          const elapsed = performance.now() - flyingStartRef.current
          let m = Math.pow(GROWTH_BASE, elapsed / 1000)
          const auto = autoCashRef.current
          if (betRef.current && cashedAtRef.current === null
              && typeof auto === 'number' && auto > 1 && m >= auto) {
            performCashOutDev(auto)
          }
          if (m >= target) {
            m = target; setMultiplier(target); crash(); return
          }
          setMultiplier(m)
          rafId = requestAnimationFrame(animate)
        }
        animate()
      }
      crash = () => {
        const target = crashTargetRef.current
        setPhase('crashed'); phaseRef.current = 'crashed'
        setCrashedAt(target)
        setHistory(prev => [...prev, target].slice(-HISTORY_SIZE))
        if (betRef.current && cashedAtRef.current === null) haptic('error')
        setBet(null); betRef.current = null
        timeoutId = setTimeout(() => { if (!cancelRef.current) startBetting() }, 3000)
      }
      startBetting()
      return () => {
        if (timeoutId) clearTimeout(timeoutId)
        if (rafId) cancelAnimationFrame(rafId)
      }
    }

    // ── SERVER mode ────────────────────────────────────────────────
    // Event-driven loop:
    //   * Realtime channel listens for INSERTs on rocket_rounds — every
    //     client learns about new rounds the moment one is created.
    //   * On mount we pull the current round once.
    //   * After that, a single setTimeout wakes us right at hold_until
    //     to pull / lazy-create the next round. ONE RPC per round, not
    //     30 per minute.
    //   * A 30s backstop interval covers the unlikely case of both the
    //     Realtime broadcast AND our scheduled wake-up missing.
    //   * 10fps frame ticker drives the multiplier readout + auto-cash.
    let frameTimer = null
    let nextRoundTimer = null
    let backstopTimer = null
    let channel = null

    function applyRoundUpdate(round) {
      if (!round || round.error) return
      const prev = roundRef.current
      if (prev && prev.id !== round.id && lastHistoryIdRef.current !== prev.id) {
        lastHistoryIdRef.current = prev.id
        setHistory(h => [...h, Number(prev.crash_at_mul)].slice(-HISTORY_SIZE))
        // Bets only live within one round — reset on the boundary.
        setBet(null); betRef.current = null
        setCashedAt(null); cashedAtRef.current = null
        setCashedWin(0)
      }
      roundRef.current = round
      scheduleNextRoundWakeup(round)
    }

    function scheduleNextRoundWakeup(round) {
      if (nextRoundTimer) clearTimeout(nextRoundTimer)
      const holdUntil = new Date(round.hold_until).getTime()
      const serverNow = Date.now() + clockOffsetRef.current
      // +150ms buffer so server clock has definitely crossed hold_until
      // by the time we ask it for the next round.
      const delay = Math.max(50, holdUntil - serverNow + 150)
      nextRoundTimer = setTimeout(async () => {
        if (cancelRef.current) return
        const next = await getOrCreateCurrentRocketRound()
        applyRoundUpdate(next)
      }, delay)
    }

    function frameTick() {
      if (cancelRef.current) return
      // Always bump the render tick so React commits a fresh paint
      // even if other state values didn't change.
      setRenderTick(t => (t + 1) % 1_000_000)
      const round = roundRef.current
      if (round) {
        const now = Date.now() + clockOffsetRef.current
        const snap = snapshotFromRound(round, now)
        if (snap) {
          setPhase(snap.phase); phaseRef.current = snap.phase
          setMultiplier(snap.multiplier)
          setBettingTimeLeft(snap.bettingTimeLeft)
          if (snap.phase === 'crashed') setCrashedAt(snap.crashAt)
          else setCrashedAt(null)
          const auto = autoCashRef.current
          if (snap.phase === 'flying' && betRef.current
              && cashedAtRef.current === null
              && typeof auto === 'number' && auto > 1
              && snap.multiplier >= auto) {
            performCashOutServer(auto)
          }
        }
      }
    }

    // Initial load — clock-sync FIRST so the very first frameTick uses
    // a corrected time, then history + current round in parallel.
    getServerNow().then(serverNow => {
      if (typeof serverNow === 'number') {
        clockOffsetRef.current = serverNow - Date.now()
      }
    }).catch(() => {})

    Promise.all([
      getRocketHistory(HISTORY_SIZE).then(rows => {
        if (Array.isArray(rows)) {
          setHistory(rows.slice().reverse().map(r => Number(r.crash_at_mul)))
        }
      }),
      getOrCreateCurrentRocketRound().then(applyRoundUpdate),
    ]).catch(() => {})

    // Realtime — instant new-round broadcast (no client even needs to
    // ask the server when a new round comes in).
    channel = subscribeRocketRounds(applyRoundUpdate)

    frameTimer = setInterval(frameTick, FRAME_INTERVAL_MS)

    // Backstop: if for some reason Realtime AND our setTimeout both
    // missed an event and the visible round is stale by 5+ seconds,
    // pull a fresh one. Interval is sparse so it's basically free.
    // ALSO covers the initial-load case where the first RPC failed
    // and roundRef is still null after BACKSTOP_POLL_MS.
    backstopTimer = setInterval(async () => {
      const round = roundRef.current
      if (!round) {
        const r = await getOrCreateCurrentRocketRound()
        applyRoundUpdate(r)
        return
      }
      const holdUntil = new Date(round.hold_until).getTime()
      const serverNow = Date.now() + clockOffsetRef.current
      if (serverNow > holdUntil + 5000) {
        const next = await getOrCreateCurrentRocketRound()
        applyRoundUpdate(next)
      }
    }, BACKSTOP_POLL_MS)

    return () => {
      if (frameTimer)     clearInterval(frameTimer)
      if (nextRoundTimer) clearTimeout(nextRoundTimer)
      if (backstopTimer)  clearInterval(backstopTimer)
      if (channel)        channel.unsubscribe()
    }
  }, [isDev])

  // Dev cash-out — credits balance locally, no RPC.
  function performCashOutDev(atMul) {
    if (!betRef.current || cashedAtRef.current !== null) return
    const win = Math.round(betRef.current.stake * atMul)
    cashedAtRef.current = atMul
    setCashedAt(atMul); setCashedWin(win)
    setBalance(balanceRef.current + win); balanceRef.current = balanceRef.current + win
    setBalanceBounce(true); setTimeout(() => setBalanceBounce(false), 600)
    haptic('success')
  }

  // Server cash-out — RPC validates against its own clock and credits.
  async function performCashOutServer(atMul) {
    if (!betRef.current || cashedAtRef.current !== null) return
    if (cashingOutRef.current) return
    cashingOutRef.current = true
    haptic('success')
    const r = await cashoutRocketBet(betRef.current.id, atMul)
    cashingOutRef.current = false
    if (!r || r.error) return
    cashedAtRef.current = Number(r.cashed_at_mul)
    setCashedAt(Number(r.cashed_at_mul))
    setCashedWin(Number(r.payout) || 0)
    if (typeof r.balance === 'number') {
      setBalance(r.balance); balanceRef.current = r.balance
      setBalanceBounce(true); setTimeout(() => setBalanceBounce(false), 600)
    }
  }

  async function placeBet() {
    if (phase !== 'betting' || bet || balance < stake) return
    haptic('medium')
    if (isDev) {
      const newBet = { stake }
      setBet(newBet); betRef.current = newBet
      setBalance(balance - stake); balanceRef.current = balance - stake
      return
    }
    const round = roundRef.current
    if (!round) return
    const r = await placeRocketBet(user.id, round.id, stake, autoCash)
    if (!r || r.error) return
    const newBet = { id: r.bet_id, stake }
    setBet(newBet); betRef.current = newBet
    if (typeof r.balance === 'number') {
      setBalance(r.balance); balanceRef.current = r.balance
    }
  }

  function manualCashOut() {
    if (phase !== 'flying' || !bet || cashedAt !== null) return
    if (isDev) performCashOutDev(multiplier)
    else      performCashOutServer(multiplier)
  }

  function changeStake(direction) {
    if (bet) return
    const nextIndex = Math.max(0, Math.min(BETS.length - 1, stakeIndex + direction))
    if (nextIndex === stakeIndex) return
    if (direction > 0 && BETS[nextIndex] > balance) return
    haptic('light')
    setStake(BETS[nextIndex])
  }

  // ── Visualisation: SVG curve + rocket position ──
  // Sample the exponential growth curve from t=0 to t=now along the same
  // (rx, ry) projection rocketPosForM uses, so curve and rocket always
  // share an endpoint.
  //
  // Computed inline on EVERY render (no useMemo). With useMemo we hit
  // a subtle React-18 batching issue: while a bet is on the table the
  // CTA also re-renders with the live multiplier, and its render slips
  // into a different commit than the curve's, leaving the memo'd path
  // stuck at whatever multiplier value was current the previous tick.
  // 32 samples × a few floats per sample = microseconds; cheaper than
  // the bug.
  let pathData = ''
  if (phase === 'flying' || phase === 'crashed') {
    const targetM = phase === 'crashed' ? (crashedAt ?? 1) : multiplier
    if (targetM > 1.001) {
      const tEnd = Math.log(targetM) / Math.log(GROWTH_BASE)
      const SAMPLES = 32
      for (let i = 0; i <= SAMPLES; i++) {
        const t = (i / SAMPLES) * tEnd
        const m = Math.pow(GROWTH_BASE, t)
        const { rx, ry } = rocketPosForM(m)
        pathData += (i === 0 ? 'M ' : ' L ') + rx.toFixed(2) + ' ' + ry.toFixed(2)
      }
    }
  }

  const rocketPos = phase === 'flying'
    ? rocketPosForM(multiplier)
    : phase === 'crashed'
      ? rocketPosForM(crashedAt ?? 1)
      : { rx: 6, ry: 90 }

  // ── UI: main CTA changes per phase + bet state ──
  const stakeUpDisabled = !!bet || stakeIndex >= BETS.length - 1 || (BETS[stakeIndex + 1] !== undefined && BETS[stakeIndex + 1] > balance)
  const stakeDownDisabled = !!bet || stakeIndex <= 0
  const bettingSecondsLeft = Math.ceil(bettingTimeLeft / 1000)

  let mainButton
  if (phase === 'flying' && bet && cashedAt === null) {
    const potential = Math.round(bet.stake * multiplier)
    mainButton = (
      <button className="rocket-cta rocket-cta--cash" type="button" onClick={manualCashOut}>
        <span className="rocket-cta-title">{t.slotRocketCashout} {fmtMul(multiplier)}</span>
        <span className="rocket-cta-sub">+{formatCurrency(potential, currency, rates)}</span>
      </button>
    )
  } else if (phase === 'betting' && bet) {
    // Aviator-style: bets cannot be cancelled once placed.
    mainButton = (
      <button className="rocket-cta rocket-cta--placed" type="button" disabled>
        <span className="rocket-cta-title">{t.slotRocketBetPlaced}</span>
        <span className="rocket-cta-sub">{formatCurrency(bet.stake, currency, rates)} · {bettingSecondsLeft}s</span>
      </button>
    )
  } else if (phase === 'betting') {
    const disabled = balance < stake
    mainButton = (
      <button
        className="rocket-cta rocket-cta--bet"
        type="button"
        onClick={placeBet}
        disabled={disabled}
      >
        <span className="rocket-cta-title">{t.slotRocketBet}</span>
        <span className="rocket-cta-sub">
          {formatCurrency(stake, currency, rates)} · {bettingSecondsLeft}s
        </span>
      </button>
    )
  } else if (phase === 'flying' && cashedAt !== null) {
    mainButton = (
      <button className="rocket-cta rocket-cta--cashed" type="button" disabled>
        <span className="rocket-cta-title">{t.slotRocketCashed} {fmtMul(cashedAt)}</span>
        <span className="rocket-cta-sub">+{formatCurrency(cashedWin, currency, rates)}</span>
      </button>
    )
  } else {
    mainButton = (
      <button className="rocket-cta rocket-cta--idle" type="button" disabled>
        <span className="rocket-cta-title">{t.slotRocketNextRound}</span>
        <span className="rocket-cta-sub">…</span>
      </button>
    )
  }

  function toggleAutoCash(value) {
    haptic('light')
    setAutoCash(prev => (prev === value ? null : value))
  }

  // Auto-scroll history to its right edge whenever a new chip arrives,
  // so the most recent multiplier is always in view.
  const historyRef = useRef(null)
  useEffect(() => {
    const el = historyRef.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [history.length])

  return (
    <div className={`rocket-slot-page rocket-slot-page--${phase}`}>
     <div className="rocket-game-window">
      {/* History strip */}
      <div className="rocket-history" ref={historyRef} aria-label={t.slotRocketHistory}>
        {history.length === 0 ? (
          <span className="rocket-history-empty">{t.slotRocketHistory}</span>
        ) : (
          history.map((m, i) => (
            <span key={i} className={`rocket-chip ${colorClassFor(m)}`}>
              {fmtMul(m)}
            </span>
          ))
        )}
      </div>

      {/* Stage */}
      <main className="rocket-stage" aria-live="polite">
        <div className="rocket-sky" aria-hidden="true">
          <span className="rocket-star rocket-star--a" />
          <span className="rocket-star rocket-star--b" />
          <span className="rocket-star rocket-star--c" />
          <span className="rocket-star rocket-star--d" />
          <span className="rocket-star rocket-star--e" />
          <span className="rocket-star rocket-star--f" />
          <span className="rocket-star rocket-star--g" />
          <span className="rocket-star rocket-star--h" />
          <span className="rocket-cloud rocket-cloud--one" />
          <span className="rocket-cloud rocket-cloud--two" />
          <span className="rocket-cloud rocket-cloud--three" />
          <span className="rocket-grid" />
        </div>

        <svg className="rocket-curve" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id="rocket-curve-stroke" x1="0" y1="1" x2="1" y2="0">
              <stop offset="0%" stopColor="#fb7185" />
              <stop offset="100%" stopColor="#fde68a" />
            </linearGradient>
          </defs>
          {pathData && (
            <path
              d={pathData}
              stroke="url(#rocket-curve-stroke)"
              strokeWidth="0.9"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
              vectorEffect="non-scaling-stroke"
              opacity={phase === 'crashed' ? 0.55 : 1}
            />
          )}
        </svg>

        {/* Rocket */}
        <div
          className="rocket-icon"
          style={{ left: `${rocketPos.rx}%`, top: `${rocketPos.ry}%` }}
          aria-hidden="true"
        >
          <span className="rocket-flame" />
          <span className="rocket-flame rocket-flame--inner" />
          <svg viewBox="0 0 28 40" width="44" height="62">
            <defs>
              <linearGradient id="rkt-body" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#fef3c7" />
                <stop offset="100%" stopColor="#fb7185" />
              </linearGradient>
            </defs>
            {/* Body */}
            <path d="M14 1.5 C20 7 22 14 22 22 L22 30 L6 30 L6 22 C6 14 8 7 14 1.5 Z"
                  fill="url(#rkt-body)" stroke="#9f1239" strokeWidth="1.1" />
            {/* Window */}
            <circle cx="14" cy="15" r="3.4" fill="#0ea5e9" stroke="#082f49" strokeWidth="1" />
            <circle cx="13" cy="14" r="1" fill="#bae6fd" opacity="0.9" />
            {/* Fins */}
            <path d="M6 25 L1 33 L6 31 Z" fill="#fb7185" stroke="#9f1239" strokeWidth="0.8" />
            <path d="M22 25 L27 33 L22 31 Z" fill="#fb7185" stroke="#9f1239" strokeWidth="0.8" />
            {/* Bottom band */}
            <rect x="6" y="28" width="16" height="2.4" fill="#9f1239" />
          </svg>
        </div>

        {/* Centre HUD */}
        <div className={`rocket-hud rocket-hud--${phase}`}>
          {phase === 'betting' ? (
            <>
              <span className="rocket-hud-label">{t.slotRocketWaiting}</span>
              <span className="rocket-hud-time">{bettingSecondsLeft}s</span>
              <span className="rocket-hud-bar">
                <span
                  className="rocket-hud-bar-fill"
                  style={{ width: `${(bettingTimeLeft / BETTING_DURATION_MS) * 100}%` }}
                />
              </span>
            </>
          ) : phase === 'flying' ? (
            <>
              <span className="rocket-hud-mul rocket-hud-mul--live">{fmtMul(multiplier)}</span>
              <span className="rocket-hud-label">{t.slotRocketFlying}</span>
            </>
          ) : (
            <>
              <span className="rocket-hud-mul rocket-hud-mul--crashed">{fmtMul(crashedAt ?? 1)}</span>
              <span className="rocket-hud-label rocket-hud-label--crashed">{t.slotRocketCrashed}</span>
            </>
          )}
          {cashedAt !== null && phase !== 'betting' && (
            <span className="rocket-hud-cashed">
              ✓ {fmtMul(cashedAt)} · +{formatCurrency(cashedWin, currency, rates)}
            </span>
          )}
        </div>
      </main>

      {/* Controls */}
      <section className="rocket-controls">
        <div className="rocket-controls-row">
          <div className="rocket-info-card rocket-info-card--stake">
            <span className="rocket-info-label">{t.slotTotalBet}</span>
            <strong className="rocket-info-value">{formatCurrency(stake, currency, rates)}</strong>
            <div className="rocket-stake-buttons">
              <button type="button" onClick={() => changeStake(1)} disabled={stakeUpDisabled} aria-label="Increase">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path d="M7 14l5-5 5 5" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <button type="button" onClick={() => changeStake(-1)} disabled={stakeDownDisabled} aria-label="Decrease">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path d="M7 10l5 5 5-5" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
          </div>

          <div className="rocket-info-card rocket-info-card--balance">
            <span className="rocket-info-label">{t.balance || 'Balance'}</span>
            <strong className="rocket-info-value">{formatCurrency(balance, currency, rates)}</strong>
          </div>
        </div>

        {mainButton}

        <div className="rocket-auto">
          <span className="rocket-auto-label">{t.slotRocketAutoCash}</span>
          <div className="rocket-auto-chips" role="radiogroup">
            {AUTO_CASH_OPTIONS.map(value => {
              const active = autoCash === value
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  className={`rocket-auto-chip ${active ? 'is-active' : ''}`}
                  onClick={() => toggleAutoCash(value)}
                >
                  ×{value}
                </button>
              )
            })}
          </div>
        </div>
      </section>
     </div>

      {exitConfirm && (
        <div className="rocket-exit-backdrop" onClick={() => { haptic('light'); setExitConfirm(false) }}>
          <div className="rocket-exit-card" onClick={e => e.stopPropagation()}>
            <h3>{t.slotExitTitle}</h3>
            <p>{t.slotExitText}</p>
            <div className="rocket-exit-actions">
              <button type="button" onClick={() => { haptic('light'); setExitConfirm(false) }}>
                {t.slotExitStay}
              </button>
              <button type="button" onClick={() => { haptic('medium'); setExitConfirm(false); navigate('/') }}>
                {t.slotExitLeave}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
