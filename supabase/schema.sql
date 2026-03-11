-- =============================================
-- OUTPLAY — Full Supabase Schema
-- Выполни в Supabase SQL Editor
-- =============================================

-- ╔═══════════════════════════════════════════╗
-- ║  1. USERS                                 ║
-- ╚═══════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id   BIGINT UNIQUE NOT NULL,
  username      TEXT,
  first_name    TEXT NOT NULL,
  avatar_url    TEXT,
  balance       INTEGER NOT NULL DEFAULT 0,
  wins          INTEGER NOT NULL DEFAULT 0,
  losses        INTEGER NOT NULL DEFAULT 0,
  currency      TEXT NOT NULL DEFAULT 'RUB',       -- RUB | USD | EUR
  lang          TEXT NOT NULL DEFAULT 'ru',         -- ru | en
  is_pro        BOOLEAN NOT NULL DEFAULT false,
  pro_expires   TIMESTAMPTZ,
  referred_by   UUID REFERENCES users(id),
  last_seen     TIMESTAMPTZ DEFAULT NOW(),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_telegram ON users(telegram_id);
CREATE INDEX IF NOT EXISTS idx_users_balance ON users(balance DESC);
CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users(referred_by);

-- ╔═══════════════════════════════════════════╗
-- ║  2. QUESTIONS                             ║
-- ╚═══════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS questions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category      TEXT NOT NULL
                CHECK (category IN ('general','history','science','sport','movies','music')),
  question      TEXT NOT NULL,
  options       JSONB NOT NULL,  -- ["A","B","C","D"]
  correct_index INTEGER NOT NULL CHECK (correct_index BETWEEN 0 AND 3),
  difficulty    INTEGER NOT NULL DEFAULT 1 CHECK (difficulty BETWEEN 1 AND 3),
  lang          TEXT NOT NULL DEFAULT 'ru',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_questions_category ON questions(category);
CREATE INDEX IF NOT EXISTS idx_questions_lang ON questions(lang);

-- ╔═══════════════════════════════════════════╗
-- ║  3. DUELS                                 ║
-- ╚═══════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS duels (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id      UUID NOT NULL REFERENCES users(id),
  opponent_id     UUID REFERENCES users(id),
  category        TEXT NOT NULL,
  stake           INTEGER NOT NULL DEFAULT 100
                  CHECK (stake IN (100, 300, 500, 1000)),
  status          TEXT NOT NULL DEFAULT 'waiting'
                  CHECK (status IN ('waiting','active','finished','cancelled')),
  creator_score   INTEGER,
  opponent_score  INTEGER,
  winner_id       UUID REFERENCES users(id),
  question_ids    UUID[] NOT NULL DEFAULT '{}',     -- массив ID вопросов для этой дуэли
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  finished_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_duels_status ON duels(status);
CREATE INDEX IF NOT EXISTS idx_duels_creator ON duels(creator_id);
CREATE INDEX IF NOT EXISTS idx_duels_opponent ON duels(opponent_id);
CREATE INDEX IF NOT EXISTS idx_duels_created ON duels(created_at DESC);

-- ╔═══════════════════════════════════════════╗
-- ║  4. FRIENDS                               ║
-- ╚═══════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS friends (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, friend_id)
);

CREATE INDEX IF NOT EXISTS idx_friends_user ON friends(user_id);
CREATE INDEX IF NOT EXISTS idx_friends_friend ON friends(friend_id);

-- Запрос дружбы
CREATE TABLE IF NOT EXISTS friend_requests (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','accepted','rejected')),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(from_id, to_id)
);

CREATE INDEX IF NOT EXISTS idx_friend_requests_to ON friend_requests(to_id, status);

-- ╔═══════════════════════════════════════════╗
-- ║  5. GUILDS                                ║
-- ╚═══════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS guild_seasons (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  start_date  TIMESTAMPTZ NOT NULL,
  end_date    TIMESTAMPTZ NOT NULL,
  prize_pool  INTEGER NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS guilds (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  description   TEXT DEFAULT '',
  avatar_url    TEXT,
  creator_id    UUID NOT NULL REFERENCES users(id),
  max_members   INTEGER NOT NULL DEFAULT 50,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_guilds_creator ON guilds(creator_id);

CREATE TABLE IF NOT EXISTS guild_members (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id    UUID NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'member'
              CHECK (role IN ('creator','member')),
  joined_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(guild_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_gm_guild ON guild_members(guild_id);
CREATE INDEX IF NOT EXISTS idx_gm_user ON guild_members(user_id);

-- PnL гильдий по сезонам
CREATE TABLE IF NOT EXISTS guild_season_stats (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id    UUID NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  season_id   UUID NOT NULL REFERENCES guild_seasons(id) ON DELETE CASCADE,
  pnl         INTEGER NOT NULL DEFAULT 0,
  UNIQUE(guild_id, season_id)
);

CREATE INDEX IF NOT EXISTS idx_gss_season ON guild_season_stats(season_id, pnl DESC);

-- PnL участников в гильдии по сезонам
CREATE TABLE IF NOT EXISTS guild_member_stats (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id    UUID NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  season_id   UUID NOT NULL REFERENCES guild_seasons(id) ON DELETE CASCADE,
  pnl         INTEGER NOT NULL DEFAULT 0,
  UNIQUE(guild_id, user_id, season_id)
);

CREATE INDEX IF NOT EXISTS idx_gms_guild_season ON guild_member_stats(guild_id, season_id, pnl DESC);

-- ╔═══════════════════════════════════════════╗
-- ║  6. SUBSCRIPTIONS (PRO)                   ║
-- ╚═══════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS plans (
  id          TEXT PRIMARY KEY,        -- '1m', '6m', '12m'
  months      INTEGER NOT NULL,
  price       INTEGER NOT NULL,        -- в Stars
  per_month   INTEGER NOT NULL,
  savings     INTEGER DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT true
);

-- Предзаполняем планы (ON CONFLICT DO NOTHING — безопасно при повторном запуске)
INSERT INTO plans (id, months, price, per_month, savings) VALUES
  ('1m',  1,  499,  499, 0),
  ('6m',  6,  2199, 366, 795),
  ('12m', 12, 3499, 292, 2489)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS subscriptions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id),
  plan_id     TEXT NOT NULL REFERENCES plans(id),
  status      TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active','expired','cancelled')),
  starts_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subs_user ON subscriptions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_subs_expires ON subscriptions(expires_at);

-- ╔═══════════════════════════════════════════╗
-- ║  7. REFERRALS                             ║
-- ╚═══════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS referrals (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id       UUID NOT NULL REFERENCES users(id),
  referred_user_id  UUID NOT NULL REFERENCES users(id),
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(referred_user_id)     -- юзер может быть приглашён только одним рефоводом
);

CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id);

-- Начисления за рефералов (каждая выигранная дуэль реферала → % рефоводу)
CREATE TABLE IF NOT EXISTS referral_earnings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id   UUID NOT NULL REFERENCES users(id),
  from_user_id  UUID NOT NULL REFERENCES users(id),
  duel_id       UUID NOT NULL REFERENCES duels(id),
  amount        INTEGER NOT NULL,           -- сколько начислено рефоводу
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ref_earn_referrer ON referral_earnings(referrer_id, created_at DESC);

-- ╔═══════════════════════════════════════════╗
-- ║  8. TRANSACTIONS (история баланса)        ║
-- ╚═══════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id),
  type            TEXT NOT NULL
                  CHECK (type IN (
                    'deposit','withdrawal',
                    'duel_win','duel_loss','duel_draw',
                    'referral_bonus',
                    'guild_create','guild_edit',
                    'guild_prize',
                    'subscription'
                  )),
  amount          INTEGER NOT NULL,             -- Stars (положительный = приход, отрицательный = расход)
  currency_amount NUMERIC(12,2),               -- сумма в валюте пользователя (≈ 100.00 ₽)
  currency_code   TEXT,                         -- RUB / USD / EUR
  ref_id          UUID,                         -- ссылка на duel_id / subscription_id и т.д.
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tx_type ON transactions(user_id, type);

-- ╔═══════════════════════════════════════════╗
-- ║  9. USER DAILY STATS (PnL-график)        ║
-- ╚═══════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS user_daily_stats (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id),
  date        DATE NOT NULL,
  pnl         INTEGER NOT NULL DEFAULT 0,     -- итого за день
  games       INTEGER NOT NULL DEFAULT 0,
  wins        INTEGER NOT NULL DEFAULT 0,
  UNIQUE(user_id, date)
);

