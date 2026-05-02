import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabase = createClient(supabaseUrl, supabaseAnonKey)

// ── Retry wrapper for Supabase RPC calls ──
// Retries transient errors (network, timeout, 5xx) with exponential backoff
// Does NOT retry business logic errors (insufficient_balance, etc.)
async function rpcWithRetry(fnName, params, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const { data, error } = await supabase.rpc(fnName, params)
      if (error) {
        const isTransient = error.message?.includes('fetch') ||
          error.message?.includes('network') ||
          error.message?.includes('Failed to fetch') ||
          error.message?.includes('connection') ||
          error.message?.includes('timeout') ||
          error.code === 'PGRST301' ||
          error.code === '57014' ||
          error.code === '500' ||
          error.code === '502' ||
          error.code === '503'
        if (isTransient && attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)))
          continue
        }
        // Non-transient or last attempt — return error
        return { data: null, error }
      }
      return { data, error: null }
    } catch (e) {
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)))
        continue
      }
      return { data: null, error: { message: e.message || 'network_error' } }
    }
  }
  return { data: null, error: { message: 'max_retries_exceeded' } }
}

// ── Retry wrapper for Supabase queries (select/update/insert) ──
async function queryWithRetry(fn, maxRetries = 1) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn()
      if (result.error) {
        const msg = result.error.message || ''
        const isTransient = msg.includes('fetch') || msg.includes('network') ||
          msg.includes('Failed to fetch') || msg.includes('timeout')
        if (isTransient && attempt < maxRetries) {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)))
          continue
        }
      }
      return result
    } catch (e) {
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)))
        continue
      }
      return { data: null, error: { message: e.message || 'network_error' } }
    }
  }
  return { data: null, error: { message: 'max_retries_exceeded' } }
}

// PRO commission helper: PRO users pay 2.5% rake, regular 5%
export function calcPayout(stake, isPro) {
  const mult = isPro ? 0.975 : 0.95
  return Math.floor(stake * 2 * mult)
}

// PRO subscription purchase (via RPC to avoid RLS issues)
export async function purchasePro(userId, planPrice, planMonths) {
  const { data, error } = await supabase.rpc('purchase_pro', {
    p_user_id: userId,
    p_price: planPrice,
    p_months: planMonths,
  })

  if (error) {
    console.error('purchasePro error:', error)
    return { error: 'internal_error' }
  }

  if (data?.error) return { error: data.error }
  return { ok: true, newBalance: data.new_balance }
}

