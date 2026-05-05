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
const BASE_HOUSE_WIDTH = 168

// Houses share a flat roof; bodies vary by inner detailing (windows/doors).
// Heights are normalized so the camera moves cleanly per story.
const HOUSE_VARIANTS = [
  { kind: 'cottage',   color: 'red',    bodyH: 58, roofH: 10 },
  { kind: 'townhouse', color: 'blue',   bodyH: 60, roofH: 10 },
  { kind: 'shop',      color: 'mint',   bodyH: 56, roofH: 10 },
  { kind: 'apartment', color: 'purple', bodyH: 64, roofH: 10 },
  { kind: 'cottage',   color: 'amber',  bodyH: 58, roofH: 10 },
  { kind: 'townhouse', color: 'green',  bodyH: 60, roofH: 10 },
  { kind: 'shop',      color: 'pink',   bodyH: 56, roofH: 10 },
  { kind: 'apartment', color: 'sky',    bodyH: 64, roofH: 10 },
]

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function rand(min, max) {
  return min + Math.random() * (max - min)
}

// Cumulative bottom offset (px) for the house at given index in the stack.
function bottomFor(blocks, index) {
  let bottom = 42 // foundation top
  for (let i = 0; i < index; i++) {
    const h = (blocks[i]?.bodyH ?? 56) + (blocks[i]?.roofH ?? 14) - 6 // -6 = roof tucks behind
    bottom += h
  }
  return bottom
}

// Decorations inside a house: roof, body, windows, door — driven by `kind`.
function HouseSilhouette({ kind }) {
  return (
    <>
      <span className="tower-house-roof" />
      <span className="tower-house-body">
        {kind === 'cottage' && (
          <>
            <span className="tower-house-window" />
            <span className="tower-house-door" />
          </>
        )}
        {kind === 'townhouse' && (
          <>
            <span className="tower-house-window tower-house-window--left" />
            <span className="tower-house-window tower-house-window--right" />
            <span className="tower-house-door" />
          </>
        )}
        {kind === 'shop' && (
          <>
            <span className="tower-house-awning" />
            <span className="tower-house-shop-window" />
            <span className="tower-house-door tower-house-door--shop" />
          </>
        )}
        {kind === 'apartment' && (
          <>
            <span className="tower-house-window tower-house-window--apt tower-house-window--apt-tl" />
            <span className="tower-house-window tower-house-window--apt tower-house-window--apt-tr" />
            <span className="tower-house-window tower-house-window--apt tower-house-window--apt-bl" />
            <span className="tower-house-window tower-house-window--apt tower-house-window--apt-br" />
          </>
        )}
      </span>
    </>
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
  function pickNextHouse(blocksList, prevSeed) {
    const level = blocksList.length
    const seed = blocksList[0]?._seed ?? prevSeed ?? Math.floor(Math.random() * HOUSE_VARIANTS.length)
    const variant = HOUSE_VARIANTS[(level + seed) % HOUSE_VARIANTS.length]
    const previousWidth = blocksList.at(-1)?.width ?? BASE_HOUSE_WIDTH
    const widthSwing = rand(-30, 14)
    const narrowingTrend = level * 1.4
    const width = level === 0
      ? Math.round(BASE_HOUSE_WIDTH - rand(0, 18))
      : clamp(Math.round(previousWidth + widthSwing - narrowingTrend), 72, BASE_HOUSE_WIDTH)
    return { ...variant, width, _seed: seed }
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
      sum += (projected[i].bodyH + projected[i].roofH - 6)
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
      // Dev mode: simulate without DB using the same honest Pareto-style
      // sampler the SQL uses (migration_tower_honest.sql). Constant
      // 95 % RTP across all cashout strategies.
      //   T = R / (1 - U), fall = max(1, ceil((T - 1) / step))
      if (balance < stake) return null
      setBalance(balance - stake)
      setRoundId(`dev-${Date.now()}`)
      const R = 0.95, STEP = 0.30, MAX_LEVEL = 50
      let u = Math.random()
      if (u >= 1) u = 0.999999
      const t = R / (1 - u)
      let level = Math.ceil((t - 1) / STEP)
      if (level < 1)         level = 1
      if (level > MAX_LEVEL) level = MAX_LEVEL
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
      color: preset.color,
      bodyH: preset.bodyH,
      roofH: preset.roofH,
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
              <span className="tower-crane-hook" />
              <span
                className={`tower-crane-load tower-house tower-house--${craneHouse.color} tower-house--${craneHouse.kind}`}
                style={{
                  '--load-width': `${craneHouseWidth}px`,
                  '--body-h': `${craneHouse.bodyH}px`,
                  '--roof-h': `${craneHouse.roofH}px`,
                  // Hide while the in-stack falling house is animating —
                  // the falling element is the "same" house, so showing
                  // both at once makes them detach visually.
                  visibility: isDropping ? 'hidden' : 'visible',
                }}
              >
                <HouseSilhouette kind={craneHouse.kind} />
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
                    `tower-house--${block.color}`,
                    `tower-house--${block.kind}`,
                    fallingBlock?.id === block.id ? 'is-falling' : '',
                    phase === 'fallen' && index === visibleBlocks.length - 1 ? 'is-doomed' : '',
                  ].filter(Boolean).join(' ')}
                  style={{
                    width: `${block.width}px`,
                    bottom: `${bottomFor(visibleBlocks, index)}px`,
                    transform: `translateX(calc(-50% + ${block.offset}px)) rotate(${phase === 'fallen' && index === visibleBlocks.length - 1 ? (block.fallDir ?? 1) * 17 : block.tilt}deg)`,
                    '--body-h': `${block.bodyH}px`,
                    '--roof-h': `${block.roofH}px`,
                    '--accuracy': `${block.accuracy}%`,
                    '--fall-start-y': fallingBlock?.id === block.id ? `${fallStartY}px` : undefined,
                    '--fall-dir': block.fallDir ?? 1,
                  }}
                >
                  <HouseSilhouette kind={block.kind} />
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
