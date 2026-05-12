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
//   5 magnets on top, 5 reels × 3 cells below. Every cell — and
//   every magnet — is a vertical "strip" of N items that scrolls
//   downward to settle on its final value, like a Minecraft-style
//   slot wheel:
//
//     1. Spin begins → magnets + reel cells animate strips top→
//        bottom for 'plavno medlenno' visual.
//     2. Magnets stop LEFT → RIGHT first (shorter durations).
//     3. Then reel cells stop LEFT → RIGHT, with each column's
//        rows staggered top → bottom inside the column.
//     4. Once everything has settled, the magnetism pass plays
//        SEQUENTIALLY per column: column 0's symbols rise toward
//        its magnet while that magnet trembles, then column 1,
//        etc. The longer the column's combined pull-strength,
//        the higher the symbols climb — `reach=1` = right under
//        the magnet (full multiplier), `reach=0` = stay put.
//   Per-reel payout = (reach × magnet_mult × stake) / REELS.
//
//   Dev-only for now: balance is debited locally with no server
//   round.
// ─────────────────────────────────────────────────────────────

const BETS = [10, 25, 50, 100, 250, 500, 1000, 2000, 4000, 8000, 16000, 25000]
const SLOT_ID = 'magnetic'

const REELS = 5
const ROWS  = 3
// Total items in each scrolling strip. 1 final symbol at the
// bottom + (STRIP_LEN - 1) random symbols above it.
const STRIP_LEN = 8

const MAGNET_POOL    = [2, 5, 10, 25, 50, 100]
const MAGNET_WEIGHTS = [38, 26, 16, 10, 6, 4]
const MAGNET_WEIGHT_SUM = MAGNET_WEIGHTS.reduce((s, w) => s + w, 0)

function pickMagnet() {
  let r = Math.random() * MAGNET_WEIGHT_SUM
  for (let i = 0; i < MAGNET_POOL.length; i++) {
    if (r < MAGNET_WEIGHTS[i]) return MAGNET_POOL[i]
    r -= MAGNET_WEIGHTS[i]
  }
  return MAGNET_POOL[0]
}

