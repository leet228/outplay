import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useShallow } from 'zustand/react/shallow'
import useGameStore from '../store/useGameStore'
import { translations } from '../lib/i18n'
import { formatCurrency } from '../lib/currency'
import { haptic } from '../lib/telegram'
import './DiceSlot.css'

// ─────────────────────────────────────────────────────────────
// DICE — classic crypto-casino dice game.
//
//   - 0..100 roll (server-driven RNG once wired up)
//   - Player chooses TARGET threshold (1..99) and MODE (above/below)
//   - Win chance = above ? (100-target) : target  (in percent)
//   - Multiplier = (100 - HOUSE_EDGE%) / chance%
//   - Live update of multiplier + win chance as the slider moves
//
// This file ships the full UI shell with a LOCAL stub for the roll
// itself — server RPC + RTP enforcement come next once the design
// brief lands.
// ─────────────────────────────────────────────────────────────

const BETS = [10, 25, 50, 100, 250, 500, 1000, 2000, 4000, 8000, 16000, 25000]
const SLOT_ID = 'dice'

// House edge in percent. 3 % → RTP 97 %. Tune via server later.
const HOUSE_EDGE = 3

// Threshold bounds — keep at least 1 % chance on either side so the
// multiplier never overflows and the slider can't get stuck at 0/100.
const MIN_TARGET = 1
const MAX_TARGET = 99

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)) }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// Win chance (in percent, 0..100) for the current target + mode.
function chanceFor(target, mode) {
  const t = clamp(target, MIN_TARGET, MAX_TARGET)
  return mode === 'above' ? 100 - t : t
}

// Payout multiplier on a win. HOUSE_EDGE is taken off the gross 100 %
// before dividing by chance, so RTP across many spins approaches
// (100 - HOUSE_EDGE) %.
function multiplierFor(target, mode) {
  const c = chanceFor(target, mode)
  if (c <= 0) return 0
  return (100 - HOUSE_EDGE) / c
}

// Local stub for the roll — uniform integer in [1, 100]. Will be
// replaced by a server RPC that returns a signed roll value.
function localRoll() {
  return Math.floor(Math.random() * 100) + 1
}

