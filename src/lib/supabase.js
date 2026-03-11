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
