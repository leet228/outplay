import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useShallow } from 'zustand/react/shallow'
import useGameStore from '../store/useGameStore'
import { translations } from '../lib/i18n'
import { formatCurrency } from '../lib/currency'
import { haptic } from '../lib/telegram'
import { startPixelMineRound, finishPixelMineRound } from '../lib/supabase'
import './PixelMineSlot.css'

// ── Texture imports ──
// Vite resolves these to hashed asset URLs at build time. We attach
// them via inline style on each cell so the CSS classes stay
// stylistic-only (sizing, shadows, animations) and the textures stay
// data-driven from the asset folder.
import texReelWood      from '../assets/games/pixel_mine/reels/wood.png'
import texReelStone     from '../assets/games/pixel_mine/reels/stone.png'
import texReelGold      from '../assets/games/pixel_mine/reels/gold.png'
import texReelDiamond   from '../assets/games/pixel_mine/reels/diamond.png'
import texReelTnt       from '../assets/games/pixel_mine/reels/tnt.png'
import texReelBook      from '../assets/games/pixel_mine/reels/book.png'
import texReelEnder     from '../assets/games/pixel_mine/reels/ender.png'

import texBlockGrass    from '../assets/games/pixel_mine/blocks/grass.png'
import texBlockDirt     from '../assets/games/pixel_mine/blocks/dirt.png'
import texBlockStone    from '../assets/games/pixel_mine/blocks/stone_block.png'
import texBlockRedstone from '../assets/games/pixel_mine/blocks/redstone.png'
import texBlockDiamond  from '../assets/games/pixel_mine/blocks/diamond_block.png'
import texBlockGold     from '../assets/games/pixel_mine/blocks/gold_block.png'
import texBlockObsidian from '../assets/games/pixel_mine/blocks/obsidian.png'

import texChestClosed   from '../assets/games/pixel_mine/chests/chest.png'
import texChestOpen     from '../assets/games/pixel_mine/chests/opened_chest.png'

// Damaged-block textures — a sequence per block type showing the
// block as it gets chipped down to zero HP. File names look like
// "obsidian (3).png" = appearance after 3 hits taken. Using
// import.meta.glob so adding new frames is just dropping a new
// PNG into the folder.
const damageRaw = import.meta.glob(
  '../assets/games/pixel_mine/block_damage/*.png',
  { eager: true, query: '?url', import: 'default' }
)
// Map block-base filename → internal block type used by BLOCKS{}.
const DAMAGE_FILE_TO_TYPE = {
  stone_block:   'stone',
  redstone:      'redstone',
  gold_block:    'gold',
  diamond_block: 'diamond',
  obsidian:      'obsidian',
}
// DAMAGE_TEX[type][level - 1] = URL of the texture after `level` hits.
const DAMAGE_TEX = {}
for (const [path, url] of Object.entries(damageRaw)) {
  // Filenames may be URL-encoded by Vite's import.meta.glob — spaces
  // become %20 and parens become %28 / %29 — so decode before
  // pattern-matching.
  const rawFilename = path.split('/').pop()                  // raw, possibly encoded
  const filename = decodeURIComponent(rawFilename)            // "obsidian (3).png"
  const m = filename.match(/^(.+?)\s*\((\d+)\)\.png$/)
  if (!m) continue
  const type = DAMAGE_FILE_TO_TYPE[m[1]]
  if (!type) continue
  const level = parseInt(m[2], 10)
  if (!DAMAGE_TEX[type]) DAMAGE_TEX[type] = []
  DAMAGE_TEX[type][level - 1] = url
}

// Pick the right texture for a block at its current HP.
//   damageLevel = full_hp - current_hp  (0 = pristine, hp_max = broken)
// damageLevel 0 → base texture; 1..N → block_damage[N-1]; capped at
// the highest available frame so missing frames don't fall back to
// the pristine block.
function blockTextureFor(type, hp) {
  const fullHp = BLOCKS[type]?.hits ?? 1
  const damageLevel = fullHp - hp
  if (damageLevel <= 0) return BLOCK_TEX[type]
  const dmg = DAMAGE_TEX[type]
  if (!dmg || dmg.length === 0) return BLOCK_TEX[type]
  const idx = Math.min(damageLevel - 1, dmg.length - 1)
  return dmg[idx] || BLOCK_TEX[type]
}

// Reel-cell texture lookup. Internal symbol keys (`stone_p`,
// `gold_p`, `enchanted`) map to the user's filenames (`stone`,
// `gold`, `diamond`) — keeps the gameplay code stable while letting
// the artist name files however they like.
const REEL_TEX = {
  wood:      texReelWood,
  stone_p:   texReelStone,
  gold_p:    texReelGold,
  enchanted: texReelDiamond,
  tnt:       texReelTnt,
  book:      texReelBook,
  ender:     texReelEnder,
  blank:     null,
}

// Block-cell texture lookup. Internal type names match the texture
// filenames so swapping art assets just means dropping a new PNG
// in src/assets/games/pixel_mine/blocks/ with the same name.
const BLOCK_TEX = {
  grass:    texBlockGrass,
  dirt:     texBlockDirt,
  stone:    texBlockStone,
  redstone: texBlockRedstone,
  gold:     texBlockGold,
  diamond:  texBlockDiamond,
  obsidian: texBlockObsidian,
}

// Falling-pickaxe sprite uses the same reel texture (just bigger
// and animated), so we re-use REEL_TEX above.

// ─────────────────────────────────────────────────────────────
// PIXEL MINE — Minecraft-style mining slot, gameplay cloned from
// InOut Games' "Mine Slot" (https://themineslot.com/).
//
// Two-layer board:
//   - Top:    5 × 3 reels that act as a tool generator. Each cell
//             is a pickaxe (Wood / Stone / Gold / Enchanted), TNT,
//             Enchantment Book, Eye of Ender (scatter), or blank.
//   - Middle: 5 × 7 mining field full of stacked blocks (Dirt →
//             Stone → Ore → Gold → Diamond → Obsidian, with the
//             toughest block at the bottom).
//   - Bottom: 5 chests — one per column. Cleared columns pop their
//             chest, revealing a multiplier that's applied to the
//             total spin payout. Multiple opened chests multiply.
//
// Spin sequence (mirrors the source game):
//   1. Reels spin → 15 random symbols.
//   2. Each Enchantment Book upgrades every pickaxe in its REEL
//      column to Enchanted (5 hits).
//   3. Pickaxes fall column-by-column, top-to-bottom, chipping the
//      top block of their column. Each block has a hit count and
//      an x-stake payout when broken.
//   4. After all pickaxes finish, every TNT on the reels drops and
//      explodes, dealing 2 damage to its column's top block + the
//      top blocks of the columns immediately to the left and right.
//   5. Any column whose blocks are all destroyed opens its chest;
//      the chest's multiplier is multiplied into the total spin
//      payout (multiple chests stack multiplicatively).
//   6. 3+ Eyes of Ender → free spins (handled in Stage 4).
//
// Server contract is the same as Plinko — start_round debits
// stake atomically, finish_round accepts the client's claimed
// total payout and caps it at stake × 5000 (matches the source
// game's 5000× max win).
//
// THIS FILE — STAGE 1
// Implements: reels, pickaxes, blocks, payouts, basic spin loop.
// Coming next: chests + TNT + Book → scatter + FS.
// ─────────────────────────────────────────────────────────────

const BETS = [10, 25, 50, 100, 250, 500, 1000, 2000, 4000, 8000, 16000, 25000]
const SLOT_ID = 'pixel-mine'

// ── Board geometry ──
const REEL_COLS = 5
const REEL_ROWS = 3
const GRID_COLS = 5
const GRID_ROWS = 7

// ── Pickaxe damage table (hits per pickaxe before it's spent) ──
const PICKAXE_HITS = {
  wood:      1,
  stone:     2,
  gold:      3,
  enchanted: 5,
}

// ── Block table — hit count + payout (× stake) when destroyed ──
// Hit-count + payout values cloned from Mine Slot's published
// paytable. Type names match the texture-file basenames in
// src/assets/games/pixel_mine/blocks/.
const BLOCKS = {
  grass:    { hits: 1, pay: 0    },
  dirt:     { hits: 1, pay: 0    },
  stone:    { hits: 2, pay: 0.1  },
  redstone: { hits: 4, pay: 1    },
  gold:     { hits: 5, pay: 3    },
  diamond:  { hits: 6, pay: 5    },
  obsidian: { hits: 7, pay: 25   },
}

