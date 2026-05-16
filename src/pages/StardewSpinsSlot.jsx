import React, { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useShallow } from 'zustand/react/shallow'
import useGameStore from '../store/useGameStore'
import { translations } from '../lib/i18n'
import { formatCurrency } from '../lib/currency'
import { haptic } from '../lib/telegram'
import { startStardewRound, finishStardewRound } from '../lib/supabase'
// Stage backdrops — painted photo of the farm, one per season.
// Vite resolves each import to a hashed URL; the CSS pulls in
// the active one via the `--stardew-bg` custom property below.
//
//   Note on naming: the user-facing asset uses "autumn" while
//   the internal season id is "fall" (matches the game-design
//   convention). The map below bridges the two.
import bgSpring from '../assets/stardew/bg/spring.png'
import bgSummer from '../assets/stardew/bg/summer.png'
import bgAutumn from '../assets/stardew/bg/autumn.png'
import bgWinter from '../assets/stardew/bg/winter.png'

// Symbol sprites — 8 main crops (ordered weakest → strongest)
// plus the lime scatter. Files live under
// src/assets/stardew/symbols/ as pixel-art PNGs.
import symPotatoe    from '../assets/stardew/symbols/potatoe.png'
import symCarrot     from '../assets/stardew/symbols/carrot.png'
import symCorn       from '../assets/stardew/symbols/corn.png'
import symEggplant   from '../assets/stardew/symbols/eggplant.png'
import symTomatoe    from '../assets/stardew/symbols/tomatoe.png'
import symGrape      from '../assets/stardew/symbols/grape.png'
import symPumpkin    from '../assets/stardew/symbols/pumpkin.png'
import symWatermelon from '../assets/stardew/symbols/watermelon.png'
import symLime       from '../assets/stardew/symbols/lime.png'
// Bonus growth-stage sprites: stage 1 (sprout) and stage 2
// (sprout2). Stage 3 is the crop's own ripe sprite (above).
import symSprout     from '../assets/stardew/symbols/sprout.png'
import symSprout2    from '../assets/stardew/symbols/sprout2.png'
import symLightning  from '../assets/stardew/symbols/lightning.png'
import './StardewSpinsSlot.css'

const SEASON_BG = {
  spring: bgSpring,
  summer: bgSummer,
  fall:   bgAutumn,
  winter: bgWinter,
}

// Map symbol id → sprite URL. The cell renders the PNG via an
// inline background-image so the actual <span> stays a pure
// styling slot (no extra <img> per tile, no DOM swap on tumble).
const SYMBOL_IMG = {
  potatoe:    symPotatoe,
  carrot:     symCarrot,
  corn:       symCorn,
  eggplant:   symEggplant,
  tomatoe:    symTomatoe,
  grape:      symGrape,
  pumpkin:    symPumpkin,
  watermelon: symWatermelon,
  lime:       symLime,
}

// Bonus plant sprite by growth stage. Stage 1/2 are the generic
// sprout art; stage 3 falls back to the crop's ripe sprite.
function bonusPlantImg(crop, stage) {
  if (stage === STAGE_SPROUT) return symSprout
  if (stage === STAGE_BUD)    return symSprout2
  return SYMBOL_IMG[crop] || null
}

// ─────────────────────────────────────────────────────────────
// STARDEW SPINS — dev v1
//
// 6×5 grid, Pay-Anywhere: 8+ of the same symbol ANYWHERE on the
// field pays. Winners tumble out, the column above them drops
// down to fill the gap, and fresh symbols spawn at the top.
// Chains keep firing while any 8+ cluster survives.
//
// Seasonal wheel header rotates every SEASON_SPINS spins and
// re-paints the sky strip. Mechanical bias on payouts per
// season is left as a follow-up — for now the wheel is purely
// visual feedback so we can wire the loop end-to-end.
//
// Server RPC integration (start_stardew_round /
// finish_stardew_round + deficit breaker) is also follow-up;
// this dev pass debits / credits the local zustand balance
// directly so the user can play offline with the existing
// 100 000 ₽ dev wallet.
// ─────────────────────────────────────────────────────────────

const ROWS = 5
const COLS = 6
const CELL_COUNT = ROWS * COLS

// Stake ladder mirrors Magnetic / Pixel Mine / Dice / Plinko —
// same coin denominations so the player's muscle memory doesn't
// reset between slots.
const BETS = [10, 25, 50, 100, 250, 500, 1000, 2000, 4000, 8000, 16000, 25000]

// Pay-Anywhere min cluster. Sweet-Bonanza-style "8+ anywhere".
const MIN_MATCH = 8

// Dev kill-switch: when true, every spin is forced to be a
// loss (no clusters ever fire, no tumble cascades, no payouts).
// Flip to `true` only to rapidly cycle the seasonal wheel.
const DEV_FORCE_NO_WINS = false

// ── Symbols ──
// Eight harvest crops, ordered weakest → strongest (cheapest
// payout per cluster → biggest). Cheaper symbols are weighted
// heavier so 8+ clusters land at a reasonable rate during play.
// `lime` is a scatter — included in the symbol pool with a
// rare weight so it dots the field occasionally, but flagged
// `isScatter` so the cluster-detection pass skips it (scatter
// bonus mechanic is wired in a follow-up pass).
// Weights tuned by scripts/stardew-rtp-sim.js for a ~95 % total
// RTP (measured 94.5 %, buy-bonus EV 97.6 %). ONLY the drop
// probabilities live here — the иксы (PAYOUTS / BONUS_CROP_PAY)
// are never touched by RTP tuning.
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
const SYM_WEIGHT_SUM = SYMBOLS.reduce((s, x) => s + x.weight, 0)
const SCATTER_IDS = new Set(SYMBOLS.filter(s => s.isScatter).map(s => s.id))

// Pay table — multiplier × stake. Sweet-Bonanza-style three-tier
// payouts:
//   Match 8-9  → key 8
//   Match 10-11→ key 10
//   Match 12+  → key 12
// The cluster resolver picks the highest key ≤ count, so 9 of
// the same symbol triggers the `8` payout, 11 → `10`, 12+ → `12`.
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

// Pure visual cycle. SEASON_SPINS counts down to 0, then we
// roll over and rotate to the next season.
const SEASONS = ['spring', 'summer', 'fall', 'winter']
const SEASON_SPINS = 5

// Animation timings (ms). Tuned so a quiet spin (no wins) takes
// roughly a second on the spin-out / spin-in pass, with the
// cascade tumble that follows still feeling snappy.
const COL_STAGGER_MS  = 100     // delay between successive columns
// Symbols travel ~6 row-heights to clear the grid completely.
// 700 ms gives a slow, readable slide without dragging the spin.
const COL_SLIDE_MS    = 700     // one column's slide duration
// Time until the LAST column finishes its slide — used as the
// wait between spin-out → grid-swap and grid-swap → spin-in done.
const ALL_COLS_MS     = (COLS - 1) * COL_STAGGER_MS + COL_SLIDE_MS
// Cascade animation breakdown:
//   PULSE  — winning symbols grow then shrink back (one beat)
//   BURST  — winning symbols pop & vanish
//   DROP   — survivors above fall into the gaps + fresh symbols
//            rain in from the top, column-staggered L→R but
//            OVERLAPPING (next column starts before the prev one
//            lands), same feel as the spin-in.
const WIN_PULSE_MS    = 460     // grow-then-shrink beat
const WIN_BURST_MS    = 340     // pop + fade
const TUMBLE_DROP_MS  = 460     // one column's gravity-drop duration
const TUMBLE_STAGGER_MS = 80    // delay between columns during the drop
const ALL_TUMBLE_MS   = (COLS - 1) * TUMBLE_STAGGER_MS + TUMBLE_DROP_MS
const POST_SPIN_REST  = 180     // gap before auto-spin re-enters

