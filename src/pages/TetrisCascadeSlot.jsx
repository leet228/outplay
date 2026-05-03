import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useShallow } from 'zustand/react/shallow'
import useGameStore from '../store/useGameStore'
import { translations } from '../lib/i18n'
import { formatCurrency } from '../lib/currency'
import { haptic } from '../lib/telegram'
import './TetrisCascadeSlot.css'

// Bets ladder (RUB) — same as other slots.
const BETS = [10, 25, 50, 100, 250, 500, 1000, 2000, 4000, 8000, 16000, 25000]
const MIN_BALANCE_RUB = 10
const SLOT_ID = 'tetris-cascade'

// Playfield 10 wide × 6 tall.
const COLS = 10
const ROWS = 6
const PIECES_PER_SPIN = 12 // ~80% grid fill — line clears happen most spins

// Tetromino shapes — 1 default rotation each. Cells are [x, y] where
// (0,0) is the top-left of the piece's bounding box. Color is the
// canonical Tetris color palette.
const PIECES = {
  I: { color: 'cyan',   cells: [[0,0],[1,0],[2,0],[3,0]] },           // ──
  O: { color: 'yellow', cells: [[0,0],[1,0],[0,1],[1,1]] },            // ▣
  T: { color: 'purple', cells: [[0,0],[1,0],[2,0],[1,1]] },            // ┴
  L: { color: 'orange', cells: [[0,0],[1,0],[2,0],[0,1]] },            // L
  J: { color: 'blue',   cells: [[0,0],[1,0],[2,0],[2,1]] },            // J
  S: { color: 'green',  cells: [[1,0],[2,0],[0,1],[1,1]] },            // S
  Z: { color: 'red',    cells: [[0,0],[1,0],[1,1],[2,1]] },            // Z
}
const PIECE_KEYS = Object.keys(PIECES)

// Multipliers per simultaneous line clears in a single cascade step.
const LINE_MUL = { 1: 1, 2: 2, 3: 5, 4: 10 }

// ── Helpers ──
function makeEmptyGrid() {
  return Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => null))
}

function pickRandomPiece() {
  const k = PIECE_KEYS[Math.floor(Math.random() * PIECE_KEYS.length)]
  return { type: k, ...PIECES[k] }
}

function pieceWidth(cells) {
  return Math.max(...cells.map(c => c[0])) + 1
}

function canPlace(grid, cells, x, y) {
  return cells.every(([cx, cy]) => {
    const gx = x + cx
    const gy = y + cy
    if (gx < 0 || gx >= COLS || gy < 0 || gy >= ROWS) return false
    if (grid[gy][gx] !== null) return false
    return true
  })
}

// Drop the piece at column x — it falls straight down until it hits
// the bottom or another block. Returns the new grid + the actual y
// the piece settled at (top of its bbox).
function dropPiece(grid, piece, x) {
  let y = 0
  while (canPlace(grid, piece.cells, x, y + 1)) y++
  const newGrid = grid.map(row => [...row])
  for (const [cx, cy] of piece.cells) {
    const gx = x + cx, gy = y + cy
    if (gy >= 0 && gy < ROWS && gx >= 0 && gx < COLS) {
      newGrid[gy][gx] = piece.color
    }
  }
  return { grid: newGrid, y }
}

function columnHeights(grid) {
  const h = []
  for (let c = 0; c < COLS; c++) {
    let height = 0
    for (let r = 0; r < ROWS; r++) {
      if (grid[r][c] !== null) { height = ROWS - r; break }
    }
    h.push(height)
  }
  return h
}

function countHoles(grid) {
  let holes = 0
  for (let c = 0; c < COLS; c++) {
    let seenBlock = false
    for (let r = 0; r < ROWS; r++) {
      if (grid[r][c] !== null) seenBlock = true
      else if (seenBlock) holes++
    }
  }
  return holes
}

