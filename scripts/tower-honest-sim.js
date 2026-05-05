// Tower Stack — HONEST RNG simulator (Pragmatic / Aviator-style).
//
// Distribution of fall_at_level is chosen so that for ANY cashout
// strategy K (cash at level K), the expected RTP equals exactly R.
// This is the same math used by real licensed crash games:
//
//     P(fall_at_level >= K+1) = R / S_K   where S_K = 1 + step * K
//
// Sampling: U ~ uniform(0, 1), T = R / (1-U),
//           fall_at_level = max(1, ceil((T - 1) / step))
//
// Deficit breaker: when house pnl <= -max_deficit, force fall_at_level=1
// (immediate loss on first drop) until pnl recovers above the floor.
//
// Run:  node scripts/tower-honest-sim.js
'use strict'

const TARGET_RTP = 0.95
const STEP_MUL   = 0.30
const MAX_LEVEL  = 50

// Sample a fall_at_level using the honest Pareto-style distribution.
function sampleFallLevel() {
  let u = Math.random()
  if (u >= 1) u = 0.999999
  // Edge case: U=0 → T=R, (R-1)/0.3 < 0 → fall = 1.
  const t = TARGET_RTP / (1 - u)
  let lvl = Math.ceil((t - 1) / STEP_MUL)
  if (lvl < 1)         lvl = 1
  if (lvl > MAX_LEVEL) lvl = MAX_LEVEL
  return lvl
}

// Run N rounds with a fixed cashout strategy.
//   strategy: number K  → always cash at level K (after K successful drops)
//             'random'  → uniform 1..15
//             'mixed'   → weighted toward 1..5 (typical player)
function simulate(N, strategy, opts = {}) {
  const { stake = 100, deficitFloor = null, initialPnl = 0 } = opts
  let totalStake = 0
  let totalWin   = 0
  let pnl        = initialPnl
  let breakerHits = 0
  let cashCount   = 0
  let bustCount   = 0
  let levelDist   = {}

  for (let i = 0; i < N; i++) {
    totalStake += stake

    // Decide cashout level for this round
    let K
    if      (typeof strategy === 'number') K = strategy
    else if (strategy === 'random')        K = 1 + Math.floor(Math.random() * 15)
    else if (strategy === 'mixed') {
      // 60% cash at 1, 25% cash at 2-3, 10% cash at 4-7, 5% cash at 8-15
      const r = Math.random()
      if      (r < 0.60) K = 1
      else if (r < 0.85) K = 2 + Math.floor(Math.random() * 2)
      else if (r < 0.95) K = 4 + Math.floor(Math.random() * 4)
      else               K = 8 + Math.floor(Math.random() * 8)
    }
    else                                   K = 1

    // Pick the round outcome
    let fall
    if (deficitFloor !== null && pnl <= -deficitFloor) {
      breakerHits++
      fall = 1                          // forced loss
    } else {
      fall = sampleFallLevel()
    }

    levelDist[fall] = (levelDist[fall] || 0) + 1

    let payout
    if (fall > K) {
      // Player successfully cashed
      payout = Math.round(stake * (1 + STEP_MUL * K))
      cashCount++
    } else {
      payout = 0
      bustCount++
    }

    totalWin += payout
    pnl += stake - payout
  }

  return {
    n: N,
    rtp: totalWin / totalStake,
    cashRate: cashCount / N,
    bustRate: bustCount / N,
    pnl,
    breakerHits,
    levelDist,
  }
}

function fmtPct(x) { return (x * 100).toFixed(2) + '%' }

console.log(`═══ Tower Stack — HONEST RNG simulator ═══`)
console.log(`target RTP = ${fmtPct(TARGET_RTP)}, step mul = +${STEP_MUL} per floor`)
console.log()

// ── 1. Verify constant RTP across cashout strategies ──
console.log('── RTP per cashout level (100 000 spins each, no breaker) ──')
for (const K of [1, 2, 3, 5, 8, 12, 20]) {
  const r = simulate(100_000, K)
  console.log(
    `  cash @ level ${String(K).padStart(2)}   RTP = ${fmtPct(r.rtp)}   ` +
    `cash rate = ${fmtPct(r.cashRate)}   bust rate = ${fmtPct(r.bustRate)}`
  )
}

