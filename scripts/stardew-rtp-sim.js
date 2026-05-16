// Stardew Spins RTP simulator — Monte Carlo over the real engine:
//   • base game: 6×5 Pay-Anywhere (8+) with tumble cascades
//   • 3+ lime scatters → "Year of Harvest" bonus (10 free spins,
//     5×5 farm, sow → grow → harvest, lightning ×100 boosts)
//   • buy-bonus: forced 3-scatter spin, cost = stake × 100
//
// IMPORTANT: this file is the tuning surface for PROBABILITIES
// ONLY. The payout multipliers (PAYOUTS, BONUS_CROP_PAY,
// LIGHTNING_FRUIT_MULT) are LOCKED to match StardewSpinsSlot.jsx
// exactly — do not touch them here. Tune the *weights* and
// *chances* below to land Total RTP ≈ 95%.
//
// Run:  node scripts/stardew-rtp-sim.js
'use strict'

// ─────────────────────────────────────────────────────────────
// PROBABILITY TUNABLES — keep in sync with StardewSpinsSlot.jsx
// (these are the ONLY numbers you may change to hit target RTP)
// ─────────────────────────────────────────────────────────────
const SYMBOLS = [
  { id: 'potatoe',    weight: 11 },
  { id: 'carrot',     weight: 11 },
  { id: 'corn',       weight: 12 },
  { id: 'eggplant',   weight: 12 },
  { id: 'tomatoe',    weight: 13 },
  { id: 'grape',      weight: 13 },
  { id: 'pumpkin',    weight: 13 },
  { id: 'watermelon', weight: 12 },
  { id: 'lime',       weight: 1.07, isScatter: true },
]
const BONUS_SOW_CHANCE       = 0.075  // per empty cell, per sow beat
const BONUS_LIGHTNING_CHANCE = 0.03   // per free spin

// ─────────────────────────────────────────────────────────────
// LOCKED PAYOUTS — DO NOT EDIT (mirror of the slot's иксы)
// ─────────────────────────────────────────────────────────────
const MIN_MATCH = 8
const PAYOUTS = {
  potatoe:    { 8: 0.25, 10: 0.75, 12:  2.00 },
  carrot:     { 8: 0.40, 10: 0.90, 12:  4.00 },
  corn:       { 8: 0.50, 10: 1.00, 12:  5.00 },
  eggplant:   { 8: 0.80, 10: 1.20, 12:  8.00 },
  tomatoe:    { 8: 1.00, 10: 1.50, 12: 10.00 },
  grape:      { 8: 1.50, 10: 2.00, 12: 12.00 },
  pumpkin:    { 8: 2.00, 10: 5.00, 12: 15.00 },
  watermelon: { 8: 2.50, 10: 10.00, 12: 25.00 },
}
const BONUS_CROP_PAY = {
  carrot: 1, potatoe: 3, corn: 8, eggplant: 2,
  tomatoe: 4, watermelon: 20, pumpkin: 5, grape: 10,
}
const LIGHTNING_FRUIT_MULT = 100

// ── Structural constants (mirror the slot) ──
const COLS = 6, ROWS = 5, CELL_COUNT = COLS * ROWS
const SCATTER_ID = 'lime'
const SCATTERS_TO_TRIGGER = 3
const BUY_BONUS_MULT = 100
const BONUS_SPINS = 10
const BONUS_ROWS = 5, BONUS_COLS = 5, BONUS_CELLS = BONUS_ROWS * BONUS_COLS
const STAGE_FRUIT = 3
const SEASON_CROPS = {
  spring: ['carrot', 'potatoe', 'corn'],
  summer: ['eggplant', 'tomatoe', 'watermelon'],
  fall:   ['pumpkin', 'grape'],
  winter: [],
}
function bonusSeasonForSpin(n) {
  if (n <= 3) return 'spring'
  if (n <= 6) return 'summer'
  if (n <= 9) return 'fall'
  return 'winter'
}

// ─────────────────────────────────────────────────────────────
const SYM_WEIGHT_SUM = SYMBOLS.reduce((s, x) => s + x.weight, 0)
const SCATTER_W = SYMBOLS.find(s => s.isScatter).weight
const NON_SCATTER = SYMBOLS.filter(s => !s.isScatter)
const NON_SCATTER_SUM = NON_SCATTER.reduce((s, x) => s + x.weight, 0)

function pickSymbol() {
  let r = Math.random() * SYM_WEIGHT_SUM
  for (const s of SYMBOLS) {
    if (r < s.weight) return s.id
    r -= s.weight
  }
  return SYMBOLS[0].id
}
function pickNonScatter() {
  let r = Math.random() * NON_SCATTER_SUM
  for (const s of NON_SCATTER) {
    if (r < s.weight) return s.id
    r -= s.weight
  }
  return NON_SCATTER[0].id
}
function pickSeasonCrop(season) {
  const pool = SEASON_CROPS[season]
  if (!pool || pool.length === 0) return null
  return pool[Math.floor(Math.random() * pool.length)]
}

