import React, { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useShallow } from 'zustand/react/shallow'
import useGameStore from '../store/useGameStore'
import { translations } from '../lib/i18n'
import { formatCurrency } from '../lib/currency'
import { haptic } from '../lib/telegram'
import './MagneticSlot.css'

// ─────────────────────────────────────────────────────────────
// MAGNETIC — popular slot.
//
//   - 5 magnets on the top row, each with a RANDOM multiplier per
//     spin (pulled from MAGNET_POOL with weighted probabilities).
//   - 5 reels × 3 symbols below. Symbols have a "pull strength":
//       🔩 bolt    3
//       🪙 coin    8
//       🏆 trophy  18
//       💎 gem     35
//       ⚡ lightning 60
//       blank      0
//   - After a spin each reel's TOTAL strength decides how high the
//     reel's symbols float upward toward their magnet:
//       reach = clamp(totalStrength / STRENGTH_NORMAL, 0, 1)
//     reach=1 → full magnet multiplier paid; reach=0.5 → half; etc.
//   - Per-reel payout = (reach × magnet_mult × stake) / REELS, so
//     all five contribute to the total. RTP isn't tuned yet — math
//     will be balanced via Monte-Carlo once the visuals lock in.
//
// Dev-only for now: balance is debited locally with a mock round
// id; no server RPCs are wired up. We'll mirror Dice's server
// pattern once the design is approved.
// ─────────────────────────────────────────────────────────────

const BETS = [10, 25, 50, 100, 250, 500, 1000, 2000, 4000]
const SLOT_ID = 'magnetic'

const REELS = 5
const ROWS  = 3

// Magnet multiplier pool + weights. Lower magnets are common so
// the player gets frequent small pulls; ×100 is rare but possible.
const MAGNET_POOL    = [2,   5,   10,  25,  50, 100]
const MAGNET_WEIGHTS = [38,  26,  16,  10,  6,  4]
const MAGNET_WEIGHT_SUM = MAGNET_WEIGHTS.reduce((s, w) => s + w, 0)

function pickMagnet() {
  let r = Math.random() * MAGNET_WEIGHT_SUM
  for (let i = 0; i < MAGNET_POOL.length; i++) {
    if (r < MAGNET_WEIGHTS[i]) return MAGNET_POOL[i]
    r -= MAGNET_WEIGHTS[i]
  }
  return MAGNET_POOL[0]
}

// Symbol table. `strength` drives the pull height; `weight`
// drives spawn rate. Blank cells are common so the average reel
// doesn't fly all the way up.
const SYMBOLS = [
  { id: 'blank', emoji: '·',  strength: 0,  weight: 30 },
  { id: 'bolt',  emoji: '🔩', strength: 3,  weight: 32 },
  { id: 'coin',  emoji: '🪙', strength: 8,  weight: 20 },
  { id: 'troph', emoji: '🏆', strength: 18, weight: 11 },
  { id: 'gem',   emoji: '💎', strength: 35, weight: 5  },
  { id: 'volt',  emoji: '⚡', strength: 60, weight: 2  },
]
const SYM_WEIGHT_SUM = SYMBOLS.reduce((s, x) => s + x.weight, 0)

function pickSymbol() {
  let r = Math.random() * SYM_WEIGHT_SUM
  for (const s of SYMBOLS) {
    if (r < s.weight) return s
    r -= s.weight
  }
  return SYMBOLS[0]
}

// 100 strength = full magnet reach. A "lucky" 3 × ⚡ gives 180,
// caps to full reach. Average reel (~30 strength) settles around
// 30 % of the magnet — enough for ×3 to ×30 mini-wins.
const STRENGTH_FULL = 100
function strengthToReach(s) {
  if (s <= 0) return 0
  return Math.min(1, s / STRENGTH_FULL)
}

