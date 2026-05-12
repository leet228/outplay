// Magnetic Slot RTP simulator — runs Monte Carlo to measure
// RTP, hit rate, bonus trigger probability, max wins, and
// payout histogram. Lets us tune the symbol / magnet weights
// and PAYOUT_DIVISOR to land on ~95 % RTP before launch.
//
// Run:  node scripts/magnetic-rtp-sim.js
'use strict'

// ─────────────────────────────────────────────────────────────
// Tunable parameters — KEEP IN SYNC with MagneticSlot.jsx
// ─────────────────────────────────────────────────────────────
const SYMBOLS = [
  { id: 'blank',   strength: 0,    weight: 30, isScatter: false },
  { id: 'coin',    strength: 0.25, weight: 32, isScatter: false },
  { id: 'bolt',    strength: 0.50, weight: 20, isScatter: false },
  { id: 'compass', strength: 0.75, weight: 11, isScatter: false },
  { id: 'orb',     strength: 1.00, weight: 5,  isScatter: false },
  { id: 'gem',     strength: 0,    weight: 2,  isScatter: true  },
]

const MAGNET_POOL    = [2, 5, 10, 25, 50, 100]
const MAGNET_WEIGHTS = [38, 26, 16, 10, 6, 4]

const REELS               = 5
const ROWS                = 3
// Separate divisors for base / bonus so we can shift more of the
// total RTP into the bonus event without breaking base-spin feel.
const BASE_DIVISOR        = 115        // base spin payouts → ~54% base RTP
const BONUS_DIVISOR       = 23         // bonus FS payouts (bigger wins per FS)
const SCATTERS_TO_TRIGGER = 3
const BONUS_FREE_SPINS    = 10         // user asked for 10 FS bonus
const BUY_BONUS_MULT      = 100        // cost = stake × 100  (per user)
const MAX_PAYOUT_CAP      = 5000       // hard cap per spin+bonus combo

// ─────────────────────────────────────────────────────────────

const SYM_WEIGHT_SUM    = SYMBOLS.reduce((s, x) => s + x.weight, 0)
const MAGNET_WEIGHT_SUM = MAGNET_WEIGHTS.reduce((s, w) => s + w, 0)

function pickSymbol() {
  let r = Math.random() * SYM_WEIGHT_SUM
  for (const s of SYMBOLS) {
    if (r < s.weight) return s
    r -= s.weight
  }
  return SYMBOLS[0]
}

function pickMagnet() {
  let r = Math.random() * MAGNET_WEIGHT_SUM
  for (let i = 0; i < MAGNET_POOL.length; i++) {
    if (r < MAGNET_WEIGHTS[i]) return MAGNET_POOL[i]
    r -= MAGNET_WEIGHTS[i]
  }
  return MAGNET_POOL[0]
}

// Roll one full spin. Returns:
//   payout    : float (in stake units — stake = 1)
//   scatters  : count of gem cells in the grid
//   magnets   : the 5 magnet mults this spin generated
// `bonusMode` switches the divisor — base spins use BASE_DIVISOR,
// bonus FS use the smaller BONUS_DIVISOR so each FS pays bigger.
function spin(megaMult /* optional */, bonusMode = false) {
  let scatters = 0
  const grid = []
  for (let ci = 0; ci < REELS; ci++) {
    const col = []
    for (let ri = 0; ri < ROWS; ri++) {
      const s = pickSymbol()
      col.push(s)
      if (s.isScatter) scatters++
    }
    grid.push(col)
  }
  const magnets = megaMult != null
    ? Array(REELS).fill(megaMult)
    : Array.from({ length: REELS }, pickMagnet)

  const divisor = bonusMode ? BONUS_DIVISOR : BASE_DIVISOR
  let payout = 0
  for (let ci = 0; ci < REELS; ci++) {
    let sum = 0
    for (const sym of grid[ci]) {
      if (sym.isScatter) continue
      sum += sym.strength
    }
    payout += (sum * magnets[ci]) / divisor
  }
  return { payout, scatters, magnets }
}

// Run a bonus sequence given the triggering spin's magnets.
// Returns the cumulative payout across BONUS_FREE_SPINS spins.
function runBonus(triggerMagnets) {
  const megaMult = triggerMagnets.reduce((a, b) => a + b, 0)
  let total = 0
  for (let i = 0; i < BONUS_FREE_SPINS; i++) {
    total += spin(megaMult, true).payout
  }
  return total
}

