import { useState, useEffect, useCallback } from 'react'
import {
  adminGetSlotStats,
  adminUpdateSlotSettings,
  adminRecomputeSlotStats,
  adminResetSlotStats,
} from '../lib/supabase'
import { haptic } from '../lib/telegram'

function fmtNum(n) {
  if (n == null) return '—'
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

function fmtRub(v) {
  if (v == null) return '—'
  const n = Math.round(Number(v))
  const sign = n < 0 ? '-' : ''
  return `${sign}${Math.abs(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} ₽`
}

function fmtPct(v) {
  if (v == null) return '—'
  return `${(Number(v) * 100).toFixed(2)}%`
}

function timeAgo(ts) {
  if (!ts) return '—'
  const diff = Date.now() - new Date(ts).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

const SLOT_LABELS = {
  'tower-stack': 'Tower Stack',
  'tetris-cascade': 'Tetris Cascade',
}

export default function AdminSlots() {
  const [stats, setStats] = useState([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(null) // slot_id being edited
  const [draft, setDraft] = useState({})
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const data = await adminGetSlotStats()
    setStats(Array.isArray(data) ? data : [])
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, 30000) // auto-refresh every 30s
    return () => clearInterval(id)
  }, [load])

  function startEdit(slot) {
    haptic('light')
    setEditing(slot.slot_id)
    setDraft({
      target_rtp: Number(slot.target_rtp),
      max_house_deficit_rub: Number(slot.max_house_deficit_rub),
      enabled: !!slot.enabled,
    })
  }

  function cancelEdit() {
    haptic('light')
    setEditing(null)
    setDraft({})
  }

  async function saveEdit(slotId) {
    haptic('medium')
    setSaving(true)
    const result = await adminUpdateSlotSettings(slotId, {
      targetRtp: Number(draft.target_rtp),
      maxDeficit: Math.round(Number(draft.max_house_deficit_rub)),
      enabled: !!draft.enabled,
    })
    setSaving(false)
    if (result?.error) {
      alert(`Save failed: ${result.error}`)
      return
    }
    setEditing(null)
    setDraft({})
    await load()
  }

  if (loading && stats.length === 0) {
    return (
      <div className="admin-section">
        <div className="admin-loading">Loading…</div>
      </div>
    )
  }

  return (
    <div className="admin-section admin-slots">
      <div className="admin-section-header">
        <h3 className="admin-section-title">Slot Performance</h3>
        <button className="admin-btn-sm" onClick={() => { haptic('light'); load() }}>
          Refresh
        </button>
      </div>

      {stats.length === 0 && (
        <div className="admin-empty">No slots configured yet.</div>
      )}

      {stats.map(slot => {
        const isEditing = editing === slot.slot_id
        const rtpDelta = Number(slot.current_rtp) - Number(slot.target_rtp)
        const rtpClass = Math.abs(rtpDelta) <= 0.03 ? 'ok' : (rtpDelta > 0 ? 'high' : 'low')
        return (
          <div key={slot.slot_id} className="admin-slot-card">
            <div className="admin-slot-header">
              <div>
                <h4 className="admin-slot-name">{SLOT_LABELS[slot.slot_id] || slot.slot_id}</h4>
                <div className="admin-slot-meta">
                  <span className={`admin-slot-status ${slot.enabled ? 'on' : 'off'}`}>
                    {slot.enabled ? 'ENABLED' : 'DISABLED'}
                  </span>
                  <span className="admin-slot-updated">updated {timeAgo(slot.updated_at)}</span>
                </div>
              </div>
              {!isEditing && (
                <div className="admin-slot-header-actions">
                  <button className="admin-btn-sm" onClick={() => startEdit(slot)}>Edit</button>
                </div>
              )}
            </div>

            {/* RTP */}
            <div className="admin-slot-rtp">
              <div className="admin-slot-rtp-row">
                <span className="admin-slot-label">Current RTP</span>
                <span className={`admin-slot-value rtp-${rtpClass}`}>{fmtPct(slot.current_rtp)}</span>
              </div>
              <div className="admin-slot-rtp-row">
                <span className="admin-slot-label">Target RTP</span>
                <span className="admin-slot-value">{fmtPct(slot.target_rtp)}</span>
              </div>
              <div className="admin-slot-rtp-row">
                <span className="admin-slot-label">Drift</span>
                <span className={`admin-slot-value rtp-${rtpClass}`}>
                  {rtpDelta >= 0 ? '+' : ''}{(rtpDelta * 100).toFixed(2)}%
                </span>
              </div>
            </div>

            {/* House PnL */}
            <div className="admin-slot-pnl">
              <div className="admin-slot-rtp-row">
                <span className="admin-slot-label">House PnL</span>
                <span className={`admin-slot-value ${slot.current_pnl_rub >= 0 ? 'pos' : 'neg'}`}>
                  {fmtRub(slot.current_pnl_rub)}
                </span>
              </div>
              <div className="admin-slot-rtp-row">
                <span className="admin-slot-label">Max house deficit</span>
                <span className="admin-slot-value">{fmtRub(slot.max_house_deficit_rub)}</span>
              </div>
              <div className="admin-slot-rtp-row">
                <span className="admin-slot-label">PnL today</span>
                <span className={`admin-slot-value ${slot.pnl_today >= 0 ? 'pos' : 'neg'}`}>
                  {fmtRub(slot.pnl_today)}
                </span>
              </div>
            </div>

            {/* Volumes */}
            <div className="admin-slot-volumes">
              <div className="admin-slot-rtp-row">
                <span className="admin-slot-label">Total games</span>
                <span className="admin-slot-value">{fmtNum(slot.total_games)}</span>
              </div>
              <div className="admin-slot-rtp-row">
                <span className="admin-slot-label">Total wagered</span>
                <span className="admin-slot-value">{fmtRub(slot.total_wagered_rub)}</span>
              </div>
              <div className="admin-slot-rtp-row">
                <span className="admin-slot-label">Total paid out</span>
                <span className="admin-slot-value">{fmtRub(slot.total_paid_rub)}</span>
              </div>
              <div className="admin-slot-rtp-row">
                <span className="admin-slot-label">Rounds today</span>
                <span className="admin-slot-value">{fmtNum(slot.rounds_today)}</span>
              </div>
              <div className="admin-slot-rtp-row">
                <span className="admin-slot-label">Active rounds</span>
                <span className="admin-slot-value">{fmtNum(slot.active_rounds)}</span>
              </div>
            </div>

            {isEditing && (
              <div className="admin-slot-edit">
                <label className="admin-slot-edit-row">
                  <span>Target RTP (e.g. 0.95)</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0.5"
                    max="1.5"
                    value={draft.target_rtp ?? ''}
                    onChange={e => setDraft(d => ({ ...d, target_rtp: e.target.value }))}
                  />
                </label>
                <label className="admin-slot-edit-row">
                  <span>Max house deficit (₽)</span>
                  <input
                    type="number"
                    step="100"
                    min="0"
                    value={draft.max_house_deficit_rub ?? ''}
                    onChange={e => setDraft(d => ({ ...d, max_house_deficit_rub: e.target.value }))}
                  />
                </label>
                <label className="admin-slot-edit-row admin-slot-edit-toggle">
                  <span>Enabled</span>
                  <input
                    type="checkbox"
                    checked={!!draft.enabled}
                    onChange={e => setDraft(d => ({ ...d, enabled: e.target.checked }))}
                  />
                </label>
                <div className="admin-slot-edit-actions">
                  <button className="admin-btn-sm" onClick={cancelEdit} disabled={saving}>Cancel</button>
                  <button className="admin-btn-sm primary" onClick={() => saveEdit(slot.slot_id)} disabled={saving}>
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </div>
            )}

            {/* Maintenance actions */}
            {!isEditing && (
              <div className="admin-slot-maintenance">
                <button
                  className="admin-btn-sm"
                  onClick={async () => {
                    haptic('light')
                    const r = await adminRecomputeSlotStats(slot.slot_id)
                    if (r?.error) alert(`Recompute failed: ${r.error}`)
                    await load()
                  }}
                >
                  Recompute stats
                </button>
                <button
                  className="admin-btn-sm danger"
                  onClick={async () => {
                    if (!confirm(`Wipe ALL rounds for ${slot.slot_id}? This cannot be undone.`)) return
                    haptic('medium')
                    const r = await adminResetSlotStats(slot.slot_id)
                    if (r?.error) alert(`Reset failed: ${r.error}`)
                    await load()
                  }}
                >
                  Hard reset
                </button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
