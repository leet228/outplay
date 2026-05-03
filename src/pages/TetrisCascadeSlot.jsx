import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useShallow } from 'zustand/react/shallow'
import useGameStore from '../store/useGameStore'
import { translations } from '../lib/i18n'
import { formatCurrency } from '../lib/currency'
import { haptic } from '../lib/telegram'
import './TetrisCascadeSlot.css'

const BETS = [10, 25, 50, 100, 250, 500, 1000, 2000, 4000, 8000, 16000, 25000]
const MIN_BALANCE_RUB = 10
const SLOT_ID = 'tetris-cascade'

// Playfield 10 wide × 8 tall.
const COLS = 10
const ROWS = 8

const INITIAL_PIECES = 14
const COLOR_LINE_MIN = 7
const MAX_CASCADES = 10

// Special piece spawn rates.
const WILD_RATE = 0.08         // colour wildcard cells
const BOMB_RATE = 0.04         // 1×1 bombs that explode 3×3 on landing
const COIN_RATE = 0.045        // 1×1 scatter coins
const COINS_TO_TRIGGER = 5     // coins on grid after initial drop → bonus

// Bonus configuration.
const BONUS_FREE_SPINS = 10
const BONUS_PIECE_MULS = [2, 3, 5, 10] // each cell carries one of these in bonus
const RAGE_MAX = 6              // line clears in bonus to fill the rage meter
const PERFECT_CLEAR_WIN_MUL = 5000
const BUY_BONUS_COST_MUL = 100  // buy-in price = stake × this

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

// Match payouts.
const COLOR_RUN_MUL = { 7: 3, 8: 5, 9: 8, 10: 15 }

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
function isCellBomb(cell)   { return cell && cell.kind === 'bomb' }
function isCellCoin(cell)   { return cell && cell.kind === 'coin' }
function cellMul(cell)      { return cell?.mul || 1 }

function pickRandomPiece(opts = {}) {
  const { forceI, bonus } = opts
  // Specials only spawn outside the bonus round (kept simple — bonus uses
  // multipliers instead).
  if (!bonus && !forceI) {
    const r = Math.random()
    if (r < BOMB_RATE) {
      return { kind: 'bomb', cells: [[0,0]], color: 'bomb' }
    }
    if (r < BOMB_RATE + COIN_RATE) {
      return { kind: 'coin', cells: [[0,0]], color: 'coin' }
    }
  }
  const k = forceI ? 'I' : PIECE_KEYS[Math.floor(Math.random() * PIECE_KEYS.length)]
  const wild = !bonus && Math.random() < WILD_RATE
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

function pickColumn(grid, piece) {
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
      cleared * 12
      - aggHeight * 0.7
      - maxHeight * 1.0
      - holes * 30
      + Math.random() * 18
    candidates.push({ x, score })
  }
  if (candidates.length === 0) return -1
  candidates.sort((a, b) => b.score - a.score)
  const top = candidates.slice(0, Math.min(2, candidates.length))
  return top[Math.floor(Math.random() * top.length)].x
}

// ── Match detection ──
// Bombs / coins block placement (isFilled === true) but neither participates
// in colour matches, and coins never count towards full row / column
// completions either — they are inert obstacles.
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
  // Bombs and scatter coins are inert — they break colour runs and never
  // participate in colour matches.
  if (isCellBomb(cell) || isCellCoin(cell)) return null
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
      matches.push({ type: 'row', cells, mul: 2 })
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
      matches.push({ type: 'col', cells, mul: 3 })
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