function bucket(w) {
  if (w <= 0)      return '0x       '
  if (w < 0.5)     return '<0.5x    '
  if (w < 1)       return '0.5-1x   '
  if (w < 2)       return '1-2x     '
  if (w < 5)       return '2-5x     '
  if (w < 10)      return '5-10x    '
  if (w < 25)      return '10-25x   '
  if (w < 50)      return '25-50x   '
  if (w < 100)     return '50-100x  '
  if (w < 250)     return '100-250x '
  if (w < 500)     return '250-500x '
  if (w < 1000)    return '500-1000x'
  return '1000x+   '
}

function simulate(N) {
  let totalStake   = 0
  let totalPayout  = 0
  let basePayout   = 0
  let bonusPayout  = 0
  let hitCount     = 0
  let bonusTriggers = 0
  let bonusesProfitable = 0   // bonuses paying ≥ buy cost (≥100×)
  let bonusesAboveBase  = 0   // bonuses paying ≥ 50×
  let bonusesHugeWin    = 0   // bonuses ≥ 500×
  let cappedSpins       = 0   // spins where total payout hit the cap
  let maxSpinWin   = 0
  let maxBonusWin  = 0
  let maxOverallWin = 0
  const HIT_THRESHOLDS = [0.5, 1, 2, 5, 10, 50, 100, 500, 1000]
  const hitAt = HIT_THRESHOLDS.map(() => 0)
  const hist = {}

  for (let i = 0; i < N; i++) {
    totalStake += 1
    const r = spin()
    let perSpinTotal = r.payout
    totalPayout += r.payout
    basePayout  += r.payout
    if (r.payout > 0) hitCount++
    if (r.payout > maxSpinWin) maxSpinWin = r.payout

    if (r.scatters >= SCATTERS_TO_TRIGGER) {
      bonusTriggers++
      const bonusWin = runBonus(r.magnets)
      if (bonusWin >= 100) bonusesProfitable++
      if (bonusWin >= 50)  bonusesAboveBase++
      if (bonusWin >= 500) bonusesHugeWin++
      if (bonusWin > maxBonusWin) maxBonusWin = bonusWin
      perSpinTotal += bonusWin
      bonusPayout  += bonusWin
      totalPayout  += bonusWin
    }

    // Apply hard payout cap.
    if (perSpinTotal > MAX_PAYOUT_CAP) {
      const excess = perSpinTotal - MAX_PAYOUT_CAP
      totalPayout -= excess
      bonusPayout -= excess  // excess always came from a triggered bonus
      perSpinTotal = MAX_PAYOUT_CAP
      cappedSpins++
    }

    if (perSpinTotal > maxOverallWin) maxOverallWin = perSpinTotal
    for (let k = 0; k < HIT_THRESHOLDS.length; k++) {
      if (perSpinTotal >= HIT_THRESHOLDS[k]) hitAt[k]++
    }
    const b = bucket(perSpinTotal)
    hist[b] = (hist[b] || 0) + 1
  }

  return {
    spins: N,
    rtp:               totalPayout / totalStake,
    baseRtp:           basePayout  / totalStake,
    bonusContribution: bonusPayout / totalStake,
    hitRate:           hitCount / N,
    bonusTriggerRate:  bonusTriggers / N,
    bonusTriggerOneIn: bonusTriggers > 0 ? Math.round(N / bonusTriggers) : Infinity,
    avgBonusWin:       bonusTriggers > 0 ? bonusPayout / bonusTriggers : 0,
    profitableBonuses: bonusTriggers > 0 ? bonusesProfitable / bonusTriggers : 0,
    aboveBaseBonuses:  bonusTriggers > 0 ? bonusesAboveBase / bonusTriggers : 0,
    hugeBonuses:       bonusTriggers > 0 ? bonusesHugeWin / bonusTriggers : 0,
    cappedRate:        cappedSpins / N,
    maxSpinWin,
    maxBonusWin,
    maxOverallWin,
    hist,
    hitThresholds: HIT_THRESHOLDS,
    hitAtThreshold: hitAt.map(c => c / N),
  }
}

