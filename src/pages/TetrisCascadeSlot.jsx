import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useShallow } from 'zustand/react/shallow'
import useGameStore from '../store/useGameStore'
import { translations } from '../lib/i18n'
import { formatCurrency } from '../lib/currency'
import { haptic } from '../lib/telegram'
import { startTetrisRound, finishTetrisRound } from '../lib/supabase'
import './TetrisCascadeSlot.css'

const BETS = [10, 25, 50, 100, 250, 500, 1000, 2000, 4000, 8000, 16000, 25000]
const MIN_BALANCE_RUB = 10
const SLOT_ID = 'tetris-cascade'

// Playfield 10 wide × 8 tall.
const COLS = 10
const ROWS = 8

const INITIAL_PIECES = 12
const COLOR_LINE_MIN = 7
const MAX_CASCADES = 6

// Special piece spawn rates.
const WILD_RATE = 0.08         // colour wildcard cells
const COIN_RATE = 0.045        // 1×1 scatter coins (trigger the bonus)
const COINS_TO_TRIGGER = 5     // coins on grid after initial drop → bonus

// Bonus configuration.
const BONUS_FREE_SPINS = 10
const BONUS_PIECE_MULS = [2, 3, 5, 10] // each cell carries one of these in bonus
const RAGE_MAX = 6              // line clears in bonus to fill the rage meter
// Visual reveal multiplier for the jackpot bonus tier. Matches v3
// SQL: jackpot mul = 800. The spin-time absolute cap
// (LEAST(stake × 1000, 200 000 ₽)) keeps payouts bounded at very
// high stakes.
const PERFECT_CLEAR_WIN_MUL = 800
const BUY_BONUS_COST_MUL = 100  // buy-in price = stake × this
// Single-spin payout cap mirroring the SQL hard cap.
const SINGLE_SPIN_PAYOUT_CAP = 200000

// Tetromino shapes (single rotation each).
const PIECES = {
  I: { color: 'cyan',   cells: [[0,0],[1,0],[2,0],[3,0]] },
  O: { color: 'yellow', cells: [[0,0],[1,0],[0,1],[1,1]] },
  T: { color: 'purple', cells: [[0,0],[1,0],[2,0],[1,1]] },
  L: { color: 'orange', cells: [[0,0],[1,0],[2,0],[0,1]] },
  J: { color: 'blue',   cells: [[0,0],[1,0],[2,0],[2,1]] },
  S: { color: 'green',  cells: [[1,0],[2,0],[0,1],[1,1]] },
  Z: { color: 'red',    cells: [[0,0],[1,0],[1,1],[2,1]] },
}
const PIECE_KEYS = Object.keys(PIECES)

// Match payouts (non-bonus). Tuned so a typical lucky spin lands in
// the 3-15× stake band. A really hot multi-cascade can creep into
// 30-50× territory but no further — no compounding cascade multiplier
// is applied, long chains just sum up.
const COLOR_RUN_MUL = { 7: 1, 8: 1, 9: 2, 10: 3 }

// ── Helpers ──
function makeEmptyGrid() {
  return Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => null))
}

function pieceWidth(cells) {
  return Math.max(...cells.map(c => c[0])) + 1
}

// Cells now store an OBJECT { color, mul, kind } instead of a string. null
// for empty, 'CLEARING' string for the flash phase.
function cellColor(cell) {
  if (!cell || cell === 'CLEARING') return null
  return cell.color
}
function isCellWild(cell)   { return cell && cell.kind === 'wild' }
function isCellCoin(cell)   { return cell && cell.kind === 'coin' }
function cellMul(cell)      { return cell?.mul || 1 }

function pickRandomPiece(opts = {}) {
  const { forceI, bonus, noSpecial } = opts
  // Specials only spawn outside the bonus round (kept simple — bonus
  // uses per-cell multipliers instead). noSpecial suppresses scatter
  // coins on dud / zero-pay spins so they can't accidentally trigger
  // the bonus during a no-payout round.
  if (!bonus && !forceI && !noSpecial) {
    if (Math.random() < COIN_RATE) {
      return { kind: 'coin', cells: [[0,0]], color: 'coin' }
    }
  }
  const k = forceI ? 'I' : PIECE_KEYS[Math.floor(Math.random() * PIECE_KEYS.length)]
  const wild = !bonus && !noSpecial && Math.random() < WILD_RATE
  return {
    kind: wild ? 'wild' : 'tetromino',
    type: k,
    cells: PIECES[k].cells,
    color: wild ? 'wild' : PIECES[k].color,
  }
}

function makeCell(piece) {
  const base = { kind: piece.kind, color: piece.color, mul: 1 }
  return base
}

function canPlace(grid, cells, x, y) {
  return cells.every(([cx, cy]) => {
    const gx = x + cx, gy = y + cy
    if (gx < 0 || gx >= COLS || gy < 0 || gy >= ROWS) return false
    if (grid[gy][gx] !== null) return false
    return true
  })
}

function dropPiece(grid, piece, x, mulProvider) {
  let y = 0
  while (canPlace(grid, piece.cells, x, y + 1)) y++
  const newGrid = grid.map(row => [...row])
  for (const [cx, cy] of piece.cells) {
    const gx = x + cx, gy = y + cy
    if (gy >= 0 && gy < ROWS && gx >= 0 && gx < COLS) {
      const cell = makeCell(piece)
      if (mulProvider) cell.mul = mulProvider()
      newGrid[gy][gx] = cell
    }
  }
  return { grid: newGrid, landY: y }
}

function columnHeights(grid) {
  const h = []
  for (let c = 0; c < COLS; c++) {
    let height = 0
    for (let r = 0; r < ROWS; r++) {
      if (grid[r][c] !== null) { height = ROWS - r; break }
    }
    h.push(height)
  }
  return h
}

function countHoles(grid) {
  let holes = 0
  for (let c = 0; c < COLS; c++) {
    let seen = false
    for (let r = 0; r < ROWS; r++) {
      const cell = grid[r][c]
      if (cell !== null && cell !== 'CLEARING') seen = true
      else if (seen && cell === null) holes++
    }
  }
  return holes
}

function pickColumn(grid, piece, opts = {}) {
  // clearWeight  > 0  → AI loves clears (default smart-drop).
  // clearWeight <= 0  → AI strictly avoids clears (used for "dud" rounds
  //                     where the server has decided this spin pays
  //                     nothing — no cascade animations should fire).
  const { clearWeight = 12 } = opts
  const w = pieceWidth(piece.cells)
  const candidates = []
  for (let x = 0; x <= COLS - w; x++) {
    if (!canPlace(grid, piece.cells, x, 0)) continue
    const { grid: simGrid } = dropPiece(grid, piece, x)
    const matches = findMatches(simGrid)
    const cleared = matches.reduce((s, m) => s + m.cells.length, 0)
    const heights = columnHeights(simGrid)
    const aggHeight = heights.reduce((a, b) => a + b, 0)
    const maxHeight = Math.max(...heights)
    const holes = countHoles(simGrid)
    const score =
      cleared * clearWeight
      - aggHeight * 0.7
      - maxHeight * 1.0
      - holes * 30
      + Math.random() * 18
    candidates.push({ x, score, cleared })
  }
  if (candidates.length === 0) return -1

  // Anti-match (dud) mode — ONLY consider placements that produce no
  // clears. If every available placement would force a match (very
  // rare on an open board), bail out and skip this piece entirely so
  // a stray cascade never fires on a dud round.
  let pool = candidates
  if (clearWeight < 0) {
    pool = candidates.filter(c => c.cleared === 0)
    if (pool.length === 0) return -1
  }

  pool.sort((a, b) => b.score - a.score)
  const top = pool.slice(0, Math.min(2, pool.length))
  return top[Math.floor(Math.random() * top.length)].x
}