function emptyGrid() {
  return Array.from({ length: REELS }, () =>
    Array.from({ length: ROWS }, () => SYMBOLS[0])
  )
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

export default function MagneticSlot() {
  const navigate = useNavigate()
  const { balance, setBalance, currency, rates, lang, user, setBalanceBounce } = useGameStore(
    useShallow(s => ({
      balance: s.balance,
      setBalance: s.setBalance,
      currency: s.currency,
      rates: s.rates,
      lang: s.lang,
      user: s.user,
      setBalanceBounce: s.setBalanceBounce,
    }))
  )
  const t = translations[lang] || translations.ru

  const [stake, setStake]               = useState(BETS[0])
  // Magnets shown on top row — re-randomised on each spin.
  const [magnets, setMagnets]           = useState(() =>
    Array.from({ length: REELS }, pickMagnet)
  )
  // Grid of current symbols on the reels.
  const [grid, setGrid]                 = useState(emptyGrid)
  // For each reel: 0..1 ratio of how far symbols float upward.
  // `null` = no pull active on this reel (idle state).
  const [reaches, setReaches]           = useState(() => Array(REELS).fill(null))
  // Per-reel payout in stake-currency (₽).
  const [reelPayouts, setReelPayouts]   = useState(() => Array(REELS).fill(0))
  const [totalWin, setTotalWin]         = useState(0)
  // 'idle' | 'spinning' | 'pulling' | 'settled'
  const [phase, setPhase]               = useState('idle')
  const [spinning, setSpinning]         = useState(false)

  // Refs for stable async access from spin orchestrator.
  const balanceRef       = useRef(balance)
  const stakeRef         = useRef(stake)
  const spinningRef      = useRef(false)
  const cancelRef        = useRef(false)
  // Interval handle for the reel-blur cycle (random emojis flashing
  // through each cell to simulate a spinning reel).
  const spinTickRef      = useRef(null)
  // Interval handle for the magnet-mult shuffle on top.
  const magnetTickRef    = useRef(null)

  useEffect(() => { balanceRef.current = balance },   [balance])
  useEffect(() => { stakeRef.current   = stake },     [stake])
  useEffect(() => () => {
    cancelRef.current = true
    if (spinTickRef.current) clearInterval(spinTickRef.current)
    if (magnetTickRef.current) clearInterval(magnetTickRef.current)
  }, [])

  // ── Telegram BackButton ──
  useEffect(() => {
    const tg = window.Telegram?.WebApp
    if (!tg) return
    tg.BackButton.show()
    const back = () => { haptic('light'); navigate('/') }
    tg.BackButton.onClick(back)
    return () => { tg.BackButton.offClick(back); tg.BackButton.hide() }
  }, [navigate])

  function canAfford() {
    return balanceRef.current >= stakeRef.current
  }

  async function spin() {
    if (spinningRef.current) return
    if (!canAfford()) return

    spinningRef.current = true
    setSpinning(true)
    haptic('light')

    // Reset previous round visuals.
    setPhase('spinning')
    setReaches(Array(REELS).fill(null))
    setReelPayouts(Array(REELS).fill(0))
    setTotalWin(0)

    // Debit stake locally (dev-only; no server round yet).
    const next = balanceRef.current - stakeRef.current
    balanceRef.current = next
    setBalance(next)

    // ── Pick final state up-front ──
    const finalMagnets = Array.from({ length: REELS }, pickMagnet)
    const finalGrid    = Array.from({ length: REELS }, () =>
      Array.from({ length: ROWS }, pickSymbol)
    )

    // ── Magnets shuffle animation (~800 ms) ──
    // Flash random mults at the top while the reels spin so the
    // header reads as "rerolling its iks". Settles to finalMagnets
    // a beat before the reels stop.
    let shuffles = 0
    magnetTickRef.current = setInterval(() => {
      shuffles++
      if (shuffles >= 9 || cancelRef.current) {
        clearInterval(magnetTickRef.current)
        magnetTickRef.current = null
        setMagnets(finalMagnets)
        return
      }
      setMagnets(Array.from({ length: REELS }, pickMagnet))
    }, 90)

    // ── Reel blur ── continuously randomise every cell at ~80ms
    // so the grid reads as spinning. Settled below by reel-by-reel
    // stagger.
    spinTickRef.current = setInterval(() => {
      if (cancelRef.current) return
      setGrid(Array.from({ length: REELS }, () =>
        Array.from({ length: ROWS }, pickSymbol)
      ))
    }, 70)

    // ── Cascade stop: settle reel by reel from left to right ──
    const settled = emptyGrid()
    for (let r = 0; r < REELS; r++) {
      await sleep(r === 0 ? 700 : 220)
      if (cancelRef.current) {
        if (spinTickRef.current) { clearInterval(spinTickRef.current); spinTickRef.current = null }
        if (magnetTickRef.current) { clearInterval(magnetTickRef.current); magnetTickRef.current = null }
        spinningRef.current = false
        setSpinning(false)
        setPhase('idle')
        return
      }
      settled[r] = finalGrid[r]
      // Update only the settled reels; the rest keep flashing via
      // the interval below. We do that by snapshotting the random
      // grid the interval just produced + overwriting the settled
      // columns.
      setGrid(prev => {
        const merged = prev.map((col, ci) => settled[ci] || col)
        return merged
      })
    }

    // Stop the reel-blur once all reels are settled.
    if (spinTickRef.current) {
      clearInterval(spinTickRef.current)
      spinTickRef.current = null
    }
    setGrid(finalGrid)

    // Beat before the pull animation so the player can read the
    // final symbols before they float upward.
    await sleep(220)
    if (cancelRef.current) {
      spinningRef.current = false
      setSpinning(false)
      setPhase('idle')
      return
    }

    // ── Magnetism pass ──
    // Compute reach per reel, then commit. Reels with low total
    // strength stay near the floor (small payout); reels with a
    // big symbol stack fly all the way to the magnet.
    const newReaches = finalGrid.map(reel => {
      const total = reel.reduce((s, sym) => s + sym.strength, 0)
      return strengthToReach(total)
    })
    const payouts = newReaches.map((reach, ri) =>
      Math.round((reach * finalMagnets[ri] * stakeRef.current) / REELS)
    )
    const winTotal = payouts.reduce((s, p) => s + p, 0)

    setReaches(newReaches)
    setReelPayouts(payouts)
    setTotalWin(winTotal)
    setPhase('pulling')

    // Pull animation runs via CSS; wait for it to land before
    // crediting the balance.
    await sleep(900)
    if (cancelRef.current) return

    if (winTotal > 0) {
      const nb = balanceRef.current + winTotal
      balanceRef.current = nb
      setBalance(nb)
      if (typeof setBalanceBounce === 'function') {
        setBalanceBounce(true)
        setTimeout(() => setBalanceBounce(false), 540)
      }
      haptic('success')
    } else {
      haptic('light')
    }

    setPhase('settled')
    spinningRef.current = false
    setSpinning(false)
  }

  return (
    <div className="magnetic-slot-page">
      <div className="magnetic-game-window">
        <main className="magnetic-stage" aria-label="Magnetic">
          {/* ── Magnets row ── */}
          <div className="magnetic-magnets">
            {magnets.map((mult, i) => {
              const isHot = mult >= 50
              const captured = reaches[i] === 1
              return (
                <div
                  key={i}
                  className={
                    'magnetic-magnet' +
                    (isHot ? ' magnetic-magnet--hot' : '') +
                    (captured ? ' is-captured' : '')
                  }
                >
                  <span className="magnetic-magnet-body">🧲</span>
                  <span className="magnetic-magnet-mult">×{mult}</span>
                </div>
              )
            })}
          </div>

          {/* ── Pull zone (between magnets and reels) ──
           * For each reel we render a column that, during the
           * 'pulling' phase, contains the reel's symbols offset
           * upward by `--reach`. Idle phases hide this layer so
           * the reels show their normal symbols below.
           */}
          <div className="magnetic-pull-zone">
            {grid.map((reel, ri) => {
              const reach = reaches[ri]
              const isPulling = phase === 'pulling' || phase === 'settled'
              const reachPct = reach == null ? 0 : Math.round(reach * 100)
              const payout = reelPayouts[ri]
              return (
                <div
                  key={ri}
                  className={
                    'magnetic-pull-col' +
                    (isPulling ? ' is-pulling' : '')
                  }
                  style={{ '--reach': `${reachPct}%` }}
                >
                  {isPulling && reach != null && (
                    <div className="magnetic-pulled-stack">
                      {reel.map((sym, ci) => (
                        <span key={ci} className="magnetic-pulled-symbol">
                          {sym.emoji}
                        </span>
                      ))}
                      {payout > 0 && (
                        <span className="magnetic-reel-payout">
                          +{formatCurrency(payout, currency, rates)}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* ── Reels ── */}
          <div className={'magnetic-reels' + (phase === 'pulling' || phase === 'settled' ? ' is-cleared' : '')}>
            {grid.map((reel, ri) => (
              <div key={ri} className="magnetic-reel">
                {reel.map((sym, ci) => (
                  <span key={ci} className="magnetic-cell">{sym.emoji}</span>
                ))}
              </div>
            ))}
          </div>

          {/* Win banner */}
          {totalWin > 0 && phase === 'settled' && (
            <div className="magnetic-win-banner">
              +{formatCurrency(totalWin, currency, rates)}
            </div>
          )}
        </main>
      </div>

      {/* ── Controls ── */}
      <div className="magnetic-controls">
        <div className="magnetic-balance-line">
          <span className="magnetic-balance-label">Баланс</span>
          <span className="magnetic-balance-value">
            {formatCurrency(balance, currency, rates)}
          </span>
        </div>

        <div className="magnetic-stakes">
          {BETS.map(b => (
            <button
              key={b}
              type="button"
              className={'magnetic-stake-btn' + (stake === b ? ' is-active' : '')}
              onClick={() => { if (!spinning) { haptic('light'); setStake(b) } }}
              disabled={spinning || b > balance + stake}
            >
              {formatCurrency(b, currency, rates)}
            </button>
          ))}
        </div>

        <button
          type="button"
          className="magnetic-spin-btn"
          onClick={spin}
          disabled={spinning || balance < stake}
        >
          {spinning ? '…' : 'SPIN'}
        </button>
      </div>
    </div>
  )
}