// ─────────────────────────────────────────────────────────────
// Buy-bonus EV (forces 3 scatters every time)
// ─────────────────────────────────────────────────────────────
function simulateBuyBonus(N) {
  let totalCost   = 0
  let totalReturn = 0
  let maxWin      = 0
  let cappedCount = 0
  let profitableCount = 0
  for (let i = 0; i < N; i++) {
    totalCost += BUY_BONUS_MULT
    const r = spin()
    let perRunTotal = r.payout + runBonus(r.magnets)
    if (perRunTotal > MAX_PAYOUT_CAP) {
      perRunTotal = MAX_PAYOUT_CAP
      cappedCount++
    }
    if (perRunTotal >= BUY_BONUS_MULT) profitableCount++
    totalReturn += perRunTotal
    if (perRunTotal > maxWin) maxWin = perRunTotal
  }
  return {
    runs: N,
    avgReturn: totalReturn / N,
    avgCost:   BUY_BONUS_MULT,
    buyEv:     totalReturn / totalCost,
    profitableRate: profitableCount / N,
    cappedRate: cappedCount / N,
    maxWin,
  }
}

function fmtPct(x)  { return (x * 100).toFixed(2) + '%' }
function fmtNum(x)  { return x.toFixed(2) }

function reportSpinSim(label, res) {
  console.log(`\n── ${label} ──`)
  console.log('Spins              :', res.spins.toLocaleString())
  console.log('Total RTP          :', fmtPct(res.rtp))
  console.log('  Base RTP         :', fmtPct(res.baseRtp))
  console.log('  Bonus RTP        :', fmtPct(res.bonusContribution))
  console.log('Hit rate (any pay) :', fmtPct(res.hitRate))
  console.log('Bonus trigger rate :', fmtPct(res.bonusTriggerRate),
              `(≈ 1 per ${res.bonusTriggerOneIn})`)
  console.log('Avg bonus payout   :', fmtNum(res.avgBonusWin), 'x stake')
  console.log('% bonuses ≥ 50×    :', fmtPct(res.aboveBaseBonuses))
  console.log('% bonuses ≥ 100×   :', fmtPct(res.profitableBonuses), ' ← cost-recovery vs buy')
  console.log('% bonuses ≥ 500×   :', fmtPct(res.hugeBonuses))
  console.log('% spins hit cap    :', fmtPct(res.cappedRate), ` (cap ${MAX_PAYOUT_CAP}× stake)`)
  console.log('Max single spin    :', fmtNum(res.maxSpinWin), 'x stake')
  console.log('Max bonus total    :', fmtNum(res.maxBonusWin), 'x stake')
  console.log('Max overall (1 sp.):', fmtNum(res.maxOverallWin), 'x stake')
  console.log('Histogram:')
  const order = ['0x       ','<0.5x    ','0.5-1x   ','1-2x     ','2-5x     ',
                 '5-10x    ','10-25x   ','25-50x   ','50-100x  ',
                 '100-250x ','250-500x ','500-1000x','1000x+   ']
  for (const k of order) {
    const c = res.hist[k] || 0
    const pct = (c / res.spins) * 100
    if (c > 0) {
      console.log(`  ${k}: ${c.toString().padStart(7)} ${pct.toFixed(3).padStart(7)}%`)
    }
  }
  console.log('Hit rate ≥ Nx stake:')
  for (let i = 0; i < res.hitThresholds.length; i++) {
    const t = res.hitThresholds[i]
    const r = res.hitAtThreshold[i]
    const oneIn = r > 0 ? Math.round(1 / r) : Infinity
    console.log(`  ≥ ${t.toString().padStart(4)}x  : ${(r * 100).toFixed(3).padStart(7)}%  (≈ 1 per ${oneIn})`)
  }
}

function reportBuyBonus(label, res) {
  console.log(`\n── ${label} ──`)
  console.log('Runs               :', res.runs.toLocaleString())
  console.log('Cost per buy       :', res.avgCost, 'x stake')
  console.log('Avg return         :', fmtNum(res.avgReturn), 'x stake')
  console.log('Buy-bonus EV / RTP :', fmtPct(res.buyEv))
  console.log('% profitable buys  :', fmtPct(res.profitableRate),
              `(buy returned ≥ ${BUY_BONUS_MULT}×)`)
  console.log('% capped buys      :', fmtPct(res.cappedRate))
  console.log('Max win on buy     :', fmtNum(res.maxWin), 'x stake')
}

