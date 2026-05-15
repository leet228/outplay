import React, { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useShallow } from 'zustand/react/shallow'
import useGameStore from '../store/useGameStore'
import { translations } from '../lib/i18n'
import { formatCurrency } from '../lib/currency'
import { haptic } from '../lib/telegram'
import './StardewSpinsSlot.css'

// ─────────────────────────────────────────────────────────────
// STARDEW SPINS — dev v1
//
// 6×5 grid, Pay-Anywhere: 8+ of the same symbol ANYWHERE on the
// field pays. Winners tumble out, the column above them drops
// down to fill the gap, and fresh symbols spawn at the top.
// Chains keep firing while any 8+ cluster survives.
//
// Seasonal wheel header rotates every SEASON_SPINS spins and
// re-paints the sky strip. Mechanical bias on payouts per
// season is left as a follow-up — for now the wheel is purely
// visual feedback so we can wire the loop end-to-end.
//
// Server RPC integration (start_stardew_round /
// finish_stardew_round + deficit breaker) is also follow-up;
// this dev pass debits / credits the local zustand balance
// directly so the user can play offline with the existing
// 100 000 ₽ dev wallet.
// ─────────────────────────────────────────────────────────────

const ROWS = 5
const COLS = 6
const CELL_COUNT = ROWS * COLS

// Stake ladder mirrors Magnetic / Pixel Mine — same coin
// denominations so the player's muscle memory doesn't reset
// between slots.
const BETS = [10, 25, 50, 100, 250, 500, 1000, 2000, 4000, 8000]

// Pay-Anywhere min cluster. Sweet-Bonanza-style "8+ anywhere".
const MIN_MATCH = 8

// ── Symbols ──
// Five harvest crops. Higher payout = rarer drop weight, so the
// expected value stays balanced across the pool.
const SYMBOLS = [
  { id: 'wheat',      weight: 24 },
  { id: 'leek',       weight: 22 },
  { id: 'carrot',     weight: 20 },
  { id: 'pumpkin',    weight: 18 },
  { id: 'strawberry', weight: 16 },
]
const SYM_WEIGHT_SUM = SYMBOLS.reduce((s, x) => s + x.weight, 0)

// Pay table — multiplier × stake. Keys are minimum match counts;
// when resolving a cluster we pick the highest key ≤ count.
//   strawberry > pumpkin > carrot > wheat > leek
// 30 of one symbol is essentially impossible (≈ 1e-20) but the
// table keeps a sane ceiling just in case.
const PAYOUTS = {
  strawberry: { 8: 0.8, 10: 2.0, 12: 5,   15: 12, 20: 40, 25: 120, 30: 500 },
  pumpkin:    { 8: 0.5, 10: 1.4, 12: 3.5, 15: 8,  20: 30, 25: 90,  30: 350 },
  carrot:     { 8: 0.4, 10: 1.0, 12: 2.5, 15: 6,  20: 20, 25: 60,  30: 250 },
  wheat:      { 8: 0.3, 10: 0.8, 12: 2.0, 15: 5,  20: 16, 25: 48,  30: 200 },
  leek:       { 8: 0.2, 10: 0.6, 12: 1.5, 15: 4,  20: 12, 25: 36,  30: 150 },
}

// Pure visual cycle. SEASON_SPINS counts down to 0, then we
// roll over and rotate to the next season.
const SEASONS = ['spring', 'summer', 'fall', 'winter']
const SEASON_SPINS = 5

// Animation timings (ms). Tuned so a quiet spin (no wins) takes
// ~700 ms and a long cascade still feels snappy.
const DROP_MS         = 320     // initial grid drop
const WIN_HIGHLIGHT_MS = 520    // dwell on winning cells
const TUMBLE_MS       = 340     // clear + drop + refill
const POST_SPIN_REST  = 180     // gap before auto-spin re-enters

function pickSymbol() {
  let r = Math.random() * SYM_WEIGHT_SUM
  for (const s of SYMBOLS) {
    if (r < s.weight) return s.id
    r -= s.weight
  }
  return SYMBOLS[0].id
}

function genGrid() {
  const g = new Array(CELL_COUNT)
  for (let i = 0; i < CELL_COUNT; i++) g[i] = pickSymbol()
  return g
}

