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

// Playfield 10 wide × 8 tall — larger than v1.
const COLS = 10
const ROWS = 8

// Initial drop fills ~70% of grid; refill on each cascade injects more.
const INITIAL_PIECES = 14
const WILD_RATE = 0.08              // chance any spawned piece is wild
const COLOR_LINE_MIN = 7            // min run length for a colour match
const MAX_CASCADES = 10              // safety cap on cascade loop

// Tetromino shapes — single rotation each, [x,y] from top-left of bbox.
const PIECES = {
  I: { color: 'cyan',   cells: [[0,0],[1,0],[2,0],[3,0]] },
  O: { color: 'yellow', cells: [[0,0],[1,0],[0,1],[1,1]] },
  T: { color: 'purple', cells: [[0,0],[1,0],[2,0],[1,1]] },
  L: { color: 'orange', cells: [[0,0],[1,0],[2,0],[0,1]] },
  J: { color: 'blue',   cells: [[0,0],[1,0],[2,0],[2,1]] },
  S: { color: 'green',  cells: [[1,0],[2,0],[0,1],[1,1]] },
  Z: { color: 'red',    cells: [[0,0],[1,0],[1,1],[2,1]] },
}
const PIECE_KEYS = Object.keys(PIECES)

// Reward table.
// Full row:    × 2
// Full column: × 3 (harder — 8 cells)
// Colour run length 7→×3, 8→×5, 9→×8, 10→×15
const COLOR_RUN_MUL = { 7: 3, 8: 5, 9: 8, 10: 15 }

// ── Helpers ──
function makeEmptyGrid() {
  return Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => null))
}

function pieceWidth(cells) {
  return Math.max(...cells.map(c => c[0])) + 1
}

function pickRandomPiece(forceWild) {
  const k = PIECE_KEYS[Math.floor(Math.random() * PIECE_KEYS.length)]
  const isWild = forceWild ?? (Math.random() < WILD_RATE)
  return {
    type: k,
    cells: PIECES[k].cells,
    color: isWild ? 'wild' : PIECES[k].color,
  }
}

function canPlace(grid, cells, x, y) {
  return cells.every(([cx, cy]) => {
    const gx = x + cx, gy = y + cy
    if (gx < 0 || gx >= COLS || gy < 0 || gy >= ROWS) return false
    if (grid[gy][gx] !== null) return false
    return true
  })
}

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
    let seen = false
    for (let r = 0; r < ROWS; r++) {
      if (grid[r][c] !== null && grid[r][c] !== 'CLEARING') seen = true
      else if (seen && grid[r][c] === null) holes++
    }
  }
  return holes
}

// Smart-ish column pick — favours line clears, low stacks, no holes.
function pickColumn(grid, piece) {
  const w = pieceWidth(piece.cells)
  const candidates = []
  for (let x = 0; x <= COLS - w; x++) {
    if (!canPlace(grid, piece.cells, x, 0)) continue
    const { grid: simGrid } = dropPiece(grid, piece, x)
    const matches = findMatches(simGrid)
    const cleared = matches.reduce((s, m) => s + m.cells.length, 0)
    const heights = columnHeights(simGrid)
    const aggHeight = heights.reduce((a, b) => a + b, 0)
    const maxHeight = Math.max(...heights)
    const holes = countHoles(simGrid)
    const score =
      cleared * 12
      - aggHeight * 0.7
      - maxHeight * 1.0
      - holes * 30
      + Math.random() * 18
    candidates.push({ x, score })
  }
  if (candidates.length === 0) return -1
  candidates.sort((a, b) => b.score - a.score)
  const top = candidates.slice(0, Math.min(2, candidates.length))
  return top[Math.floor(Math.random() * top.length)].x
}

// ── Match detection ──
// A "wild" cell counts as ANY colour for colour runs. Lines / columns
// just need every cell filled, regardless of colour.
function colorMatches(a, b) {
  if (a == null || b == null) return false
  return a === b || a === 'wild' || b === 'wild'
}

