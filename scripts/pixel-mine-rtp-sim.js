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
  { sym: 'tnt',       weight: 5.9 },
  { sym: 'book',      weight: 1.65 },
  { sym: 'ender',     weight: 1.52 },
  { sym: 'blank',     weight: 29.61 },
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

// FS reel layout — strip ender scatters so the bonus can't
// re-trigger itself (mirrors generateReelsNoEnder in the game).
function generateReelsNoEnder() {
  const reels = generateReels()
  for (let r = 0; r < REEL_ROWS; r++) {
    for (let c = 0; c < REEL_COLS; c++) {
      if (reels[r][c] === 'ender') reels[r][c] = 'blank'
    }
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

// Detect newly-cleared columns and mark their chests open. Returns
// an array of multipliers that were "newly opened" this phase.
// Multipliers are NOT applied here — the caller stacks them across
// the whole spin / bonus and applies them all at the end.
function detectChestOpens(grid, chests) {
  const opens = []
  for (let c = 0; c < GRID_COLS; c++) {
    if (chests[c].open) continue
    let cleared = true
    for (let r = 0; r < GRID_ROWS; r++) {
      if (grid[r][c]) { cleared = false; break }
    }
    if (cleared) {
      chests[c].open = true
      opens.push(chests[c].mul)
    }
  }
  return opens
}

// One spin's RAW win — pickaxes + TNT only, NO chest mults applied.
// Returns { rawWin, opens } where `opens` is the list of newly-
// opened chest multipliers in this phase. The caller chains them.
function runOnePhase(grid, rawReels, chests, stake) {
  const reels = applyBookUpgrades(rawReels)
  let rawWin = 0
  // Pickaxes
  for (let c = 0; c < REEL_COLS; c++) {
    for (let r = 0; r < REEL_ROWS; r++) {
      const sym = reels[r][c]
      if (PICKAXE_KINDS.has(sym)) rawWin += dropPickaxe(grid, sym, c, stake)
    }
  }
  // TNT
  for (let c = 0; c < REEL_COLS; c++) {
    for (let r = 0; r < REEL_ROWS; r++) {
      const sym = reels[r][c]
      if (sym === 'tnt') rawWin += explodeTnt(grid, c, stake)
    }
  }
  const opens = detectChestOpens(grid, chests)
  return { rawWin, opens }
}

// One full round (trigger spin + optional 4 FS). Chest mults from
// EVERY opened chest across the round multiply the CUMULATIVE raw
// win at the end — not piecewise per spin. This matches the in-
// game reveal sequence.
function runFullSpin(stake) {
  const rawReels = generateReels()
  const grid = generateGrid()
  const chests = generateChests()

  let cumulativeRaw = 0
  const allOpens = []

  const trig = runOnePhase(grid, rawReels, chests, stake)
  cumulativeRaw += trig.rawWin
  allOpens.push(...trig.opens)

  if (countEnders(rawReels) >= SCATTER_TRIGGER) {
    for (let i = 0; i < FS_COUNT; i++) {
      const fsReels = generateReelsNoEnder()
      const fs = runOnePhase(grid, fsReels, chests, stake)
      cumulativeRaw += fs.rawWin
      allOpens.push(...fs.opens)
    }
  }

  // Apply all chest mults to the cumulative raw, in detection order.
  let total = cumulativeRaw
  for (const m of allOpens) total = Math.round(total * m)

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

  // Bonus payout distribution buckets — tracks how many triggered
  // bonuses paid back at various profit thresholds.
  let bonusZero        = 0   // 0 payout
  let bonusGtZero      = 0   // > 0
  let bonusGteStake    = 0   // ≥ 1× stake (covered the trigger spin's bet)
  let bonusGte10x      = 0   // ≥ 10× stake (decent run)
  let bonusGte50x      = 0   // ≥ 50× stake
  let bonusGte100x     = 0   // ≥ 100× stake (covered Buy Bonus cost)
  let bonusGte500x     = 0   // ≥ 500× stake (good hit)
  let bonusGteCap      = 0   // hit the 5000× cap
  let bonusWinSum      = 0
  let bonusWinSqSum    = 0
  let bonusBest        = 0

  for (let i = 0; i < spins; i++) {
    totalBet += stake
    const rawReels = generateReels()
    const grid = generateGrid()
    const chests = generateChests()

    // Trigger spin — raw + opens.
    const trig = runOnePhase(grid, rawReels, chests, stake)
    let cumulativeRaw = trig.rawWin
    const allOpens = trig.opens.slice()

    // Count chests opened during base only (before FS started).
    chestOpensBaseOnly += chests.filter(c => c.open).length

    let isBonus = countEnders(rawReels) >= SCATTER_TRIGGER
    if (isBonus) {
      bonusEntries++
      for (let j = 0; j < FS_COUNT; j++) {
        const fsReels = generateReelsNoEnder()
        const fs = runOnePhase(grid, fsReels, chests, stake)
        cumulativeRaw += fs.rawWin
        allOpens.push(...fs.opens)
      }
    }

    // Stack all chest mults at the end.
    let total = cumulativeRaw
    for (const m of allOpens) total = Math.round(total * m)
    const totalCapped = Math.min(total, stake * PAYOUT_CAP)

    if (isBonus) {
      bonusWin += totalCapped       // entire round (incl. trigger raw)
      // For distribution buckets we look at the WHOLE round's payout
      // when a bonus fires — that's what the player actually walks
      // away with, and it's the relevant number for "did the bonus
      // pay back its cost?" questions.
      bonusWinSum   += totalCapped
      bonusWinSqSum += totalCapped * totalCapped
      if (totalCapped > bonusBest) bonusBest = totalCapped
      if (totalCapped === 0)             bonusZero++
      if (totalCapped > 0)               bonusGtZero++
      if (totalCapped >= stake)          bonusGteStake++
      if (totalCapped >= stake * 10)     bonusGte10x++
      if (totalCapped >= stake * 50)     bonusGte50x++
      if (totalCapped >= stake * 100)    bonusGte100x++
      if (totalCapped >= stake * 500)    bonusGte500x++
      if (totalCapped >= stake * PAYOUT_CAP) bonusGteCap++
    } else {
      baseWin += totalCapped
    }

    chestOpensTotal += chests.filter(c => c.open).length
  }

  const avgBonus = bonusEntries > 0 ? bonusWinSum / bonusEntries : 0
  const varBonus = bonusEntries > 0
    ? Math.max(0, bonusWinSqSum / bonusEntries - avgBonus * avgBonus)
    : 0

  return {
    rtp:           (baseWin + bonusWin) / totalBet,
    baseRtp:       baseWin / totalBet,
    bonusRtp:      bonusWin / totalBet,
    bonusFreq:     bonusEntries / spins,
    bonusEntries,
    avgChestsBase: chestOpensBaseOnly / spins,
    avgChestsAll:  chestOpensTotal / spins,

    // Bonus distribution (% of triggered bonuses)
    bonusAvg:        avgBonus,
    bonusBest:       bonusBest,
    bonusStdDev:     Math.sqrt(varBonus),
    pctBonusZero:    bonusEntries > 0 ? bonusZero      / bonusEntries : 0,
    pctBonusGtZero:  bonusEntries > 0 ? bonusGtZero    / bonusEntries : 0,
    pctBonusGteStake:bonusEntries > 0 ? bonusGteStake  / bonusEntries : 0,
    pctBonus10x:     bonusEntries > 0 ? bonusGte10x    / bonusEntries : 0,
    pctBonus50x:     bonusEntries > 0 ? bonusGte50x    / bonusEntries : 0,
    pctBonus100x:    bonusEntries > 0 ? bonusGte100x   / bonusEntries : 0,
    pctBonus500x:    bonusEntries > 0 ? bonusGte500x   / bonusEntries : 0,
    pctBonusCap:     bonusEntries > 0 ? bonusGteCap    / bonusEntries : 0,
  }
}

// ── Main ──
const SPINS = parseInt(process.argv[2] || '300000', 10)
console.log(`Running ${SPINS.toLocaleString()} spins...`)
const t0 = Date.now()
const r = simulate(SPINS)
// Bonus is ~1 in 600 spins, so push diagnose() through enough spins
// to land at least a few thousand bonus samples.
const d = diagnose(Math.min(SPINS, 5_000_000))
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
console.log('Bonus payout distribution:')
console.log(`  Sample size:        ${d.bonusEntries.toLocaleString()} bonus rounds`)
console.log(`  Avg bonus payout:   ${d.bonusAvg.toFixed(2)} × stake`)
console.log(`  Best bonus seen:    ${d.bonusBest.toFixed(0)} × stake`)
console.log(`  σ (volatility):     ${d.bonusStdDev.toFixed(2)} × stake`)
console.log(`  % paying 0:         ${(d.pctBonusZero    * 100).toFixed(2)} %`)
console.log(`  % paying > 0:       ${(d.pctBonusGtZero  * 100).toFixed(2)} %`)
console.log(`  % paying ≥ 1×:      ${(d.pctBonusGteStake* 100).toFixed(2)} %  (covered the trigger bet)`)
console.log(`  % paying ≥ 10×:     ${(d.pctBonus10x     * 100).toFixed(2)} %`)
console.log(`  % paying ≥ 50×:     ${(d.pctBonus50x     * 100).toFixed(2)} %`)
console.log(`  % paying ≥ 100×:    ${(d.pctBonus100x    * 100).toFixed(2)} %  (Buy Bonus break-even)`)
console.log(`  % paying ≥ 500×:    ${(d.pctBonus500x    * 100).toFixed(2)} %`)
console.log(`  % hitting cap 5000×:${(d.pctBonusCap     * 100).toFixed(3)} %`)
console.log('═'.repeat(50))