export default function DiceSlot() {
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

  // ── Settings ──
  const [stake, setStake]     = useState(BETS[0])
  const [target, setTarget]   = useState(50)
  const [mode, setMode]       = useState('above')  // 'above' | 'below'

  // ── Round state ──
  const [history, setHistory] = useState([])       // [{ id, roll, win }, ...]
  const [lastRoll, setLastRoll] = useState(null)   // { value, win } | null
  const [rolling, setRolling] = useState(false)
  const [lastWin, setLastWin] = useState(0)
  const [exitConfirm, setExitConfirm] = useState(false)

  // Refs for stable async access.
  const balanceRef = useRef(balance)
  const stakeRef   = useRef(stake)
  const targetRef  = useRef(target)
  const modeRef    = useRef(mode)
  const rollingRef = useRef(false)
  const cancelRef  = useRef(false)

  useEffect(() => { balanceRef.current = balance }, [balance])
  useEffect(() => { stakeRef.current   = stake },   [stake])
  useEffect(() => { targetRef.current  = target },  [target])
  useEffect(() => { modeRef.current    = mode },    [mode])
  useEffect(() => () => { cancelRef.current = true }, [])

  // ── Telegram BackButton ──
  useEffect(() => {
    const tg = window.Telegram?.WebApp
    if (!tg) return
    tg.BackButton.show()
    const back = () => {
      haptic('light')
      if (rolling) setExitConfirm(true)
      else navigate('/')
    }
    tg.BackButton.onClick(back)
    return () => { tg.BackButton.offClick(back); tg.BackButton.hide() }
  }, [navigate, rolling])

  function confirmExit() {
    haptic('medium')
    cancelRef.current = true
    setExitConfirm(false)
    navigate('/')
  }

  const stakeIndex = BETS.indexOf(stake)
  const chance     = chanceFor(target, mode)
  const mult       = multiplierFor(target, mode)
  const canAfford  = balance >= stake

  function changeStake(dir) {
    if (rollingRef.current) return
    const i = stakeIndex + dir
    if (i < 0 || i >= BETS.length) return
    if (dir > 0 && BETS[i] > balance) return
    haptic('light')
    setStake(BETS[i])
  }

  function setTargetClamped(value) {
    const v = clamp(Math.round(value), MIN_TARGET, MAX_TARGET)
    setTarget(v)
  }

  function toggleMode() {
    if (rollingRef.current) return
    haptic('light')
    setMode(m => (m === 'above' ? 'below' : 'above'))
  }

  // ── One roll ──
  // Currently local-only (uniform 1..100). Wire to a server RPC
  // (start_dice_round / finish_dice_round) once the RTP-target spec
  // is locked.
  async function roll() {
    if (rollingRef.current) return
    if (!canAfford) return
    rollingRef.current = true
    setRolling(true)
    haptic('light')

    // Optimistic debit.
    const debited = balanceRef.current - stakeRef.current
    balanceRef.current = debited
    setBalance(debited)

    // Decide outcome.
    const value = localRoll()
    const isWin = modeRef.current === 'above'
      ? value > targetRef.current
      : value < targetRef.current
    const payout = isWin
      ? Math.round(stakeRef.current * multiplierFor(targetRef.current, modeRef.current))
      : 0

    // Drive the cube animation.
    setLastRoll({ value, win: isWin })

    // Hold for animation, then settle.
    await sleep(750)
    if (cancelRef.current) return

    if (payout > 0) {
      const next = balanceRef.current + payout
      balanceRef.current = next
      setBalance(next)
      if (typeof setBalanceBounce === 'function') {
        setBalanceBounce(true)
        setTimeout(() => setBalanceBounce(false), 540)
      }
      setLastWin(payout)
      haptic('success')
    } else {
      setLastWin(0)
    }

    // Push to history (newest first, cap 10 — fewer pills means each
    // one is wider, which is what the reference design calls for).
    setHistory(prev => [
      { id: Date.now() + Math.random(), roll: value, win: isWin },
      ...prev,
    ].slice(0, 10))

    rollingRef.current = false
    setRolling(false)
  }

  const stakeUpDisabled   = rolling || stakeIndex >= BETS.length - 1 ||
                            (BETS[stakeIndex + 1] !== undefined && BETS[stakeIndex + 1] > balance)
  const stakeDownDisabled = rolling || stakeIndex <= 0
  const winLabel = lastWin > 0 ? `+${formatCurrency(lastWin, currency, rates)}` : null

  return (
    <div className="dice-slot-page">
      <div className="dice-game-window">
        <main className="dice-stage" aria-label="Dice">
          <div className="dice-bg" />

          {/* ── History row ──
              Last N rolls, newest first. Green pill = win, gray = loss.
              Padded with placeholder pills so the row's visual width is
              stable from spin 1 onward. */}
          <div className="dice-history" aria-hidden="true">
            {Array.from({ length: 10 }, (_, i) => {
              const h = history[i]
              if (!h) {
                return <span key={`empty-${i}`} className="dice-history-pill is-empty" />
              }
              return (
                <span
                  key={h.id}
                  className={`dice-history-pill ${h.win ? 'is-win' : 'is-loss'}`}
                >
                  {h.roll}
                </span>
              )
            })}
          </div>

          {/* ── Slider area ──
              Scale labels above, the red/green bar with draggable handle
              and result cube in the middle. */}
          <div className="dice-slider-area">
            <div className="dice-scale" aria-hidden="true">
              <span>0</span>
              <span>25</span>
              <span>50</span>
              <span>75</span>
              <span>100</span>
            </div>

            <DiceBar
              target={target}
              mode={mode}
              lastRoll={lastRoll}
              disabled={rolling}
              onChangeTarget={setTargetClamped}
            />
          </div>
        </main>

        {/* ── HUD: multiplier / target & mode toggle / win chance ── */}
        <div className="dice-hud">
          <div className="dice-hud-box">
            <span className="dice-hud-label">{t.diceMultiplier}</span>
            <strong className="dice-hud-value">{mult.toFixed(2)}×</strong>
          </div>
          <div className="dice-hud-box dice-hud-box--center">
            <div className="dice-hud-target">
              <span className="dice-hud-label">
                {mode === 'above' ? t.diceRollAbove : t.diceRollBelow}
              </span>
              <strong className="dice-hud-value">{target}</strong>
            </div>
            <button
              type="button"
              className="dice-mode-toggle"
              onClick={toggleMode}
              disabled={rolling}
              aria-label={mode === 'above' ? t.diceModeBelow : t.diceModeAbove}
            >
              {mode === 'above' ? t.diceModeBelow : t.diceModeAbove}
            </button>
          </div>
          <div className="dice-hud-box">
            <span className="dice-hud-label">{t.diceWinChance}</span>
            <strong className="dice-hud-value">{chance.toFixed(2)}%</strong>
          </div>
        </div>

        {/* ── Last-win banner ── */}
        <div className={`dice-winbar ${lastWin > 0 ? 'is-win' : ''}`}>
          <span className="dice-winbar-label">{t.slotPotential}</span>
          <strong className="dice-winbar-value">
            {winLabel ?? formatCurrency(0, currency, rates)}
          </strong>
        </div>

        {/* ── Bottom controls: balance / roll / stake ── */}
        <section className="dice-controls">
          <div className="dice-balance">
            <span>{t.balance || 'Balance'}</span>
            <strong>{formatCurrency(balance, currency, rates)}</strong>
          </div>

          <div className="dice-center">
            <button
              type="button"
              className="dice-roll-btn"
              onClick={roll}
              disabled={!canAfford || rolling}
              aria-label={t.diceRoll}
            >
              <DiceIcon />
            </button>
          </div>

          <div className="dice-stake-block">
            <div className="dice-stake-row">
              <button
                type="button"
                className="dice-stake-step"
                onClick={() => changeStake(-1)}
                disabled={stakeDownDisabled}
                aria-label="stake down"
              >−</button>
              <div className="dice-stake">
                <span>{t.slotBet}</span>
                <strong>{formatCurrency(stake, currency, rates)}</strong>
              </div>
              <button
                type="button"
                className="dice-stake-step"
                onClick={() => changeStake(1)}
                disabled={stakeUpDisabled}
                aria-label="stake up"
              >+</button>
            </div>
          </div>
        </section>
      </div>

      {exitConfirm && (
        <div className="dice-exit-backdrop">
          <div className="dice-exit-card">
            <h3>{t.slotExitTitle}</h3>
            <p>{t.slotExitText}</p>
            <div className="dice-exit-actions">
              <button type="button" onClick={() => { haptic('light'); setExitConfirm(false) }}>
                {t.slotExitStay}
              </button>
              <button type="button" onClick={confirmExit}>{t.slotExitLeave}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// DiceBar — the slider + the result cube. Tracks pointer/touch
// drag and rerports the new target percentage to the parent.
// ─────────────────────────────────────────────────────────────
function DiceBar({ target, mode, lastRoll, disabled, onChangeTarget }) {
  const barRef = useRef(null)
  const draggingRef = useRef(false)
  // Tracks the last integer value reported so we can fire a haptic
  // "tick" exactly once per integer crossing while the player drags
  // (gives the slider a notched / ratcheting feel instead of a
  // smooth glide). Defaults to a sentinel that never equals a real
  // value so the first drag move always emits one tick.
  const lastTickRef = useRef(NaN)

  const handleMove = useCallback((clientX) => {
    const el = barRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const pct = ((clientX - rect.left) / rect.width) * 100
    // Quantise to integer so the slider snaps to whole-number
    // targets, then report. If the integer changed since the last
    // tick, also fire a light haptic — that's the "click per step"
    // feel the design calls for.
    const integerPct = Math.max(0, Math.min(100, Math.round(pct)))
    if (integerPct !== lastTickRef.current) {
      lastTickRef.current = integerPct
      haptic('light')
    }
    onChangeTarget(integerPct)
  }, [onChangeTarget])

  function onPointerDown(e) {
    if (disabled) return
    draggingRef.current = true
    // Reset the tick tracker so the initial jump on press also
    // emits a haptic if it lands on a different integer.
    lastTickRef.current = NaN
    const x = e.touches ? e.touches[0].clientX : e.clientX
    handleMove(x)
  }

  useEffect(() => {
    function onMove(e) {
      if (!draggingRef.current) return
      const x = e.touches ? e.touches[0].clientX : e.clientX
      handleMove(x)
    }
    function onUp() {
      draggingRef.current = false
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('touchmove', onMove, { passive: true })
    window.addEventListener('mouseup', onUp)
    window.addEventListener('touchend', onUp)
    window.addEventListener('touchcancel', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('touchend', onUp)
      window.removeEventListener('touchcancel', onUp)
    }
  }, [handleMove])

  // Red zone = loss zone; green zone = win zone. In ABOVE mode the
  // win zone is to the RIGHT of the handle (roll > target wins). In
  // BELOW mode it's to the LEFT.
  const redLeftPct  = mode === 'above' ? 0 : target
  const redRightPct = mode === 'above' ? target : 100
  const greenLeftPct  = mode === 'above' ? target : 0
  const greenRightPct = mode === 'above' ? 100 : target

  return (
    <div
      ref={barRef}
      className={`dice-bar ${disabled ? 'is-disabled' : ''}`}
      onMouseDown={onPointerDown}
      onTouchStart={onPointerDown}
    >
      <div
        className="dice-bar-red"
        style={{ left: `${redLeftPct}%`, right: `${100 - redRightPct}%` }}
      />
      <div
        className="dice-bar-green"
        style={{ left: `${greenLeftPct}%`, right: `${100 - greenRightPct}%` }}
      />

      {/* Result cube — sits at the rolled value's position on the
          bar. Animates when the new value lands. */}
      {lastRoll && (
        <div
          key={lastRoll.value + '-' + (lastRoll.win ? 'w' : 'l')}
          className={`dice-cube ${lastRoll.win ? 'is-win' : 'is-loss'}`}
          style={{ left: `${lastRoll.value}%` }}
        >
          <span>{lastRoll.value}</span>
        </div>
      )}

      {/* Draggable threshold handle — three vertical grip lines
       * inside a white pill. No CSS transition: the handle JUMPS
       * between integer positions for the ratchet/tick feel. */}
      <div
        className="dice-handle"
        style={{ left: `${target}%` }}
        role="slider"
        aria-valuemin={MIN_TARGET}
        aria-valuemax={MAX_TARGET}
        aria-valuenow={target}
      >
        <span className="dice-handle-grip" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
      </div>
    </div>
  )
}

function DiceIcon() {
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="3" stroke="currentColor" strokeWidth="2" />
      <circle cx="8" cy="8" r="1.4" fill="currentColor" />
      <circle cx="16" cy="8" r="1.4" fill="currentColor" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" />
      <circle cx="8" cy="16" r="1.4" fill="currentColor" />
      <circle cx="16" cy="16" r="1.4" fill="currentColor" />
    </svg>
  )
}