function findMatches(grid) {
  const matches = []

  // Full horizontal rows
  for (let r = 0; r < ROWS; r++) {
    if (grid[r].every(cell => cell !== null && cell !== 'CLEARING')) {
      const cells = []
      for (let c = 0; c < COLS; c++) cells.push([c, r])
      matches.push({ type: 'row', cells, mul: 2 })
    }
  }

  // Full vertical columns
  for (let c = 0; c < COLS; c++) {
    let full = true
    for (let r = 0; r < ROWS; r++) {
      if (grid[r][c] === null || grid[r][c] === 'CLEARING') { full = false; break }
    }
    if (full) {
      const cells = []
      for (let r = 0; r < ROWS; r++) cells.push([c, r])
      matches.push({ type: 'col', cells, mul: 3 })
    }
  }

  // Horizontal colour runs ≥ COLOR_LINE_MIN
  for (let r = 0; r < ROWS; r++) {
    let runStart = 0
    let runColor = null    // canonical (non-wild) colour of the run
    let allWild = true
    for (let c = 0; c <= COLS; c++) {
      const cell = c < COLS ? grid[r][c] : null
      if (cell == null || cell === 'CLEARING') {
        // run ends
        const len = c - runStart
        if (len >= COLOR_LINE_MIN && runColor !== null && !allWild) {
          const cells = []
          for (let i = runStart; i < c; i++) cells.push([i, r])
          const mul = COLOR_RUN_MUL[Math.min(len, 10)] || COLOR_RUN_MUL[10]
          matches.push({ type: 'color-h', cells, mul, color: runColor, len })
        }
        runStart = c + 1
        runColor = null
        allWild = true
      } else if (runColor === null) {
        // start of a run
        runStart = c
        if (cell !== 'wild') { runColor = cell; allWild = false }
        else { runColor = 'wild'; /* allWild stays true until non-wild seen */ }
      } else if (cell === 'wild') {
        // wild extends any run
        // (don't change runColor unless we've never seen real colour)
        if (runColor === 'wild') { /* still all wild */ }
      } else if (runColor === 'wild' || runColor === cell) {
        runColor = cell
        allWild = false
      } else {
        // colour mismatch — close run, start new at this cell
        const len = c - runStart
        if (len >= COLOR_LINE_MIN && runColor !== null && !allWild) {
          const cells = []
          for (let i = runStart; i < c; i++) cells.push([i, r])
          const mul = COLOR_RUN_MUL[Math.min(len, 10)] || COLOR_RUN_MUL[10]
          matches.push({ type: 'color-h', cells, mul, color: runColor, len })
        }
        runStart = c
        runColor = cell
        allWild = (cell === 'wild')
      }
    }
  }

  // Vertical colour runs ≥ COLOR_LINE_MIN
  for (let c = 0; c < COLS; c++) {
    let runStart = 0
    let runColor = null
    let allWild = true
    for (let r = 0; r <= ROWS; r++) {
      const cell = r < ROWS ? grid[r][c] : null
      if (cell == null || cell === 'CLEARING') {
        const len = r - runStart
        if (len >= COLOR_LINE_MIN && runColor !== null && !allWild) {
          const cells = []
          for (let i = runStart; i < r; i++) cells.push([c, i])
          const mul = COLOR_RUN_MUL[Math.min(len, 10)] || COLOR_RUN_MUL[10]
          matches.push({ type: 'color-v', cells, mul, color: runColor, len })
        }
        runStart = r + 1
        runColor = null
        allWild = true
      } else if (runColor === null) {
        runStart = r
        if (cell !== 'wild') { runColor = cell; allWild = false }
        else { runColor = 'wild' }
      } else if (cell === 'wild') {
        // wild extends
      } else if (runColor === 'wild' || runColor === cell) {
        runColor = cell
        allWild = false
      } else {
        const len = r - runStart
        if (len >= COLOR_LINE_MIN && runColor !== null && !allWild) {
          const cells = []
          for (let i = runStart; i < r; i++) cells.push([c, i])
          const mul = COLOR_RUN_MUL[Math.min(len, 10)] || COLOR_RUN_MUL[10]
          matches.push({ type: 'color-v', cells, mul, color: runColor, len })
        }
        runStart = r
        runColor = cell
        allWild = (cell === 'wild')
      }
    }
  }

  return matches
}