// Smart-ish column pick: scores each candidate by how good the
// resulting grid looks (more lines cleared = great, low aggregate
// height = good, fewer holes = good) and adds noise so the slot
// stays unpredictable.
function pickColumn(grid, piece) {
  const w = pieceWidth(piece.cells)
  const candidates = []
  for (let x = 0; x <= COLS - w; x++) {
    if (!canPlace(grid, piece.cells, x, 0)) continue
    const { grid: simGrid } = dropPiece(grid, piece, x)
    const linesCleared = findCompleteLines(simGrid).length
    const heights = columnHeights(simGrid)
    const aggHeight = heights.reduce((a, b) => a + b, 0)
    const maxHeight = Math.max(...heights)
    const holes = countHoles(simGrid)
    // Big reward for line clears, strong penalty for holes (those
    // permanently block lower rows), gentle penalty for tall stacks,
    // plus randomness so the player still sees varied placements.
    const score =
      linesCleared * 250
      - aggHeight * 0.8
      - maxHeight * 1.2
      - holes * 35
      + Math.random() * 15
    candidates.push({ x, score })
  }
  if (candidates.length === 0) return -1
  candidates.sort((a, b) => b.score - a.score)
  // Pick from the top 2 to keep some variety.
  const top = candidates.slice(0, Math.min(2, candidates.length))
  return top[Math.floor(Math.random() * top.length)].x
}

function findCompleteLines(grid) {
  const lines = []
  for (let r = 0; r < ROWS; r++) {
    if (grid[r].every(cell => cell !== null && cell !== 'CLEARING')) lines.push(r)
  }
  return lines
}