// Users
export async function getOrCreateUser(telegramUser, referrerId = null) {
  const { data: existing } = await supabase
    .from('users')
    .select('*')
    .eq('telegram_id', telegramUser.id)
    .maybeSingle()

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

  // Новый пользователь с реферальной ссылкой — атомарная регистрация
  if (referrerId) {
    try {
      const { data, error } = await supabase.rpc('register_with_referral', {
        p_telegram_id: telegramUser.id,
        p_username: telegramUser.username ?? null,
        p_first_name: telegramUser.first_name,
        p_avatar_url: telegramUser.photo_url ?? null,
        p_referrer_id: referrerId,
      })
      if (!error && data?.user) return data.user
      console.error('register_with_referral error:', error)
    } catch (e) {
      console.error('register_with_referral exception:', e)
    }
  }

  // Новый пользователь без реферала (или fallback)
  const { data: newUser } = await supabase
    .from('users')
    .insert({
      telegram_id: telegramUser.id,
      username: telegramUser.username ?? null,
      first_name: telegramUser.first_name,
      avatar_url: telegramUser.photo_url ?? null,
      balance: 50,
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
  const { data, error } = await rpcWithRetry('get_user_profile', {
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
  const { data, error } = await queryWithRetry(() =>
    supabase.from('plans').select('id, months, price, per_month, savings')
      .eq('is_active', true).order('months', { ascending: true })
  )
  if (error) { console.error('getPlans error:', error); return [] }
  return data ?? []
}

// Referrals list with per-period earnings (paginated)
export async function getReferralsList(userId, limit = 50, offset = 0) {
  const { data, error } = await rpcWithRetry('get_referrals_list', {
    p_user_id: userId,
    p_limit:   limit,
    p_offset:  offset,
  })
  if (error) { console.error('getReferralsList error:', error); return { total: 0, items: [] } }
  return data ?? { total: 0, items: [] }
}

// Leaderboard (ranked by real PnL from duels, not balance)
export async function getLeaderboard(limit = 50) {
  const { data, error } = await rpcWithRetry('get_leaderboard', { p_limit: limit })
  if (error) { console.error('getLeaderboard error:', error); return [] }
  return data ?? []
}

// Guild data — user's guild + top guilds + season (single RPC)
export async function getGuildData(userId) {
  const { data, error } = await rpcWithRetry('get_guild_data', { p_user_id: userId })
  if (error) { console.error('getGuildData error:', error); return null }
  return data
}

// Recent opponents from finished duels
export async function getRecentOpponents(userId, limit = 20) {
  const { data, error } = await rpcWithRetry('get_recent_opponents', {
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

export async function deleteGuild(userId, guildId) {
  const { data, error } = await supabase.rpc('delete_guild', {
    p_user_id: userId,
    p_guild_id: guildId,
  })
  if (error) { console.error('deleteGuild error:', error); return { error: error.message } }
  return data
}

// Friends — single RPC for all friends data (bootstrap)
export async function getFriendsData(userId) {
  const { data, error } = await rpcWithRetry('get_friends_data', { p_user_id: userId })
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

// ── Game Invites ──

export async function sendGameInvite(fromId, toId, gameType, stake) {
  const { data, error } = await supabase.rpc('send_game_invite', {
    p_from_id: fromId, p_to_id: toId, p_game_type: gameType, p_stake: stake,
  })
  if (error) { console.error('sendGameInvite error:', error); return { error: error.message } }
  return data
}

export async function acceptGameInvite(inviteId, userId) {
  const { data, error } = await supabase.rpc('accept_game_invite', {
    p_invite_id: inviteId, p_user_id: userId,
  })
  if (error) { console.error('acceptGameInvite error:', error); return { error: error.message } }
  return data
}

export async function rejectGameInvite(inviteId, userId) {
  const { data, error } = await supabase.rpc('reject_game_invite', {
    p_invite_id: inviteId, p_user_id: userId,
  })
  if (error) { console.error('rejectGameInvite error:', error); return { error: error.message } }
  return data
}

export async function cancelGameInvite(inviteId, userId) {
  const { data, error } = await supabase.rpc('cancel_game_invite', {
    p_invite_id: inviteId, p_user_id: userId,
  })
  if (error) { console.error('cancelGameInvite error:', error); return { error: error.message } }
  return data
}

export async function cancelAllPendingInvites(userId) {
  const { error } = await supabase.rpc('cancel_all_pending_invites', { p_user_id: userId })
  if (error) console.error('cancelAllPendingInvites error:', error)
}

export async function getPendingInvites(userId) {
  const { data, error } = await queryWithRetry(() =>
    supabase.from('game_invites').select('*')
      .eq('to_id', userId).eq('status', 'pending')
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
  )
  if (error) { console.error('getPendingInvites error:', error); return [] }
  return data || []
}

// ── Withdrawals ──

export async function requestWithdrawal(userId, amountRub, tonAddress, memo) {
  const { data, error } = await supabase.rpc('request_withdrawal', {
    p_user_id: userId,
    p_amount_rub: amountRub,
    p_ton_address: tonAddress,
    p_memo: memo || '',
  })
  if (error) throw error

  // Fire-and-forget: ping Edge Function to process immediately (don't wait for cron)
  supabase.functions.invoke('process-withdrawals').catch(() => {})

  return data
}

export async function adminRequestWithdrawal(adminUserId, tonAddress, tonAmount, memo) {
  const { data, error } = await supabase.rpc('admin_request_withdrawal', {
    p_admin_user_id: adminUserId,
    p_ton_address: tonAddress,
    p_ton_amount: tonAmount,
    p_memo: memo || '',
  })
  if (error) throw error

  supabase.functions.invoke('process-withdrawals').catch(() => {})

  return data
}

// ── Deposits ──

export async function createStarsInvoice(userId, amount, currencyAmount, currencyCode) {
  const { data, error } = await supabase.functions.invoke('create-stars-invoice', {
    body: { user_id: userId, amount, currency_amount: currencyAmount, currency_code: currencyCode },
  })
  if (error) { console.error('createStarsInvoice error:', error); return null }
  return data // { url, tx_id }
}

export async function processDeposit(userId, amount, txId, currencyAmount, currencyCode) {
  const params = {
    p_user_id: userId,
    p_amount: amount,
    p_tx_id: txId,
  }
  if (currencyAmount != null) params.p_currency_amt = currencyAmount
  if (currencyCode) params.p_currency_code = currencyCode
  const { data, error } = await supabase.rpc('process_deposit', params)
  if (error) { console.error('processDeposit error:', error); return null }
  return data
}

// ── Admin ──

export async function getAppSettings() {
  const { data, error } = await rpcWithRetry('get_app_settings')
  if (error) { console.error('getAppSettings error:', error); return null }
  return data
}

export async function getBootstrapData(userId, days = 30, leaderboardLimit = 10, recentOpponentsLimit = 20) {
  const { data, error } = await rpcWithRetry('get_bootstrap_data', {
    p_user_id: userId,
    p_days: days,
    p_leaderboard_limit: leaderboardLimit,
    p_recent_opponents_limit: recentOpponentsLimit,
  })
  if (error) { console.error('getBootstrapData error:', error); return null }
  return data
}

export async function getBootstrapCriticalData(userId) {
  const { data, error } = await rpcWithRetry('get_bootstrap_critical_data', {
    p_user_id: userId,
  })
  if (error) { console.error('getBootstrapCriticalData error:', error); return null }
  return data
}

export async function getBootstrapDeferredData(userId, days = 30, leaderboardLimit = 10, recentOpponentsLimit = 20) {
  const { data, error } = await rpcWithRetry('get_bootstrap_deferred_data', {
    p_user_id: userId,
    p_days: days,
    p_leaderboard_limit: leaderboardLimit,
    p_recent_opponents_limit: recentOpponentsLimit,
  })
  if (error) { console.error('getBootstrapDeferredData error:', error); return null }
  return data
}

export async function updateAppSetting(key, value) {
  const { error } = await supabase.rpc('update_app_setting', { p_key: key, p_value: value })
  if (error) { console.error('updateAppSetting error:', error); return false }
  return true
}

export async function getAdminStats() {
  const { data, error } = await supabase.rpc('get_admin_stats')
  if (error) { console.error('getAdminStats error:', error); return null }
  return data
}

export async function adminSearchUser(query) {
  const { data, error } = await supabase.rpc('admin_search_user', { p_query: query })
  if (error) { console.error('adminSearchUser error:', error); return null }
  return data
}

export async function getAdminServerInfo() {
  const { data, error } = await supabase.rpc('get_admin_server_info')
  if (error) { console.error('getAdminServerInfo error:', error); return null }
  return data
}

export async function getBotStarsBalance() {
  try {
    const res = await supabase.functions.invoke('get-bot-stars-balance')
    return res.data?.balance ?? 0
  } catch (e) {
    console.error('getBotStarsBalance error:', e)
    return 0
  }
}

// ── Bot ─────────────────────────────────────────
export const BOT_USER_ID = '00000000-0000-0000-0000-000000000001'

export async function createBotDuel(userId, category, stakes, gameType = 'quiz') {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { data, error } = await supabase.rpc('create_bot_duel', {
        p_user_id: userId,
        p_category: category,
        p_stakes: stakes,
        p_game_type: gameType,
      })
      if (error) {
        console.error(`createBotDuel attempt ${attempt + 1} error:`, error)
        // Transient errors — retry
        if (attempt < 2 && (error.message?.includes('fetch') || error.message?.includes('network') || error.message?.includes('connection') || error.code === 'PGRST301' || error.code === '57014')) {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)))
          continue
        }
        return null
      }
      return data
    } catch (e) {
      console.error(`createBotDuel attempt ${attempt + 1} exception:`, e)
      if (attempt < 2) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)))
        continue
      }
      return null
    }
  }
  return null
}