// Mark cells as 'CLEARING' in-place for the flash animation.
function markClearing(grid, cellSet) {
  return grid.map((row, r) =>
    row.map((cell, c) => cellSet.has(`${c},${r}`) ? 'CLEARING' : cell)
  )
}

// Remove cleared cells AND apply gravity (cells above fall to fill gaps).
function applyGravity(grid, cellSet) {
  const newGrid = makeEmptyGrid()
  for (let c = 0; c < COLS; c++) {
    // Collect remaining cells from this column (top→bottom)
    const remaining = []
    for (let r = 0; r < ROWS; r++) {
      const cell = grid[r][c]
      if (!cellSet.has(`${c},${r}`) && cell !== null && cell !== 'CLEARING') {
        remaining.push(cell)
      }
    }
    // Drop them to the bottom of the column
    for (let i = 0; i < remaining.length; i++) {
      newGrid[ROWS - 1 - (remaining.length - 1 - i)][c] = remaining[i]
    }
  }
  return newGrid
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
  const [bigText, setBigText] = useState(null)
  const [autoSpin, setAutoSpin] = useState(false)
  const [exitConfirm, setExitConfirm] = useState(false)

  const stakeIndex = BETS.indexOf(stake)
  const isBusy = phase === 'dropping' || phase === 'clearing'
  const canPlay = balance >= MIN_BALANCE_RUB && balance >= stake

  const cancelRef = useRef(false)
  const balanceRef = useRef(balance)
  const stakeRef = useRef(stake)
  const autoRef = useRef(autoSpin)
  useEffect(() => { balanceRef.current = balance }, [balance])
  useEffect(() => { stakeRef.current = stake }, [stake])
  useEffect(() => { autoRef.current = autoSpin }, [autoSpin])

  // ── Telegram BackButton ──
  useEffect(() => {
    const tg = window.Telegram?.WebApp
    if (!tg) return
    tg.BackButton.show()
    const back = () => {
      haptic('light')
      if (isBusy || autoSpin) setExitConfirm(true)
      else navigate('/')
    }
    tg.BackButton.onClick(back)
    return () => {
      tg.BackButton.offClick(back)
      tg.BackButton.hide()
    }
  }, [navigate, isBusy, autoSpin])

  useEffect(() => () => { cancelRef.current = true }, [])

  // Auto-clamp stake when balance drops below current.
  useEffect(() => {
    if (isBusy) return
    if (stake <= balance) return
    for (let i = BETS.length - 1; i >= 0; i--) {
      if (BETS[i] <= balance) { setStake(BETS[i]); return }
    }
  }, [balance])

  function changeStake(direction) {
    if (isBusy) return
    const nextIndex = Math.max(0, Math.min(BETS.length - 1, stakeIndex + direction))
    if (nextIndex === stakeIndex) return
    if (direction > 0 && BETS[nextIndex] > balance) return
    haptic('light')
    setStake(BETS[nextIndex])
  }

  // ── Drop initial pieces ──
  async function dropInitialPieces(initial) {
    let g = initial
    for (let i = 0; i < INITIAL_PIECES; i++) {
      if (cancelRef.current) return g
      const piece = pickRandomPiece()
      const x = pickColumn(g, piece)
      if (x < 0) continue
      const { grid: ng } = dropPiece(g, piece, x)
      g = ng
      setGrid(g.map(row => [...row]))
      await sleep(110)
    }
    return g
  }

  // Drop a few new pieces (for refill after cascade).
  async function dropFillerPieces(g, count) {
    for (let i = 0; i < count; i++) {
      if (cancelRef.current) return g
      const piece = pickRandomPiece()
      const x = pickColumn(g, piece)
      if (x < 0) break
      const { grid: ng } = dropPiece(g, piece, x)
      g = ng
      setGrid(g.map(row => [...row]))
      await sleep(120)
    }
    return g
  }

  function buildBigText(matches, cascade) {
    // Pick the most impressive match for the headline.
    const sorted = [...matches].sort((a, b) => (b.mul * b.cells.length) - (a.mul * a.cells.length))
    const top = sorted[0]
    if (!top) return null
    if (top.type === 'row' && matches.filter(m => m.type === 'row').length === 4) {
      return { kind: 'tetris', mul: top.mul, label: t.slotTetrisTetris }
    }
    if (top.type === 'col') {
      return { kind: 'col', mul: top.mul, label: t.slotTetrisVerticalLine }
    }
    if (top.type === 'color-h' || top.type === 'color-v') {
      return { kind: 'color', mul: top.mul, label: `${t.slotTetrisColorRun} ×${top.len}` }
    }
    const rowCount = matches.filter(m => m.type === 'row').length
    if (rowCount === 3) return { kind: 'triple', mul: top.mul, label: t.slotTetrisTriple }
    if (rowCount === 2) return { kind: 'double', mul: top.mul, label: t.slotTetrisDouble }
    return { kind: 'line', mul: top.mul, label: t.slotTetrisLineWin }
  }

  // ── Main spin ──
  async function runSpin() {
    if (cancelRef.current) return
    if (balanceRef.current < stakeRef.current) {
      setAutoSpin(false)
      autoRef.current = false
      return
    }

    haptic('medium')
    const currentStake = stakeRef.current
    setBalance(balanceRef.current - currentStake)
    setTotalWin(0)
    setCascadeStep(0)
    setBigText(null)

    let g = makeEmptyGrid()
    setGrid(g)
    setPhase('dropping')

    g = await dropInitialPieces(g)
    if (cancelRef.current) return

    // Cascade loop
    let win = 0
    let cascade = 0
    let safety = 0
    while (safety++ < MAX_CASCADES) {
      const matches = findMatches(g)
      if (matches.length === 0) break

      cascade++
      setCascadeStep(cascade)
      setPhase('clearing')

      // Aggregate cells from all matches.
      const cellSet = new Set()
      let stepWin = 0
      for (const m of matches) {
        for (const [x, y] of m.cells) cellSet.add(`${x},${y}`)
        stepWin += currentStake * m.mul * cascade
      }

      setBigText(buildBigText(matches, cascade))

      // Flash
      const flashGrid = markClearing(g, cellSet)
      setGrid(flashGrid)
      haptic(matches.some(m => m.type === 'col' || m.cells.length >= 9) ? 'success' : 'medium')
      await sleep(420)
      if (cancelRef.current) return

      // Remove + gravity
      g = applyGravity(g, cellSet)
      setGrid(g.map(row => [...row]))
      await sleep(360)

      win += stepWin
      setTotalWin(win)
      setBigText(null)

      // Refill — drop more pieces from top so the spin can keep cascading.
      const refillCount = 3 + Math.ceil(matches.length * 1.5)
      g = await dropFillerPieces(g, refillCount)
      if (cancelRef.current) return
      setPhase('dropping')
    }

    // Settle
    if (win > 0) {
      setBalance(balanceRef.current + win)
      setBalanceBounce(true)
      setTimeout(() => setBalanceBounce(false), 700)
    }
    setPhase('done')

    // Auto-spin chain: schedule next spin after a short pause.
    if (autoRef.current && balanceRef.current >= stakeRef.current && !cancelRef.current) {
      await sleep(900)
      if (autoRef.current && !cancelRef.current && balanceRef.current >= stakeRef.current) {
        runSpin()
      } else {
        setAutoSpin(false)
        autoRef.current = false
      }
    }
  }

  function onSpinClick() {
    if (isBusy) return
    if (autoSpin) {
      // Cancel auto-spin
      setAutoSpin(false)
      autoRef.current = false
      return
    }
    if (!canPlay) return
    runSpin()
  }

  function onAutoSpinClick() {
    if (isBusy) return
    if (autoSpin) {
      setAutoSpin(false)
      autoRef.current = false
      return
    }
    if (!canPlay) return
    setAutoSpin(true)
    autoRef.current = true
    runSpin()
  }

  function confirmExit() {
    haptic('medium')
    cancelRef.current = true
    setAutoSpin(false)
    autoRef.current = false
    setExitConfirm(false)
    navigate('/')
  }

  const stakeUpDisabled = isBusy || stakeIndex >= BETS.length - 1 || (BETS[stakeIndex + 1] !== undefined && BETS[stakeIndex + 1] > balance)
  const stakeDownDisabled = isBusy || stakeIndex <= 0
  const winLabel = totalWin > 0 ? `+${formatCurrency(totalWin, currency, rates)}` : null

  return (
    <div className={`tetris-slot-page tetris-slot-page--${phase}`}>
      <div className="tetris-game-window">
        {/* Playfield — fills most of the screen, no top HUD */}
        <main className="tetris-stage" aria-label="Tetris Cascade">
          <div className="tetris-bg" />
          <div className="tetris-grid" style={{ '--cols': COLS, '--rows': ROWS }}>
            {Array.from({ length: ROWS }).map((_, r) => (
              <React.Fragment key={`row-${r}`}>
                {Array.from({ length: COLS }).map((__, c) => {
                  const cell = grid[r][c]
                  const isClearing = cell === 'CLEARING'
                  const isWild = cell === 'wild'
                  const colorClass = !cell || isClearing ? '' :
                    isWild ? 'tetris-cell--wild' : `tetris-cell--${cell}`
                  return (
                    <div
                      key={`${r}-${c}`}
                      className={`tetris-cell ${cell ? 'is-filled' : ''} ${isClearing ? 'is-clearing' : ''} ${colorClass}`}
                    >
                      {cell && !isClearing && !isWild && <span className="tetris-cell-shine" />}
                      {isWild && (
                        <span className="tetris-cell-wild-mark">
                          <svg viewBox="0 0 24 24" fill="none">
                            <path d="M12 2l2.4 6.8 7.6.4-5.7 4.6 1.9 7.2-6.2-4.2-6.2 4.2 1.9-7.2L2 9.2l7.6-.4z" fill="#fff" />
                          </svg>
                        </span>
                      )}
                    </div>
                  )
                })}
              </React.Fragment>
            ))}
          </div>

          {bigText && (
            <div className={`tetris-big-text tetris-big-text--${bigText.kind}`}>
              <span className="tetris-big-label">{bigText.label}</span>
              <span className="tetris-big-mul">×{bigText.mul}{cascadeStep > 1 ? ` × c${cascadeStep}` : ''}</span>
            </div>
          )}
        </main>

        {/* Win banner — above the controls panel */}
        <div className={`tetris-winbar ${totalWin > 0 ? 'is-win' : ''}`}>
          <span className="tetris-winbar-label">{t.slotPotential}</span>
          <strong className="tetris-winbar-value">
            {winLabel ?? formatCurrency(0, currency, rates)}
          </strong>
          {cascadeStep > 1 && (
            <span className="tetris-winbar-cascade">×{cascadeStep}</span>
          )}
        </div>

        {/* Controls — balance, big spin button + auto-spin stacked, stake */}
        <section className="tetris-controls">
          <div className="tetris-balance">
            <span>{t.balance || 'Balance'}</span>
            <strong>{formatCurrency(balance, currency, rates)}</strong>
          </div>

          <div className="tetris-center">
            <button
              type="button"
              className={`tetris-spin-btn ${isBusy ? 'is-busy' : ''} ${autoSpin ? 'is-auto' : ''}`}
              onClick={onSpinClick}
              disabled={!canPlay && !autoSpin}
              aria-label={autoSpin ? t.slotTetrisStop : t.slotTetrisSpin}
            >
              {isBusy ? (
                <svg className="tetris-spin-icon spinning" width="36" height="36" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" strokeDasharray="40 60" strokeLinecap="round"/>
                </svg>
              ) : autoSpin ? (
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
              className={`tetris-auto-btn ${autoSpin ? 'is-auto' : ''}`}
              onClick={onAutoSpinClick}
              disabled={isBusy && !autoSpin}
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
              {autoSpin ? t.slotTetrisStop : t.slotTetrisAutoSpin}
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
