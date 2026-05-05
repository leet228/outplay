// Tetris Cascade — HONEST RNG simulator (Pragmatic-style).
//
// No target_payout, no scaling. Pieces fall, matches found, multipliers
// applied per the paytable, cascades chain naturally. RTP comes out as
// whatever the math produces. This file is the source of truth for the
// paytable — once it sims to ~94 % RTP at 100k+ spins, we copy the
// constants verbatim into the client + SQL.
//
// Run: node scripts/tetris-honest-sim.js
'use strict'

// ─── Game constants (must match TetrisCascadeSlot.jsx) ──────────
const COLS              = 10
const ROWS              = 8
const INITIAL_PIECES    = 12
const COLOR_LINE_MIN    = 7
const MAX_CASCADES      = 4
const WILD_RATE         = 0.06
const COIN_RATE         = 0.040
const COINS_TO_TRIGGER  = 5
const BONUS_FREE_SPINS  = 6
const BONUS_PIECE_MULS  = [0.5, 1, 1, 2]   // avg = 1.125
const RAGE_MAX          = 6

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

// ─── PAYTABLE — TUNE THIS ────────────────────────────────────────
// All numbers are × stake. A spin of 100 ₽ that hits "fullRow=1"
// receives 100 ₽ for that match (additive across simultaneous matches
// in one cascade step).
const PAY = {
  fullRow: 0.20,   // 10 cells in a single row cleared (any colour mix)
  fullCol: 0.08,   // 8 cells in a single column cleared (any colour mix)
  run7:    0.45,   // colour run length 7 (horizontal OR vertical)
  run8:    1.60,
  run9:    5.20,
  run10:  21.00,
}
// Bonus mode pays stake × Σ(cell.mul) over all cleared cells, where
// each cell's mul is uniform random from BONUS_PIECE_MULS. So the
// bonus economy is governed entirely by BONUS_PIECE_MULS; we leave
// it at [2,3,5,10] and let the math fall out.

// ─── Helpers (mirror TetrisCascadeSlot.jsx) ──────────────────────
function makeEmptyGrid() {
  return Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => null))
}
function pieceWidth(cells) { return Math.max(...cells.map(c => c[0])) + 1 }
function isFilled(c)   { return c !== null && c !== 'CLEARING' }
function isCellWild(c) { return c && c.kind === 'wild' }
function isCellCoin(c) { return c && c.kind === 'coin' }
function cellMul(c)    { return c?.mul || 1 }
function isLineFiller(c) { return isFilled(c) && !isCellCoin(c) }
function colourOf(c) {
  if (!isFilled(c) || isCellCoin(c)) return null
  return c.color
}
function colourMatchesRun(runColor, cv) {
  if (cv === null) return false
  if (cv === 'wild') return true
  return runColor === 'wild' || runColor === cv
}

