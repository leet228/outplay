import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabase = createClient(supabaseUrl, supabaseAnonKey)

// PRO commission helper: PRO users pay 2.5% rake, regular 5%
export function calcPayout(stake, isPro) {
  const mult = isPro ? 0.975 : 0.95
  return Math.floor(stake * 2 * mult)
}

// PRO subscription purchase
export async function purchasePro(userId, planPrice, planMonths) {
  // 1. Check balance
  const { data: user } = await supabase
    .from('users')
    .select('balance')
    .eq('id', userId)
    .single()

  if (!user || user.balance < planPrice) {
    return { error: 'insufficient_balance' }
  }

  // 2. Deduct balance
  const { error: balErr } = await supabase
    .from('users')
    .update({
      balance: user.balance - planPrice,
      is_pro: true,
      pro_expires: new Date(Date.now() + planMonths * 30 * 86400000).toISOString(),
    })
    .eq('id', userId)

  if (balErr) {
    console.error('purchasePro balance error:', balErr)
    return { error: 'update_failed' }
  }

  // 3. Record transaction
  await supabase.from('transactions').insert({
    user_id: userId,
    type: 'pro_subscription',
    amount: -planPrice,
  })

  return { ok: true, newBalance: user.balance - planPrice }
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

// Leaderboard (ranked by real PnL from duels, not balance)
export async function getLeaderboard(limit = 50) {
  const { data, error } = await supabase.rpc('get_leaderboard', { p_limit: limit })
  if (error) { console.error('getLeaderboard error:', error); return [] }
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
  const { data, error } = await supabase
    .from('game_invites')
    .select('*')
    .eq('to_id', userId)
    .eq('status', 'pending')
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
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
  const { data, error } = await supabase.rpc('get_app_settings')
  if (error) { console.error('getAppSettings error:', error); return null }
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

export async function finalizeDuel(duelId) {
  const { data, error } = await supabase.rpc('finalize_duel', { p_duel_id: duelId })
  if (error) { console.error('finalizeDuel error:', error); return null }
  return data
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

// ── Blackjack ───────────────────────────────────
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
