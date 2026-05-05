import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useShallow } from 'zustand/react/shallow'
import useGameStore from '../store/useGameStore'
import { translations } from '../lib/i18n'
import { formatCurrency } from '../lib/currency'
import { haptic } from '../lib/telegram'
import { startSlotRound, finishSlotRound, getLeaderboard, getUserProfile } from '../lib/supabase'
import './TowerStackSlot.css'

// Bets in RUB. Storage layer is RUB; display converts to currency.
const BETS = [10, 25, 50, 100, 250, 500, 1000, 2000, 4000, 8000, 16000, 25000]
const MIN_BALANCE_RUB = 10
const SLOT_ID = 'tower-stack'

// ── Minecraft houses ──
// Each variant is a high-level config (size + materials + window /
// door positions). HouseSilhouette renders it as an inline SVG with
// real Minecraft-ish texture patterns (cobblestone noise, plank
// stripes, log grain), a flat plank roof and a black outline — the
// same general look as a real village house.
const BLOCK = 14
const BASE_HOUSE_WIDTH = 98  // median across variants (7 cols × 14)

// 8 distinct village houses. cols × rows includes the roof row at top
// and the foundation (cobblestone) row at bottom. Walls are everything
// in between.
const HOUSES = {
  oak_cottage: {
    cols: 6, rows: 6,
    wall: 'oak_plank', corner: 'oak_log',
    roof: 'oak_plank', foundation: 'cobble',
    windows: [[1, 2], [4, 2]],
    doors:   [[2, 4], [3, 4]],
  },
  birch_house: {
    cols: 7, rows: 6,
    wall: 'birch_plank', corner: 'birch_log',
    roof: 'birch_plank', foundation: 'cobble',
    windows: [[1, 2], [5, 2]],
    doors:   [[3, 4]],
  },
  spruce_lodge: {
    cols: 8, rows: 7,
    wall: 'spruce_plank', corner: 'spruce_log',
    roof: 'dark_plank', foundation: 'cobble',
    windows: [[1, 2], [3, 2], [6, 2]],
    doors:   [[4, 5]],
  },
  dark_oak_tall: {
    cols: 6, rows: 8,
    wall: 'dark_plank', corner: 'dark_log',
    roof: 'dark_plank', foundation: 'cobble',
    windows: [[1, 2], [4, 2], [1, 4], [4, 4]],
    doors:   [[2, 6], [3, 6]],
  },
  acacia_hut: {
    cols: 5, rows: 5,
    wall: 'acacia_plank', corner: 'acacia_log',
    roof: 'oak_plank', foundation: 'cobble',
    windows: [[1, 1], [3, 1]],
    doors:   [[2, 3]],
  },
  stone_house: {
    cols: 7, rows: 6,
    wall: 'stone_brick', corner: 'oak_log',
    roof: 'oak_plank', foundation: 'cobble',
    windows: [[1, 2], [3, 2], [5, 2]],
    doors:   [[3, 4]],
  },
  cobble_smith: {
    cols: 6, rows: 6,
    wall: 'cobble', corner: 'oak_log',
    roof: 'oak_plank', foundation: 'cobble',
    windows: [[1, 2], [4, 2]],
    doors:   [[2, 4]],
    chimney: { x: 4, h: 1 }, // 1-block chimney sticking above the roof
  },
  big_library: {
    cols: 8, rows: 8,
    wall: 'oak_plank', corner: 'dark_log',
    roof: 'dark_plank', foundation: 'cobble',
    windows: [[1, 2], [3, 2], [6, 2], [1, 4], [3, 4], [6, 4]],
    doors:   [[3, 6], [4, 6]],
  },
}

function variantFromKey(key) {
  const cfg = HOUSES[key]
  return {
    kind: key,
    cfg,
    width: cfg.cols * BLOCK,
    bodyH: cfg.rows * BLOCK,
    roofH: 0,
  }
}

const HOUSE_VARIANTS = [
  variantFromKey('oak_cottage'),
  variantFromKey('birch_house'),
  variantFromKey('spruce_lodge'),
  variantFromKey('dark_oak_tall'),
  variantFromKey('acacia_hut'),
  variantFromKey('stone_house'),
  variantFromKey('cobble_smith'),
  variantFromKey('big_library'),
]

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function rand(min, max) {
  return min + Math.random() * (max - min)
}

// Cumulative bottom offset (px) for the house at given index in the stack.
// Heights are pure layout heights now; no roof-tuck overlap. The
// foundation slab is 46 px tall and sits at bottom: 0 of the stack,
// so the very first house has to start above it (bottom: 46) — not
// 42, otherwise the house's own bottom row sinks 4 px into the
// foundation slab.
function bottomFor(blocks, index) {
  let bottom = 46 // foundation top
  for (let i = 0; i < index; i++) {
    bottom += (blocks[i]?.bodyH ?? BLOCK * 7)
  }
  return bottom
}