// ── Matchmaking ─────────────────────────────────
export async function findMatch(userId, category, stakes, gameType = 'quiz') {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { data, error } = await supabase.rpc('find_match', {
        p_user_id: userId,
        p_category: category,
        p_stakes: stakes,
        p_game_type: gameType,
      })
      if (error) {
        // Transient errors (network/timeout) — retry once
        if (attempt === 0 && (error.message?.includes('fetch') || error.message?.includes('network') || error.code === 'PGRST301' || error.code === '57014')) {
          await new Promise(r => setTimeout(r, 800))
          continue
        }
        console.error('findMatch error:', error)
        return { status: 'error', error: error.message || 'server_error' }
      }
      return data
    } catch (e) {
      if (attempt === 0) {
        await new Promise(r => setTimeout(r, 800))
        continue
      }
      console.error('findMatch exception:', e)
      return { status: 'error', error: 'network_error' }
    }
  }
}

export async function cancelMatchmaking(userId) {
  const { error } = await supabase.rpc('cancel_matchmaking', { p_user_id: userId })
  if (error) console.error('cancelMatchmaking error:', error)
}

export async function submitAnswer(duelId, userId, questionIndex, answerIndex, isCorrect, timeSpent) {
  const { data, error } = await supabase.rpc('submit_answer', {
    p_duel_id: duelId,
    p_user_id: userId,
    p_question_index: questionIndex,
    p_answer_index: answerIndex,
    p_is_correct: isCorrect,
    p_time_spent: timeSpent,
  })
  if (error) { console.error('submitAnswer error:', error); return null }
  return data
}

