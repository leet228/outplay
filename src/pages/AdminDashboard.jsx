import { useState, useEffect, useCallback, useRef } from 'react'
import { getAdminStats, adminSearchUser, getBotStarsBalance } from '../lib/supabase'
import { TON_ADDRESS } from '../lib/addresses'

// ── Blockchain fetchers (same as wallet, but lightweight here) ──
async function fetchTonBalance(addr) {
  try {
    const r = await fetch(`https://toncenter.com/api/v2/getAddressBalance?address=${addr}`)
    if (!r.ok) return 0
    const d = await r.json()
    return d.ok ? Number(BigInt(d.result)) / 1e9 : 0
  } catch { return 0 }
}

async function fetchTonPriceRub() {
  try {
    // CoinLore: TON id=54683, цена в USD
    const r = await fetch('https://api.coinlore.net/api/ticker/?id=54683')
    if (!r.ok) return 270
    const d = await r.json()
    const usdPrice = parseFloat(d[0]?.price_usd) || 0
    if (usdPrice <= 0) return 270
    // Конвертируем USD → RUB через курс ЦБ
    try {
      const rr = await fetch('https://api.exchangerate-api.com/v4/latest/USD')
      if (rr.ok) {
        const rd = await rr.json()
        return usdPrice * (rd.rates?.RUB ?? 90)
      }
    } catch {}
    return usdPrice * 90 // fallback курс
  } catch { return 270 }
}

function fmtNum(n) {
  if (n == null) return '—'
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '\u00A0')
}

function fmtRub(v) {
  return Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '\u00A0') + ' \u20BD'
}