function clearLines(grid, lines) {
  const remaining = grid.filter((_, idx) => !lines.includes(idx))
  while (remaining.length < ROWS) {
    remaining.unshift(Array.from({ length: COLS }, () => null))
  }
  return remaining
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

export default function TetrisCascadeSlot() {
  const navigate = useNavigate()
  const { balance, currency, rates, lang, user, setBalance, setBalanceBounce } = useGameStore(useShallow((s) => ({
    balance: s.balance, currency: s.currency, rates: s.rates, lang: s.lang,
    user: s.user, setBalance: s.setBalance, setBalanceBounce: s.setBalanceBounce,
  })))
  const t = translations[lang] ?? translations.ru

  const initialStake = useMemo(() => {
    const defaults = [50, 25, 10]
    for (const v of defaults) if (balance >= v) return v
    return BETS[0]
  }, [])

  // ── State ──
  const [stake, setStake] = useState(initialStake)
  const [grid, setGrid] = useState(makeEmptyGrid())
  const [phase, setPhase] = useState('ready') // ready | dropping | clearing | done
  const [totalWin, setTotalWin] = useState(0)
  const [cascadeStep, setCascadeStep] = useState(0)
  const [bigText, setBigText] = useState(null) // 'Line!' | 'Tetris!' | etc.
  const [exitConfirm, setExitConfirm] = useState(false)

  const stakeIndex = BETS.indexOf(stake)
  const isBusy = phase === 'dropping' || phase === 'clearing'
  const isFinished = phase === 'done'
  const canPlay = balance >= MIN_BALANCE_RUB && balance >= stake
  const playDisabled = isBusy || (!isFinished && !canPlay)

  const cancelRef = useRef(false)

  // ── Telegram BackButton ──
  useEffect(() => {
    const tg = window.Telegram?.WebApp
    if (!tg) return
    tg.BackButton.show()
    const back = () => {
      haptic('light')
      if (isBusy) setExitConfirm(true)
      else navigate('/')
    }
    tg.BackButton.onClick(back)
    return () => {
      tg.BackButton.offClick(back)
      tg.BackButton.hide()
    }
  }, [navigate, isBusy])

  useEffect(() => () => { cancelRef.current = true }, [])

  function autoStakeIfTooLow() {
    if (phase !== 'ready' && phase !== 'done') return
    if (stake <= balance) return
    for (let i = BETS.length - 1; i >= 0; i--) {
      if (BETS[i] <= balance) { setStake(BETS[i]); return }
    }
  }
  useEffect(() => { autoStakeIfTooLow() }, [balance])

  function changeStake(direction) {
    if (isBusy) return
    const nextIndex = Math.max(0, Math.min(BETS.length - 1, stakeIndex + direction))
    if (nextIndex === stakeIndex) return
    if (direction > 0 && BETS[nextIndex] > balance) return
    haptic('light')
    setStake(BETS[nextIndex])
  }

  // ── Spin loop ──
  async function startSpin() {
    if (isBusy) return
    if (!canPlay) return
    haptic('medium')
    cancelRef.current = false

    setBalance(balance - stake)
    setTotalWin(0)
    setCascadeStep(0)
    setBigText(null)

    let g = makeEmptyGrid()
    setGrid(g)
    setPhase('dropping')

    // 1. Drop pieces one by one with a small delay so the user sees them fall.
    const pieces = Array.from({ length: PIECES_PER_SPIN }, () => pickRandomPiece())
    for (const piece of pieces) {
      if (cancelRef.current) return
      const x = pickColumn(g, piece)
      if (x < 0) continue // playfield full — skip
      const { grid: ng } = dropPiece(g, piece, x)
      g = ng
      setGrid(g.map(row => [...row]))
      await sleep(150)
    }

    // 2. Cascade: clear lines, drop, repeat until no more lines.
    let win = 0
    let cascade = 0
    while (true) {
      const lines = findCompleteLines(g)
      if (lines.length === 0) break

      cascade++
      setCascadeStep(cascade)

      // Cascade multiplier grows: c1 = 1×, c2 = 2×, c3 = 3×, etc.
      const cascadeMul = cascade
      const baseMul = LINE_MUL[lines.length] || lines.length * 3
      const stepWin = stake * baseMul * cascadeMul

      // Big text feedback.
      const tag =
        lines.length === 4 ? 'tetris' :
        lines.length === 3 ? 'triple' :
        lines.length === 2 ? 'double' :
        'line'
      setBigText({ kind: tag, mul: baseMul * cascadeMul })

      setPhase('clearing')

      // Mark cleared cells so CSS can flash them.
      const flashGrid = g.map((row, ri) => lines.includes(ri) ? row.map(() => 'CLEARING') : row)
      setGrid(flashGrid)
      haptic(lines.length === 4 ? 'success' : 'medium')
      await sleep(420)
      if (cancelRef.current) return

      g = clearLines(g, lines)
      setGrid(g.map(row => [...row]))

      win += stepWin
      setTotalWin(win)

      await sleep(360)
      setBigText(null)
    }

    // 3. Wrap up.
    if (win > 0) {
      setBalance(balance - stake + win)
      setBalanceBounce(true)
      setTimeout(() => setBalanceBounce(false), 700)
    }
    setPhase('done')
  }

  function resetGame() {
    haptic('light')
    setGrid(makeEmptyGrid())
    setTotalWin(0)
    setCascadeStep(0)
    setBigText(null)
    setPhase('ready')
  }

  function confirmExit() {
    haptic('medium')
    cancelRef.current = true
    setExitConfirm(false)
    navigate('/')
  }

  // Bottom controls
  const stakeUpDisabled = isBusy || stakeIndex >= BETS.length - 1 || (BETS[stakeIndex + 1] !== undefined && BETS[stakeIndex + 1] > balance)
  const stakeDownDisabled = isBusy || stakeIndex <= 0

  // Big-text label
  const bigTextLabel = bigText
    ? bigText.kind === 'tetris' ? t.slotTetrisTetris
    : bigText.kind === 'triple' ? t.slotTetrisTriple
    : bigText.kind === 'double' ? t.slotTetrisDouble
    : t.slotTetrisLineWin
    : null

  return (
    <div className={`tetris-slot-page tetris-slot-page--${phase}`}>
      <div className="tetris-game-window">
        {/* HUD top */}
        <header className="tetris-hud">
          <div className="tetris-hud-stat">
            <span>{t.slotTetrisCascade}</span>
            <strong>{cascadeStep > 0 ? `x${cascadeStep}` : '—'}</strong>
          </div>
          <div className={`tetris-hud-win ${totalWin > 0 ? 'is-win' : ''}`}>
            <span>{t.slotPotential}</span>
            <strong>{formatCurrency(totalWin, currency, rates)}</strong>
          </div>
          <div className="tetris-hud-stat">
            <span>{t.slotMultiplier}</span>
            <strong>{cascadeStep > 0 ? `x${cascadeStep}` : '—'}</strong>
          </div>
        </header>

        {/* Playfield */}
        <main className="tetris-stage" aria-label="Tetris Cascade">
          <div className="tetris-bg" />
          <div className="tetris-grid" style={{ '--cols': COLS, '--rows': ROWS }}>
            {Array.from({ length: ROWS }).map((_, r) => (
              <React.Fragment key={`row-${r}`}>
                {Array.from({ length: COLS }).map((__, c) => {
                  const cell = grid[r][c]
                  const isClearing = cell === 'CLEARING'
                  const colorClass = !cell || isClearing ? '' : `tetris-cell--${cell}`
                  return (
                    <div
                      key={`${r}-${c}`}
                      className={`tetris-cell ${cell ? 'is-filled' : ''} ${isClearing ? 'is-clearing' : ''} ${colorClass}`}
                    >
                      {cell && !isClearing && <span className="tetris-cell-shine" />}
                    </div>
                  )
                })}
              </React.Fragment>
            ))}
          </div>

          {bigTextLabel && (
            <div className={`tetris-big-text tetris-big-text--${bigText.kind}`}>
              <span className="tetris-big-label">{bigTextLabel}</span>
              <span className="tetris-big-mul">×{bigText.mul}</span>
            </div>
          )}
        </main>

        {/* Hint / status line */}
        <div className="tetris-status">
          {phase === 'ready' && t.slotTetrisAuto}
          {phase === 'dropping' && t.slotTowerDropping}
          {phase === 'clearing' && t.slotTetrisCascade + ' x' + cascadeStep}
          {phase === 'done' && (totalWin > 0
            ? `${t.slotWin} +${formatCurrency(totalWin, currency, rates)}`
            : t.slotLost)}
        </div>

        {/* Controls */}
        <section className="tetris-controls">
          <div className="tetris-balance">
            <span>{t.balance || 'Balance'}</span>
            <strong>{formatCurrency(balance, currency, rates)}</strong>
          </div>

          <div className="tetris-center">
            <button
              type="button"
              className="tetris-spin-btn"
              onClick={isFinished ? resetGame : startSpin}
              disabled={playDisabled && !isFinished}
            >
              {isBusy
                ? <svg className="tetris-spin-icon spinning" width="28" height="28" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" strokeDasharray="40 60" strokeLinecap="round"/>
                  </svg>
                : isFinished
                  ? <span className="tetris-spin-label">{t.slotReset}</span>
                  : <>
                      <span className="tetris-spin-label">{t.slotTetrisSpin}</span>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                        <path d="M21 12a9 9 0 1 1-3-6.7M21 4v5h-5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </>}
            </button>
          </div>

          <div className="tetris-stake">
            <span>{t.slotTotalBet}</span>
            <strong>{formatCurrency(stake, currency, rates)}</strong>
            <div className="tetris-stake-buttons">
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
          </div>
        </section>
      </div>

      {exitConfirm && (
        <div className="tetris-exit-backdrop">
          <div className="tetris-exit-card">
            <h3>{t.slotExitTitle}</h3>
            <p>{t.slotExitText}</p>
            <div className="tetris-exit-actions">
              <button type="button" onClick={() => { haptic('light'); setExitConfirm(false) }}>{t.slotExitStay}</button>
              <button type="button" onClick={confirmExit}>{t.slotExitLeave}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