export async function submitQuizResult(duelId, userId, score, time) {
  const { data, error } = await supabase.rpc('submit_quiz_result', {
    p_duel_id: duelId,
    p_user_id: userId,
    p_score: score,
    p_time: time,
  })
  if (error) { console.error('submitQuizResult error:', error); return null }
  return data
}

export async function finalizeDuel(duelId) {
  const { data, error } = await supabase.rpc('finalize_duel', { p_duel_id: duelId })
  if (error) { console.error('finalizeDuel error:', error); return null }
  return data
}

// ── Heartbeat & Forfeit ──

export function heartbeatDuel(duelId, userId) {
  // Fire-and-forget — не ждём ответа, не ретраим
  supabase.rpc('heartbeat_duel', { p_duel_id: duelId, p_user_id: userId })
    .then(({ error }) => { if (error) console.error('heartbeat error:', error) })
}

export async function forfeitDuel(duelId, userId) {
  const { data, error } = await supabase.rpc('forfeit_duel', { p_duel_id: duelId, p_user_id: userId })
  if (error) { console.error('forfeitDuel error:', error); return null }
  return data
}

export async function claimForfeit(duelId, userId) {
  const { data, error } = await supabase.rpc('claim_forfeit', { p_duel_id: duelId, p_user_id: userId })
  if (error) { console.error('claimForfeit error:', error); return null }
  return data
}

export async function getDuelState(duelId, columns = '*') {
  const { data, error } = await supabase
    .from('duels')
    .select(columns)
    .eq('id', duelId)
    .single()
  if (error) { console.error('getDuelState error:', error); return null }
  return data
}

export function subscribeToDuelUpdates(duelId, callback, event = 'UPDATE') {
  const channel = supabase
    .channel(`duel-${duelId}-${Math.random().toString(36).slice(2, 8)}`)
    .on('postgres_changes', {
      event,
      schema: 'public',
      table: 'duels',
      filter: `id=eq.${duelId}`,
    }, payload => {
      callback(payload.new, payload)
    })
    .subscribe()
  return channel
}

