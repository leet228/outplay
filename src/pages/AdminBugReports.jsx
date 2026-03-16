import { useState, useEffect, useCallback } from 'react'
import { getBugReports, updateBugReportStatus } from '../lib/supabase'
import { haptic } from '../lib/telegram'

const STATUSES = ['all', 'new', 'seen', 'resolved', 'closed']
const NEXT_STATUS = { new: 'seen', seen: 'resolved', resolved: 'closed', closed: 'new' }
const STATUS_COLORS = {
  new: '#3b82f6',
  seen: '#eab308',
  resolved: '#22c55e',
  closed: '#6b7280',
}

function timeAgo(dateStr) {
  if (!dateStr) return '—'
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export default function AdminBugReports() {
  const [reports, setReports] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all')
  const [expanded, setExpanded] = useState(null)
  const [updating, setUpdating] = useState({})

  const loadReports = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getBugReports(filter === 'all' ? null : filter)
      setReports(data || [])
    } catch (err) {
      console.error('Load bug reports error:', err)
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => { loadReports() }, [loadReports])

  async function handleStatusChange(reportId, currentStatus) {
    const newStatus = NEXT_STATUS[currentStatus]
    if (!newStatus) return
    haptic('light')
    setUpdating(prev => ({ ...prev, [reportId]: true }))
    try {
      const result = await updateBugReportStatus(reportId, newStatus)
      if (!result?.error) {
        setReports(prev => prev.map(r =>
          r.id === reportId ? { ...r, status: newStatus } : r
        ))
      }
    } catch (err) {
      console.error('Status update error:', err)
    } finally {
      setUpdating(prev => ({ ...prev, [reportId]: false }))
    }
  }

  const newCount = reports.filter(r => r.status === 'new').length

  return (
    <div className="admin-reports">
      {/* Filter tabs */}
      <div className="admin-reports-filters">
        {STATUSES.map(s => (
          <button
            key={s}
            className={`admin-reports-filter ${filter === s ? 'active' : ''}`}
            onClick={() => { haptic('light'); setFilter(s) }}
          >
            {s === 'all' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
            {s === 'new' && newCount > 0 && (
              <span className="admin-reports-badge">{newCount}</span>
            )}
          </button>
        ))}
      </div>

      {/* Loading */}
      {loading && (
        <div className="admin-reports-loading">
          {[1, 2, 3].map(i => (
            <div key={i} className="admin-report-skeleton" />
          ))}
        </div>
      )}

      {/* Empty */}
      {!loading && reports.length === 0 && (
        <div className="admin-reports-empty">
          <span className="admin-reports-empty-icon">📭</span>
          <span>No reports{filter !== 'all' ? ` with status "${filter}"` : ''}</span>
        </div>
      )}

      {/* Reports */}
      {!loading && reports.map(report => (
        <div
          key={report.id}
          className="admin-report-card"
          onClick={() => setExpanded(expanded === report.id ? null : report.id)}
        >
          <div className="admin-report-header">
            <div className="admin-report-user">
              <span className="admin-report-username">
                {report.username ? `@${report.username}` : report.first_name || 'Unknown'}
              </span>
              <span className="admin-report-tgid">#{report.telegram_id}</span>
            </div>
            <div className="admin-report-meta">
              <span className="admin-report-time">{timeAgo(report.created_at)}</span>
              <button
                className="admin-report-status"
                style={{ background: `${STATUS_COLORS[report.status]}22`, color: STATUS_COLORS[report.status] }}
                onClick={(e) => { e.stopPropagation(); handleStatusChange(report.id, report.status) }}
                disabled={updating[report.id]}
              >
                {updating[report.id] ? '...' : report.status}
              </button>
            </div>
          </div>

          <div className="admin-report-desc">{report.description}</div>

          {/* Photos */}
          {report.photos && report.photos.length > 0 && (
            <div className="admin-report-photos">
              {report.photos.map((url, i) => (
                <a key={i} href={url} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}>
                  <img src={url} alt={`Photo ${i + 1}`} className="admin-report-photo" />
                </a>
              ))}
            </div>
          )}

          {/* Expanded details */}
          {expanded === report.id && (
            <div className="admin-report-details">
              {report.device_info && (
                <div className="admin-report-detail-row">
                  <span className="admin-report-detail-label">Device</span>
                  <span className="admin-report-detail-value">{report.device_info}</span>
                </div>
              )}
              <div className="admin-report-detail-row">
                <span className="admin-report-detail-label">Version</span>
                <span className="admin-report-detail-value">{report.app_version || '—'}</span>
              </div>
              {report.context && Object.keys(report.context).length > 0 && (
                <div className="admin-report-detail-row">
                  <span className="admin-report-detail-label">Context</span>
                  <pre className="admin-report-context">{JSON.stringify(report.context, null, 2)}</pre>
                </div>
              )}
              <div className="admin-report-detail-row">
                <span className="admin-report-detail-label">ID</span>
                <span className="admin-report-detail-value" style={{ fontSize: '11px', opacity: 0.6 }}>{report.id}</span>
              </div>
            </div>
          )}
        </div>
      ))}

      {/* Refresh */}
      <button className="admin-reports-refresh" onClick={() => { haptic('medium'); loadReports() }}>
        Refresh
      </button>
    </div>
  )
}