function timeAgo(dateStr) {
  if (!dateStr) return 'never'
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function formatDate(dateStr) {
  if (!dateStr) return '—'
  return new Date(dateStr).toLocaleDateString('ru-RU', {
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

// ── TX type icons ──
function TxIcon({ type }) {
  if (type === 'deposit' || type === 'crypto_deposit') {
    return <span className="admin-tx-icon admin-tx-icon--deposit">{'\u2193'}</span>
  }
  if (type === 'withdrawal') {
    return <span className="admin-tx-icon admin-tx-icon--withdraw">{'\u2191'}</span>
  }
  if (type === 'duel_win' || type === 'duel_loss') {
    return <span className="admin-tx-icon admin-tx-icon--duel">{'\u2694'}</span>
  }
  return <span className="admin-tx-icon">{'\u2022'}</span>
}

export default function AdminDashboard() {
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(true)
  const [revenue, setRevenue] = useState(null)

  // Search
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResult, setSearchResult] = useState(null)
  const [searching, setSearching] = useState(false)
  const debounceRef = useRef(null)

  // Fetch stats + revenue on mount
  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      try {
        const [statsData, tonBal, tonPriceRub, realBotStars] = await Promise.all([
          getAdminStats(),
          fetchTonBalance(TON_ADDRESS),
          fetchTonPriceRub(),
          getBotStarsBalance(),
        ])
        if (cancelled) return
        setStats(statsData)

        if (statsData) {
          const walletRub = tonBal * tonPriceRub
          const depositsTotal = statsData.deposits_total ?? 0
          const cryptoStars = statsData.crypto_deposits_stars ?? 0
          const botStars = realBotStars // real balance from Telegram API
          const userBalances = statsData.total_user_balances ?? 0
          const guildPrizePool = statsData.guild_prize_pool ?? 0
          const totalAssetsRub = botStars + walletRub // 1 star ≈ 1 RUB
          const totalLiabilities = userBalances + guildPrizePool
          const netRevenue = totalAssetsRub - totalLiabilities
          setRevenue({
            botStars,
            cryptoStars,
            depositsTotal,
            walletRub,
            userBalances,
            guildPrizePool,
            totalLiabilities,
            totalAssetsRub,
            netRevenue,
            tonBal,
            tonPriceRub,
          })
        }
      } catch (err) {
        console.error('AdminDashboard load error:', err)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [])

  // Debounced search
  const handleSearch = useCallback((q) => {
    setSearchQuery(q)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (!q.trim()) {
      setSearchResult(null)
      setSearching(false)
      return
    }
    setSearching(true)
    debounceRef.current = setTimeout(async () => {
      try {
        const result = await adminSearchUser(q.trim())
        setSearchResult(result)
      } catch {
        setSearchResult(null)
      } finally {
        setSearching(false)
      }
    }, 300)
  }, [])

  // Cleanup debounce
  useEffect(() => {
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [])

  return (
    <div className="admin-dashboard">
      {/* ── Search bar (top, always visible) ── */}
      <div className="admin-search-section">
        <div className="admin-search-wrap">
          <svg className="admin-search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
          </svg>
          <input
            className="admin-search-input"
            type="text"
            placeholder="Telegram ID, @username or name..."
            value={searchQuery}
            onChange={(e) => handleSearch(e.target.value)}
            inputMode="search"
          />
          {searching && <div className="admin-search-spinner" />}
          {searchQuery && !searching && (
            <button className="admin-search-clear" onClick={() => { setSearchQuery(''); setSearchResult(null) }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6L6 18M6 6l12 12"/>
              </svg>
            </button>
          )}
        </div>

        {/* User result */}
        {searchResult && searchResult.user && (
          <div className="admin-user-result">
            <div className="admin-user-info">
              <div className="admin-user-info-header">
                <div className="admin-user-avatar">
                  {searchResult.user.first_name?.[0]?.toUpperCase() || '?'}
                </div>
                <div className="admin-user-info-main">
                  <span className="admin-user-name">
                    {searchResult.user.first_name}
                    {searchResult.user.is_pro && <span className="admin-user-pro">PRO</span>}
                  </span>
                  <span className="admin-user-username">
                    {searchResult.user.username ? `@${searchResult.user.username}` : 'no username'}
                  </span>
                </div>
              </div>

              <div className="admin-user-details">
                <div className="admin-user-detail-row">
                  <span>Telegram ID</span>
                  <span>{searchResult.user.telegram_id}</span>
                </div>
                <div className="admin-user-detail-row">
                  <span>Balance</span>
                  <span>{fmtNum(searchResult.user.balance)} {'\u2B50'}</span>
                </div>
                <div className="admin-user-detail-row">
                  <span>Wins / Losses</span>
                  <span className="admin-user-wl">
                    <span className="admin-user-wins">{searchResult.user.wins ?? 0}W</span>
                    {' / '}
                    <span className="admin-user-losses">{searchResult.user.losses ?? 0}L</span>
                  </span>
                </div>
                <div className="admin-user-detail-row">
                  <span>Created</span>
                  <span>{formatDate(searchResult.user.created_at)}</span>
                </div>
                <div className="admin-user-detail-row">
                  <span>Last Seen</span>
                  <span>{timeAgo(searchResult.user.last_seen)}</span>
                </div>
              </div>
            </div>

            {/* Transactions */}
            {searchResult.transactions && searchResult.transactions.length > 0 && (
              <div className="admin-tx-section">
                <h4 className="admin-tx-title">
                  Last {searchResult.transactions.length} Transactions
                </h4>
                <div className="admin-tx-list">
                  {searchResult.transactions.map((tx, i) => (
                    <div key={tx.id || i} className="admin-tx-item">
                      <TxIcon type={tx.type} />
                      <div className="admin-tx-info">
                        <span className="admin-tx-type">{tx.type?.replace(/_/g, ' ')}</span>
                        <span className="admin-tx-date">{timeAgo(tx.created_at)}</span>
                      </div>
                      <span className={`admin-tx-amount ${tx.amount >= 0 ? 'positive' : 'negative'}`}>
                        {tx.amount >= 0 ? '+' : ''}{fmtNum(tx.amount)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* No result */}
        {searchResult && !searchResult.user && searchQuery.trim() && !searching && (
          <div className="admin-search-empty">
            No user found
          </div>
        )}
      </div>

      {/* Stats grid */}
      {loading && (
        <div className="admin-stats-grid">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="admin-stat-card admin-skeleton-card" style={{ height: 80 }} />
          ))}
        </div>
      )}

      {stats && !loading && (
        <div className="admin-stats-grid">
          {/* Users */}
          <div className="admin-stat-card">
            <span className="admin-stat-value">{fmtNum(stats.total_users)}</span>
            <span className="admin-stat-label">Total Users</span>
          </div>
          <div className="admin-stat-card">
            <div className="admin-stat-value-row">
              <span className="admin-stat-online-dot" />
              <span className="admin-stat-value">{fmtNum(stats.online_now)}</span>
            </div>
            <span className="admin-stat-label">Online Now</span>
          </div>
          <div className="admin-stat-card">
            <span className="admin-stat-value">{fmtNum(stats.new_today)}</span>
            <span className="admin-stat-label">New Today</span>
          </div>

          {/* Games */}
          <div className="admin-stat-card">
            <span className="admin-stat-value">{fmtNum(stats.total_games)}</span>
            <span className="admin-stat-label">Total Games</span>
          </div>
          <div className="admin-stat-card">
            <span className="admin-stat-value">{fmtNum(stats.active_games)}</span>
            <span className="admin-stat-label">Active Now</span>
          </div>
          <div className="admin-stat-card">
            <span className="admin-stat-value">{fmtNum(stats.games_today)}</span>
            <span className="admin-stat-label">Games Today</span>
          </div>

          {/* Finance */}
          <div className="admin-stat-card">
            <span className="admin-stat-value">{fmtNum(stats.deposits_total)}</span>
            <span className="admin-stat-label">Deposits Total</span>
            <span className="admin-stat-sub">{'\u2B50'} stars</span>
          </div>
          <div className="admin-stat-card">
            <span className="admin-stat-value">{fmtNum(stats.withdrawals_total)}</span>
            <span className="admin-stat-label">Withdrawals</span>
          </div>
          <div className="admin-stat-card">
            <span className="admin-stat-value">{fmtNum(stats.deposits_today)}</span>
            <span className="admin-stat-label">Deposits Today</span>
          </div>

          {/* Pro & Guilds */}
          <div className="admin-stat-card">
            <span className="admin-stat-value">{fmtNum(stats.total_pro)}</span>
            <span className="admin-stat-label">PRO Users</span>
          </div>
          <div className="admin-stat-card">
            <span className="admin-stat-value">{fmtNum(stats.total_guilds)}</span>
            <span className="admin-stat-label">Guilds</span>
          </div>
        </div>
      )}

      {/* Revenue card */}
      {revenue && (
        <div className="admin-revenue-card">
          <div className="admin-revenue-glow" />
          <span className="admin-revenue-label">Net Revenue</span>
          <span className={`admin-revenue-value ${revenue.netRevenue >= 0 ? '' : 'negative'}`}>
            {fmtRub(revenue.netRevenue)}
          </span>

          {/* Assets */}
          <div className="admin-revenue-breakdown">
            <div className="admin-revenue-group-title">Assets</div>

            <div className="admin-revenue-row">
              <span>{'\u2B50'} Bot Stars Balance</span>
              <span className="admin-revenue-highlight">{fmtNum(revenue.botStars)} {'\u2B50'}</span>
            </div>
            <div className="admin-revenue-row admin-revenue-row-sub">
              <span>Stars deposits</span>
              <span>{fmtNum(revenue.depositsTotal - revenue.cryptoStars)}</span>
            </div>
            {revenue.cryptoStars > 0 && (
              <div className="admin-revenue-row admin-revenue-row-sub">
                <span>Crypto deposits (not in bot)</span>
                <span>{fmtNum(revenue.cryptoStars)}</span>
              </div>
            )}

            <div className="admin-revenue-row" style={{ marginTop: 6 }}>
              <span>{'\uD83D\uDC8E'} TON Wallet</span>
              <span className="admin-revenue-highlight">{fmtRub(revenue.walletRub)}</span>
            </div>
            <div className="admin-revenue-row admin-revenue-row-sub">
              <span>{revenue.tonBal.toFixed(4)} TON × {fmtNum(Math.round(revenue.tonPriceRub))} {'\u20BD'}</span>
              <span></span>
            </div>

            <div className="admin-revenue-total-row">
              <span>Total Assets</span>
              <span>{fmtRub(revenue.totalAssetsRub)}</span>
            </div>
          </div>

          {/* Liabilities */}
          <div className="admin-revenue-breakdown">
            <div className="admin-revenue-group-title">Liabilities</div>
            <div className="admin-revenue-row">
              <span>{'\uD83D\uDC64'} Player Balances</span>
              <span className="admin-revenue-negative">{fmtNum(revenue.userBalances)} {'\u2B50'}</span>
            </div>
            {revenue.guildPrizePool > 0 && (
              <div className="admin-revenue-row">
                <span>{'\uD83C\uDFC6'} Guild Prize Pool</span>
                <span className="admin-revenue-negative">{fmtNum(revenue.guildPrizePool)} {'\u2B50'}</span>
              </div>
            )}
            <div className="admin-revenue-total-row">
              <span>Total Liabilities</span>
              <span>{fmtNum(revenue.totalLiabilities)} {'\u2B50'}</span>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}