export async function waitForFinishedDuelState({
  duelId,
  userId,
  columns = '*',
  timeoutMs = 90000,
  forfeitCheckMs = 10000,
  fallbackPollMs = 15000,
} = {}) {
  return await new Promise((resolve) => {
    let settled = false
    let channel = null
    let timeoutId = null
    let forfeitIntervalId = null
    let fallbackPollId = null

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId)
      if (forfeitIntervalId) clearInterval(forfeitIntervalId)
      if (fallbackPollId) clearInterval(fallbackPollId)
      if (channel) supabase.removeChannel(channel)
    }

    const finish = (value) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }

    const fetchLatest = async () => {
      const duel = await getDuelState(duelId, columns)
      if (duel?.status === 'finished') {
        finish(duel)
        return duel
      }
      return duel
    }

    channel = subscribeToDuelUpdates(duelId, (duel) => {
      if (duel?.status === 'finished') {
        finish(duel)
      }
    })

    fetchLatest().catch(() => {})

    fallbackPollId = setInterval(() => {
      fetchLatest().catch(() => {})
    }, fallbackPollMs)

    if (userId) {
      forfeitIntervalId = setInterval(async () => {
        if (settled) return
        const res = await claimForfeit(duelId, userId)
        if (res?.status === 'forfeited') {
          const duel = await getDuelState(duelId, columns)
          finish(duel)
        }
      }, forfeitCheckMs)
    }

    timeoutId = setTimeout(async () => {
      const duel = await getDuelState(duelId, columns)
      finish(duel?.status === 'finished' ? duel : null)
    }, timeoutMs)
  })
}

// ── Sequence ────────────────────────────────────
export async function getSequenceDuel(duelId) {
  const { data, error } = await supabase
    .from('duels')
    .select('id, creator_id, opponent_id, stake, status, is_bot_game, bot_should_win, game_type, creator_score, opponent_score, winner_id')
    .eq('id', duelId)
    .single()
  if (error) { console.error('getSequenceDuel error:', error); return null }
  return data
}

export async function submitSequenceResult(duelId, userId, score, time) {
  const { data, error } = await supabase.rpc('submit_sequence_result', {
    p_duel_id: duelId,
    p_user_id: userId,
    p_score: score,
    p_time: time,
  })
  if (error) { console.error('submitSequenceResult error:', error); return null }
  return data
}

// ── Reaction ───────────────────────────────────
export async function getReactionDuel(duelId) {
  const { data, error } = await supabase
    .from('duels')
    .select('id, creator_id, opponent_id, stake, status, is_bot_game, bot_should_win, game_type, creator_score, opponent_score, winner_id, creator_time, opponent_time')
    .eq('id', duelId)
    .single()
  if (error) { console.error('getReactionDuel error:', error); return null }
  return data
}

export async function submitReactionResult(duelId, userId, score, time) {
  const { data, error } = await supabase.rpc('submit_reaction_result', {
    p_duel_id: duelId,
    p_user_id: userId,
    p_score: score,
    p_time: time,
  })
  if (error) { console.error('submitReactionResult error:', error); return null }
  return data
}

// ── Hearing ────────────────────────────────────
export async function getHearingDuel(duelId) {
  const { data, error } = await supabase
    .from('duels')
    .select('id, creator_id, opponent_id, stake, status, is_bot_game, bot_should_win, game_type, creator_score, opponent_score, winner_id, creator_time, opponent_time')
    .eq('id', duelId)
    .single()
  if (error) { console.error('getHearingDuel error:', error); return null }
  return data
}

export async function submitHearingResult(duelId, userId, score, time) {
  const { data, error } = await supabase.rpc('submit_hearing_result', {
    p_duel_id: duelId,
    p_user_id: userId,
    p_score: score,
    p_time: time,
  })
  if (error) { console.error('submitHearingResult error:', error); return null }
  return data
}