CREATE INDEX IF NOT EXISTS idx_uds_user_date ON user_daily_stats(user_id, date DESC);

-- ╔═══════════════════════════════════════════╗
-- ║  10. PUSH TOKENS (уведомления)            ║
-- ╚═══════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS push_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token       TEXT NOT NULL,
  platform    TEXT NOT NULL DEFAULT 'telegram',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, token)
);

-- ╔═══════════════════════════════════════════╗
-- ║  RPC FUNCTIONS                            ║
-- ╚═══════════════════════════════════════════╝

-- Удаляем старые функции (если есть) чтобы избежать конфликтов имён параметров
DROP FUNCTION IF EXISTS increment_balance(UUID, INTEGER);
DROP FUNCTION IF EXISTS finalize_duel(UUID);
DROP FUNCTION IF EXISTS update_guild_pnl_after_duel(UUID, INTEGER);
DROP FUNCTION IF EXISTS create_guild(UUID, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS join_guild(UUID, UUID);
DROP FUNCTION IF EXISTS kick_from_guild(UUID, UUID, UUID);
DROP FUNCTION IF EXISTS kick_guild_member(UUID, UUID, UUID);
DROP FUNCTION IF EXISTS edit_guild(UUID, UUID, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS get_referral_stats(UUID);
DROP FUNCTION IF EXISTS get_referral_earnings(UUID);
DROP FUNCTION IF EXISTS subscribe_pro(UUID, TEXT, TEXT);

-- Атомарное изменение баланса
CREATE OR REPLACE FUNCTION increment_balance(p_user_id UUID, p_amount INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  new_balance INTEGER;
BEGIN
  UPDATE users
  SET balance = balance + p_amount
  WHERE id = p_user_id
  RETURNING balance INTO new_balance;
  RETURN new_balance;
END;
$$;

-- Финализация дуэли
CREATE OR REPLACE FUNCTION finalize_duel(p_duel_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  d         duels%ROWTYPE;
  v_winner  UUID;
  v_loser   UUID;
  payout    INTEGER;
  v_ref_id  UUID;
  v_bonus   INTEGER;
BEGIN
  SELECT * INTO d FROM duels WHERE id = p_duel_id;

  IF d IS NULL THEN
    RETURN jsonb_build_object('error', 'duel_not_found');
  END IF;

  IF d.status = 'finished' THEN
    RETURN jsonb_build_object('error', 'already_finished');
  END IF;

  IF d.creator_score IS NULL OR d.opponent_score IS NULL THEN
    RETURN jsonb_build_object('error', 'scores_incomplete');
  END IF;

  payout := d.stake;

  IF d.creator_score > d.opponent_score THEN
    v_winner := d.creator_id;
    v_loser  := d.opponent_id;
  ELSIF d.opponent_score > d.creator_score THEN
    v_winner := d.opponent_id;
    v_loser  := d.creator_id;
  ELSE
    -- Ничья — ставки возвращаются
    UPDATE duels SET status = 'finished', finished_at = NOW() WHERE id = p_duel_id;
    INSERT INTO transactions (user_id, type, amount, ref_id)
    VALUES (d.creator_id, 'duel_draw', 0, p_duel_id),
           (d.opponent_id, 'duel_draw', 0, p_duel_id);
    RETURN jsonb_build_object('result', 'draw');
  END IF;

  -- Обновляем балансы и статистику
  UPDATE users SET balance = balance + payout, wins = wins + 1 WHERE id = v_winner;
  UPDATE users SET balance = balance - payout, losses = losses + 1 WHERE id = v_loser;

  -- Обновляем дуэль
  UPDATE duels SET status = 'finished', winner_id = v_winner, finished_at = NOW() WHERE id = p_duel_id;

  -- Транзакции
  INSERT INTO transactions (user_id, type, amount, ref_id)
  VALUES (v_winner, 'duel_win', payout, p_duel_id),
         (v_loser, 'duel_loss', -payout, p_duel_id);

  -- Дневная статистика
  INSERT INTO user_daily_stats (user_id, date, pnl, games, wins)
  VALUES (v_winner, CURRENT_DATE, payout, 1, 1)
  ON CONFLICT (user_id, date)
  DO UPDATE SET pnl = user_daily_stats.pnl + payout, games = user_daily_stats.games + 1, wins = user_daily_stats.wins + 1;

  INSERT INTO user_daily_stats (user_id, date, pnl, games, wins)
  VALUES (v_loser, CURRENT_DATE, -payout, 1, 0)
  ON CONFLICT (user_id, date)
  DO UPDATE SET pnl = user_daily_stats.pnl - payout, games = user_daily_stats.games + 1;

  -- Реферальный бонус (2% от выигрыша → рефоводу)
  SELECT referrer_id INTO v_ref_id FROM referrals WHERE referred_user_id = v_winner;
  IF v_ref_id IS NOT NULL THEN
    v_bonus := GREATEST(1, payout * 2 / 100);
    UPDATE users SET balance = balance + v_bonus WHERE id = v_ref_id;
    INSERT INTO referral_earnings (referrer_id, from_user_id, duel_id, amount)
    VALUES (v_ref_id, v_winner, p_duel_id, v_bonus);
    INSERT INTO transactions (user_id, type, amount, ref_id)
    VALUES (v_ref_id, 'referral_bonus', v_bonus, p_duel_id);
  END IF;

  -- Обновляем PnL гильдий
  PERFORM update_guild_pnl_after_duel(v_winner, payout);
  PERFORM update_guild_pnl_after_duel(v_loser, -payout);

  RETURN jsonb_build_object('result', 'win', 'winner', v_winner);
END;
$$;

-- Обновление PnL гильдии после дуэли
CREATE OR REPLACE FUNCTION update_guild_pnl_after_duel(p_user_id UUID, p_amount INTEGER)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_guild_id  UUID;
  v_season_id UUID;
BEGIN
  SELECT guild_id INTO v_guild_id FROM guild_members WHERE user_id = p_user_id LIMIT 1;
  IF v_guild_id IS NULL THEN RETURN; END IF;

  SELECT id INTO v_season_id FROM guild_seasons WHERE is_active = true LIMIT 1;
  IF v_season_id IS NULL THEN RETURN; END IF;

  INSERT INTO guild_member_stats (guild_id, user_id, season_id, pnl)
  VALUES (v_guild_id, p_user_id, v_season_id, p_amount)
  ON CONFLICT (guild_id, user_id, season_id)
  DO UPDATE SET pnl = guild_member_stats.pnl + p_amount;

  INSERT INTO guild_season_stats (guild_id, season_id, pnl)
  VALUES (v_guild_id, v_season_id, p_amount)
  ON CONFLICT (guild_id, season_id)
  DO UPDATE SET pnl = guild_season_stats.pnl + p_amount;
END;
$$;

-- Создание гильдии
CREATE OR REPLACE FUNCTION create_guild(
  p_user_id UUID,
  p_name TEXT,
  p_description TEXT DEFAULT '',
  p_avatar_url TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_guild_id UUID;
  v_cost     INTEGER := 5000;
  v_balance  INTEGER;
BEGIN
  SELECT balance INTO v_balance FROM users WHERE id = p_user_id;
  IF v_balance < v_cost THEN
    RETURN jsonb_build_object('error', 'insufficient_balance');
  END IF;

  IF EXISTS (SELECT 1 FROM guild_members WHERE user_id = p_user_id) THEN
    RETURN jsonb_build_object('error', 'already_in_guild');
  END IF;

  INSERT INTO guilds (name, description, avatar_url, creator_id)
  VALUES (p_name, p_description, p_avatar_url, p_user_id)
  RETURNING id INTO v_guild_id;

  INSERT INTO guild_members (guild_id, user_id, role) VALUES (v_guild_id, p_user_id, 'creator');

  UPDATE users SET balance = balance - v_cost WHERE id = p_user_id;

  INSERT INTO transactions (user_id, type, amount, ref_id) VALUES (p_user_id, 'guild_create', -v_cost, v_guild_id);

  RETURN jsonb_build_object('guild_id', v_guild_id);
END;
$$;

-- Вступление в гильдию
CREATE OR REPLACE FUNCTION join_guild(p_user_id UUID, p_guild_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_count INTEGER;
  v_max   INTEGER;
BEGIN
  IF EXISTS (SELECT 1 FROM guild_members WHERE user_id = p_user_id) THEN
    RETURN jsonb_build_object('error', 'already_in_guild');
  END IF;

  SELECT max_members INTO v_max FROM guilds WHERE id = p_guild_id;
  SELECT COUNT(*) INTO v_count FROM guild_members WHERE guild_id = p_guild_id;

  IF v_count >= v_max THEN
    RETURN jsonb_build_object('error', 'guild_full');
  END IF;

  INSERT INTO guild_members (guild_id, user_id, role) VALUES (p_guild_id, p_user_id, 'member');

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- Исключение из гильдии (только создатель)
CREATE OR REPLACE FUNCTION kick_from_guild(p_creator_id UUID, p_target_id UUID, p_guild_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM guild_members WHERE guild_id = p_guild_id AND user_id = p_creator_id AND role = 'creator'
  ) THEN
    RETURN jsonb_build_object('error', 'not_creator');
  END IF;

  DELETE FROM guild_members WHERE guild_id = p_guild_id AND user_id = p_target_id AND role = 'member';

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- Редактирование гильдии (стоит 100 stars)
CREATE OR REPLACE FUNCTION edit_guild(
  p_user_id UUID,
  p_guild_id UUID,
  p_name TEXT DEFAULT NULL,
  p_description TEXT DEFAULT NULL,
  p_avatar_url TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_cost INTEGER := 100;
  v_balance INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM guilds WHERE id = p_guild_id AND creator_id = p_user_id
  ) THEN
    RETURN jsonb_build_object('error', 'not_creator');
  END IF;

  SELECT balance INTO v_balance FROM users WHERE id = p_user_id;
  IF v_balance < v_cost THEN
    RETURN jsonb_build_object('error', 'insufficient_balance');
  END IF;

  UPDATE guilds SET
    name        = COALESCE(p_name, name),
    description = COALESCE(p_description, description),
    avatar_url  = COALESCE(p_avatar_url, avatar_url),
    updated_at  = NOW()
  WHERE id = p_guild_id;

  UPDATE users SET balance = balance - v_cost WHERE id = p_user_id;

  INSERT INTO transactions (user_id, type, amount, ref_id) VALUES (p_user_id, 'guild_edit', -v_cost, p_guild_id);

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- Статистика рефералов по периодам
CREATE OR REPLACE FUNCTION get_referral_stats(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_day   INTEGER;
  v_week  INTEGER;
  v_month INTEGER;
  v_all   INTEGER;
BEGIN
  SELECT COALESCE(SUM(amount), 0) INTO v_day
  FROM referral_earnings WHERE referrer_id = p_user_id AND created_at >= CURRENT_DATE;

  SELECT COALESCE(SUM(amount), 0) INTO v_week
  FROM referral_earnings WHERE referrer_id = p_user_id AND created_at >= CURRENT_DATE - INTERVAL '7 days';

  SELECT COALESCE(SUM(amount), 0) INTO v_month
  FROM referral_earnings WHERE referrer_id = p_user_id AND created_at >= CURRENT_DATE - INTERVAL '30 days';

  SELECT COALESCE(SUM(amount), 0) INTO v_all
  FROM referral_earnings WHERE referrer_id = p_user_id;

  RETURN jsonb_build_object('day', v_day, 'week', v_week, 'month', v_month, 'all', v_all);
END;
$$;

-- Профиль пользователя — единый запрос (rank + daily_stats + total_pnl + ref_earnings)
DROP FUNCTION IF EXISTS get_user_profile(UUID, INTEGER);

CREATE OR REPLACE FUNCTION get_user_profile(p_user_id UUID, p_days INTEGER DEFAULT 30)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_balance     INTEGER;
  v_rank        INTEGER;
  v_stats       JSONB;
  v_total       INTEGER;
  v_ref_day     INTEGER;
  v_ref_week    INTEGER;
  v_ref_month   INTEGER;
  v_ref_all     INTEGER;
BEGIN
  SELECT balance INTO v_balance FROM users WHERE id = p_user_id;
  IF v_balance IS NULL THEN
    RETURN jsonb_build_object('error', 'user_not_found');
  END IF;

  -- Total PnL (all time) — compute first, needed for rank
  SELECT COALESCE(SUM(pnl), 0) INTO v_total
  FROM user_daily_stats WHERE user_id = p_user_id;

  -- Rank: users with strictly higher PnL + 1
  SELECT COUNT(*) + 1 INTO v_rank
  FROM users u
  WHERE COALESCE((SELECT SUM(pnl) FROM user_daily_stats WHERE user_id = u.id), 0) > v_total;

  -- Daily stats for last N days
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object('date', uds.date, 'pnl', uds.pnl, 'games', uds.games, 'wins', uds.wins)
    ORDER BY uds.date ASC
  ), '[]'::JSONB)
  INTO v_stats
  FROM user_daily_stats uds
  WHERE uds.user_id = p_user_id
    AND uds.date >= CURRENT_DATE - (p_days || ' days')::INTERVAL;

  -- Referral earnings by period
  SELECT COALESCE(SUM(amount), 0) INTO v_ref_day
  FROM referral_earnings WHERE referrer_id = p_user_id AND created_at >= CURRENT_DATE;

  SELECT COALESCE(SUM(amount), 0) INTO v_ref_week
  FROM referral_earnings WHERE referrer_id = p_user_id AND created_at >= CURRENT_DATE - INTERVAL '7 days';

  SELECT COALESCE(SUM(amount), 0) INTO v_ref_month
  FROM referral_earnings WHERE referrer_id = p_user_id AND created_at >= CURRENT_DATE - INTERVAL '30 days';

  SELECT COALESCE(SUM(amount), 0) INTO v_ref_all
  FROM referral_earnings WHERE referrer_id = p_user_id;

  RETURN jsonb_build_object(
    'rank',         v_rank,
    'daily_stats',  v_stats,
    'total_pnl',    v_total,
    'ref_earnings', jsonb_build_object('day', v_ref_day, 'week', v_ref_week, 'month', v_ref_month, 'all', v_ref_all)
  );
END;
$$;

-- ╔═══════════════════════════════════════════╗
-- ║  LEADERBOARD (top by real PnL)            ║
-- ╚═══════════════════════════════════════════╝

DROP FUNCTION IF EXISTS get_leaderboard(INTEGER);

CREATE OR REPLACE FUNCTION get_leaderboard(p_limit INTEGER DEFAULT 50)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  RETURN (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'id',         t.id,
        'first_name', t.first_name,
        'username',   t.username,
        'avatar_url', t.avatar_url,
        'balance',    t.balance,
        'wins',       t.wins,
        'losses',     t.losses,
        'total_pnl',  t.pnl
      )
      ORDER BY t.pnl DESC
    ), '[]'::JSONB)
    FROM (
      SELECT
        u.id,
        u.first_name,
        u.username,
        u.avatar_url,
        u.balance,
        u.wins,
        u.losses,
        COALESCE(s.pnl, 0) AS pnl
      FROM users u
      LEFT JOIN (
        SELECT user_id, SUM(pnl) AS pnl
        FROM user_daily_stats
        GROUP BY user_id
      ) s ON s.user_id = u.id
      ORDER BY COALESCE(s.pnl, 0) DESC
      LIMIT p_limit
    ) t
  );
END;
$$;

-- Список рефералов с заработком по периодам (пагинация)
DROP FUNCTION IF EXISTS get_referrals_list(UUID, INTEGER, INTEGER);

CREATE OR REPLACE FUNCTION get_referrals_list(p_user_id UUID, p_limit INTEGER DEFAULT 50, p_offset INTEGER DEFAULT 0)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_total INTEGER;
  v_items JSONB;
BEGIN
  SELECT COUNT(*) INTO v_total FROM referrals WHERE referrer_id = p_user_id;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id',           sub.uid,
      'first_name',   sub.first_name,
      'username',     sub.username,
      'earned_day',   sub.earned_day,
      'earned_week',  sub.earned_week,
      'earned_month', sub.earned_month,
      'earned_all',   sub.earned_all
    ) ORDER BY sub.earned_all DESC
  ), '[]'::JSONB)
  INTO v_items
  FROM (
    SELECT
      u.id        AS uid,
      u.first_name,
      u.username,
      COALESCE(SUM(CASE WHEN re.created_at >= CURRENT_DATE THEN re.amount ELSE 0 END), 0)                    AS earned_day,
      COALESCE(SUM(CASE WHEN re.created_at >= CURRENT_DATE - INTERVAL '7 days' THEN re.amount ELSE 0 END), 0) AS earned_week,
      COALESCE(SUM(CASE WHEN re.created_at >= CURRENT_DATE - INTERVAL '30 days' THEN re.amount ELSE 0 END), 0) AS earned_month,
      COALESCE(SUM(re.amount), 0)                                                                              AS earned_all
    FROM referrals r
    JOIN users u ON u.id = r.referred_id
    LEFT JOIN referral_earnings re
      ON re.from_user_id = r.referred_id AND re.referrer_id = p_user_id
    WHERE r.referrer_id = p_user_id
    GROUP BY u.id, u.first_name, u.username
    ORDER BY earned_all DESC
    LIMIT p_limit OFFSET p_offset
  ) sub;

  RETURN jsonb_build_object('total', v_total, 'items', v_items);
