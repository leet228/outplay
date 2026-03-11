import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabase = createClient(supabaseUrl, supabaseAnonKey)

// Users
export async function getOrCreateUser(telegramUser) {
  const { data: existing } = await supabase
    .from('users')
    .select('*')
    .eq('telegram_id', telegramUser.id)
    .single()

  if (existing) {
    // Синхронизируем профиль — имя/username/аватар могли смениться
    const { data: updated } = await supabase
      .from('users')
      .update({
        first_name: telegramUser.first_name,
        username: telegramUser.username ?? null,
        avatar_url: telegramUser.photo_url ?? null,
        last_seen: new Date().toISOString(),
      })
      .eq('telegram_id', telegramUser.id)
      .select()
      .single()
    return updated
  }

  // Новый пользователь
  const { data: newUser } = await supabase
    .from('users')
    .insert({
      telegram_id: telegramUser.id,
      username: telegramUser.username ?? null,
      first_name: telegramUser.first_name,
      avatar_url: telegramUser.photo_url ?? null,
      balance: 0,
    })
    .select()
    .single()

  return newUser
}

export async function pingOnline(userId) {
  await supabase.from('users').update({ last_seen: new Date().toISOString() }).eq('id', userId)
}

export async function getUserBalance(userId) {
  const { data } = await supabase
    .from('users')
    .select('balance')
    .eq('id', userId)
    .single()
  return data?.balance ?? 0
}

export async function updateBalance(userId, delta) {
  const { data } = await supabase.rpc('increment_balance', {
    user_id: userId,
    amount: delta,
  })
  return data
}

// Rank — считаем сколько юзеров с балансом выше
export async function getUserRank(balance) {
  const { count } = await supabase
    .from('users')
    .select('*', { count: 'exact', head: true })
    .gt('balance', balance)
  return (count ?? 0) + 1
}

// Profile — single RPC (rank + daily_stats + total_pnl)
export async function getUserProfile(userId, days = 30) {
  const { data, error } = await supabase.rpc('get_user_profile', {
    p_user_id: userId,
    p_days: days,
  })
  if (error) {
    console.error('getUserProfile error:', error)
    return null
  }
  return data
}

// Sync settings to DB — fire-and-forget
export function syncUserSettings(userId, settings) {
  supabase
    .from('users')
    .update(settings)
    .eq('id', userId)
    .then(({ error }) => {
      if (error) console.error('syncUserSettings error:', error)
    })
}

// Plans — PRO subscription options from DB
export async function getPlans() {
  const { data, error } = await supabase
    .from('plans')
    .select('id, months, price, per_month, savings')
    .eq('is_active', true)
    .order('months', { ascending: true })
  if (error) { console.error('getPlans error:', error); return [] }
  return data ?? []
}

// Referrals list with per-period earnings (paginated)
export async function getReferralsList(userId, limit = 50, offset = 0) {
  const { data, error } = await supabase.rpc('get_referrals_list', {
    p_user_id: userId,
    p_limit:   limit,
    p_offset:  offset,
  })
  if (error) { console.error('getReferralsList error:', error); return { total: 0, items: [] } }
  return data ?? { total: 0, items: [] }
}

// Leaderboard
export async function getLeaderboard(limit = 50) {
  const { data } = await supabase
    .from('users')
    .select('id, first_name, username, avatar_url, balance, wins, losses')
    .order('balance', { ascending: false })
    .limit(limit)
  return data ?? []
}

// Guild data — user's guild + top guilds + season (single RPC)
export async function getGuildData(userId) {
  const { data, error } = await supabase.rpc('get_guild_data', { p_user_id: userId })
  if (error) { console.error('getGuildData error:', error); return null }
  return data
}

// Recent opponents from finished duels
export async function getRecentOpponents(userId, limit = 20) {
  const { data, error } = await supabase.rpc('get_recent_opponents', {
    p_user_id: userId,
    p_limit: limit,
  })
  if (error) { console.error('getRecentOpponents error:', error); return [] }
  return data ?? []
}

// Search guilds by name (on-demand, FindGuildSheet)
export async function searchGuilds(query, limit = 20) {
  const { data, error } = await supabase.rpc('search_guilds', {
    p_query: query,
    p_limit: limit,
  })
  if (error) { console.error('searchGuilds error:', error); return [] }
  return data ?? []
}

// Guild operations (wrappers for existing RPCs)
export async function createGuild(userId, name, description, avatarUrl) {
  const { data, error } = await supabase.rpc('create_guild', {
    p_user_id: userId,
    p_name: name,
    p_description: description || '',
    p_avatar_url: avatarUrl || null,
  })
  if (error) { console.error('createGuild error:', error); return { error: error.message } }
  return data
}

export async function joinGuild(userId, guildId) {
  const { data, error } = await supabase.rpc('join_guild', {
    p_user_id: userId,
    p_guild_id: guildId,
  })
  if (error) { console.error('joinGuild error:', error); return { error: error.message } }
  return data
}

export async function kickFromGuild(creatorId, targetId, guildId) {
  const { data, error } = await supabase.rpc('kick_from_guild', {
    p_creator_id: creatorId,
    p_target_id: targetId,
    p_guild_id: guildId,
  })
  if (error) { console.error('kickFromGuild error:', error); return { error: error.message } }
  return data
}

export async function editGuild(userId, guildId, name, description, avatarUrl) {
  const { data, error } = await supabase.rpc('edit_guild', {
    p_user_id: userId,
    p_guild_id: guildId,
    p_name: name || null,
    p_description: description || null,
    p_avatar_url: avatarUrl || null,
  })
  if (error) { console.error('editGuild error:', error); return { error: error.message } }
  return data
}

export async function leaveGuild(userId) {
  const { data, error } = await supabase.rpc('leave_guild', { p_user_id: userId })
  if (error) { console.error('leaveGuild error:', error); return { error: error.message } }
  return data
}

// Friends — single RPC for all friends data (bootstrap)
export async function getFriendsData(userId) {
  const { data, error } = await supabase.rpc('get_friends_data', { p_user_id: userId })
  if (error) { console.error('getFriendsData error:', error); return null }
  return data
}

// Search users globally (for "Find friends" mode)
export async function searchUsers(userId, query, limit = 20) {
  const { data, error } = await supabase.rpc('search_users', {
    p_user_id: userId,
    p_query: query,
    p_limit: limit,
  })
  if (error) { console.error('searchUsers error:', error); return [] }
  return data ?? []
}

// Send friend request
export async function sendFriendRequest(fromId, toId) {
  const { data, error } = await supabase.rpc('send_friend_request', {
    p_from_id: fromId,
    p_to_id: toId,
  })
  if (error) { console.error('sendFriendRequest error:', error); return { error: error.message } }
  return data
}

// Accept friend request
export async function acceptFriendRequest(userId, requestId) {
  const { data, error } = await supabase.rpc('accept_friend_request', {
    p_user_id: userId,
    p_request_id: requestId,
  })
  if (error) { console.error('acceptFriendRequest error:', error); return { error: error.message } }
  return data
}

// Reject friend request
export async function rejectFriendRequest(userId, requestId) {
  const { data, error } = await supabase.rpc('reject_friend_request', {
    p_user_id: userId,
    p_request_id: requestId,
  })
  if (error) { console.error('rejectFriendRequest error:', error); return { error: error.message } }
  return data
}

// Remove friend
export async function removeFriend(userId, friendId) {
  const { data, error } = await supabase.rpc('remove_friend', {
    p_user_id: userId,
    p_friend_id: friendId,
  })
  if (error) { console.error('removeFriend error:', error); return { error: error.message } }
  return data
}
