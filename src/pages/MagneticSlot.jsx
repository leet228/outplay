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

const SYMBOLS = [
  // Blank cells render NOTHING — empty cells are truly empty.
  { id: 'blank', emoji: '',   strength: 0,  weight: 30 },
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

// Tier ladder + the strength → tier mapping.
//
// Reach is now DISCRETE — column strength snaps to one of five
// tiers (0 / 25 / 50 / 75 / 100 %) so the pulled symbol stack
// lands cleanly inside whichever tier cell matches its strength.
// Thresholds are tuned for the symbol weights below:
//   ≤9  → 0     (a few bolts; no win)
//   10‒29 → 25   (a coin or two)
//   30‒54 → 50   (a trophy + something)
//   55‒89 → 75   (a gem or volt)
//   90+   → 100  (volt + gem combo / triple high)
function strengthToTier(s) {
  if (s < 10) return 0
  if (s < 30) return 0.25
  if (s < 55) return 0.5
  if (s < 90) return 0.75
  return 1.0
}

// Tier cells shown in each pull column — they tell the player
// "if your symbol stack lands in THIS cell, you keep this much
// of the magnet's multiplier." Big mults (≥10) round to integers;
// small mults keep a single decimal so the ×0.5 / ×1.5 fractions
// stay legible.
const TIER_PERCENTS = [100, 75, 50, 25]
function fmtTierMult(m) {
  if (m >= 10) return `${Math.round(m)}`
  if (Number.isInteger(m)) return `${m}`
  return m.toFixed(1).replace(/\.0$/, '')
}

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
  const [reachByCol, setReachByCol]     = useState(() => Array(REELS).fill(0))
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
    setReachByCol(Array(REELS).fill(0))
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

    // ── Compute reaches + payouts ──
    // Each column's strength snaps to a discrete tier so the
    // pulled stack lands inside one of the visible tier cells.
    const newReaches = finalGridArr.map(col => {
      const total = col.reduce((s, sym) => s + sym.strength, 0)
      return strengthToTier(total)
    })
    const payouts = newReaches.map((reach, ci) =>
      Math.round((reach * finalMagnetsArr[ci] * stakeRef.current) / REELS)
    )
    const winTotal = payouts.reduce((s, p) => s + p, 0)

    setReachByCol(newReaches)
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

      await sleep(COLUMN_GAP)
    }
    setShakingMagnet(null)

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
              const captured  = pulledRows[mi] === ROWS && (reachByCol[mi] || 0) === 1
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
            * Each column anchors a pulled-stack at the top of the
            * zone — its top edge sits at `100% - var(--reach)` from
            * the pull-zone TOP, so reach=100% pins the stack right
            * under its magnet. Pulled symbols are appended into the
            * stack one row at a time via the pulledRows state, each
            * one running its own fly-in animation on mount.
            */}
          <div className="magnetic-pull-zone" aria-hidden="true">
            {Array.from({ length: REELS }).map((_, ci) => {
              const reach     = reachByCol[ci] || 0
              const reachPct  = Math.round(reach * 100)
              const payout    = payoutByCol[ci]
              const rows      = pulledRows[ci]
              const allPulled = rows >= ROWS
              const magnetMult = finalMagnets[ci]
              return (
                <div
                  key={ci}
                  className={'magnetic-pull-col' + (rows > 0 ? ' is-pulling' : '')}
                  style={{ '--reach': `${reachPct}%` }}
                >
                  {/* Tier ladder — semi-transparent badges showing
                    * the multiplier you'd earn at each reach level.
                    * Their vertical positions are pinned to the
                    * pull-col height (top: 100% - tier%) so a
                    * symbol stack at, say, 50 % reach lines up
                    * exactly with the 50 % tier badge. */}
                  <div className="magnetic-tier-ladder" aria-hidden="true">
                    {TIER_PERCENTS.map(pct => {
                      const mult = (magnetMult * pct) / 100
                      return (
                        <span
                          key={pct}
                          className="magnetic-tier"
                          style={{ '--tier-pct': `${pct}%` }}
                        >
                          ×{fmtTierMult(mult)}
                        </span>
                      )
                    })}
                  </div>
                  {rows > 0 && reach > 0 && (
                    <div className="magnetic-pulled-stack">
                      {Array.from({ length: rows }).map((_, idx) => {
                        const sym = finalGrid[ci]?.[idx]
                        if (!sym || !sym.emoji) return null
                        return (
                          <span
                            key={idx}
                            className="magnetic-pulled-symbol"
                          >
                            {sym.emoji}
                          </span>
                        )
                      })}
                      {allPulled && payout > 0 && (
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

          {/* ── Reels ──
            * Each cell hides its strip the instant `pulledRows[ci]`
            * passes its row index — i.e. the moment that cell's
            * symbol has flown up into the stack, the cell goes
            * empty. Matches the user's "ничего не остаётся в ячейке"
            * requirement.
            */}
          <div className="magnetic-reels">
            {cellStrips.map((col, ci) => {
              const rows = pulledRows[ci]
              return (
                <div key={ci} className="magnetic-reel">
                  {col.map((strip, ri) => {
                    const released = rows > ri
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