END;
$$;

-- ╔═══════════════════════════════════════════╗
-- ║  GUILD DATA (single RPC for Guilds page)  ║
-- ╚═══════════════════════════════════════════╝

DROP FUNCTION IF EXISTS get_guild_data(UUID);

CREATE OR REPLACE FUNCTION get_guild_data(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_guild_id   UUID;
  v_season_id  UUID;
  v_my_guild   JSONB := 'null'::JSONB;
  v_top_guilds JSONB := '[]'::JSONB;
  v_season     JSONB := 'null'::JSONB;
  v_members    JSONB;
  v_rank       INTEGER;
  v_member_count INTEGER;
BEGIN
  -- Active season
  SELECT id INTO v_season_id
  FROM guild_seasons WHERE is_active = true LIMIT 1;

  IF v_season_id IS NULL THEN
    SELECT id INTO v_season_id FROM guild_seasons ORDER BY end_date DESC LIMIT 1;
  END IF;

  -- Build season info
  IF v_season_id IS NOT NULL THEN
    SELECT jsonb_build_object('prize_pool', prize_pool, 'end_date', end_date)
    INTO v_season
    FROM guild_seasons WHERE id = v_season_id;
  END IF;

  -- User's guild
  SELECT gm.guild_id INTO v_guild_id
  FROM guild_members gm WHERE gm.user_id = p_user_id LIMIT 1;

  IF v_guild_id IS NOT NULL THEN
    -- Member count
    SELECT COUNT(*) INTO v_member_count FROM guild_members WHERE guild_id = v_guild_id;

    -- Guild rank among all guilds in season
    SELECT COALESCE(pos, 0) INTO v_rank
    FROM (
      SELECT guild_id, ROW_NUMBER() OVER (ORDER BY pnl DESC) AS pos
      FROM guild_season_stats WHERE season_id = v_season_id
    ) ranked
    WHERE guild_id = v_guild_id;

    IF v_rank IS NULL OR v_rank = 0 THEN v_rank := 999; END IF;

    -- Members with PnL
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'user_id',    u.id,
        'first_name', u.first_name,
        'username',   u.username,
        'avatar_url', u.avatar_url,
        'role',       gm.role,
        'pnl',        COALESCE(gms.pnl, 0)
      ) ORDER BY COALESCE(gms.pnl, 0) DESC
    ), '[]'::JSONB) INTO v_members
    FROM guild_members gm
    JOIN users u ON u.id = gm.user_id
    LEFT JOIN guild_member_stats gms
      ON gms.guild_id = v_guild_id AND gms.user_id = gm.user_id AND gms.season_id = v_season_id
    WHERE gm.guild_id = v_guild_id;

    -- Build my_guild object
    SELECT jsonb_build_object(
      'id',           g.id,
      'name',         g.name,
      'description',  g.description,
      'avatar_url',   g.avatar_url,
      'creator_id',   g.creator_id,
      'rank',         v_rank,
      'member_count', v_member_count,
      'pnl',          COALESCE(gss.pnl, 0),
      'members',      v_members,
      'creator_name', (SELECT first_name FROM users WHERE id = g.creator_id)
    ) INTO v_my_guild
    FROM guilds g
    LEFT JOIN guild_season_stats gss ON gss.guild_id = g.id AND gss.season_id = v_season_id
    WHERE g.id = v_guild_id;
  END IF;

  -- Top guilds
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id',            g.id,
      'name',          g.name,
      'tag',           UPPER(LEFT(g.name, 2)),
      'avatar_url',    g.avatar_url,
      'member_count',  (SELECT COUNT(*) FROM guild_members WHERE guild_id = g.id),
      'pnl',           COALESCE(gss.pnl, 0),
      'creator_name',  (SELECT first_name FROM users WHERE id = g.creator_id)
    ) ORDER BY COALESCE(gss.pnl, 0) DESC
  ), '[]'::JSONB) INTO v_top_guilds
  FROM guilds g
  LEFT JOIN guild_season_stats gss ON gss.guild_id = g.id AND gss.season_id = v_season_id;

  RETURN jsonb_build_object(
    'my_guild',   v_my_guild,
    'top_guilds', v_top_guilds,
    'season',     v_season
  );