// ─────────────────────────────────────────────────────────────
// BONUS — "Year of Harvest" free spins
//
// 3+ lime scatters anywhere on the settled base grid trigger it
// (or the Buy-Bonus button forces a spin guaranteed to land 3).
// The base spin's own cascade win is carried INTO the bonus
// total. The grid then becomes a 5×5 farm for 10 free spins
// (= one in-game year). Each free spin:
//   1. SOW    — empty cells have a chance to sprout a season crop
//   2. GROW   — every plant advances one stage
//                (sprout → sprout2 → ripe fruit)
//   3. HARVEST— any cell that reached the fruit stage is auto-
//                collected, pays BONUS_CROP_PAY × stake, clears.
//   4. LIGHTNING (basic) — a random cell may be struck: if it
//                holds a fruit it pays ×100, then the cell burns
//                (skips one spin). Sprinkler is a later pass.
// ─────────────────────────────────────────────────────────────
const SCATTERS_TO_TRIGGER = 3
const SCATTER_ID = 'lime'
const BUY_BONUS_MULT = 100        // cost = stake × 100

const BONUS_SPINS = 10
const BONUS_ROWS  = 5
const BONUS_COLS  = 5
const BONUS_CELLS = BONUS_ROWS * BONUS_COLS

// Plant growth stages. 1 = sprout, 2 = sprout2, 3 = ripe fruit
// (the crop's own sprite). Harvest fires at stage 3.
const STAGE_SPROUT = 1
const STAGE_BUD    = 2
const STAGE_FRUIT  = 3

// Which season each free-spin index belongs to (1-based spin no).
//   1-3 Spring · 4-6 Summer · 7-9 Fall · 10 Winter (finale)
function bonusSeasonForSpin(n) {
  if (n <= 3) return 'spring'
  if (n <= 6) return 'summer'
  if (n <= 9) return 'fall'
  return 'winter'
}

// Crop pool that can be sown each season (mapped to OUR sprites).
// Designer's table → our symbols:
//   Spring  Parsnip ×1   → carrot
//           Cauliflower ×3 → potatoe
//           Strawberry ×8  → corn
//   Summer  Blueberry ×2 → eggplant
//           Pepper ×4    → tomatoe
//           Starfruit ×20→ watermelon
//   Fall    Pumpkin ×5   → pumpkin
//           Grape ×10    → grape
//   (Ancient Fruit ×40 rare — no sprite yet, deferred.)
// Winter sows nothing — spin 10 is final grow + harvest only.
const SEASON_CROPS = {
  spring: ['carrot', 'potatoe', 'corn'],
  summer: ['eggplant', 'tomatoe', 'watermelon'],
  fall:   ['pumpkin', 'grape'],
  winter: [],
}

// Per-fruit harvest payout (× stake) straight from the designer's
// x-values, only ever paid when a plant reaches the ripe stage.
const BONUS_CROP_PAY = {
  carrot:      1,   // Parsnip
  potatoe:     3,   // Cauliflower
  corn:        8,   // Strawberry
  eggplant:    2,   // Blueberry
  tomatoe:     4,   // Pepper
  watermelon: 20,   // Starfruit
  pumpkin:     5,   // Pumpkin
  grape:      10,   // Grape
}

// Chance an empty cell sprouts a new seed on a sow phase.
// (RTP-tuned — see scripts/stardew-rtp-sim.js.)
const BONUS_SOW_CHANCE     = 0.075
// Chance a lightning event happens on a given free spin (only
// fires if there's at least one plant to strike). RTP-tuned —
// the ×100 boost is brutal so this stays low.
const BONUS_LIGHTNING_CHANCE = 0.03
// A lightning-struck plant pays this × stake when harvested ripe,
// instead of its own crop multiplier. A struck sprout carries the
// boost as it grows; if it never ripens before the year ends the
// boost is simply lost.
const LIGHTNING_FRUIT_MULT   = 100

// Bonus animation beats (ms). Deliberately slow — each free spin
// is a readable HARVEST → GROW → SOW (→ LIGHTNING) sequence.
const BONUS_HARVEST_MS  = 900   // ripe fruit flash + yoink
const BONUS_HARVEST_GAP = 320   // beat after fruit vanishes
const BONUS_GROW_MS     = 720   // plants level up one stage
const BONUS_GROW_GAP    = 260
const BONUS_SOW_MS      = 640   // new sprouts pop in
const BONUS_SPIN_GAP    = 520   // breath before the next free spin
// Lightning sub-sequence: bolt forms over cell A (screen darkens
// except A, sprite grows + sparks), vanishes, then a strike bolt
// hits target cell B (screen still dark, B highlighted).
const LIGHTNING_APPEAR_MS = 950
const LIGHTNING_STRIKE_MS = 760
const LIGHTNING_GAP_MS    = 360
const OVERLAY_INTRO_MS  = 2400
const OVERLAY_END_MS     = 2800

function pickSymbol() {
  let r = Math.random() * SYM_WEIGHT_SUM
  for (const s of SYMBOLS) {
    if (r < s.weight) return s.id
    r -= s.weight
  }
  return SYMBOLS[0].id
}

function genGrid() {
  const g = new Array(CELL_COUNT)
  for (let i = 0; i < CELL_COUNT; i++) g[i] = pickSymbol()
  return g
}