// ── 2. Mixed strategy player RTP ──
console.log('\n── Realistic mixed-strategy player ──')
for (const n of [100, 1_000, 10_000, 100_000]) {
  const r = simulate(n, 'mixed')
  console.log(
    `  N = ${String(n).padStart(7)}   RTP = ${fmtPct(r.rtp).padStart(7)}   ` +
    `cash = ${fmtPct(r.cashRate)}   bust = ${fmtPct(r.bustRate)}`
  )
}

// ── 3. Random-level (uniform 1..15) player RTP ──
console.log('\n── Random-level player (uniform 1..15) ──')
for (const n of [100, 1_000, 10_000, 100_000]) {
  const r = simulate(n, 'random')
  console.log(`  N = ${String(n).padStart(7)}   RTP = ${fmtPct(r.rtp).padStart(7)}`)
}

// ── 4. Always-greedy player (cash at level 8) variance ──
console.log('\n── Greedy player (always cash @ 8) — 30 runs of 1 000 ──')
{
  const trials = []
  for (let i = 0; i < 30; i++) trials.push(simulate(1_000, 8))
  const rtps = trials.map(t => t.rtp)
  const avg = rtps.reduce((a, b) => a + b, 0) / rtps.length
  const min = Math.min(...rtps), max = Math.max(...rtps)
  const std = Math.sqrt(rtps.reduce((a, b) => a + (b - avg) ** 2, 0) / rtps.length)
  console.log(`  RTP avg ${fmtPct(avg)}  min ${fmtPct(min)}  max ${fmtPct(max)}  std ${fmtPct(std)}`)
}

// ── 5. Long-run mean (5 × 100k mixed) ──
console.log('\n── True mean — 5 runs of 100 000 mixed-strategy spins ──')
{
  const trials = []
  for (let i = 0; i < 5; i++) trials.push(simulate(100_000, 'mixed'))
  const rtps = trials.map(t => t.rtp)
  const avg = rtps.reduce((a, b) => a + b, 0) / rtps.length
  const min = Math.min(...rtps), max = Math.max(...rtps)
  console.log(`  RTP avg ${fmtPct(avg)}  min ${fmtPct(min)}  max ${fmtPct(max)}`)
  console.log(`  per-run: ${rtps.map(fmtPct).join('  ')}`)
}

// ── 6. Deficit breaker recovery ──
console.log('\n── Deficit breaker — recovery from −15 000 ₽ ──')
for (const n of [1_000, 10_000, 100_000]) {
  const r = simulate(n, 'mixed', { deficitFloor: 10_000, initialPnl: -15_000 })
  console.log(
    `  N = ${String(n).padStart(7)}   final pnl = ${r.pnl.toLocaleString('en-US')} ₽   ` +
    `breaker = ${r.breakerHits} (${(r.breakerHits / n * 100).toFixed(2)} %)   ` +
    `RTP = ${fmtPct(r.rtp)}`
  )
}

// ── 7. Distribution of fall_at_level ──
console.log('\n── Distribution of fall_at_level (1M samples) ──')
{
  const r = simulate(1_000_000, 100)  // strategy=100 means "never cash"
  const total = 1_000_000
  const cum = []
  let acc = 0
  for (let k = 1; k <= 15; k++) {
    const cnt = r.levelDist[k] || 0
    acc += cnt
    cum.push({ k, p: cnt / total, cum: acc / total })
  }
  console.log(`  level   P(fall=K)   cumulative`)
  for (const row of cum) {
    console.log(`    ${String(row.k).padStart(2)}     ${fmtPct(row.p).padStart(7)}     ${fmtPct(row.cum).padStart(7)}`)
  }
  // Tail beyond 15
  let tail = 0
  for (const k of Object.keys(r.levelDist)) {
    if (Number(k) > 15) tail += r.levelDist[k]
  }
  console.log(`   16+    ${fmtPct(tail / total).padStart(7)}`)
}

// ── 8. Analytic check ──
console.log('\n── Analytic: P(reach level K) = R/S_K ──')
for (const K of [1, 2, 3, 5, 8, 12, 20]) {
  const S = 1 + STEP_MUL * K
  const p = TARGET_RTP / S
  console.log(`  K=${String(K).padStart(2)}  S_K=${S.toFixed(2)}  P(reach)=${fmtPct(p)}  RTP if cash=${fmtPct(p * S)}`)
}
