// Tetris Cascade — RTP simulator for the redesigned (no-bias)
// distribution.
//
// Goal: a single fixed probabilistic table that lands at ≈ 95 % RTP
// for every spin in the long run. No house-recovers / house-concedes
// AI — every spin is rolled from the same distribution and the
// outcome speaks for itself.
//
// Outcome categories ("rarer / fatter tail"):
//   dud    × 0       — most spins lose
//   small  × 1-2     — most-common win
//   medium × 3-6
//   big    × 7-13
//   huge   × 18-29
//   bonus  free-spin round, paid as a single lump-sum (5 sub-tiers)
//
// Run: node scripts/tetris-rtp-sim.js

'use strict'

const TARGET_RTP = 0.95

// Cumulative probabilities, must sum to 1.0
const P_DUD    = 0.746
const P_SMALL  = 0.180
const P_MEDIUM = 0.050
const P_BIG    = 0.015
const P_HUGE   = 0.008
const P_BONUS  = 0.001    // 0.1 % of spins trigger the bonus round

// Within bonus, sub-tier mix:
const BONUS_TIERS = [
  { weight: 0.55, range: [25,  60]  },  // small
  { weight: 0.28, range: [70,  150] },  // medium
  { weight: 0.14, range: [200, 400] },  // big
  { weight: 0.03, range: [800, 800] },  // jackpot
]

function pickInRange([lo, hi]) {
  return lo + Math.floor(Math.random() * (hi - lo + 1))
}

function simulateSpinMul() {
  const r = Math.random()
  let acc = 0
  if (r < (acc += P_DUD))    return 0
  if (r < (acc += P_SMALL))  return pickInRange([1, 2])
  if (r < (acc += P_MEDIUM)) return pickInRange([3, 6])
  if (r < (acc += P_BIG))    return pickInRange([7, 13])
  if (r < (acc += P_HUGE))   return pickInRange([18, 29])
  // bonus
  const r2 = Math.random()
  let w = 0
  for (const tier of BONUS_TIERS) {
    w += tier.weight
    if (r2 < w) return pickInRange(tier.range)
  }
  return pickInRange(BONUS_TIERS[BONUS_TIERS.length - 1].range)
}

function rtpOver(n) {
  let totalStake = 0
  let totalPayout = 0
  for (let i = 0; i < n; i++) {
    totalStake += 1
    totalPayout += simulateSpinMul()
  }
  return totalPayout / totalStake
}

function fmtPct(x) { return (x * 100).toFixed(2) + '%' }
function fmtSum(x) { return Number(x).toFixed(2) }

console.log('═══ Tetris Cascade RTP simulator ═══')
console.log(`target ${fmtPct(TARGET_RTP)}\n`)

// Headline RTP at four scales (single seed each).
console.log('Single run at each N:')
for (const n of [100, 1_000, 10_000, 100_000]) {
  const rtp = rtpOver(n)
  console.log(`  N = ${String(n).padStart(7)}   RTP = ${fmtPct(rtp)}`)
}

// Variance check — repeat 1k spins 50 times
console.log('\nVariance — 50 runs of 1 000 spins:')
{
  const trials = []
  for (let i = 0; i < 50; i++) trials.push(rtpOver(1_000))
  const avg = trials.reduce((a, b) => a + b, 0) / trials.length
  const min = Math.min(...trials)
  const max = Math.max(...trials)
  const std = Math.sqrt(trials.reduce((a, b) => a + (b - avg) ** 2, 0) / trials.length)
  console.log(`  avg ${fmtPct(avg)}  min ${fmtPct(min)}  max ${fmtPct(max)}  std ${fmtPct(std)}`)
}

// Long-run convergence — single 1M-spin sim
console.log('\nLong-run convergence — single 1 000 000-spin sim:')
{
  const rtp = rtpOver(1_000_000)
  console.log(`  RTP = ${fmtPct(rtp)}`)
}

// Dump the analytic expectation for sanity-check.
console.log('\nAnalytic expected RTP:')
{
  const e_small  = (1 + 2) / 2
  const e_medium = (3 + 6) / 2
  const e_big    = (7 + 13) / 2
  const e_huge   = (18 + 29) / 2
  const e_bonus  = BONUS_TIERS.reduce((acc, t) => acc + t.weight * (t.range[0] + t.range[1]) / 2, 0)
  console.log(`  E[small]  ${fmtSum(e_small)}`)
  console.log(`  E[medium] ${fmtSum(e_medium)}`)
  console.log(`  E[big]    ${fmtSum(e_big)}`)
  console.log(`  E[huge]   ${fmtSum(e_huge)}`)
  console.log(`  E[bonus]  ${fmtSum(e_bonus)}`)
  const e_total = (
    P_DUD    * 0 +
    P_SMALL  * e_small +
    P_MEDIUM * e_medium +
    P_BIG    * e_big +
    P_HUGE   * e_huge +
    P_BONUS  * e_bonus
  )
  console.log(`  E[spin]   ${fmtSum(e_total)}   (${fmtPct(e_total)})`)
}
