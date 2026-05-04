import { useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import useGameStore from '../store/useGameStore'
import { translations } from '../lib/i18n'
import { formatCurrency } from '../lib/currency'
import { getLiveFeed, subscribeLiveFeed } from '../lib/supabase'
import './LiveFeed.css'

// How many rows we keep mounted at once. Anything older drops off the
// bottom — keeps the DOM tree tiny and the scroll height predictable.
const VISIBLE_ROWS = 12
// Hard cap so a server flood can't blow up state/memory.
const MAX_ROWS = 30

/**
 * Live feed of slot wins / losses (Tower / Tetris / Rocket).
 *
 * Architecture:
 *   - On mount: one RPC call for the initial page.
 *   - Then: Supabase Realtime subscription on live_feed_events INSERT.
 *     New rows prepend at the top with a slide-in CSS animation.
 *   - The component is purely render — no polling, no timers.
 *
 * Performance:
 *   - VISIBLE_ROWS rows in the DOM at any time. CSS animation is
 *     transform+opacity (GPU-accelerated). Each new event triggers
 *     exactly one React re-render with a single state update.
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

    // Initial fetch
    getLiveFeed(MAX_ROWS).then(initial => {
      if (cancelled || !Array.isArray(initial)) return
      const seen = new Set()
      const fresh = []
      for (const r of initial) {
        if (!seen.has(r.id)) { seen.add(r.id); fresh.push(r) }
      }
      seenIdsRef.current = seen
      setRows(fresh)
    })

    // Realtime broadcast
    const channel = subscribeLiveFeed((row) => {
      if (cancelled) return
      if (seenIdsRef.current.has(row.id)) return
      seenIdsRef.current.add(row.id)
      setRows(prev => {
        const next = [row, ...prev].slice(0, MAX_ROWS)
        // Drop ids that fell off the back so the seen-set doesn't
        // grow unbounded over a long session.
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

  if (rows.length === 0) {
    return (
      <div className="live-feed live-feed--loading">
        <div className="live-feed-header">
          <span className="live-feed-dot" />
          <span>{t.liveFeedTitle}</span>
        </div>
        <div className="live-feed-empty">{t.liveFeedLoading}</div>
      </div>
    )
  }

  // Only the first VISIBLE_ROWS go to the DOM — the rest are kept in
  // state for dedup but not rendered. Keeps render cost flat.
  const visible = rows.slice(0, VISIBLE_ROWS)

  return (
    <div className="live-feed">
      <div className="live-feed-header">
        <span className="live-feed-dot" />
        <span>{t.liveFeedTitle}</span>
      </div>
      <div className="live-feed-list">
        {visible.map(row => {
          const win = row.amount_rub > 0
          return (
            <div key={row.id} className={`live-feed-row ${win ? 'is-win' : 'is-loss'}`}>
              <span className="live-feed-avatar">{row.avatar_emoji}</span>
              <span className="live-feed-meta">
                <span className="live-feed-name">{row.user_name}</span>
                <span className="live-feed-game">{row.game_label}</span>
              </span>
              <span className="live-feed-amount">
                {win ? '+' : '−'}{formatCurrency(Math.abs(row.amount_rub), currency, rates)}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
