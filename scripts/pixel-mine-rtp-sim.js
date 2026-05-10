// =============================================================
// Pixel Mine — RTP simulator
//
// Mirrors the in-game logic from src/pages/PixelMineSlot.jsx
// (no animations, no React, just the math) and Monte-Carlo's it
// to estimate long-run RTP. Tweak the WEIGHTS section at the top
// to balance toward the design target (≤ 95 %).
//
// Run:
//   node scripts/pixel-mine-rtp-sim.js
//   node scripts/pixel-mine-rtp-sim.js 500000   # custom spin count
// =============================================================

// ── Geometry ──
const REEL_COLS = 5
const REEL_ROWS = 3
const GRID_COLS = 5
const GRID_ROWS = 7

// ── Pickaxe damage ──
const PICKAXE_HITS = { wood: 1, stone_p: 2, gold_p: 3, enchanted: 5 }
const PICKAXE_KINDS = new Set(['wood', 'stone_p', 'gold_p', 'enchanted'])

// ── Block paytable (locked — Mine Slot reference values) ──
const BLOCKS = {
  grass:    { hits: 1, pay: 0    },
  dirt:     { hits: 1, pay: 0    },
  stone:    { hits: 2, pay: 0.1  },
  redstone: { hits: 4, pay: 1    },
  gold:     { hits: 5, pay: 3    },
  diamond:  { hits: 6, pay: 5    },
  obsidian: { hits: 7, pay: 25   },
}

// ── Reel weights — only knob we're allowed to tune ──
const REEL_TABLE = [
  { sym: 'wood',      weight: 35 },
  { sym: 'stone_p',   weight: 18 },
  { sym: 'gold_p',    weight: 7.3 },
  { sym: 'enchanted', weight: 1.02 },
  { sym: 'tnt',       weight: 6.45 },
  { sym: 'book',      weight: 1.65 },
  { sym: 'ender',     weight: 1.605 },
  { sym: 'blank',     weight: 28.975 },
]

// ── Per-row block weights (top → bottom) ──
const COLUMN_ROW_TABLES = [
  [{ type: 'grass',    weight: 100 }],
  [
    { type: 'dirt',  weight: 80 },
    { type: 'stone', weight: 20 },
  ],
  [{ type: 'stone',    weight: 100 }],
  [{ type: 'redstone', weight: 100 }],
  [
    { type: 'gold',     weight: 70 },
    { type: 'diamond',  weight: 25 },
    { type: 'redstone', weight: 5  },
  ],
  [
    { type: 'diamond',  weight: 55 },
    { type: 'gold',     weight: 30 },
    { type: 'obsidian', weight: 15 },
  ],
  [
    { type: 'obsidian', weight: 60 },
    { type: 'diamond',  weight: 30 },
    { type: 'gold',     weight: 10 },
  ],
]

// ── Chest multipliers (locked — design-spec values) ──
const CHEST_MUL_TABLE = [
  { val: 2,   weight: 30 },
  { val: 3,   weight: 20 },
  { val: 4,   weight: 15 },
  { val: 5,   weight: 12 },
  { val: 10,  weight: 10 },
  { val: 25,  weight: 8  },
  { val: 50,  weight: 4  },
  { val: 100, weight: 1  },
]

// ── Bonus config ──
const SCATTER_TRIGGER = 3   // ≥3 Eye-of-Ender → 4 free spins
const FS_COUNT        = 4
const PAYOUT_CAP      = 5000  // server hard cap (× stake)

// ── Helpers ──
function pickWeighted(table, key) {
  const total = table.reduce((s, e) => s + e.weight, 0)
  let r = Math.random() * total
  for (const e of table) {
    r -= e.weight
    if (r < 0) return e[key]
  }
  return table[table.length - 1][key]
}

function generateReels() {
  const reels = []
  for (let r = 0; r < REEL_ROWS; r++) {
    const row = []
    for (let c = 0; c < REEL_COLS; c++) row.push(pickWeighted(REEL_TABLE, 'sym'))
    reels.push(row)
  }
  return reels
}

function generateColumn() {
  return COLUMN_ROW_TABLES.map(t => pickWeighted(t, 'type'))
}

function generateGrid() {
  const cols = []
  for (let c = 0; c < GRID_COLS; c++) cols.push(generateColumn())
  const grid = []
  for (let r = 0; r < GRID_ROWS; r++) {
    const row = []
    for (let c = 0; c < GRID_COLS; c++) {
      const t = cols[c][r]
      row.push({ type: t, hp: BLOCKS[t].hits })
    }
    grid.push(row)
  }
  return grid
}