// Reusable Minecraft-ish texture patterns. Each pattern is a single
// SVG <pattern> definition that tiles to fill any sized rect. The
// caller passes a unique idPrefix so multiple house instances on the
// page don't fight over pattern IDs.
function HousePatterns({ idPrefix }) {
  return (
    <defs>
      {/* Cobblestone — irregular grey blocks with darker mortar */}
      <pattern id={`${idPrefix}-cobble`} x="0" y="0" width="14" height="14" patternUnits="userSpaceOnUse">
        <rect width="14" height="14" fill="#7c7c7c" />
        <rect width="14" height="14" fill="none" stroke="#3a3a3a" strokeWidth="1" />
        <rect x="2"  y="2"  width="3" height="3" fill="#a0a0a0" />
        <rect x="8"  y="3"  width="3" height="2" fill="#9a9a9a" />
        <rect x="3"  y="8"  width="2" height="3" fill="#909090" />
        <rect x="9"  y="9"  width="3" height="2" fill="#a8a8a8" />
        <rect x="6"  y="5"  width="1" height="1" fill="#5a5a5a" />
        <rect x="11" y="6"  width="1" height="1" fill="#5a5a5a" />
        <rect x="2"  y="11" width="1" height="1" fill="#5a5a5a" />
      </pattern>

      {/* Stone bricks — uniform grid */}
      <pattern id={`${idPrefix}-stone_brick`} x="0" y="0" width="14" height="14" patternUnits="userSpaceOnUse">
        <rect width="14" height="14" fill="#8a8a8a" />
        <rect width="14" height="14" fill="none" stroke="#454545" strokeWidth="1" />
        <rect x="0" y="6" width="14" height="2" fill="#454545" />
        <rect x="6" y="0" width="2" height="6"  fill="#454545" />
        <rect x="0" y="8" width="2" height="6"  fill="#454545" />
        <rect x="2" y="8" width="2" height="2"  fill="#a0a0a0" />
        <rect x="8" y="2" width="2" height="2"  fill="#a0a0a0" />
      </pattern>

      {/* Oak planks — horizontal woodgrain */}
      <pattern id={`${idPrefix}-oak_plank`} x="0" y="0" width="28" height="14" patternUnits="userSpaceOnUse">
        <rect width="28" height="14" fill="#b58a55" />
        <rect width="28" height="2"  y="0"  fill="#7a5a30" />
        <rect width="14" height="2"  y="7"  x="0"  fill="#9d7644" />
        <rect width="14" height="2"  y="7"  x="14" fill="#9d7644" />
        <rect width="14" height="1"  y="3"  x="2"  fill="#cba074" />
        <rect width="10" height="1"  y="11" x="14" fill="#cba074" />
      </pattern>

      {/* Birch planks — pale, fine horizontal grain */}
      <pattern id={`${idPrefix}-birch_plank`} x="0" y="0" width="28" height="14" patternUnits="userSpaceOnUse">
        <rect width="28" height="14" fill="#efe6c2" />
        <rect width="28" height="1"  y="0" fill="#a89968" />
        <rect width="28" height="1"  y="7" fill="#cdbe87" />
        <rect width="28" height="1"  y="13" fill="#a89968" />
        <rect width="2"  height="14" x="6"  fill="#cdbe87" />
        <rect width="2"  height="14" x="20" fill="#cdbe87" />
      </pattern>

      {/* Spruce planks — darker brown grain */}
      <pattern id={`${idPrefix}-spruce_plank`} x="0" y="0" width="28" height="14" patternUnits="userSpaceOnUse">
        <rect width="28" height="14" fill="#7d6038" />
        <rect width="28" height="2"  y="0" fill="#3d2c16" />
        <rect width="28" height="1"  y="7" fill="#5a4326" />
        <rect width="2"  height="14" x="10" fill="#5a4326" />
        <rect width="2"  height="14" x="22" fill="#5a4326" />
      </pattern>

      {/* Dark oak planks */}
      <pattern id={`${idPrefix}-dark_plank`} x="0" y="0" width="28" height="14" patternUnits="userSpaceOnUse">
        <rect width="28" height="14" fill="#4a341e" />
        <rect width="28" height="2"  y="0"  fill="#22150a" />
        <rect width="28" height="1"  y="7"  fill="#321f10" />
        <rect width="14" height="1"  y="3"  x="2"  fill="#5e4527" />
        <rect width="2"  height="14" x="13" fill="#22150a" />
      </pattern>

      {/* Acacia planks — orange-red */}
      <pattern id={`${idPrefix}-acacia_plank`} x="0" y="0" width="28" height="14" patternUnits="userSpaceOnUse">
        <rect width="28" height="14" fill="#c47148" />
        <rect width="28" height="2"  y="0"  fill="#5a2811" />
        <rect width="28" height="1"  y="7"  fill="#823a1a" />
        <rect width="2"  height="14" x="9"  fill="#823a1a" />
        <rect width="2"  height="14" x="21" fill="#823a1a" />
      </pattern>

      {/* Oak log — vertical strips with annual rings */}
      <pattern id={`${idPrefix}-oak_log`} x="0" y="0" width="14" height="14" patternUnits="userSpaceOnUse">
        <rect width="14" height="14" fill="#7a5634" />
        <rect width="14" height="14" fill="none" stroke="#3d2814" strokeWidth="1" />
        <rect x="2"  y="0" width="2" height="14" fill="#5a3d20" />
        <rect x="9"  y="0" width="2" height="14" fill="#5a3d20" />
        <rect x="6"  y="0" width="1" height="14" fill="#9a734a" />
      </pattern>

      {/* Dark oak log */}
      <pattern id={`${idPrefix}-dark_log`} x="0" y="0" width="14" height="14" patternUnits="userSpaceOnUse">
        <rect width="14" height="14" fill="#3a2c1d" />
        <rect width="14" height="14" fill="none" stroke="#16100a" strokeWidth="1" />
        <rect x="2" y="0" width="2" height="14" fill="#22180e" />
        <rect x="9" y="0" width="2" height="14" fill="#22180e" />
      </pattern>

      {/* Spruce log */}
      <pattern id={`${idPrefix}-spruce_log`} x="0" y="0" width="14" height="14" patternUnits="userSpaceOnUse">
        <rect width="14" height="14" fill="#4a3b25" />
        <rect width="14" height="14" fill="none" stroke="#1d1408" strokeWidth="1" />
        <rect x="2" y="0" width="2" height="14" fill="#2a200f" />
        <rect x="9" y="0" width="2" height="14" fill="#2a200f" />
      </pattern>

      {/* Birch log — pale with dark stripes */}
      <pattern id={`${idPrefix}-birch_log`} x="0" y="0" width="14" height="14" patternUnits="userSpaceOnUse">
        <rect width="14" height="14" fill="#dad2af" />
        <rect width="14" height="14" fill="none" stroke="#7a7553" strokeWidth="1" />
        <rect x="2" y="2" width="3" height="2" fill="#3a3a3a" />
        <rect x="9" y="9" width="3" height="2" fill="#3a3a3a" />
      </pattern>

      {/* Acacia log */}
      <pattern id={`${idPrefix}-acacia_log`} x="0" y="0" width="14" height="14" patternUnits="userSpaceOnUse">
        <rect width="14" height="14" fill="#a04a26" />
        <rect width="14" height="14" fill="none" stroke="#3d1f0c" strokeWidth="1" />
        <rect x="2" y="0" width="2" height="14" fill="#7a3617" />
        <rect x="9" y="0" width="2" height="14" fill="#7a3617" />
      </pattern>
    </defs>
  )
}