// Per-column composition — every row rolls a weighted random tier
// each spin, so every column is a unique skyline. Most rows are
// "almost always" their dominant tier with a small slice of variety
// mixed in to keep the field fresh.
//
//   Row 1 (top):     grass    (always)
//   Row 2:           dirt 80 % │ stone 20 %                 ← rare stone surface
//   Row 3:           stone    (always)
//   Row 4:           redstone (always)
//   Row 5:           gold 70 │ diamond 25 │ redstone 5      ← rare redstone here
//   Row 6:           diamond 55 │ gold 30 │ obsidian 15
//   Row 7 (bottom):  obsidian 60 │ diamond 30 │ gold 10     (jackpot row)
const COLUMN_ROW_TABLES = [
  // Row 1 — grass surface
  [{ type: 'grass', weight: 100 }],
  // Row 2 — dirt with occasional stone outcrop
  [
    { type: 'dirt',  weight: 80 },
    { type: 'stone', weight: 20 },
  ],
  // Row 3 — stone bedrock
  [{ type: 'stone', weight: 100 }],
  // Row 4 — redstone band
  [{ type: 'redstone', weight: 100 }],
  // Row 5 — gold dominant, diamond minor, redstone rare
  [
    { type: 'gold',     weight: 70 },
    { type: 'diamond',  weight: 25 },
    { type: 'redstone', weight: 5  },
  ],
  // Row 6 — diamond dominant, gold mid, obsidian minor
  [
    { type: 'diamond',  weight: 55 },
    { type: 'gold',     weight: 30 },
    { type: 'obsidian', weight: 15 },
  ],
  // Row 7 — obsidian dominant, diamond second, gold rare
  [
    { type: 'obsidian', weight: 60 },
    { type: 'diamond',  weight: 30 },
    { type: 'gold',     weight: 10 },
  ],
]

// ── Reel symbol weights ──
// Tuned via scripts/pixel-mine-rtp-sim.js (5 M-spin Monte Carlo)
// to land long-run RTP at ≈ 94.3 %, just under the 95 % design
// ceiling. Tuned for the "stack-at-end" chest mechanic — every
// chest opened across trigger + bonus stacks one big multiplier
// chain on the cumulative raw win, so freq has to be tighter
// than under per-spin chest math.
//
// Wood + Stone pickaxes do most of the chipping; Gold and
// Enchanted are rarer but punchier; TNT + Book add surprise
// factor; Eye-of-Ender scatter at 1.52 fires the bonus ≈ 1 in
// 820 spins. Blanks fill the remainder so a single base spin
// can't flatten the field on its own.
const REEL_TABLE = [
  { sym: 'wood',      weight: 35,     kind: 'pickaxe' },
  { sym: 'stone_p',   weight: 18,     kind: 'pickaxe' },
  { sym: 'gold_p',    weight: 7.3,    kind: 'pickaxe' },
  { sym: 'enchanted', weight: 1.02,   kind: 'pickaxe' },
  { sym: 'tnt',       weight: 5.9,    kind: 'tnt'     },
  { sym: 'book',      weight: 1.65,   kind: 'book'    },
  { sym: 'ender',     weight: 1.52,   kind: 'scatter' },
  { sym: 'blank',     weight: 29.61,  kind: 'blank'   },
]
const REEL_TOTAL_W = REEL_TABLE.reduce((s, e) => s + e.weight, 0)

// Shorthand for the four pickaxe types — used by the upgrade pass.
const PICKAXE_KINDS = new Set(['wood', 'stone_p', 'gold_p', 'enchanted'])

// ── Chest multiplier table ──
// Each spin every chest rolls a random multiplier from this table.
// Cheaper mults are far more common; the 100× jackpot is a once-
// in-a-blue-moon thrill. Open chests multiply the spin's total
// payout (multiple chests stack multiplicatively).
const CHEST_MUL_TABLE = [
  { type: 2,   weight: 30 },
  { type: 3,   weight: 20 },
  { type: 4,   weight: 15 },
  { type: 5,   weight: 12 },
  { type: 10,  weight: 10 },
  { type: 25,  weight: 8  },
  { type: 50,  weight: 4  },
  { type: 100, weight: 1  },
]

function pickaxeHits(sym) {
  if (sym === 'wood')      return PICKAXE_HITS.wood
  if (sym === 'stone_p')   return PICKAXE_HITS.stone
  if (sym === 'gold_p')    return PICKAXE_HITS.gold
  if (sym === 'enchanted') return PICKAXE_HITS.enchanted
  return 0
}

// ── Helpers ──
function pickReelSymbol() {
  let r = Math.random() * REEL_TOTAL_W
  for (const e of REEL_TABLE) {
    r -= e.weight
    if (r < 0) return e.sym
  }
  return REEL_TABLE[REEL_TABLE.length - 1].sym
}

function generateReels() {
  const reels = []
  for (let r = 0; r < REEL_ROWS; r++) {
    const row = []
    for (let c = 0; c < REEL_COLS; c++) row.push(pickReelSymbol())
    reels.push(row)
  }
  return reels
}

// Free-Spins reel generator. Eye-of-Ender scatters can never
// appear inside the bonus — the FS run is sealed at exactly the
// 4 spins triggered. Any roll that would have been an ender is
// swapped to a `blank` so the symbol probabilities stay otherwise
// identical to the base game.
function generateReelsNoEnder() {
  const reels = generateReels()
  for (let r = 0; r < REEL_ROWS; r++) {
    for (let c = 0; c < REEL_COLS; c++) {
      if (reels[r][c] === 'ender') reels[r][c] = 'blank'
    }
  }
  return reels
}

// Count Eye of Ender scatters in a reel grid.
function countEnders(reels) {
  let n = 0
  for (let r = 0; r < REEL_ROWS; r++) {
    for (let c = 0; c < REEL_COLS; c++) {
      if (reels[r][c] === 'ender') n++
    }
  }
  return n
}

// Generate a normal-random reel grid GUARANTEED to contain at
// least `minEnders` Eye-of-Ender scatters. Used by Buy Bonus and
// the bonus-bet feature to force a trigger.
function generateReelsWithMinEnders(minEnders) {
  // Flat list of 15 cells, then reshape.
  const cells = []
  for (let i = 0; i < REEL_ROWS * REEL_COLS; i++) cells.push(pickReelSymbol())
  let enderCount = cells.filter(s => s === 'ender').length
  if (enderCount < minEnders) {
    // Pick random non-ender slots and overwrite them with enders
    // until we have the requested minimum.
    const slots = []
    for (let i = 0; i < cells.length; i++) if (cells[i] !== 'ender') slots.push(i)
    // Fisher-Yates shuffle the slot indices.
    for (let i = slots.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[slots[i], slots[j]] = [slots[j], slots[i]]
    }
    const need = minEnders - enderCount
    for (let n = 0; n < need; n++) cells[slots[n]] = 'ender'
  }
  const reels = []
  for (let r = 0; r < REEL_ROWS; r++) {
    reels.push(cells.slice(r * REEL_COLS, (r + 1) * REEL_COLS))
  }
  return reels
}

// Weighted picker for [{type, weight}] tables.
function pickWeightedType(table) {
  const total = table.reduce((s, e) => s + e.weight, 0)
  let r = Math.random() * total
  for (const e of table) {
    r -= e.weight
    if (r < 0) return e.type
  }
  return table[table.length - 1].type
}

// Generate one column as a top→bottom array of block types. EVERY
// row rolls a weighted random tier from COLUMN_ROW_TABLES, so each
// column is a unique skyline. Single-entry tables (rows 1, 3, 4)
// always pick the same tier — the helper handles them naturally.
function generateColumn() {
  return COLUMN_ROW_TABLES.map(table => pickWeightedType(table))
}

// Build a fresh chest row — one entry per column, each with a
// random multiplier and `open: false`. Re-rolled at the start of
// every spin (chests don't persist between spins in base game).
function generateChests() {
  return Array.from({ length: GRID_COLS }, () => ({
    mul:  pickWeightedType(CHEST_MUL_TABLE),
    open: false,
  }))
}

// Build a fresh 5 × 7 grid of blocks with each cell tracking its
// remaining hit count. The grid is laid out [row][col]; we
// generate per-column then transpose so each column has its own
// independent random skyline.
function generateGrid() {
  // First build columns top→bottom, then flip to row-major.
  const cols = []
  for (let c = 0; c < GRID_COLS; c++) cols.push(generateColumn())
  const grid = []
  for (let r = 0; r < GRID_ROWS; r++) {
    const row = []
    for (let c = 0; c < GRID_COLS; c++) {
      const type = cols[c][r]
      row.push({ type, hp: BLOCKS[type].hits })
    }
    grid.push(row)
  }
  return grid
}

// Top live block of a column = topmost row whose cell has hp > 0.
// Returns row index, or -1 if column is fully cleared.
function topBlockRow(grid, col) {
  for (let r = 0; r < GRID_ROWS; r++) {
    if (grid[r][col] && grid[r][col].hp > 0) return r
  }
  return -1
}

