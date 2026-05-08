// Plinko RTP simulator — runs Monte Carlo across all three risk modes
// at N = 100 / 1k / 10k / 100k / 1M spins, and prints the analytic
// long-run mean for comparison.
//
// Run: node scripts/plinko-rtp-sim.js
'use strict'

const ROWS = 16

const MULTIPLIERS = {
  low:    [16,    9,   2,   1.4, 1.4, 1.2, 1,   0.9, 0.55, 0.9, 1,   1.2, 1.4, 1.4, 2,   9,   16   ],
  medium: [110,   41,  10,  5,   3,   1.5, 1,   0.4, 0.2,  0.4, 1,   1.5, 3,   5,   10,  41,  110  ],
  high:   [10000, 211, 21,  5,   1.8, 0.8, 0.3, 0.2, 0.1,  0.2, 0.3, 0.8, 1.8, 5,   21,  211, 10000],
}

// Single ball drop — fair coin per row → final slot index ∈ [0, ROWS].
// Distribution is binomial(ROWS, 0.5).
function rollSlot() {
  let k = 0
  for (let r = 0; r < ROWS; r++) {
    if (Math.random() < 0.5) k++
  }
  return k
}

function simulate(N, risk) {
  const muls = MULTIPLIERS[risk]
  let totalStake = 0
  let totalWin   = 0
  let maxWinX    = 0
  let hits       = 0
  for (let i = 0; i < N; i++) {
    const stake = 1
    totalStake += stake
    const k     = rollSlot()
    const win   = stake * muls[k]
    totalWin   += win
    if (win > maxWinX) maxWinX = win
    if (win > stake)   hits++
  }
  return {
    n: N,
    risk,
    rtp: totalWin / totalStake,
    maxWinX,
    hitRate: hits / N,
  }
}

// Binomial(ROWS, 0.5) coefficient table
const C = []
for (let k = 0; k <= ROWS; k++) {
  let c = 1
  for (let i = 0; i < k; i++) c = (c * (ROWS - i)) / (i + 1)
  C.push(c)
}
const TOTAL = 2 ** ROWS  // 65536 for ROWS=16

function analyticRTP(muls) {
  let sum = 0
  for (let k = 0; k <= ROWS; k++) sum += C[k] * muls[k]
  return sum / TOTAL
}

function fmtPct(x) { return (x * 100).toFixed(2) + '%' }

console.log('═══ PLINKO — RTP simulator ═══')
console.log(`ROWS = ${ROWS}, SLOTS = ${ROWS + 1}, distribution = binomial(${ROWS}, 0.5)\n`)

// ── Analytic long-run RTP per risk ────────────────────────────────
console.log('── Analytic long-run RTP (theoretical mean) ──')
for (const risk of ['low', 'medium', 'high']) {
  const rtp = analyticRTP(MULTIPLIERS[risk])
  console.log(`  ${risk.padEnd(8)} : ${fmtPct(rtp)}`)
}
console.log()

// ── Monte Carlo across spin counts ────────────────────────────────
const SPIN_COUNTS = [100, 1_000, 10_000, 100_000, 1_000_000]
for (const risk of ['low', 'medium', 'high']) {
  console.log(`── ${risk.toUpperCase()} risk ──`)
  for (const N of SPIN_COUNTS) {
    const r = simulate(N, risk)
    console.log(
      `  N = ${String(N).padStart(9)}   RTP = ${fmtPct(r.rtp).padStart(8)}   ` +
      `hit = ${fmtPct(r.hitRate).padStart(7)}   maxWin = ${r.maxWinX.toFixed(0)}× stake`
    )
  }
  console.log()
}

// ── Variance — 30 batches of 1k for each risk ─────────────────────
console.log('── Variance — 30 batches of 1 000 spins ──')
for (const risk of ['low', 'medium', 'high']) {
  const trials = []
  for (let i = 0; i < 30; i++) trials.push(simulate(1_000, risk))
  const rtps = trials.map(t => t.rtp)
  const avg  = rtps.reduce((a, b) => a + b, 0) / rtps.length
  const min  = Math.min(...rtps), max = Math.max(...rtps)
  const std  = Math.sqrt(rtps.reduce((a, b) => a + (b - avg) ** 2, 0) / rtps.length)
  console.log(
    `  ${risk.padEnd(8)} : avg ${fmtPct(avg)}  min ${fmtPct(min)}  max ${fmtPct(max)}  std ${fmtPct(std)}`
  )
}