END;
$$;

-- ╔═══════════════════════════════════════════╗
-- ║  RECENT OPPONENTS                         ║
-- ╚═══════════════════════════════════════════╝

DROP FUNCTION IF EXISTS get_recent_opponents(UUID, INTEGER);

CREATE OR REPLACE FUNCTION get_recent_opponents(p_user_id UUID, p_limit INTEGER DEFAULT 20)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  RETURN COALESCE((
    SELECT jsonb_agg(
      jsonb_build_object(
        'id',         r.opp_id,
        'first_name', r.first_name,
        'username',   r.username,
        'avatar_url', r.avatar_url
      )
    )
    FROM (
      SELECT sub.opp_id, sub.first_name, sub.username, sub.avatar_url
      FROM (
        SELECT DISTINCT ON (opp_id)
          CASE WHEN d.creator_id = p_user_id THEN d.opponent_id ELSE d.creator_id END AS opp_id,
          u.first_name, u.username, u.avatar_url,
          d.created_at
        FROM duels d
        JOIN users u ON u.id = CASE WHEN d.creator_id = p_user_id THEN d.opponent_id ELSE d.creator_id END
        WHERE (d.creator_id = p_user_id OR d.opponent_id = p_user_id)
          AND d.status = 'finished'
          AND d.opponent_id IS NOT NULL
        ORDER BY opp_id, d.created_at DESC
      ) sub
      ORDER BY sub.created_at DESC
      LIMIT p_limit
    ) r
  ), '[]'::JSONB);