// Symbol strengths are FIXED tier ratios — each non-blank, non-
// scatter symbol always lands in the same tier cell. ⚡ volt is
// a SCATTER: it doesn't get pulled toward the magnet, just stays
// put in its reel cell. (Bonus mechanic for N+ scatters is left
// open for later; for now it just doesn't contribute to payout.)
const SYMBOLS = [
  { id: 'blank', emoji: '',   strength: 0,    weight: 30 },
  { id: 'bolt',  emoji: '🔩', strength: 0.25, weight: 32 },
  { id: 'coin',  emoji: '🪙', strength: 0.50, weight: 20 },
  { id: 'troph', emoji: '🏆', strength: 0.75, weight: 11 },
  { id: 'gem',   emoji: '💎', strength: 1.00, weight: 5  },
  { id: 'volt',  emoji: '⚡', strength: 0,    weight: 2, isScatter: true },
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

// Four tier cells per column: 100 / 75 / 50 / 25 %, evenly
// stepped down the pull column. Each symbol's own `strength`
// (0.25 / 0.50 / 0.75 / 1.00) IS its tier — no aggregation
// happens, every symbol lands in its own matching cell.
// Order top → bottom in the JSX so DOM read order matches what
// the eye sees.
const TIER_PERCENTS = [100, 75, 50, 25]

// Per-symbol payout divisor. Dev-only — RTP not tuned yet; we'll
// run Monte-Carlo before launch. Smaller divisor = bigger
// payouts (player-favoured during early testing so the loop
// feels rewarding while we iterate on visuals).
const PAYOUT_DIVISOR = 50

// Strip layouts: the LAST item is the final value, everything
// above is random filler that scrolls past the viewport during
// the spin animation.
function buildSymbolStrip(final) {
  const strip = []
  for (let i = 0; i < STRIP_LEN - 1; i++) strip.push(pickSymbol())
  strip.push(final)
  return strip
}
function buildMagnetStrip(final) {
  const strip = []
  for (let i = 0; i < STRIP_LEN - 1; i++) strip.push(pickMagnet())
  strip.push(final)
  return strip
}

function initialCellStrip() {
  // At rest the cell shows ONE blank symbol — ty=0 displays the
  // first (and only) entry of the strip.
  return { symbols: [SYMBOLS[0]], ty: 0, td: 0 }
}
function initialMagnetStrip() {
  return { mults: [2], ty: 0, td: 0 }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const rafTwo = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))

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

  const initialStake = (() => {
    const defaults = [50, 25, 10]
    for (const v of defaults) if (balance >= v) return v
    return BETS[0]
  })()

  const [stake, setStake] = useState(initialStake)

  // ── Strip state (drives the visual spin) ──
  const [cellStrips, setCellStrips] = useState(() =>
    Array.from({ length: REELS }, () =>
      Array.from({ length: ROWS }, initialCellStrip)
    )
  )
  const [magnetStrips, setMagnetStrips] = useState(() =>
    Array.from({ length: REELS }, initialMagnetStrip)
  )

  // ── Round outcome state (drives the pull phase) ──
  const [finalGrid, setFinalGrid] = useState(() =>
    Array.from({ length: REELS }, () =>
      Array.from({ length: ROWS }, () => SYMBOLS[0])
    )
  )
  const [finalMagnets, setFinalMagnets] = useState(() => Array(REELS).fill(2))
  const [payoutByCol, setPayoutByCol]   = useState(() => Array(REELS).fill(0))
  // pulledRows[ci] = how many symbols have already left column ci's
  // cells and risen into its pulled-stack (0..ROWS). Drives both:
  //   - reel cell visibility (cell empties once its row is pulled)
  //   - stack rendering (first N pulled symbols appear in stack)
  const [pulledRows, setPulledRows]     = useState(() => Array(REELS).fill(0))
  const [shakingMagnet, setShakingMagnet] = useState(null)
  const [lastWin, setLastWin]           = useState(0)
  const [phase, setPhase]               = useState('idle') // idle | spinning | pulling | settled
  const [spinning, setSpinning]         = useState(false)
  const [autoSpin, setAutoSpin]         = useState(false)
  const [exitConfirm, setExitConfirm]   = useState(false)

  // ── Refs for stable async access ──
  const balanceRef    = useRef(balance)
  const stakeRef      = useRef(stake)
  const spinningRef   = useRef(false)
  const autoRef       = useRef(false)
  const cancelRef     = useRef(false)

  useEffect(() => { balanceRef.current = balance }, [balance])
  useEffect(() => { stakeRef.current   = stake },   [stake])
  useEffect(() => { autoRef.current    = autoSpin }, [autoSpin])
  useEffect(() => () => { cancelRef.current = true }, [])

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

    // Reset everything from the previous round.
    setPhase('spinning')
    setPulledRows(Array(REELS).fill(0))
    setShakingMagnet(null)
    setPayoutByCol(Array(REELS).fill(0))
    setLastWin(0)

    // Debit stake locally (dev-only).
    const balanceAfterDebit = balanceRef.current - stakeRef.current
    balanceRef.current = balanceAfterDebit
    setBalance(balanceAfterDebit)

    // ── Pick final outcome ──
    const finalGridArr = Array.from({ length: REELS }, () =>
      Array.from({ length: ROWS }, pickSymbol)
    )
    const finalMagnetsArr = Array.from({ length: REELS }, pickMagnet)
    setFinalGrid(finalGridArr)
    setFinalMagnets(finalMagnetsArr)

    // ── Build strips, render them at ty=0 (top symbol showing) ──
    // ty: integer number of CELL-heights the strip is translated.
    // ty=0   → first symbol of the strip is in view (random filler).
    // ty=-(STRIP_LEN-1) → last symbol (the FINAL one) is in view.
    const newCellStrips = finalGridArr.map(col =>
      col.map(final => ({
        symbols: buildSymbolStrip(final),
        ty: 0,
        td: 0,
      }))
    )
    const newMagnetStrips = finalMagnetsArr.map(final => ({
      mults: buildMagnetStrip(final),
      ty: 0,
      td: 0,
    }))
    setCellStrips(newCellStrips)
    setMagnetStrips(newMagnetStrips)

    // Force-commit the ty=0/td=0 starting state before triggering
    // the transitions — without this React batches both updates
    // and the browser never sees the FROM state, so no transition
    // fires.
    await rafTwo()
    if (cancelRef.current) return

    // ── Trigger the actual spin transitions ──
    //
    //   Magnets stop LEFT → RIGHT first (shorter durations).
    //   Then reel cells stop LEFT → RIGHT, and within each column
    //   the rows stop TOP → BOTTOM. So the overall sequence reads
    //   as: magnets settle, then row-0 cells settle column by
    //   column, then row-1 cells, then row-2 cells.
    const MAGNET_BASE     = 600   // ms — first magnet's transition duration
    const MAGNET_STAGGER  = 220   // each subsequent magnet finishes this much later
    const REEL_GAP        = 200   // pause between last magnet stop and first reel stop
    const REEL_BASE       = MAGNET_BASE + (REELS - 1) * MAGNET_STAGGER + REEL_GAP
    const REEL_STAGGER    = 240   // each column finishes this much after the prev
    const ROW_STAGGER     = 110   // within a column, each row finishes this much later

    setMagnetStrips(prev => prev.map((s, i) => ({
      ...s,
      ty: -(STRIP_LEN - 1),
      td: MAGNET_BASE + i * MAGNET_STAGGER,
    })))

    setCellStrips(prev => prev.map((col, ci) =>
      col.map((cell, ri) => ({
        ...cell,
        ty: -(STRIP_LEN - 1),
        td: REEL_BASE + ci * REEL_STAGGER + ri * ROW_STAGGER,
      }))
    ))

    // Total time until the last cell has settled.
    const totalSpinDuration = REEL_BASE + (REELS - 1) * REEL_STAGGER + (ROWS - 1) * ROW_STAGGER
    await sleep(totalSpinDuration + 160)
    if (cancelRef.current) {
      spinningRef.current = false
      setSpinning(false)
      setPhase('idle')
      return
    }

    // ── Compute payouts ──
    // Each non-blank, non-scatter symbol contributes its own
    // strength × magnet × stake / PAYOUT_DIVISOR. Scatters (⚡)
    // and blanks contribute 0. The column's total is the sum of
    // its individual symbol contributions.
    const payouts = finalGridArr.map((col, ci) => {
      let sumStrength = 0
      for (const sym of col) {
        if (sym.isScatter) continue
        sumStrength += sym.strength
      }
      return Math.round(
        (sumStrength * finalMagnetsArr[ci] * stakeRef.current) / PAYOUT_DIVISOR
      )
    })
    const winTotal = payouts.reduce((s, p) => s + p, 0)

    setPayoutByCol(payouts)
    setPhase('pulling')

    // ── Sequential per-symbol pull ──
    //   For each column ci (left → right):
    //     1. Start the matching magnet's shake animation.
    //     2. For each row ri (top → bottom) WITHIN the column:
    //        a. Increment pulledRows[ci] — that simultaneously
    //           empties the cell at (ci, ri) AND mounts symbol ri
    //           in the pulled-stack with its fly-in animation.
    //        b. Wait SYMBOL_PULL_INTERVAL ms before pulling the
    //           next symbol (so the eye can track each one).
    //        c. Blank rows skip the wait — the cell was already
    //           empty, so dwelling on it would look like a freeze.
    //     3. Brief gap, then move on to the next column.
    // Pull tuned for a deliberate "плавно медленно" feel — each
    // symbol has plenty of time to float up before the next one
    // starts. magnetic-fly-in (CSS) now runs 850 ms; with an
    // interval of 480 ms the previous symbol is more than half
    // done before the next begins, so the eye can track each
    // arrival individually instead of seeing a blurry triple-rise.
    const SYMBOL_PULL_INTERVAL = 480   // ms between symbol mounts
    const COLUMN_GAP           = 180   // ms between columns
    for (let ci = 0; ci < REELS; ci++) {
      if (cancelRef.current) break
      setShakingMagnet(ci)

      for (let ri = 0; ri < ROWS; ri++) {
        if (cancelRef.current) break
        setPulledRows(prev => {
          const next = [...prev]
          next[ci] = ri + 1
          return next
        })
        const sym = finalGridArr[ci][ri]
        if (sym && sym.emoji) {
          await sleep(SYMBOL_PULL_INTERVAL)
        }
      }

      // Skip the trailing gap after the last column — we add a
      // dedicated tail-wait below to let the last fly-in finish
      // before we flip the phase to 'settled' and reveal payouts.
      if (ci < REELS - 1) {
        await sleep(COLUMN_GAP)
      }
    }
    setShakingMagnet(null)

    // Wait for the LAST column's last symbol to finish its fly-in
    // animation. The CSS keyframe runs 900 ms; the last symbol
    // mounted SYMBOL_PULL_INTERVAL ms ago, so ~440 ms still left.
    // Buffer pushes that to 560 ms so payouts don't pop while the
    // symbol is still settling.
    await sleep(560)
    if (cancelRef.current) return

    setLastWin(winTotal)

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
      await sleep(500)
    }
  }

  function onSpinClick() {
    if (autoSpin) { setAutoSpin(false); autoRef.current = false; return }
    if (!canAfford || spinning) return
    spin()
  }

  function onAutoClick() {
    if (autoSpin) { setAutoSpin(false); autoRef.current = false; return }
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
            {magnetStrips.map((strip, mi) => {
              const finalMult = finalMagnets[mi]
              const isHot     = finalMult >= 50
              // "Captured" lights up the magnet once the column has
              // finished pulling AND it contained at least one 100%
              // tier symbol (💎).
              const captured  = pulledRows[mi] === ROWS &&
                                finalGrid[mi]?.some(s => s && s.strength === 1.0)
              const shaking   = shakingMagnet === mi
              return (
                <div
                  key={mi}
                  className={
                    'magnetic-magnet' +
                    (isHot    ? ' magnetic-magnet--hot' : '') +
                    (captured ? ' is-captured'          : '') +
                    (shaking  ? ' is-shaking'           : '')
                  }
                >
                  <div
                    className="magnetic-magnet-strip"
                    style={{
                      transform: `translateY(calc(var(--magnet-h) * ${strip.ty}))`,
                      transition: strip.td > 0
                        ? `transform ${strip.td}ms cubic-bezier(0.18, 0.6, 0.32, 1)`
                        : 'none',
                    }}
                  >
                    {strip.mults.map((mult, si) => (
                      <span key={si} className="magnetic-magnet-cell">
                        <span className="magnetic-magnet-body">🧲</span>
                        <span className="magnetic-magnet-mult">×{mult}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>

          {/* ── Pull-zone (between magnets and reels) ──
            * Each non-scatter pulled symbol flies into its OWN
            * tier cell based on its individual strength:
            *   🔩 → 25 %, 🪙 → 50 %, 🏆 → 75 %, 💎 → 100 %
            * Scatters (⚡) don't get pulled at all.
            * Multiple symbols going into the same tier stack on
            * each other — first arrival centred in the cell, the
            * rest layered slightly below so the count is readable.
            */}
          <div className="magnetic-pull-zone" aria-hidden="true">
            {Array.from({ length: REELS }).map((_, ci) => {
              const payout    = payoutByCol[ci]
              const rows      = pulledRows[ci]
              const showPayout = phase === 'settled' && payout > 0

              // Build a flat list of (symbol, idx, tier %, stack-idx)
              // for every symbol that has already been pulled.
              // The stack-idx counts how many EARLIER symbols in the
              // same column landed in the same tier — the first
              // arrival in a tier is 0 (centred), the next is 1, etc.
              const tierCounters = {}
              const pulledItems = []
              for (let idx = 0; idx < rows; idx++) {
                const sym = finalGrid[ci]?.[idx]
                if (!sym || sym.isScatter || sym.strength === 0 || !sym.emoji) continue
                const tier = Math.round(sym.strength * 100)
                const stackIdx = tierCounters[tier] || 0
                tierCounters[tier] = stackIdx + 1
                pulledItems.push({ sym, idx, tier, stackIdx })
              }

              return (
                <div key={ci} className="magnetic-pull-col">
                  {/* Tier ladder — 4 SQUARE transparent cells per
                    * column at 100 / 75 / 50 / 25 % reach heights.
                    * Each one is `--cell-h` square (same size as
                    * a reel spin cell) so it reads as a landing
                    * box of the same family the symbols launched
                    * from. */}
                  <div className="magnetic-tier-ladder" aria-hidden="true">
                    {TIER_PERCENTS.map(pct => (
                      <span
                        key={pct}
                        className="magnetic-tier"
                        style={{ '--tier-pct': `${pct}%` }}
                      >
                        {pct}%
                      </span>
                    ))}
                  </div>

                  {/* Per-symbol pulled — each lands in its own tier,
                    * stacked downward when multiple share a tier. */}
                  {pulledItems.map(({ sym, idx, tier, stackIdx }) => (
                    <span
                      key={idx}
                      className="magnetic-pulled-symbol"
                      style={{
                        '--tier-pct': `${tier}%`,
                        '--stack-idx': stackIdx,
                      }}
                    >
                      {sym.emoji}
                    </span>
                  ))}

                  {/* Column payout pill — appears once everything
                    * across all five columns has settled. */}
                  {showPayout && (
                    <span className="magnetic-reel-payout">
                      +{formatCurrency(payout, currency, rates)}
                    </span>
                  )}
                </div>
              )
            })}
          </div>

          {/* ── Reels ──
            * Each cell hides its strip the instant `pulledRows[ci]`
            * passes its row index — UNLESS the symbol at that row
            * is a scatter (⚡): scatters never get pulled, so their
            * cell keeps showing the symbol through the entire
            * pull phase.
            */}
          <div className="magnetic-reels">
            {cellStrips.map((col, ci) => {
              const rows = pulledRows[ci]
              return (
                <div key={ci} className="magnetic-reel">
                  {col.map((strip, ri) => {
                    const finalSym = finalGrid[ci]?.[ri]
                    const isScatter = finalSym?.isScatter
                    const released = rows > ri && !isScatter
                    return (
                      <span key={ri} className="magnetic-cell">
                        {!released && (
                          <div
                            className="magnetic-strip"
                            style={{
                              transform: `translateY(calc(var(--cell-h) * ${strip.ty}))`,
                              transition: strip.td > 0
                                ? `transform ${strip.td}ms cubic-bezier(0.18, 0.6, 0.32, 1)`
                                : 'none',
                            }}
                          >
                            {strip.symbols.map((sym, si) => (
                              <span key={si} className="magnetic-strip-sym">
                                {sym.emoji}
                              </span>
                            ))}
                          </div>
                        )}
                      </span>
                    )
                  })}
                </div>
              )
            })}
          </div>
        </main>

        {/* Win bar — OUTSIDE the stage frame, like the user asked. */}
        <div className={'magnetic-winbar' + (lastWin > 0 ? ' is-win' : '')}>
          <span className="magnetic-winbar-label">{t.slotPotential || 'Выигрыш'}</span>
          <strong className="magnetic-winbar-value">
            {winLabel ?? formatCurrency(0, currency, rates)}
          </strong>
        </div>

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