function generateChests() {
  const out = []
  for (let c = 0; c < GRID_COLS; c++) {
    out.push({ mul: pickWeighted(CHEST_MUL_TABLE, 'val'), open: false })
  }
  return out
}

function topBlockRow(grid, col) {
  for (let r = 0; r < GRID_ROWS; r++) {
    if (grid[r][col] && grid[r][col].hp > 0) return r
  }
  return -1
}

function applyBookUpgrades(reels) {
  const out = reels.map(row => row.slice())
  for (let c = 0; c < REEL_COLS; c++) {
    let hasBook = false
    for (let r = 0; r < REEL_ROWS; r++) if (out[r][c] === 'book') { hasBook = true; break }
    if (!hasBook) continue
    for (let r = 0; r < REEL_ROWS; r++) {
      if (PICKAXE_KINDS.has(out[r][c])) out[r][c] = 'enchanted'
    }
  }
  return out
}

function countEnders(reels) {
  let n = 0
  for (let r = 0; r < REEL_ROWS; r++) {
    for (let c = 0; c < REEL_COLS; c++) {
      if (reels[r][c] === 'ender') n++
    }
  }
  return n
}

// ── Spin pipeline (no animations) ──
function dropPickaxe(grid, sym, col, stake) {
  let hits = PICKAXE_HITS[sym] || 0
  let added = 0
  while (hits > 0) {
    const r = topBlockRow(grid, col)
    if (r < 0) break
    const cell = grid[r][col]
    cell.hp -= 1
    hits -= 1
    if (cell.hp <= 0) {
      added += BLOCKS[cell.type].pay * stake
      grid[r][col] = null
    }
  }
  return added
}

function explodeTnt(grid, col, stake) {
  const tr = topBlockRow(grid, col)
  const landing = tr >= 0 ? tr : GRID_ROWS
  const center = landing - 1
  let added = 0
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const r = center + dr
      const c = col + dc
      if (r < 0 || r >= GRID_ROWS) continue
      if (c < 0 || c >= GRID_COLS) continue
      const cell = grid[r][c]
      if (!cell) continue
      const damage = Math.min(2, cell.hp)
      cell.hp -= damage
      if (cell.hp <= 0) {
        added += BLOCKS[cell.type].pay * stake
        grid[r][c] = null
      }
    }
  }
  return added
}

// Multiplicative chest stacking (matches the in-game logic) —
// the products of all newly-opened chests' mults are applied to
// the spin's win.
function openChests(grid, chests) {
  let mul = 1
  for (let c = 0; c < GRID_COLS; c++) {
    if (chests[c].open) continue
    let cleared = true
    for (let r = 0; r < GRID_ROWS; r++) {
      if (grid[r][c]) { cleared = false; break }
    }
    if (cleared) {
      chests[c].open = true
      mul *= chests[c].mul
    }
  }
  return mul
}

function runOnePhase(grid, rawReels, chests, stake) {
  const reels = applyBookUpgrades(rawReels)
  let win = 0
  // Pickaxes
  for (let c = 0; c < REEL_COLS; c++) {
    for (let r = 0; r < REEL_ROWS; r++) {
      const sym = reels[r][c]
      if (PICKAXE_KINDS.has(sym)) win += dropPickaxe(grid, sym, c, stake)
    }
  }
  // TNT
  for (let c = 0; c < REEL_COLS; c++) {
    for (let r = 0; r < REEL_ROWS; r++) {
      const sym = reels[r][c]
      if (sym === 'tnt') win += explodeTnt(grid, c, stake)
    }
  }
  // Chests
  const chestMul = openChests(grid, chests)
  if (chestMul > 1) win *= chestMul
  return win
}

function runFullSpin(stake) {
  const rawReels = generateReels()
  const grid = generateGrid()
  const chests = generateChests()
  let total = runOnePhase(grid, rawReels, chests, stake)
  if (countEnders(rawReels) >= SCATTER_TRIGGER) {
    for (let i = 0; i < FS_COUNT; i++) {
      const fsReels = generateReels()
      total += runOnePhase(grid, fsReels, chests, stake)
    }
  }
  // Server-side cap
  if (total > stake * PAYOUT_CAP) total = stake * PAYOUT_CAP
  return total
}

