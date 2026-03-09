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

// Leaderboard
export async function getLeaderboard(limit = 50) {
  const { data } = await supabase
    .from('users')
    .select('id, first_name, username, avatar_url, balance, wins, losses')
    .order('balance', { ascending: false })
    .limit(limit)
  return data ?? []
}
