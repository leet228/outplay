import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useShallow } from 'zustand/react/shallow'
import useGameStore from '../store/useGameStore'
import { translations } from '../lib/i18n'
import { formatCurrency } from '../lib/currency'
import { haptic } from '../lib/telegram'
import { startSlotRound, finishSlotRound } from '../lib/supabase'
import './TowerStackSlot.css'

// Bets in RUB. Storage layer is RUB; display converts to currency.
const BETS = [10, 25, 50, 100, 250, 500, 1000, 2000, 4000, 8000, 16000, 25000]
const MIN_BALANCE_RUB = 10
const SLOT_ID = 'tower-stack'
const BASE_BLOCK_WIDTH = 164
const BLOCK_HEIGHT = 45
const BLOCK_COLORS = ['orange', 'blue', 'green', 'pink', 'amber', 'mint']

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function rand(min, max) {
  return min + Math.random() * (max - min)
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

  const [stake, setStake] = useState(initialStake)
  const [blocks, setBlocks] = useState([])
  const [fallingBlock, setFallingBlock] = useState(null)
  const [craneTarget, setCraneTarget] = useState(0)
  const [phase, setPhase] = useState('ready')
  const [lastWin, setLastWin] = useState(0)
  const [exitConfirm, setExitConfirm] = useState(false)
  const [roundId, setRoundId] = useState(null) // server-side round id (null when no active round)
  const [serverError, setServerError] = useState(null) // 'start_failed' | 'insufficient' | null
  const dropTimerRef = useRef(null)
  const errorTimerRef = useRef(null)
  const finishingRef = useRef(false) // guards against double-finish during async

  const isDev = !user || user.id === 'dev'

  const multiplier = useMemo(() => Number((1 + blocks.length * 0.3).toFixed(1)), [blocks.length])
  const potentialWin = Math.round(stake * multiplier)
  const cameraLift = Math.max(0, (blocks.length - 3) * 48)
  const isBusy = phase === 'swinging' || phase === 'dropping' || phase === 'starting'
  const isDropping = phase === 'dropping'
  const isFinished = phase === 'fallen' || phase === 'cashed'
  const visibleBlocks = isDropping && fallingBlock ? [...blocks, fallingBlock] : blocks
  const stakeIndex = BETS.indexOf(stake)
  const nextBlockColor = BLOCK_COLORS[blocks.length % BLOCK_COLORS.length]
  const craneBlockWidth = fallingBlock?.width ?? blocks.at(-1)?.width ?? BASE_BLOCK_WIDTH
  const craneBlockColor = fallingBlock?.color ?? nextBlockColor

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
  useEffect(() => {
    const tg = window.Telegram?.WebApp
    if (!tg) return
    tg.BackButton.show()
    const back = () => {
      haptic('light')
      setExitConfirm(true)
    }
    tg.BackButton.onClick(back)
    return () => {
      tg.BackButton.offClick(back)
      tg.BackButton.hide()
    }
  }, [navigate])

  useEffect(() => {
    return () => {
      if (dropTimerRef.current) window.clearTimeout(dropTimerRef.current)
      if (errorTimerRef.current) window.clearTimeout(errorTimerRef.current)
    }
  }, [])

  // ── Server round start/finish helpers ──
  // Returns true on success.
  async function callStartRound() {
    if (isDev) {
      // Dev mode: simulate without DB. Just deduct local balance.
      if (balance < stake) return false
      setBalance(balance - stake)
      setRoundId(`dev-${Date.now()}`)
      return true
    }
    const res = await startSlotRound(user.id, SLOT_ID, stake)
    if (!res || res.error) {
      flashError(res?.error === 'insufficient_balance' ? 'insufficient' : 'start_failed')
      return false
    }
    setRoundId(res.round_id)
    if (typeof res.balance === 'number') setBalance(res.balance)
    return true
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
  }

  async function buildBlock() {
    if (isBusy) return
    if (isFinished) {
      resetRound()
      return
    }

    // Starting a fresh round?
    if (!isRoundActive) {
      if (!canStartRound) {
        flashError(canPlay ? 'insufficient' : 'min_balance')
        return
      }
      // Lock UI while RPC runs.
      setPhase('starting')
      const ok = await callStartRound()
      if (!ok) {
        setPhase('ready')
        return
      }
      // continue with first block placement below
    }

    haptic('medium')
    const level = blocks.length
    const previousBlock = blocks.at(-1)
    const previousWidth = previousBlock?.width ?? 196
    const previousOffset = previousBlock?.offset ?? 0
    const fallChance = Math.min(0.07 + level * 0.055, 0.68)
    const willFall = level > 0 && Math.random() < fallChance
    const width = level === 0
      ? BASE_BLOCK_WIDTH
      : clamp(Math.round(previousWidth - rand(0, 18 + level * 2.2)), 48, BASE_BLOCK_WIDTH)

    // Success: more than half of the new block lands on the previous one.
    // Fall: less than half overlaps, all the way down to an edge touch.
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
      color: BLOCK_COLORS[level % BLOCK_COLORS.length],
      tilt: rand(-2.4, 2.4).toFixed(1),
      doomed: willFall,
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
      }, 1080)
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

        <div className="tower-window-topbar">
          <div className="tower-brand">
            <span className="tower-brand-mark">T</span>
            <div>
              <strong>Tower Stack</strong>
            </div>
          </div>
        </div>

        <main className="tower-slot-stage" aria-label="Tower Stack Bet">
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
              <span className="tower-crane-cabin" />
              <span className="tower-crane-cable" />
              <span className="tower-crane-hook" />
              <span
                className={`tower-crane-load tower-block--${craneBlockColor} ${isDropping ? 'is-releasing' : ''}`}
                style={{ '--load-width': `${craneBlockWidth}px` }}
              >
                <span className="tower-block-shine" />
                <span className="tower-block-panel" />
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
            <div className="tower-stack" style={{ '--block-height': `${BLOCK_HEIGHT}px` }}>
              <div className="tower-foundation">
                <span />
                <span />
              </div>
              {visibleBlocks.map((block, index) => (
                <div
                  key={block.id}
                  className={[
                    'tower-block',
                    `tower-block--${block.color}`,
                    fallingBlock?.id === block.id ? 'is-falling' : '',
                    phase === 'fallen' && index === visibleBlocks.length - 1 ? 'is-doomed' : '',
                  ].filter(Boolean).join(' ')}
                  style={{
                    width: `${block.width}px`,
                    bottom: `${42 + index * BLOCK_HEIGHT}px`,
                    transform: `translateX(calc(-50% + ${block.offset}px)) rotate(${phase === 'fallen' && index === visibleBlocks.length - 1 ? 17 : block.tilt}deg)`,
                    '--accuracy': `${block.accuracy}%`,
                  }}
                >
                  <span className="tower-block-shine" />
                  <span className="tower-block-panel" />
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