// ─────────────────────────────────────────────────────────────
// Analytic expectations (for sanity checking)
// ─────────────────────────────────────────────────────────────
function analyticReport() {
  const eStrengthPerCell = SYMBOLS.reduce(
    (s, x) => s + (x.isScatter ? 0 : x.strength) * (x.weight / SYM_WEIGHT_SUM),
    0
  )
  const eSumPerCol  = ROWS * eStrengthPerCell
  const eMagnet     = MAGNET_POOL.reduce(
    (s, m, i) => s + m * (MAGNET_WEIGHTS[i] / MAGNET_WEIGHT_SUM),
    0
  )

  const scatterP = SYMBOLS.find(s => s.isScatter).weight / SYM_WEIGHT_SUM
  // P(k scatters in 15 cells) — binomial(15, scatterP)
  function binom(n, k) {
    let c = 1
    for (let i = 0; i < k; i++) c = c * (n - i) / (i + 1)
    return c
  }
  let pTrigger = 0
  for (let k = SCATTERS_TO_TRIGGER; k <= REELS * ROWS; k++) {
    pTrigger += binom(REELS * ROWS, k) *
                Math.pow(scatterP, k) *
                Math.pow(1 - scatterP, REELS * ROWS - k)
  }

  const eBaseRtp = REELS * eSumPerCol * eMagnet / BASE_DIVISOR
  const eMega = REELS * eMagnet
  const eBonusPerSpin = REELS * eSumPerCol * eMega / BONUS_DIVISOR
  const eBonusContrib = pTrigger * BONUS_FREE_SPINS * eBonusPerSpin

  console.log('── Analytic expectations ──')
  console.log('E[strength / cell]   :', eStrengthPerCell.toFixed(4))
  console.log('E[sum strength / col]:', eSumPerCol.toFixed(4))
  console.log('E[magnet]            :', eMagnet.toFixed(2))
  console.log('P(scatter / cell)    :', scatterP.toFixed(4))
  console.log('P(trigger / spin)    :', pTrigger.toFixed(5),
              `(≈ 1 per ${Math.round(1 / pTrigger)})`)
  console.log('E[base RTP]          :', fmtPct(eBaseRtp))
  console.log('E[bonus FS payout]   :', eBonusPerSpin.toFixed(2), 'x stake')
  console.log('E[bonus total / trig.]:', (BONUS_FREE_SPINS * eBonusPerSpin).toFixed(2), 'x stake')
  console.log('E[bonus contribution]:', fmtPct(eBonusContrib))
  console.log('E[total RTP]         :', fmtPct(eBaseRtp + eBonusContrib))
}

// ─────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────
console.log('╔════════════════════════════════════════════════════════════╗')
console.log('║  Magnetic Slot RTP simulator                               ║')
console.log('╚════════════════════════════════════════════════════════════╝')
console.log()
console.log('Tunables in use:')
console.log('  BASE_DIVISOR         =', BASE_DIVISOR)
console.log('  BONUS_DIVISOR        =', BONUS_DIVISOR)
console.log('  SCATTERS_TO_TRIGGER  =', SCATTERS_TO_TRIGGER)
console.log('  BONUS_FREE_SPINS     =', BONUS_FREE_SPINS)
console.log('  BUY_BONUS_MULT       =', BUY_BONUS_MULT)
console.log('  MAX_PAYOUT_CAP       =', MAX_PAYOUT_CAP)
console.log()
console.log('Symbol weights:',
            SYMBOLS.map(s => `${s.id}=${s.weight}`).join(' '))
console.log('Magnet weights:',
            MAGNET_POOL.map((m, i) => `×${m}=${MAGNET_WEIGHTS[i]}`).join(' '))
console.log()

analyticReport()

const N_LIST = [10_000, 100_000, 1_000_000]
for (const N of N_LIST) {
  reportSpinSim(`Monte-Carlo @ ${N.toLocaleString()} spins`, simulate(N))
}

reportBuyBonus('Buy-bonus EV @ 100,000 runs', simulateBuyBonus(100_000))
