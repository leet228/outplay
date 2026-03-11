-- =============================================
-- OUTPLAY — Full Supabase Schema
-- Выполни в Supabase SQL Editor
-- =============================================

-- ╔═══════════════════════════════════════════╗
-- ║  1. USERS                                 ║
-- ╚═══════════════════════════════════════════╝

CREATE TABLE users (
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

CREATE INDEX idx_users_telegram ON users(telegram_id);
CREATE INDEX idx_users_balance ON users(balance DESC);
CREATE INDEX idx_users_referred_by ON users(referred_by);

-- ╔═══════════════════════════════════════════╗
-- ║  2. QUESTIONS                             ║
-- ╚═══════════════════════════════════════════╝

CREATE TABLE questions (
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

CREATE INDEX idx_questions_category ON questions(category);
CREATE INDEX idx_questions_lang ON questions(lang);

-- ╔═══════════════════════════════════════════╗
-- ║  3. DUELS                                 ║
-- ╚═══════════════════════════════════════════╝

CREATE TABLE duels (
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

CREATE INDEX idx_duels_status ON duels(status);
CREATE INDEX idx_duels_creator ON duels(creator_id);
CREATE INDEX idx_duels_opponent ON duels(opponent_id);
CREATE INDEX idx_duels_created ON duels(created_at DESC);

-- ╔═══════════════════════════════════════════╗
-- ║  4. FRIENDS                               ║
-- ╚═══════════════════════════════════════════╝

CREATE TABLE friends (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, friend_id)
);

CREATE INDEX idx_friends_user ON friends(user_id);
CREATE INDEX idx_friends_friend ON friends(friend_id);

-- Запрос дружбы
CREATE TABLE friend_requests (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','accepted','rejected')),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(from_id, to_id)
);

CREATE INDEX idx_friend_requests_to ON friend_requests(to_id, status);

-- ╔═══════════════════════════════════════════╗
-- ║  5. GUILDS                                ║
-- ╚═══════════════════════════════════════════╝

CREATE TABLE guild_seasons (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  start_date  TIMESTAMPTZ NOT NULL,
  end_date    TIMESTAMPTZ NOT NULL,
  prize_pool  INTEGER NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE guilds (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  description   TEXT DEFAULT '',
  avatar_url    TEXT,
  creator_id    UUID NOT NULL REFERENCES users(id),
  max_members   INTEGER NOT NULL DEFAULT 50,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_guilds_creator ON guilds(creator_id);

CREATE TABLE guild_members (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id    UUID NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'member'
              CHECK (role IN ('creator','member')),
  joined_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(guild_id, user_id)
);

CREATE INDEX idx_gm_guild ON guild_members(guild_id);
CREATE INDEX idx_gm_user ON guild_members(user_id);

-- PnL гильдий по сезонам
CREATE TABLE guild_season_stats (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id    UUID NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  season_id   UUID NOT NULL REFERENCES guild_seasons(id) ON DELETE CASCADE,
  pnl         INTEGER NOT NULL DEFAULT 0,
  UNIQUE(guild_id, season_id)
);

CREATE INDEX idx_gss_season ON guild_season_stats(season_id, pnl DESC);

-- PnL участников в гильдии по сезонам
CREATE TABLE guild_member_stats (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id    UUID NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  season_id   UUID NOT NULL REFERENCES guild_seasons(id) ON DELETE CASCADE,
  pnl         INTEGER NOT NULL DEFAULT 0,
  UNIQUE(guild_id, user_id, season_id)
);

CREATE INDEX idx_gms_guild_season ON guild_member_stats(guild_id, season_id, pnl DESC);

-- ╔═══════════════════════════════════════════╗
-- ║  6. SUBSCRIPTIONS (PRO)                   ║
-- ╚═══════════════════════════════════════════╝

CREATE TABLE plans (
  id          TEXT PRIMARY KEY,        -- '1m', '6m', '12m'
  months      INTEGER NOT NULL,
  price       INTEGER NOT NULL,        -- в Stars
  per_month   INTEGER NOT NULL,
  savings     INTEGER DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT true
);

-- Предзаполняем планы
INSERT INTO plans (id, months, price, per_month, savings) VALUES
  ('1m',  1,  499,  499, 0),
  ('6m',  6,  2199, 366, 795),
  ('12m', 12, 3499, 292, 2489);

CREATE TABLE subscriptions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id),
  plan_id     TEXT NOT NULL REFERENCES plans(id),
  status      TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active','expired','cancelled')),
  starts_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_subs_user ON subscriptions(user_id, status);
CREATE INDEX idx_subs_expires ON subscriptions(expires_at);

-- ╔═══════════════════════════════════════════╗
-- ║  7. REFERRALS                             ║
-- ╚═══════════════════════════════════════════╝

CREATE TABLE referrals (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id       UUID NOT NULL REFERENCES users(id),
  referred_user_id  UUID NOT NULL REFERENCES users(id),
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(referred_user_id)     -- юзер может быть приглашён только одним рефоводом
);

CREATE INDEX idx_referrals_referrer ON referrals(referrer_id);

-- Начисления за рефералов (каждая выигранная дуэль реферала → % рефоводу)
CREATE TABLE referral_earnings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id   UUID NOT NULL REFERENCES users(id),
  from_user_id  UUID NOT NULL REFERENCES users(id),
  duel_id       UUID NOT NULL REFERENCES duels(id),
  amount        INTEGER NOT NULL,           -- сколько начислено рефоводу
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_ref_earn_referrer ON referral_earnings(referrer_id, created_at DESC);

-- ╔═══════════════════════════════════════════╗
-- ║  8. TRANSACTIONS (история баланса)        ║
-- ╚═══════════════════════════════════════════╝

CREATE TABLE transactions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id),
  type        TEXT NOT NULL
              CHECK (type IN (
                'deposit','withdrawal',
                'duel_win','duel_loss','duel_draw',
                'referral_bonus',
                'guild_create','guild_edit',
                'guild_prize',
                'subscription'
              )),
  amount      INTEGER NOT NULL,             -- положительный = приход, отрицательный = расход
  ref_id      UUID,                         -- ссылка на duel_id / subscription_id и т.д.
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_tx_user ON transactions(user_id, created_at DESC);
CREATE INDEX idx_tx_type ON transactions(user_id, type);

-- ╔═══════════════════════════════════════════╗
-- ║  9. USER DAILY STATS (PnL-график)        ║
-- ╚═══════════════════════════════════════════╝

CREATE TABLE user_daily_stats (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id),
  date        DATE NOT NULL,
  pnl         INTEGER NOT NULL DEFAULT 0,     -- итого за день
  games       INTEGER NOT NULL DEFAULT 0,
  wins        INTEGER NOT NULL DEFAULT 0,
  UNIQUE(user_id, date)
);

CREATE INDEX idx_uds_user_date ON user_daily_stats(user_id, date DESC);

-- ╔═══════════════════════════════════════════╗
-- ║  10. PUSH TOKENS (уведомления)            ║
-- ╚═══════════════════════════════════════════╝

CREATE TABLE push_tokens (
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
DROP FUNCTION IF EXISTS set_updated_at();

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

-- Профиль пользователя — единый запрос (rank + daily_stats + total_pnl)
DROP FUNCTION IF EXISTS get_user_profile(UUID, INTEGER);

CREATE OR REPLACE FUNCTION get_user_profile(p_user_id UUID, p_days INTEGER DEFAULT 30)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_balance INTEGER;
  v_rank    INTEGER;
  v_stats   JSONB;
  v_total   INTEGER;
BEGIN
  SELECT balance INTO v_balance FROM users WHERE id = p_user_id;
  IF v_balance IS NULL THEN
    RETURN jsonb_build_object('error', 'user_not_found');
  END IF;

  -- Rank: users with strictly higher balance + 1
  SELECT COUNT(*) + 1 INTO v_rank
  FROM users WHERE balance > v_balance;

  -- Daily stats for last N days
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object('date', uds.date, 'pnl', uds.pnl, 'games', uds.games, 'wins', uds.wins)
    ORDER BY uds.date ASC
  ), '[]'::JSONB)
  INTO v_stats
  FROM user_daily_stats uds
  WHERE uds.user_id = p_user_id
    AND uds.date >= CURRENT_DATE - (p_days || ' days')::INTERVAL;

  -- Total PnL (all time)
  SELECT COALESCE(SUM(pnl), 0) INTO v_total
  FROM user_daily_stats WHERE user_id = p_user_id;

  RETURN jsonb_build_object('rank', v_rank, 'daily_stats', v_stats, 'total_pnl', v_total);
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