// ── Gradient ───────────────────────────────────
export async function getGradientDuel(duelId) {
  const { data, error } = await supabase
    .from('duels')
    .select('id, creator_id, opponent_id, stake, status, is_bot_game, bot_should_win, game_type, creator_score, opponent_score, winner_id, creator_time, opponent_time')
    .eq('id', duelId)
    .single()
  if (error) { console.error('getGradientDuel error:', error); return null }
  return data
}

export async function submitGradientResult(duelId, userId, score, time) {
  const { data, error } = await supabase.rpc('submit_gradient_result', {
    p_duel_id: duelId,
    p_user_id: userId,
    p_score: score,
    p_time: time,
  })
  if (error) { console.error('submitGradientResult error:', error); return null }
  return data
}

// ── Race ───────────────────────────────────────
export async function getRaceDuel(duelId) {
  const { data, error } = await supabase
    .from('duels')
    .select('id, creator_id, opponent_id, stake, status, is_bot_game, bot_should_win, game_type, creator_score, opponent_score, winner_id, creator_time, opponent_time')
    .eq('id', duelId)
    .single()
  if (error) { console.error('getRaceDuel error:', error); return null }
  return data
}

export async function submitRaceResult(duelId, userId, score, time) {
  const { data, error } = await supabase.rpc('submit_race_result', {
    p_duel_id: duelId,
    p_user_id: userId,
    p_score: score,
    p_time: time,
  })
  if (error) { console.error('submitRaceResult error:', error); return null }
  return data
}

// ── Capitals ───────────────────────────────────
export async function getCapitalsDuel(duelId) {
  const { data, error } = await supabase
    .from('duels')
    .select('id, creator_id, opponent_id, stake, status, is_bot_game, bot_should_win, game_type, creator_score, opponent_score, winner_id, creator_time, opponent_time, capitals_seed')
    .eq('id', duelId)
    .single()
  if (error) { console.error('getCapitalsDuel error:', error); return null }
  return data
}

export async function submitCapitalsResult(duelId, userId, score, time) {
  const { data, error } = await supabase.rpc('submit_capitals_result', {
    p_duel_id: duelId,
    p_user_id: userId,
    p_score: score,
    p_time: time,
  })
  if (error) { console.error('submitCapitalsResult error:', error); return null }
  return data
}

// ── Blackjack ───────────────────────────────────
export async function getCircleDuel(duelId) {
  const { data, error } = await supabase
    .from('duels')
    .select('id, creator_id, opponent_id, stake, status, is_bot_game, bot_should_win, game_type, creator_score, opponent_score, winner_id, creator_time, opponent_time')
    .eq('id', duelId)
    .single()
  if (error) { console.error('getCircleDuel error:', error); return null }
  return data
}

export async function submitCircleResult(duelId, userId, score, time) {
  const { data, error } = await supabase.rpc('submit_circle_result', {
    p_duel_id: duelId,
    p_user_id: userId,
    p_score: score,
    p_time: time,
  })
  if (error) { console.error('submitCircleResult error:', error); return null }
  return data
}

export async function getBlackjackState(duelId) {
  const { data, error } = await supabase
    .from('duels')
    .select('id, bj_deck, bj_state, creator_id, opponent_id, stake, status, is_bot_game, bot_should_win, game_type')
    .eq('id', duelId)
    .single()
  if (error) { console.error('getBlackjackState error:', error); return null }
  return data
}

export async function submitBlackjackAction(duelId, userId, action) {
  const { data, error } = await supabase.rpc('submit_blackjack_action', {
    p_duel_id: duelId,
    p_user_id: userId,
    p_action: action,
  })
  if (error) { console.error('submitBlackjackAction error:', error); return null }
  return data
}

export async function finalizeBlackjack(duelId, creatorScore, opponentScore) {
  const { data, error } = await supabase.rpc('finalize_blackjack', {
    p_duel_id: duelId,
    p_creator_score: creatorScore,
    p_opponent_score: opponentScore,
  })
  if (error) { console.error('finalizeBlackjack error:', error); return null }
  return data
}

