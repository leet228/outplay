import React, { useEffect, useMemo, useRef, useState } from 'react'
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

// ── Minecraft pixel-art houses ──
// Each house is a 2-D character grid; one character = one 14 × 14 px
// block. The HouseSilhouette component renders it as an inline SVG
// with one <rect> stack per block (fill + 1-px shadow + 1-px highlight)
// for that classic blocky-block look.
const BLOCK = 14
const BASE_HOUSE_WIDTH = 84  // median across variants (6 cols × 14)

// Block palette. Each entry { fill, dark, light } draws as a filled
// 14 × 14 square with a 1 px right/bottom shadow and a 1 px top/left
// highlight, mimicking Minecraft block bevel without using textures.
const BLOCKS = {
  // ── wood ──
  L:  { fill: '#7a5634', dark: '#3d2814', light: '#a3784e' },  // oak log
  B:  { fill: '#d8d1ad', dark: '#7a7553', light: '#f0eccd' },  // birch log
  D:  { fill: '#3a2c1d', dark: '#1a1308', light: '#574028' },  // dark-oak log
  S:  { fill: '#4a3b25', dark: '#22190d', light: '#6c5535' },  // spruce log
  A:  { fill: '#a04a26', dark: '#5a2811', light: '#cc6638' },  // acacia log
  p:  { fill: '#b58a55', dark: '#7a5634', light: '#d3aa78' },  // oak plank
  b:  { fill: '#efe6c2', dark: '#a89968', light: '#fff7d8' },  // birch plank
  d:  { fill: '#5b4128', dark: '#241906', light: '#7a5a37' },  // dark-oak plank
  s:  { fill: '#7d6038', dark: '#3d2c16', light: '#9b7a4c' },  // spruce plank
  a:  { fill: '#c47148', dark: '#5a2811', light: '#dd9266' },  // acacia plank
  // ── stone ──
  C:  { fill: '#7a7a7a', dark: '#3e3e3e', light: '#9a9a9a' },  // cobblestone
  T:  { fill: '#8a8a8a', dark: '#4a4a4a', light: '#a8a8a8' },  // stone bricks
  M:  { fill: '#6a8a5a', dark: '#3a4f30', light: '#88a878' },  // mossy cobble
  // ── windows / doors ──
  g:  { fill: '#7cc1e6', dark: '#2f6e96', light: '#a8dffc', frame: '#1c1c1c' },
  r:  { fill: '#5a3a1f', dark: '#231408', light: '#7a512c', frame: '#181818' },
  // ── roof tints ──
  R:  { fill: '#bb3d2c', dark: '#6e2018', light: '#dc5a48' },  // red wool roof
  O:  { fill: '#9d6738', dark: '#5a3920', light: '#bb8657' },  // oak slab roof
  K:  { fill: '#3a2615', dark: '#1a0f06', light: '#5a3f25' },  // dark roof
  W:  { fill: '#dadada', dark: '#a8a8a8', light: '#f5f5f5' },  // white wool
}

// Layouts. Each row is one character per block, top → bottom.
// Width = row length, height = number of rows. Rows must all have
// equal length. '.' = empty cell.
const HOUSES = {
  oak_cottage: [
    '..OOO..',
    '.OOOOO.',
    'LpppppL',
    'LgpppgL',
    'LpppppL',
    'LpprppL',
    'CCCCCCC',
  ],
  birch_house: [
    '..OOOO..',
    '.OOOOOO.',
    'BbbbbbbB',
    'BgbbbbgB',
    'BbbbbbbB',
    'BbbrrbbB',
    'CCCCCCCC',
  ],
  spruce_lodge: [
    '...KKK...',
    '..KKKKK..',
    '.KKKKKKK.',
    'SsgsssgsS',
    'SsssssssS',
    'SsssrsssS',
    'SsssssssS',
    'CCCCCCCCC',
  ],
  dark_oak_tall: [
    '..KKKK..',
    '.KKKKKK.',
    'DddddddD',
    'DgddddgD',
    'DddddddD',
    'DgddddgD',
    'DddrrddD',
    'CCCCCCCC',
  ],
  acacia_hut: [
    '..OOO..',
    '.OOOOO.',
    'AaaaaaA',
    'AagagaA',
    'AaaraaA',
    'CCCCCCC',
  ],
  stone_house: [
    '..WWWW..',
    '.WWWWWW.',
    'TTTTTTTT',
    'TgTTgTgT',
    'TTTTTTTT',
    'TTrTrTTT',
    'CCCCCCCC',
  ],
  cobble_smith: [
    '..OOO.C',
    '.OOOOOC',
    'LpppppC',
    'LgpgpgC',
    'LpppppC',
    'LpprppC',
    'CCCCCCC',
  ],
  big_library: [
    '...RRR...',
    '..RRRRR..',
    '.RRRRRRR.',
    'pdddddddp',
    'pdgdgdgdp',
    'pdddddddp',
    'pdgdgdgdp',
    'pddrrrddp',
    'CCCCCCCCC',
  ],
}

