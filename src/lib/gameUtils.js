import useGameStore from '../store/useGameStore'

/**
 * Update local store stats after a game finishes (PnL, leaderboard, guild).
 * Call this after any game (quiz or blackjack) to keep stats fresh without server refetch.
 */
export function updateLocalStats({ won, stake, userId }) {
  const store = useGameStore.getState()
  const {
    dailyStats, totalPnl, leaderboard, guild, guildMembers, topGuilds, guildSeason,
    setDailyStats, setTotalPnl, setLeaderboard, setGuild, setGuildMembers, setTopGuilds, setGuildSeason,
  } = store

  const payout = won ? Math.floor(stake * 2 * 0.95) : 0
  const pnlChange = won ? (payout - stake) : -stake

  // 1. Daily stats
  const now = new Date()
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const updatedDailyStats = [...dailyStats]
  const todayIdx = updatedDailyStats.findIndex(d => d.date === today)
  if (todayIdx >= 0) {
    updatedDailyStats[todayIdx] = {
      ...updatedDailyStats[todayIdx],
      pnl: updatedDailyStats[todayIdx].pnl + pnlChange,
      games: (updatedDailyStats[todayIdx].games || 0) + 1,
      wins: (updatedDailyStats[todayIdx].wins || 0) + (won ? 1 : 0),
    }
  } else {
    updatedDailyStats.push({ date: today, pnl: pnlChange, games: 1, wins: won ? 1 : 0 })
  }
  setDailyStats(updatedDailyStats)

  // 2. Total PnL
  setTotalPnl(totalPnl + pnlChange)

  // 3. Leaderboard
  if (leaderboard.length > 0) {
    const updatedLb = leaderboard.map(p =>
      p.id === userId
        ? {
            ...p,
            total_pnl: (p.total_pnl || 0) + pnlChange,
            wins: won ? (p.wins || 0) + 1 : (p.wins || 0),
            losses: won ? (p.losses || 0) : (p.losses || 0) + 1,
          }
        : p
    ).sort((a, b) => (b.total_pnl || 0) - (a.total_pnl || 0))
    setLeaderboard(updatedLb)
  }

  // 4. Guild PnL
  if (guild) {
    setGuild({ ...guild, pnl: (guild.pnl || 0) + pnlChange })

    if (guildMembers.length > 0) {
      const updatedMembers = guildMembers.map(m =>
        m.user_id === userId
          ? { ...m, pnl: (m.pnl || 0) + pnlChange }
          : m
      ).sort((a, b) => (b.pnl || 0) - (a.pnl || 0))
      setGuildMembers(updatedMembers)
    }

    if (topGuilds.length > 0) {
      const updatedTopGuilds = topGuilds.map(g =>
        g.id === guild.id
          ? { ...g, pnl: (g.pnl || 0) + pnlChange }
          : g
      ).sort((a, b) => (b.pnl || 0) - (a.pnl || 0))
      setTopGuilds(updatedTopGuilds)
    }
  }

  // 5. Guild season prize pool
  if (guildSeason) {
    const guildFee = Math.floor(stake * 2 * 0.005)
    setGuildSeason({ ...guildSeason, prize_pool: (guildSeason.prize_pool || 0) + guildFee })
  }
}