// Local dev-mode outcome generator. Mirrors the SQL function in
// migration_tetris_rtp_v2.sql so the slot is playable without a
// Supabase connection. Used when user is the mock dev user.
function decideTetrisOutcomeDev(stake, isBought) {
  const roll = Math.random()
  let outcome_kind, bonus_kind = null
  // Distribution mirrors migration_tetris_rtp_v4.sql.
  //
  // Regular spin (paid):
  //   dud 74.6 %, small 18 %, medium 5 %, big 1.5 %, huge 0.8 %, bonus 0.1 %
  // In-spin bonus tiers: small 55 %, medium 28 %, big 14 %, jackpot 3 %
  //   (E[mul] ≈ 120 ⇒ contribution to RTP ≈ 12 pp)
  //
  // Bought bonus (cost = stake × 100): tilted to small for ~80 % RTP
  //   on the buy feature.
  //   small 70 %, medium 23 %, big 6 %, jackpot 1 %  (E[mul] ≈ 81)
  //
  // Dev mode skips the deficit circuit-breaker (no slot_stats access).
  if (isBought) {
    outcome_kind = 'bonus'
    if      (roll < 0.70) bonus_kind = 'small'
    else if (roll < 0.93) bonus_kind = 'medium'
    else if (roll < 0.99) bonus_kind = 'big'
    else                  bonus_kind = 'jackpot'
  } else {
    if      (roll < 0.746)                                outcome_kind = 'dud'
    else if (roll < 0.746 + 0.180)                        outcome_kind = 'small'
    else if (roll < 0.746 + 0.180 + 0.050)                outcome_kind = 'medium'
    else if (roll < 0.746 + 0.180 + 0.050 + 0.015)        outcome_kind = 'big'
    else if (roll < 0.746 + 0.180 + 0.050 + 0.015 + 0.008) outcome_kind = 'huge'
    else {
      outcome_kind = 'bonus'
      const r2 = Math.random()
      if      (r2 < 0.55) bonus_kind = 'small'
      else if (r2 < 0.83) bonus_kind = 'medium'
      else if (r2 < 0.97) bonus_kind = 'big'
      else                bonus_kind = 'jackpot'
    }
  }
  let mul = 0
  if (outcome_kind === 'dud') mul = 0
  else if (outcome_kind === 'small')  mul = 1  + Math.floor(Math.random() * 2)        // 1-2
  else if (outcome_kind === 'medium') mul = 3  + Math.floor(Math.random() * 4)        // 3-6
  else if (outcome_kind === 'big')    mul = 7  + Math.floor(Math.random() * 7)        // 7-13
  else if (outcome_kind === 'huge')   mul = 18 + Math.floor(Math.random() * 12)       // 18-29
  else if (outcome_kind === 'bonus') {
    if      (bonus_kind === 'small')   mul = 25  + Math.floor(Math.random() * 36)     // 25-60
    else if (bonus_kind === 'medium')  mul = 70  + Math.floor(Math.random() * 81)     // 70-150
    else if (bonus_kind === 'big')     mul = 200 + Math.floor(Math.random() * 201)    // 200-400
    else if (bonus_kind === 'jackpot') mul = 800
  }
  // Mirror the SQL hard cap: LEAST(stake × mul, stake × 1000, 200_000)
  const target = Math.min(stake * mul, stake * 1000, SINGLE_SPIN_PAYOUT_CAP)
  return {
    ok: true,
    round_id: `dev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    outcome_kind,
    target_payout_rub: target,
    bonus_kind,
    is_bought: isBought,
  }
}

// Clamp a single-spin payout to the same cap the SQL applies. Used as
// a defensive filter on bonus slices so a "big bonus on a high stake"
// can never produce a single free spin paying more than the cap.
function clampSpinPayout(value, stake) {
  return Math.min(value, stake * 1000, SINGLE_SPIN_PAYOUT_CAP)
}

// Slice a bonus round's total payout across N free spins. Used when the
// server returns target_payout_rub for the whole bonus — the frontend
// then plays each spin so its visual win matches its assigned slice.
//
// jackpot:   one spin gets the entire prize (Perfect Clear); the rest pay 0
// empty:     mostly zeros, a couple of tiny scraps
// otherwise: random distribution biased toward 1-3 "big" spins
function distributeBonusPayout(totalPayout, spinCount, bonusKind) {
  const slices = new Array(spinCount).fill(0)
  if (totalPayout <= 0 || spinCount <= 0) return slices

  if (bonusKind === 'jackpot') {
    const idx = Math.floor(Math.random() * spinCount)
    slices[idx] = totalPayout
    return slices
  }

  // Pick which spins win at all.
  const winRate = bonusKind === 'empty' ? 0.25 : 0.7
  const winners = []
  for (let i = 0; i < spinCount; i++) {
    if (Math.random() < winRate) winners.push(i)
  }
  if (winners.length === 0) winners.push(Math.floor(Math.random() * spinCount))

  // Random weights, then normalize to total.
  const weights = winners.map(() => Math.random() * Math.random() + 0.05)
  const wSum = weights.reduce((a, b) => a + b, 0)
  let assigned = 0
  for (let i = 0; i < winners.length - 1; i++) {
    const slice = Math.round(totalPayout * (weights[i] / wSum))
    slices[winners[i]] = slice
    assigned += slice
  }
  // Last winner gets the remainder so the total matches exactly.
  slices[winners[winners.length - 1]] = Math.max(0, totalPayout - assigned)

  return slices
}

// ── Match detection ──
// Coins block placement (isFilled === true) but never participate in
// matches: they don't complete rows / columns, and they don't extend
// colour runs.
function isFilled(cell) {
  return cell !== null && cell !== 'CLEARING'
}

// A cell that can be part of a full row / column match. Excludes scatter
// coins so a row containing a coin never clears via line completion.
function isLineFiller(cell) {
  return isFilled(cell) && !isCellCoin(cell)
}

function colourOf(cell) {
  if (!isFilled(cell)) return null
  // Coins are inert — they break colour runs and never participate in
  // colour matches.
  if (isCellCoin(cell)) return null
  return cell.color
}

function colourMatchesRun(runColor, cellColorVal) {
  if (cellColorVal === null) return false
  if (cellColorVal === 'wild') return true
  return runColor === 'wild' || runColor === cellColorVal
}

function findMatches(grid) {
  const matches = []

  for (let r = 0; r < ROWS; r++) {
    if (grid[r].every(isLineFiller)) {
      const cells = []
      for (let c = 0; c < COLS; c++) cells.push([c, r])
      matches.push({ type: 'row', cells, mul: 1 })
    }
  }

  for (let c = 0; c < COLS; c++) {
    let full = true
    for (let r = 0; r < ROWS; r++) {
      if (!isLineFiller(grid[r][c])) { full = false; break }
    }
    if (full) {
      const cells = []
      for (let r = 0; r < ROWS; r++) cells.push([c, r])
      matches.push({ type: 'col', cells, mul: 2 })
    }
  }

  // Horizontal colour runs ≥ COLOR_LINE_MIN
  for (let r = 0; r < ROWS; r++) {
    let runStart = 0
    let runColor = null
    let allWild = true
    const closeRun = (endC) => {
      const len = endC - runStart
      if (len >= COLOR_LINE_MIN && runColor !== null && runColor !== 'wild' || (len >= COLOR_LINE_MIN && !allWild)) {
        // Only emit if we have a real (non-all-wild) colour.
        if (allWild) return
        const cells = []
        for (let i = runStart; i < endC; i++) cells.push([i, r])
        const mul = COLOR_RUN_MUL[Math.min(len, 10)] || COLOR_RUN_MUL[10]
        matches.push({ type: 'color-h', cells, mul, color: runColor, len })
      }
    }
    for (let c = 0; c <= COLS; c++) {
      const cell = c < COLS ? grid[r][c] : null
      const cv = colourOf(cell)
      if (cv === null) {
        closeRun(c)
        runStart = c + 1
        runColor = null
        allWild = true
      } else if (runColor === null) {
        runStart = c
        runColor = cv
        allWild = (cv === 'wild')
      } else if (colourMatchesRun(runColor, cv)) {
        if (cv !== 'wild') { runColor = cv; allWild = false }
      } else {
        closeRun(c)
        runStart = c
        runColor = cv
        allWild = (cv === 'wild')
      }
    }
  }

  // Vertical colour runs
  for (let c = 0; c < COLS; c++) {
    let runStart = 0
    let runColor = null
    let allWild = true
    const closeRun = (endR) => {
      const len = endR - runStart
      if (len >= COLOR_LINE_MIN && !allWild && runColor !== null && runColor !== 'wild') {
        const cells = []
        for (let i = runStart; i < endR; i++) cells.push([c, i])
        const mul = COLOR_RUN_MUL[Math.min(len, 10)] || COLOR_RUN_MUL[10]
        matches.push({ type: 'color-v', cells, mul, color: runColor, len })
      }
    }
    for (let r = 0; r <= ROWS; r++) {
      const cell = r < ROWS ? grid[r][c] : null
      const cv = colourOf(cell)
      if (cv === null) {
        closeRun(r)
        runStart = r + 1
        runColor = null
        allWild = true
      } else if (runColor === null) {
        runStart = r
        runColor = cv
        allWild = (cv === 'wild')
      } else if (colourMatchesRun(runColor, cv)) {
        if (cv !== 'wild') { runColor = cv; allWild = false }
      } else {
        closeRun(r)
        runStart = r
        runColor = cv
        allWild = (cv === 'wild')
      }
    }
  }

  return matches
}

function markClearing(grid, cellSet) {
  return grid.map((row, r) =>
    row.map((cell, c) => cellSet.has(`${c},${r}`) ? 'CLEARING' : cell)
  )
}

function applyGravity(grid, cellSet) {
  const newGrid = makeEmptyGrid()
  for (let c = 0; c < COLS; c++) {
    const remaining = []
    for (let r = 0; r < ROWS; r++) {
      const cell = grid[r][c]
      if (!cellSet.has(`${c},${r}`) && cell !== null && cell !== 'CLEARING') {
        remaining.push(cell)
      }
    }
    for (let i = 0; i < remaining.length; i++) {
      newGrid[ROWS - 1 - (remaining.length - 1 - i)][c] = remaining[i]
    }
  }
  return newGrid
}

function isGridEmpty(grid) {
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (grid[r][c] !== null && grid[r][c] !== 'CLEARING') return false
    }
  }
  return true
}

function countCoins(grid) {
  let n = 0
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (isCellCoin(grid[r][c])) n++
    }
  }
  return n
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

export default function TetrisCascadeSlot() {
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

  // ── Core state ──
  const [stake, setStake] = useState(initialStake)
  const [grid, setGrid] = useState(makeEmptyGrid())
  const [phase, setPhase] = useState('ready')
  const [totalWin, setTotalWin] = useState(0)
  const [cascadeStep, setCascadeStep] = useState(0)
  const [bigText, setBigText] = useState(null)
  const [autoSpin, setAutoSpin] = useState(false)
  const [exitConfirm, setExitConfirm] = useState(false)
  const [buyBonusOpen, setBuyBonusOpen] = useState(false)

  // ── Bonus state ──
  const [isBonus, setIsBonus] = useState(false)
  const [freeSpinsLeft, setFreeSpinsLeft] = useState(0)
  const [rage, setRage] = useState(0) // 0..RAGE_MAX
  const [forceNextI, setForceNextI] = useState(false)
  const [bonusSummary, setBonusSummary] = useState(null) // { totalWin } | null

  const stakeIndex = BETS.indexOf(stake)
  const isBusy = phase === 'dropping' || phase === 'clearing'
  const canPlay = balance >= MIN_BALANCE_RUB && balance >= stake

  const cancelRef = useRef(false)
  const balanceRef = useRef(balance)
  const stakeRef = useRef(stake)
  const autoRef = useRef(autoSpin)
  const isBonusRef = useRef(isBonus)
  const freeSpinsLeftRef = useRef(freeSpinsLeft)
  const rageRef = useRef(rage)
  const forceNextIRef = useRef(forceNextI)
  // Accumulates winnings across the whole bonus round (all 10 free spins).
  // Reset whenever the bonus starts fresh.
  const bonusAccruedRef = useRef(0)
  // Holds the current server-issued round descriptor:
  //   { round_id, balance, outcome_kind, target_payout_rub, bonus_kind, is_bought }
  // For paid spins this is set in runSpin before any animation runs.
  // For bonus free spins this stays set across all 10 spins until the
  // round closes via finishTetrisRound().
  const currentRoundRef = useRef(null)
  // Pre-distributed payout slices for the active bonus round (one entry
  // per free spin), and how many of those have been paid so far.
  const bonusSlicesRef = useRef([])
  const bonusSliceIdxRef = useRef(0)
  useEffect(() => { balanceRef.current = balance }, [balance])
  useEffect(() => { stakeRef.current = stake }, [stake])
  useEffect(() => { autoRef.current = autoSpin }, [autoSpin])
  useEffect(() => { isBonusRef.current = isBonus }, [isBonus])
  useEffect(() => { freeSpinsLeftRef.current = freeSpinsLeft }, [freeSpinsLeft])
  useEffect(() => { rageRef.current = rage }, [rage])
  useEffect(() => { forceNextIRef.current = forceNextI }, [forceNextI])

  // BackButton
  useEffect(() => {
    const tg = window.Telegram?.WebApp
    if (!tg) return
    tg.BackButton.show()
    const back = () => {
      haptic('light')
      if (isBusy || autoSpin || isBonus) setExitConfirm(true)
      else navigate('/')
    }
    tg.BackButton.onClick(back)
    return () => {
      tg.BackButton.offClick(back)
      tg.BackButton.hide()
    }
  }, [navigate, isBusy, autoSpin, isBonus])

  useEffect(() => () => { cancelRef.current = true }, [])

  useEffect(() => {
    if (isBusy) return
    if (stake <= balance) return
    for (let i = BETS.length - 1; i >= 0; i--) {
      if (BETS[i] <= balance) { setStake(BETS[i]); return }
    }
  }, [balance])

  function changeStake(direction) {
    if (isBusy || isBonus) return
    const nextIndex = Math.max(0, Math.min(BETS.length - 1, stakeIndex + direction))
    if (nextIndex === stakeIndex) return
    if (direction > 0 && BETS[nextIndex] > balance) return
    haptic('light')
    setStake(BETS[nextIndex])
  }

  // ── Drop initial pieces ──
  // clearWeight controls the smart-drop AI:
  //   12  → default, prefers placements that clear lines
  //  -50  → "dud" mode, avoids clears entirely
  async function dropInitialPieces(initial, bonus, clearWeight = 12) {
    let g = initial
    for (let i = 0; i < INITIAL_PIECES; i++) {
      if (cancelRef.current) return g
      // In bonus, force I-piece if rage was full (consume the buff once).
      let forceI = false
      if (bonus && forceNextIRef.current && i === 0) {
        forceI = true
        forceNextIRef.current = false
        setForceNextI(false)
      }
      const piece = pickRandomPiece({ bonus, forceI })
      const x = pickColumn(g, piece, { clearWeight })
      if (x < 0) continue
      const mulProvider = bonus
        ? () => BONUS_PIECE_MULS[Math.floor(Math.random() * BONUS_PIECE_MULS.length)]
        : null
      const { grid: ng } = dropPiece(g, piece, x, mulProvider)
      g = ng
      setGrid(g.map(row => [...row]))
      await sleep(110)
    }
    return g
  }

  async function dropFillerPieces(g, count, bonus, clearWeight = 12) {
    for (let i = 0; i < count; i++) {
      if (cancelRef.current) return g
      const piece = pickRandomPiece({ bonus })
      const x = pickColumn(g, piece, { clearWeight })
      if (x < 0) break
      const mulProvider = bonus
        ? () => BONUS_PIECE_MULS[Math.floor(Math.random() * BONUS_PIECE_MULS.length)]
        : null
      const { grid: ng } = dropPiece(g, piece, x, mulProvider)
      g = ng
      setGrid(g.map(row => [...row]))
      await sleep(120)
    }
    return g
  }

  // Force exactly N scatter coins to drop into spread-out columns —
  // used on the trigger spin when the server has decided this round
  // is a 'bonus' outcome.
  async function forceScatterDrop(g, count = COINS_TO_TRIGGER) {
    const cols = []
    // pick `count` distinct columns spread across the board
    const all = [0,1,2,3,4,5,6,7,8,9]
    while (cols.length < count && all.length) {
      const idx = Math.floor(Math.random() * all.length)
      cols.push(all[idx])
      all.splice(idx, 1)
    }
    for (const c of cols) {
      if (cancelRef.current) return g
      const piece = { kind: 'coin', cells: [[0,0]], color: 'coin' }
      if (!canPlace(g, piece.cells, c, 0)) continue
      const { grid: ng } = dropPiece(g, piece, c)
      g = ng
      setGrid(g.map(row => [...row]))
      await sleep(140)
    }
    return g
  }

  function buildBigText(matches) {
    const sorted = [...matches].sort((a, b) => (b.mul * b.cells.length) - (a.mul * a.cells.length))
    const top = sorted[0]
    if (!top) return null
    const rowCount = matches.filter(m => m.type === 'row').length
    if (rowCount === 4) return { kind: 'tetris', mul: top.mul, label: t.slotTetrisTetris }
    if (top.type === 'col') return { kind: 'col', mul: top.mul, label: t.slotTetrisVerticalLine }
    if (top.type === 'color-h' || top.type === 'color-v') {
      return { kind: 'color', mul: top.mul, label: `${t.slotTetrisColorRun} ×${top.len}` }
    }
    if (rowCount === 3) return { kind: 'triple', mul: top.mul, label: t.slotTetrisTriple }
    if (rowCount === 2) return { kind: 'double', mul: top.mul, label: t.slotTetrisDouble }
    return { kind: 'line', mul: top.mul, label: t.slotTetrisLineWin }
  }

  // ── Main spin (RTP-driven) ──
  // Paid spins call start_tetris_round which RETURNS the outcome:
  //   - outcome_kind: 'dud' | 'small' | 'medium' | 'big' | 'huge' | 'bonus'
  //   - target_payout_rub: the exact amount the server has decided to pay
  //   - bonus_kind: subtype when outcome_kind='bonus'
  //
  // The frontend animates a natural-looking spin (cascades, line clears,
  // colour runs) but the FINAL displayed win + balance change is whatever
  // the server pre-decided. For dud rounds the smart-drop AI is told to
  // avoid clears so the visuals stay believable.
  //
  // For 'bonus' outcomes the trigger spin pays nothing itself — the
  // server's target_payout_rub is the TOTAL bonus payout, which the
  // frontend then distributes across the 10 free spins via
  // distributeBonusPayout(). At end of bonus, finish_tetris_round is
  // called once for the entire round.
  async function runSpin(bonusOverride = null) {
    if (cancelRef.current) return

    const inBonus = bonusOverride ?? isBonusRef.current
    let round = currentRoundRef.current

    if (!inBonus) {
      // Paid spin — start a new round on the server (or dev-mode local).
      if (balanceRef.current < stakeRef.current) {
        setAutoSpin(false); autoRef.current = false
        return
      }
      const isDev = !user || user.id === 'dev'
      let result
      if (isDev) {
        const dev = decideTetrisOutcomeDev(stakeRef.current, false)
        result = { ...dev, balance: balanceRef.current - stakeRef.current }
      } else {
        result = await startTetrisRound(user.id, stakeRef.current, false)
        if (cancelRef.current) return
        if (!result || result.error || !result.ok) {
          console.error('startTetrisRound failed:', result)
          setAutoSpin(false); autoRef.current = false
          return
        }
      }
      round = result
      currentRoundRef.current = round
      setBalance(round.balance)
      balanceRef.current = round.balance
    } else {
      // Free spin within a bonus round — decrement counter
      setFreeSpinsLeft(prev => Math.max(0, prev - 1))
      freeSpinsLeftRef.current = Math.max(0, freeSpinsLeftRef.current - 1)
    }

    haptic('medium')
    const currentStake = stakeRef.current
    if (!inBonus) {
      setTotalWin(0)
    }
    setCascadeStep(0)
    setBigText(null)

    const willTriggerBonus = !inBonus && round?.outcome_kind === 'bonus'
    const isDud           = !inBonus && round?.outcome_kind === 'dud'

    // Decide this spin's exact target payout (RTP-driven).
    let spinTarget = 0
    if (inBonus) {
      spinTarget = bonusSlicesRef.current[bonusSliceIdxRef.current] || 0
    } else if (willTriggerBonus) {
      spinTarget = 0 // trigger spin pays nothing — bonus carries payout
    } else if (round) {
      spinTarget = Number(round.target_payout_rub) || 0
    }
    const isJackpotSpin = inBonus && round?.bonus_kind === 'jackpot'
                            && spinTarget >= currentStake * PERFECT_CLEAR_WIN_MUL
                            && spinTarget > 0
    // ANY spin where the win bar will display 0 — be it a dud, a bonus
    // trigger (bonus carries the payout), or a bonus free spin assigned
    // a 0-slice — must NOT fire any cascades. Without this, an "empty"
    // bonus would still flash line clears that contributed nothing to
    // the running total, which the user reads as buggy.
    const isZeroPaySpin = spinTarget === 0
    const needCascades  = !isZeroPaySpin
    // clearWeight: -50 (anti-match) for any zero-pay spin; 12 inside
    // a paid bonus spin (where bonus piece multipliers naturally make
    // cascades worth a lot); 30 for paid wins so cascades are likely
    // to fire and the RTP target is hit.
    const clearWeight = isZeroPaySpin ? -50 : (inBonus ? 12 : 30)
    // Suppress coins / wilds on zero-pay paid-side spins so they can't
    // accidentally trigger the bonus or extend a colour run during a
    // round whose payout is fixed at zero.
    const noSpecialThisSpin = !inBonus && isZeroPaySpin

    // Capture rage-buff state once; consumed after we commit to a script.
    const rageBuffActive = inBonus && forceNextIRef.current

    // ── Phase 1: simulate the spin in pure JS (no animation) ──
    // Pure function: same bonus/clearWeight inputs, runs the smart-drop
    // AI through a full spin and returns the script + naturals. Called
    // once for paid/dud spins; can be retried if non-dud produced no
    // cascades (super-unlucky AI).
    const simulateOnce = () => {
      const script = []
      let simBuff = rageBuffActive
      let sg = makeEmptyGrid()

      // Initial drop
      for (let i = 0; i < INITIAL_PIECES; i++) {
        let forceI = false
        if (simBuff && i === 0) { forceI = true; simBuff = false }
        const piece = pickRandomPiece({ bonus: inBonus, forceI, noSpecial: noSpecialThisSpin })
        const x = pickColumn(sg, piece, { clearWeight })
        if (x < 0) continue
        const mulProvider = inBonus
          ? () => BONUS_PIECE_MULS[Math.floor(Math.random() * BONUS_PIECE_MULS.length)]
          : null
        const { grid: ng } = dropPiece(sg, piece, x, mulProvider)
        script.push({ kind: 'place', gap: 110, gridAfter: ng })
        sg = ng
      }

      // Cascades
      let totalNatural = 0
      let cascadeNum = 0
      while (cascadeNum < MAX_CASCADES) {
        const matches = findMatches(sg)
        if (matches.length === 0) break
        cascadeNum++
        const cellSet = new Set()
        for (const m of matches) for (const [x, y] of m.cells) cellSet.add(`${x},${y}`)

        let stepWin = 0
        if (inBonus) {
          let mulSum = 0
          for (const k of cellSet) {
            const [x, y] = k.split(',').map(Number)
            mulSum += cellMul(sg[y][x])
          }
          stepWin = currentStake * mulSum
        } else {
          stepWin = matches.reduce((s, m) => s + currentStake * m.mul, 0)
        }
        totalNatural += stepWin

        const after = applyGravity(sg, cellSet)
        script.push({
          kind: 'cascade',
          cascadeNum,
          matches,
          cellSet,
          stepWin,
          gridAfter: after,
        })
        sg = after

        // Refill
        const refillCount = 3 + Math.ceil(matches.length * 1.5)
        for (let i = 0; i < refillCount; i++) {
          const piece = pickRandomPiece({ bonus: inBonus, noSpecial: noSpecialThisSpin })
          const x = pickColumn(sg, piece, { clearWeight })
          if (x < 0) break
          const mulProvider = inBonus
            ? () => BONUS_PIECE_MULS[Math.floor(Math.random() * BONUS_PIECE_MULS.length)]
            : null
          const { grid: ng } = dropPiece(sg, piece, x, mulProvider)
          script.push({ kind: 'place', gap: 120, gridAfter: ng })
          sg = ng
        }

      }

      return { script, totalNatural, cascadeNum }
    }

    // Run simulation. Retry up to 12× for non-dud spins that need
    // cascades but the unlucky AI didn't make any. For dud rounds we
    // accept whatever the strict no-match AI produced (zero cascades
    // is the desired outcome).
    let sim = simulateOnce()
    if (needCascades) {
      let attempts = 0
      while (sim.cascadeNum === 0 && attempts < 12) {
        sim = simulateOnce()
        attempts++
      }
    }
    const { script, totalNatural } = sim

    // Consume the rage buff now that we've committed to a script.
    if (rageBuffActive) {
      forceNextIRef.current = false
      setForceNextI(false)
    }

    // Compute the scale factor so cascade wins sum exactly to the target.
    // For dud rounds: scale = 0 (no payout) — but the no-match AI also
    // means there typically aren't any cascade steps in the script.
    const scale = totalNatural > 0 ? spinTarget / totalNatural : 0

    // ── Phase 2: replay the script with animation + scaled wins ──
    let g = makeEmptyGrid()
    setGrid(g)
    setPhase('dropping')

    const baseDisplayWin = inBonus ? bonusAccruedRef.current : 0
    let accumulatedScaled = 0

    for (const step of script) {
      if (cancelRef.current) return
      if (step.kind === 'place') {
        g = step.gridAfter
        setGrid(g.map(row => [...row]))
        await sleep(step.gap || 110)
      } else if (step.kind === 'cascade') {
        setCascadeStep(step.cascadeNum)
        setPhase('clearing')
        setBigText(buildBigText(step.matches))
        setGrid(markClearing(g, step.cellSet))
        haptic(step.matches.some(m => m.type === 'col' || m.cells.length >= 9) ? 'success' : 'medium')
        await sleep(420)
        if (cancelRef.current) return
        g = step.gridAfter
        setGrid(g.map(row => [...row]))
        await sleep(360)

        // Scaled win contribution from this cascade.
        const scaled = Math.round(step.stepWin * scale)
        if (scaled > 0) {
          accumulatedScaled += scaled
          setTotalWin(baseDisplayWin + accumulatedScaled)
        }
        setBigText(null)

        // Rage meter (bonus only)
        if (inBonus) {
          const linesContribution = step.matches.length
          const newRage = Math.min(RAGE_MAX, rageRef.current + linesContribution)
          rageRef.current = newRage
          setRage(newRage)
          if (newRage >= RAGE_MAX) {
            forceNextIRef.current = true
            setForceNextI(true)
            rageRef.current = 0
            setRage(0)
          }
        }
        setPhase('dropping')
      }
    }

    // Reconcile any rounding error so the displayed total equals exactly
    // baseDisplayWin + spinTarget.
    if (accumulatedScaled !== spinTarget) {
      setTotalWin(baseDisplayWin + spinTarget)
    }

    // For bonus-trigger spins drop the 5 scatter coins now (after cascade).
    if (willTriggerBonus) {
      g = await forceScatterDrop(g, COINS_TO_TRIGGER)
      if (cancelRef.current) return
    }

    // Jackpot bonus spin → force-clear remaining cells with the Perfect
    // Clear celebration so the visuals match the x5000 payout.
    if (isJackpotSpin) {
      const allCells = new Set()
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          if (g[r][c] !== null && g[r][c] !== 'CLEARING') allCells.add(`${c},${r}`)
        }
      }
      if (allCells.size > 0) {
        setGrid(markClearing(g, allCells))
        haptic('success')
        await sleep(420)
        g = applyGravity(g, allCells)
        setGrid(g.map(row => [...row]))
        await sleep(280)
      }
      setBigText({
        kind: 'perfect',
        label: t.slotTetrisPerfectClear,
        mul: PERFECT_CLEAR_WIN_MUL,
      })
      haptic('success')
      await sleep(1700)
      setBigText(null)
    }

    // Track accrued + advance bonus slice index, credit balance.
    if (inBonus) {
      bonusAccruedRef.current += spinTarget
      bonusSliceIdxRef.current++
    }
    if (spinTarget > 0) {
      setBalance(balanceRef.current + spinTarget)
      balanceRef.current = balanceRef.current + spinTarget
      setBalanceBounce(true)
      setTimeout(() => setBalanceBounce(false), 700)
    }
    setPhase('done')

    // Variable kept for parity with later code paths.
    const spinPayout = spinTarget; void spinPayout

    // ── Bonus trigger: animate scatter sweep + celebration, then chain ──
    if (willTriggerBonus) {
      const coinCellSet = new Set()
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          if (isCellCoin(g[r][c])) coinCellSet.add(`${c},${r}`)
        }
      }
      if (coinCellSet.size > 0) {
        setGrid(markClearing(g, coinCellSet))
        haptic('success')
        await sleep(520)
        if (cancelRef.current) return
        g = applyGravity(g, coinCellSet)
        setGrid(g.map(row => [...row]))
        await sleep(280)
      }
      setBigText({
        kind: 'bonus',
        label: t.slotTetrisBonusTrigger,
        subLabel: `${BONUS_FREE_SPINS} ${t.slotTetrisFreeSpinsWord}`,
        mul: 0,
      })
      haptic('success')
      await sleep(2000)
      setBigText(null)

      setIsBonus(true)
      isBonusRef.current = true
      setFreeSpinsLeft(BONUS_FREE_SPINS)
      freeSpinsLeftRef.current = BONUS_FREE_SPINS
      setRage(0)
      rageRef.current = 0
      setForceNextI(false)
      forceNextIRef.current = false

      // Pre-distribute the server's bonus payout across the 10 spins.
      bonusSlicesRef.current = distributeBonusPayout(
        Number(round?.target_payout_rub) || 0,
        BONUS_FREE_SPINS,
        round?.bonus_kind,
      )
      bonusSliceIdxRef.current = 0
      bonusAccruedRef.current = 0
      setTotalWin(0)

      await sleep(450)
      runSpin(true)
      return
    }

    // ── Continue bonus round if more free spins remain ──
    if (inBonus && freeSpinsLeftRef.current > 0 && !cancelRef.current) {
      await sleep(900)
      runSpin(true)
      return
    }

    // ── End of bonus round: finalize, show summary ──
    if (inBonus && freeSpinsLeftRef.current <= 0) {
      setIsBonus(false)
      isBonusRef.current = false
      setRage(0)
      rageRef.current = 0
      setForceNextI(false)
      forceNextIRef.current = false
      const total = bonusAccruedRef.current
      bonusAccruedRef.current = 0
      bonusSlicesRef.current = []
      bonusSliceIdxRef.current = 0

      // Finalize the round on the server. Server will pay this much
      // (clamped to the original target). We've already credited
      // balance per slice, so server credit reconciles the final value.
      // Dev rounds (no Supabase user) skip the RPC call.
      if (currentRoundRef.current) {
        const rid = currentRoundRef.current.round_id
        if (typeof rid === 'string' && !rid.startsWith('dev-')) {
          await finishTetrisRound(rid, total)
        }
        currentRoundRef.current = null
      }

      await sleep(700)
      if (!cancelRef.current) {
        setBonusSummary({ totalWin: total })
        haptic('success')
      }
      return
    }

    // ── End of a paid (non-bonus, non-trigger) spin: finalize ──
    if (!inBonus && !willTriggerBonus && currentRoundRef.current) {
      const rid = currentRoundRef.current.round_id
      if (typeof rid === 'string' && !rid.startsWith('dev-')) {
        await finishTetrisRound(rid, spinPayout)
      }
      currentRoundRef.current = null
    }

    // ── Auto-spin chain ──
    if (autoRef.current && !isBonusRef.current && balanceRef.current >= stakeRef.current && !cancelRef.current) {
      await sleep(900)
      if (autoRef.current && !cancelRef.current && balanceRef.current >= stakeRef.current) {
        runSpin()
      } else {
        setAutoSpin(false); autoRef.current = false
      }
    }
  }

  function onSpinClick() {
    if (isBusy) return
    if (isBonus) return // Bonus drives itself
    if (autoSpin) {
      setAutoSpin(false); autoRef.current = false
      return
    }
    if (!canPlay) return
    runSpin()
  }

  function onAutoSpinClick() {
    if (isBusy || isBonus) return
    if (autoSpin) {
      setAutoSpin(false); autoRef.current = false
      return
    }
    if (!canPlay) return
    setAutoSpin(true); autoRef.current = true
    runSpin()
  }

  function confirmExit() {
    haptic('medium')
    cancelRef.current = true
    setAutoSpin(false); autoRef.current = false
    setExitConfirm(false)
    navigate('/')
  }

  // ── Buy bonus ──
  function onBuyBonusClick() {
    if (isBusy || isBonus || autoSpin) return
    if (balance < stake * BUY_BONUS_COST_MUL) return
    haptic('light')
    setBuyBonusOpen(true)
  }

  async function confirmBuyBonus() {
    const cost = stakeRef.current * BUY_BONUS_COST_MUL
    if (balanceRef.current < cost) return
    haptic('success')
    setBuyBonusOpen(false)
    await runBoughtBonus()
  }

  // Special bonus-purchase flow.
  // Calls start_tetris_round(stake, is_bought=true). Server deducts
  // stake × 100 and returns the bonus's pre-decided target_payout_rub.
  // Frontend then animates 5 scatters dropping in, the celebration
  // banner, and chains the 10 free spins driven by the same round.
  async function runBoughtBonus() {
    if (cancelRef.current) return
    const isDev = !user || user.id === 'dev'
    const cost = stakeRef.current * BUY_BONUS_COST_MUL
    let result
    if (isDev) {
      const dev = decideTetrisOutcomeDev(stakeRef.current, true)
      result = { ...dev, balance: balanceRef.current - cost }
    } else {
      result = await startTetrisRound(user.id, stakeRef.current, true)
      if (cancelRef.current) return
      if (!result || result.error || !result.ok) {
        console.error('startTetrisRound (bought) failed:', result)
        return
      }
    }
    currentRoundRef.current = result
    setBalance(result.balance)
    balanceRef.current = result.balance

    haptic('medium')
    setTotalWin(0)
    setCascadeStep(0)
    setBigText(null)

    let g = makeEmptyGrid()
    setGrid(g)
    setPhase('dropping')

    // Drop 5 coin scatters into spread-out columns.
    const cols = [1, 3, 5, 7, 9]
    for (const c of cols) {
      if (cancelRef.current) return
      const piece = { kind: 'coin', cells: [[0, 0]], color: 'coin' }
      const { grid: ng } = dropPiece(g, piece, c)
      g = ng
      setGrid(g.map(row => [...row]))
      await sleep(200)
    }
    await sleep(380)
    if (cancelRef.current) return

    // Sweep them with a flash + collapse.
    const coinCellSet = new Set()
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (isCellCoin(g[r][c])) coinCellSet.add(`${c},${r}`)
      }
    }
    if (coinCellSet.size > 0) {
      setGrid(markClearing(g, coinCellSet))
      haptic('success')
      await sleep(520)
      if (cancelRef.current) return
      g = applyGravity(g, coinCellSet)
      setGrid(g.map(row => [...row]))
      await sleep(280)
    }

    setBigText({
      kind: 'bonus',
      label: t.slotTetrisBonusTrigger,
      subLabel: `${BONUS_FREE_SPINS} ${t.slotTetrisFreeSpinsWord}`,
      mul: 0,
    })
    haptic('success')
    await sleep(2000)
    setBigText(null)

    setIsBonus(true)
    isBonusRef.current = true
    setFreeSpinsLeft(BONUS_FREE_SPINS)
    freeSpinsLeftRef.current = BONUS_FREE_SPINS
    setRage(0)
    rageRef.current = 0
    setForceNextI(false)
    forceNextIRef.current = false

    bonusSlicesRef.current = distributeBonusPayout(
      Number(result.target_payout_rub) || 0,
      BONUS_FREE_SPINS,
      result.bonus_kind,
    )
    bonusSliceIdxRef.current = 0
    bonusAccruedRef.current = 0
    setTotalWin(0)
    setPhase('done')

    await sleep(450)
    if (cancelRef.current) return
    runSpin(true)
  }

  const stakeUpDisabled = isBusy || isBonus || stakeIndex >= BETS.length - 1 || (BETS[stakeIndex + 1] !== undefined && BETS[stakeIndex + 1] > balance)
  const stakeDownDisabled = isBusy || isBonus || stakeIndex <= 0
  const winLabel = totalWin > 0 ? `+${formatCurrency(totalWin, currency, rates)}` : null
  const buyBonusCost = stake * BUY_BONUS_COST_MUL
  const canBuyBonus = !isBusy && !isBonus && !autoSpin && balance >= buyBonusCost

  return (
    <div className={`tetris-slot-page tetris-slot-page--${phase} ${isBonus ? 'tetris-slot-page--bonus' : ''}`}>
      <div className="tetris-game-window">
        {isBonus && (
          <div className="tetris-bonus-strip">
            <div className="tetris-bonus-strip-left">
              <span className="tetris-bonus-flag">{t.slotTetrisBonusTrigger}</span>
              <span className="tetris-bonus-spins">{t.slotTetrisFreeSpinsLeft}: <strong>{freeSpinsLeft}</strong></span>
            </div>
            <div className="tetris-rage">
              <span className="tetris-rage-label">{t.slotTetrisRage}</span>
              <span className="tetris-rage-bar">
                <span className="tetris-rage-fill" style={{ width: `${(rage / RAGE_MAX) * 100}%` }} />
              </span>
              {forceNextI && <span className="tetris-rage-i">I</span>}
            </div>
          </div>
        )}

        <main className="tetris-stage" aria-label="Tetris Cascade">
          <div className="tetris-bg" />
          <div className="tetris-grid" style={{ '--cols': COLS, '--rows': ROWS }}>
            {Array.from({ length: ROWS }).map((_, r) => (
              <React.Fragment key={`row-${r}`}>
                {Array.from({ length: COLS }).map((__, c) => {
                  const cell = grid[r][c]
                  const isClearing = cell === 'CLEARING'
                  const filled = !isClearing && cell !== null
                  const wild  = filled && isCellWild(cell)
                  const coin  = filled && isCellCoin(cell)
                  const colorClass = !filled
                    ? ''
                    : coin ? 'tetris-cell--coin'
                    : wild ? 'tetris-cell--wild'
                    : `tetris-cell--${cell.color}`
                  const showMul = filled && !coin && cell.mul > 1
                  return (
                    <div
                      key={`${r}-${c}`}
                      className={`tetris-cell ${filled ? 'is-filled' : ''} ${isClearing ? 'is-clearing' : ''} ${colorClass}`}
                    >
                      {filled && !wild && !coin && <span className="tetris-cell-shine" />}
                      {wild && (
                        <span className="tetris-cell-wild-mark">
                          <svg viewBox="0 0 24 24" fill="none">
                            <path d="M12 2l2.4 6.8 7.6.4-5.7 4.6 1.9 7.2-6.2-4.2-6.2 4.2 1.9-7.2L2 9.2l7.6-.4z" fill="#fff" />
                          </svg>
                        </span>
                      )}
                      {coin && (
                        <span className="tetris-cell-coin-mark">
                          <svg viewBox="0 0 24 24" fill="none">
                            <circle cx="12" cy="12" r="9" fill="#fbbf24" stroke="#92400e" strokeWidth="1.5" />
                            <text x="12" y="16" textAnchor="middle" fontSize="11" fontWeight="900" fill="#7c2d12">$</text>
                          </svg>
                        </span>
                      )}
                      {showMul && <span className="tetris-cell-mul">×{cell.mul}</span>}
                    </div>
                  )
                })}
              </React.Fragment>
            ))}
          </div>

          {bigText && (
            <div className={`tetris-big-text tetris-big-text--${bigText.kind}`}>
              <span className="tetris-big-label">{bigText.label}</span>
              {bigText.subLabel && (
                <span className="tetris-big-sublabel">{bigText.subLabel}</span>
              )}
              {bigText.mul > 0 && (
                <span className="tetris-big-mul">
                  ×{bigText.mul}{cascadeStep > 1 && bigText.kind !== 'bonus' && bigText.kind !== 'perfect' ? ` × c${cascadeStep}` : ''}
                </span>
              )}
            </div>
          )}
        </main>

        {!isBonus && (
          <button
            type="button"
            className="tetris-buy-bonus"
            onClick={onBuyBonusClick}
            disabled={!canBuyBonus}
          >
            <span className="tetris-buy-bonus-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M12 2.6 L14.4 8.7 L20.9 9.2 L15.9 13.4 L17.5 19.7 L12 16 L6.5 19.7 L8.1 13.4 L3.1 9.2 L9.6 8.7 Z" fill="currentColor" />
              </svg>
            </span>
            <span className="tetris-buy-bonus-label">
              <span className="tetris-buy-bonus-title">{t.slotTetrisBuyBonus}</span>
              <span className="tetris-buy-bonus-sub">{BONUS_FREE_SPINS} {t.slotTetrisFreeSpinsWord}</span>
            </span>
            <span className="tetris-buy-bonus-price">{formatCurrency(buyBonusCost, currency, rates)}</span>
          </button>
        )}

        <div className={`tetris-winbar ${totalWin > 0 ? 'is-win' : ''}`}>
          <span className="tetris-winbar-label">{t.slotPotential}</span>
          <strong className="tetris-winbar-value">
            {winLabel ?? formatCurrency(0, currency, rates)}
          </strong>
          {cascadeStep > 1 && (
            <span className="tetris-winbar-cascade">×{cascadeStep}</span>
          )}
        </div>

        <section className="tetris-controls">
          <div className="tetris-balance">
            <span>{t.balance || 'Balance'}</span>
            <strong>{formatCurrency(balance, currency, rates)}</strong>
          </div>

          <div className="tetris-center">
            <button
              type="button"
              className={`tetris-spin-btn ${isBusy ? 'is-busy' : ''} ${autoSpin ? 'is-auto' : ''}`}
              onClick={onSpinClick}
              disabled={(!canPlay && !autoSpin) || isBonus}
              aria-label={autoSpin ? t.slotTetrisStop : t.slotTetrisSpin}
            >
              {isBusy ? (
                <svg className="tetris-spin-icon spinning" width="36" height="36" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" strokeDasharray="40 60" strokeLinecap="round"/>
                </svg>
              ) : autoSpin ? (
                <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="5" width="4" height="14" rx="1.2" />
                  <rect x="14" y="5" width="4" height="14" rx="1.2" />
                </svg>
              ) : (
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none">
                  <path d="M21 12a9 9 0 1 1-3-6.7M21 4v5h-5" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              )}
            </button>
            <button
              type="button"
              className={`tetris-auto-btn ${autoSpin ? 'is-auto' : ''}`}
              onClick={onAutoSpinClick}
              disabled={(isBusy && !autoSpin) || isBonus}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                {autoSpin ? (
                  <>
                    <rect x="6" y="5" width="4" height="14" rx="1.2" fill="currentColor" />
                    <rect x="14" y="5" width="4" height="14" rx="1.2" fill="currentColor" />
                  </>
                ) : (
                  <path d="M5 3l14 9-14 9z" fill="currentColor" />
                )}
              </svg>
              {autoSpin ? t.slotTetrisStop : t.slotTetrisAutoSpin}
            </button>
          </div>

          {/* Stake column — arrows live in column 1 next to the amount, like Tower Stack. */}
          <div className="tetris-stake">
            <div className="tetris-stake-buttons">
              <button type="button" onClick={() => changeStake(1)} disabled={stakeUpDisabled} aria-label="Increase">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path d="M7 14l5-5 5 5" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
              <button type="button" onClick={() => changeStake(-1)} disabled={stakeDownDisabled} aria-label="Decrease">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path d="M7 10l5 5 5-5" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
            </div>
            <div className="tetris-stake-info">
              <span>{t.slotTotalBet}</span>
              <strong>{formatCurrency(stake, currency, rates)}</strong>
            </div>
          </div>
        </section>
      </div>

      {exitConfirm && (
        <div className="tetris-exit-backdrop">
          <div className="tetris-exit-card">
            <h3>{t.slotExitTitle}</h3>
            <p>{t.slotExitText}</p>
            <div className="tetris-exit-actions">
              <button type="button" onClick={() => { haptic('light'); setExitConfirm(false) }}>{t.slotExitStay}</button>
              <button type="button" onClick={confirmExit}>{t.slotExitLeave}</button>
            </div>
          </div>
        </div>
      )}

      {bonusSummary && (
        <div className="tetris-summary-backdrop" onClick={() => { haptic('light'); setBonusSummary(null) }}>
          <div className="tetris-summary-card" onClick={e => e.stopPropagation()}>
            <div className="tetris-summary-glow" aria-hidden="true" />
            <div className="tetris-summary-confetti" aria-hidden="true">
              <span /><span /><span /><span /><span /><span /><span /><span />
            </div>
            <span className="tetris-summary-kicker">{t.slotTetrisBonusEnded}</span>
            <h3 className="tetris-summary-title">{t.slotTetrisBonusTotalWin}</h3>
            <strong className={`tetris-summary-amount ${bonusSummary.totalWin > 0 ? 'is-win' : 'is-zero'}`}>
              {bonusSummary.totalWin > 0
                ? `+${formatCurrency(bonusSummary.totalWin, currency, rates)}`
                : formatCurrency(0, currency, rates)}
            </strong>
            <span className="tetris-summary-multiplier">
              {bonusSummary.totalWin > 0 && stakeRef.current > 0
                ? `×${(bonusSummary.totalWin / stakeRef.current).toFixed(1)} ${t.slotTetrisStakeWord}`
                : ''}
            </span>
            <button
              type="button"
              className="tetris-summary-close"
              onClick={() => { haptic('light'); setBonusSummary(null) }}
            >
              {t.slotTetrisBonusClose}
            </button>
          </div>
        </div>
      )}

      {buyBonusOpen && (
        <div className="tetris-buy-backdrop" onClick={() => { haptic('light'); setBuyBonusOpen(false) }}>
          <div className="tetris-buy-card" onClick={e => e.stopPropagation()}>
            <div className="tetris-buy-card-glow" aria-hidden="true" />
            <div className="tetris-buy-card-icon">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M12 2.6 L14.4 8.7 L20.9 9.2 L15.9 13.4 L17.5 19.7 L12 16 L6.5 19.7 L8.1 13.4 L3.1 9.2 L9.6 8.7 Z" fill="currentColor" />
              </svg>
            </div>
            <h3 className="tetris-buy-card-title">{t.slotTetrisBuyBonusTitle}</h3>
            <p className="tetris-buy-card-headline">{BONUS_FREE_SPINS} {t.slotTetrisFreeSpinsWord}</p>
            <ul className="tetris-buy-card-features">
              <li>{t.slotTetrisBuyBonusFeatureMul}</li>
              <li>{t.slotTetrisBuyBonusFeatureRage}</li>
              <li>{t.slotTetrisBuyBonusFeaturePerfect}</li>
            </ul>
            <div className="tetris-buy-card-price">
              <span>{t.slotTetrisBuyBonusPriceLabel}</span>
              <strong>{formatCurrency(buyBonusCost, currency, rates)}</strong>
            </div>
            <div className="tetris-buy-card-actions">
              <button type="button" className="tetris-buy-cancel" onClick={() => { haptic('light'); setBuyBonusOpen(false) }}>
                {t.slotTetrisBuyBonusCancel}
              </button>
              <button
                type="button"
                className="tetris-buy-confirm"
                onClick={confirmBuyBonus}
                disabled={balance < buyBonusCost}
              >
                {balance < buyBonusCost
                  ? t.slotTetrisBuyBonusInsufficient
                  : t.slotTetrisBuyBonusConfirm}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
