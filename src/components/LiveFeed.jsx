import { useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import useGameStore from '../store/useGameStore'
import { translations } from '../lib/i18n'
import { formatCurrency } from '../lib/currency'
import { getLiveFeed, subscribeLiveFeed } from '../lib/supabase'
import './LiveFeed.css'

// Hard caps. The list shows up to VISIBLE_ROWS at once; one extra
// "leaving" slot is rendered with a fade-out class so the bottom row
// gracefully animates out as a new one slides in at the top.
const VISIBLE_ROWS = 10
// State buffer — keeps a few removed rows long enough for the
// CSS leaving animation to finish before they unmount.
const STATE_BUFFER = VISIBLE_ROWS + 4

// Slot icon. We render a small inline SVG / emoji combo per game id
// so there are no extra HTTP requests and the icon scales to any DPR.
function SlotIcon({ gameId }) {
  if (gameId === 'tower-stack') {
    return (
      <svg viewBox="0 0 36 36" width="32" height="32" aria-hidden="true">
        <rect x="3"  y="20" width="30" height="13" rx="2" fill="#2fb04f" />
        <rect x="8"  y="11" width="20" height="9"  rx="1.5" fill="#3b82f6" stroke="#1e40af" strokeWidth="0.8" />
        <rect x="11" y="14" width="4"  height="4"  fill="#bfdbfe" />
        <rect x="21" y="14" width="4"  height="4"  fill="#bfdbfe" />
        <rect x="11" y="3"  width="14" height="9"  rx="1.5" fill="#fb923c" stroke="#9a3412" strokeWidth="0.8" />
        <rect x="14" y="6"  width="8"  height="4"  fill="#fed7aa" />
      </svg>
    )
  }
  if (gameId === 'tetris-cascade') {
    return (
      <svg viewBox="0 0 36 36" width="32" height="32" aria-hidden="true">
        <rect x="2" y="2" width="32" height="32" rx="4" fill="#1e1b4b" />
        <rect x="5"  y="22" width="6" height="6" fill="#06b6d4" />
        <rect x="11" y="22" width="6" height="6" fill="#f59e0b" />
        <rect x="17" y="22" width="6" height="6" fill="#22c55e" />
        <rect x="23" y="22" width="6" height="6" fill="#ef4444" />
        <rect x="11" y="16" width="6" height="6" fill="#a855f7" />
        <rect x="17" y="16" width="6" height="6" fill="#fbbf24" />
        <rect x="23" y="10" width="6" height="6" fill="#f97316" />
      </svg>
    )
  }
  // rocket
  return (
    <svg viewBox="0 0 36 36" width="32" height="32" aria-hidden="true">
      <rect x="2" y="2" width="32" height="32" rx="4" fill="#1d0838" />
      <circle cx="27" cy="9" r="3.2" fill="#fde68a" />
      <path d="M14 5 C18 9 19 14 19 19 L19 23 L9 23 L9 19 C9 14 10 9 14 5 Z"
            fill="#fbcfe8" stroke="#9f1239" strokeWidth="0.9" />
      <circle cx="14" cy="13" r="2.4" fill="#0ea5e9" stroke="#082f49" strokeWidth="0.6" />
      <path d="M9 19 L5 27 L9 25 Z"  fill="#fb7185" />
      <path d="M19 19 L23 27 L19 25 Z" fill="#fb7185" />
      <path d="M11 23 L14 31 L17 23 Z" fill="#f97316" opacity="0.85" />
    </svg>
  )
}

/**
 * Live feed shown under the Slots tab on Home.
 * Real outcomes (Tower Stack, Tetris Cascade, Rocket) come in via
 * Realtime; fake events keep the ribbon moving when the room is quiet.
 *
 * Performance:
 *   - 1 RPC at mount + Realtime subscription. No polling.
 *   - At most STATE_BUFFER rows in state, VISIBLE_ROWS + 1 in DOM.
 *   - All animations are compositor-only (transform/opacity).
 */
export default function LiveFeed() {
  const { currency, rates, lang } = useGameStore(useShallow(s => ({
    currency: s.currency,
    rates: s.rates,
    lang: s.lang,
  })))
  const t = translations[lang] ?? translations.ru

  const [rows, setRows] = useState([])
  const seenIdsRef = useRef(new Set())

  useEffect(() => {
    let cancelled = false

    getLiveFeed(VISIBLE_ROWS).then(initial => {
      if (cancelled || !Array.isArray(initial)) return
      const seen = new Set()
      const fresh = []
      for (const r of initial) {
        if (!seen.has(r.id)) { seen.add(r.id); fresh.push(r) }
      }
      seenIdsRef.current = seen
      setRows(fresh)
    })

    const channel = subscribeLiveFeed((row) => {
      if (cancelled) return
      if (seenIdsRef.current.has(row.id)) return
      seenIdsRef.current.add(row.id)
      setRows(prev => {
        const next = [row, ...prev].slice(0, STATE_BUFFER)
        const live = new Set(next.map(r => r.id))
        seenIdsRef.current = live
        return next
      })
    })

    return () => {
      cancelled = true
      channel?.unsubscribe()
    }
  }, [])

  // Render the top VISIBLE_ROWS as live + the one right after as
  // "leaving" so the fade-out animation has a DOM target.
  const renderable = rows.slice(0, VISIBLE_ROWS + 1)

  return (
    <div className="live-feed">
      <div className="live-feed-headerline">
        <span>{t.liveFeedColumnGame}</span>
        <span className="live-feed-headerline-payment">{t.liveFeedColumnPayment}</span>
      </div>

      <div className="live-feed-list">
        {renderable.map((row, i) => {
          const win = row.amount_rub > 0
          const leaving = i >= VISIBLE_ROWS
          return (
            <div
              key={row.id}
              className={
                'live-feed-row' +
                (win ? ' is-win' : ' is-loss') +
                (leaving ? ' is-leaving' : '')
              }
            >
              <span className={`live-feed-icon icon--${row.game_id}`}>
                <SlotIcon gameId={row.game_id} />
              </span>
              <span className="live-feed-meta">
                <span className="live-feed-studio">{t.liveFeedStudio}</span>
                <span className="live-feed-game">{row.game_label}</span>
              </span>
              <span className="live-feed-amount">
                <span className="live-feed-money-icon">$</span>
                <span className="live-feed-amount-value">
                  {win ? '' : '− '}
                  {formatCurrency(row.amount_rub, currency, rates, { abs: true })}
                </span>
              </span>
            </div>
          )
        })}

        {renderable.length === 0 && (
          <div className="live-feed-empty">{t.liveFeedLoading}</div>
        )}
      </div>
    </div>
  )
}