// Count occurrences of each symbol on a flat grid. Returns
// `{ [symId]: [cellIdx, ...] }` for symbols that hit MIN_MATCH+.
// Scatter symbols (lime) are excluded from cluster detection —
// they trigger the bonus FS via a separate count, not Pay-Anywhere.
function findWins(grid) {
  // Dev kill-switch — every spin is a clean loss while this is
  // on, so the season wheel can rotate without cascades dragging.
  if (DEV_FORCE_NO_WINS) return {}
  const buckets = {}
  for (let i = 0; i < grid.length; i++) {
    const s = grid[i]
    if (!s || SCATTER_IDS.has(s)) continue
    if (!buckets[s]) buckets[s] = []
    buckets[s].push(i)
  }
  const wins = {}
  for (const [sym, indices] of Object.entries(buckets)) {
    if (indices.length >= MIN_MATCH) wins[sym] = indices
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

// Sweet-Bonanza-style tumble. For each column:
//   1. Remove any cells whose flat index is in `winningSet`.
//   2. Let the remaining cells fall to the bottom of the column.
//   3. Spawn fresh symbols at the top to refill the cleared slots.
// `rowOf(i)` and `colOf(i)` use the standard `r * COLS + c` flat
// layout (row 0 = top).
function tumbleGrid(grid, winningSet) {
  const next = new Array(CELL_COUNT)
  // `drop[newIdx]` = how many rows that symbol visually fell to
  // reach its slot. Survivors fall by the number of cleared cells
  // that ended up below them; fresh spawns fall from above the
  // grid as one connected stack (offset = cleared count K so the
  // whole new block enters from off-screen top).
  const drop = new Array(CELL_COUNT).fill(0)
  for (let c = 0; c < COLS; c++) {
    // Survivors, top→bottom, remembering each one's old row.
    const survivors = []  // { sym, oldRow }
    for (let r = 0; r < ROWS; r++) {
      const i = r * COLS + c
      if (!winningSet.has(i)) survivors.push({ sym: grid[i], oldRow: r })
    }
    const K = ROWS - survivors.length   // cleared in this column
    for (let r = 0; r < ROWS; r++) {
      const i = r * COLS + c
      if (r < K) {
        // Fresh spawn — comes from above the grid.
        next[i] = pickSymbol()
        drop[i] = K
      } else {
        const s = survivors[r - K]
        next[i] = s.sym
        drop[i] = r - s.oldRow          // rows this survivor fell
      }
    }
  }
  return { grid: next, drop }
}

const wait = (ms) => new Promise(r => setTimeout(r, ms))

// ── Bonus helpers ──

function countScatters(grid) {
  let n = 0
  for (const s of grid) if (s === SCATTER_ID) n++
  return n
}

// Build a base grid that is GUARANTEED to contain exactly
// SCATTERS_TO_TRIGGER scatters at random positions (used by the
// Buy-Bonus path). The rest is the normal weighted pool with the
// scatter removed so we don't accidentally exceed the count
// (which would change nothing functionally, but keeps it clean).
function genGridForcedScatters() {
  const g = new Array(CELL_COUNT)
  for (let i = 0; i < CELL_COUNT; i++) {
    // pick a non-scatter symbol
    let r = Math.random() * (SYM_WEIGHT_SUM)
    let chosen = SYMBOLS[0].id
    for (const s of SYMBOLS) {
      if (s.isScatter) { r -= s.weight; continue }
      if (r < s.weight) { chosen = s.id; break }
      r -= s.weight
    }
    g[i] = chosen
  }
  // Sprinkle exactly N scatters into distinct random cells.
  const slots = new Set()
  while (slots.size < SCATTERS_TO_TRIGGER) {
    slots.add(Math.floor(Math.random() * CELL_COUNT))
  }
  for (const i of slots) g[i] = SCATTER_ID
  return g
}

// HONESTLY-empty grid for the house-recovery (deficit) state.
// The user's rule: a deficit base spin must be *genuinely* a
// loss — we don't detect wins and silently swallow them, we
// deal a board where no symbol can possibly form an 8+ cluster.
// Every non-scatter symbol is hard-capped at MIN_MATCH-1 (7)
// copies, and scatters are capped below SCATTERS_TO_TRIGGER so a
// deficit default spin can't even back-door into the bonus. The
// fill is still weighted-random per cell — it just re-rolls a
// symbol that has already hit its cap, so the field looks like a
// normal messy spin that simply didn't line anything up.
function genGridDeficit() {
  const g = new Array(CELL_COUNT)
  const counts = {}
  const cropCap = MIN_MATCH - 1               // 7 — never reaches 8
  const scatterCap = SCATTERS_TO_TRIGGER - 1  // 2 — never triggers FS
  for (let i = 0; i < CELL_COUNT; i++) {
    let chosen = null
    // Try a handful of weighted picks first so the distribution
    // still looks organic; fall back to a deterministic scan for
    // any symbol still under its cap so we always place something.
    for (let tries = 0; tries < 12 && chosen == null; tries++) {
      const s = pickSymbol()
      const cap = SCATTER_IDS.has(s) ? scatterCap : cropCap
      if ((counts[s] || 0) < cap) chosen = s
    }
    if (chosen == null) {
      for (const s of SYMBOLS) {
        const cap = s.isScatter ? scatterCap : cropCap
        if ((counts[s.id] || 0) < cap) { chosen = s.id; break }
      }
    }
    g[i] = chosen
    counts[chosen] = (counts[chosen] || 0) + 1
  }
  return g
}

function pickSeasonCrop(season) {
  const pool = SEASON_CROPS[season]
  if (!pool || pool.length === 0) return null
  return pool[Math.floor(Math.random() * pool.length)]
}

// The bonus free-spin is staged into discrete beats so the player
// reads each one. The harvest collects fruit that ripened on a
// PREVIOUS spin — a plant that hits the fruit stage THIS spin
// just sits there and is collected next spin. That produces the
// design cadence:
//   spin 1: sow (sprouts appear)
//   spin 2: sprouts → bud + new sow
//   spin 3: bud → ripe fruit + bud + new sow
//   spin 4: ripe fruit harvested (vanishes) + grows + sow …
//
//   board : Array(BONUS_CELLS) of null | { crop, stage, boosted? }
//   `boosted` (×100 from a lightning strike) rides with the plant
//   through every grow until it's harvested ripe.

// Beat 1 — collect every fruit that was ALREADY ripe (stage 3)
// at the start of this spin. A boosted fruit pays the flat
// LIGHTNING_FRUIT_MULT × stake instead of its crop multiplier.
function bonusHarvest(board, stake) {
  const next = board.slice()
  const fruits = []
  for (let i = 0; i < BONUS_CELLS; i++) {
    if (next[i] && next[i].stage === STAGE_FRUIT) fruits.push(i)
  }
  const harvested = []
  let win = 0
  for (const i of fruits) {
    const c = next[i]
    const pay = c.boosted
      ? LIGHTNING_FRUIT_MULT * stake
      : (BONUS_CROP_PAY[c.crop] || 0) * stake
    win += pay
    harvested.push(i)
    next[i] = null
  }
  return { board: next, win, harvested }
}

// Beat 2 — every surviving plant advances ONE stage (1→2, 2→3).
// The `boosted` flag (and crop) ride along via the spread.
function bonusGrow(board) {
  const next = board.slice()
  const grown = []
  for (let i = 0; i < BONUS_CELLS; i++) {
    const c = next[i]
    if (c && c.stage < STAGE_FRUIT) {
      next[i] = { ...c, stage: c.stage + 1 }
      grown.push(i)
    }
  }
  return { board: next, grown }
}

// Beat 3 — sow fresh stage-1 sprouts into empty cells.
// `sowChance` defaults to the RTP-tuned constant; the deficit
// flow passes a much lower value so the harvest stays poor and
// the house recovers honestly (sprouts genuinely don't take —
// we never suppress a fruit that already grew).
function bonusSow(board, season, sowChance = BONUS_SOW_CHANCE) {
  const next = board.slice()
  const sown = []
  const crop = pickSeasonCrop(season)
  if (crop) {
    for (let i = 0; i < BONUS_CELLS; i++) {
      if (next[i]) continue
      if (Math.random() < sowChance) {
        next[i] = { crop, stage: STAGE_SPROUT }
        sown.push(i)
      }
    }
  }
  return { board: next, sown }
}

// Beat 4 (chance) — pick the lightning cells. `appear` is where
// the bolt forms (any cell, visual only); `strike` is the plant
// it hits (a random occupied cell) which becomes ×100-boosted.
// Returns null when there's nothing to strike.
function pickLightning(board, lightChance = BONUS_LIGHTNING_CHANCE) {
  if (Math.random() >= lightChance) return null
  const occupied = []
  for (let i = 0; i < BONUS_CELLS; i++) if (board[i]) occupied.push(i)
  if (occupied.length === 0) return null
  const strike = occupied[Math.floor(Math.random() * occupied.length)]
  const appear = Math.floor(Math.random() * BONUS_CELLS)
  return { appear, strike }
}

export default function StardewSpinsSlot() {
  const navigate = useNavigate()
  const { lang, currency, rates, balance, setBalance, user } = useGameStore(
    useShallow(s => ({
      lang: s.lang,
      currency: s.currency,
      rates: s.rates,
      balance: s.balance,
      setBalance: s.setBalance,
      user: s.user,
    }))
  )
  const t = translations[lang]

  // ── State ──
  const [grid, setGrid] = useState(() => genGrid())
  const [winningCells, setWinningCells] = useState(() => new Set())
  // Win-cluster animation stage for the cells in `winningCells`:
  //   'none'  — not a win moment
  //   'pulse' — symbols grow then shrink (one beat)
  //   'burst' — symbols pop & vanish
  const [winPhase, setWinPhase] = useState('none')
  // Per-cell fall distance (in rows) for the tumble drop. Sparse:
  // `{ [cellIdx]: rows }`. Empty when not mid-tumble.
  const [dropMap, setDropMap] = useState(() => ({}))
  // True while the gravity-drop + refill animation is playing —
  // toggles the `.is-tumble` class on the grid.
  const [tumbling, setTumbling] = useState(false)
  const [stake, setStake] = useState(BETS[0])
  const [spinning, setSpinning] = useState(false)
  const [autoSpin, setAutoSpin] = useState(false)
  const [lastWin, setLastWin] = useState(0)
  // Monotonic step counter — increments by 1 each season rotation
  // and never wraps. Drives both the displayed season name (via
  // SEASONS[step % 4]) AND the needle angle (-45 + step * 90).
  // Keeping the angle monotonically increasing means CSS transition
  // always rotates clockwise — never short-cuts back through the
  // sky quadrants when wrapping from winter → spring.
  // Initial step = 1 → SEASONS[1] = 'summer'.
  const [seasonStep, setSeasonStep] = useState(1)
  const season = SEASONS[seasonStep % SEASONS.length]
  const [seasonCountdown, setSeasonCountdown] = useState(SEASON_SPINS)
  // Spin animation phase. The initial swap of the whole grid plays
  // a column-staggered slide: every cell in column N starts moving
  // N * COL_STAGGER_MS after column 0. Two phases drive the CSS:
  //   'spin-out' — current cells slide DOWN out of the grid
  //   'spin-in'  — new cells slide DOWN from above into place
  // Cascade tumbles use the separate `tumbling` flag + `dropMap`.
  const [spinPhase, setSpinPhase] = useState('idle')

  // Buy-Bonus confirmation modal.
  const [buyBonusConfirm, setBuyBonusConfirm] = useState(false)

  // ── Bonus state ──
  //   mode      'base' | 'bonus'   — which engine is on screen
  //   bonusBoard Array(25) of null | { crop, stage }
  //   bonusSpinNo current free spin (1..BONUS_SPINS)
  //   bonusTotal accumulated bonus payout (incl. the carried base
  //              cascade win that triggered it)
  //   overlay   null | 'intro' | 'end'  — full-stage takeover card
  //   bonusFx   per-cell animation hints for the current beat:
  //             { sown:Set, grown:Set, harvested:Set,
  //               lp:null|'appear'|'strike', la:appearIdx,
  //               ls:strikeIdx }
  const EMPTY_FX = { sown: new Set(), grown: new Set(), harvested: new Set(), lp: null, la: -1, ls: -1 }
  const [mode, setMode] = useState('base')
  const [bonusBoard, setBonusBoard] = useState(() => new Array(BONUS_CELLS).fill(null))
  const [bonusSpinNo, setBonusSpinNo] = useState(0)
  const [bonusTotal, setBonusTotal] = useState(0)
  const [overlay, setOverlay] = useState(null)
  const [bonusFx, setBonusFx] = useState(() => ({ sown: new Set(), grown: new Set(), harvested: new Set(), lp: null, la: -1, ls: -1 }))
  const bonusSeason = mode === 'bonus' ? bonusSeasonForSpin(bonusSpinNo) : season

  // ── Asset preloader ──
  // Block the slot behind a parchment loading screen until every
  // texture it can show is decoded in the browser cache: the four
  // ~600 KB season backdrops AND every symbol sprite (8 crops,
  // lime scatter, the two sprout stages, the lightning bolt). By
  // the time the player can spin, no season swap / cascade / bonus
  // ever flashes a missing image.
  const [loadingBgs, setLoadingBgs] = useState(true)
  const [loadProgress, setLoadProgress] = useState(0)

  useEffect(() => {
    const sources = [
      // Season backdrops
      bgSpring, bgSummer, bgAutumn, bgWinter,
      // Base + bonus symbol sprites
      symPotatoe, symCarrot, symCorn, symEggplant, symTomatoe,
      symGrape, symPumpkin, symWatermelon, symLime,
      // Bonus growth stages + lightning
      symSprout, symSprout2, symLightning,
    ]
    const total = sources.length
    let loaded = 0
    let cancelled = false
    // Minimum display time so the loader doesn't blink in/out
    // when every PNG is already in the browser cache.
    const mountedAt = Date.now()
    const MIN_DISPLAY_MS = 600

    const finish = () => {
      if (cancelled) return
      const elapsed = Date.now() - mountedAt
      const wait = Math.max(0, MIN_DISPLAY_MS - elapsed)
      setTimeout(() => { if (!cancelled) setLoadingBgs(false) }, wait)
    }

    const onAny = () => {
      loaded++
      if (cancelled) return
      setLoadProgress(Math.round((loaded / total) * 100))
      if (loaded === total) finish()
    }

    sources.forEach((src) => {
      const img = new Image()
      img.onload  = onAny
      img.onerror = onAny       // count failures so we don't hang
      img.src = src
    })

    return () => { cancelled = true }
  }, [])

  // ── Refs (avoid stale-closure inside the spin loop / auto loop)
  const spinningRef  = useRef(false)
  const autoRef      = useRef(false)
  const stakeRef     = useRef(stake)
  const balanceRef   = useRef(balance)
  const cancelRef    = useRef(false)
  // Server round wrapping the WHOLE lifecycle (base cascade +
  // optional "Year of Harvest" bonus). One round, one finish call
  // at the very end with base+bonus summed — so buying a bonus,
  // playing it, then doing a normal spin can never orphan the
  // bonus win. `deficitRef` caches start_stardew_round's
  // deficit flag so the base grid + bonus go honestly poor.
  const roundRef     = useRef(null)
  const isDevRef     = useRef(false)
  const deficitRef   = useRef(false)
  useEffect(() => { spinningRef.current = spinning }, [spinning])
  useEffect(() => { autoRef.current     = autoSpin }, [autoSpin])
  useEffect(() => { stakeRef.current    = stake },    [stake])
  useEffect(() => { balanceRef.current  = balance },  [balance])
  useEffect(() => () => { cancelRef.current = true }, [])

  // ── Telegram BackButton + browser back to home ──
  useEffect(() => {
    const tg = window.Telegram?.WebApp
    const back = () => {
      haptic('light')
      cancelRef.current = true
      setAutoSpin(false); autoRef.current = false
      navigate('/home')
    }
    if (tg) {
      tg.BackButton.show()
      tg.BackButton.onClick(back)
    }
    return () => {
      if (tg) { tg.BackButton.offClick(back); tg.BackButton.hide() }
    }
  }, [navigate])

  // ── Derived values for the control bar ──
  const stakeIndex = BETS.indexOf(stake)
  const canAfford  = balance >= stake
  const stakeUpDisabled   = spinning || stakeIndex >= BETS.length - 1 ||
                            (BETS[stakeIndex + 1] !== undefined && BETS[stakeIndex + 1] > balance)
  const stakeDownDisabled = spinning || stakeIndex <= 0

  function changeStake(dir) {
    if (spinning) return
    const next = BETS[stakeIndex + dir]
    if (next == null) return
    if (dir > 0 && next > balance) return
    haptic('light')
    setStake(next)
  }

  // ── Spin loop ──
  // `buyBonus` forces a grid guaranteed to land 3 scatters and
  // charges stake × BUY_BONUS_MULT instead of one stake.
  async function spin({ buyBonus = false } = {}) {
    if (spinningRef.current) return
    const cost = buyBonus ? stakeRef.current * BUY_BONUS_MULT : stakeRef.current
    if (balanceRef.current < cost) return

    setSpinning(true); spinningRef.current = true
    haptic('medium')
    setLastWin(0)

    // ── Server start — opens ONE round wrapping base + bonus ──
    // Dev / no-Telegram falls back to the local zustand wallet so
    // the slot still plays offline. Real users get an atomic
    // server debit; the round id is finished ONCE at the very end
    // with the base cascade + full bonus summed.
    const isDev = !user || user.id === 'dev'
    isDevRef.current = isDev
    if (isDev) {
      const next = balanceRef.current - cost
      balanceRef.current = next
      setBalance(next)
      roundRef.current = { dev: true, round_id: `dev-${Date.now()}` }
      deficitRef.current = false
    } else {
      const res = await startStardewRound(user.id, stakeRef.current, buyBonus)
      if (cancelRef.current) { spinningRef.current = false; setSpinning(false); return }
      if (!res || res.error || !res.ok) {
        console.error('startStardewRound failed:', res)
        spinningRef.current = false
        setSpinning(false)
        return
      }
      roundRef.current = res
      deficitRef.current = !!res.deficit_active
      balanceRef.current = res.balance
      setBalance(res.balance)
    }

    // 1a) SLIDE OUT — current cells fall off the bottom of the
    // grid, column by column (col 0 first, then col 1 after
    // COL_STAGGER_MS, …). The whole pass finishes when the LAST
    // column's COL_SLIDE_MS animation ends.
    setWinningCells(new Set())
    setWinPhase('none')
    setTumbling(false)
    setDropMap({})
    setSpinPhase('spin-out')
    await wait(ALL_COLS_MS)

    // 1b) Swap to a fresh grid AND flip the phase to spin-in in
    // the same React tick. Cells were just animated to translateY
    // off the bottom; the new class's keyframe starts at
    // translateY off the TOP, so no visible snap.
    // Deficit base spins are HONESTLY empty — genGridDeficit caps
    // every symbol below the 8-cluster / 3-scatter thresholds so
    // there is genuinely nothing to win (not a suppressed win).
    // A buy-bonus still forces its 3 scatters even in deficit —
    // the player chose it; the bonus itself just pays poorly.
    let g = buyBonus
      ? genGridForcedScatters()
      : (deficitRef.current ? genGridDeficit() : genGrid())
    setGrid(g)
    setSpinPhase('spin-in')
    await wait(ALL_COLS_MS)
    setSpinPhase('idle')

    // 2) Cascade loop.
    let totalWin = 0
    let chain = 0
    // Sanity bound — chain can't loop forever (each iteration
    // strictly reduces something), but cap it anyway.
    while (chain < 30) {
      if (cancelRef.current) break
      const wins = findWins(g)
      const symIds = Object.keys(wins)
      if (symIds.length === 0) break

      // Build the winning-cell set and tally the cluster payouts.
      const winSet = new Set()
      let chainWin = 0
      for (const sym of symIds) {
        const idx = wins[sym]
        chainWin += payoutFor(sym, idx.length) * stakeRef.current
        idx.forEach(i => winSet.add(i))
      }

      // Accumulate into the running total and push it to the
      // winbar NOW (during the pulse) — so the player watches the
      // number climb with every cascade in the chain, not only at
      // the very end. The balance itself isn't touched until the
      // whole cascade finishes (credited once below).
      totalWin += chainWin
      setLastWin(Math.round(totalWin))

      // 2a) PULSE — winning symbols grow then shrink back (one
      // beat) so the eye registers what's about to pop.
      setWinningCells(winSet)
      setWinPhase('pulse')
      haptic('light')
      await wait(WIN_PULSE_MS)
      if (cancelRef.current) break

      // 2b) BURST — same cells pop and vanish.
      setWinPhase('burst')
      haptic('medium')
      await wait(WIN_BURST_MS)
      if (cancelRef.current) break

      // 2c) DROP — compute the tumbled grid + per-cell fall
      // distance, swap it in, and play the gravity-drop: every
      // symbol slides down from `drop[i]` rows above its slot,
      // column-staggered L→R but overlapping (the `.is-tumble`
      // class drives the keyframe; `--drop` / `--col` set inline).
      const { grid: tg, drop } = tumbleGrid(g, winSet)
      g = tg
      setGrid(g)
      setDropMap(drop)
      setWinningCells(new Set())
      setWinPhase('none')
      setTumbling(true)

      chain++
      await wait(ALL_TUMBLE_MS)
      setTumbling(false)
      setDropMap({})
    }

    // 4) Scatter trigger — 3+ lime anywhere on the settled grid
    // (the buy path forces this). The base spin's own cascade win
    // is NOT credited here: it's carried INTO the bonus and the
    // whole round (base + harvest) is finished on the server in
    // ONE call below, so the bonus win can never get orphaned.
    const scatters = countScatters(g)
    const triggered = scatters >= SCATTERS_TO_TRIGGER && !cancelRef.current
    let bonusContribution = 0
    if (triggered) {
      // runBonus SEEDS its total with the base cascade win and
      // returns base + harvest, so it already includes totalWin.
      bonusContribution = await runBonus(Math.round(totalWin), {
        deficit: deficitRef.current,
      }) || 0
    }

    // ── Server finalize — ONE finish call for the whole round ──
    // grandTotal = base cascade ⊔ (base + bonus). Math.max guards
    // a cancelled/partial bonus so the base win still settles.
    const grandTotal = Math.max(Math.round(totalWin), Math.round(bonusContribution))
    if (isDevRef.current) {
      if (grandTotal > 0) {
        const fb = balanceRef.current + grandTotal
        balanceRef.current = fb
        setBalance(fb)
        try { window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success') } catch { /* opt */ }
      }
    } else if (roundRef.current?.round_id) {
      try {
        const res = await finishStardewRound(roundRef.current.round_id, grandTotal)
        if (res && !res.error && typeof res.balance === 'number') {
          setBalance(res.balance)
          balanceRef.current = res.balance
        }
      } catch (err) {
        console.error('finishStardewRound failed:', err)
      }
    }
    roundRef.current = null

    // 5) Seasonal countdown (base-game wheel only, no bonus). The
    // monotonic step keeps the needle sweeping clockwise.
    if (!triggered) {
      setSeasonCountdown(c => {
        if (c <= 1) {
          setSeasonStep(s => s + 1)
          return SEASON_SPINS
        }
        return c - 1
      })
    }

    setSpinning(false); spinningRef.current = false

    if (triggered) {
      // Don't auto-continue straight out of a bonus — let the
      // player breathe and resume manually.
      setAutoSpin(false); autoRef.current = false
      return
    }

    // Auto-spin continuation.
    if (autoRef.current && balanceRef.current >= stakeRef.current) {
      await wait(POST_SPIN_REST)
      if (autoRef.current && !cancelRef.current) spin()
    } else if (autoRef.current) {
      setAutoSpin(false); autoRef.current = false
    }
  }

  // ── Bonus runner — 10 free spins on the 5×5 farm ──
  // `seedWin` is the carried base-spin cascade win (already
  // rounded). It opens the run so the bonus total starts from it.
  // Returns the GRAND total (seed + harvest) — the caller does the
  // single server finish so the win can never be orphaned. When
  // `deficit` is set the bonus isn't empty, just POOR: sprouts
  // rarely take and lightning never strikes, so the house
  // recovers honestly without ever swallowing a fruit that grew.
  async function runBonus(seedWin, { deficit = false } = {}) {
    const sowChance   = deficit ? 0.012 : BONUS_SOW_CHANCE
    const lightChance = deficit ? 0     : BONUS_LIGHTNING_CHANCE
    haptic('heavy')
    // Intro takeover card.
    setBonusTotal(seedWin)
    setLastWin(seedWin)
    setOverlay('intro')
    await wait(OVERLAY_INTRO_MS)
    if (cancelRef.current) return seedWin
    setOverlay(null)

    // Switch the stage to the empty 5×5 farm.
    let board = new Array(BONUS_CELLS).fill(null)
    let total = seedWin
    setMode('bonus')
    setBonusBoard(board)
    setBonusFx({ ...EMPTY_FX })

    const emptyFx = () => ({ sown: new Set(), grown: new Set(), harvested: new Set(), lp: null, la: -1, ls: -1 })

    for (let n = 1; n <= BONUS_SPINS; n++) {
      if (cancelRef.current) break
      setBonusSpinNo(n)
      const season = bonusSeasonForSpin(n)

      // ── BEAT 1: HARVEST — collect fruit that ripened on a
      // PREVIOUS spin. Boosted fruit pays the flat ×100. Flash +
      // yoink the ripe cells, bank the win, then clear them.
      const h = bonusHarvest(board, stakeRef.current)
      if (h.harvested.length) {
        setBonusFx({ ...emptyFx(), harvested: new Set(h.harvested) })
        total += h.win
        setBonusTotal(total)
        setLastWin(Math.round(total))
        haptic(h.win > stakeRef.current * 20 ? 'heavy' : 'medium')
        await wait(BONUS_HARVEST_MS)
        if (cancelRef.current) break
        setBonusBoard(h.board)              // ripe cells now empty
        setBonusFx(emptyFx())
        await wait(BONUS_HARVEST_GAP)
        if (cancelRef.current) break
      }
      board = h.board

      // ── BEAT 2: GROW — survivors advance one stage. Sprites
      // swap instantly (sprout → sprout2 → ripe fruit); the
      // boosted flag rides along. Hold so the player sees it.
      const g = bonusGrow(board)
      if (g.grown.length) {
        setBonusBoard(g.board)
        setBonusFx({ ...emptyFx(), grown: new Set(g.grown) })
        await wait(BONUS_GROW_MS)
        if (cancelRef.current) break
        setBonusFx(emptyFx())
        await wait(BONUS_GROW_GAP)
        if (cancelRef.current) break
      }
      board = g.board

      // ── BEAT 3: SOW — fresh sprouts pop into empty plots.
      const s = bonusSow(board, season, sowChance)
      if (s.sown.length) {
        setBonusBoard(s.board)
        setBonusFx({ ...emptyFx(), sown: new Set(s.sown) })
        await wait(BONUS_SOW_MS)
        if (cancelRef.current) break
        setBonusFx(emptyFx())
      }
      board = s.board

      // ── BEAT 4 (chance): LIGHTNING. The bolt FORMS over cell A
      // (screen darkens except A, sprite grows + sparks), then
      // vanishes and a strike bolt hits target cell B (screen
      // still dark, B highlighted). B's plant becomes ×100-
      // boosted and keeps the boost as it grows; it only ever
      // pays out if it survives to a ripe harvest.
      const lt = pickLightning(board, lightChance)
      if (lt) {
        // Form-up over A.
        setBonusFx({ ...emptyFx(), lp: 'appear', la: lt.appear, ls: lt.strike })
        haptic('medium')
        await wait(LIGHTNING_APPEAR_MS)
        if (cancelRef.current) break
        // Strike B.
        setBonusFx({ ...emptyFx(), lp: 'strike', la: lt.appear, ls: lt.strike })
        try { window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('warning') } catch { /* opt */ }
        haptic('heavy')
        await wait(LIGHTNING_STRIKE_MS)
        if (cancelRef.current) break
        // Boost B's plant (rides through grow until harvested).
        if (board[lt.strike]) {
          const nb = board.slice()
          nb[lt.strike] = { ...nb[lt.strike], boosted: true }
          board = nb
          setBonusBoard(board)
        }
        setBonusFx(emptyFx())
        await wait(LIGHTNING_GAP_MS)
        if (cancelRef.current) break
      }

      await wait(BONUS_SPIN_GAP)
    }

    // End takeover card with the grand total.
    setOverlay('end')
    haptic('heavy')
    await wait(OVERLAY_END_MS)

    // NOTE: the win is NOT credited here. runBonus only returns
    // the grand total (base carry + harvest); the caller runs the
    // single server finish_stardew_round so the whole round —
    // base cascade AND bonus — settles atomically in ONE call and
    // the bonus win can never be orphaned by a quick follow-up
    // spin. (Dev mode credits the local wallet there instead.)

    // Tear the bonus down and restore the idle base grid.
    setOverlay(null)
    setMode('base')
    setBonusSpinNo(0)
    setBonusBoard(new Array(BONUS_CELLS).fill(null))
    setBonusFx({ ...EMPTY_FX })
    setGrid(genGrid())
    return total
  }

  function onSpinClick() {
    if (autoSpin) {
      // Tap during auto = "stop after current spin".
      setAutoSpin(false); autoRef.current = false
      return
    }
    if (!canAfford || spinning) return
    spin()
  }

  function onAutoClick() {
    if (autoSpin) {
      setAutoSpin(false); autoRef.current = false
      return
    }
    if (!canAfford || spinning) return
    setAutoSpin(true); autoRef.current = true
    spin()
  }

  // Needle rotation — 4 quadrants × 90° each. Step 0 is spring
  // (TL → -45°), then +90° per season, indefinitely:
  //   step 0 (spring) = -45°
  //   step 1 (summer) =  45°
  //   step 2 (fall)   = 135°
  //   step 3 (winter) = 225°
  //   step 4 (spring) = 315°
  // The CSS transition lerps between successive values, so the
  // needle always sweeps clockwise the full 90° without ever
  // jumping backwards on the winter → spring boundary.
  const seasonAngle = -45 + seasonStep * 90

  // During the bonus the wheel + backdrop track the BONUS season
  // (Spring → Summer → Fall → Winter across the 10 free spins),
  // not the base-game wheel. SEASONS index = needle quadrant, so
  // angle = -45 + idx*90 keeps the sweep clockwise spring→winter.
  const SEASON_IDX = { spring: 0, summer: 1, fall: 2, winter: 3 }
  const effSeason  = mode === 'bonus' ? bonusSeason : season
  const effAngle   = mode === 'bonus'
    ? (-45 + (SEASON_IDX[bonusSeason] ?? 1) * 90)
    : seasonAngle

  // ── Loading screen ──
  // Held until every seasonal backdrop is decoded so the wheel
  // never flips to a half-loaded photo mid-spin.
  if (loadingBgs) {
    return (
      <div className="stardew-slot-page stardew-slot-page--summer">
        <div className="stardew-game-window stardew-loading-window">
          <div className="stardew-loading-card">
            <h2 className="stardew-loading-title">{t.slotStardewTitle || 'Stardew Spins'}</h2>
            <p className="stardew-loading-sub">
              {lang === 'ru' ? 'Готовим грядки…' : 'Tilling the soil…'}
            </p>
            <div className="stardew-loading-bar" aria-label="Loading">
              <span
                className="stardew-loading-bar-fill"
                style={{ width: `${loadProgress}%` }}
              />
            </div>
            <span className="stardew-loading-percent">{loadProgress}%</span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={`stardew-slot-page stardew-slot-page--${effSeason}`}>
      <div className="stardew-game-window">
        <main
          className={'stardew-stage' + (spinning ? ' is-spinning' : '')}
          aria-label="Stardew Spins"
          style={{ '--stardew-bg': `url("${SEASON_BG[effSeason] || bgSummer}")` }}
        >
          {/* The summer.png backdrop paints sky / grass / fence /
            * scarecrow / sun / well already — the only thing we
            * keep animated on top are drifting clouds. Some live
            * up in the sky area, others spawn lower and pass
            * behind the wooden grid (clouds sit at z-index 1,
            * grid at 2) so the whole window feels alive. */}
          <span className="stardew-cloud stardew-cloud--one" />
          <span className="stardew-cloud stardew-cloud--two" />
          <span className="stardew-cloud stardew-cloud--three" />
          <span className="stardew-cloud stardew-cloud--four" />
          <span className="stardew-cloud stardew-cloud--five" />
          <span className="stardew-cloud stardew-cloud--six" />

          {/* Snowfall — only when the seasonal wheel is on winter.
            * A small flake field with staggered start times so the
            * sky always has snow in motion, not synchronized
            * "raindrop" pulses. */}
          {season === 'winter' && (
            <>
              <span className="stardew-snow stardew-snow--a" />
              <span className="stardew-snow stardew-snow--b" />
              <span className="stardew-snow stardew-snow--c" />
              <span className="stardew-snow stardew-snow--d" />
              <span className="stardew-snow stardew-snow--e" />
              <span className="stardew-snow stardew-snow--f" />
              <span className="stardew-snow stardew-snow--g" />
              <span className="stardew-snow stardew-snow--h" />
              <span className="stardew-snow stardew-snow--i" />
              <span className="stardew-snow stardew-snow--j" />
              <span className="stardew-snow stardew-snow--k" />
              <span className="stardew-snow stardew-snow--l" />
            </>
          )}

          {/* Seasonal wheel — pinned to the top of the stage. */}
          <div className="stardew-wheel">
            <div className="stardew-wheel-disc">
              <span className="stardew-wheel-q stardew-wheel-q--spring" />
              <span className="stardew-wheel-q stardew-wheel-q--summer" />
              <span className="stardew-wheel-q stardew-wheel-q--fall" />
              <span className="stardew-wheel-q stardew-wheel-q--winter" />
              <span className="stardew-wheel-needle" style={{ transform: `translate(-50%, -100%) rotate(${effAngle}deg)` }} />
              <span className="stardew-wheel-hub" />
            </div>
            <span className="stardew-wheel-label">
              {seasonLabel(t, effSeason)}
            </span>
            <span className="stardew-wheel-counter">
              {mode === 'bonus'
                ? (lang === 'ru' ? 'Год урожая' : 'Harvest year')
                : (t.stardewSeasonNext || 'Next:') + ' ' + seasonCountdown}
            </span>
          </div>

          {/* ── Field area — just the wooden grid floats over the
              farm backdrop now; fence / sunflowers / well /
              scarecrow are all baked into summer.png. ── */}
          <div className="stardew-field-area">
            {/* CENTER — wooden grid frame with crops */}
            <div className="stardew-grid-frame">
              <span className="stardew-nail stardew-nail--tl" />
              <span className="stardew-nail stardew-nail--tr" />
              <span className="stardew-nail stardew-nail--bl" />
              <span className="stardew-nail stardew-nail--br" />


              {mode === 'base' ? (
              <div
                className={
                  'stardew-grid' +
                  (spinPhase === 'spin-out' ? ' is-spin-out' : '') +
                  (spinPhase === 'spin-in'  ? ' is-spin-in'  : '') +
                  (tumbling                 ? ' is-tumble'   : '')
                }
              >
                {/* Column-strip backgrounds — one per column, each
                  * spans all five grid rows so the dirt colour reads
                  * as ONE continuous vertical band. Cells themselves
                  * stay transparent above these, which is what lets
                  * a sliding crop pass through neighbouring cells
                  * without being painted over by their backgrounds. */}
                {Array.from({ length: COLS }).map((_, c) => (
                  <span
                    key={`col-bg-${c}`}
                    className="stardew-col-bg"
                    aria-hidden="true"
                    style={{ gridColumn: c + 1, gridRow: '1 / -1' }}
                  />
                ))}
                {grid.map((sym, i) => {
                  const isWin   = winningCells.has(i)
                  const c       = i % COLS
                  const r       = Math.floor(i / COLS)
                  const drop    = dropMap[i] || 0
                  // `--col` drives the column-staggered animation
                  // delay; `--drop` is how many rows this symbol
                  // visually falls during the tumble. Explicit
                  // gridColumn / gridRow keeps the cell in its
                  // row-major slot even though .stardew-col-bg
                  // siblings span grid-row: 1/-1 over the same
                  // tracks (auto-placement would otherwise shove
                  // the cells off the grid).
                  const cellStyle = {
                    '--col': c,
                    '--drop': drop,
                    gridColumn: c + 1,
                    gridRow: r + 1,
                  }
                  // Win-cluster cells take 'is-pulse' then
                  // 'is-burst' depending on the current winPhase.
                  const winCls = isWin
                    ? (winPhase === 'burst'
                        ? ' is-win is-burst'
                        : winPhase === 'pulse'
                          ? ' is-win is-pulse'
                          : ' is-win')
                    : ''
                  return (
                    <span
                      key={i}
                      className={'stardew-cell' + winCls}
                      style={cellStyle}
                    >
                      {sym && SYMBOL_IMG[sym] && (
                        <span
                          className="stardew-crop"
                          style={{ backgroundImage: `url("${SYMBOL_IMG[sym]}")` }}
                        />
                      )}
                    </span>
                  )
                })}
              </div>
              ) : (
              /* ── Bonus farm — 5×5 grid of plant plots ── */
              <div
                className={
                  'stardew-grid stardew-grid--bonus' +
                  (bonusFx.lp ? ' is-lightning' : '')
                }
              >
                {Array.from({ length: BONUS_COLS }).map((_, c) => (
                  <span
                    key={`bcol-bg-${c}`}
                    className="stardew-col-bg"
                    aria-hidden="true"
                    style={{ gridColumn: c + 1, gridRow: '1 / -1' }}
                  />
                ))}
                {bonusBoard.map((cell, i) => {
                  const c = i % BONUS_COLS
                  const r = Math.floor(i / BONUS_COLS)
                  const isSown      = bonusFx.sown.has(i)
                  const isGrown     = bonusFx.grown.has(i)
                  const isHarvested = bonusFx.harvested.has(i)
                  // Lightning lighting: while the bolt is forming
                  // (`appear`) cell A is the lit one; while it
                  // strikes (`strike`) cell B is. Everything else
                  // is dimmed by the .is-lightning grid overlay.
                  const isLitAppear = bonusFx.lp === 'appear' && bonusFx.la === i
                  const isLitStrike = bonusFx.lp === 'strike' && bonusFx.ls === i
                  const cls =
                    'stardew-cell stardew-cell--bonus' +
                    (isSown      ? ' is-sown'        : '') +
                    (isGrown     ? ' is-grown'       : '') +
                    (isHarvested ? ' is-harvested'   : '') +
                    (isLitAppear ? ' is-lit is-bolt' : '') +
                    (isLitStrike ? ' is-lit is-struck' : '')
                  const img = cell ? bonusPlantImg(cell.crop, cell.stage) : null
                  // ×N badge: only ripe fruit shows its crop
                  // multiplier; a lightning-boosted plant shows
                  // ×100 at ANY stage; plain sprouts show nothing.
                  let badge = null
                  if (cell) {
                    if (cell.boosted) badge = `×${LIGHTNING_FRUIT_MULT}`
                    else if (cell.stage === STAGE_FRUIT) badge = `×${BONUS_CROP_PAY[cell.crop] || 0}`
                  }
                  return (
                    <span
                      key={i}
                      className={cls}
                      style={{ gridColumn: c + 1, gridRow: r + 1 }}
                    >
                      {img && (
                        <span
                          className={
                            'stardew-crop stardew-plant' +
                            (cell.stage === STAGE_FRUIT ? ' is-ripe' : '') +
                            (cell.boosted ? ' is-boosted' : '')
                          }
                          style={{ backgroundImage: `url("${img}")` }}
                        />
                      )}
                      {badge && (
                        <span className={'stardew-x-badge' + (cell.boosted ? ' is-boosted' : '')}>
                          {badge}
                        </span>
                      )}
                      {/* Lightning sprite — forms over cell A while
                        * the bolt charges. */}
                      {isLitAppear && (
                        <span
                          className="stardew-lightning-sprite"
                          style={{ backgroundImage: `url("${symLightning}")` }}
                        />
                      )}
                      {/* Strike bolt — slams into cell B. */}
                      {isLitStrike && <span className="stardew-strike-bolt" aria-hidden="true" />}
                    </span>
                  )
                })}
              </div>
              )}

            </div>
          </div>

          {/* ── Bonus season banner — replaces nothing, floats
            * just above the farm so the player tracks the
            * Spring → Summer → Fall → Winter year + spin count. */}
          {mode === 'bonus' && (
            <div className={`stardew-bonus-banner stardew-bonus-banner--${bonusSeason}`}>
              <span className="stardew-bonus-banner-season">
                {seasonLabel(t, bonusSeason)}
              </span>
              <span className="stardew-bonus-banner-spin">
                {(lang === 'ru' ? 'Спин ' : 'Spin ') + bonusSpinNo + ' / ' + BONUS_SPINS}
              </span>
            </div>
          )}

          {/* ── Bonus overlays — full-stage takeover cards ── */}
          {overlay && (
            <div className="stardew-bonus-overlay">
              <div className="stardew-bonus-overlay-card">
                {overlay === 'intro' ? (
                  <>
                    <div className="stardew-bonus-overlay-title">
                      {lang === 'ru' ? 'ГОД УРОЖАЯ' : 'YEAR OF HARVEST'}
                    </div>
                    <div className="stardew-bonus-overlay-big">{BONUS_SPINS}</div>
                    <div className="stardew-bonus-overlay-sub">
                      {lang === 'ru' ? 'Фриспинов' : 'Free spins'}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="stardew-bonus-overlay-title">
                      {lang === 'ru' ? 'УРОЖАЙ СОБРАН' : 'HARVEST COMPLETE'}
                    </div>
                    <div className="stardew-bonus-overlay-total">
                      +{formatCurrency(Math.round(bonusTotal), currency, rates)}
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Buy-Bonus FAB — round gold coin pinned to the
            * bottom-LEFT corner of the stage (matches Pixel Mine's
            * placement). Tapping opens the confirmation modal;
            * actual purchase RPC is wired in a follow-up. */}
          <button
            type="button"
            className="stardew-buy-bonus-fab"
            onClick={() => {
              if (spinning || autoSpin) return
              haptic('medium')
              setBuyBonusConfirm(true)
            }}
            disabled={spinning || autoSpin || balance < stake * 100}
            aria-label="Buy Bonus"
          >
            <span className="stardew-buy-bonus-fab-buy">BUY</span>
          </button>

          {/* ── Buy-Bonus confirmation modal ──
            * Mirrors the Pixel Mine modal's structure (title, cost
            * chip, Cancel/Buy row) but recoloured to the parchment
            * + wooden-plank Stardew palette. The "Купить" button is
            * a visual stub for now — clicks just dismiss the modal
            * until the purchase RPC is wired in. */}
          {buyBonusConfirm && (
            <div
              className="stardew-buy-modal-backdrop"
              onClick={() => setBuyBonusConfirm(false)}
            >
              <div
                className="stardew-buy-modal-card"
                onClick={e => e.stopPropagation()}
              >
                <h3 className="stardew-buy-modal-title">BUY BONUS</h3>
                <div className="stardew-buy-modal-cost">
                  <span>{lang === 'ru' ? 'Стоимость' : 'Cost'}</span>
                  <strong>{formatCurrency(stake * 100, currency, rates)}</strong>
                </div>
                <div className="stardew-buy-modal-actions">
                  <button
                    type="button"
                    className="stardew-buy-modal-cancel"
                    onClick={() => { haptic('light'); setBuyBonusConfirm(false) }}
                  >
                    {lang === 'ru' ? 'Отмена' : 'Cancel'}
                  </button>
                  <button
                    type="button"
                    className="stardew-buy-modal-buy"
                    disabled={spinning || balance < stake * BUY_BONUS_MULT}
                    onClick={() => {
                      if (spinning || balance < stake * BUY_BONUS_MULT) return
                      haptic('medium')
                      setBuyBonusConfirm(false)
                      // Forced spin: grid lands 3 scatters → its
                      // cascades resolve → bonus triggers. Cost is
                      // stake × BUY_BONUS_MULT, debited inside spin().
                      spin({ buyBonus: true })
                    }}
                  >
                    {lang === 'ru' ? 'Купить' : 'Buy'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </main>

        {/* ── Winbar — sits between stage and controls, same slot
          * as Magnetic's winbar. Always rendered so the controls
          * tray stays at a stable height; lights up when a win
          * lands. */}
        <div className={'stardew-winbar-row'}>
          <div className={'stardew-winbar' + (lastWin > 0 ? ' is-win' : '')}>
            <span className="stardew-winbar-label">
              {t.slotPotential || 'Win'}
            </span>
            <strong className="stardew-winbar-value">
              {lastWin > 0
                ? `+${formatCurrency(lastWin, currency, rates)}`
                : formatCurrency(0, currency, rates)}
            </strong>
          </div>
        </div>

        {/* ── Controls ── */}
        <section className="stardew-controls">
          <div className="stardew-balance">
            <span>{t.balance || 'Баланс'}</span>
            <strong>{formatCurrency(balance, currency, rates)}</strong>
          </div>

          <div className="stardew-center">
            <button
              type="button"
              className={'stardew-spin-btn' + (autoSpin ? ' is-auto' : '')}
              onClick={onSpinClick}
              disabled={!autoSpin && (!canAfford || spinning)}
              aria-label={autoSpin ? 'Stop' : 'Spin'}
            >
              {autoSpin ? (
                <svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <rect x="6" y="5" width="4" height="14" rx="1.2" />
                  <rect x="14" y="5" width="4" height="14" rx="1.2" />
                </svg>
              ) : (
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M21 12a9 9 0 1 1-3-6.7M21 4v5h-5" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              )}
            </button>
            <button
              type="button"
              className={'stardew-auto-btn' + (autoSpin ? ' is-on' : '')}
              onClick={onAutoClick}
              disabled={!autoSpin && (!canAfford || spinning)}
            >
              {autoSpin
                ? (t.slotPlinkoStop || 'Stop')
                : (t.slotPlinkoAuto || 'Auto')}
            </button>
          </div>

          <div className="stardew-stake-block">
            {/* Label sits ABOVE the row (mirrors the balance card)
              * so the −/+ row gets the full column width for the
              * value — important once the stake climbs to 8 000 ₽
              * and the formatted number wouldn't fit beside an
              * inline label. */}
            <span className="stardew-stake-label">{t.slotBet || 'Ставка'}</span>
            <div className="stardew-stake-row">
              <button
                type="button"
                className="stardew-stake-step"
                onClick={() => changeStake(-1)}
                disabled={stakeDownDisabled}
                aria-label="stake down"
              >−</button>
              <strong className="stardew-stake-value">
                {formatCurrency(stake, currency, rates)}
              </strong>
              <button
                type="button"
                className="stardew-stake-step"
                onClick={() => changeStake(1)}
                disabled={stakeUpDisabled}
                aria-label="stake up"
              >+</button>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}

// ── Helpers ──

// Pull the localised season label straight from the active i18n
// bundle. Keys are added in src/lib/i18n.js (stardewSeasonSpring
// etc.) for every supported language — the EN fallback inside
// the helper only kicks in if a translation file ever forgets
// one of the four seasons.
function seasonLabel(t, season) {
  if (season === 'spring') return t.stardewSeasonSpring || 'Spring'
  if (season === 'summer') return t.stardewSeasonSummer || 'Summer'
  if (season === 'fall')   return t.stardewSeasonFall   || 'Fall'
  if (season === 'winter') return t.stardewSeasonWinter || 'Winter'
  return season
}
