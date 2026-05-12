import React, { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useShallow } from 'zustand/react/shallow'
import useGameStore from '../store/useGameStore'
import { translations } from '../lib/i18n'
import { formatCurrency } from '../lib/currency'
import { haptic } from '../lib/telegram'
import './MagneticSlot.css'

// 16×16 textures. Vite resolves these to hashed asset URLs at
// build time; we attach them inline as background-image so the
// CSS stays purely stylistic and the textures stay data-driven.
import texCoin    from '../assets/games/magnetic/coin.png'
import texBolt    from '../assets/games/magnetic/bolt.png'
import texCompass from '../assets/games/magnetic/compas.png'
import texOrb     from '../assets/games/magnetic/plazm_orb.png'
import texGem     from '../assets/games/magnetic/scatter.png'
import texMagnet  from '../assets/games/magnetic/magnet.png'

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
// scatter symbol always lands in the same tier cell. 💎 gem is
// the SCATTER: it doesn't get pulled toward the magnet, just
// stays put in its reel cell. (Bonus mechanic for N+ scatters is
// left open for later; for now it just doesn't contribute to
// payout.)
const SYMBOLS = [
  { id: 'blank',   texture: null,        strength: 0,    weight: 30 },
  { id: 'coin',    texture: texCoin,     strength: 0.25, weight: 32 },
  { id: 'bolt',    texture: texBolt,     strength: 0.50, weight: 20 },
  { id: 'compass', texture: texCompass,  strength: 0.75, weight: 11 },
  { id: 'orb',     texture: texOrb,      strength: 1.00, weight: 5  },
  { id: 'gem',     texture: texGem,      strength: 0,    weight: 2, isScatter: true },
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

// Two separate payout divisors — base spins and bonus FS use
// different ones so we can shift more of the total RTP weight
// into the bonus event without breaking base-game feel.
//   BASE_DIVISOR  = 115  → ~53 % base RTP
//   BONUS_DIVISOR =  23  → ~135× avg bonus payout
//   Combined total RTP ≈ 95.5 % (verified by Monte-Carlo on 1 M
//   spins in scripts/magnetic-rtp-sim.js).
const BASE_DIVISOR  = 115
const BONUS_DIVISOR = 23

// ── Bonus tuning ──
// 3+ 💎 scatters anywhere on the 15-cell grid trigger the bonus.
const SCATTERS_TO_TRIGGER = 3
// Number of free spins awarded when triggered.
const BONUS_FREE_SPINS    = 10

// Hard cap on a single spin's combined payout (base + bonus).
// 5000× stake — safety net for extreme tails. In practice
// observed max in 1 M sims sits well below this (~660×), so the
// cap rarely fires; keeping it future-proofs against weight
// re-tunes that could create much higher tails.
const MAX_PAYOUT_CAP = 5000

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

  // ── Bonus state ──
  // bonusPhase :  idle | scatter-pulse | overlay-intro | merge-magnets
  //               | bonus-fs | overlay-end
  // bonusSpinsLeft : counter for the 4 free spins
  // bonusMegaMult  : sum of the 5 magnets from the triggering spin —
  //                  used as the SINGLE mega-magnet for every FS
  // bonusTotalWin  : cumulative win across all FS, shown on the
  //                  end overlay
  // scatterPositions : [{ ci, ri }, ...] — the cells that pulse
  //                  during the scatter-pulse phase
  // magnetsMerged  : flips true during merge animation +
  //                  bonus-fs phase so the header renders one
  //                  giant magnet instead of five separate ones
  const [bonusPhase, setBonusPhase]               = useState('idle')
  const [bonusSpinsLeft, setBonusSpinsLeft]       = useState(0)
  const [bonusMegaMult, setBonusMegaMult]         = useState(0)
  const [bonusTotalWin, setBonusTotalWin]         = useState(0)
  const [scatterPositions, setScatterPositions]   = useState([])
  const [magnetsMerged, setMagnetsMerged]         = useState(false)
  // Buy-bonus confirmation modal — opens on the FAB tap, closes
  // on cancel/backdrop click, or fires confirmBuyBonus which
  // debits 100× stake and runs a spin with 3 forced scatters.
  const [buyBonusConfirm, setBuyBonusConfirm]     = useState(false)
  const [exitConfirm, setExitConfirm]   = useState(false)

  // ── Refs for stable async access ──
  const balanceRef    = useRef(balance)
  const stakeRef      = useRef(stake)
  const spinningRef   = useRef(false)
  const autoRef       = useRef(false)
  const cancelRef     = useRef(false)
  const bonusPhaseRef     = useRef('idle')
  const bonusMegaMultRef  = useRef(0)
  const bonusTotalWinRef  = useRef(0)

  useEffect(() => { balanceRef.current = balance }, [balance])
  useEffect(() => { stakeRef.current   = stake },   [stake])
  useEffect(() => { autoRef.current    = autoSpin }, [autoSpin])
  useEffect(() => { bonusPhaseRef.current = bonusPhase }, [bonusPhase])
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

  async function spin({ bonusMode = false, forceScatters = false } = {}) {
    if (spinningRef.current) return
    if (!bonusMode && balanceRef.current < stakeRef.current) return

    spinningRef.current = true
    setSpinning(true)
    haptic('light')

    // Reset everything from the previous round.
    setPhase('spinning')
    setPulledRows(Array(REELS).fill(0))
    setShakingMagnet(null)
    setPayoutByCol(Array(REELS).fill(0))
    setLastWin(0)

    if (!bonusMode) {
      // Debit stake locally (dev-only). Bonus free spins are free —
      // payouts accumulate into bonusTotalWin and credit at the end
      // of the bonus sequence.
      const balanceAfterDebit = balanceRef.current - stakeRef.current
      balanceRef.current = balanceAfterDebit
      setBalance(balanceAfterDebit)
    }

    // ── Pick final outcome ──
    const finalGridArr = Array.from({ length: REELS }, () =>
      Array.from({ length: ROWS }, pickSymbol)
    )
    // Buy-bonus forces exactly 3 scatters into random positions so
    // the post-settle trigger detection always fires.
    if (forceScatters) {
      const gemSym = SYMBOLS.find(s => s.id === 'gem')
      const cells = []
      for (let ci = 0; ci < REELS; ci++) {
        for (let ri = 0; ri < ROWS; ri++) cells.push({ ci, ri })
      }
      // Shuffle and grab first 3 — that's our forced scatter set.
      for (let i = cells.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[cells[i], cells[j]] = [cells[j], cells[i]]
      }
      for (let n = 0; n < 3; n++) {
        const { ci, ri } = cells[n]
        finalGridArr[ci][ri] = gemSym
      }
    }
    // In bonus mode all 5 magnets are the SAME mega-magnet (sum of
    // the triggering spin's magnets); in normal mode each is rolled
    // independently from the weighted pool.
    const finalMagnetsArr = bonusMode
      ? Array(REELS).fill(bonusMegaMultRef.current)
      : Array.from({ length: REELS }, pickMagnet)
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
    // strength × magnet × stake / DIVISOR. Scatters (💎) and
    // blanks contribute 0. Base spins use BASE_DIVISOR, bonus
    // FS use the smaller BONUS_DIVISOR so each FS pays bigger.
    const divisor = bonusMode ? BONUS_DIVISOR : BASE_DIVISOR
    const payouts = finalGridArr.map((col, ci) => {
      let sumStrength = 0
      for (const sym of col) {
        if (sym.isScatter) continue
        sumStrength += sym.strength
      }
      return Math.round(
        (sumStrength * finalMagnetsArr[ci] * stakeRef.current) / divisor
      )
    })
    let winTotal = payouts.reduce((s, p) => s + p, 0)
    // Hard payout cap — applies to the single spin's win. The
    // bonus session's cumulative cap is enforced separately when
    // crediting the balance at end of runBonusSequence.
    const spinCap = MAX_PAYOUT_CAP * stakeRef.current
    if (winTotal > spinCap) winTotal = spinCap

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
        // Skip the inter-symbol wait when the row is blank — the
        // cell was already empty so dwelling on it reads as a
        // freeze.
        if (sym && sym.texture) {
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
      if (bonusMode) {
        // Accumulate the bonus winnings into the bonus pot —
        // they credit to the balance at the end of the bonus
        // sequence, not now.
        const newBonusTotal = bonusTotalWinRef.current + winTotal
        bonusTotalWinRef.current = newBonusTotal
        setBonusTotalWin(newBonusTotal)
      } else {
        const nb = balanceRef.current + winTotal
        balanceRef.current = nb
        setBalance(nb)
        if (typeof setBalanceBounce === 'function') {
          setBalanceBounce(true)
          setTimeout(() => setBalanceBounce(false), 540)
        }
      }
      haptic('success')
    } else {
      haptic('light')
    }

    setPhase('settled')
    spinningRef.current = false
    setSpinning(false)

    // ── Bonus trigger detection ──
    // After a NORMAL spin settles (not during the bonus FS), check
    // whether the final grid contains 3+ scatters. If yes, kick
    // off the bonus sequence right here — autoLoop is gated on
    // spinningRef which we just released, so runBonusSequence is
    // free to run its own awaits without overlap.
    if (!bonusMode && bonusPhaseRef.current === 'idle') {
      const scatters = []
      for (let ci = 0; ci < REELS; ci++) {
        for (let ri = 0; ri < ROWS; ri++) {
          const sym = finalGridArr[ci][ri]
          if (sym && sym.isScatter) scatters.push({ ci, ri })
        }
      }
      if (scatters.length >= SCATTERS_TO_TRIGGER) {
        await runBonusSequence(scatters, finalMagnetsArr)
      }
    }
  }

  // ── Bonus sequence orchestrator ──
  // Drives the 6-phase bonus flow the user spec'd:
  //   1. scatter-pulse  — darken the field, pulse the scatters
  //   2. overlay-intro  — modal "FREE SPINS / 4"
  //   3. merge-magnets  — 5 magnets fuse into ONE mega-magnet
  //   4. bonus-fs       — 4 free spins, all under the mega-magnet
  //   5. overlay-end    — modal "BONUS COMPLETE / +N₽"
  //   6. idle           — credit total, reset bonus state
  async function runBonusSequence(scatters, triggerMagnets) {
    // 1) Scatter pulse — field darkens, scatters bounce. The
    //    just-settled pulled symbols stay visible; the scatters
    //    in their reel cells also stay (they're scatters, they
    //    never get pulled).
    setScatterPositions(scatters)
    setBonusPhase('scatter-pulse')
    bonusPhaseRef.current = 'scatter-pulse'
    haptic('success')
    await sleep(1600)
    if (cancelRef.current) return

    // 2) Compute the mega-mult: sum of all 5 magnets from the
    //    spin that triggered the bonus. That number becomes the
    //    SINGLE multiplier every free spin shares.
    const megaMult = triggerMagnets.reduce((a, b) => a + b, 0)
    bonusMegaMultRef.current = megaMult
    setBonusMegaMult(megaMult)

    // 3) Intro overlay — "FREE SPINS / 4"
    setBonusSpinsLeft(BONUS_FREE_SPINS)
    setBonusPhase('overlay-intro')
    bonusPhaseRef.current = 'overlay-intro'
    await sleep(2400)
    if (cancelRef.current) return

    // 4) Clear the field (pulled symbols vanish, tier ladder
    //    reverts to default brightness) so the merge animation
    //    plays on a clean stage. Then start the merge — the 5
    //    magnet cells animate into a single mega-magnet via CSS
    //    (.magnets-merged class on the magnets row).
    setPulledRows(Array(REELS).fill(0))
    setScatterPositions([])
    setPayoutByCol(Array(REELS).fill(0))
    setLastWin(0)
    setMagnetsMerged(true)
    setBonusPhase('merge-magnets')
    bonusPhaseRef.current = 'merge-magnets'
    await sleep(1400)
    if (cancelRef.current) return

    // 5) Free-spin loop — 4 default spins, each with the mega
    //    magnet held constant. Spin() handles bonusMode internally
    //    (no stake debit, payouts → bonusTotalWin, no shuffle of
    //    finalMagnets).
    bonusTotalWinRef.current = 0
    setBonusTotalWin(0)
    setBonusPhase('bonus-fs')
    bonusPhaseRef.current = 'bonus-fs'
    for (let i = 0; i < BONUS_FREE_SPINS; i++) {
      if (cancelRef.current) break
      setBonusSpinsLeft(BONUS_FREE_SPINS - i)
      // Release the spinning gate so the nested spin() doesn't
      // see itself as already-running and bail.
      spinningRef.current = false
      await spin({ bonusMode: true })
      await sleep(500)
    }
    setBonusSpinsLeft(0)
    if (cancelRef.current) return

    // 6) End overlay — "BONUS COMPLETE / +N₽"
    setBonusPhase('overlay-end')
    bonusPhaseRef.current = 'overlay-end'
    await sleep(3200)
    if (cancelRef.current) return

    // Credit the accumulated bonus winnings to the balance, with
    // the hard cap applied (extreme tails capped at 5000 × stake).
    let total = bonusTotalWinRef.current
    const bonusCap = MAX_PAYOUT_CAP * stakeRef.current
    if (total > bonusCap) total = bonusCap
    if (total > 0) {
      const nb = balanceRef.current + total
      balanceRef.current = nb
      setBalance(nb)
      if (typeof setBalanceBounce === 'function') {
        setBalanceBounce(true)
        setTimeout(() => setBalanceBounce(false), 540)
      }
      haptic('success')
    }

    // Reset bonus state — back to a normal spin loop.
    setMagnetsMerged(false)
    setBonusMegaMult(0)
    bonusMegaMultRef.current = 0
    setBonusTotalWin(0)
    bonusTotalWinRef.current = 0
    setBonusPhase('idle')
    bonusPhaseRef.current = 'idle'
  }

  async function autoLoop() {
    while (autoRef.current && !cancelRef.current) {
      // Wait for any active bonus sequence to finish — bonus runs
      // its own free spins via runBonusSequence and shouldn't be
      // overlapped by the auto-loop's stake spins.
      while (bonusPhaseRef.current !== 'idle' && !cancelRef.current && autoRef.current) {
        await sleep(120)
      }
      if (!autoRef.current || cancelRef.current) break
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
    if (bonusPhase !== 'idle') return    // bonus drives itself
    spin()
  }

  // ── Buy-bonus controls ──
  // Tap opens the confirmation modal. Confirm actually debits
  // BUY_BONUS_MULT × stake and fires a spin that's guaranteed to
  // drop 3 scatters → trigger detection picks them up at the end
  // of the spin and runs the standard bonus sequence.
  //
  // Cost = 100 × stake. With the new 10-FS / BONUS_DIVISOR=23
  // bonus structure the avg return is ~135 × stake, giving a
  // Buy-EV around 135 % — slightly player-favoured (encourages
  // buying) but the bonus trigger rate (~1 / 320) means the
  // average player who only plays base game sees ~95 % RTP
  // overall.
  const BUY_BONUS_MULT = 100
  function onBuyBonusClick() {
    if (autoSpin || spinning) return
    if (bonusPhase !== 'idle') return
    const cost = stakeRef.current * BUY_BONUS_MULT
    if (balanceRef.current < cost) return
    haptic('light')
    setBuyBonusConfirm(true)
  }
  function confirmBuyBonus() {
    setBuyBonusConfirm(false)
    if (autoSpin || spinning) return
    if (bonusPhase !== 'idle') return
    const cost = stakeRef.current * BUY_BONUS_MULT
    if (balanceRef.current < cost) return
    // Debit the bonus cost up-front. The follow-on spin() will
    // try to debit `stake` itself unless we set bonusMode — but
    // for buy-bonus we want the spin to LOOK like a normal stake
    // spin (it produces the scatter trigger), so we manually
    // pre-debit the bonus cost MINUS one regular stake (spin()
    // takes that one itself).
    haptic('medium')
    const overcharge = cost - stakeRef.current
    const newBalance = balanceRef.current - overcharge
    balanceRef.current = newBalance
    setBalance(newBalance)
    // Run a regular spin that's guaranteed to seed 3 scatters
    // in the grid — trigger detection at settle time picks them
    // up and runs the bonus sequence as normal.
    spin({ forceScatters: true })
  }

  function onAutoClick() {
    if (autoSpin) { setAutoSpin(false); autoRef.current = false; return }
    if (!canAfford || spinning) return
    if (bonusPhase !== 'idle') return
    setAutoSpin(true); autoRef.current = true
    autoLoop()
  }

  return (
    <div className={`magnetic-slot-page magnetic-slot-page--${phase}`}>
      <div className="magnetic-game-window">
        <main className={'magnetic-stage' + (bonusPhase === 'scatter-pulse' ? ' is-scatter-pulse' : '') + (bonusPhase === 'bonus-fs' || bonusPhase === 'merge-magnets' ? ' is-bonus' : '')} aria-label="Magnetic">
          {/* ── Magnets row ──
            * Two modes:
            *   - default: 5 magnets, each scrolling its own strip
            *   - merged : ONE giant magnet in the centre during the
            *              bonus FS, mult = sum of the 5 triggering
            *              magnets
            */}
          <div className={'magnetic-magnets' + (magnetsMerged ? ' is-merged' : '')}>
            {magnetsMerged && (
              <div className="magnetic-magnet-mega">
                <span className="magnetic-magnet-mult">×{bonusMegaMult}</span>
                <span
                  className="magnetic-magnet-body"
                  style={{ backgroundImage: `url("${texMagnet}")` }}
                />
              </div>
            )}
            {!magnetsMerged && magnetStrips.map((strip, mi) => {
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
                        {/* Mult label sits ON the magnet — rendered
                          * above the body, slightly overlapping its
                          * top arch so it reads as a label resting
                          * on the horseshoe. */}
                        <span className="magnetic-magnet-mult">×{mult}</span>
                        <span
                          className="magnetic-magnet-body"
                          style={{ backgroundImage: `url("${texMagnet}")` }}
                        />
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
                if (!sym || sym.isScatter || sym.strength === 0 || !sym.texture) continue
                const tier = Math.round(sym.strength * 100)
                const stackIdx = tierCounters[tier] || 0
                tierCounters[tier] = stackIdx + 1
                pulledItems.push({ sym, idx, tier, stackIdx })
              }

              // Which tier cells in this column ended up empty
              // (no symbol landed). When the round is settled we
              // darken those cells so the eye reads the "winning"
              // tiers at a glance.
              const filledTiers = phase === 'settled'
                ? new Set(pulledItems.map(p => p.tier))
                : null

              return (
                <div key={ci} className="magnetic-pull-col">
                  {/* Tier ladder — 4 SQUARE transparent cells per
                    * column at 100 / 75 / 50 / 25 % reach heights.
                    * Each one is `--cell-h` square (same size as
                    * a reel spin cell) so it reads as a landing
                    * box of the same family the symbols launched
                    * from. */}
                  <div className="magnetic-tier-ladder" aria-hidden="true">
                    {TIER_PERCENTS.map(pct => {
                      const isEmpty = filledTiers != null && !filledTiers.has(pct)
                      return (
                        <span
                          key={pct}
                          className={'magnetic-tier' + (isEmpty ? ' is-empty' : '')}
                          style={{ '--tier-pct': `${pct}%` }}
                        >
                          {pct}%
                        </span>
                      )
                    })}
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
                        backgroundImage: `url("${sym.texture}")`,
                      }}
                    />
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
                    // During scatter-pulse phase, the cells that
                    // contain the triggering scatters bounce to
                    // signal the bonus is launching.
                    const isPulsing = bonusPhase === 'scatter-pulse' &&
                                      isScatter &&
                                      scatterPositions.some(p => p.ci === ci && p.ri === ri)
                    return (
                      <span
                        key={ri}
                        className={'magnetic-cell' + (isPulsing ? ' is-scatter-bouncing' : '')}
                      >
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
                              <span
                                key={si}
                                className="magnetic-strip-sym"
                                style={sym.texture ? { backgroundImage: `url("${sym.texture}")` } : undefined}
                              />
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

        {/* ── Winbar row ──
          *   [ BUY BONUS ]  [ Winbar ]
          * Winbar shows the CUMULATIVE bonusTotalWin during the
          * FS run and end overlay; otherwise it shows the most
          * recent spin's win as before. */}
        {(() => {
          const isBonusWin = bonusPhase === 'bonus-fs' || bonusPhase === 'overlay-end'
          const displayWin = isBonusWin ? bonusTotalWin : lastWin
          const displayLabel = displayWin > 0
            ? `+${formatCurrency(displayWin, currency, rates)}`
            : formatCurrency(0, currency, rates)
          return (
            <div className="magnetic-winbar-row">
              <button
                type="button"
                className="magnetic-buy-bonus-btn"
                onClick={onBuyBonusClick}
                disabled={
                  spinning ||
                  autoSpin ||
                  bonusPhase !== 'idle' ||
                  balance < stake * BUY_BONUS_MULT
                }
                aria-label="Buy Bonus"
              >
                <span className="magnetic-buy-bonus-btn-icon">💎</span>
                <span className="magnetic-buy-bonus-btn-text">BUY</span>
              </button>
              <div className={'magnetic-winbar' + (displayWin > 0 ? ' is-win' : '')}>
                <span className="magnetic-winbar-label">
                  {isBonusWin ? 'Бонус' : (t.slotPotential || 'Выигрыш')}
                </span>
                <strong className="magnetic-winbar-value">{displayLabel}</strong>
              </div>
            </div>
          )
        })()}

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
              disabled={!autoSpin && (!canAfford || spinning || bonusPhase !== 'idle')}
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
              disabled={!autoSpin && (!canAfford || spinning || bonusPhase !== 'idle')}
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

        {/* ── Bonus overlays ──
          * Intro shows when the scatter trigger fires:
          *     "FREE SPINS / 4"
          * End shows after the last bonus spin:
          *     "BONUS COMPLETE / +N₽"
          */}
        {(bonusPhase === 'overlay-intro' || bonusPhase === 'overlay-end') && (
          <div className="magnetic-bonus-overlay">
            <div className="magnetic-bonus-card">
              {bonusPhase === 'overlay-intro' && (
                <>
                  <div className="magnetic-bonus-title">FREE SPINS</div>
                  <div className="magnetic-bonus-count">{BONUS_FREE_SPINS}</div>
                  <div className="magnetic-bonus-sub">
                    Mega Magnet ×{bonusMegaMult}
                  </div>
                </>
              )}
              {bonusPhase === 'overlay-end' && (
                <>
                  <div className="magnetic-bonus-title">BONUS COMPLETE</div>
                  <div className="magnetic-bonus-total">
                    +{formatCurrency(bonusTotalWin, currency, rates)}
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* Small indicator pinned in the corner of the stage
          * showing how many free spins remain. */}
        {bonusPhase === 'bonus-fs' && (
          <div className="magnetic-bonus-indicator">
            <span>FREE SPINS</span>
            <strong>{bonusSpinsLeft}</strong>
          </div>
        )}

        {/* Buy-bonus confirmation modal — styled in the slot's
          * violet/fuchsia theme. Tap backdrop OR cancel button
          * to dismiss; "Купить" debits 100× stake and fires the
          * forced-scatter spin. */}
        {buyBonusConfirm && (
          <div
            className="magnetic-buy-modal-backdrop"
            onClick={() => setBuyBonusConfirm(false)}
          >
            <div
              className="magnetic-buy-modal-card"
              onClick={e => e.stopPropagation()}
            >
              <h3 className="magnetic-buy-modal-title">BUY BONUS</h3>
              <div className="magnetic-buy-modal-cost">
                <span>Стоимость</span>
                <strong>{formatCurrency(stake * BUY_BONUS_MULT, currency, rates)}</strong>
              </div>
              <div className="magnetic-buy-modal-actions">
                <button
                  type="button"
                  className="magnetic-buy-modal-cancel"
                  onClick={() => { haptic('light'); setBuyBonusConfirm(false) }}
                >
                  Отмена
                </button>
                <button
                  type="button"
                  className="magnetic-buy-modal-buy"
                  onClick={confirmBuyBonus}
                >
                  Купить
                </button>
              </div>
            </div>
          </div>
        )}
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