END;
$$;

-- ╔═══════════════════════════════════════════╗
-- ║  SEARCH GUILDS                            ║
-- ╚═══════════════════════════════════════════╝

DROP FUNCTION IF EXISTS search_guilds(TEXT, INTEGER);

CREATE OR REPLACE FUNCTION search_guilds(p_query TEXT, p_limit INTEGER DEFAULT 20)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_season_id UUID;
BEGIN
  SELECT id INTO v_season_id FROM guild_seasons WHERE is_active = true LIMIT 1;

  RETURN COALESCE((
    SELECT jsonb_agg(
      jsonb_build_object(
        'id',           g.id,
        'name',         g.name,
        'tag',          UPPER(LEFT(g.name, 2)),
        'avatar_url',   g.avatar_url,
        'member_count', (SELECT COUNT(*) FROM guild_members WHERE guild_id = g.id),
        'pnl',          COALESCE(gss.pnl, 0),
        'creator_name', (SELECT first_name FROM users WHERE id = g.creator_id),
        'max_members',  g.max_members
      ) ORDER BY COALESCE(gss.pnl, 0) DESC
    )
    FROM guilds g
    LEFT JOIN guild_season_stats gss ON gss.guild_id = g.id AND gss.season_id = v_season_id
    WHERE g.name ILIKE '%' || p_query || '%'
    LIMIT p_limit
  ), '[]'::JSONB);