// Count occurrences of each symbol on a flat grid. Returns
// `{ [symId]: [cellIdx, ...] }` for symbols that hit MIN_MATCH+.
function findWins(grid) {
  const buckets = {}
  for (let i = 0; i < grid.length; i++) {
    const s = grid[i]
    if (!s) continue
    if (!buckets[s]) buckets[s] = []
    buckets[s].push(i)
  }
  const wins = {}
  for (const [sym, indices] of Object.entries(buckets)) {
    if (indices.length >= MIN_MATCH) wins[sym] = indices
  }
  return wins
}

function payoutFor(sym, count) {
  const table = PAYOUTS[sym]
  if (!table) return 0
  let best = 0
  for (const k of Object.keys(table)) {
    const n = Number(k)
    if (count >= n && table[k] > best) best = table[k]
  }
  return best
}

// Sweet-Bonanza-style tumble. For each column:
//   1. Remove any cells whose flat index is in `winningSet`.
//   2. Let the remaining cells fall to the bottom of the column.
//   3. Spawn fresh symbols at the top to refill the cleared slots.
// `rowOf(i)` and `colOf(i)` use the standard `r * COLS + c` flat
// layout (row 0 = top).
function tumbleGrid(grid, winningSet) {
  const next = new Array(CELL_COUNT)
  for (let c = 0; c < COLS; c++) {
    // Read column top→bottom, drop cleared cells.
    const survivors = []
    for (let r = 0; r < ROWS; r++) {
      const i = r * COLS + c
      if (!winningSet.has(i)) survivors.push(grid[i])
    }
    // Survivors sit at the BOTTOM of the column. Top rows get
    // fresh picks.
    const newCount = ROWS - survivors.length
    for (let r = 0; r < ROWS; r++) {
      const i = r * COLS + c
      if (r < newCount) next[i] = pickSymbol()
      else              next[i] = survivors[r - newCount]
    }
  }
  return next
}

const wait = (ms) => new Promise(r => setTimeout(r, ms))

// Sprinkle multiplier coins on the top-of-column refill cells.
// Extracted to module scope so the spin loop stays pure-ish from
// React's perspective (Math.random() inside a component body
// trips the react-hooks/purity rule even though the call lives
// inside an async event handler, not render).
const MULT_COIN_POOL = [2, 3, 5, 10, 25, 50]
const MULT_COIN_CHANCE = 0.06
function sprinkleMultipliers(refillIndices) {
  const out = {}
  for (const i of refillIndices) {
    if (Math.random() < MULT_COIN_CHANCE) {
      out[i] = MULT_COIN_POOL[Math.floor(Math.random() * MULT_COIN_POOL.length)]
    }
  }
  return out
}