// ── Monte Carlo ──
function simulate(spins) {
  const stake = 1
  let totalBet = 0
  let totalWin = 0
  let bonusCount = 0
  let bigWins = 0   // wins ≥ 100×
  let maxWin = 0
  let sumSquare = 0  // for std-dev / volatility
  let zeroSpins = 0

  for (let i = 0; i < spins; i++) {
    totalBet += stake
    const win = runFullSpin(stake)
    totalWin += win
    sumSquare += win * win
    if (win === 0) zeroSpins++
    if (win >= 100) bigWins++
    if (win > maxWin) maxWin = win
    // Track bonus separately by re-rolling a deterministic check —
    // expensive; instead track via a side channel inside runFullSpin
    // would be cleaner. For now use a heuristic: any spin ≥ 30×
    // probably had a bonus.
  }

  // Re-run a smaller batch JUST to count bonus frequency.
  let bonusHits = 0
  const bonusProbe = Math.min(spins, 50_000)
  for (let i = 0; i < bonusProbe; i++) {
    const reels = generateReels()
    if (countEnders(reels) >= SCATTER_TRIGGER) bonusHits++
  }

  return {
    rtp:            totalWin / totalBet,
    avgWin:         totalWin / spins,
    hitRate:        1 - zeroSpins / spins,
    bigWinRate:     bigWins / spins,
    maxWin:         maxWin,
    bonusFreq:      bonusHits / bonusProbe,    // approx — Eye-of-Ender frequency on first spin
    volatility:     Math.sqrt(sumSquare / spins - Math.pow(totalWin / spins, 2)),
  }
}

// ── Diagnostic: split contribution between base and bonus ──
function diagnose(spins) {
  const stake = 1
  let totalBet = 0
  let baseWin = 0
  let bonusWin = 0
  let bonusEntries = 0
  let chestOpensTotal = 0
  let chestOpensBaseOnly = 0

  for (let i = 0; i < spins; i++) {
    totalBet += stake
    const rawReels = generateReels()
    const grid = generateGrid()
    const chests = generateChests()
    const baseSpin = runOnePhase(grid, rawReels, chests, stake)
    baseWin += Math.min(baseSpin, stake * PAYOUT_CAP)

    // Count chests opened during base
    const baseOpens = chests.filter(c => c.open).length
    chestOpensBaseOnly += baseOpens

    if (countEnders(rawReels) >= SCATTER_TRIGGER) {
      bonusEntries++
      let fs = 0
      for (let j = 0; j < FS_COUNT; j++) {
        const fsReels = generateReels()
        fs += runOnePhase(grid, fsReels, chests, stake)
      }
      bonusWin += Math.min(fs, stake * PAYOUT_CAP)
    }

    chestOpensTotal += chests.filter(c => c.open).length
  }

  return {
    rtp:           (baseWin + bonusWin) / totalBet,
    baseRtp:       baseWin / totalBet,
    bonusRtp:      bonusWin / totalBet,
    bonusFreq:     bonusEntries / spins,
    avgChestsBase: chestOpensBaseOnly / spins,
    avgChestsAll:  chestOpensTotal / spins,
  }
}

// ── Main ──
const SPINS = parseInt(process.argv[2] || '300000', 10)
console.log(`Running ${SPINS.toLocaleString()} spins...`)
const t0 = Date.now()
const r = simulate(SPINS)
const d = diagnose(Math.min(SPINS, 100_000))
const elapsed = ((Date.now() - t0) / 1000).toFixed(1)

console.log('')
console.log('═'.repeat(50))
console.log(`RTP overall:   ${(r.rtp * 100).toFixed(2)} %     (target ≤ 95)`)
console.log(`Base RTP:      ${(d.baseRtp * 100).toFixed(2)} %`)
console.log(`Bonus RTP:     ${(d.bonusRtp * 100).toFixed(2)} %`)
console.log(`Avg win:       ${r.avgWin.toFixed(3)} × stake`)
console.log(`Hit rate:      ${(r.hitRate * 100).toFixed(2)} %     (any non-zero win)`)
console.log(`Big-win rate:  ${(r.bigWinRate * 100).toFixed(3)} %  (≥100×)`)
console.log(`Max win:       ${r.maxWin.toFixed(0)} × stake`)
console.log(`Bonus freq:    1 in ${(1 / r.bonusFreq).toFixed(0)} (~${(r.bonusFreq * 100).toFixed(2)} %)`)
console.log(`Chests / spin: ${d.avgChestsBase.toFixed(3)} (base) / ${d.avgChestsAll.toFixed(3)} (incl. FS)`)
console.log(`Volatility σ:  ${r.volatility.toFixed(2)}`)
console.log(`Time:          ${elapsed} s`)
console.log('═'.repeat(50))
