// Tetris Cascade — RTP simulator (v4: deficit-aware + buy-bonus split).
//
// What this verifies:
//   1. Long-run RTP ≈ 95 % for regular paid spins.
//   2. Long-run RTP ≈ 80 % for "Купить бонус" purchases — slot edge
//      on the buy feature is intentional and tunable.
//   3. The deficit circuit breaker pulls house pnl back when it falls
//      below the configured floor (default −10 000 ₽):
//        - regular spin → forced dud (mul 0)
//        - buy bonus    → forced floor of the smallest bonus tier
//                         (mul 25-30 vs 100× cost ⇒ deep loss)
//
// Run: node scripts/tetris-rtp-sim.js
'use strict'

// ─── Distributions ────────────────────────────────────────────────
const P_DUD    = 0.746
const P_SMALL  = 0.180
const P_MEDIUM = 0.050
const P_BIG    = 0.015
const P_HUGE   = 0.008
const P_BONUS  = 0.001

// Bonus tiers when triggered IN-spin (the rare ×120-on-average tail).
const BONUS_TIERS_TRIGGER = [
  { weight: 0.55, range: [25,  60]  },
  { weight: 0.28, range: [70,  150] },
  { weight: 0.14, range: [200, 400] },
  { weight: 0.03, range: [800, 800] },
]

// Bonus tiers when explicitly BOUGHT (cost = 100 × stake). We weight
// these toward the smaller tiers so the expected return on a buy is
// ~80× stake (RTP 80 % on the buy feature — the intentional house edge).
const BONUS_TIERS_BOUGHT = [
  { weight: 0.70, range: [25,  60]  },
  { weight: 0.23, range: [70,  150] },
  { weight: 0.06, range: [200, 400] },
  { weight: 0.01, range: [800, 800] },
]

// Deficit floor — when house_pnl ≤ −MAX_DEFICIT, the circuit breaker
// fires and forces a loss until house pnl climbs back above it.
const MAX_DEFICIT = 10_000

// ─── Helpers ──────────────────────────────────────────────────────
function pickInRange([lo, hi]) {
  return lo + Math.floor(Math.random() * (hi - lo + 1))
}

function pickFromTiers(tiers) {
  const r = Math.random()
  let w = 0
  for (const tier of tiers) {
    w += tier.weight
    if (r < w) return pickInRange(tier.range)
  }
  return pickInRange(tiers[tiers.length - 1].range)
}

// Pick the multiplier for ONE regular paid spin from the v3 table.
// Returns { mul, kind } where kind ∈ {dud, small, medium, big, huge, bonus}.
function pickRegularOutcome() {
  const r = Math.random()
  let acc = 0
  if (r < (acc += P_DUD))    return { mul: 0,                            kind: 'dud' }
  if (r < (acc += P_SMALL))  return { mul: pickInRange([1, 2]),          kind: 'small' }
  if (r < (acc += P_MEDIUM)) return { mul: pickInRange([3, 6]),          kind: 'medium' }
  if (r < (acc += P_BIG))    return { mul: pickInRange([7, 13]),         kind: 'big' }
  if (r < (acc += P_HUGE))   return { mul: pickInRange([18, 29]),        kind: 'huge' }
  return                            { mul: pickFromTiers(BONUS_TIERS_TRIGGER), kind: 'bonus' }
}

function pickBoughtOutcome() {
  return { mul: pickFromTiers(BONUS_TIERS_BOUGHT), kind: 'bonus' }
}

// ─── Engine that tracks house pnl + applies circuit breaker ───────
// `mode` is 'regular' or 'bought'. Stake is fixed at 1 unit; for
// bought spins the cost is 100. House pnl accumulates wagered − paid.
function runEngine(n, mode, opts = {}) {
  const { maxDeficit = MAX_DEFICIT, enableBreaker = true, initialPnl = 0 } = opts
  let pnl       = initialPnl
  let wagered   = 0
  let paid      = 0
  let breakerHits = 0
  let bonusFires  = 0   // counted on the regular-mode trigger only

  for (let i = 0; i < n; i++) {
    const stake = mode === 'bought' ? 100 : 1
    wagered += stake

    let mul
    if (enableBreaker && pnl <= -maxDeficit) {
      // Circuit breaker: force a loss path.
      breakerHits++
      if (mode === 'bought') {
        // Smallest tier, lowest end of its range.
        mul = pickInRange([25, 30])
      } else {
        mul = 0  // dud
      }
    } else {
      const out = mode === 'bought' ? pickBoughtOutcome() : pickRegularOutcome()
      mul = out.mul
      if (out.kind === 'bonus') bonusFires++
    }

    const win = mul * 1   // mul is per stake-unit; payout uses 1, cost reflected in stake above
    paid += win
    pnl  += stake - win
  }

  return {
    n, mode, wagered, paid, pnl, breakerHits, bonusFires,
    rtp: paid / wagered,
  }
}

// ─── Output helpers ───────────────────────────────────────────────
function fmtPct(x) { return (x * 100).toFixed(2) + '%' }
function fmtSum(x) { return Number(x).toFixed(2) }

console.log('═══ Tetris Cascade RTP simulator v4 ═══')
console.log(`target regular RTP = 95 %, target buy-bonus RTP = 80 %`)
console.log(`circuit-breaker fires when pnl ≤ −${MAX_DEFICIT.toLocaleString('en-US')} ₽\n`)