// Renders a single Minecraft house using SVG patterns + a flat roof.
// Walls are one big <rect> with a pattern fill (real plank / stone /
// cobble texture, not an obvious 14-px grid). Corners are darker log
// pillars. Roof is a flat plank slab with a black outline.
function HouseSilhouette({ variant }) {
  const reactId = useId()
  if (!variant?.cfg) return null
  const { cols, rows, wall, corner, roof, foundation, windows = [], doors = [], chimney } = variant.cfg
  const W = cols * BLOCK
  const H = rows * BLOCK
  const wallTop = BLOCK            // the roof eats the top row
  const wallBottom = H - BLOCK     // the foundation eats the bottom row
  const wallH = wallBottom - wallTop
  const idP = `mc-${reactId.replace(/[^a-z0-9]/gi, '')}-${variant.kind}`

  return (
    <svg
      className="tower-house-svg"
      viewBox={`0 0 ${W} ${H}`}
      width={W}
      height={H}
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      <HousePatterns idPrefix={idP} />

      {/* Wall body (full width). Drawn first so corners + roof + foundation overlay it. */}
      <rect x="0" y={wallTop} width={W} height={wallH} fill={`url(#${idP}-${wall})`} />

      {/* Corner pillars (logs) — left and right edges of the wall band. */}
      <rect x="0"           y={wallTop} width={BLOCK} height={wallH} fill={`url(#${idP}-${corner})`} />
      <rect x={W - BLOCK}   y={wallTop} width={BLOCK} height={wallH} fill={`url(#${idP}-${corner})`} />

      {/* Windows */}
      {windows.map(([cx, cy], i) => {
        const x = cx * BLOCK, y = cy * BLOCK
        return (
          <g key={`w${i}`}>
            <rect x={x} y={y} width={BLOCK} height={BLOCK} fill="#7cc1e6" />
            <rect x={x} y={y} width={BLOCK} height={BLOCK} fill="none" stroke="#1c1c1c" strokeWidth="1.5" />
            <rect x={x + BLOCK / 2 - 0.5} y={y + 1} width="1" height={BLOCK - 2} fill="#1c1c1c" />
            <rect x={x + 1} y={y + BLOCK / 2 - 0.5} width={BLOCK - 2} height="1" fill="#1c1c1c" />
            {/* tiny highlight on the top-left pane */}
            <rect x={x + 2} y={y + 2} width="3" height="2" fill="#d6f0ff" />
          </g>
        )
      })}

      {/* Doors */}
      {doors.map(([cx, cy], i) => {
        const x = cx * BLOCK, y = cy * BLOCK
        return (
          <g key={`d${i}`}>
            <rect x={x} y={y} width={BLOCK} height={BLOCK} fill={`url(#${idP}-oak_plank)`} />
            <rect x={x} y={y} width={BLOCK} height={BLOCK} fill="none" stroke="#1c0e05" strokeWidth="1.5" />
            <rect x={x + BLOCK / 2 - 0.5} y={y + 1} width="1" height={BLOCK - 2} fill="#1c0e05" />
            <rect x={x + BLOCK - 4} y={y + BLOCK / 2 - 1} width="2" height="2" fill="#d4af37" />
          </g>
        )
      })}

      {/* Foundation slab — cobblestone runs the whole width below the wall. */}
      <rect x="0" y={H - BLOCK} width={W} height={BLOCK} fill={`url(#${idP}-${foundation})`} />

      {/* Flat roof slab — overhangs the wall by 2 px each side for a stair-cap look. */}
      <rect x="-2" y="0" width={W + 4} height={BLOCK} fill={`url(#${idP}-${roof})`} />
      <rect x="-2" y="0" width={W + 4} height={BLOCK} fill="none" stroke="#1d1410" strokeWidth="2" />
      {/* Roof trim — single dark line at the bottom edge of the roof slab. */}
      <rect x="-2" y={BLOCK - 2} width={W + 4} height="2" fill="#1d1410" />

      {/* Optional chimney sticking above the roof */}
      {chimney && (
        <g>
          <rect
            x={chimney.x * BLOCK}
            y={-(chimney.h * BLOCK)}
            width={BLOCK}
            height={chimney.h * BLOCK + BLOCK}
            fill={`url(#${idP}-cobble)`}
          />
          <rect
            x={chimney.x * BLOCK}
            y={-(chimney.h * BLOCK)}
            width={BLOCK}
            height={chimney.h * BLOCK + BLOCK}
            fill="none"
            stroke="#1d1410"
            strokeWidth="1.5"
          />
        </g>
      )}

      {/* Outer black outline — sells the "Minecraft sketch" look. */}
      <rect x="0" y="0" width={W} height={H} fill="none" stroke="#1d1410" strokeWidth="2" />
    </svg>
  )
}

