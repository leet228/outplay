import { useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import useGameStore from '../store/useGameStore'
import { translations } from '../lib/i18n'
import { formatCurrency } from '../lib/currency'
import { getLiveFeed, subscribeLiveFeed } from '../lib/supabase'

import iconTowerStack    from '../assets/games/tower_stack.png'
import iconTetrisCascade from '../assets/games/tetris_cascade.png'
import iconRocket        from '../assets/games/rocket.png'

import './LiveFeed.css'

const VISIBLE_ROWS = 5
// Buffer keeps a few "leaving" rows in state long enough for the CSS
// fade-out to play before they unmount.
const STATE_BUFFER = VISIBLE_ROWS + 4

const SLOT_ICONS = {
  'tower-stack':    iconTowerStack,
  'tetris-cascade': iconTetrisCascade,
  'rocket':         iconRocket,
}

/**
 * Live feed shown under the Slots tab on Home. Real outcomes
 * (Tower Stack, Tetris Cascade, Rocket) come in via Realtime; the
 * server pg_cron fires bursts of fake events about twice a second.
 *
 * Performance:
 *   - 1 RPC at mount + Realtime subscription. No polling.
 *   - At most STATE_BUFFER rows in state, VISIBLE_ROWS + 1 in DOM.
 *   - All animations are compositor-only (transform / opacity).
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

  // VISIBLE_ROWS as live + one "leaving" slot for the fade-out target.
  const renderable = rows.slice(0, VISIBLE_ROWS + 1)

  return (
    <div className="live-feed">
      <div className="live-feed-headerline">
        <span>{t.liveFeedColumnGame}</span>
        <span>{t.liveFeedColumnPayment}</span>
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
              <span className="live-feed-icon">
                <img src={SLOT_ICONS[row.game_id]} alt="" loading="lazy" />
              </span>
              <span className="live-feed-game">{row.game_label}</span>
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
