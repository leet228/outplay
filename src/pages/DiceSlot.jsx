import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useShallow } from 'zustand/react/shallow'
import useGameStore from '../store/useGameStore'
import { translations } from '../lib/i18n'
import { formatCurrency } from '../lib/currency'
import { haptic } from '../lib/telegram'
import { startDiceRound, finishDiceRound } from '../lib/supabase'
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

// House edge in percent. 2.9 % → RTP 97.1 %.
const HOUSE_EDGE = 2.9

// Chance curve — exponential decay across the slider's reach.
//   distance = 0  (above 0   / below 100) → chance = C_HIGH
//   distance = 99 (above 99  / below 1  ) → chance = C_LOW
// These two pin-points give: above 0  → 88.27 % chance / 1.10× mult,
//                            above 99 → 0.000971 % / 100 000× mult,
// and the below-mode mirror lines up the same way. The mid-range
// drops off sharply (high volatility, classic crypto-dice feel).
const CHANCE_HIGH = 88.27
const CHANCE_LOW  = 0.000971
const CHANCE_K    = Math.log(CHANCE_HIGH / CHANCE_LOW) / 99   // ≈ 0.1153

// Threshold bounds — mode-specific so the math stays symmetric
// when the player toggles ABOVE ↔ BELOW.
//   ABOVE mode:  target ∈ [0  .. 99]  (above 0 = always win, above
//                                     99 = 1 % chance / max mult)
//   BELOW mode:  target ∈ [1  .. 100] (below 100 = always win,
//                                     below 1  = 1 % chance / max
//                                     mult)
// Both ranges have the same SPAN (99 units), so the visual mapping
// width below stays identical between modes.
const BOUNDS = {
  above: { min: 0, max: 99  },
  below: { min: 1, max: 100 },
}
function boundsFor(mode) {
  return BOUNDS[mode] || BOUNDS.above
}

// Visual mapping. The slider's PHYSICAL handle range inside
// .dice-bar-inner runs from RANGE_PAD_PCT to (100 - RANGE_PAD_PCT)
// of the inner-wrapper width. We linearly map the logical target
// [min..max] (per the active mode) across that physical range, so:
//   target = min → handle at RANGE_PAD_PCT %
//   target = max → handle at (100 - RANGE_PAD_PCT) %
// The areas OUTSIDE the physical range act as "tails": the
// coloured bars always extend through them so the player sees a
// sliver of the extreme zone even at the extreme target.
const RANGE_PAD_PCT = 14
const RANGE_SPAN_PCT = 100 - 2 * RANGE_PAD_PCT  // 72

// Logical target → visual % position of the inner-wrapper.
function targetToVisualPct(t, mode) {
  const { min, max } = boundsFor(mode)
  const span = max - min
  const clamped = clamp(t, min, max)
  return RANGE_PAD_PCT + ((clamped - min) / span) * RANGE_SPAN_PCT
}

// Visual % position [0..100] → logical target, clamped.
function visualPctToTarget(p, mode) {
  const { min, max } = boundsFor(mode)
  const span = max - min
  return clamp(
    min + ((p - RANGE_PAD_PCT) / RANGE_SPAN_PCT) * span,
    min,
    max,
  )
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)) }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// Win chance (in percent, 0..100) for the current target + mode.
//
// The "distance" from the always-wins extreme drives the decay:
//   above mode: 0 = always-wins extreme, 99 = max-risk extreme
//                  → distance = target
//   below mode: 100 = always-wins extreme, 1 = max-risk extreme
//                  → distance = (100 - target)
// Chance follows an exponential decay pinned to CHANCE_HIGH at
// distance 0 and CHANCE_LOW at distance 99.
function chanceFor(target, mode) {
  const { min, max } = boundsFor(mode)
  const clamped = clamp(target, min, max)
  const distance = mode === 'above' ? clamped : (max - clamped)
  return CHANCE_HIGH * Math.exp(-CHANCE_K * distance)
}

// Payout multiplier on a win. HOUSE_EDGE is taken off the gross 100 %
// before dividing by chance, so RTP across many spins approaches
// (100 - HOUSE_EDGE) %.
function multiplierFor(target, mode) {
  const c = chanceFor(target, mode)
  if (c <= 0) return 0
  return (100 - HOUSE_EDGE) / c
}