export default function TowerStackSlot() {
  const navigate = useNavigate()
  const { balance, currency, rates, lang, user, setBalance, setBalanceBounce } = useGameStore(useShallow((s) => ({
    balance: s.balance,
    currency: s.currency,
    rates: s.rates,
    lang: s.lang,
    user: s.user,
    setBalance: s.setBalance,
    setBalanceBounce: s.setBalanceBounce,
  })))
  const t = translations[lang] ?? translations.ru

  // Initial stake: max affordable from defaults [10..500] band, capped by balance.
  const initialStake = useMemo(() => {
    const defaults = [50, 25, 10]
    for (const v of defaults) if (balance >= v) return v
    return BETS[0]
  }, []) // run once on mount only

  // Builds a fresh "next house" preview for the crane. Pre-computes
  // variant + width so the crane shows the SAME house from idle through
  // swing, drop and landing — only after the round completes does it
  // swap to a new preview.
  // Pick the next house from the variants list. Each variant has a
  // fixed width / height baked into its pixel-art layout — that's the
  // gameplay variability now (no random width swing on top).
  function pickNextHouse(blocksList, prevSeed) {
    const level = blocksList.length
    const seed = blocksList[0]?._seed ?? prevSeed ?? Math.floor(Math.random() * HOUSE_VARIANTS.length)
    const variant = HOUSE_VARIANTS[(level + seed) % HOUSE_VARIANTS.length]
    return { ...variant, _seed: seed }
  }

  const [stake, setStake] = useState(initialStake)
  const [blocks, setBlocks] = useState([])
  const [fallingBlock, setFallingBlock] = useState(null)
  const [craneNext, setCraneNext] = useState(() => pickNextHouse([], null))
  const [craneTarget, setCraneTarget] = useState(0)
  const [phase, setPhase] = useState('ready')
  const [lastWin, setLastWin] = useState(0)
  const [exitConfirm, setExitConfirm] = useState(false)
  const [roundId, setRoundId] = useState(null) // server-side round id (null when no active round)
  const [fallAtLevel, setFallAtLevel] = useState(99) // server-decided fall floor
  const [serverError, setServerError] = useState(null) // 'start_failed' | 'insufficient' | null
  const [stageHeight, setStageHeight] = useState(510) // measured at runtime
  const stageRef = useRef(null)
  const dropTimerRef = useRef(null)
  const errorTimerRef = useRef(null)
  const finishingRef = useRef(false) // guards against double-finish during async

  const isDev = !user || user.id === 'dev'

  const multiplier = useMemo(() => Number((1 + blocks.length * 0.3).toFixed(1)), [blocks.length])
  const potentialWin = Math.round(stake * multiplier)
  // Lift the world so the active building stays in view. During the drop
  // animation we project the falling block as if it's already placed —
  // that way the world settles into its final lift while the block is
  // still in mid-air, eliminating any post-landing teleport.
  const cameraLift = useMemo(() => {
    const isFalling = (phase === 'swinging' || phase === 'dropping') && fallingBlock
    const projected = isFalling ? [...blocks, fallingBlock] : blocks
    const visibleStories = 1
    if (projected.length <= visibleStories) return 0
    let sum = 0
    for (let i = 0; i < projected.length - visibleStories; i++) {
      sum += (projected[i].bodyH ?? BLOCK * 7)
    }
    return sum
  }, [blocks, fallingBlock, phase])

  // Distance the falling house travels: from the crane's load anchor
  // (stage_top + 160 with the new higher crane) down to its landing
  // position (always stage_height − 166 because the projected lift
  // keeps the topmost story anchored).
  const fallStartY = -(stageHeight - 326)
  const isBusy = phase === 'swinging' || phase === 'dropping' || phase === 'starting'
  const isDropping = phase === 'dropping'
  const isFinished = phase === 'fallen' || phase === 'cashed'
  const visibleBlocks = isDropping && fallingBlock ? [...blocks, fallingBlock] : blocks
  const stakeIndex = BETS.indexOf(stake)
  // Crane shows the same house from idle through swing/drop. craneNext
  // is regenerated only after a round ends.
  const craneHouse = fallingBlock ?? craneNext
  const craneHouseWidth = craneHouse.width ?? BASE_HOUSE_WIDTH

  const isRoundActive = roundId !== null
  const canPlay = balance >= MIN_BALANCE_RUB
  const canStartRound = canPlay && balance >= stake
  const playDisabled = isBusy || (!isRoundActive && !isFinished && !canStartRound)

  // Find max bet ≤ balance for stepper bounds.
  const maxAffordableIdx = useMemo(() => {
    for (let i = BETS.length - 1; i >= 0; i--) {
      if (BETS[i] <= balance) return i
    }
    return -1
  }, [balance])

  const resultText = phase === 'fallen'
    ? t.slotLost
    : phase === 'cashed'
      ? `${t.slotWin} +${formatCurrency(lastWin, currency, rates)}`
      : null

  // Auto-clamp stake to max affordable when balance drops below current stake.
  // Only applies BEFORE round starts (mid-round stake is already paid).
  useEffect(() => {
    if (isRoundActive) return
    if (maxAffordableIdx < 0) return
    if (stake > balance) {
      setStake(BETS[maxAffordableIdx])
    }
  }, [balance, stake, isRoundActive, maxAffordableIdx])

  // ── Telegram BackButton + cleanup ──
  // Re-binds when round-active state changes so the handler sees the
  // latest value and only prompts confirmation if a real bet is on the line.
  useEffect(() => {
    const tg = window.Telegram?.WebApp
    if (!tg) return
    tg.BackButton.show()
    const back = () => {
      haptic('light')
      // No active round → just leave silently.
      if (!isRoundActive || isFinished) {
        navigate('/')
        return
      }
      setExitConfirm(true)
    }
    tg.BackButton.onClick(back)
    return () => {
      tg.BackButton.offClick(back)
      tg.BackButton.hide()
    }
  }, [navigate, isRoundActive, isFinished])

  useEffect(() => {
    return () => {
      if (dropTimerRef.current) window.clearTimeout(dropTimerRef.current)
      if (errorTimerRef.current) window.clearTimeout(errorTimerRef.current)
    }
  }, [])

  // Measure the playable stage so the fall distance stays accurate across
  // device sizes (mobile, desktop, safe-area changes from rotation, etc.).
  useEffect(() => {
    if (!stageRef.current) return
    const update = () => {
      if (stageRef.current) setStageHeight(stageRef.current.offsetHeight)
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(stageRef.current)
    return () => ro.disconnect()
  }, [])

  // Refresh leaderboard + profile PnL on unmount — slot wins/losses change
  // both rank position and total PnL, and other screens read them from store.
  useEffect(() => {
    return () => {
      const uid = useGameStore.getState().user?.id
      if (!uid || uid === 'dev') return
      getLeaderboard(10).then(lb => {
        if (Array.isArray(lb)) useGameStore.getState().setLeaderboard(lb)
      }).catch(() => {})
      getUserProfile(uid).then(profile => {
        if (profile && !profile.error) {
          const store = useGameStore.getState()
          if (typeof profile.rank === 'number') store.setRank(profile.rank)
          if (Array.isArray(profile.daily_stats)) store.setDailyStats(profile.daily_stats)
          if (typeof profile.total_pnl === 'number') store.setTotalPnl(profile.total_pnl)
        }
      }).catch(() => {})
    }
  }, [])

  // ── Server round start/finish helpers ──
  // Returns the fall_at_level on success, or null on failure.
  async function callStartRound() {
    if (isDev) {
      // Dev mode: simulate without DB. Geometric distribution
      // (p=0.73 survival → ~95% RTP for level-1 cash-out).
      if (balance < stake) return null
      setBalance(balance - stake)
      setRoundId(`dev-${Date.now()}`)
      let level = 1
      while (Math.random() < 0.73 && level < 50) level++
      setFallAtLevel(level)
      return level
    }
    const res = await startSlotRound(user.id, SLOT_ID, stake)
    if (!res || res.error) {
      flashError(res?.error === 'insufficient_balance' ? 'insufficient' : 'start_failed')
      return null
    }
    setRoundId(res.round_id)
    if (typeof res.balance === 'number') setBalance(res.balance)
    const fl = Number(res.fall_at_level) || 99
    setFallAtLevel(fl)
    return fl
  }

  async function callFinishRound(outcome, payout, floors, mult) {
    if (!roundId) return
    if (finishingRef.current) return
    finishingRef.current = true
    const id = roundId
    setRoundId(null)

    if (isDev) {
      // Dev mode: just credit local balance.
      if (outcome === 'cashed' && payout > 0) {
        setBalance(balance + payout)
        setBalanceBounce(true)
        setTimeout(() => setBalanceBounce(false), 600)
      }
      finishingRef.current = false
      return
    }

    const res = await finishSlotRound(id, outcome, payout, floors, mult)
    if (res && typeof res.balance === 'number') {
      setBalance(res.balance)
      if (outcome === 'cashed' && res.payout > 0) {
        setBalanceBounce(true)
        setTimeout(() => setBalanceBounce(false), 600)
      }
    }
    finishingRef.current = false
  }

  function flashError(kind) {
    setServerError(kind)
    if (errorTimerRef.current) window.clearTimeout(errorTimerRef.current)
    errorTimerRef.current = window.setTimeout(() => setServerError(null), 2400)
    haptic('error')
  }

  // ── Game logic ──
  function resetRound() {
    if (dropTimerRef.current) window.clearTimeout(dropTimerRef.current)
    haptic('light')
    setBlocks([])
    setFallingBlock(null)
    setCraneTarget(0)
    setPhase('ready')
    setLastWin(0)
    setRoundId(null)
    setFallAtLevel(99)
    // Fresh round → fresh first-house preview on the crane.
    setCraneNext(pickNextHouse([], null))
  }

  async function buildBlock() {
    if (isBusy) return
    if (isFinished) {
      resetRound()
      return
    }

    // Starting a fresh round? Server pre-decides fall_at_level here.
    let activeFall = fallAtLevel
    if (!isRoundActive) {
      if (!canStartRound) {
        flashError(canPlay ? 'insufficient' : 'min_balance')
        return
      }
      // Lock UI while RPC runs.
      setPhase('starting')
      const startedFall = await callStartRound()
      if (!startedFall) {
        setPhase('ready')
        return
      }
      activeFall = startedFall
    }

    haptic('medium')
    const level = blocks.length
    const previousBlock = blocks.at(-1)
    const previousWidth = previousBlock?.width ?? 196
    const previousOffset = previousBlock?.offset ?? 0
    // The block being built becomes blocks[level], which after this
    // build will be at floor (level + 1). Fall when that floor matches
    // the server's predetermined fall_at_level. First block CAN fall
    // (fall_at_level === 1).
    const newFloor = level + 1
    const willFall = newFloor >= activeFall

    // Reuse the house already shown on the crane (variant + width) so the
    // visual doesn't switch when the player taps Play.
    const preset = craneNext

    const width = preset.width
    // Success: more than half of the new house lands on the previous one.
    const overlapRatio = willFall ? rand(0.04, 0.48) : rand(0.56, 0.98)
    const desiredOverlap = width * overlapRatio
    const deltaForOverlap = Math.max(0, (previousWidth + width) / 2 - desiredOverlap)
    const direction = Math.random() < 0.5 ? -1 : 1
    const releaseOffset = Math.round(clamp(previousOffset + direction * deltaForOverlap, -108, 108))
    const accuracy = clamp(overlapRatio + rand(-0.03, 0.03), 0.04, 1)
    const nextBlock = {
      id: `${Date.now()}-${level}`,
      width,
      offset: releaseOffset,
      accuracy: Math.round(accuracy * 100),
      kind: preset.kind,
      cfg: preset.cfg,
      bodyH: preset.bodyH,
      // Tiny random tilt (sub-degree) — barely visible but adds
      // a touch of human imperfection to the stack.
      tilt: rand(-0.4, 0.4).toFixed(2),
      doomed: willFall,
      // Direction the new house overshot the previous floor (-1 left,
      // +1 right) — drives the doomed-fall side later in CSS.
      fallDir: direction,
      _seed: preset._seed,
    }

    setCraneTarget(releaseOffset)
    setFallingBlock(nextBlock)
    // Skip the swing-and-jiggle phase — the crane just instantly
    // moves to the release column and the house drops. User asked
    // for "no jump", "just falls".
    setPhase('dropping')

    dropTimerRef.current = window.setTimeout(() => {
      setFallingBlock(null)
      const newBlocks = [...blocks, nextBlock]
      setBlocks(newBlocks)
      setCraneTarget(0)
      // Generate the NEXT preview now that this house has landed —
      // user sees the new variant pop onto the crane only after a
      // round outcome, not when they click Play.
      setCraneNext(pickNextHouse(newBlocks, preset._seed))

      if (willFall) {
        haptic('error')
        setPhase('fallen')
        // Server: finalize round as 'fallen' (no payout).
        const fallMult = Number((1 + newBlocks.length * 0.3).toFixed(1))
        callFinishRound('fallen', 0, newBlocks.length, fallMult)
      } else {
        haptic('success')
        setPhase('ready')
      }
    }, 720)
  }

  function cashOut() {
    if (isBusy || blocks.length === 0 || isFinished || !isRoundActive) return
    haptic('success')
    const payout = potentialWin
    setLastWin(payout)
    setPhase('cashed')
    callFinishRound('cashed', payout, blocks.length, multiplier)
  }

  function changeStake(direction) {
    if (isBusy || isRoundActive) return
    const nextIndex = clamp(stakeIndex + direction, 0, BETS.length - 1)
    if (nextIndex === stakeIndex) return
    // Block stake increase if it exceeds balance.
    if (direction > 0 && BETS[nextIndex] > balance) return
    haptic('light')
    setStake(BETS[nextIndex])
  }

  function confirmExit() {
    haptic('medium')
    setExitConfirm(false)
    // If a round is active and not finished — abort it server-side.
    if (isRoundActive && !isFinished) {
      callFinishRound('aborted', 0, blocks.length, multiplier)
    }
    navigate('/')
  }

  // Stepper button states.
  const stakeUpDisabled = isBusy || isRoundActive || stakeIndex >= BETS.length - 1 || (BETS[stakeIndex + 1] !== undefined && BETS[stakeIndex + 1] > balance)
  const stakeDownDisabled = isBusy || isRoundActive || stakeIndex <= 0

  return (
    <div className={`tower-slot-page tower-slot-page--${phase}`}>
      <div className="tower-game-window">
        <div className="tower-slot-sky" aria-hidden="true">
          <span className="tower-sky-sun" />
          <span className="tower-cloud tower-cloud--one" />
          <span className="tower-cloud tower-cloud--two" />
          <span className="tower-cloud tower-cloud--three" />
          <span className="tower-cloud tower-cloud--four" />
          <span className="tower-cloud tower-cloud--five" />
          <span className="tower-cloud tower-cloud--six" />
          <span className="tower-cloud tower-cloud--seven" />
        </div>

        <main ref={stageRef} className="tower-slot-stage" aria-label="Tower Stack Bet">
          <div
            className={[
              'tower-crane',
              phase === 'swinging' ? 'is-swinging' : '',
              phase === 'dropping' ? 'is-dropping' : '',
            ].filter(Boolean).join(' ')}
            style={{
              '--crane-x': `${craneTarget}px`,
              '--crane-wind-x': `${craneTarget > 0 ? craneTarget - 58 : craneTarget + 58}px`,
            }}
            aria-hidden="true"
          >
            <span className="tower-crane-rail" />
            <span className="tower-crane-carriage">
              <span className="tower-crane-cabin">
                <span className="tower-crane-cabin-window" />
              </span>
              <span className="tower-crane-cable" />
              <span className="tower-crane-hook">
                <span className="tower-crane-hook-line" />
                <span className="tower-crane-hook-line tower-crane-hook-line--right" />
              </span>
              <span
                className={`tower-crane-load tower-house tower-house--${craneHouse.kind}`}
                style={{
                  '--load-width': `${craneHouseWidth}px`,
                  '--body-h': `${craneHouse.bodyH}px`,
                  // Hide while the in-stack falling house is animating —
                  // the falling element is the "same" house, so showing
                  // both at once makes them detach visually.
                  visibility: isDropping ? 'hidden' : 'visible',
                }}
              >
                <HouseSilhouette variant={craneHouse} />
              </span>
            </span>
          </div>

          <div className="tower-world" style={{ transform: `translateY(${cameraLift}px)` }}>
            <div className="tower-far-hills" />
            <div className="tower-grass">
              <span />
              <span />
              <span />
            </div>
            <div className="tower-stack">
              <div className="tower-foundation">
                <span />
                <span />
              </div>
              {visibleBlocks.map((block, index) => (
                <div
                  key={block.id}
                  className={[
                    'tower-house',
                    `tower-house--${block.kind}`,
                    fallingBlock?.id === block.id ? 'is-falling' : '',
                    phase === 'fallen' && index === visibleBlocks.length - 1 ? 'is-doomed' : '',
                  ].filter(Boolean).join(' ')}
                  style={{
                    width: `${block.width}px`,
                    bottom: `${bottomFor(visibleBlocks, index)}px`,
                    transform: `translateX(calc(-50% + ${block.offset}px)) rotate(${phase === 'fallen' && index === visibleBlocks.length - 1 ? (block.fallDir ?? 1) * 17 : block.tilt}deg)`,
                    '--body-h': `${block.bodyH}px`,
                    '--accuracy': `${block.accuracy}%`,
                    '--fall-start-y': fallingBlock?.id === block.id ? `${fallStartY}px` : undefined,
                    '--fall-dir': block.fallDir ?? 1,
                  }}
                >
                  <HouseSilhouette variant={block} />
                </div>
              ))}
            </div>
          </div>
        </main>

        <section className="tower-slot-hud">
          <div className="tower-stat">
            <span>{t.slotFloors}</span>
            <strong>{blocks.length}</strong>
          </div>
          <div className="tower-stat">
            <span>{t.slotPotential}</span>
            <strong>{formatCurrency(phase === 'cashed' ? lastWin : potentialWin, currency, rates)}</strong>
          </div>
          <div className="tower-stat">
            <span>{t.slotMultiplier}</span>
            <strong>x{multiplier.toFixed(1)}</strong>
          </div>
        </section>

        {resultText && (
          <div className={`tower-result tower-result--${phase}`}>
            {resultText}
          </div>
        )}

        {serverError && (
          <div className="tower-result tower-result--error">
            {serverError === 'min_balance'
              ? t.slotMinBalance.replace('{amount}', formatCurrency(MIN_BALANCE_RUB, currency, rates))
              : serverError === 'insufficient'
                ? t.slotInsufficient
                : t.slotStartFailed}
          </div>
        )}

        <section className="tower-slot-controls">
          <div className="tower-balance-box">
            <span>{t.balance || 'Balance'}</span>
            <strong>{formatCurrency(balance, currency, rates)}</strong>
          </div>

          <div className="tower-center-controls">
            <button
              className="tower-main-btn"
              type="button"
              onClick={buildBlock}
              disabled={playDisabled}
              aria-label={isFinished ? t.slotReset : t.slotBuild}
            >
              {isFinished ? (
                <span className="tower-reset-label">{t.slotReset}</span>
              ) : (
                <svg width="34" height="34" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M8 5.5L18 12L8 18.5V5.5Z" fill="currentColor" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
                </svg>
              )}
            </button>
            <button
              className="tower-cash-btn"
              type="button"
              onClick={cashOut}
              disabled={isBusy || blocks.length === 0 || isFinished || !isRoundActive}
            >
              {t.slotCashout}
            </button>
          </div>

          <div className="tower-bet-stepper">
            <span>{t.slotTotalBet}</span>
            <strong>{formatCurrency(stake, currency, rates)}</strong>
            <div className="tower-stepper-buttons">
              <button type="button" onClick={() => changeStake(1)} disabled={stakeUpDisabled} aria-label="Increase bet">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                  <path d="M7 14L12 9L17 14" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <button type="button" onClick={() => changeStake(-1)} disabled={stakeDownDisabled} aria-label="Decrease bet">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                  <path d="M7 10L12 15L17 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
          </div>
        </section>
      </div>

      {exitConfirm && (
        <div className="tower-exit-backdrop">
          <div className="tower-exit-card">
            <h3>{t.slotExitTitle}</h3>
            <p>{t.slotExitText}</p>
            <div className="tower-exit-actions">
              <button type="button" onClick={() => { haptic('light'); setExitConfirm(false) }}>{t.slotExitStay}</button>
              <button type="button" onClick={confirmExit}>{t.slotExitLeave}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