export function subscribeBlackjackActions(duelId, callback) {
  const channel = supabase
    .channel(`bj-${duelId}`)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'blackjack_actions',
      filter: `duel_id=eq.${duelId}`,
    }, payload => {
      callback(payload.new)
    })
    .subscribe()
  return channel
}

// ── Bug Reports ──

export async function uploadBugPhoto(userId, file) {
  const timestamp = Date.now()
  const path = `${userId}/${timestamp}_${Math.random().toString(36).slice(2, 6)}.jpg`
  const { error } = await supabase.storage.from('bug-photos').upload(path, file, {
    contentType: 'image/jpeg',
    upsert: false,
  })
  if (error) { console.error('uploadBugPhoto error:', error); return null }
  const { data: urlData } = supabase.storage.from('bug-photos').getPublicUrl(path)
  return urlData?.publicUrl || null
}

export async function submitBugReport(userId, description, photos, deviceInfo, context) {
  const { data, error } = await supabase.rpc('submit_bug_report', {
    p_user_id: userId,
    p_description: description,
    p_photos: photos,
    p_device_info: deviceInfo,
    p_context: context,
  })
  if (error) { console.error('submitBugReport error:', error); throw error }
  return data
}

export async function getBugReports(status = null) {
  const { data, error } = await supabase.rpc('get_bug_reports', {
    p_status: status,
  })
  if (error) { console.error('getBugReports error:', error); return [] }
  return data || []
}

export async function updateBugReportStatus(reportId, status) {
  const { data, error } = await supabase.rpc('update_bug_report_status', {
    p_report_id: reportId,
    p_status: status,
  })
  if (error) { console.error('updateBugReportStatus error:', error); return { error: error.message } }
  return data
}

export async function getRecentCryptoDeposits(limit = 10) {
  const { data, error } = await supabase
    .from('crypto_processed_txs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) { console.error('getRecentCryptoDeposits error:', error); return [] }
  return data
}

// ── Slots ───────────────────────────────────
// Server-controlled RTP: start_slot_round returns the round_id PLUS
// the predetermined fall_at_level (the floor at which the tower will
// collapse). Client just animates that outcome — the server is the
// source of truth.
export async function startSlotRound(userId, slotId, stakeRub) {
  const { data, error } = await supabase.rpc('start_slot_round', {
    p_user_id: userId,
    p_slot_id: slotId,
    p_stake_rub: stakeRub,
  })
  if (error) { console.error('startSlotRound error:', error); return { error: error.message } }
  return data
}

// Финализация раунда: outcome = 'cashed' | 'fallen' | 'aborted'
// Server enforces the predetermined fall level — if you claim 'cashed'
// at or past fall_at_level, payout is forced to 0.
export async function finishSlotRound(roundId, outcome, payoutRub, floors, multiplier = 1) {
  const { data, error } = await supabase.rpc('finish_slot_round', {
    p_round_id: roundId,
    p_outcome: outcome,
    p_payout_rub: Math.max(0, Math.round(payoutRub || 0)),
    p_floors: Math.max(0, Math.round(floors || 0)),
    p_multiplier: Number(multiplier) || 1,
  })
  if (error) { console.error('finishSlotRound error:', error); return { error: error.message } }
  return data
}

// ── Admin: slot stats ───────────────────────
export async function adminGetSlotStats() {
  const { data, error } = await supabase.rpc('admin_get_slot_stats')
  if (error) { console.error('adminGetSlotStats error:', error); return [] }
  return data ?? []
}

export async function adminUpdateSlotSettings(slotId, { targetRtp, maxDeficit, enabled } = {}) {
  const { data, error } = await supabase.rpc('admin_update_slot_settings', {
    p_slot_id: slotId,
    p_target_rtp: targetRtp ?? null,
    p_max_deficit: maxDeficit ?? null,
    p_enabled: enabled ?? null,
  })
  if (error) { console.error('adminUpdateSlotSettings error:', error); return { error: error.message } }
  return data
}