END;
$$;

-- ╔═══════════════════════════════════════════╗
-- ║  LEAVE GUILD                              ║
-- ╚═══════════════════════════════════════════╝

DROP FUNCTION IF EXISTS leave_guild(UUID);

CREATE OR REPLACE FUNCTION leave_guild(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  -- Creator cannot leave, must delete guild
  IF EXISTS (SELECT 1 FROM guild_members WHERE user_id = p_user_id AND role = 'creator') THEN
    RETURN jsonb_build_object('error', 'creator_cannot_leave');
  END IF;

  DELETE FROM guild_members WHERE user_id = p_user_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'not_in_guild');
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ╔═══════════════════════════════════════════╗
-- ║  FRIENDS DATA (single RPC for bootstrap)  ║
-- ╚═══════════════════════════════════════════╝

DROP FUNCTION IF EXISTS get_friends_data(UUID);

CREATE OR REPLACE FUNCTION get_friends_data(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_friends  JSONB;
  v_incoming JSONB;
  v_outgoing JSONB;
BEGIN
  -- Confirmed friends
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id',         u.id,
      'first_name', u.first_name,
      'username',   u.username,
      'avatar_url', u.avatar_url,
      'last_seen',  u.last_seen
    ) ORDER BY u.last_seen DESC NULLS LAST
  ), '[]'::JSONB)
  INTO v_friends
  FROM friends f
  JOIN users u ON u.id = f.friend_id
  WHERE f.user_id = p_user_id;

  -- Incoming pending requests
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'request_id', fr.id,
      'from_user',  jsonb_build_object(
        'id',         u.id,
        'first_name', u.first_name,
        'username',   u.username,
        'avatar_url', u.avatar_url
      ),
      'created_at', fr.created_at
    ) ORDER BY fr.created_at DESC
  ), '[]'::JSONB)
  INTO v_incoming
  FROM friend_requests fr
  JOIN users u ON u.id = fr.from_id
  WHERE fr.to_id = p_user_id AND fr.status = 'pending';

  -- Outgoing pending request target IDs
  SELECT COALESCE(jsonb_agg(fr.to_id), '[]'::JSONB)
  INTO v_outgoing
  FROM friend_requests fr
  WHERE fr.from_id = p_user_id AND fr.status = 'pending';

  RETURN jsonb_build_object(
    'friends',              v_friends,
    'incoming_requests',    v_incoming,
    'outgoing_request_ids', v_outgoing
  );
END;
$$;

-- ╔═══════════════════════════════════════════╗
-- ║  SEARCH USERS (global friend search)      ║
-- ╚═══════════════════════════════════════════╝

DROP FUNCTION IF EXISTS search_users(UUID, TEXT, INTEGER);

CREATE OR REPLACE FUNCTION search_users(p_user_id UUID, p_query TEXT, p_limit INTEGER DEFAULT 20)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  RETURN COALESCE((
    SELECT jsonb_agg(
      jsonb_build_object(
        'id',              sub.id,
        'first_name',      sub.first_name,
        'username',        sub.username,
        'avatar_url',      sub.avatar_url,
        'is_friend',       sub.is_friend,
        'request_pending', sub.request_pending
      )
    )
    FROM (
      SELECT
        u.id,
        u.first_name,
        u.username,
        u.avatar_url,
        EXISTS (
          SELECT 1 FROM friends f
          WHERE f.user_id = p_user_id AND f.friend_id = u.id
        ) AS is_friend,
        EXISTS (
          SELECT 1 FROM friend_requests fr
          WHERE fr.from_id = p_user_id AND fr.to_id = u.id AND fr.status = 'pending'
        ) AS request_pending
      FROM users u
      WHERE u.id != p_user_id
        AND (
          u.first_name ILIKE '%' || p_query || '%'
          OR u.username ILIKE '%' || p_query || '%'
        )
      ORDER BY u.last_seen DESC NULLS LAST
      LIMIT p_limit
    ) sub
  ), '[]'::JSONB);
END;
$$;

-- ╔═══════════════════════════════════════════╗
-- ║  SEND FRIEND REQUEST                      ║
-- ╚═══════════════════════════════════════════╝