// Pre-computed metadata for each variant — width / height in pixels,
// derived from the layout shape. Used by the stacking layout math.
function variantFromKey(key) {
  const layout = HOUSES[key]
  return {
    kind: key,
    layout,
    width: layout[0].length * BLOCK,
    bodyH: layout.length * BLOCK,
    roofH: 0,  // roof is baked into the layout
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
// Heights are pure layout heights now; no roof-tuck overlap.
function bottomFor(blocks, index) {
  let bottom = 42 // foundation top
  for (let i = 0; i < index; i++) {
    bottom += (blocks[i]?.bodyH ?? BLOCK * 7)
  }
  return bottom
}

// Renders a Minecraft-style pixel-art house from a layout grid.
// Each cell is BLOCK × BLOCK px with a tiny shadow + highlight to
// give every block its own bevel. Glass cells get a window cross,
// door cells get a vertical handle line.
function HouseSilhouette({ layout }) {
  if (!layout) return null
  const cols = layout[0].length
  const rows = layout.length
  const W = cols * BLOCK
  const H = rows * BLOCK
  const pieces = []
  for (let y = 0; y < rows; y++) {
    const row = layout[y]
    for (let x = 0; x < cols; x++) {
      const ch = row[x]
      if (ch === '.') continue
      const def = BLOCKS[ch]
      if (!def) continue
      const px = x * BLOCK
      const py = y * BLOCK
      // base block with bevel
      pieces.push(
        <g key={`${x}-${y}`}>
          <rect x={px} y={py} width={BLOCK} height={BLOCK} fill={def.fill} />
          {/* highlight (top + left, 1 px) */}
          <rect x={px} y={py} width={BLOCK} height={1} fill={def.light} />
          <rect x={px} y={py} width={1} height={BLOCK} fill={def.light} />
          {/* shadow (right + bottom, 1 px) */}
          <rect x={px + BLOCK - 1} y={py} width={1} height={BLOCK} fill={def.dark} />
          <rect x={px} y={py + BLOCK - 1} width={BLOCK} height={1} fill={def.dark} />
        </g>
      )
      // glass: window cross
      if (ch === 'g') {
        pieces.push(
          <g key={`${x}-${y}-w`}>
            <rect x={px + 6} y={py + 1} width={2} height={BLOCK - 2} fill={def.frame} />
            <rect x={px + 1} y={py + 6} width={BLOCK - 2} height={2} fill={def.frame} />
          </g>
        )
      }
      // door: handle dot + vertical seam
      if (ch === 'r') {
        pieces.push(
          <g key={`${x}-${y}-d`}>
            <rect x={px + 1} y={py + 1} width={BLOCK - 2} height={1} fill={def.dark} />
            <rect x={px + BLOCK / 2} y={py + 1} width={1} height={BLOCK - 2} fill={def.dark} />
            <rect x={px + BLOCK - 4} y={py + BLOCK / 2} width={2} height={2} fill="#d4af37" />
          </g>
        )
      }
      // cobblestone / stone bricks: subtle inner notches
      if (ch === 'C' || ch === 'M') {
        pieces.push(
          <rect key={`${x}-${y}-n1`} x={px + 3} y={py + 4} width={2} height={2} fill={def.dark} />
        )
        pieces.push(
          <rect key={`${x}-${y}-n2`} x={px + BLOCK - 5} y={py + BLOCK - 6} width={2} height={2} fill={def.dark} />
        )
      }
      if (ch === 'T') {
        pieces.push(
          <rect key={`${x}-${y}-tb`} x={px} y={py + Math.floor(BLOCK / 2)} width={BLOCK} height={1} fill={def.dark} />
        )
      }
    }
  }
  return (
    <svg
      className="tower-house-svg"
      viewBox={`0 0 ${W} ${H}`}
      width={W}
      height={H}
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      {pieces}
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
      layout: preset.layout,
      bodyH: preset.bodyH,
      tilt: rand(-1.6, 1.6).toFixed(1),
      doomed: willFall,
      // Direction the new house overshot the previous floor (-1 left,
      // +1 right) — drives the doomed-fall side later in CSS.
      fallDir: direction,
      _seed: preset._seed,
    }

    setCraneTarget(releaseOffset)
    setFallingBlock(nextBlock)
    setPhase('swinging')

    dropTimerRef.current = window.setTimeout(() => {
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
    }, 980)
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
                <HouseSilhouette layout={craneHouse.layout} />
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
                  <HouseSilhouette layout={block.layout} />
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