// ── 1. Regular spins, breaker OFF (math sanity) ───────────────────
console.log('── Regular spins (no breaker) ──')
for (const n of [100, 1_000, 10_000, 100_000, 1_000_000]) {
  const r = runEngine(n, 'regular', { enableBreaker: false })
  console.log(`  N = ${String(n).padStart(7)}   RTP = ${fmtPct(r.rtp)}   bonuses = ${r.bonusFires}`)
}

// ── 2. Regular spins, breaker ON ──────────────────────────────────
console.log('\n── Regular spins (breaker ON, max_deficit = ' + MAX_DEFICIT.toLocaleString('en-US') + ') ──')
for (const n of [100, 1_000, 10_000, 100_000, 1_000_000]) {
  const r = runEngine(n, 'regular')
  console.log(
    `  N = ${String(n).padStart(7)}   RTP = ${fmtPct(r.rtp)}   ` +
    `bonuses = ${r.bonusFires}   breaker = ${r.breakerHits} (${(r.breakerHits / n * 100).toFixed(2)} %)`
  )
}

// ── 3. Buy-bonus only, breaker OFF ────────────────────────────────
console.log('\n── Buy bonus only (no breaker) ──')
for (const n of [100, 1_000, 10_000, 100_000]) {
  const r = runEngine(n, 'bought', { enableBreaker: false })
  console.log(`  N = ${String(n).padStart(6)}   RTP = ${fmtPct(r.rtp)}   pnl = ${r.pnl.toLocaleString('en-US')}`)
}

// ── 4. Buy-bonus only, breaker ON ─────────────────────────────────
console.log('\n── Buy bonus only (breaker ON) ──')
for (const n of [100, 1_000, 10_000, 100_000]) {
  const r = runEngine(n, 'bought')
  console.log(
    `  N = ${String(n).padStart(6)}   RTP = ${fmtPct(r.rtp)}   ` +
    `pnl = ${r.pnl.toLocaleString('en-US')}   breaker = ${r.breakerHits}`
  )
}

// ── 5. Recovery from a real deficit ───────────────────────────────
// Start the house already 15 000 ₽ in the red and watch the breaker
// claw it back.
console.log('\n── Recovery from −15 000 ₽ deficit (regular spins) ──')
for (const n of [100, 1_000, 10_000, 100_000]) {
  const r = runEngine(n, 'regular', { initialPnl: -15_000 })
  console.log(
    `  N = ${String(n).padStart(7)}   RTP = ${fmtPct(r.rtp)}   ` +
    `final pnl = ${r.pnl.toLocaleString('en-US')}   breaker = ${r.breakerHits} (${(r.breakerHits / n * 100).toFixed(2)} %)`
  )
}

console.log('\n── Recovery from −15 000 ₽ deficit (buy-bonus spins, stake×100) ──')
for (const n of [100, 1_000, 10_000]) {
  const r = runEngine(n, 'bought', { initialPnl: -15_000 })
  console.log(
    `  N = ${String(n).padStart(5)}   RTP = ${fmtPct(r.rtp)}   ` +
    `final pnl = ${r.pnl.toLocaleString('en-US')}   breaker = ${r.breakerHits}`
  )
}

// ── Variance — 50 × 1 000 regular spins ───────────────────────────
console.log('\n── Variance — 50 runs of 1 000 regular spins ──')
{
  const trials = []
  for (let i = 0; i < 50; i++) trials.push(runEngine(1_000, 'regular'))
  const rtps = trials.map(t => t.rtp)
  const avg  = rtps.reduce((a, b) => a + b, 0) / rtps.length
  const min  = Math.min(...rtps)
  const max  = Math.max(...rtps)
  const std  = Math.sqrt(rtps.reduce((a, b) => a + (b - avg) ** 2, 0) / rtps.length)
  const bonusCounts = trials.map(t => t.bonusFires)
  const breaker     = trials.map(t => t.breakerHits)
  console.log(`  RTP   avg ${fmtPct(avg)}  min ${fmtPct(min)}  max ${fmtPct(max)}  std ${fmtPct(std)}`)
  console.log(`  bonuses per 1k:   avg ${(bonusCounts.reduce((a,b)=>a+b,0)/50).toFixed(2)}  min ${Math.min(...bonusCounts)}  max ${Math.max(...bonusCounts)}`)
  console.log(`  breaker hits:     avg ${(breaker.reduce((a,b)=>a+b,0)/50).toFixed(1)}  min ${Math.min(...breaker)}  max ${Math.max(...breaker)}`)
}

// ── 6. Analytic expectations ──────────────────────────────────────
function ev(tiers) {
  return tiers.reduce((acc, t) => acc + t.weight * (t.range[0] + t.range[1]) / 2, 0)
}
console.log('\n── Analytic expectation ──')
{
  const e_small  = (1 + 2) / 2
  const e_medium = (3 + 6) / 2
  const e_big    = (7 + 13) / 2
  const e_huge   = (18 + 29) / 2
  const e_bonus_trigger = ev(BONUS_TIERS_TRIGGER)
  const e_bonus_bought  = ev(BONUS_TIERS_BOUGHT)
  const e_regular = (
    P_DUD    * 0 +
    P_SMALL  * e_small +
    P_MEDIUM * e_medium +
    P_BIG    * e_big +
    P_HUGE   * e_huge +
    P_BONUS  * e_bonus_trigger
  )
  console.log(`  E[regular spin]      = ${fmtSum(e_regular)}   (${fmtPct(e_regular)})`)
  console.log(`  E[bought bonus mul]  = ${fmtSum(e_bonus_bought)}   `
              + `(cost 100 ⇒ RTP ${fmtPct(e_bonus_bought / 100)})`)
}