// Local stub roll — picks a win/loss FIRST using the exponential
// chance curve (so the actual win rate matches the chance the
// player sees on the HUD), then synthesises a display value that
// agrees with the outcome:
//   above mode + win  → uniform in [target + 1, 100]
//   above mode + loss → uniform in [0, target]
//   below mode + win  → uniform in [0, target - 1]
//   below mode + loss → uniform in [target, 100]
// Will be replaced by a server RPC once the dice round is wired
// up. Returns { value, isWin }.
//
// `deficit` flag (from server's start_dice_round.deficit_active)
// forces the outcome to a LOSS so the displayed value falls on
// the losing side of the player's threshold. The roll still
// looks honest — just always against the bet — until the house
// recovers from deficit.
function localRoll(target, mode, deficit = false) {
  const chance = chanceFor(target, mode)
  const isWin = deficit ? false : (Math.random() * 100 < chance)
  let value
  if (mode === 'above') {
    if (isWin) {
      const span = 100 - target               // size of win range
      value = target + 1 + Math.floor(Math.random() * span)
    } else {
      value = Math.floor(Math.random() * (target + 1))
    }
  } else {
    if (isWin) {
      value = Math.floor(Math.random() * target)
    } else {
      const span = 101 - target
      value = target + Math.floor(Math.random() * span)
    }
  }
  return { value, isWin }
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
  // Cube state — drives the multi-stage reveal animation:
  //   1. Cube parks at last-roll position (or centre 50 on first spin)
  //      with the old value, coloured GRAY.
  //   2. Slides to the new roll's visual position.
  //   3. On arrival the value + colour swap to the new result and a
  //      bounce scale plays.
  //   4. After ~3 s of hold the cube fades out.
  //   5. If another roll fires before the fade completes, the cube
  //      grays the number immediately and slides off to the new
  //      position — landing with the new value/colour.
  const [cube, setCube] = useState(null)           // see startCubeReveal()
  const [rolling, setRolling] = useState(false)
  const [lastWin, setLastWin] = useState(0)
  const [autoSpin, setAutoSpin] = useState(false)
  const [exitConfirm, setExitConfirm] = useState(false)

  // Refs for stable async access.
  const balanceRef       = useRef(balance)
  const stakeRef         = useRef(stake)
  const targetRef        = useRef(target)
  const modeRef          = useRef(mode)
  const rollingRef       = useRef(false)
  const autoRef          = useRef(false)
  const cancelRef        = useRef(false)
  const finalizingRef    = useRef(false)
  const currentRoundRef  = useRef(null)
  // Mirror of `cube` state for synchronous reads from the reveal
  // orchestrator (so consecutive fast rolls can chain off the
  // previous cube's last position even before the next render).
  const cubeRef    = useRef(null)
  // Timeouts driving the cube animation pipeline — cleared on
  // every new roll so the stages don't double-fire.
  const cubeTimersRef = useRef([])

  useEffect(() => { balanceRef.current = balance }, [balance])
  useEffect(() => { stakeRef.current   = stake },   [stake])
  useEffect(() => { targetRef.current  = target },  [target])
  useEffect(() => { modeRef.current    = mode },    [mode])
  useEffect(() => { autoRef.current    = autoSpin }, [autoSpin])
  useEffect(() => { cubeRef.current    = cube },    [cube])
  useEffect(() => () => {
    cancelRef.current = true
    cubeTimersRef.current.forEach(clearTimeout)
    cubeTimersRef.current = []
  }, [])

  // ── Telegram BackButton ──
  useEffect(() => {
    const tg = window.Telegram?.WebApp
    if (!tg) return
    tg.BackButton.show()
    const back = () => {
      haptic('light')
      if (rolling || autoSpin) setExitConfirm(true)
      else navigate('/')
    }
    tg.BackButton.onClick(back)
    return () => { tg.BackButton.offClick(back); tg.BackButton.hide() }
  }, [navigate, rolling, autoSpin])

  function confirmExit() {
    haptic('medium')
    cancelRef.current = true
    setAutoSpin(false); autoRef.current = false
    setExitConfirm(false)
    navigate('/')
  }

  const stakeIndex = BETS.indexOf(stake)
  const chance     = chanceFor(target, mode)
  const mult       = multiplierFor(target, mode)
  const canAfford  = balance >= stake

  function changeStake(dir) {
    if (rollingRef.current || autoRef.current) return
    const i = stakeIndex + dir
    if (i < 0 || i >= BETS.length) return
    if (dir > 0 && BETS[i] > balance) return
    haptic('light')
    setStake(BETS[i])
  }

  function setTargetClamped(value) {
    if (autoRef.current) return
    const { min, max } = boundsFor(modeRef.current)
    const v = clamp(Math.round(value), min, max)
    setTarget(v)
  }

  function toggleMode() {
    if (rollingRef.current || autoRef.current) return
    haptic('light')
    setMode(m => (m === 'above' ? 'below' : 'above'))
    // Mirror the target so it lands at the symmetric chance in the
    // new mode: above T  ↔  below (100 - T).
    //   above 0  (100 % chance) ↔ below 100 (100 % chance)
    //   above 99 (1 %   chance) ↔ below 1   (1 %   chance)
    setTarget(t => 100 - t)
  }

  // ── Cube reveal animation ──
  // Orchestrates the four-stage flow described above. Fire-and-
  // forget — callers (the roll fn) hand off a fresh roll value
  // + win flag, the function manages every state transition + the
  // timers driving them.
  const CUBE_SLIDE_MS = 380
  const CUBE_BOUNCE_MS = 250
  const CUBE_HOLD_MS = 3000
  const CUBE_FADE_MS = 500

  function startCubeReveal(rollValue, isWin) {
    // Cancel any in-flight stages from a previous roll.
    cubeTimersRef.current.forEach(clearTimeout)
    cubeTimersRef.current = []

    // Where the cube starts from this roll:
    //   - centre 50 with "50" ONLY for the very first roll (no
    //     prior cube state has been recorded yet).
    //   - every subsequent roll picks up from the LAST result's
    //     position + value, whether the cube is still on screen
    //     mid-fade or has already faded out and been hidden.
    const prev = cubeRef.current
    const startPct   = prev ? prev.visualPct : 50
    const startValue = prev ? prev.value     : 50

    const endPct = targetToVisualPct(rollValue, 'above')

    // Stage 1 — render at start position, gray number, old value.
    setCube({
      visible:    true,
      visualPct:  startPct,
      value:      startValue,
      color:      'gray',
      scaling:    false,
      fading:     false,
    })

    // Stage 2 — let React paint the start state, then move to the
    // target visualPct so the CSS transition slides the cube.
    cubeTimersRef.current.push(setTimeout(() => {
      setCube(s => s ? { ...s, visualPct: endPct } : s)
    }, 30))

    // Stage 3 — at slide-end, swap to the new value + colour, fire
    // the bounce scale animation, AND immediately push the result
    // into the history ribbon. Doing it here (instead of from
    // roll() after its 750 ms hold) keeps the pill flash in lock-
    // step with the cube's land bounce — no perceptible delay.
    cubeTimersRef.current.push(setTimeout(() => {
      setCube(s => s ? {
        ...s,
        value:   rollValue,
        color:   isWin ? 'win' : 'loss',
        scaling: true,
      } : s)
      setHistory(prev => [
        { id: Date.now() + Math.random(), roll: rollValue, win: isWin },
        ...prev,
      ].slice(0, 8))
    }, 30 + CUBE_SLIDE_MS))

    // Stage 3b — end the bounce class.
    cubeTimersRef.current.push(setTimeout(() => {
      setCube(s => s ? { ...s, scaling: false } : s)
    }, 30 + CUBE_SLIDE_MS + CUBE_BOUNCE_MS))

    // Stage 4 — after the hold, start fading.
    cubeTimersRef.current.push(setTimeout(() => {
      setCube(s => s ? { ...s, fading: true } : s)
    }, 30 + CUBE_SLIDE_MS + CUBE_HOLD_MS))

    // Stage 5 — fully hide after the fade. State keeps the last
    // visualPct so the NEXT roll picks up from this position.
    cubeTimersRef.current.push(setTimeout(() => {
      setCube(s => s ? { ...s, visible: false, fading: false } : s)
    }, 30 + CUBE_SLIDE_MS + CUBE_HOLD_MS + CUBE_FADE_MS))
  }

  // ── Auto-spin loop ──
  // Drives consecutive rolls while `autoSpin` is on. Stops when the
  // user toggles auto off, leaves the page, or runs out of balance.
  async function autoLoop() {
    while (autoRef.current && !cancelRef.current) {
      // Wait out any in-progress roll before starting the next one.
      while (rollingRef.current && !cancelRef.current && autoRef.current) {
        await sleep(60)
      }
      if (!autoRef.current || cancelRef.current) break
      if (balanceRef.current < stakeRef.current) {
        setAutoSpin(false); autoRef.current = false
        break
      }
      await roll()
      // Breath between rolls — keeps the history pills readable.
      await sleep(200)
    }
  }

  function onAutoClick() {
    haptic('light')
    if (autoSpin) {
      // Cancel auto-spin — current roll (if any) finishes, then we
      // stop. Don't fire the next iteration.
      setAutoSpin(false); autoRef.current = false
      return
    }
    if (!canAfford || rolling) return
    setAutoSpin(true); autoRef.current = true
    autoLoop()
  }

  // ── One roll ──
  //
  // CRITICAL: the body lives inside a try/catch/finally. The server
  // round MUST be finalized no matter how gameplay ends — otherwise
  // the bet sits debited on the server while the user sees no
  // payout, and on reload they look like they "lost their winnings".
  //
  // Flow:
  //   1. start_dice_round  → atomic debit + open round
  //   2. localRoll          → outcome + display value
  //   3. animate cube       → reveal sequence (separate timer chain)
  //   4. finish_dice_round  → cap + credit balance (always, in finally)
  async function roll() {
    if (rollingRef.current) return
    if (cancelRef.current) return
    if (finalizingRef.current) return

    const baseStake = stakeRef.current
    if (balanceRef.current < baseStake) {
      setAutoSpin(false); autoRef.current = false
      return
    }

    rollingRef.current = true
    setRolling(true)
    haptic('light')

    const isDev = !user || user.id === 'dev'
    let round = null
    let totalWin = 0
    let startFailed = false

    try {
      // ── Server start (or dev simulate) ──
      if (isDev) {
        const next = balanceRef.current - baseStake
        balanceRef.current = next
        setBalance(next)
        round = {
          ok: true,
          round_id: `dev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          balance: next,
        }
      } else {
        const res = await startDiceRound(user.id, baseStake)
        if (cancelRef.current) return
        if (!res || res.error || !res.ok) {
          console.error('startDiceRound failed:', res)
          setAutoSpin(false); autoRef.current = false
          startFailed = true
          return        // finally still runs → resets rolling
        }
        round = res
        setBalance(round.balance)
        balanceRef.current = round.balance
      }
      currentRoundRef.current = round

      // Decide outcome — chance-curve win/loss + consistent value.
      // Server signals deficit_active when the house is in deficit;
      // localRoll then forces a losing outcome so the rolling cube
      // lands on the wrong side of the threshold naturally.
      const deficit = !!round?.deficit_active
      const { value, isWin } = localRoll(targetRef.current, modeRef.current, deficit)
      totalWin = isWin
        ? Math.round(baseStake * multiplierFor(targetRef.current, modeRef.current))
        : 0

      // Drive the cube reveal animation. Fire-and-forget — it owns
      // its own setTimeout chain.
      startCubeReveal(value, isWin)

      // Wait for the cube to land (= the bounce moment), then
      // optimistically settle the balance / win banner so the UI
      // reacts in lock-step with the bounce.
      await sleep(30 + CUBE_SLIDE_MS)
      if (cancelRef.current) return

      if (totalWin > 0) {
        const next = balanceRef.current + totalWin
        balanceRef.current = next
        setBalance(next)
        if (typeof setBalanceBounce === 'function') {
          setBalanceBounce(true)
          setTimeout(() => setBalanceBounce(false), 540)
        }
        setLastWin(totalWin)
        haptic('success')
      } else {
        setLastWin(0)
      }
    } catch (err) {
      console.error('Dice roll failed:', err)
      setAutoSpin(false); autoRef.current = false
    } finally {
      // ── Server finalize ──
      // ALWAYS finalize a real-money round we successfully started,
      // even if gameplay above threw. Sends the totalWin we
      // computed up to the throw point — server pays it out in
      // full (no cap).
      if (round && !isDev && !startFailed && round.round_id && !round.round_id.startsWith('dev-')) {
        finalizingRef.current = true
        try {
          const res = await finishDiceRound(round.round_id, Math.round(totalWin))
          if (res && typeof res.balance === 'number' && !cancelRef.current) {
            setBalance(res.balance)
            balanceRef.current = res.balance
          }
        } catch (finErr) {
          console.error('Dice finalize failed:', finErr)
        } finally {
          finalizingRef.current = false
        }
      }
      currentRoundRef.current = null
      rollingRef.current = false
      setRolling(false)
    }
  }

  const stakeUpDisabled   = rolling || autoSpin || stakeIndex >= BETS.length - 1 ||
                            (BETS[stakeIndex + 1] !== undefined && BETS[stakeIndex + 1] > balance)
  const stakeDownDisabled = rolling || autoSpin || stakeIndex <= 0
  const winLabel = lastWin > 0 ? `+${formatCurrency(lastWin, currency, rates)}` : null

  // Chance values run from ~88 % down to ~1e-3 % across the slider.
  // Bigger numbers fit 2 decimals; small ones need extra precision
  // so "0.000971" reads correctly instead of rounding to "0.00".
  const chanceLabel = chance >= 1
    ? `${chance.toFixed(2)}%`
    : chance >= 0.01
      ? `${chance.toFixed(4)}%`
      : `${chance.toFixed(6)}%`

  return (
    <div className="dice-slot-page">
      <div className="dice-game-window">
        <main className="dice-stage" aria-label="Dice">
          <div className="dice-bg" />

          {/* ── History row ──
              Last N rolls, newest first. Green pill = win, gray =
              loss. Empty slots render NOTHING — no placeholder
              oval — so before the first spin the row is just blank
              space, and the pills only show when there's something
              real to show. Pills have a fixed width so they don't
              stretch when there's only one of them. */}
          <div className="dice-history" aria-hidden="true">
            {history.map(h => (
              <span
                key={h.id}
                className={`dice-history-pill ${h.win ? 'is-win' : 'is-loss'}`}
              >
                {h.roll}
              </span>
            ))}
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
              cube={cube}
              disabled={rolling}
              onChangeTarget={setTargetClamped}
            />
          </div>

          {/* ── HUD ─────────────────────────────────────────────
              Lives INSIDE the stage now, at the bottom. Two-row
              layout matching the reference:
                Row 1 — Multiplier  |  Win chance
                Row 2 — Roll above [value]            [toggle btn]
              ──────────────────────────────────────────────── */}
          <div className="dice-hud">
            <div className="dice-hud-top">
              <div className="dice-hud-box">
                <span className="dice-hud-label">{t.diceMultiplier}</span>
                <strong className="dice-hud-value">{mult.toFixed(2)}×</strong>
              </div>
              <div className="dice-hud-box">
                <span className="dice-hud-label">{t.diceWinChance}</span>
                <strong className="dice-hud-value">{chanceLabel}</strong>
              </div>
            </div>
            <div className="dice-hud-box dice-hud-box--toggle">
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
          </div>
        </main>

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
              className={`dice-roll-btn ${autoSpin ? 'is-auto' : ''}`}
              onClick={autoSpin ? onAutoClick : roll}
              disabled={!autoSpin && (!canAfford || rolling)}
              aria-label={autoSpin ? t.slotPlinkoStop : t.diceRoll}
            >
              {autoSpin ? (
                <svg width="34" height="34" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <rect x="6" y="5" width="4" height="14" rx="1.2" />
                  <rect x="14" y="5" width="4" height="14" rx="1.2" />
                </svg>
              ) : (
                <DiceIcon />
              )}
            </button>
            <button
              type="button"
              className={`dice-auto-btn ${autoSpin ? 'is-on' : ''}`}
              onClick={onAutoClick}
              disabled={!autoSpin && (!canAfford || rolling)}
            >
              {autoSpin ? t.slotPlinkoStop : t.slotPlinkoAuto}
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
function DiceBar({ target, mode, cube, disabled, onChangeTarget }) {
  const barRef = useRef(null)
  // The inner-wrapper element is what the user actually drags on
  // (the coordinate space the coloured stripe + handle live in).
  const innerRef = useRef(null)
  const draggingRef = useRef(false)
  // Tracks the last integer value reported so we can fire a haptic
  // "tick" exactly once per integer crossing while the player drags
  // (gives the slider a notched / ratcheting feel instead of a
  // smooth glide). Defaults to a sentinel that never equals a real
  // value so the first drag move always emits one tick.
  const lastTickRef = useRef(NaN)
  // Identifier of the touch that initiated the current drag. We
  // only follow THIS finger — events from any second / third
  // finger that touches the screen later are ignored, so the
  // handle never jumps to where an unrelated touch happens to be.
  const touchIdRef = useRef(null)
  // Wall-clock timestamp of the most recent touchend / touchcancel.
  // Used to suppress the browser's simulated mouse events
  // (mousedown / mouseup) that follow a tap-like touch — on iOS
  // Safari those simulated events fire at the touchSTART position,
  // not the lift position, so without this guard a quick small
  // drag would snap the handle back to where the finger first
  // landed the moment the simulated mousedown was processed.
  const lastTouchEndAtRef = useRef(0)

  // Refs that mirror the latest props / callbacks. handleMove reads
  // through them so the callback itself can stay STABLE (empty deps
  // in useCallback). Stable handleMove means the window listener
  // effect below only attaches its handlers once — without these
  // refs, the parent re-rendered on every drag tick, recreated
  // onChangeTarget, which forced the listener effect to detach +
  // re-attach during the drag. Touchmove events that fell into that
  // microsecond gap got dropped → on release the handle snapped to
  // the LAST successfully-reported position instead of where the
  // finger actually was. With a stable handler, no gap, no jump.
  const modeRef             = useRef(mode)
  const onChangeTargetRef   = useRef(onChangeTarget)
  useEffect(() => { modeRef.current           = mode }, [mode])
  useEffect(() => { onChangeTargetRef.current = onChangeTarget }, [onChangeTarget])

  const handleMove = useCallback((clientX) => {
    // Drag math: convert pointer X (relative to inner-wrapper) to
    // a visual % [0..100] of the inner-wrapper, then map that to
    // a logical target via the inverse of `targetToVisualPct`,
    // using the active mode's bounds.
    const el = innerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const visualPct = ((clientX - rect.left) / rect.width) * 100
    const t = visualPctToTarget(visualPct, modeRef.current)
    const { min, max } = boundsFor(modeRef.current)
    const integerT = clamp(Math.round(t), min, max)
    if (integerT !== lastTickRef.current) {
      lastTickRef.current = integerT
      haptic('light')
    }
    onChangeTargetRef.current(integerT)
  }, [])  // stable — refs do the work

  function onPointerDown(e) {
    if (disabled) return
    // If this is a MOUSE event arriving shortly after a touch
    // ended, it's almost certainly the browser's simulated mouse
    // event (iOS Safari + some Android browsers fire it for
    // tap-like touches at the touchSTART position). Ignoring it
    // prevents the handle from snapping back to where the finger
    // first landed after a quick small drag.
    if (!e.touches && Date.now() - lastTouchEndAtRef.current < 500) {
      return
    }
    draggingRef.current = true
    // Reset the tick tracker so the initial jump on press also
    // emits a haptic if it lands on a different integer.
    lastTickRef.current = NaN
    if (e.touches && e.touches[0]) {
      // Lock in the identifier of the FIRST touch — every later
      // touchmove will follow only this finger.
      touchIdRef.current = e.touches[0].identifier
      handleMove(e.touches[0].clientX)
    } else {
      touchIdRef.current = null
      handleMove(e.clientX)
    }
  }

  useEffect(() => {
    function onMove(e) {
      if (!draggingRef.current) return
      if (e.touches) {
        // Find OUR touch in the active touches list — ignore any
        // other fingers that may have landed on the screen during
        // the drag.
        let touch = null
        for (let i = 0; i < e.touches.length; i++) {
          if (e.touches[i].identifier === touchIdRef.current) {
            touch = e.touches[i]
            break
          }
        }
        if (!touch) return
        handleMove(touch.clientX)
      } else {
        handleMove(e.clientX)
      }
    }
    function onUp(e) {
      // For touch end / cancel, only release the drag if OUR touch
      // was the one that ended. A second finger lifting elsewhere
      // mustn't drop the active drag.
      if (e && e.changedTouches) {
        let ours = null
        for (let i = 0; i < e.changedTouches.length; i++) {
          if (e.changedTouches[i].identifier === touchIdRef.current) {
            ours = e.changedTouches[i]
            break
          }
        }
        if (!ours) return
        // Push one final position update from the lift X — the
        // browser sometimes skips emitting a touchmove for the
        // last few pixels before touchend, so without this the
        // committed target would lag the actual release point.
        if (draggingRef.current) {
          handleMove(ours.clientX)
        }
        // Record the wall-clock so we can suppress simulated
        // mouse events that the browser fires right after.
        lastTouchEndAtRef.current = Date.now()
      }
      draggingRef.current = false
      touchIdRef.current  = null
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

  // Coloured bars use the visual % range of the inner-wrapper:
  //   In ABOVE mode — red (loss) spans 0..vp(target),
  //                   green (win) spans vp(target)..100.
  //   In BELOW mode — green (win) spans 0..vp(target),
  //                   red  (loss) spans vp(target)..100.
  // Because the slider's reachable range is RANGE_PAD..100-RANGE_PAD,
  // the "tail" areas at the corners (0..8 % and 92..100 %) are always
  // painted by the loss / win bars and act as the permanent sliver
  // peeking past the handle at the extremes.
  const targetVp = targetToVisualPct(target, mode)
  const { min: bMin, max: bMax } = boundsFor(mode)
  const redStyle = mode === 'above'
    ? { left:  0, width: `${targetVp}%` }
    : { right: 0, width: `${100 - targetVp}%` }
  const greenStyle = mode === 'above'
    ? { right: 0, width: `${100 - targetVp}%` }
    : { left:  0, width: `${targetVp}%` }

  return (
    <div
      ref={barRef}
      className={`dice-bar ${disabled ? 'is-disabled' : ''}`}
      onMouseDown={onPointerDown}
      onTouchStart={onPointerDown}
    >
      {/* Inner wrapper — narrower coordinate system so there's a
       * visible dark gutter past the coloured stripe on the LEFT
       * and RIGHT (between the stripe and the gray ring). The end
       * dots, the coloured stripes, the result cube and the
       * handle all position relative to THIS wrapper, not the
       * outer .dice-bar. */}
      <div ref={innerRef} className="dice-bar-inner">
        <div className="dice-bar-red"   style={redStyle} />
        <div className="dice-bar-green" style={greenStyle} />

        {/* Result cube — multi-stage reveal driven from the parent
            via the `cube` state. The `is-neutral / is-win / is-loss`
            class flips the colour, `is-bouncing` fires the land
            scale animation, `is-fading` triggers the opacity fade
            out. `visualPct` is in inner-wrapper percent (so the
            cube moves through the same coordinate space as the
            handle). */}
        {cube && cube.visible && (
          <div
            className={
              `dice-cube`
              + (cube.color === 'win'  ? ' is-win'  : '')
              + (cube.color === 'loss' ? ' is-loss' : '')
              + (cube.color === 'gray' ? ' is-neutral' : '')
              + (cube.scaling          ? ' is-bouncing' : '')
              + (cube.fading           ? ' is-fading' : '')
            }
            style={{ left: `${cube.visualPct}%` }}
          >
            <span>{cube.value}</span>
          </div>
        )}

        {/* Draggable threshold handle — square white thumb with
         * three vertical grip lines. No CSS transition: the handle
         * JUMPS between integer positions for the ratchet/tick feel.
         * The visual position remaps target into the
         * RANGE_PAD..100-RANGE_PAD slice of the inner-wrapper so the
         * handle aligns with the "min"/"max" labels exactly. */}
        <div
          className="dice-handle"
          style={{ left: `${targetVp}%` }}
          role="slider"
          aria-valuemin={bMin}
          aria-valuemax={bMax}
          aria-valuenow={target}
        >
          {/* Three short vertical grip bars inside the square thumb. */}
          <span className="dice-handle-grip" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        </div>
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