function genGrid() {
  const g = new Array(CELL_COUNT)
  for (let i = 0; i < CELL_COUNT; i++) g[i] = pickSymbol()
  return g
}
function genGridForcedScatters() {
  const g = new Array(CELL_COUNT)
  for (let i = 0; i < CELL_COUNT; i++) g[i] = pickNonScatter()
  const slots = new Set()
  while (slots.size < SCATTERS_TO_TRIGGER) slots.add(Math.floor(Math.random() * CELL_COUNT))
  for (const i of slots) g[i] = SCATTER_ID
  return g
}

function findWins(grid) {
  const buckets = {}
  for (let i = 0; i < grid.length; i++) {
    const s = grid[i]
    if (!s || s === SCATTER_ID) continue
    ;(buckets[s] || (buckets[s] = [])).push(i)
  }
  const wins = {}
  for (const sym of Object.keys(buckets)) {
    if (buckets[sym].length >= MIN_MATCH) wins[sym] = buckets[sym]
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
function tumbleGrid(grid, winSet) {
  const next = new Array(CELL_COUNT)
  for (let c = 0; c < COLS; c++) {
    const survivors = []
    for (let r = 0; r < ROWS; r++) {
      const i = r * COLS + c
      if (!winSet.has(i)) survivors.push(grid[i])
    }
    const K = ROWS - survivors.length
    for (let r = 0; r < ROWS; r++) {
      const i = r * COLS + c
      next[i] = r < K ? pickSymbol() : survivors[r - K]
    }
  }
  return next
}

// One base spin → { win (× stake), scatters } after all cascades.
function baseSpin(forced) {
  let g = forced ? genGridForcedScatters() : genGrid()
  let win = 0
  let chain = 0
  while (chain < 60) {
    const wins = findWins(g)
    const ids = Object.keys(wins)
    if (ids.length === 0) break
    const winSet = new Set()
    for (const sym of ids) {
      win += payoutFor(sym, wins[sym].length)
      wins[sym].forEach(i => winSet.add(i))
    }
    g = tumbleGrid(g, winSet)
    chain++
  }
  let scatters = 0
  for (const s of g) if (s === SCATTER_ID) scatters++
  return { win, scatters }
}

// Full "Year of Harvest": 10 free spins on a 5×5 board.
// HARVEST (ripe-from-before) → GROW → SOW → LIGHTNING.
function runBonus() {
  let board = new Array(BONUS_CELLS).fill(null)
  let total = 0
  for (let n = 1; n <= BONUS_SPINS; n++) {
    const season = bonusSeasonForSpin(n)
    // HARVEST
    for (let i = 0; i < BONUS_CELLS; i++) {
      const cl = board[i]
      if (cl && cl.stage === STAGE_FRUIT) {
        total += cl.boosted
          ? LIGHTNING_FRUIT_MULT
          : (BONUS_CROP_PAY[cl.crop] || 0)
        board[i] = null
      }
    }
    // GROW
    for (let i = 0; i < BONUS_CELLS; i++) {
      const cl = board[i]
      if (cl && cl.stage < STAGE_FRUIT) board[i] = { ...cl, stage: cl.stage + 1 }
    }
    // SOW
    const crop = pickSeasonCrop(season)
    if (crop) {
      for (let i = 0; i < BONUS_CELLS; i++) {
        if (board[i]) continue
        if (Math.random() < BONUS_SOW_CHANCE) board[i] = { crop, stage: 1 }
      }
    }
    // LIGHTNING
    if (Math.random() < BONUS_LIGHTNING_CHANCE) {
      const occ = []
      for (let i = 0; i < BONUS_CELLS; i++) if (board[i]) occ.push(i)
      if (occ.length) {
        const t = occ[Math.floor(Math.random() * occ.length)]
        board[t] = { ...board[t], boosted: true }
      }
    }
  }
  return total
}

function bucket(w) {
  if (w <= 0)    return '0x       '
  if (w < 0.5)   return '<0.5x    '
  if (w < 1)     return '0.5-1x   '
  if (w < 2)     return '1-2x     '
  if (w < 5)     return '2-5x     '
  if (w < 10)    return '5-10x    '
  if (w < 25)    return '10-25x   '
  if (w < 50)    return '25-50x   '
  if (w < 100)   return '50-100x  '
  if (w < 250)   return '100-250x '
  if (w < 500)   return '250-500x '
  if (w < 1000)  return '500-1000x'
  return '1000x+   '
}

function simulate(N) {
  let totalStake = 0, totalPayout = 0, basePayout = 0, bonusPayout = 0
  let hitCount = 0, bonusTriggers = 0
  let maxSpin = 0, maxBonus = 0, maxOverall = 0
  const hist = {}
  for (let i = 0; i < N; i++) {
    totalStake += 1
    const r = baseSpin(false)
    let perSpin = r.win
    basePayout += r.win
    if (r.win > 0) hitCount++
    if (r.win > maxSpin) maxSpin = r.win
    if (r.scatters >= SCATTERS_TO_TRIGGER) {
      bonusTriggers++
      const bw = runBonus()
      bonusPayout += bw
      perSpin += bw
      if (bw > maxBonus) maxBonus = bw
    }
    totalPayout += perSpin
    if (perSpin > maxOverall) maxOverall = perSpin
    const b = bucket(perSpin)
    hist[b] = (hist[b] || 0) + 1
  }
  return {
    spins: N,
    rtp: totalPayout / totalStake,
    baseRtp: basePayout / totalStake,
    bonusContribution: bonusPayout / totalStake,
    hitRate: hitCount / N,
    bonusTriggerRate: bonusTriggers / N,
    bonusTriggerOneIn: bonusTriggers ? Math.round(N / bonusTriggers) : Infinity,
    avgBonusWin: bonusTriggers ? bonusPayout / bonusTriggers : 0,
    maxSpin, maxBonus, maxOverall, hist,
  }
}

// Buy-bonus EV — forced 3 scatters every run, cost = stake × 100.
function simulateBuyBonus(N) {
  let totalCost = 0, totalReturn = 0, maxWin = 0, profitable = 0
  for (let i = 0; i < N; i++) {
    totalCost += BUY_BONUS_MULT
    const r = baseSpin(true)            // forced scatters
    const ret = r.win + runBonus()
    if (ret >= BUY_BONUS_MULT) profitable++
    totalReturn += ret
    if (ret > maxWin) maxWin = ret
  }
  return {
    runs: N,
    avgReturn: totalReturn / N,
    avgCost: BUY_BONUS_MULT,
    buyEv: totalReturn / totalCost,
    profitableRate: profitable / N,
    maxWin,
  }
}

function fmtPct(x) { return (x * 100).toFixed(2) + '%' }
function fmtNum(x) { return x.toFixed(2) }

function reportSpin(label, res) {
  console.log(`\n── ${label} ──`)
  console.log('Spins              :', res.spins.toLocaleString())
  console.log('Total RTP          :', fmtPct(res.rtp))
  console.log('  Base RTP         :', fmtPct(res.baseRtp))
  console.log('  Bonus RTP        :', fmtPct(res.bonusContribution))
  console.log('Hit rate (any pay) :', fmtPct(res.hitRate))
  console.log('Bonus trigger rate :', fmtPct(res.bonusTriggerRate),
              `(≈ 1 per ${res.bonusTriggerOneIn})`)
  console.log('Avg bonus payout   :', fmtNum(res.avgBonusWin), 'x stake')
  console.log('Max single spin    :', fmtNum(res.maxSpin), 'x stake')
  console.log('Max bonus total    :', fmtNum(res.maxBonus), 'x stake')
  console.log('Max overall (1 sp.):', fmtNum(res.maxOverall), 'x stake')
  console.log('Histogram:')
  const order = ['0x       ','<0.5x    ','0.5-1x   ','1-2x     ','2-5x     ',
                 '5-10x    ','10-25x   ','25-50x   ','50-100x  ',
                 '100-250x ','250-500x ','500-1000x','1000x+   ']
  for (const k of order) {
    const c = res.hist[k] || 0
    if (c > 0) console.log(`  ${k}: ${String(c).padStart(8)} ${((c / res.spins) * 100).toFixed(3).padStart(7)}%`)
  }
}
function reportBuy(label, res) {
  console.log(`\n── ${label} ──`)
  console.log('Runs               :', res.runs.toLocaleString())
  console.log('Cost per buy       :', res.avgCost, 'x stake')
  console.log('Avg return         :', fmtNum(res.avgReturn), 'x stake')
  console.log('Buy-bonus EV / RTP :', fmtPct(res.buyEv))
  console.log('% profitable buys  :', fmtPct(res.profitableRate),
              `(buy returned ≥ ${BUY_BONUS_MULT}×)`)
  console.log('Max win on buy     :', fmtNum(res.maxWin), 'x stake')
}

console.log('╔════════════════════════════════════════════════════════════╗')
console.log('║  Stardew Spins RTP simulator                               ║')
console.log('╚════════════════════════════════════════════════════════════╝')
console.log()
console.log('Symbol weights :', SYMBOLS.map(s => `${s.id}=${s.weight}`).join(' '))
console.log('Scatter P/cell :', (SCATTER_W / SYM_WEIGHT_SUM).toFixed(4))
console.log('Sow chance     :', BONUS_SOW_CHANCE)
console.log('Lightning chance:', BONUS_LIGHTNING_CHANCE)

const N_LIST = [50_000, 500_000, 2_000_000]
for (const N of N_LIST) reportSpin(`Monte-Carlo @ ${N.toLocaleString()} spins`, simulate(N))
reportBuy('Buy-bonus EV @ 200,000 runs', simulateBuyBonus(200_000))
