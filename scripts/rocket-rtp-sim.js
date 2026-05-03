// Rocket slot — RTP simulator.
//
// Goal: confirm the crash distribution + bias rules give us a long-run
// 95% RTP across a few realistic player strategies.
//
// Crash distribution (per round):
//   raw  = HOUSE_RTP / (1 - U)        where U ~ Uniform(0, 1)
//   crash = clamp(raw, 1.00, 100.00)
//
// HOUSE_RTP is the bias-driven base:
//   normal           → 0.95
//   house_recovers   → 0.70
//   house_concedes   → 1.05
//
// Bias selection mirrors the Tetris RTP logic:
//   pnl <= -max_deficit            → house_recovers
//   wagered < cold_start_threshold → normal (no signal yet)
//   current_rtp > target + 0.05    → house_recovers
//   current_rtp < target - 0.05 AND pnl > 0 → house_concedes
//   else                           → normal
//
// Run: node scripts/rocket-rtp-sim.js

'use strict'

const TARGET_RTP = 0.95
const MAX_HOUSE_DEFICIT_RUB = 10_000
const COLD_START_WAGERED = 10_000

const HOUSE_RTP_BY_BIAS = {
  normal:         0.95,
  house_recovers: 0.70,
  house_concedes: 1.05,
}

function generateCrash(houseRtp) {
  // Inverse-CDF sample of P(crash > x) = houseRtp / x.
  const u = Math.random()
  const raw = houseRtp / Math.max(0.0001, 1 - u)
  return Math.max(1.00, Math.min(100.00, Math.round(raw * 100) / 100))
}

function decideBias(pnl, wagered, paid, target, maxDeficit) {
  if (pnl <= -maxDeficit) return 'house_recovers'
  if (wagered < COLD_START_WAGERED) return 'normal'
  const currentRtp = wagered > 0 ? paid / wagered : 0
  if (currentRtp > target + 0.05) return 'house_recovers'
  if (currentRtp < target - 0.05 && pnl > 0) return 'house_concedes'
  return 'normal'
}

// Player strategies.
// Each takes the crash and returns the cash-out multiplier the player
// would have hit (0 means they didn't cash out → lost).
const strategies = {
  fixed1_5x: (_) => 1.5,
  fixed2x:   (_) => 2.0,
  fixed3x:   (_) => 3.0,
  fixed5x:   (_) => 5.0,
  fixed10x:  (_) => 10.0,
  // Realistic mixed: 50% try 1.5x, 30% try 2x, 15% try 3x, 5% try 5x.
  mixed: (_) => {
    const r = Math.random()
    if (r < 0.50) return 1.5
    if (r < 0.80) return 2.0
    if (r < 0.95) return 3.0
    return 5.0
  },
}

function simulate(N, strategyName, stakeFixed = 100) {
  const strategy = strategies[strategyName]
  let pnl = 0, wagered = 0, paid = 0
  const samples = []

  for (let i = 0; i < N; i++) {
    const bias = decideBias(pnl, wagered, paid, TARGET_RTP, MAX_HOUSE_DEFICIT_RUB)
    const crash = generateCrash(HOUSE_RTP_BY_BIAS[bias])
    const cashoutAt = strategy(crash)
    const stake = stakeFixed
    const win = crash >= cashoutAt ? Math.round(stake * cashoutAt) : 0

    wagered += stake
    paid += win
    pnl += stake - win  // house pnl = wagered - paid

    samples.push({ bias, crash, cashoutAt, stake, win })
  }

  const rtp = wagered > 0 ? paid / wagered : 0
  const housePnl = wagered - paid
  const biasCounts = samples.reduce((acc, s) => {
    acc[s.bias] = (acc[s.bias] || 0) + 1
    return acc
  }, {})

  return { N, strategyName, rtp, wagered, paid, housePnl, biasCounts }
}

function fmtPct(x) { return (x * 100).toFixed(2) + '%' }
function fmtRub(x) { return x.toLocaleString('ru-RU') + ' ₽' }

function row(...cells) { return cells.map((c, i) => String(c).padEnd(i === 0 ? 14 : 14)).join(' ') }

console.log('═══ Rocket RTP simulator ═══')
console.log(`target RTP: ${fmtPct(TARGET_RTP)}, max house deficit: ${fmtRub(MAX_HOUSE_DEFICIT_RUB)}\n`)

// Per-strategy headline RTP at 1k.
console.log('1 000 rounds (single seed) per strategy:\n')
console.log(row('strategy', 'RTP', 'wagered', 'paid', 'house pnl', 'bias counts'))
console.log('─'.repeat(110))
for (const name of Object.keys(strategies)) {
  const r = simulate(1000, name)
  const biasStr = Object.entries(r.biasCounts).map(([k, v]) => `${k}:${v}`).join(' ')
  console.log(row(name, fmtPct(r.rtp), fmtRub(r.wagered), fmtRub(r.paid), fmtRub(r.housePnl), biasStr))
}

// Variance check — repeat 1k-round sim 30x for the mixed strategy.
console.log('\nVariance — 30 independent 1k-round runs (mixed strategy):')
const rtps = []
for (let i = 0; i < 30; i++) {
  rtps.push(simulate(1000, 'mixed').rtp)
}
const avg = rtps.reduce((a, b) => a + b, 0) / rtps.length
const min = Math.min(...rtps)
const max = Math.max(...rtps)
const std = Math.sqrt(rtps.reduce((acc, r) => acc + (r - avg) ** 2, 0) / rtps.length)
console.log(`  avg ${fmtPct(avg)}  ·  min ${fmtPct(min)}  ·  max ${fmtPct(max)}  ·  std ${fmtPct(std)}`)

// Long-run convergence.
console.log('\nLong-run convergence — single 100k-round mixed sim:')
const long = simulate(100_000, 'mixed')
console.log(`  RTP after 100k rounds: ${fmtPct(long.rtp)}`)
console.log(`  house pnl: ${fmtRub(long.housePnl)} on ${fmtRub(long.wagered)} wagered`)
console.log(`  bias mix: ${Object.entries(long.biasCounts).map(([k, v]) => `${k}:${v}`).join(' ')}`)