function pickRandomPiece({ forceI = false, bonus = false, noSpecial = false } = {}) {
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

function makeCell(piece, mulProvider) {
  return {
    kind: piece.kind,
    color: piece.color,
    mul: mulProvider ? mulProvider() : 1,
  }
}

function canPlace(grid, cells, x, y) {
  for (const [dx, dy] of cells) {
    const cx = x + dx, cy = y + dy
    if (cx < 0 || cx >= COLS || cy < 0 || cy >= ROWS) return false
    if (grid[cy][cx] !== null) return false
  }
  return true
}

function dropPiece(grid, piece, x, mulProvider) {
  let y = 0
  while (canPlace(grid, piece.cells, x, y + 1)) y++
  if (!canPlace(grid, piece.cells, x, y)) return { grid, placed: false }
  const ng = grid.map(row => [...row])
  for (const [dx, dy] of piece.cells) {
    ng[y + dy][x + dx] = makeCell(piece, mulProvider)
  }
  return { grid: ng, placed: true }
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

// Honest placement: no clear-bias. Just avoid towering / holes so the
// grid remains playable — mirrors current pickColumn() with clearWeight=0.
function pickColumn(grid, piece) {
  const w = pieceWidth(piece.cells)
  const candidates = []
  for (let x = 0; x <= COLS - w; x++) {
    if (!canPlace(grid, piece.cells, x, 0)) continue
    const { grid: simGrid } = dropPiece(grid, piece, x)
    const heights   = columnHeights(simGrid)
    const aggHeight = heights.reduce((a, b) => a + b, 0)
    const maxHeight = Math.max(...heights)
    const holes     = countHoles(simGrid)
    const score = -aggHeight * 0.7 - maxHeight * 1.0 - holes * 30 + Math.random() * 18
    candidates.push({ x, score })
  }
  if (candidates.length === 0) return -1
  candidates.sort((a, b) => b.score - a.score)
  const top = candidates.slice(0, Math.min(2, candidates.length))
  return top[Math.floor(Math.random() * top.length)].x
}

// Mirror of TetrisCascadeSlot.jsx#findMatches
function findMatches(grid) {
  const matches = []

  // Full rows
  for (let r = 0; r < ROWS; r++) {
    if (grid[r].every(isLineFiller)) {
      const cells = []
      for (let c = 0; c < COLS; c++) cells.push([c, r])
      matches.push({ type: 'row', cells, len: COLS })
    }
  }
  // Full columns
  for (let c = 0; c < COLS; c++) {
    let full = true
    for (let r = 0; r < ROWS; r++) {
      if (!isLineFiller(grid[r][c])) { full = false; break }
    }
    if (full) {
      const cells = []
      for (let r = 0; r < ROWS; r++) cells.push([c, r])
      matches.push({ type: 'col', cells, len: ROWS })
    }
  }

  // Horizontal colour runs
  for (let r = 0; r < ROWS; r++) {
    let runStart = 0, runColor = null, allWild = true
    const closeRun = (endC) => {
      const len = endC - runStart
      if (len >= COLOR_LINE_MIN && !allWild && runColor !== null && runColor !== 'wild') {
        const cells = []
        for (let i = runStart; i < endC; i++) cells.push([i, r])
        matches.push({ type: 'color-h', cells, color: runColor, len })
      }
    }
    for (let c = 0; c <= COLS; c++) {
      const cell = c < COLS ? grid[r][c] : null
      const cv = colourOf(cell)
      if (cv === null) {
        closeRun(c); runStart = c + 1; runColor = null; allWild = true
      } else if (runColor === null) {
        runStart = c; runColor = cv; allWild = (cv === 'wild')
      } else if (colourMatchesRun(runColor, cv)) {
        if (cv !== 'wild') { runColor = cv; allWild = false }
      } else {
        closeRun(c); runStart = c; runColor = cv; allWild = (cv === 'wild')
      }
    }
  }

  // Vertical colour runs
  for (let c = 0; c < COLS; c++) {
    let runStart = 0, runColor = null, allWild = true
    const closeRun = (endR) => {
      const len = endR - runStart
      if (len >= COLOR_LINE_MIN && !allWild && runColor !== null && runColor !== 'wild') {
        const cells = []
        for (let i = runStart; i < endR; i++) cells.push([c, i])
        matches.push({ type: 'color-v', cells, color: runColor, len })
      }
    }
    for (let r = 0; r <= ROWS; r++) {
      const cell = r < ROWS ? grid[r][c] : null
      const cv = colourOf(cell)
      if (cv === null) {
        closeRun(r); runStart = r + 1; runColor = null; allWild = true
      } else if (runColor === null) {
        runStart = r; runColor = cv; allWild = (cv === 'wild')
      } else if (colourMatchesRun(runColor, cv)) {
        if (cv !== 'wild') { runColor = cv; allWild = false }
      } else {
        closeRun(r); runStart = r; runColor = cv; allWild = (cv === 'wild')
      }
    }
  }

  return matches
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

function countCoins(grid) {
  let n = 0
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++)
      if (isCellCoin(grid[r][c])) n++
  return n
}

// ─── Pay calculation ────────────────────────────────────────────
function payMulFor(m) {
  if (m.type === 'row') return PAY.fullRow
  if (m.type === 'col') return PAY.fullCol
  if (m.type === 'color-h' || m.type === 'color-v') {
    if (m.len <= 7)  return PAY.run7
    if (m.len === 8) return PAY.run8
    if (m.len === 9) return PAY.run9
    return PAY.run10
  }
  return 0
}

// ─── Run a single non-bonus spin ────────────────────────────────
function runRegularSpin(stake, breakdown) {
  let g = makeEmptyGrid()

  // Initial drop (12 pieces)
  for (let i = 0; i < INITIAL_PIECES; i++) {
    const piece = pickRandomPiece({})
    const x = pickColumn(g, piece)
    if (x < 0) continue
    const { grid: ng, placed } = dropPiece(g, piece, x)
    if (placed) g = ng
  }

  let win = 0
  let cascadeNum = 0

  while (cascadeNum < MAX_CASCADES) {
    const matches = findMatches(g)
    if (matches.length === 0) break
    cascadeNum++

    const cellSet = new Set()
    for (const m of matches) for (const [x, y] of m.cells) cellSet.add(`${x},${y}`)

    for (const m of matches) {
      const w = stake * payMulFor(m)
      win += w
      if (breakdown) {
        const key = m.type === 'row' ? 'fullRow'
                  : m.type === 'col' ? 'fullCol'
                  : (m.len <= 7 ? 'run7' : m.len === 8 ? 'run8' : m.len === 9 ? 'run9' : 'run10')
        breakdown[key] = (breakdown[key] || 0) + w
      }
    }

    g = applyGravity(g, cellSet)

    const refillCount = 3 + Math.ceil(matches.length * 1.5)
    for (let i = 0; i < refillCount; i++) {
      const piece = pickRandomPiece({})
      const x = pickColumn(g, piece)
      if (x < 0) break
      const { grid: ng, placed } = dropPiece(g, piece, x)
      if (placed) g = ng
    }
  }

  const triggeredBonus = countCoins(g) >= COINS_TO_TRIGGER
  return { win, triggeredBonus }
}

// ─── Run a bonus round (10 free spins, per-cell multipliers) ────
function runBonusRound(stake) {
  let totalWin = 0
  let rage = 0
  let forceI = false

  for (let s = 0; s < BONUS_FREE_SPINS; s++) {
    let g = makeEmptyGrid()
    const mulProvider = () =>
      BONUS_PIECE_MULS[Math.floor(Math.random() * BONUS_PIECE_MULS.length)]

    for (let i = 0; i < INITIAL_PIECES; i++) {
      const useForceI = forceI && i === 0
      if (useForceI) forceI = false
      const piece = pickRandomPiece({ bonus: true, forceI: useForceI })
      const x = pickColumn(g, piece)
      if (x < 0) continue
      const { grid: ng, placed } = dropPiece(g, piece, x, mulProvider)
      if (placed) g = ng
    }

    let cascadeNum = 0
    while (cascadeNum < MAX_CASCADES) {
      const matches = findMatches(g)
      if (matches.length === 0) break
      cascadeNum++

      const cellSet = new Set()
      for (const m of matches) for (const [x, y] of m.cells) cellSet.add(`${x},${y}`)

      // Bonus pay: stake × Σ mul over cleared cells
      let mulSum = 0
      for (const k of cellSet) {
        const [x, y] = k.split(',').map(Number)
        mulSum += cellMul(g[y][x])
      }
      totalWin += stake * mulSum

      rage += matches.length
      if (rage >= RAGE_MAX) {
        forceI = true
        rage = 0
      }

      g = applyGravity(g, cellSet)

      const refillCount = 3 + Math.ceil(matches.length * 1.5)
      for (let i = 0; i < refillCount; i++) {
        const piece = pickRandomPiece({ bonus: true })
        const x = pickColumn(g, piece)
        if (x < 0) break
        const { grid: ng, placed } = dropPiece(g, piece, x, mulProvider)
        if (placed) g = ng
      }
    }
  }

  return totalWin
}

// ─── Drive a batch of N spins ───────────────────────────────────
function simulate(N, stake = 100, opts = {}) {
  const { collectBreakdown = false } = opts
  let totalWagered = 0
  let totalWon = 0
  let bonusFires = 0
  let maxWin = 0
  let hits = 0
  const breakdown = collectBreakdown
    ? { fullRow: 0, fullCol: 0, run7: 0, run8: 0, run9: 0, run10: 0, bonus: 0 }
    : null

  for (let i = 0; i < N; i++) {
    totalWagered += stake
    const r = runRegularSpin(stake, breakdown)
    let spinWin = r.win
    if (r.triggeredBonus) {
      bonusFires++
      const bonusWin = runBonusRound(stake)
      if (breakdown) breakdown.bonus += bonusWin
      spinWin += bonusWin
    }
    if (spinWin > 0)        hits++
    if (spinWin > maxWin)   maxWin = spinWin
    totalWon += spinWin
  }

  return {
    n: N,
    rtp:       totalWon / totalWagered,
    bonusRate: bonusFires / N,
    hitRate:   hits / N,
    maxWinX:   maxWin / stake,
    totalWagered,
    totalWon,
    breakdown,
  }
}

// ─── Output ─────────────────────────────────────────────────────
function fmtPct(x) { return (x * 100).toFixed(2) + '%' }

console.log('═══ Tetris Cascade — HONEST RNG simulator ═══')
console.log('Paytable:')
for (const [k, v] of Object.entries(PAY)) console.log(`  ${k.padEnd(10)} = ${v}× stake`)
console.log(`Bonus piece muls = [${BONUS_PIECE_MULS.join(', ')}]`)
console.log()

for (const n of [100, 1_000, 10_000, 100_000]) {
  const r = simulate(n, 100, { collectBreakdown: true })
  console.log(
    `N = ${String(n).padStart(7)}   ` +
    `RTP = ${fmtPct(r.rtp).padStart(7)}   ` +
    `hit = ${fmtPct(r.hitRate).padStart(7)}   ` +
    `bonus = ${fmtPct(r.bonusRate).padStart(7)}   ` +
    `maxWin = ${r.maxWinX.toFixed(0)}× stake`
  )
  if (n === 100_000 && r.breakdown) {
    console.log('  Breakdown (% of total wagered):')
    for (const [k, v] of Object.entries(r.breakdown)) {
      console.log(`    ${k.padEnd(8)} = ${fmtPct(v / r.totalWagered).padStart(7)}`)
    }
  }
}

// Variance check at 1k
console.log('\n── Variance — 30 runs of 1 000 spins ──')
{
  const trials = []
  for (let i = 0; i < 30; i++) trials.push(simulate(1_000))
  const rtps = trials.map(t => t.rtp)
  const avg  = rtps.reduce((a, b) => a + b, 0) / rtps.length
  const min  = Math.min(...rtps), max = Math.max(...rtps)
  const std  = Math.sqrt(rtps.reduce((a, b) => a + (b - avg) ** 2, 0) / rtps.length)
  console.log(`  RTP avg ${fmtPct(avg)}  min ${fmtPct(min)}  max ${fmtPct(max)}  std ${fmtPct(std)}`)
}

// Long-run truth: average over multiple 100k batches.
console.log('\n── True mean — 5 runs of 100 000 spins ──')
{
  const trials = []
  for (let i = 0; i < 5; i++) trials.push(simulate(100_000))
  const rtps = trials.map(t => t.rtp)
  const avg  = rtps.reduce((a, b) => a + b, 0) / rtps.length
  const min  = Math.min(...rtps), max = Math.max(...rtps)
  console.log(`  RTP avg ${fmtPct(avg)}  min ${fmtPct(min)}  max ${fmtPct(max)}`)
  console.log(`  per-run: ${rtps.map(fmtPct).join('  ')}`)
}