// Apply the Enchantment Book upgrade pass: any column on the reels
// that contains a 'book' upgrades EVERY pickaxe in that column
// (across all 3 reel rows) to enchanted. Multiple books in the same
// column have the same effect — they're already at 'enchanted'.
function applyBookUpgrades(reels) {
  const upgraded = reels.map(row => row.slice())
  for (let c = 0; c < REEL_COLS; c++) {
    let hasBook = false
    for (let r = 0; r < REEL_ROWS; r++) {
      if (upgraded[r][c] === 'book') { hasBook = true; break }
    }
    if (!hasBook) continue
    for (let r = 0; r < REEL_ROWS; r++) {
      const s = upgraded[r][c]
      if (PICKAXE_KINDS.has(s)) upgraded[r][c] = 'enchanted'
    }
  }
  return upgraded
}

// Simple sleep helper for chained animations.
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const MIN_BALANCE_RUB = 10

// ─────────────────────────────────────────────────────────────
// React component
// ─────────────────────────────────────────────────────────────
export default function PixelMineSlot() {
  const navigate = useNavigate()
  const { balance, currency, rates, lang, user, setBalance, setBalanceBounce } =
    useGameStore(useShallow(s => ({
      balance: s.balance, currency: s.currency, rates: s.rates, lang: s.lang,
      user: s.user, setBalance: s.setBalance, setBalanceBounce: s.setBalanceBounce,
    })))
  const t = translations[lang] ?? translations.ru

  const initialStake = useMemo(() => {
    const defaults = [50, 25, 10]
    for (const v of defaults) if (balance >= v) return v
    return BETS[0]
  }, [])

  const [stake, setStake]             = useState(initialStake)
  // 5×3 board of symbols (reel results) — kept blank between spins.
  const [reels, setReels]             = useState(() => Array.from({ length: REEL_ROWS }, () =>
                                          Array.from({ length: REEL_COLS }, () => 'blank')))
  // While a spin is rolling, each cell is a 4-symbol vertical
  // strip that scrolls top-to-bottom via CSS transform. `null`
  // when not rolling — that's when we render the static `reels`
  // grid above.
  const [reelStrips, setReelStrips]   = useState(null)
  // 5×7 grid of {type, hp} blocks. Reset each base spin.
  const [grid, setGrid]               = useState(() => generateGrid())
  // Cell currently being chipped (visual highlight). { r, c } | null
  const [activeBlock, setActiveBlock] = useState(null)
  // Pickaxe currently in flight as a falling sprite. Keyed so React
  // remounts the element each drop and the keyframe restarts.
  const [flyingPickaxe, setFlyingPickaxe] = useState(null) // {key, sym, col, fromReelRow}
  // TNT currently mid-explosion: falling → fuse → expand → boom.
  // Has its own state because it doesn't spin like a pickaxe and
  // goes through three distinct animation phases.
  const [flyingTnt, setFlyingTnt]         = useState(null) // {key, col, ty, td, ease, phase}
  // Active explosion overlay (radial blast cloud + cell shake).
  // null when no TNT is currently going off.
  const [explodingTnt, setExplodingTnt]   = useState(null) // {key, col, row}
  // While the Enchantment Book is doing its upgrade pass: column
  // with the active book (everything else dims out), and the
  // single cell currently mid-transformation (flash + swap to
  // Enchanted pickaxe).
  const [bookActiveCol, setBookActiveCol] = useState(null) // number | null
  const [bookFlashCell, setBookFlashCell] = useState(null) // {row, col} | null
  // 5 chests — one per column. Each holds a random multiplier
  // and an `open` flag. Re-rolled at the start of every base spin
  // (FS iterations REUSE the trigger spin's chests).
  //
  // chestsRef shadows the state so the spin pipeline can read the
  // current chests synchronously across awaits — avoids stale
  // closures when multiple FS spins fire one after another.
  const [chests, setChests]               = useState(() => generateChests())
  const chestsRef                          = useRef(chests)
  // Buy-Bonus confirmation modal — `true` when the user has
  // tapped the Buy Bonus FAB but hasn't confirmed yet.
  const [buyBonusConfirm, setBuyBonusConfirm] = useState(false)
  // Free-Spins bonus state.
  //   bonusActive    : are we currently in the FS sequence?
  //   bonusSpinsLeft : remaining free spins in the FS run
  //   bonusOverlay   : animated full-stage announcement, either
  //                    {kind:'intro', spins} on entry or
  //                    {kind:'end',   total} when the bonus closes.
  const [bonusActive, setBonusActive]     = useState(false)
  const [bonusSpinsLeft, setBonusSpinsLeft] = useState(0)
  const [bonusOverlay, setBonusOverlay]   = useState(null)

  // Spin lifecycle phase. 'idle' is the only state that allows a new
  // spin click; everything else locks the controls.
  const [phase, setPhase]             = useState('idle')
  const [autoSpin, setAutoSpin]       = useState(false)
  const [lastWin, setLastWin]         = useState(0)
  const [exitConfirm, setExitConfirm] = useState(false)
  const [finalizing, setFinalizing]   = useState(false)

  const balanceRef       = useRef(balance)
  const stakeRef         = useRef(stake)
  const autoRef          = useRef(autoSpin)
  const cancelRef        = useRef(false)
  const finalizingRef    = useRef(false)
  const currentRoundRef  = useRef(null)

  useEffect(() => { balanceRef.current = balance },   [balance])
  useEffect(() => { stakeRef.current   = stake },     [stake])
  useEffect(() => { autoRef.current    = autoSpin },  [autoSpin])
  useEffect(() => { chestsRef.current  = chests },    [chests])
  useEffect(() => () => { cancelRef.current = true }, [])

  // ── Telegram BackButton ──
  useEffect(() => {
    const tg = window.Telegram?.WebApp
    if (!tg) return
    tg.BackButton.show()
    const back = () => {
      haptic('light')
      const busy = phase !== 'idle' || autoSpin || finalizing
      if (busy) setExitConfirm(true)
      else navigate('/')
    }
    tg.BackButton.onClick(back)
    return () => { tg.BackButton.offClick(back); tg.BackButton.hide() }
  }, [navigate, phase, autoSpin, finalizing])

  function confirmExit() {
    haptic('medium')
    cancelRef.current = true
    setAutoSpin(false); autoRef.current = false
    setExitConfirm(false)
    navigate('/')
  }

  const stakeIndex = BETS.indexOf(stake)
  const canAfford  = balance >= stake
  const isBusy     = phase !== 'idle' || autoSpin || finalizing

  function changeStake(direction) {
    if (isBusy) return
    const ni = Math.max(0, Math.min(BETS.length - 1, stakeIndex + direction))
    if (ni === stakeIndex) return
    if (direction > 0 && BETS[ni] > balance) return
    haptic('light')
    setStake(BETS[ni])
  }

  // Auto-clamp stake when balance drops (manual mode only).
  useEffect(() => {
    if (autoSpin) return
    if (stake <= balance) return
    for (let i = BETS.length - 1; i >= 0; i--) {
      if (BETS[i] <= balance) { setStake(BETS[i]); return }
    }
  }, [balance, stake, autoSpin])

  // ── Animation: one pickaxe falls + chips one block, bouncing
  // between hits ──
  //
  // ty is in "row units" of the GRID — translateY(N * 100%) where
  // the sprite height equals one grid row.
  //   ty = 0           → pickaxe sits ON top of grid row 0
  //   ty = r - 1       → pickaxe sits ABOVE block r (its bottom
  //                       edge meets block r's top edge — this is
  //                       the "hit point").
  //   ty negative      → pickaxe is ABOVE the grid entirely.
  //
  // Initial spawn is calculated from the reel-cell position so the
  // pickaxe LITERALLY drops out of where its reel cell is. Reels
  // sit ~3 row-heights + a half-row of gap above the grid:
  //
  //   ty_start = -(REEL_ROWS - reelRow + 0.5)
  //
  // The artist-supplied REEL_ROWS = 3, so:
  //   reelRow 0 (top reel)    → ty_start ≈ -3.5
  //   reelRow 1 (mid reel)    → ty_start ≈ -2.5
  //   reelRow 2 (bottom reel) → ty_start ≈ -1.5
  //
  // We also clear the source reel cell to 'blank' the moment the
  // pickaxe leaves so the visual reads as "the pickaxe fell out
  // of its slot".
  async function dropPickaxeFromReel(symbol, reelRow, col, currentGrid, currentStake) {
    if (cancelRef.current) return { grid: currentGrid, added: 0 }

    let hitsLeft = pickaxeHits(symbol)
    if (hitsLeft <= 0) return { grid: currentGrid, added: 0 }

    let g = currentGrid.map(row => row.slice())
    let added = 0
    const baseKey = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

    // Initial spawn — pickaxe appears at its reel cell (visually
    // overlaps that reel slot for 1 frame), no transition.
    const tyStart = -(REEL_ROWS - reelRow + 0.5)
    setFlyingPickaxe({
      key: baseKey, sym: symbol, col,
      ty: tyStart,
      td: 0,                // no transition on mount
      ease: 'ease-in',
      opacity: 1,
    })
    // Empty the reel cell — the pickaxe has "fallen out" of it.
    setReels(prev => {
      const next = prev.map(row => row.slice())
      if (next[reelRow]) next[reelRow][col] = 'blank'
      return next
    })
    await sleep(50)

    while (hitsLeft > 0) {
      if (cancelRef.current) break
      const r = topBlockRow(g, col)
      if (r < 0) break
      const cell = g[r][col]

      // Drop — pickaxe falls from its current position down to land
      // on TOP of block r. ease-in so it feels like gravity.
      setFlyingPickaxe(p => ({ ...p, ty: r - 1, td: 200, ease: 'cubic-bezier(0.4, 0, 1, 0.6)' }))
      await sleep(200)
      if (cancelRef.current) break

      // ── ONE strike = ONE damage point ──
      // Damage applies the INSTANT the pickaxe touches the block,
      // and the pickaxe bounces back up immediately afterwards.
      // Stone pickaxe (2 hits) hitting a Stone block (2 HP) takes
      // two separate drop+bounce cycles — between the cycles the
      // damage texture (1) is visible.
      hitsLeft -= 1
      setActiveBlock({ r, c: col })
      g[r][col] = { ...cell, hp: cell.hp - 1 }
      setGrid(g.map(row => row.slice()))
      haptic('light')

      if (g[r][col].hp <= 0) {
        // Destroyed — payout, clear cell, and skip the
        // damage-frame hold (there's no damage frame on a
        // destroyed cell). Falls straight through to the bounce.
        const blockPay = BLOCKS[cell.type].pay * currentStake
        added += blockPay
        if (blockPay > 0) {
          setLastWin(prev => Math.round(prev + blockPay))
          setBalanceBounce(true)
          setTimeout(() => setBalanceBounce(false), 240)
        }
        g[r][col] = null
        setGrid(g.map(row => row.slice()))
        haptic('medium')
      } else {
        // Damaged but alive — short hold so the new damage frame
        // is visibly different from the previous frame before the
        // pickaxe rises for the next strike.
        await sleep(110)
      }
      setActiveBlock(null)

      if (hitsLeft <= 0 || cancelRef.current) break

      // Bounce up one row above the hit point — ty: r - 2 — so
      // the next strike has visible space to fall from.
      const bounceTy = r - 2
      setFlyingPickaxe(p => ({ ...p, ty: bounceTy, td: 140, ease: 'cubic-bezier(0, 0.5, 0.4, 1)' }))
      await sleep(140)
    }

    // Pickaxe consumed — fade out at its last position.
    setFlyingPickaxe(p => p ? { ...p, opacity: 0, td: 160, ease: 'ease' } : null)
    await sleep(170)
    setFlyingPickaxe(null)
    return { grid: g, added }
  }

  // ── TNT lifecycle ──
  //
  //   1. Drop  — TNT falls from its reel cell to land on top of the
  //              column's topmost block (or to the grid floor if the
  //              column has been fully cleared by pickaxes). NO
  //              rotation — TNT is a crate, not a tool.
  //   2. Fuse  — brief pulse-pause (~350 ms). Visually the brick
  //              brightens-and-pulses to read as the fuse burning.
  //   3. Expand — TNT scales up ~50 % in 160 ms (the "flash before
  //              the bang" beat).
  //   4. BOOM  — fixed 3-column × 3-row blast centred on the TNT's
  //              own resting cell (which sits one row above the top
  //              block of its column). Every block inside that 3×3
  //              window takes 2 HP of damage. Destroyed blocks pay
  //              out and clear instantly.
  //
  //              IMPORTANT — this is a 3×3 area blast (matches the
  //              published Mine Slot mechanic), NOT a "top block of
  //              each column" hit. Implication:
  //                - In TNT's own column, only its top block is hit
  //                  (rows above are empty by definition).
  //                - In adjacent columns it depends on their state:
  //                  if a neighbour is less mined than the TNT
  //                  column, multiple blocks of that neighbour can
  //                  fall inside the 3×3 zone and all take damage;
  //                  if a neighbour is more mined, its top block
  //                  may sit BELOW the 3×3 zone and survive intact.
  //
  //              The RTP simulator (scripts/pixel-mine-rtp-sim.js)
  //              uses the same geometry — keep them in sync.
  //
  //              The flash holds for ~450 ms then fades.
  async function explodeTntFromReel(reelRow, col, currentGrid, currentStake) {
    if (cancelRef.current) return { grid: currentGrid, added: 0 }

    let g = currentGrid.map(row => row.slice())
    let added = 0

    const targetRow = topBlockRow(g, col)
    // If the column is fully cleared, TNT lands at the grid floor
    // (just above the chests). The visual still looks fine because
    // the explosion radius reaches the side columns anyway.
    const landingRow = targetRow >= 0 ? targetRow : GRID_ROWS

    const baseKey = `tnt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

    // Step 1 — initial mount at the reel cell, no transition.
    const tyStart = -(REEL_ROWS - reelRow + 0.5)
    setFlyingTnt({
      key: baseKey, col,
      ty: tyStart, td: 0, ease: 'linear',
      phase: '',
    })
    // Empty the source reel cell — the brick has fallen out.
    setReels(prev => {
      const next = prev.map(row => row.slice())
      if (next[reelRow]) next[reelRow][col] = 'blank'
      return next
    })
    await sleep(60)
    if (cancelRef.current) { setFlyingTnt(null); return { grid: g, added } }

    // Step 1b — drop down to land on top of the target block.
    setFlyingTnt(p => ({ ...p, ty: landingRow - 1, td: 280, ease: 'cubic-bezier(0.4, 0, 1, 0.6)' }))
    await sleep(280)
    if (cancelRef.current) { setFlyingTnt(null); return { grid: g, added } }

    // Step 2 — fuse pulse for ~350 ms. The CSS class "fuse" runs a
    // brightness + scale alternating pulse on the sprite.
    setFlyingTnt(p => ({ ...p, phase: 'fuse' }))
    haptic('light')
    await sleep(350)
    if (cancelRef.current) { setFlyingTnt(null); return { grid: g, added } }

    // Step 3 — expand briefly before detonating.
    setFlyingTnt(p => ({ ...p, phase: 'expand' }))
    await sleep(160)
    if (cancelRef.current) { setFlyingTnt(null); return { grid: g, added } }

    // Step 4 — BOOM. Remove the brick sprite, mount the explosion
    // overlay, apply damage to the TOP block of self + adjacent
    // columns.
    setFlyingTnt(null)
    // Centre the blast overlay on the TNT's own visual position
    // (one row above the top block) so the cloud lines up with
    // the same 3 × 3 area we're applying damage to.
    setExplodingTnt({
      key: `boom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      col, row: landingRow - 1,
    })
    haptic('heavy')

    // 3 × 3 blast radius CENTRED ON THE TNT ITSELF — TNT visually
    // sits at row (landingRow - 1), one above the top block of its
    // column. So the 3 × 3 around TNT covers:
    //
    //   row landingRow-2 │ NW │ N │ NE │  ← rarely has blocks
    //   row landingRow-1 │  W │TNT│  E │  ← TNT's own row
    //   row landingRow   │ SW │ S │ SE │  ← top-block row → main hits
    //
    // Cells outside the grid bounds and already-empty cells are
    // ignored. With this geometry, the centre column only takes
    // damage on row landingRow (one block deep), NOT two.
    const centerRow = landingRow - 1
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const r = centerRow + dr
        const c = col + dc
        if (r < 0 || r >= GRID_ROWS) continue
        if (c < 0 || c >= GRID_COLS) continue
        const cell = g[r][c]
        if (!cell) continue
        const damage = Math.min(2, cell.hp)
        g[r][c] = { ...cell, hp: cell.hp - damage }
        if (g[r][c].hp <= 0) {
          const blockPay = BLOCKS[cell.type].pay * currentStake
          added += blockPay
          if (blockPay > 0) {
            setLastWin(prev => Math.round(prev + blockPay))
            setBalanceBounce(true)
            setTimeout(() => setBalanceBounce(false), 240)
          }
          g[r][c] = null
        }
      }
    }
    setGrid(g.map(row => row.slice()))

    // Hold the blast cloud, then unmount.
    await sleep(450)
    setExplodingTnt(null)
    return { grid: g, added }
  }

  // ── Animation: fill the mining grid BOTTOM-UP, smoothly ──
  // Starts with an empty grid; reveals rows from row GRID_ROWS-1
  // (bottom — obsidian/jackpot row, sitting on the ground) up to
  // row 0 (top — grass / surface). Each row reveal pauses long
  // enough that the player can see the column "build up" like
  // Minecraft chunks loading.
  async function fillGridAnimated(targetGrid) {
    if (cancelRef.current) return
    setGrid(Array.from({ length: GRID_ROWS }, () => Array(GRID_COLS).fill(null)))
    await sleep(80)
    for (let r = GRID_ROWS - 1; r >= 0; r--) {
      if (cancelRef.current) return
      setGrid(prev => {
        const next = prev.map(row => row.slice())
        next[r] = targetGrid[r].map(cell => cell ? { ...cell } : null)
        return next
      })
      await sleep(140)
    }
    await sleep(200)
  }

  // ── Animation: slot-machine reel scroll
  //
  // Each cell becomes a 4-symbol vertical "strip" that scrolls
  // smoothly TOP → BOTTOM. The strip is laid out (top → bottom):
  //
  //   [final, mid2, mid1, start]
  //
  // Initial transform: translateY(-75 %) — showing `start` at the
  // bottom of the strip (the cell's viewport sees the strip's
  // bottom-most symbol). The animation runs translateY from -75 %
  // to 0 % over the cell's stopTime ms; as the strip slides DOWN,
  // start exits at the bottom, mid1 → mid2 pass through, and
  // `final` arrives at the top and locks.
  //
  // Cells stop in order: col 0 first (top to bottom), then col 1,
  // etc. — same cadence as the reference Mine Slot.
  async function spinReelsAnimated(finalReels) {
    const symChoices = REEL_TABLE.map(e => e.sym).filter(s => s !== 'blank')
    function pickRandomSlotSymbol() {
      // ~35 % of the strip slots are blank inventory cells — the
      // reel passes through empty slots just like a real one.
      if (Math.random() < 0.35) return 'blank'
      return symChoices[Math.floor(Math.random() * symChoices.length)]
    }

    // ── Per-column sequential start ──
    // Columns spin one after the other: col 0 kicks off first,
    // col 1 starts ~COL_START_GAP ms later, and so on. Each cell
    // takes ~CELL_SPIN_MS to roll through the strip, with a small
    // top-to-bottom stagger inside each column so the row 0 cell
    // settles a hair before row 1, row 1 before row 2.
    const COL_START_GAP = 220   // ms between consecutive columns starting
    const CELL_SPIN_MS  = 520   // base time for one cell to scroll through the strip
    const ROW_STAGGER   = 80    // extra ms each row down adds to that

    // Build per-cell strip data once. The bottom-most slot
    // (`start`) is always BLANK — that's what the player sees
    // BEFORE the cell starts rolling. As the strip slides down,
    // mid1 and mid2 (random) pass through, then `final` settles
    // at the top.
    const strips = Array.from({ length: REEL_ROWS }, (_, r) =>
      Array.from({ length: REEL_COLS }, (_, c) => ({
        start: 'blank',
        mid1:  pickRandomSlotSymbol(),
        mid2:  pickRandomSlotSymbol(),
        final: finalReels[r][c],
      }))
    )

    // Phase 1 — render every strip parked at translateY(-75 %)
    // (showing the bottom-most "start" symbol), no transition.
    setReelStrips(strips.map(row => row.map(cell => ({
      ...cell,
      ty: -75,
      td: 0,
      ease: 'linear',
    }))))
    await sleep(60)
    if (cancelRef.current) return

    // Phase 2 — kick each column off in turn. Within a column,
    // every cell starts at the same instant but the row-stagger
    // makes the top row settle slightly earlier than the bottom.
    for (let c = 0; c < REEL_COLS; c++) {
      if (cancelRef.current) return
      setReelStrips(prev => prev.map((row, r) => row.map((cell, cc) => {
        if (cc !== c) return cell
        return {
          ...cell,
          ty: 0,
          td: CELL_SPIN_MS + r * ROW_STAGGER,
          ease: 'cubic-bezier(0.15, 0.7, 0.2, 1)',
        }
      })))
      if (c < REEL_COLS - 1) await sleep(COL_START_GAP)
    }

    // Wait for the LAST column's bottom cell to finish.
    const lastDuration = CELL_SPIN_MS + (REEL_ROWS - 1) * ROW_STAGGER
    await sleep(lastDuration + 80)
    if (cancelRef.current) return

    // Tear down the strips and restore the static `reels` state
    // so the post-spin pickaxe-drop loop can read finalReels[r][c].
    setReels(finalReels)
    setReelStrips(null)
  }

  // ── Enchantment Book pre-pass ──
  //
  // Runs AFTER the reel spin lands but BEFORE the pickaxes drop.
  // For every column that contains a Book symbol:
  //   1. All OTHER columns dim out (filter:brightness/saturate
  //      via .is-dimmed class).
  //   2. Each Pickaxe cell in the book's column flashes (cyan/
  //      purple radial burst) and swaps texture to Enchanted.
  //   3. Brief hold, then move to the next book column.
  // After the last book column: dim clears, and the upgraded reel
  // grid is returned for the pickaxe-drop loop.
  async function applyBookAnimations(rawReels) {
    // Find which columns contain at least one Book.
    const bookCols = []
    for (let c = 0; c < REEL_COLS; c++) {
      for (let r = 0; r < REEL_ROWS; r++) {
        if (rawReels[r][c] === 'book') { bookCols.push(c); break }
      }
    }
    if (bookCols.length === 0) return rawReels
    if (cancelRef.current) return rawReels

    const upgraded = rawReels.map(row => row.slice())

    for (const col of bookCols) {
      if (cancelRef.current) break

      // Step 1 — dim every column except this one.
      setBookActiveCol(col)
      haptic('medium')
      await sleep(420)
      if (cancelRef.current) break

      // Step 2 — for each pickaxe in this column, do a flash +
      // swap. Skip cells that are already enchanted (no-op) and
      // non-pickaxe cells (TNT, ender, blank, the book itself).
      for (let r = 0; r < REEL_ROWS; r++) {
        if (cancelRef.current) break
        const sym = upgraded[r][col]
        if (!PICKAXE_KINDS.has(sym) || sym === 'enchanted') continue

        setBookFlashCell({ row: r, col })
        haptic('light')
        await sleep(140)              // flash burst expands
        if (cancelRef.current) break

        // Swap texture mid-flash so the burst hides the moment
        // of replacement.
        upgraded[r][col] = 'enchanted'
        setReels(upgraded.map(row => row.slice()))
        await sleep(180)              // flash continues + fades
      }
      setBookFlashCell(null)

      // Step 3 — brief hold so the upgraded column reads before
      // moving on / clearing the dim state.
      await sleep(280)
    }

    setBookActiveCol(null)
    return upgraded
  }

  // ── runSpinPhases ──
  // Runs the complete in-spin sequence on a given grid + reel
  // layout. Used both for the trigger spin (with grid fill) and
  // for every Free-Spin iteration (no fill — the FS grid persists
  // from the previous spin). Returns the updated grid + total
  // payout from THIS spin (cluster wins + chest multipliers
  // already applied per opened chest).
  //
  // Steps:
  //   1. Reel spin animation (with fill grid in parallel if asked)
  //   2. Book pre-pass (dim + flash → upgrade pickaxes)
  //   3. Pickaxe drop loop (per column, top-to-bottom)
  //   4. TNT explosion loop (per column)
  //   5. Chest opening for any column whose blocks all cleared
  async function runSpinPhases(g, rawReels, { fillGrid, gridForFill }) {
    if (cancelRef.current) return { grid: g, win: 0, finalReels: rawReels }

    // 1 — reel spin (and optional grid fill in parallel).
    if (fillGrid) {
      await Promise.all([
        fillGridAnimated(gridForFill),
        spinReelsAnimated(rawReels),
      ])
    } else {
      await spinReelsAnimated(rawReels)
    }
    if (cancelRef.current) return { grid: g, win: 0, finalReels: rawReels }

    // 2 — book pre-pass; returns the upgraded reels for use below.
    const finalReels = await applyBookAnimations(rawReels)
    if (cancelRef.current) return { grid: g, win: 0, finalReels }

    let win = 0

    // 3 — pickaxe drops.
    setPhase('mining')
    for (let c = 0; c < REEL_COLS; c++) {
      for (let r = 0; r < REEL_ROWS; r++) {
        const sym = finalReels[r][c]
        if (!PICKAXE_KINDS.has(sym)) continue
        const out = await dropPickaxeFromReel(sym, r, c, g, stakeRef.current)
        g = out.grid
        win += out.added
        if (cancelRef.current) return { grid: g, win, finalReels }
      }
    }

    // 4 — TNT explosions.
    setPhase('exploding')
    for (let c = 0; c < REEL_COLS; c++) {
      for (let r = 0; r < REEL_ROWS; r++) {
        const sym = finalReels[r][c]
        if (sym !== 'tnt') continue
        const out = await explodeTntFromReel(r, c, g, stakeRef.current)
        g = out.grid
        win += out.added
        if (cancelRef.current) return { grid: g, win, finalReels }
      }
    }

    // 5 — chest detection (visuals + multiplier MATH are deferred).
    //
    // We mark any column that just cleared in chestsRef.current
    // (truth state used to prevent double-counting across spins),
    // but we DO NOT pop the chest visually here, and we DO NOT
    // multiply this spin's win. The caller batches every chest
    // open across the whole bonus / single base spin and applies
    // the multipliers as one chained pop sequence at the end.
    //
    // This matches the "all multipliers applied to the cumulative
    // raw win at the end" mechanic — chests stack into one big
    // payout reveal, not piecewise per spin.
    const clearedCols = []
    for (let c = 0; c < GRID_COLS; c++) {
      let cleared = true
      for (let r = 0; r < GRID_ROWS; r++) {
        if (g[r][c]) { cleared = false; break }
      }
      if (cleared) clearedCols.push(c)
    }
    const pendingChestOpens = []
    if (clearedCols.length > 0) {
      const currentChests = chestsRef.current
      const nextChests = currentChests.map(c => ({ ...c }))
      for (const col of clearedCols) {
        if (!nextChests[col].open) {
          nextChests[col].open = true
          pendingChestOpens.push({ col, mul: nextChests[col].mul })
        }
      }
      if (pendingChestOpens.length > 0) {
        // Truth state moves forward immediately; visual state stays
        // closed until the caller runs the reveal sequence.
        chestsRef.current = nextChests
      }
    }

    return { grid: g, win, finalReels, pendingChestOpens }
  }

  // ── revealChestsSequential ──
  // Pops every pending chest one at a time, multiplying the
  // running cumulative win by that chest's multiplier and bumping
  // the on-screen win counter as the reveal lands.
  //
  //   opens          — [{col, mul}, ...] in detection order
  //   startingWin    — sum of pickaxe + TNT raw payouts (no chest
  //                    mults applied yet) over the spin or bonus.
  //   onRunningChange — receives the new cumulative win after each
  //                    chest pop, so the caller can keep its own
  //                    running total in sync (used for the
  //                    server-side cap + final balance bump).
  //
  // Returns the final cumulative win after every chest is opened.
  async function revealChestsSequential(opens, startingWin, onRunningChange) {
    let running = startingWin
    for (const { col, mul } of opens) {
      if (cancelRef.current) break
      // 1. Pop this chest in React state — drives the bounce/pop.
      setChests(prev => {
        const next = prev.map(c => ({ ...c }))
        next[col].open = true
        return next
      })
      // 2. Multiply the running total — the lastWin display jumps
      //    up to the new cumulative figure as the chest lands.
      running = Math.round(running * mul)
      if (typeof onRunningChange === 'function') onRunningChange(running)
      setLastWin(running)
      setBalanceBounce(true)
      setTimeout(() => setBalanceBounce(false), 360)
      haptic('success')
      await sleep(580)
    }
    return running
  }

  // ── One full spin: server start → reel result → process pickaxes
  // by column → settle → server finish ──
  async function spin(opts = {}) {
    const { isBuyBonus = false, forceEnders: forceEndersOpt = false } = opts
    if (cancelRef.current) return
    if (phase !== 'idle') return
    if (finalizingRef.current) return
    if (balanceRef.current < stakeRef.current) {
      setAutoSpin(false); autoRef.current = false
      return
    }

    setPhase('spinning')
    setLastWin(0)
    setActiveBlock(null)
    setFlyingPickaxe(null)
    setFlyingTnt(null)
    setExplodingTnt(null)
    // Clear the reels to blank IMMEDIATELY on spin start so the
    // previous round's final symbols don't flash for a frame
    // before the rolling strips mount.
    setReels(Array.from({ length: REEL_ROWS }, () => Array(REEL_COLS).fill('blank')))
    haptic('light')

    // ── Cost ──
    // Normal spin = 1 × stake. Buy Bonus = 100 × stake (paid up
    // front to guarantee a 3-Eye-of-Ender trigger). Server-side
    // start_pixel_mine_round still gets called with `stake` because
    // we don't have a buy-bonus RPC yet — for real-money users the
    // extra 99 × stake is debited client-side here as a hold; this
    // would be replaced with a proper start_buy_bonus RPC when we
    // wire the server side.
    const baseStake = stakeRef.current
    const cost      = isBuyBonus ? baseStake * 100 : baseStake
    if (balanceRef.current < cost) {
      setAutoSpin(false); autoRef.current = false
      setPhase('idle')
      return
    }

    // Server round.
    const isDev = !user || user.id === 'dev'
    let round
    if (isDev) {
      const next = balanceRef.current - cost
      balanceRef.current = next
      setBalance(next)
      round = { ok: true, round_id: `dev-${Date.now()}-${Math.random().toString(36).slice(2,8)}`, balance: next }
    } else {
      // The server RPC handles BOTH normal (1× stake) and buy-bonus
      // (100× stake) debits atomically — we just pass the flag.
      const res = await startPixelMineRound(user.id, baseStake, isBuyBonus)
      if (cancelRef.current) return
      if (!res || res.error || !res.ok) {
        console.error('startPixelMineRound failed:', res)
        setAutoSpin(false); autoRef.current = false
        setPhase('idle')
        return
      }
      round = res
      setBalance(round.balance)
      balanceRef.current = round.balance
    }
    currentRoundRef.current = round

    // ── Decide the trigger-spin reel layout ──
    let rawReels
    if (forceEndersOpt) {
      // Buy Bonus (or bonus-bet) — guarantee at least 3 Eye-of-
      // Ender scatters so the trigger spin always activates the
      // free-spins bonus.
      rawReels = generateReelsWithMinEnders(3)
    } else {
      rawReels = generateReels()
    }
    const targetGrid = generateGrid()
    // Re-roll the chests with fresh multipliers — each base spin
    // gets its own loadout. (FS iterations REUSE the chests from
    // the trigger spin; they're not regenerated below.)
    // Update the ref synchronously too so step 5 can read the new
    // loadout without waiting for the useEffect tick.
    const freshChests = generateChests()
    chestsRef.current = freshChests
    setChests(freshChests)

    // Working grid copy — the source of truth for damage tracking.
    let g = targetGrid.map(row => row.map(cell => cell ? { ...cell } : null))

    // ── Trigger spin: full pipeline including grid fill ──
    // runSpinPhases now returns RAW spin win (pickaxes + TNT only,
    // no chest mults applied) plus the list of chests that just
    // cleared. Chest mults are applied at the end via one big
    // sequential reveal that multiplies the cumulative raw win.
    let result = await runSpinPhases(g, rawReels, {
      fillGrid: true,
      gridForFill: targetGrid,
    })
    if (cancelRef.current) return
    g = result.grid
    let cumulativeRaw = result.win
    const triggerReels = result.finalReels
    const pendingOpens = (result.pendingChestOpens || []).slice()

    // ── Free-Spins bonus trigger ──
    // 3+ Eye-of-Ender scatters on the trigger spin → 4 free spins
    // on the SAME GRID (no reset). After the announcement overlay,
    // each FS runs the same phase pipeline minus the grid fill.
    const enderCount = countEnders(triggerReels)
    let isBonus = enderCount >= 3
    if (isBonus) {
      const FS_TOTAL = 4
      // Intro overlay — "FREE SPINS / 4" big-pop reveal.
      setBonusOverlay({ kind: 'intro', spins: FS_TOTAL })
      haptic('success')
      await sleep(2400)
      setBonusOverlay(null)
      if (cancelRef.current) return

      setBonusActive(true)
      for (let i = 0; i < FS_TOTAL; i++) {
        if (cancelRef.current) break
        // Counter shows REMAINING spins after this one — so the
        // first FS spin shows (FS_TOTAL - 1), the last shows 0.
        setBonusSpinsLeft(FS_TOTAL - 1 - i)
        // FS reels — `generateReelsNoEnder` strips Eye-of-Ender
        // scatters (mapped to `blank`) so a bonus can never
        // re-trigger inside itself. The 4 free spins are sealed.
        const fsRawReels = generateReelsNoEnder()
        const fsResult = await runSpinPhases(g, fsRawReels, { fillGrid: false })
        if (cancelRef.current) break
        g = fsResult.grid
        cumulativeRaw += fsResult.win
        if (fsResult.pendingChestOpens?.length) {
          pendingOpens.push(...fsResult.pendingChestOpens)
        }
        await sleep(280)             // breath between free spins
      }
      setBonusActive(false)
      setBonusSpinsLeft(0)
    }

    // ── Chest reveal ──
    // Trigger spin (no FS): reveal at the end of this spin.
    // Bonus path: reveal AFTER all FS finish, BEFORE the bonus-end
    // overlay — every chest that opened anywhere across the
    // trigger + 4 FS pops one by one and multiplies the
    // cumulative raw win.
    let totalWin = cumulativeRaw
    if (pendingOpens.length > 0) {
      totalWin = await revealChestsSequential(pendingOpens, cumulativeRaw)
    }

    if (isBonus) {
      // Bonus-end overlay — totals up the bonus payout (cumulative
      // raw + chest mults). For the "end" card we show the bonus
      // contribution = totalWin - (whatever the trigger raw was),
      // but since chest mults stack across the whole bonus we just
      // show totalWin as the bonus total (matches what the player
      // is now holding from this round).
      setBonusOverlay({ kind: 'end', total: totalWin })
      await sleep(2200)
      setBonusOverlay(null)
    }

    // Cap the locally-claimed total at the server's hard cap so we
    // don't show a number we'll have to walk back at finalize.
    const localCap = baseStake * 5000
    if (totalWin > localCap) totalWin = localCap

    if (totalWin > 0) {
      const next = balanceRef.current + totalWin
      balanceRef.current = next
      setBalance(next)
      setBalanceBounce(true)
      setTimeout(() => setBalanceBounce(false), 600)
      setLastWin(Math.round(totalWin))
      haptic('success')
    } else {
      setLastWin(0)
    }

    // Server finalize.
    setPhase('finishing')
    if (!isDev && round.round_id && !round.round_id.startsWith('dev-')) {
      finalizingRef.current = true
      setFinalizing(true)
      try {
        const res = await finishPixelMineRound(round.round_id, Math.round(totalWin))
        if (res && typeof res.balance === 'number' && !cancelRef.current) {
          setBalance(res.balance)
          balanceRef.current = res.balance
        }
      } finally {
        finalizingRef.current = false
        setFinalizing(false)
      }
    }
    currentRoundRef.current = null
    setPhase('idle')
  }

  // ── Auto-spin loop ──
  async function autoLoop() {
    while (autoRef.current && !cancelRef.current) {
      while ((phase !== 'idle' || finalizingRef.current) && !cancelRef.current && autoRef.current) {
        await sleep(60)
      }
      if (!autoRef.current || cancelRef.current) break
      if (balanceRef.current < stakeRef.current) {
        setAutoSpin(false); autoRef.current = false
        break
      }
      await spin()
      await sleep(220)
    }
  }

  function onSpinClick() {
    if (autoSpin) {
      setAutoSpin(false); autoRef.current = false
      return
    }
    if (isBusy) return
    if (!canAfford) return
    spin()
  }

  // Buy Bonus — opens the confirmation modal first. The actual
  // buy happens only when the user taps the green "BUY" button
  // inside the modal (handled by `confirmBuyBonus` below).
  function onBuyBonusClick() {
    if (autoSpin) return
    if (isBusy) return
    const cost = stake * 100
    if (balance < cost) return
    haptic('light')
    setBuyBonusConfirm(true)
  }

  function confirmBuyBonus() {
    setBuyBonusConfirm(false)
    if (autoSpin || isBusy) return
    if (balance < stake * 100) return
    haptic('medium')
    spin({ isBuyBonus: true, forceEnders: true })
  }

  function onAutoClick() {
    if (autoSpin) {
      setAutoSpin(false); autoRef.current = false
      return
    }
    if (isBusy) return
    if (!canAfford) return
    setAutoSpin(true); autoRef.current = true
    autoLoop()
  }

  const stakeUpDisabled   = isBusy || stakeIndex >= BETS.length - 1 ||
                            (BETS[stakeIndex + 1] !== undefined && BETS[stakeIndex + 1] > balance)
  const stakeDownDisabled = isBusy || stakeIndex <= 0
  const winLabel          = lastWin > 0 ? `+${formatCurrency(lastWin, currency, rates)}` : null

  return (
    <div className={`pixel-mine-page pixel-mine-page--${phase}`}>
      <div className="pixel-mine-window">
        <main className="pixel-mine-stage" aria-label="Pixel Mine">
          <div className="pixel-mine-bg" />

          {/* ── Clouds ──
              Floating Minecraft-style clouds drifting across the
              sky behind everything else (behind the blocks, even
              behind the chests platform area). When a block at the
              top of a column breaks, the cloud passing behind that
              cell is visible through the hole. 8 cloud variants at
              different vertical positions and speeds. */}
          <div className="pixel-mine-clouds" aria-hidden="true">
            <span className="pixel-mine-cloud pixel-mine-cloud--a" />
            <span className="pixel-mine-cloud pixel-mine-cloud--b" />
            <span className="pixel-mine-cloud pixel-mine-cloud--c" />
            <span className="pixel-mine-cloud pixel-mine-cloud--d" />
            <span className="pixel-mine-cloud pixel-mine-cloud--e" />
            <span className="pixel-mine-cloud pixel-mine-cloud--f" />
            <span className="pixel-mine-cloud pixel-mine-cloud--g" />
            <span className="pixel-mine-cloud pixel-mine-cloud--h" />
          </div>

          {/* ── REELS (5×3) ──
              Two render paths:
                - reelStrips set (mid-spin): each cell renders a
                  4-symbol vertical strip with a CSS-transform
                  animation that scrolls top→bottom past the cell
                  viewport. The viewport is overflow-hidden so
                  only ONE symbol is visible at any moment.
                - reelStrips null (idle / post-spin): each cell
                  is a static slot showing reels[r][c].
          */}
          <div className="pixel-mine-reels" aria-hidden="true">
            {reels.map((row, r) => row.map((sym, c) => {
              const strip = reelStrips?.[r]?.[c]
              if (strip) {
                const bgFor = (s) => {
                  const t = REEL_TEX[s]
                  return t ? `url("${t}")` : 'none'
                }
                return (
                  <span
                    key={`reel-${r}-${c}`}
                    className="pmr-cell pmr-cell--strip"
                    data-row={r}
                    data-col={c}
                  >
                    <div
                      className="pmr-strip"
                      style={{
                        transform: `translateY(${strip.ty}%)`,
                        transition: `transform ${strip.td}ms ${strip.ease}`,
                      }}
                    >
                      <span className="pmr-strip-symbol" style={{ backgroundImage: bgFor(strip.final) }} />
                      <span className="pmr-strip-symbol" style={{ backgroundImage: bgFor(strip.mid2)  }} />
                      <span className="pmr-strip-symbol" style={{ backgroundImage: bgFor(strip.mid1)  }} />
                      <span className="pmr-strip-symbol" style={{ backgroundImage: bgFor(strip.start) }} />
                    </div>
                  </span>
                )
              }
              const tex = REEL_TEX[sym]
              const dimmed   = bookActiveCol != null && c !== bookActiveCol
              const flashing = bookFlashCell && bookFlashCell.row === r && bookFlashCell.col === c
              return (
                <span
                  key={`reel-${r}-${c}`}
                  className={
                    `pmr-cell pmr-cell--${sym}` +
                    (dimmed   ? ' is-dimmed'      : '') +
                    (flashing ? ' is-book-flash'  : '')
                  }
                  data-row={r}
                  data-col={c}
                  style={{ backgroundImage: tex ? `url("${tex}")` : 'none' }}
                />
              )
            }))}
          </div>

          {/* ── GRID (5×7) ── */}
          <div className="pixel-mine-grid" aria-hidden="true">
            {grid.map((row, r) => row.map((cell, c) => {
              const k = `${r}-${c}`
              if (!cell) {
                // Empty slot — nothing rendered, but the cell DIV is
                // kept so the grid layout stays stable.
                return <span key={k} className="pmg-cell pmg-cell--empty" />
              }
              const isActive = activeBlock && activeBlock.r === r && activeBlock.c === c
              // Pick the right texture based on HP — pristine blocks
              // use the base texture, chipped blocks slide through
              // the block_damage frames as their HP drops.
              const tex = blockTextureFor(cell.type, cell.hp)
              return (
                <span
                  key={k}
                  className={
                    `pmg-cell pmg-cell--${cell.type}` +
                    (isActive ? ' is-hit' : '')
                  }
                  data-hp={cell.hp}
                  /* Quote the URL — block_damage filenames contain
                     parens like "stone_block (1).png" which break
                     CSS url() parsing if left unquoted. */
                  style={tex ? { backgroundImage: `url("${tex}")` } : undefined}
                />
              )
            }))}

            {/* Falling pickaxe sprite — outer element controls
                vertical position (translateY in row units via
                --ty), inner element does the continuous spin. */}
            {flyingPickaxe && (
              <span
                key={flyingPickaxe.key}
                className="pixel-mine-falling-pickaxe"
                style={{
                  '--col': flyingPickaxe.col,
                  '--ty':  `calc(${flyingPickaxe.ty} * 100%)`,
                  '--td':  `${flyingPickaxe.td}ms`,
                  '--ease': flyingPickaxe.ease,
                  opacity: flyingPickaxe.opacity ?? 1,
                }}
              >
                <span
                  className="pixel-mine-pickaxe-spin"
                  style={{ backgroundImage: `url("${REEL_TEX[flyingPickaxe.sym]}")` }}
                />
              </span>
            )}

            {/* Falling TNT — same vertical-translate setup as the
                pickaxe but the inner sprite doesn't spin. The
                phase class drives fuse-pulse + expand animations. */}
            {flyingTnt && (
              <span
                key={flyingTnt.key}
                className={`pixel-mine-falling-tnt ${flyingTnt.phase || ''}`}
                style={{
                  '--col': flyingTnt.col,
                  '--ty':  `calc(${flyingTnt.ty} * 100%)`,
                  '--td':  `${flyingTnt.td}ms`,
                  '--ease': flyingTnt.ease,
                }}
              >
                <span
                  className="pixel-mine-tnt-sprite"
                  style={{ backgroundImage: `url("${REEL_TEX.tnt}")` }}
                />
              </span>
            )}

            {/* TNT explosion overlay — radial blast cloud sized to
                cover a 3-column × 3-row area centred on the
                detonation cell. */}
            {explodingTnt && (
              <div
                key={explodingTnt.key}
                className="pixel-mine-explosion"
                style={{
                  '--ex-col': explodingTnt.col,
                  '--ex-row': explodingTnt.row,
                }}
              />
            )}
          </div>

          {/* Buy Bonus FAB — circular icon button overlaid on the
              bottom-left of the stage. Tapping shows the
              confirmation modal; the actual purchase only happens
              after the user confirms. */}
          <button
            type="button"
            className="pixel-mine-buy-bonus-fab"
            onClick={onBuyBonusClick}
            disabled={isBusy || autoSpin || bonusActive || balance < stake * 100}
            aria-label="Buy Bonus"
          >
            <span className="pixel-mine-buy-bonus-fab-stack">
              <span className="pixel-mine-buy-bonus-fab-eye" />
              <span className="pixel-mine-buy-bonus-fab-text">BUY</span>
            </span>
          </button>

          {/* ── CHESTS ROW (5 chests, one per column) ──
              Each cell renders its chest sprite (closed or open)
              and, when open, a 3-D white multiplier label that
              pops up out of the chest. The label is keyed on `mul`
              so it remounts (re-runs the pop animation) every time
              a chest opens with a new multiplier. */}
          <div className="pixel-mine-chests" aria-hidden="true">
            {chests.map((chest, c) => (
              <span
                key={`chest-${c}`}
                className={`pmc-cell pmc-cell--${chest.open ? 'open' : 'closed'}`}
                style={{ backgroundImage: `url("${chest.open ? texChestOpen : texChestClosed}")` }}
              >
                {chest.open && (
                  <span key={`mul-${c}-${chest.mul}`} className="pmc-mul">
                    {chest.mul}x
                  </span>
                )}
              </span>
            ))}
          </div>
        </main>

        {/* Win bar */}
        <div className={`pixel-mine-winbar ${lastWin > 0 ? 'is-win' : ''}`}>
          <span className="pixel-mine-winbar-label">{t.slotPotential}</span>
          <strong className="pixel-mine-winbar-value">
            {winLabel ?? formatCurrency(0, currency, rates)}
          </strong>
        </div>

        {/* Tetris-style controls — balance left, spin centre, stake right */}
        <section className="pixel-mine-controls">
          <div className="pixel-mine-balance">
            <span>{t.balance || 'Balance'}</span>
            <strong>{formatCurrency(balance, currency, rates)}</strong>
          </div>

          <div className="pixel-mine-center">
            <button
              type="button"
              className={`pixel-mine-spin-btn ${autoSpin ? 'is-auto' : ''}`}
              onClick={onSpinClick}
              disabled={!autoSpin && (!canAfford || isBusy)}
              aria-label={autoSpin ? t.slotPlinkoStop : 'Spin'}
            >
              {autoSpin ? (
                <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="5" width="4" height="14" rx="1.2" />
                  <rect x="14" y="5" width="4" height="14" rx="1.2" />
                </svg>
              ) : (
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none">
                  <path d="M21 12a9 9 0 1 1-3-6.7M21 4v5h-5" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              )}
            </button>
            <button
              type="button"
              className={`pixel-mine-auto-btn ${autoSpin ? 'is-on' : ''}`}
              onClick={onAutoClick}
              disabled={!autoSpin && (!canAfford || isBusy)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                {autoSpin ? (
                  <>
                    <rect x="6" y="5" width="4" height="14" rx="1.2" fill="currentColor" />
                    <rect x="14" y="5" width="4" height="14" rx="1.2" fill="currentColor" />
                  </>
                ) : (
                  <path d="M5 3l14 9-14 9z" fill="currentColor" />
                )}
              </svg>
              {autoSpin ? t.slotPlinkoStop : t.slotPlinkoAuto}
            </button>
          </div>

          <div className="pixel-mine-stake">
            <div className="pixel-mine-stake-buttons">
              <button type="button" onClick={() => changeStake(1)} disabled={stakeUpDisabled} aria-label="Increase">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path d="M7 14l5-5 5 5" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
              <button type="button" onClick={() => changeStake(-1)} disabled={stakeDownDisabled} aria-label="Decrease">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path d="M7 10l5 5 5-5" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
            </div>
            <div className="pixel-mine-stake-info">
              <span>{t.slotBet}</span>
              <strong>{formatCurrency(stake, currency, rates)}</strong>
            </div>
          </div>
        </section>

        {/* Bonus indicator — small floating badge in the top-right
            of the stage during the FS run. */}
        {bonusActive && (
          <div className="pixel-mine-bonus-indicator">
            <span>FREE SPINS</span>
            <strong>{bonusSpinsLeft}</strong>
          </div>
        )}

        {/* Buy Bonus confirm modal — shows the cost in a Minecraft-
            styled card with Cancel / Buy buttons. The Buy button
            is the action that actually triggers the spin. */}
        {buyBonusConfirm && (
          <div className="pixel-mine-buy-modal-backdrop" onClick={() => setBuyBonusConfirm(false)}>
            <div className="pixel-mine-buy-modal-card" onClick={e => e.stopPropagation()}>
              <h3 className="pixel-mine-buy-modal-title">BUY BONUS</h3>
              <div className="pixel-mine-buy-modal-cost">
                <span>Стоимость</span>
                <strong>{formatCurrency(stake * 100, currency, rates)}</strong>
              </div>
              <div className="pixel-mine-buy-modal-actions">
                <button
                  type="button"
                  className="pixel-mine-buy-modal-cancel"
                  onClick={() => { haptic('light'); setBuyBonusConfirm(false) }}
                >
                  Отмена
                </button>
                <button
                  type="button"
                  className="pixel-mine-buy-modal-buy"
                  onClick={confirmBuyBonus}
                >
                  Купить
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Bonus announcement overlay — full-stage takeover with
            big 3-D pixel text. Two flavours: 'intro' on entry,
            'end' when the bonus closes. */}
        {bonusOverlay && (
          <div className="pixel-mine-bonus-overlay">
            <div className="pixel-mine-bonus-card">
              {bonusOverlay.kind === 'intro' && (
                <>
                  <div className="pixel-mine-bonus-title">FREE SPINS</div>
                  <div className="pixel-mine-bonus-count">{bonusOverlay.spins}</div>
                </>
              )}
              {bonusOverlay.kind === 'end' && (
                <>
                  <div className="pixel-mine-bonus-title">BONUS COMPLETE</div>
                  <div className="pixel-mine-bonus-total">
                    +{formatCurrency(bonusOverlay.total || 0, currency, rates)}
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {exitConfirm && (
        <div className="pixel-mine-exit-backdrop">
          <div className="pixel-mine-exit-card">
            <h3>{t.slotExitTitle}</h3>
            <p>{t.slotExitText}</p>
            <div className="pixel-mine-exit-actions">
              <button type="button" onClick={() => { haptic('light'); setExitConfirm(false) }}>{t.slotExitStay}</button>
              <button type="button" onClick={confirmExit}>{t.slotExitLeave}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