DROP FUNCTION IF EXISTS send_friend_request(UUID, UUID);

CREATE OR REPLACE FUNCTION send_friend_request(p_from_id UUID, p_to_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  -- Cannot add self
  IF p_from_id = p_to_id THEN
    RETURN jsonb_build_object('error', 'cannot_add_self');
  END IF;

  -- Already friends
  IF EXISTS (SELECT 1 FROM friends WHERE user_id = p_from_id AND friend_id = p_to_id) THEN
    RETURN jsonb_build_object('error', 'already_friends');
  END IF;

  -- Reverse request exists → auto-accept
  IF EXISTS (
    SELECT 1 FROM friend_requests
    WHERE from_id = p_to_id AND to_id = p_from_id AND status = 'pending'
  ) THEN
    UPDATE friend_requests SET status = 'accepted'
    WHERE from_id = p_to_id AND to_id = p_from_id AND status = 'pending';

    INSERT INTO friends (user_id, friend_id) VALUES (p_from_id, p_to_id) ON CONFLICT DO NOTHING;
    INSERT INTO friends (user_id, friend_id) VALUES (p_to_id, p_from_id) ON CONFLICT DO NOTHING;

    RETURN jsonb_build_object('result', 'auto_accepted');
  END IF;

  -- Duplicate pending request
  IF EXISTS (
    SELECT 1 FROM friend_requests
    WHERE from_id = p_from_id AND to_id = p_to_id AND status = 'pending'
  ) THEN
    RETURN jsonb_build_object('error', 'already_sent');
  END IF;

  INSERT INTO friend_requests (from_id, to_id) VALUES (p_from_id, p_to_id);

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ╔═══════════════════════════════════════════╗
-- ║  ACCEPT FRIEND REQUEST                    ║
-- ╚═══════════════════════════════════════════╝

DROP FUNCTION IF EXISTS accept_friend_request(UUID, UUID);

CREATE OR REPLACE FUNCTION accept_friend_request(p_user_id UUID, p_request_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_from_id UUID;
BEGIN
  SELECT from_id INTO v_from_id
  FROM friend_requests
  WHERE id = p_request_id AND to_id = p_user_id AND status = 'pending';

  IF v_from_id IS NULL THEN
    RETURN jsonb_build_object('error', 'request_not_found');
  END IF;

  UPDATE friend_requests SET status = 'accepted' WHERE id = p_request_id;

  INSERT INTO friends (user_id, friend_id) VALUES (p_user_id, v_from_id) ON CONFLICT DO NOTHING;
  INSERT INTO friends (user_id, friend_id) VALUES (v_from_id, p_user_id) ON CONFLICT DO NOTHING;

  RETURN jsonb_build_object('ok', true, 'friend_id', v_from_id);
END;
$$;

-- ╔═══════════════════════════════════════════╗
-- ║  REJECT FRIEND REQUEST                    ║
-- ╚═══════════════════════════════════════════╝

DROP FUNCTION IF EXISTS reject_friend_request(UUID, UUID);

CREATE OR REPLACE FUNCTION reject_friend_request(p_user_id UUID, p_request_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM friend_requests
    WHERE id = p_request_id AND to_id = p_user_id AND status = 'pending'
  ) THEN
    RETURN jsonb_build_object('error', 'request_not_found');
  END IF;

  UPDATE friend_requests SET status = 'rejected' WHERE id = p_request_id;

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ╔═══════════════════════════════════════════╗
-- ║  REMOVE FRIEND                            ║
-- ╚═══════════════════════════════════════════╝

DROP FUNCTION IF EXISTS remove_friend(UUID, UUID);

CREATE OR REPLACE FUNCTION remove_friend(p_user_id UUID, p_friend_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  DELETE FROM friends WHERE user_id = p_user_id AND friend_id = p_friend_id;
  DELETE FROM friends WHERE user_id = p_friend_id AND friend_id = p_user_id;

  -- Clean up requests between them
  DELETE FROM friend_requests
  WHERE (from_id = p_user_id AND to_id = p_friend_id)
     OR (from_id = p_friend_id AND to_id = p_user_id);

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ╔═══════════════════════════════════════════╗
-- ║  PROCESS DEPOSIT                          ║
-- ╚═══════════════════════════════════════════╝

DROP FUNCTION IF EXISTS process_deposit(UUID, INTEGER, UUID);
DROP FUNCTION IF EXISTS process_deposit(UUID, INTEGER, UUID, NUMERIC, TEXT);

CREATE OR REPLACE FUNCTION process_deposit(
  p_user_id       UUID,
  p_amount        INTEGER,
  p_tx_id         UUID,
  p_currency_amt  NUMERIC DEFAULT NULL,
  p_currency_code TEXT    DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  new_balance INTEGER;
BEGIN
  IF p_amount < 1 THEN
    RETURN jsonb_build_object('error', 'amount must be >= 1');
  END IF;

  -- Deduplication
  IF EXISTS (
    SELECT 1 FROM transactions
    WHERE user_id = p_user_id AND type = 'deposit' AND ref_id = p_tx_id
  ) THEN
    SELECT balance INTO new_balance FROM users WHERE id = p_user_id;
    RETURN jsonb_build_object('new_balance', new_balance, 'duplicate', true);
  END IF;

  -- Credit balance
  UPDATE users
  SET balance = balance + p_amount
  WHERE id = p_user_id
  RETURNING balance INTO new_balance;

  -- Log transaction with currency info
  INSERT INTO transactions (user_id, type, amount, currency_amount, currency_code, ref_id)
  VALUES (p_user_id, 'deposit', p_amount, p_currency_amt, p_currency_code, p_tx_id);

  RETURN jsonb_build_object('new_balance', new_balance);
END;
$$;

-- ╔═══════════════════════════════════════════╗
-- ║  TRIGGERS                                 ║
-- ╚═══════════════════════════════════════════╝

-- Автообновление updated_at
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_users_updated ON users;
DROP TRIGGER IF EXISTS trg_guilds_updated ON guilds;
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_guilds_updated BEFORE UPDATE ON guilds FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ╔═══════════════════════════════════════════╗
-- ║  ROW LEVEL SECURITY                       ║
-- ╚═══════════════════════════════════════════╝

ALTER TABLE users              ENABLE ROW LEVEL SECURITY;
ALTER TABLE questions           ENABLE ROW LEVEL SECURITY;
ALTER TABLE duels               ENABLE ROW LEVEL SECURITY;
ALTER TABLE friends             ENABLE ROW LEVEL SECURITY;
ALTER TABLE friend_requests     ENABLE ROW LEVEL SECURITY;
ALTER TABLE guilds              ENABLE ROW LEVEL SECURITY;
ALTER TABLE guild_members       ENABLE ROW LEVEL SECURITY;
ALTER TABLE guild_seasons       ENABLE ROW LEVEL SECURITY;
ALTER TABLE guild_season_stats  ENABLE ROW LEVEL SECURITY;
ALTER TABLE guild_member_stats  ENABLE ROW LEVEL SECURITY;
ALTER TABLE plans               ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE referrals           ENABLE ROW LEVEL SECURITY;
ALTER TABLE referral_earnings   ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_daily_stats    ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_tokens         ENABLE ROW LEVEL SECURITY;

-- Чтение — открыто
DROP POLICY IF EXISTS "read_all" ON users;
DROP POLICY IF EXISTS "read_all" ON questions;
DROP POLICY IF EXISTS "read_all" ON duels;
DROP POLICY IF EXISTS "read_all" ON friends;
DROP POLICY IF EXISTS "read_all" ON friend_requests;
DROP POLICY IF EXISTS "read_all" ON guilds;
DROP POLICY IF EXISTS "read_all" ON guild_members;
DROP POLICY IF EXISTS "read_all" ON guild_seasons;
DROP POLICY IF EXISTS "read_all" ON guild_season_stats;
DROP POLICY IF EXISTS "read_all" ON guild_member_stats;
DROP POLICY IF EXISTS "read_all" ON plans;
DROP POLICY IF EXISTS "read_all" ON subscriptions;
DROP POLICY IF EXISTS "read_all" ON referrals;
DROP POLICY IF EXISTS "read_all" ON referral_earnings;
DROP POLICY IF EXISTS "read_all" ON transactions;
DROP POLICY IF EXISTS "read_all" ON user_daily_stats;
DROP POLICY IF EXISTS "read_all" ON push_tokens;

CREATE POLICY "read_all" ON users             FOR SELECT USING (true);
CREATE POLICY "read_all" ON questions          FOR SELECT USING (true);
CREATE POLICY "read_all" ON duels              FOR SELECT USING (true);
CREATE POLICY "read_all" ON friends            FOR SELECT USING (true);
CREATE POLICY "read_all" ON friend_requests    FOR SELECT USING (true);
CREATE POLICY "read_all" ON guilds             FOR SELECT USING (true);
CREATE POLICY "read_all" ON guild_members      FOR SELECT USING (true);
CREATE POLICY "read_all" ON guild_seasons      FOR SELECT USING (true);
CREATE POLICY "read_all" ON guild_season_stats FOR SELECT USING (true);
CREATE POLICY "read_all" ON guild_member_stats FOR SELECT USING (true);
CREATE POLICY "read_all" ON plans              FOR SELECT USING (true);
CREATE POLICY "read_all" ON subscriptions      FOR SELECT USING (true);
CREATE POLICY "read_all" ON referrals          FOR SELECT USING (true);
CREATE POLICY "read_all" ON referral_earnings  FOR SELECT USING (true);
CREATE POLICY "read_all" ON transactions       FOR SELECT USING (true);
CREATE POLICY "read_all" ON user_daily_stats   FOR SELECT USING (true);
CREATE POLICY "read_all" ON push_tokens        FOR SELECT USING (true);

-- Запись — через SECURITY DEFINER RPC
DROP POLICY IF EXISTS "write_all" ON users;
DROP POLICY IF EXISTS "write_all" ON duels;
DROP POLICY IF EXISTS "write_all" ON friends;
DROP POLICY IF EXISTS "write_all" ON friend_requests;
DROP POLICY IF EXISTS "write_all" ON guild_members;
DROP POLICY IF EXISTS "write_all" ON subscriptions;
DROP POLICY IF EXISTS "write_all" ON referrals;
DROP POLICY IF EXISTS "write_all" ON transactions;
DROP POLICY IF EXISTS "write_all" ON user_daily_stats;
DROP POLICY IF EXISTS "write_all" ON push_tokens;

CREATE POLICY "write_all" ON users             FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "write_all" ON duels             FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "write_all" ON friends           FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "write_all" ON friend_requests   FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "write_all" ON guild_members     FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "write_all" ON subscriptions     FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "write_all" ON referrals         FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "write_all" ON transactions      FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "write_all" ON user_daily_stats  FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "write_all" ON push_tokens       FOR ALL USING (true) WITH CHECK (true);

-- =============================================
-- ИТОГО 17 таблиц:
--  1. users              — профили, балансы, настройки
--  2. questions           — вопросы по категориям
--  3. duels               — дуэли и результаты
--  4. friends             — список друзей
--  5. friend_requests     — запросы в друзья
--  6. guild_seasons       — сезоны гильдий (1 месяц)
--  7. guilds              — гильдии
--  8. guild_members       — участники гильдий
--  9. guild_season_stats  — PnL гильдий по сезонам
-- 10. guild_member_stats  — PnL участников по сезонам
-- 11. plans               — PRO-тарифы (предзаполнены)
-- 12. subscriptions       — активные подписки
-- 13. referrals           — кто кого пригласил
-- 14. referral_earnings   — начисления за рефералов
-- 15. transactions        — полная история баланса
-- 16. user_daily_stats    — дневной PnL (график профиля)
-- 17. push_tokens         — токены уведомлений
--
-- 8 RPC функций:
--  1. increment_balance    — атомарный баланс
--  2. finalize_duel        — результат дуэли + рефбонус + гильдии
--  3. update_guild_pnl_after_duel — PnL гильдии/участника
--  4. create_guild         — создание гильдии (-5000)
--  5. join_guild           — вступление
--  6. kick_from_guild      — исключение
--  7. edit_guild           — редактирование (-100)
--  8. get_referral_stats   — доходы по периодам
--  9. get_user_profile     — профиль (rank + daily_stats + total_pnl)
-- =============================================