// 3×3 explosion centred on a bomb at (bx, by). Returns the cell-key set
// to clear (excluding the bomb itself, which is always cleared too).
function bombExplosionCells(bx, by) {
  const set = new Set()
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = bx + dx, y = by + dy
      if (x < 0 || x >= COLS || y < 0 || y >= ROWS) continue
      set.add(`${x},${y}`)
    }
  }
  return set
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

  // ── Bomb explosions (run AFTER all initial drops, before match check) ──
  function handleBombExplosions(g) {
    // Find all bombs on the grid
    const explosions = []
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (isCellBomb(g[r][c])) explosions.push([c, r])
      }
    }
    if (explosions.length === 0) return { grid: g, exploded: false }
    const cellSet = new Set()
    for (const [bx, by] of explosions) {
      for (const k of bombExplosionCells(bx, by)) cellSet.add(k)
    }
    return { grid: g, cellSet, exploded: true }
  }

  // ── Drop initial pieces ──
  async function dropInitialPieces(initial, bonus) {
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
      const x = pickColumn(g, piece)
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

  async function dropFillerPieces(g, count, bonus) {
    for (let i = 0; i < count; i++) {
      if (cancelRef.current) return g
      const piece = pickRandomPiece({ bonus })
      const x = pickColumn(g, piece)
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

  async function explodeBombsIfAny(g) {
    const bombs = []
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (isCellBomb(g[r][c])) bombs.push([c, r])
      }
    }
    if (bombs.length === 0) return g

    // Build the explosion cellSet, but SKIP any scatter coins — coins are
    // inert and survive bomb blasts that hit them.
    const cellSet = new Set()
    for (const [bx, by] of bombs) {
      for (const k of bombExplosionCells(bx, by)) {
        const [x, y] = k.split(',').map(Number)
        if (isCellCoin(g[y][x])) continue
        cellSet.add(k)
      }
    }
    if (cellSet.size === 0) return g

    setBigText({ kind: 'boom', label: t.slotTetrisBoom, mul: 0 })
    setGrid(markClearing(g, cellSet))
    haptic('error')
    await sleep(420)
    g = applyGravity(g, cellSet)
    setGrid(g.map(row => [...row]))
    await sleep(360)
    setBigText(null)
    return g
  }

  // ── Main spin ──
  async function runSpin(bonusOverride = null) {
    if (cancelRef.current) return

    // Are we in a bonus round on this spin?
    const bonusThisSpin = bonusOverride ?? isBonusRef.current

    if (!bonusThisSpin) {
      if (balanceRef.current < stakeRef.current) {
        setAutoSpin(false); autoRef.current = false
        return
      }
      setBalance(balanceRef.current - stakeRef.current)
    } else {
      // Free spin — decrement freeSpinsLeft
      setFreeSpinsLeft(prev => Math.max(0, prev - 1))
      freeSpinsLeftRef.current = Math.max(0, freeSpinsLeftRef.current - 1)
    }

    haptic('medium')
    const currentStake = stakeRef.current
    // Reset displayed totalWin only for paid spins. In a bonus round we
    // keep the running total across all 10 free spins so the win bar
    // shows the cumulative amount.
    if (!bonusThisSpin) {
      setTotalWin(0)
    }
    setCascadeStep(0)
    setBigText(null)

    let g = makeEmptyGrid()
    setGrid(g)
    setPhase('dropping')

    g = await dropInitialPieces(g, bonusThisSpin)
    if (cancelRef.current) return

    // Detonate bombs first (they create gaps for the cascade phase).
    // Coins survive bomb blasts so they still count later.
    g = await explodeBombsIfAny(g)
    if (cancelRef.current) return

    // Cascade loop
    let win = 0
    let cascade = 0
    let safety = 0
    while (safety++ < MAX_CASCADES) {
      const matches = findMatches(g)
      if (matches.length === 0) break

      cascade++
      setCascadeStep(cascade)
      setPhase('clearing')

      const cellSet = new Set()
      let stepWin = 0
      for (const m of matches) {
        for (const [x, y] of m.cells) cellSet.add(`${x},${y}`)
      }
      // Compute payout.
      // Bonus payout follows the spec literally: each cleared cell contributes
      // its built-in multiplier; the line is worth stake × Σ(cell muls). No
      // cascade boost — the per-cell multipliers are already the reward.
      // Example: a row of 5 cells each carrying x2 → mulSum = 10 → win = 10× stake.
      if (bonusThisSpin) {
        let mulSum = 0
        for (const k of cellSet) {
          const [x, y] = k.split(',').map(Number)
          mulSum += cellMul(g[y][x])
        }
        stepWin = currentStake * mulSum
      } else {
        stepWin = matches.reduce((s, m) => s + currentStake * m.mul * cascade, 0)
      }

      setBigText(buildBigText(matches))

      const flashGrid = markClearing(g, cellSet)
      setGrid(flashGrid)
      haptic(matches.some(m => m.type === 'col' || m.cells.length >= 9) ? 'success' : 'medium')
      await sleep(420)
      if (cancelRef.current) return

      g = applyGravity(g, cellSet)
      setGrid(g.map(row => [...row]))
      await sleep(360)

      win += stepWin
      // In a bonus round the displayed total accumulates across all
      // free spins — add stepWin on top of whatever was already shown.
      // For paid spins the totalWin started at 0 this spin, so this is
      // equivalent to setTotalWin(win).
      setTotalWin(prev => prev + stepWin)
      setBigText(null)

      // Rage meter (bonus only)
      if (bonusThisSpin) {
        const linesContribution = matches.length
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

      const refillCount = 3 + Math.ceil(matches.length * 1.5)
      g = await dropFillerPieces(g, refillCount, bonusThisSpin)
      if (cancelRef.current) return
      // After refill, more bombs might exist — chain explosions too.
      g = await explodeBombsIfAny(g)
      if (cancelRef.current) return
      setPhase('dropping')
    }

    // Perfect Clear (only when bonus active)
    if (bonusThisSpin && isGridEmpty(g)) {
      const perfectWin = currentStake * PERFECT_CLEAR_WIN_MUL
      win += perfectWin
      setTotalWin(win)
      setBigText({ kind: 'perfect', label: t.slotTetrisPerfectClear, mul: PERFECT_CLEAR_WIN_MUL })
      setFreeSpinsLeft(prev => prev + 5)
      freeSpinsLeftRef.current = freeSpinsLeftRef.current + 5
      haptic('success')
      await sleep(1500)
      setBigText(null)
    }

    if (win > 0) {
      setBalance(balanceRef.current + win)
      setBalanceBounce(true)
      setTimeout(() => setBalanceBounce(false), 700)
      // Track running bonus total so we can show it in the end-of-bonus
      // summary overlay.
      if (bonusThisSpin) {
        bonusAccruedRef.current += win
      }
    }
    setPhase('done')

    // Bonus trigger from coin scatters (only outside bonus). Counted at
    // the END of the spin so coins from cascade refills count too. Coins
    // are inert all spin long; only here, when 5+ have triggered the
    // bonus, do they finally pop with a flash + collapse — as part of
    // the celebration animation.
    const coinsLanded = bonusThisSpin ? 0 : countCoins(g)
    if (!bonusThisSpin && coinsLanded >= COINS_TO_TRIGGER) {
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
      // Reset the bonus win accumulator + win bar so the cumulative
      // total starts fresh for this round.
      bonusAccruedRef.current = 0
      setTotalWin(0)
      // Auto-start the first free spin
      await sleep(450)
      runSpin(true)
      return
    }

    // Continue bonus round
    if (bonusThisSpin && freeSpinsLeftRef.current > 0 && !cancelRef.current) {
      await sleep(900)
      runSpin(true)
      return
    }

    // Bonus complete — close out and show the summary overlay.
    if (bonusThisSpin && freeSpinsLeftRef.current <= 0) {
      setIsBonus(false)
      isBonusRef.current = false
      setRage(0)
      rageRef.current = 0
      setForceNextI(false)
      forceNextIRef.current = false
      const total = bonusAccruedRef.current
      bonusAccruedRef.current = 0
      await sleep(700)
      if (!cancelRef.current) {
        setBonusSummary({ totalWin: total })
        haptic('success')
      }
    }

    // Auto-spin chain (paid spins only)
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
    setBalance(balanceRef.current - cost)
    balanceRef.current = balanceRef.current - cost
    await runBoughtBonus()
  }

  // Special "spin" played after buying — no real round, just plops 5
  // scatters onto an empty grid, then runs the standard bonus trigger
  // (sweep + celebration banner + auto-start the free-spin chain).
  async function runBoughtBonus() {
    if (cancelRef.current) return
    haptic('medium')
    setTotalWin(0)
    setCascadeStep(0)
    setBigText(null)

    let g = makeEmptyGrid()
    setGrid(g)
    setPhase('dropping')

    // Drop 5 coin scatters into 5 evenly spaced columns.
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

    // Sweep them with a flash + collapse — same animation as a natural trigger.
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

    // Celebration banner.
    setBigText({
      kind: 'bonus',
      label: t.slotTetrisBonusTrigger,
      subLabel: `${BONUS_FREE_SPINS} ${t.slotTetrisFreeSpinsWord}`,
      mul: 0,
    })
    haptic('success')
    await sleep(2000)
    setBigText(null)

    // Activate bonus and chain the first free spin.
    setIsBonus(true)
    isBonusRef.current = true
    setFreeSpinsLeft(BONUS_FREE_SPINS)
    freeSpinsLeftRef.current = BONUS_FREE_SPINS
    setRage(0)
    rageRef.current = 0
    setForceNextI(false)
    forceNextIRef.current = false
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
                  const bomb  = filled && isCellBomb(cell)
                  const coin  = filled && isCellCoin(cell)
                  const colorClass = !filled
                    ? ''
                    : bomb ? 'tetris-cell--bomb'
                    : coin ? 'tetris-cell--coin'
                    : wild ? 'tetris-cell--wild'
                    : `tetris-cell--${cell.color}`
                  const showMul = filled && !bomb && !coin && cell.mul > 1
                  return (
                    <div
                      key={`${r}-${c}`}
                      className={`tetris-cell ${filled ? 'is-filled' : ''} ${isClearing ? 'is-clearing' : ''} ${colorClass}`}
                    >
                      {filled && !wild && !bomb && !coin && <span className="tetris-cell-shine" />}
                      {wild && (
                        <span className="tetris-cell-wild-mark">
                          <svg viewBox="0 0 24 24" fill="none">
                            <path d="M12 2l2.4 6.8 7.6.4-5.7 4.6 1.9 7.2-6.2-4.2-6.2 4.2 1.9-7.2L2 9.2l7.6-.4z" fill="#fff" />
                          </svg>
                        </span>
                      )}
                      {bomb && (
                        <span className="tetris-cell-bomb-mark">
                          <span className="tetris-cell-bomb-fuse" />
                          <span className="tetris-cell-bomb-spark" />
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