export default function StardewSpinsSlot() {
  const navigate = useNavigate()
  const { lang, currency, rates, balance, setBalance } = useGameStore(
    useShallow(s => ({
      lang: s.lang,
      currency: s.currency,
      rates: s.rates,
      balance: s.balance,
      setBalance: s.setBalance,
    }))
  )
  const t = translations[lang]

  // ── State ──
  const [grid, setGrid] = useState(() => genGrid())
  const [winningCells, setWinningCells] = useState(() => new Set())
  // Per-cell multiplier coin overlay. Sparse — `{ [i]: 2|3|5|... }`.
  const [multipliers, setMultipliers] = useState(() => ({}))
  const [stake, setStake] = useState(BETS[0])
  const [spinning, setSpinning] = useState(false)
  const [autoSpin, setAutoSpin] = useState(false)
  const [lastWin, setLastWin] = useState(0)
  const [season, setSeason] = useState('summer')
  const [seasonCountdown, setSeasonCountdown] = useState(SEASON_SPINS)
  // Cells that are currently mid "fall in" — drives a CSS animation
  // class that only plays once after each grid swap.
  const [fallingIn, setFallingIn] = useState(() => new Set())

  // ── Refs (avoid stale-closure inside the spin loop / auto loop)
  const spinningRef  = useRef(false)
  const autoRef      = useRef(false)
  const stakeRef     = useRef(stake)
  const balanceRef   = useRef(balance)
  const cancelRef    = useRef(false)
  useEffect(() => { spinningRef.current = spinning }, [spinning])
  useEffect(() => { autoRef.current     = autoSpin }, [autoSpin])
  useEffect(() => { stakeRef.current    = stake },    [stake])
  useEffect(() => { balanceRef.current  = balance },  [balance])
  useEffect(() => () => { cancelRef.current = true }, [])

  // ── Telegram BackButton + browser back to home ──
  useEffect(() => {
    const tg = window.Telegram?.WebApp
    const back = () => {
      haptic('light')
      cancelRef.current = true
      setAutoSpin(false); autoRef.current = false
      navigate('/home')
    }
    if (tg) {
      tg.BackButton.show()
      tg.BackButton.onClick(back)
    }
    return () => {
      if (tg) { tg.BackButton.offClick(back); tg.BackButton.hide() }
    }
  }, [navigate])

  // ── Derived values for the control bar ──
  const stakeIndex = BETS.indexOf(stake)
  const canAfford  = balance >= stake
  const stakeUpDisabled   = spinning || stakeIndex >= BETS.length - 1 ||
                            (BETS[stakeIndex + 1] !== undefined && BETS[stakeIndex + 1] > balance)
  const stakeDownDisabled = spinning || stakeIndex <= 0

  function changeStake(dir) {
    if (spinning) return
    const next = BETS[stakeIndex + dir]
    if (next == null) return
    if (dir > 0 && next > balance) return
    haptic('light')
    setStake(next)
  }

  // ── Spin loop ──
  async function spin() {
    if (spinningRef.current) return
    if (balanceRef.current < stakeRef.current) return

    setSpinning(true); spinningRef.current = true
    haptic('medium')

    // Debit stake from local balance.
    const startBalance = balanceRef.current - stakeRef.current
    setBalance(startBalance)
    setLastWin(0)

    // 1) Generate fresh grid + drop animation.
    let g = genGrid()
    setMultipliers({})
    setGrid(g)
    setWinningCells(new Set())
    // Every cell falls in on a fresh spin.
    setFallingIn(new Set(Array.from({ length: CELL_COUNT }, (_, i) => i)))
    await wait(DROP_MS)
    setFallingIn(new Set())

    // 2) Cascade loop.
    let totalWin = 0
    let chain = 0
    // Sanity bound — chain can't loop forever (each iteration
    // strictly reduces something), but cap it anyway.
    while (chain < 30) {
      if (cancelRef.current) break
      const wins = findWins(g)
      const symIds = Object.keys(wins)
      if (symIds.length === 0) break

      // Build the winning-cell set and tally the cluster payouts.
      const winSet = new Set()
      let chainWin = 0
      for (const sym of symIds) {
        const idx = wins[sym]
        chainWin += payoutFor(sym, idx.length) * stakeRef.current
        idx.forEach(i => winSet.add(i))
      }
      // Apply any active multipliers under those cells.
      // (Multipliers are intentionally rare — sprinkled after wins
      //  in the same cascade, hot-floor mechanic.)
      // For dev: any multiplier that sits on a winning cell stacks
      // additively. ×2 + ×3 = ×5 etc.
      let multTotal = 0
      for (const i of winSet) {
        if (multipliers[i]) multTotal += multipliers[i]
      }
      if (multTotal > 0) chainWin *= multTotal

      setWinningCells(winSet)
      haptic('light')
      await wait(WIN_HIGHLIGHT_MS)
      if (cancelRef.current) break

      // 3) Tumble.
      g = tumbleGrid(g, winSet)
      setGrid(g)
      setWinningCells(new Set())
      // Cells in cleared positions are the ones falling in.
      // Easiest approximation — flag every cell whose new symbol
      // wasn't there a frame ago. For dev we just light up the
      // whole grid; it's a 320 ms transition either way.
      setFallingIn(new Set(Array.from({ length: CELL_COUNT }, (_, i) => i)))
      // Drop spent multipliers; the new pass gets fresh chances.
      setMultipliers({})

      // Rare: a ×N coin lands on a freshly-refilled cell during a
      // cascade. Drives the dopamine when long chains keep firing.
      // Cells that just got a fresh symbol are at the top of each
      // column — count the cleared cells per column to find them.
      const refillIndices = []
      for (let c = 0; c < COLS; c++) {
        let cleared = 0
        for (let r = 0; r < ROWS; r++) {
          const i = r * COLS + c
          if (winSet.has(i)) cleared++
        }
        for (let r = 0; r < cleared; r++) refillIndices.push(r * COLS + c)
      }
      setMultipliers(sprinkleMultipliers(refillIndices))

      totalWin += chainWin
      chain++
      await wait(TUMBLE_MS)
      setFallingIn(new Set())
    }

    // 4) Credit total win.
    if (totalWin > 0) {
      const finalBalance = balanceRef.current + Math.round(totalWin)
      setBalance(finalBalance)
      setLastWin(Math.round(totalWin))
      try { window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success') } catch { /* haptic optional */ }
    }

    // 5) Seasonal countdown.
    setSeasonCountdown(c => {
      if (c <= 1) {
        setSeason(s => SEASONS[(SEASONS.indexOf(s) + 1) % SEASONS.length])
        return SEASON_SPINS
      }
      return c - 1
    })

    setSpinning(false); spinningRef.current = false

    // Auto-spin continuation.
    if (autoRef.current && balanceRef.current >= stakeRef.current) {
      await wait(POST_SPIN_REST)
      if (autoRef.current && !cancelRef.current) spin()
    } else if (autoRef.current) {
      // Can't afford next auto-spin — turn auto off so the spin
      // button isn't stuck in "STOP" state.
      setAutoSpin(false); autoRef.current = false
    }
  }

  function onSpinClick() {
    if (autoSpin) {
      // Tap during auto = "stop after current spin".
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
    spin()
  }

  const winLabel = lastWin > 0 ? `+${formatCurrency(lastWin, currency, rates)}` : null

  // Needle rotation — 4 quadrants × 90° each, summer = 45°, spring
  // = -45°, fall = 135°, winter = 225° (rotates clockwise through
  // the year).
  const seasonAngle = (() => {
    switch (season) {
      case 'spring': return -45
      case 'summer': return 45
      case 'fall':   return 135
      case 'winter': return -135 // = 225, but rotate visually
      default:       return 45
    }
  })()

  return (
    <div className={`stardew-slot-page stardew-slot-page--${season}`}>
      <div className="stardew-game-window">
        <main className={'stardew-stage' + (spinning ? ' is-spinning' : '')} aria-label="Stardew Spins">
          {/* ── Sky strip ── */}
          <div className="stardew-sky">
            <span className="stardew-sun" />
            <span className="stardew-cloud stardew-cloud--one" />
            <span className="stardew-cloud stardew-cloud--two" />
            <span className="stardew-cloud stardew-cloud--three" />
            {season === 'winter' && (
              <>
                <span className="stardew-snow stardew-snow--one" />
                <span className="stardew-snow stardew-snow--two" />
                <span className="stardew-snow stardew-snow--three" />
              </>
            )}

            {/* Seasonal wheel — quadrants + rotating needle. */}
            <div className="stardew-wheel">
              <div className="stardew-wheel-disc">
                <span className="stardew-wheel-q stardew-wheel-q--spring" />
                <span className="stardew-wheel-q stardew-wheel-q--summer" />
                <span className="stardew-wheel-q stardew-wheel-q--fall" />
                <span className="stardew-wheel-q stardew-wheel-q--winter" />
                <span className="stardew-wheel-needle" style={{ transform: `translate(-50%, -100%) rotate(${seasonAngle}deg)` }} />
                <span className="stardew-wheel-hub" />
              </div>
              <span className="stardew-wheel-label">
                {seasonLabel(lang, season)}
              </span>
              <span className="stardew-wheel-counter">
                {(lang === 'ru' ? 'До смены: ' : 'Next: ') + seasonCountdown}
              </span>
            </div>
          </div>

          {/* ── Field area (left fence / grid / right well) ── */}
          <div className="stardew-field-area">
            {/* LEFT side — fence + sunflowers */}
            <div className="stardew-side stardew-side--left" aria-hidden="true">
              <span className="stardew-fence-rail stardew-fence-rail--top" />
              <span className="stardew-fence-rail stardew-fence-rail--mid" />
              <span className="stardew-fence-post stardew-fence-post--a" />
              <span className="stardew-fence-post stardew-fence-post--b" />
              <span className="stardew-fence-post stardew-fence-post--c" />
              <span className="stardew-sunflower stardew-sunflower--tall" />
              <span className="stardew-sunflower stardew-sunflower--short" />
            </div>

            {/* CENTER — wooden grid frame with crops */}
            <div className="stardew-grid-frame">
              <span className="stardew-nail stardew-nail--tl" />
              <span className="stardew-nail stardew-nail--tr" />
              <span className="stardew-nail stardew-nail--bl" />
              <span className="stardew-nail stardew-nail--br" />

              <div className="stardew-grid">
                {grid.map((sym, i) => {
                  const isWin   = winningCells.has(i)
                  const isFall  = fallingIn.has(i)
                  const mult    = multipliers[i]
                  return (
                    <span
                      key={i}
                      className={
                        'stardew-cell' +
                        (isWin  ? ' is-win'      : '') +
                        (isFall ? ' is-falling'  : '')
                      }
                      style={isFall ? { animationDelay: `${(i % COLS) * 30}ms` } : undefined}
                    >
                      {sym && (
                        <span className={`stardew-crop stardew-crop--${sym}`} />
                      )}
                      {mult && (
                        <span className="stardew-mult-coin">×{mult}</span>
                      )}
                    </span>
                  )
                })}
              </div>

              {/* Win banner — drops down from the top of the frame
                * once a cascade settles. Lives inside the frame so
                * the controls stay clean. */}
              {winLabel && !spinning && (
                <div className="stardew-win-banner">
                  <span className="stardew-win-banner-label">
                    {lang === 'ru' ? 'УРОЖАЙ' : 'HARVEST'}
                  </span>
                  <strong>{winLabel}</strong>
                </div>
              )}
            </div>

            {/* RIGHT side — well + scarecrow */}
            <div className="stardew-side stardew-side--right" aria-hidden="true">
              <div className="stardew-well">
                <span className="stardew-well-roof" />
                <span className="stardew-well-roof-tile" />
                <span className="stardew-well-pole stardew-well-pole--l" />
                <span className="stardew-well-pole stardew-well-pole--r" />
                <span className="stardew-well-body">
                  <span className="stardew-well-water" />
                </span>
                <span className="stardew-well-bucket" />
              </div>
              <div className="stardew-scarecrow">
                <span className="stardew-scarecrow-hat" />
                <span className="stardew-scarecrow-face" />
                <span className="stardew-scarecrow-body" />
                <span className="stardew-scarecrow-stick" />
              </div>
            </div>
          </div>
        </main>

        {/* ── Controls ── */}
        <section className="stardew-controls">
          <div className="stardew-balance">
            <span>{t.balance || 'Баланс'}</span>
            <strong>{formatCurrency(balance, currency, rates)}</strong>
          </div>

          <div className="stardew-center">
            <button
              type="button"
              className={'stardew-spin-btn' + (autoSpin ? ' is-auto' : '')}
              onClick={onSpinClick}
              disabled={!autoSpin && (!canAfford || spinning)}
              aria-label={autoSpin ? 'Stop' : 'Spin'}
            >
              {autoSpin ? (
                <svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <rect x="6" y="5" width="4" height="14" rx="1.2" />
                  <rect x="14" y="5" width="4" height="14" rx="1.2" />
                </svg>
              ) : (
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M21 12a9 9 0 1 1-3-6.7M21 4v5h-5" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              )}
            </button>
            <button
              type="button"
              className={'stardew-auto-btn' + (autoSpin ? ' is-on' : '')}
              onClick={onAutoClick}
              disabled={!autoSpin && (!canAfford || spinning)}
            >
              {autoSpin ? (lang === 'ru' ? 'СТОП' : 'STOP') : (lang === 'ru' ? 'АВТО' : 'AUTO')}
            </button>
          </div>

          <div className="stardew-stake-block">
            <div className="stardew-stake-row">
              <button
                type="button"
                className="stardew-stake-step"
                onClick={() => changeStake(-1)}
                disabled={stakeDownDisabled}
                aria-label="stake down"
              >−</button>
              <div className="stardew-stake">
                <span>{t.slotBet || 'Ставка'}</span>
                <strong>{formatCurrency(stake, currency, rates)}</strong>
              </div>
              <button
                type="button"
                className="stardew-stake-step"
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

// ── Helpers ──

function seasonLabel(lang, season) {
  const RU = { spring: 'Весна', summer: 'Лето', fall: 'Осень', winter: 'Зима' }
  const EN = { spring: 'Spring', summer: 'Summer', fall: 'Fall', winter: 'Winter' }
  return (lang === 'ru' ? RU : EN)[season] || season
}
