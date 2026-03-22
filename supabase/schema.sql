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

-- Баланс НИКОГДА не может уйти в минус — последний рубеж защиты
ALTER TABLE users ADD CONSTRAINT users_balance_non_negative CHECK (balance >= 0);

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
  stake           INTEGER NOT NULL DEFAULT 50
                  CHECK (stake > 0),
  status          TEXT NOT NULL DEFAULT 'waiting'
                  CHECK (status IN ('waiting','active','finished','cancelled')),
  creator_score   INTEGER,
  opponent_score  INTEGER,
  winner_id       UUID REFERENCES users(id),
  question_ids    UUID[] NOT NULL DEFAULT '{}',     -- массив ID вопросов для этой дуэли
  is_bot_game     BOOLEAN NOT NULL DEFAULT false,   -- игра с ботом
  bot_should_win  BOOLEAN,                          -- null для обычных дуэлей, true/false для бот-игр
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  finished_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_duels_status ON duels(status);
CREATE INDEX IF NOT EXISTS idx_duels_creator ON duels(creator_id);
CREATE INDEX IF NOT EXISTS idx_duels_opponent ON duels(opponent_id);
CREATE INDEX IF NOT EXISTS idx_duels_created ON duels(created_at DESC);

-- ╔═══════════════════════════════════════════╗
-- ║  3b. MATCHMAKING QUEUE                    ║
-- ╚═══════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS matchmaking_queue (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category    TEXT NOT NULL
              CHECK (category IN ('general','history','science','sport','movies','music')),
  stake       INTEGER NOT NULL CHECK (stake IN (50, 100, 300, 500, 1000)),
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, stake)
);

CREATE INDEX IF NOT EXISTS idx_mmq_match
  ON matchmaking_queue(category, stake, joined_at ASC);

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
CREATE INDEX IF NOT EXISTS idx_tx_ref  ON transactions(ref_id) WHERE ref_id IS NOT NULL;

-- Unique index for atomic deposit dedup (used by process_deposit ON CONFLICT)
DROP INDEX IF EXISTS uq_deposit_tx;
CREATE UNIQUE INDEX IF NOT EXISTS uq_deposit_tx ON transactions(ref_id) WHERE type = 'deposit' AND ref_id IS NOT NULL;

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
  d              duels%ROWTYPE;
  v_winner       UUID;
  v_loser        UUID;
  payout         INTEGER;
  v_total_pot    INTEGER;
  v_rake         INTEGER;
  v_guild_fee    INTEGER;
  v_bot_fee      INTEGER;
  v_ref_id       UUID;
  v_bonus        INTEGER;
  v_creator_time REAL;
  v_opp_time     REAL;
  v_season_id    UUID;
  v_winner_wins  INTEGER;
BEGIN
  -- Блокируем строку дуэли чтобы предотвратить двойную финализацию
  SELECT * INTO d FROM duels WHERE id = p_duel_id FOR UPDATE;

  IF d IS NULL THEN
    RETURN jsonb_build_object('error', 'duel_not_found');
  END IF;

  IF d.status = 'finished' THEN
    RETURN jsonb_build_object('error', 'already_finished');
  END IF;

  IF d.creator_score IS NULL OR d.opponent_score IS NULL THEN
    RETURN jsonb_build_object('error', 'scores_incomplete');
  END IF;

  -- Экономика: total_pot = 2 * stake, rake 5% (0.5% гильдии + бот + реферал)
  -- Ставки УЖЕ списаны при матчинге (find_match)
  v_total_pot := d.stake * 2;
  v_rake      := FLOOR(v_total_pot * 5 / 100);       -- 5% рейк
  v_guild_fee := FLOOR(v_total_pot * 5 / 1000);      -- 0.5% гильдии

  -- Добавить 0.5% в призовой фонд активного сезона гильдий
  SELECT id INTO v_season_id FROM guild_seasons WHERE is_active = true LIMIT 1;
  IF v_season_id IS NOT NULL THEN
    UPDATE guild_seasons SET prize_pool = prize_pool + v_guild_fee WHERE id = v_season_id;
  END IF;

  -- Бот-игра: bot_should_win принудительно определяет победителя
  IF d.is_bot_game AND d.bot_should_win IS NOT NULL THEN
    IF d.bot_should_win THEN
      -- Бот должен выиграть → игрок проигрывает
      v_winner := d.opponent_id;  -- бот = opponent
      v_loser  := d.creator_id;   -- игрок = creator
    ELSE
      -- Бот должен проиграть → игрок выигрывает
      v_winner := d.creator_id;
      v_loser  := d.opponent_id;
    END IF;
  ELSIF d.creator_score > d.opponent_score THEN
    v_winner := d.creator_id;
    v_loser  := d.opponent_id;
  ELSIF d.opponent_score > d.creator_score THEN
    v_winner := d.opponent_id;
    v_loser  := d.creator_id;
  ELSE
    -- Одинаковый счёт — тайбрейк по суммарному времени ответов (быстрее = победа)
    SELECT COALESCE(SUM(time_spent), 75) INTO v_creator_time
    FROM duel_answers WHERE duel_id = p_duel_id AND user_id = d.creator_id;

    SELECT COALESCE(SUM(time_spent), 75) INTO v_opp_time
    FROM duel_answers WHERE duel_id = p_duel_id AND user_id = d.opponent_id;

    IF v_creator_time <= v_opp_time THEN
      v_winner := d.creator_id;
      v_loser  := d.opponent_id;
    ELSE
      v_winner := d.opponent_id;
      v_loser  := d.creator_id;
    END IF;
  END IF;

  -- Обновляем статистику (wins/losses) ДО подсчёта реферального бонуса
  UPDATE users SET wins = wins + 1 WHERE id = v_winner;
  UPDATE users SET losses = losses + 1 WHERE id = v_loser;

  -- Реферальный бонус: каждая 3-я победа реферала → 1% от total_pot рефоводу
  -- Если 3-я победа: бот получает 3.5%, реферовод 1%
  -- Если нет: бот получает 4.5%, бонуса нет
  -- НЕ начисляем реферальный бонус если победитель — бот-соперник
  SELECT referrer_id INTO v_ref_id FROM referrals WHERE referred_user_id = v_winner;
  IF v_ref_id IS NOT NULL AND v_winner != '00000000-0000-0000-0000-000000000001' THEN
    SELECT wins INTO v_winner_wins FROM users WHERE id = v_winner;
    IF v_winner_wins % 3 = 0 THEN
      -- Каждая 3-я победа: 1% от total_pot рефоводу (из доли бота)
      v_bonus := GREATEST(1, FLOOR(v_total_pot * 1 / 100));
      v_bot_fee := v_rake - v_guild_fee - v_bonus;  -- 5% - 0.5% - 1% = 3.5%
      UPDATE users SET balance = balance + v_bonus WHERE id = v_ref_id;
      INSERT INTO referral_earnings (referrer_id, from_user_id, duel_id, amount)
      VALUES (v_ref_id, v_winner, p_duel_id, v_bonus);
      INSERT INTO transactions (user_id, type, amount, ref_id)
      VALUES (v_ref_id, 'referral_bonus', v_bonus, p_duel_id);
    ELSE
      v_bot_fee := v_rake - v_guild_fee;  -- 4.5%
    END IF;
  ELSE
    v_bot_fee := v_rake - v_guild_fee;  -- 4.5%
  END IF;

  -- Победитель получает pot - rake (ставка уже списана, так что += payout)
  payout := v_total_pot - v_rake;

  -- Обновляем баланс победителя
  UPDATE users SET balance = balance + payout WHERE id = v_winner;

  -- Обновляем дуэль
  UPDATE duels SET status = 'finished', winner_id = v_winner, finished_at = NOW() WHERE id = p_duel_id;

  -- Транзакции
  INSERT INTO transactions (user_id, type, amount, ref_id)
  VALUES (v_winner, 'duel_win', payout, p_duel_id),
         (v_loser, 'duel_loss', -d.stake, p_duel_id);

  -- Дневная статистика и гильдии — пропускаем для бота (telegram_id = -1)
  IF v_winner != '00000000-0000-0000-0000-000000000001' THEN
    INSERT INTO user_daily_stats (user_id, date, pnl, games, wins)
    VALUES (v_winner, CURRENT_DATE, payout - d.stake, 1, 1)
    ON CONFLICT (user_id, date)
    DO UPDATE SET pnl = user_daily_stats.pnl + (payout - d.stake), games = user_daily_stats.games + 1, wins = user_daily_stats.wins + 1;
    PERFORM update_guild_pnl_after_duel(v_winner, payout - d.stake);
  END IF;

  IF v_loser != '00000000-0000-0000-0000-000000000001' THEN
    INSERT INTO user_daily_stats (user_id, date, pnl, games, wins)
    VALUES (v_loser, CURRENT_DATE, -d.stake, 1, 0)
    ON CONFLICT (user_id, date)
    DO UPDATE SET pnl = user_daily_stats.pnl - d.stake, games = user_daily_stats.games + 1;
    PERFORM update_guild_pnl_after_duel(v_loser, -d.stake);
  END IF;

  RETURN jsonb_build_object(
    'result', 'win',
    'winner', v_winner,
    'tiebreak', (d.creator_score = d.opponent_score),
    'creator_time', v_creator_time,
    'opponent_time', v_opp_time
  );
EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'rpc:finalize_duel', SQLERRM, jsonb_build_object('duel_id', p_duel_id));
  RETURN jsonb_build_object('error', 'internal_error');
END;
$$;

-- ── Matchmaking: find_match ──────────────────────────────────────
-- Атомарный поиск соперника. Принимает массив ставок — ищет по всем.
-- FOR UPDATE SKIP LOCKED = без гонок при 100k онлайн.
CREATE OR REPLACE FUNCTION find_match(
  p_user_id  UUID,
  p_category TEXT,
  p_stakes   INTEGER[]
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_opponent      matchmaking_queue%ROWTYPE;
  v_duel_id       UUID;
  v_question_ids  UUID[];
  v_my_balance    INTEGER;
  v_opp_balance   INTEGER;
  v_stake         INTEGER;
  v_matched       BOOLEAN := false;
  v_affected      INTEGER;
BEGIN
  -- Проверяем баланс вызывающего (минимальная ставка)
  SELECT balance INTO v_my_balance FROM users WHERE id = p_user_id;
  IF v_my_balance IS NULL THEN
    RETURN jsonb_build_object('status', 'error', 'error', 'user_not_found');
  END IF;

  -- Сортируем ставки по убыванию (приоритет — самая большая)
  SELECT ARRAY(SELECT unnest(p_stakes) ORDER BY 1 DESC) INTO p_stakes;

  -- Перебираем каждую ставку — ищем матч
  FOREACH v_stake IN ARRAY p_stakes LOOP
    -- Пропускаем ставки которые не можем себе позволить
    IF v_my_balance < v_stake THEN
      CONTINUE;
    END IF;

    -- Ищем соперника с такой же category+stake (атомарно)
    SELECT * INTO v_opponent
    FROM matchmaking_queue
    WHERE category = p_category
      AND stake = v_stake
      AND user_id != p_user_id
    ORDER BY joined_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED;

    IF v_opponent IS NOT NULL THEN
      -- Проверяем АКТУАЛЬНЫЙ баланс соперника (мог измениться с момента постановки в очередь)
      SELECT balance INTO v_opp_balance FROM users WHERE id = v_opponent.user_id;
      IF v_opp_balance IS NOT NULL AND v_opp_balance >= v_stake THEN
        v_matched := true;
        EXIT; -- нашли матч, выходим из цикла
      ELSE
        -- Соперник не может — удаляем его из очереди
        DELETE FROM matchmaking_queue WHERE id = v_opponent.id;
        v_opponent := NULL;
      END IF;
    END IF;
  END LOOP;

  IF NOT v_matched THEN
    -- Не нашли соперника — встаём в очередь по всем доступным ставкам
    -- Сначала удаляем старые записи этого юзера
    DELETE FROM matchmaking_queue WHERE user_id = p_user_id;
    -- Вставляем по каждой ставке
    FOREACH v_stake IN ARRAY p_stakes LOOP
      IF v_my_balance >= v_stake THEN
        INSERT INTO matchmaking_queue (user_id, category, stake)
        VALUES (p_user_id, p_category, v_stake)
        ON CONFLICT (user_id, stake) DO UPDATE
          SET category = EXCLUDED.category, joined_at = NOW();
      END IF;
    END LOOP;
    RETURN jsonb_build_object('status', 'queued');
  END IF;

  -- Матч найден! v_opponent и v_stake заполнены
  -- Выбираем 5 случайных вопросов
  SELECT ARRAY(
    SELECT id FROM questions
    WHERE category = p_category
    ORDER BY RANDOM()
    LIMIT 5
  ) INTO v_question_ids;

  -- Валидация: проверяем что нашлось ровно 5 вопросов
  IF v_question_ids IS NULL OR array_length(v_question_ids, 1) IS NULL OR array_length(v_question_ids, 1) < 5 THEN
    PERFORM admin_log('error', 'rpc:find_match', 'Not enough questions for category',
      jsonb_build_object('category', p_category, 'found', COALESCE(array_length(v_question_ids, 1), 0)));
    RETURN jsonb_build_object('status', 'error', 'error', 'not_enough_questions');
  END IF;

  -- Создаём дуэль
  INSERT INTO duels (creator_id, opponent_id, category, stake, status, question_ids)
  VALUES (v_opponent.user_id, p_user_id, p_category, v_stake, 'active', v_question_ids)
  RETURNING id INTO v_duel_id;

  -- Удаляем ВСЕ записи обоих из очереди
  DELETE FROM matchmaking_queue WHERE user_id IN (p_user_id, v_opponent.user_id);

  -- Атомарное списание ставки: AND balance >= v_stake гарантирует что баланс не уйдёт в минус
  UPDATE users SET balance = balance - v_stake WHERE id = p_user_id AND balance >= v_stake;
  GET DIAGNOSTICS v_affected = ROW_COUNT;
  IF v_affected = 0 THEN
    -- Баланс упал пока искали — откатываем дуэль
    DELETE FROM duels WHERE id = v_duel_id;
    PERFORM admin_log('warn', 'rpc:find_match', 'Caller balance insufficient at deduction',
      jsonb_build_object('user_id', p_user_id, 'stake', v_stake));
    RETURN jsonb_build_object('status', 'error', 'error', 'insufficient_balance');
  END IF;

  UPDATE users SET balance = balance - v_stake WHERE id = v_opponent.user_id AND balance >= v_stake;
  GET DIAGNOSTICS v_affected = ROW_COUNT;
  IF v_affected = 0 THEN
    -- Баланс оппонента упал — возвращаем ставку вызывающему, удаляем дуэль
    UPDATE users SET balance = balance + v_stake WHERE id = p_user_id;
    DELETE FROM duels WHERE id = v_duel_id;
    -- Удаляем оппонента из очереди (баланс не позволяет играть)
    DELETE FROM matchmaking_queue WHERE user_id = v_opponent.user_id AND stake = v_stake;
    PERFORM admin_log('warn', 'rpc:find_match', 'Opponent balance insufficient at deduction',
      jsonb_build_object('opponent_id', v_opponent.user_id, 'stake', v_stake));
    RETURN jsonb_build_object('status', 'error', 'error', 'opponent_balance_insufficient');
  END IF;

  -- Транзакции
  INSERT INTO transactions (user_id, type, amount, ref_id)
  VALUES
    (p_user_id, 'duel_loss', -v_stake, v_duel_id),
    (v_opponent.user_id, 'duel_loss', -v_stake, v_duel_id);

  RETURN jsonb_build_object(
    'status', 'matched',
    'duel_id', v_duel_id,
    'opponent_id', v_opponent.user_id,
    'stake', v_stake
  );
EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'rpc:find_match', SQLERRM,
    jsonb_build_object('user_id', p_user_id, 'category', p_category, 'stakes', p_stakes));
  RETURN jsonb_build_object('status', 'error', 'error', SQLERRM);
END;
$$;

-- ── Matchmaking: cancel ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION cancel_matchmaking(p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  DELETE FROM matchmaking_queue WHERE user_id = p_user_id;
END;
$$;

-- ── Matchmaking: cleanup stale queue entries ────────────────────
CREATE OR REPLACE FUNCTION cleanup_matchmaking_queue()
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  DELETE FROM matchmaking_queue
  WHERE joined_at < NOW() - INTERVAL '3 minutes';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- ── Bot user ───────────────────────────────────────────────────
-- Бот-соперник для дуэлей. Огромный баланс, telegram_id = -1
INSERT INTO users (id, telegram_id, username, first_name, balance, wins, losses)
VALUES ('00000000-0000-0000-0000-000000000001', -1, 'outplay_bot', 'Outplay Bot', 999999999, 0, 0)
ON CONFLICT (telegram_id) DO NOTHING;

-- ── Bot Duel: create_bot_duel ─────────────────────────────────
DROP FUNCTION IF EXISTS create_bot_duel(UUID, TEXT, INTEGER[]);

CREATE OR REPLACE FUNCTION create_bot_duel(
  p_user_id  UUID,
  p_category TEXT,
  p_stakes   INTEGER[]
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_bot_id        UUID := '00000000-0000-0000-0000-000000000001';
  v_my_balance    INTEGER;
  v_stake         INTEGER;
  v_question_ids  UUID[];
  v_duel_id       UUID;
  v_bot_enabled   BOOLEAN;
  v_total_games   INTEGER;
  v_total_wagered INTEGER;
  v_total_paid    INTEGER;
  v_current_pnl   INTEGER;
  v_current_rtp   NUMERIC;
  v_should_win    BOOLEAN;
  v_payout        INTEGER;
  v_affected      INTEGER;
BEGIN
  -- 1. Проверяем что бот включён
  SELECT (value)::boolean INTO v_bot_enabled FROM app_settings WHERE key = 'bot_enabled';
  IF NOT COALESCE(v_bot_enabled, true) THEN
    RETURN jsonb_build_object('status', 'error', 'error', 'bot_disabled');
  END IF;

  -- 2+3. Атомарно удаляем юзера из очереди (защита от race condition с find_match)
  DELETE FROM matchmaking_queue WHERE user_id = p_user_id;
  GET DIAGNOSTICS v_affected = ROW_COUNT;
  IF v_affected = 0 THEN
    -- Юзер уже не в очереди — find_match забрал его раньше
    RETURN jsonb_build_object('status', 'error', 'error', 'not_in_queue');
  END IF;

  -- 4. Баланс
  SELECT balance INTO v_my_balance FROM users WHERE id = p_user_id;
  IF v_my_balance IS NULL THEN
    RETURN jsonb_build_object('status', 'error', 'error', 'user_not_found');
  END IF;

  -- 5. Выбираем максимальную доступную ставку
  SELECT ARRAY(SELECT unnest(p_stakes) ORDER BY 1 DESC) INTO p_stakes;
  v_stake := NULL;
  FOR i IN 1..array_length(p_stakes, 1) LOOP
    IF v_my_balance >= p_stakes[i] THEN
      v_stake := p_stakes[i];
      EXIT;
    END IF;
  END LOOP;

  IF v_stake IS NULL THEN
    RETURN jsonb_build_object('status', 'error', 'error', 'insufficient_balance');
  END IF;

  -- 6. Вопросы
  SELECT ARRAY(
    SELECT id FROM questions WHERE category = p_category ORDER BY RANDOM() LIMIT 5
  ) INTO v_question_ids;

  IF v_question_ids IS NULL OR array_length(v_question_ids, 1) IS NULL OR array_length(v_question_ids, 1) < 5 THEN
    RETURN jsonb_build_object('status', 'error', 'error', 'not_enough_questions');
  END IF;

  -- 7. RTP расчёт — решаем: бот выигрывает или проигрывает
  SELECT COALESCE((value)::integer, 0) INTO v_total_games   FROM app_settings WHERE key = 'bot_total_games';
  SELECT COALESCE((value)::integer, 0) INTO v_total_wagered FROM app_settings WHERE key = 'bot_total_wagered';
  SELECT COALESCE((value)::integer, 0) INTO v_total_paid    FROM app_settings WHERE key = 'bot_total_paid';
  SELECT COALESCE((value)::integer, 0) INTO v_current_pnl   FROM app_settings WHERE key = 'bot_current_pnl';

  v_payout := FLOOR(v_stake * 2 * 0.95); -- что получит игрок при победе

  IF v_current_pnl <= -2000 THEN
    -- Защита дефицита — бот обязан выиграть
    v_should_win := true;
  ELSIF v_total_games < 5 THEN
    -- Холодный старт — лёгкий bias в пользу бота
    v_should_win := random() < 0.55;
  ELSE
    -- RTP = (total_paid / total_wagered) * 100
    v_current_rtp := (v_total_paid::numeric / NULLIF(v_total_wagered, 0)) * 100;
    IF v_current_rtp IS NULL THEN
      v_should_win := random() < 0.55;
    ELSIF v_current_rtp > 95 THEN
      v_should_win := true;  -- слишком много выплатили — забираем
    ELSIF v_current_rtp < 95 THEN
      v_should_win := false; -- мало выплатили — отдаём
    ELSE
      v_should_win := random() < 0.5;
    END IF;
  END IF;

  -- 8. Создаём дуэль
  INSERT INTO duels (creator_id, opponent_id, category, stake, status, question_ids, is_bot_game, bot_should_win)
  VALUES (p_user_id, v_bot_id, p_category, v_stake, 'active', v_question_ids, true, v_should_win)
  RETURNING id INTO v_duel_id;

  -- 9. Списываем ставку с игрока
  UPDATE users SET balance = balance - v_stake WHERE id = p_user_id AND balance >= v_stake;
  GET DIAGNOSTICS v_affected = ROW_COUNT;
  IF v_affected = 0 THEN
    DELETE FROM duels WHERE id = v_duel_id;
    RETURN jsonb_build_object('status', 'error', 'error', 'insufficient_balance');
  END IF;

  -- 10. Списываем ставку с бота (у него огромный баланс — формальность)
  UPDATE users SET balance = balance - v_stake WHERE id = v_bot_id;

  -- 11. Транзакции
  INSERT INTO transactions (user_id, type, amount, ref_id)
  VALUES (p_user_id, 'duel_loss', -v_stake, v_duel_id),
         (v_bot_id, 'duel_loss', -v_stake, v_duel_id);

  -- 12. Обновляем бот-статистику
  UPDATE app_settings SET value = to_jsonb(v_total_games + 1), updated_at = NOW() WHERE key = 'bot_total_games';
  UPDATE app_settings SET value = to_jsonb(v_total_wagered + v_stake), updated_at = NOW() WHERE key = 'bot_total_wagered';

  IF NOT v_should_win THEN
    -- Бот проигрывает → выплата игроку
    UPDATE app_settings SET value = to_jsonb(v_total_paid + v_payout), updated_at = NOW() WHERE key = 'bot_total_paid';
    UPDATE app_settings SET value = to_jsonb(v_current_pnl - (v_payout - v_stake)), updated_at = NOW() WHERE key = 'bot_current_pnl';
  ELSE
    -- Бот выигрывает → игрок теряет ставку
    UPDATE app_settings SET value = to_jsonb(v_current_pnl + v_stake), updated_at = NOW() WHERE key = 'bot_current_pnl';
  END IF;

  RETURN jsonb_build_object(
    'status', 'matched',
    'duel_id', v_duel_id,
    'bot_should_win', v_should_win,
    'stake', v_stake
  );
EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'rpc:create_bot_duel', SQLERRM,
    jsonb_build_object('user_id', p_user_id, 'category', p_category));
  RETURN jsonb_build_object('status', 'error', 'error', SQLERRM);
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
  v_cost     INTEGER := 2000;
  v_balance  INTEGER;
BEGIN
  -- Validate name length
  IF LENGTH(TRIM(p_name)) < 2 OR LENGTH(TRIM(p_name)) > 50 THEN
    RETURN jsonb_build_object('error', 'invalid_name');
  END IF;

  -- Check name uniqueness (case-insensitive)
  IF EXISTS (SELECT 1 FROM guilds WHERE LOWER(name) = LOWER(TRIM(p_name))) THEN
    RETURN jsonb_build_object('error', 'name_taken');
  END IF;

  -- Validate description length
  IF LENGTH(COALESCE(p_description, '')) > 1000 THEN
    RETURN jsonb_build_object('error', 'description_too_long');
  END IF;

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
EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'rpc:create_guild', SQLERRM, jsonb_build_object('user_id', p_user_id, 'name', p_name));
  RETURN jsonb_build_object('error', 'internal_error');
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
EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'rpc:join_guild', SQLERRM, jsonb_build_object('user_id', p_user_id, 'guild_id', p_guild_id));
  RETURN jsonb_build_object('error', 'internal_error');
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
EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'rpc:kick_from_guild', SQLERRM, jsonb_build_object('creator_id', p_creator_id, 'target_id', p_target_id));
  RETURN jsonb_build_object('error', 'internal_error');
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

  -- Validate new name if provided
  IF p_name IS NOT NULL THEN
    IF LENGTH(TRIM(p_name)) < 2 OR LENGTH(TRIM(p_name)) > 50 THEN
      RETURN jsonb_build_object('error', 'invalid_name');
    END IF;
    IF EXISTS (SELECT 1 FROM guilds WHERE LOWER(name) = LOWER(TRIM(p_name)) AND id != p_guild_id) THEN
      RETURN jsonb_build_object('error', 'name_taken');
    END IF;
  END IF;

  -- Validate description length if provided
  IF p_description IS NOT NULL AND LENGTH(p_description) > 1000 THEN
    RETURN jsonb_build_object('error', 'description_too_long');
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
EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'rpc:edit_guild', SQLERRM, jsonb_build_object('user_id', p_user_id, 'guild_id', p_guild_id));
  RETURN jsonb_build_object('error', 'internal_error');
END;
$$;

-- ── Регистрация нового юзера по реферальной ссылке (атомарно) ──
CREATE OR REPLACE FUNCTION register_with_referral(
  p_telegram_id BIGINT,
  p_username    TEXT,
  p_first_name  TEXT,
  p_avatar_url  TEXT,
  p_referrer_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_existing  JSONB;
  v_user_id   UUID;
  v_user_row  JSONB;
  v_ref_valid BOOLEAN := false;
  v_bonus     INTEGER := 100;
BEGIN
  -- 1. Если юзер уже существует — вернуть его (реферал не применяется)
  SELECT to_jsonb(u.*) INTO v_existing FROM users u WHERE u.telegram_id = p_telegram_id;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'existing', 'user', v_existing);
  END IF;

  -- 2. Проверить реферера
  IF p_referrer_id IS NOT NULL THEN
    SELECT EXISTS(SELECT 1 FROM users WHERE id = p_referrer_id) INTO v_ref_valid;
  END IF;

  -- 3. Создать юзера
  IF v_ref_valid THEN
    INSERT INTO users (telegram_id, username, first_name, avatar_url, balance, referred_by)
    VALUES (p_telegram_id, p_username, p_first_name, p_avatar_url, v_bonus, p_referrer_id)
    RETURNING id INTO v_user_id;

    -- 4. Записать реферала
    INSERT INTO referrals (referrer_id, referred_user_id) VALUES (p_referrer_id, v_user_id);

    -- 5. Транзакция бонуса
    INSERT INTO transactions (user_id, type, amount)
    VALUES (v_user_id, 'referral_bonus', v_bonus);

    SELECT to_jsonb(u.*) INTO v_user_row FROM users u WHERE u.id = v_user_id;
    RETURN jsonb_build_object('status', 'new_with_referral', 'user', v_user_row, 'bonus', v_bonus);
  ELSE
    -- Реферер невалиден — создать с начальным бонусом 50
    INSERT INTO users (telegram_id, username, first_name, avatar_url, balance)
    VALUES (p_telegram_id, p_username, p_first_name, p_avatar_url, 50)
    RETURNING id INTO v_user_id;

    SELECT to_jsonb(u.*) INTO v_user_row FROM users u WHERE u.id = v_user_id;
    RETURN jsonb_build_object('status', 'new_no_referrer', 'user', v_user_row);
  END IF;

EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'rpc:register_with_referral', SQLERRM, jsonb_build_object('telegram_id', p_telegram_id, 'referrer_id', p_referrer_id));
  RETURN jsonb_build_object('error', 'internal_error');
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

  -- Rank: users with strictly higher PnL + 1 (exclude bot)
  SELECT COUNT(*) + 1 INTO v_rank
  FROM users u
  WHERE u.id != '00000000-0000-0000-0000-000000000001'
    AND COALESCE((SELECT SUM(pnl) FROM user_daily_stats WHERE user_id = u.id), 0) > v_total;

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
      WHERE u.telegram_id != -1
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
      'avatar_url',   sub.avatar_url,
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
      u.avatar_url,
      COALESCE(SUM(CASE WHEN re.created_at >= CURRENT_DATE THEN re.amount ELSE 0 END), 0)                    AS earned_day,
      COALESCE(SUM(CASE WHEN re.created_at >= CURRENT_DATE - INTERVAL '7 days' THEN re.amount ELSE 0 END), 0) AS earned_week,
      COALESCE(SUM(CASE WHEN re.created_at >= CURRENT_DATE - INTERVAL '30 days' THEN re.amount ELSE 0 END), 0) AS earned_month,
      COALESCE(SUM(re.amount), 0)                                                                              AS earned_all
    FROM referrals r
    JOIN users u ON u.id = r.referred_user_id
    LEFT JOIN referral_earnings re
      ON re.from_user_id = r.referred_user_id AND re.referrer_id = p_user_id
    WHERE r.referrer_id = p_user_id
    GROUP BY u.id, u.first_name, u.username, u.avatar_url
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
  SELECT id INTO v_season_id FROM guild_seasons WHERE is_active = true LIMIT 1;
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

    -- Guild rank among all guilds in season (include guilds with no stats)
    SELECT COALESCE(pos, 999) INTO v_rank
    FROM (
      SELECT g2.id AS guild_id, ROW_NUMBER() OVER (ORDER BY COALESCE(gss2.pnl, 0) DESC) AS pos
      FROM guilds g2
      LEFT JOIN guild_season_stats gss2 ON gss2.guild_id = g2.id AND gss2.season_id = v_season_id
    ) ranked
    WHERE guild_id = v_guild_id;

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
EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'rpc:leave_guild', SQLERRM, jsonb_build_object('user_id', p_user_id));
  RETURN jsonb_build_object('error', 'internal_error');
END;
$$;

-- Delete guild (creator only — removes all members & the guild)
DROP FUNCTION IF EXISTS delete_guild(UUID, UUID);

CREATE OR REPLACE FUNCTION delete_guild(p_user_id UUID, p_guild_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  -- Only creator can delete
  IF NOT EXISTS (
    SELECT 1 FROM guild_members
    WHERE user_id = p_user_id AND guild_id = p_guild_id AND role = 'creator'
  ) THEN
    RETURN jsonb_build_object('error', 'not_creator');
  END IF;

  -- Remove all member stats for this guild
  DELETE FROM guild_member_stats WHERE guild_id = p_guild_id;

  -- Remove all season stats for this guild
  DELETE FROM guild_season_stats WHERE guild_id = p_guild_id;

  -- Remove all members
  DELETE FROM guild_members WHERE guild_id = p_guild_id;

  -- Delete the guild itself
  DELETE FROM guilds WHERE id = p_guild_id;

  RETURN jsonb_build_object('ok', true);
EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'rpc:delete_guild', SQLERRM, jsonb_build_object('user_id', p_user_id, 'guild_id', p_guild_id));
  RETURN jsonb_build_object('error', 'internal_error');
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
        AND u.telegram_id != -1
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
EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'rpc:send_friend_request', SQLERRM, jsonb_build_object('from_id', p_from_id, 'to_id', p_to_id));
  RETURN jsonb_build_object('error', 'internal_error');
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
EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'rpc:accept_friend_request', SQLERRM, jsonb_build_object('user_id', p_user_id, 'request_id', p_request_id));
  RETURN jsonb_build_object('error', 'internal_error');
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
EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'rpc:reject_friend_request', SQLERRM, jsonb_build_object('user_id', p_user_id, 'request_id', p_request_id));
  RETURN jsonb_build_object('error', 'internal_error');
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
EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'rpc:remove_friend', SQLERRM, jsonb_build_object('user_id', p_user_id, 'friend_id', p_friend_id));
  RETURN jsonb_build_object('error', 'internal_error');
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

  -- Atomic dedup: try INSERT, if conflict on ref_id → duplicate
  INSERT INTO transactions (user_id, type, amount, currency_amount, currency_code, ref_id)
  VALUES (p_user_id, 'deposit', p_amount, p_currency_amt, p_currency_code, p_tx_id)
  ON CONFLICT (ref_id) WHERE type = 'deposit' AND ref_id IS NOT NULL DO NOTHING;

  IF NOT FOUND THEN
    SELECT balance INTO new_balance FROM users WHERE id = p_user_id;
    RETURN jsonb_build_object('new_balance', new_balance, 'duplicate', true);
  END IF;

  -- Credit balance
  UPDATE users
  SET balance = balance + p_amount
  WHERE id = p_user_id
  RETURNING balance INTO new_balance;

  RETURN jsonb_build_object('new_balance', new_balance);
EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'rpc:process_deposit', SQLERRM, jsonb_build_object('user_id', p_user_id, 'amount', p_amount, 'tx_id', p_tx_id));
  RETURN jsonb_build_object('error', 'internal_error');
END;
$$;

-- ╔═══════════════════════════════════════════╗
-- ║  18. CRYPTO PROCESSED TXS                ║
-- ╚═══════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS crypto_processed_txs (
  tx_hash    TEXT PRIMARY KEY,
  chain      TEXT NOT NULL,
  crypto_amt NUMERIC(20,8) NOT NULL,
  rub_amount NUMERIC(12,2) NOT NULL,
  stars      INTEGER NOT NULL,
  user_id    UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crypto_tx_user ON crypto_processed_txs(user_id, created_at DESC);

-- process_crypto_deposit — зачисление крипто-депозита с дедупликацией
CREATE OR REPLACE FUNCTION process_crypto_deposit(
  p_user_id      UUID,
  p_stars        INTEGER,
  p_tx_hash      TEXT,
  p_chain        TEXT,
  p_crypto_amt   NUMERIC,
  p_rub_amount   NUMERIC
) RETURNS JSONB AS $$
DECLARE
  new_bal INTEGER;
BEGIN
  IF p_stars < 1 THEN
    RETURN jsonb_build_object('error', 'stars must be >= 1');
  END IF;

  -- Atomic dedup: INSERT ON CONFLICT eliminates race condition
  INSERT INTO crypto_processed_txs (tx_hash, chain, crypto_amt, rub_amount, stars, user_id)
  VALUES (p_tx_hash, p_chain, p_crypto_amt, p_rub_amount, p_stars, p_user_id)
  ON CONFLICT (tx_hash) DO NOTHING;

  IF NOT FOUND THEN
    SELECT balance INTO new_bal FROM users WHERE id = p_user_id;
    RETURN jsonb_build_object('new_balance', new_bal, 'duplicate', true);
  END IF;

  UPDATE users SET balance = balance + p_stars WHERE id = p_user_id
  RETURNING balance INTO new_bal;

  INSERT INTO transactions (user_id, type, amount, currency_amount, currency_code)
  VALUES (p_user_id, 'deposit', p_stars, p_rub_amount, 'RUB');

  RETURN jsonb_build_object('new_balance', new_bal, 'credited', true);
EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'rpc:process_crypto_deposit', SQLERRM, jsonb_build_object('user_id', p_user_id, 'stars', p_stars, 'tx_hash', p_tx_hash));
  RETURN jsonb_build_object('error', 'internal_error');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

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
ALTER TABLE crypto_processed_txs ENABLE ROW LEVEL SECURITY;

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
DROP POLICY IF EXISTS "read_all" ON crypto_processed_txs;

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
CREATE POLICY "read_all" ON crypto_processed_txs FOR SELECT USING (true);

-- Запись — ТОЛЬКО через SECURITY DEFINER RPC функции (они обходят RLS)
-- Прямая запись с клиента заблокирована для чувствительных таблиц
-- users — единственная таблица с прямой записью (регистрация, профиль, ping)
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
DROP POLICY IF EXISTS "write_all" ON crypto_processed_txs;

-- users: клиент может INSERT (регистрация) и UPDATE (профиль, last_seen, настройки)
-- Баланс защищён CHECK constraint (>= 0), критические операции через SECURITY DEFINER
CREATE POLICY "users_insert" ON users FOR INSERT WITH CHECK (true);
CREATE POLICY "users_update" ON users FOR UPDATE USING (true) WITH CHECK (true);

-- ╔═══════════════════════════════════════════╗
-- ║  19. APP SETTINGS (feature flags)         ║
-- ╚═══════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL DEFAULT 'true'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO app_settings (key, value) VALUES
  ('stars_deposits',  'true'::jsonb),
  ('crypto_deposits', 'true'::jsonb),
  ('withdrawals',     'true'::jsonb),
  ('game_creation',   'true'::jsonb),
  ('subscriptions',   'true'::jsonb),
  ('bot_enabled',     'true'::jsonb),
  ('bot_total_games', '0'::jsonb),
  ('bot_total_wagered', '0'::jsonb),
  ('bot_total_paid',  '0'::jsonb),
  ('bot_current_pnl', '0'::jsonb)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "read_all" ON app_settings;
CREATE POLICY "read_all" ON app_settings FOR SELECT USING (true);
DROP POLICY IF EXISTS "write_all" ON app_settings;
-- app_settings: запись только через SECURITY DEFINER update_app_setting()

-- get_app_settings — все настройки одним запросом
CREATE OR REPLACE FUNCTION get_app_settings()
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN (SELECT jsonb_object_agg(key, value) FROM app_settings);
END;
$$;

-- update_app_setting — обновить одну настройку
CREATE OR REPLACE FUNCTION update_app_setting(p_key TEXT, p_value JSONB)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE app_settings SET value = p_value, updated_at = NOW() WHERE key = p_key;
END;
$$;

-- get_admin_stats — вся статистика одним запросом
CREATE OR REPLACE FUNCTION get_admin_stats()
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE r JSONB;
BEGIN
  SELECT jsonb_build_object(
    'total_users',           (SELECT COUNT(*) FROM users WHERE telegram_id != -1),
    'online_now',            (SELECT COUNT(*) FROM users WHERE last_seen > NOW() - INTERVAL '5 minutes' AND telegram_id != -1),
    'new_today',             (SELECT COUNT(*) FROM users WHERE created_at >= CURRENT_DATE),
    'new_week',              (SELECT COUNT(*) FROM users WHERE created_at >= DATE_TRUNC('week', NOW())),
    'new_month',             (SELECT COUNT(*) FROM users WHERE created_at >= DATE_TRUNC('month', NOW())),
    'total_games',           (SELECT COUNT(*) FROM duels WHERE status = 'finished'),
    'games_today',           (SELECT COUNT(*) FROM duels WHERE status = 'finished' AND finished_at >= CURRENT_DATE),
    'games_week',            (SELECT COUNT(*) FROM duels WHERE status = 'finished' AND finished_at >= DATE_TRUNC('week', NOW())),
    'games_month',           (SELECT COUNT(*) FROM duels WHERE status = 'finished' AND finished_at >= DATE_TRUNC('month', NOW())),
    'active_games',          (SELECT COUNT(*) FROM duels WHERE status IN ('waiting', 'active')),
    'deposits_total',        (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE type = 'deposit'),
    'withdrawals_total',     (SELECT COALESCE(ABS(SUM(amount)), 0) FROM transactions WHERE type = 'withdrawal'),
    'deposits_today',        (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE type = 'deposit' AND created_at >= CURRENT_DATE),
    'deposits_week',         (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE type = 'deposit' AND created_at >= DATE_TRUNC('week', NOW())),
    'deposits_month',        (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE type = 'deposit' AND created_at >= DATE_TRUNC('month', NOW())),
    'total_user_balances',   (SELECT COALESCE(SUM(balance), 0) FROM users WHERE telegram_id != -1),
    'total_pro',             (SELECT COUNT(*) FROM users WHERE is_pro = true AND pro_expires > NOW()),
    'total_guilds',          (SELECT COUNT(*) FROM guilds),
    'crypto_deposits_stars', (SELECT COALESCE(SUM(stars), 0) FROM crypto_processed_txs),
    'guild_prize_pool',      (SELECT COALESCE(prize_pool, 0) FROM guild_seasons WHERE is_active = true LIMIT 1)
  ) INTO r;
  RETURN r;
END;
$$;

-- admin_search_user — поиск юзера + его транзакции
CREATE OR REPLACE FUNCTION admin_search_user(p_query TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_user JSONB;
  v_txs  JSONB;
  v_uid  UUID;
BEGIN
  -- Ищем по telegram_id или username
  SELECT id INTO v_uid FROM users
  WHERE telegram_id::text = p_query
     OR LOWER(username) = LOWER(p_query)
     OR LOWER(first_name) ILIKE '%' || LOWER(p_query) || '%'
  LIMIT 1;

  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  SELECT row_to_json(u)::jsonb INTO v_user
  FROM (SELECT id, telegram_id, username, first_name, avatar_url, balance, wins, losses,
               is_pro, pro_expires, currency, lang, last_seen, created_at FROM users WHERE id = v_uid) u;

  SELECT COALESCE(jsonb_agg(t), '[]'::jsonb) INTO v_txs
  FROM (SELECT type, amount, currency_amount, currency_code, created_at
        FROM transactions WHERE user_id = v_uid ORDER BY created_at DESC LIMIT 50) t;

  RETURN jsonb_build_object('user', v_user, 'transactions', v_txs);
END;
$$;

-- =============================================
-- ╔═══════════════════════════════════════════╗
-- ║  ADMIN LOGS (error/event tracking)        ║
-- ╚═══════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS admin_logs (
  id          BIGSERIAL PRIMARY KEY,
  level       TEXT NOT NULL DEFAULT 'error',   -- error | warn | info
  source      TEXT NOT NULL,                    -- rpc:function_name | edge:function_name | client
  message     TEXT NOT NULL,
  details     JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_logs_created ON admin_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_logs_level ON admin_logs(level);

-- Auto-cleanup: keep only last 1000 logs
CREATE OR REPLACE FUNCTION cleanup_admin_logs()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM admin_logs
  WHERE id NOT IN (
    SELECT id FROM admin_logs ORDER BY created_at DESC LIMIT 1000
  );
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_cleanup_admin_logs ON admin_logs;
CREATE TRIGGER trg_cleanup_admin_logs
  AFTER INSERT ON admin_logs
  FOR EACH STATEMENT
  WHEN (pg_trigger_depth() = 0)
  EXECUTE FUNCTION cleanup_admin_logs();

-- Helper to write a log entry from any RPC/Edge function
CREATE OR REPLACE FUNCTION admin_log(p_level TEXT, p_source TEXT, p_message TEXT, p_details JSONB DEFAULT '{}')
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO admin_logs (level, source, message, details) VALUES (p_level, p_source, p_message, p_details);
END;
$$;

-- ╔═══════════════════════════════════════════╗
-- ║  GET ADMIN SERVER INFO                    ║
-- ╚═══════════════════════════════════════════╝

DROP FUNCTION IF EXISTS get_admin_server_info();

CREATE OR REPLACE FUNCTION get_admin_server_info()
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_db_stats JSONB;
  v_table_counts JSONB;
  v_recent_logs JSONB;
  v_rpc_stats JSONB;
  v_edge_stats JSONB;
  v_pg_version TEXT;
  v_db_size TEXT;
  v_uptime INTERVAL;
BEGIN
  -- PostgreSQL version
  SELECT version() INTO v_pg_version;

  -- DB size
  SELECT pg_size_pretty(pg_database_size(current_database())) INTO v_db_size;

  -- Server uptime
  SELECT NOW() - pg_postmaster_start_time() INTO v_uptime;

  -- Table row counts (approximate for speed)
  SELECT jsonb_build_object(
    'users',              (SELECT COUNT(*) FROM users),
    'duels',              (SELECT COUNT(*) FROM duels),
    'questions',          (SELECT COUNT(*) FROM questions),
    'guilds',             (SELECT COUNT(*) FROM guilds),
    'guild_members',      (SELECT COUNT(*) FROM guild_members),
    'transactions',       (SELECT COUNT(*) FROM transactions),
    'friends',            (SELECT COUNT(*) FROM friends),
    'friend_requests',    (SELECT COUNT(*) FROM friend_requests),
    'referrals',          (SELECT COUNT(*) FROM referrals),
    'subscriptions',      (SELECT COUNT(*) FROM subscriptions),
    'crypto_processed_txs', (SELECT COUNT(*) FROM crypto_processed_txs)
  ) INTO v_table_counts;

  -- Recent logs (last 30)
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id',         l.id,
      'level',      l.level,
      'source',     l.source,
      'message',    l.message,
      'details',    l.details,
      'created_at', l.created_at
    ) ORDER BY l.created_at DESC
  ), '[]'::JSONB) INTO v_recent_logs
  FROM (SELECT * FROM admin_logs ORDER BY created_at DESC LIMIT 30) l;

  -- RPC function stats from pg_stat_user_functions
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'name',       f.funcname,
      'calls',      f.calls,
      'total_ms',   ROUND(f.total_time::NUMERIC),
      'avg_ms',     CASE WHEN f.calls > 0 THEN ROUND((f.total_time / f.calls)::NUMERIC) ELSE 0 END
    ) ORDER BY f.calls DESC
  ), '[]'::JSONB) INTO v_rpc_stats
  FROM pg_stat_user_functions f
  WHERE f.schemaname = 'public';

  -- Edge function stats (derived from data)
  SELECT jsonb_build_object(
    'create_stars_invoice', jsonb_build_object(
      'last_call', (SELECT MAX(created_at) FROM transactions WHERE type = 'deposit'),
      'calls_today', (SELECT COUNT(*) FROM transactions WHERE type = 'deposit' AND created_at >= CURRENT_DATE)
    ),
    'check_crypto_deposits', jsonb_build_object(
      'last_call', (SELECT MAX(created_at) FROM crypto_processed_txs),
      'calls_today', (SELECT COUNT(*) FROM crypto_processed_txs WHERE created_at >= CURRENT_DATE)
    ),
    'telegram_webhook', jsonb_build_object(
      'last_call', (SELECT MAX(created_at) FROM users),
      'calls_today', (SELECT COUNT(*) FROM users WHERE last_seen >= CURRENT_DATE)
    )
  ) INTO v_edge_stats;

  -- DB connection stats
  SELECT jsonb_build_object(
    'active_connections', (SELECT COUNT(*) FROM pg_stat_activity WHERE state = 'active'),
    'idle_connections',   (SELECT COUNT(*) FROM pg_stat_activity WHERE state = 'idle'),
    'total_connections',  (SELECT COUNT(*) FROM pg_stat_activity)
  ) INTO v_db_stats;

  RETURN jsonb_build_object(
    'pg_version',     v_pg_version,
    'db_size',        v_db_size,
    'uptime_seconds', EXTRACT(EPOCH FROM v_uptime)::BIGINT,
    'db_stats',       v_db_stats,
    'table_counts',   v_table_counts,
    'recent_logs',    v_recent_logs,
    'rpc_stats',      v_rpc_stats,
    'edge_stats',     v_edge_stats
  );
END;
$$;

-- ИТОГО 19 таблиц (+ app_settings):
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
-- 18. crypto_processed_txs — обработанные крипто-депозиты
-- 19. matchmaking_queue    — очередь поиска соперников
--
-- RPC функций:
--  1. increment_balance    — атомарный баланс
--  2. finalize_duel        — результат дуэли + рефбонус + гильдии
--  3. update_guild_pnl_after_duel — PnL гильдии/участника
--  4. create_guild         — создание гильдии (-2000)
--  5. join_guild           — вступление
--  6. kick_from_guild      — исключение
--  7. edit_guild           — редактирование (-100)
--  8. get_referral_stats   — доходы по периодам
--  9. get_user_profile     — профиль (rank + daily_stats + total_pnl)
-- 10. process_crypto_deposit — зачисление крипто-депозита
-- 11. find_match             — атомарный поиск соперника
-- 12. cancel_matchmaking     — отмена поиска
-- 13. cleanup_matchmaking_queue — очистка зависших
-- 14. submit_answer             — запись ответа + авто-финализация
-- =============================================

-- ╔═══════════════════════════════════════════╗
-- ║  DUEL ANSWERS                             ║
-- ╚═══════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS duel_answers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  duel_id         UUID NOT NULL REFERENCES duels(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id),
  question_index  INTEGER NOT NULL CHECK (question_index BETWEEN 0 AND 4),
  answer_index    INTEGER,                     -- null = таймаут
  is_correct      BOOLEAN NOT NULL DEFAULT false,
  time_spent      REAL NOT NULL DEFAULT 15.0,  -- секунды на ответ
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(duel_id, user_id, question_index)
);

CREATE INDEX IF NOT EXISTS idx_duel_answers_duel ON duel_answers(duel_id);
CREATE INDEX IF NOT EXISTS idx_duel_answers_duel_qi ON duel_answers(duel_id, question_index);
CREATE INDEX IF NOT EXISTS idx_duel_answers_duel_user ON duel_answers(duel_id, user_id);

ALTER TABLE duel_answers ENABLE ROW LEVEL SECURITY;
-- duel_answers: чтение открыто, запись только через submit_answer() SECURITY DEFINER
CREATE POLICY "duel_answers_read" ON duel_answers FOR SELECT USING (true);
DROP POLICY IF EXISTS "duel_answers_all" ON duel_answers;

-- ╔═══════════════════════════════════════════╗
-- ║  RPC: submit_answer                       ║
-- ╚═══════════════════════════════════════════╝

DROP FUNCTION IF EXISTS submit_answer(UUID, UUID, INTEGER, INTEGER, BOOLEAN, REAL);

CREATE OR REPLACE FUNCTION submit_answer(
  p_duel_id        UUID,
  p_user_id        UUID,
  p_question_index INTEGER,
  p_answer_index   INTEGER,     -- null для таймаута
  p_is_correct     BOOLEAN,
  p_time_spent     REAL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_both_count    INTEGER;
  v_total_answers INTEGER;
  v_duel          duels%ROWTYPE;
  v_creator_score INTEGER;
  v_opp_score     INTEGER;
  v_safe_time     REAL;
BEGIN
  -- Валидация входных данных
  IF p_question_index < 0 OR p_question_index > 4 THEN
    RETURN jsonb_build_object('error', 'invalid_question_index');
  END IF;
  IF p_answer_index IS NOT NULL AND (p_answer_index < 0 OR p_answer_index > 3) THEN
    RETURN jsonb_build_object('error', 'invalid_answer_index');
  END IF;
  -- Clamp time_spent в допустимых пределах
  v_safe_time := LEAST(GREATEST(COALESCE(p_time_spent, 15.0), 0), 15);

  -- Блокируем строку дуэли — ключевая защита от гонки двойной финализации
  SELECT * INTO v_duel FROM duels WHERE id = p_duel_id FOR UPDATE;

  IF v_duel IS NULL THEN
    RETURN jsonb_build_object('error', 'duel_not_found');
  END IF;

  IF v_duel.status != 'active' THEN
    RETURN jsonb_build_object('error', 'duel_not_active');
  END IF;

  -- Проверка что пользователь — участник дуэли
  IF p_user_id != v_duel.creator_id AND p_user_id != v_duel.opponent_id THEN
    RETURN jsonb_build_object('error', 'not_participant');
  END IF;

  -- Записываем ответ (ON CONFLICT = защита от дублей)
  INSERT INTO duel_answers (duel_id, user_id, question_index, answer_index, is_correct, time_spent)
  VALUES (p_duel_id, p_user_id, p_question_index, p_answer_index, p_is_correct, v_safe_time)
  ON CONFLICT (duel_id, user_id, question_index) DO NOTHING;

  -- Сколько игроков ответили на ЭТОТ вопрос
  SELECT COUNT(*) INTO v_both_count
  FROM duel_answers
  WHERE duel_id = p_duel_id AND question_index = p_question_index;

  -- Всего ответов в дуэли (оба игрока, все вопросы)
  SELECT COUNT(*) INTO v_total_answers
  FROM duel_answers
  WHERE duel_id = p_duel_id;

  -- Если оба ответили на все 5 вопросов (10 ответов) — финализируем
  IF v_total_answers >= 10 AND v_duel.status = 'active' THEN
    -- Считаем очки каждого
    SELECT COUNT(*) INTO v_creator_score
    FROM duel_answers WHERE duel_id = p_duel_id AND user_id = v_duel.creator_id AND is_correct = true;

    SELECT COUNT(*) INTO v_opp_score
    FROM duel_answers WHERE duel_id = p_duel_id AND user_id = v_duel.opponent_id AND is_correct = true;

    -- Обновляем scores перед финализацией
    UPDATE duels SET creator_score = v_creator_score, opponent_score = v_opp_score
    WHERE id = p_duel_id;

    -- Финализируем (дуэль уже заблокирована — finalize_duel увидит обновлённые данные)
    PERFORM finalize_duel(p_duel_id);
  END IF;

  RETURN jsonb_build_object(
    'answered_count', v_both_count,
    'total_answers', v_total_answers
  );
EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'rpc:submit_answer', SQLERRM,
    jsonb_build_object('duel_id', p_duel_id, 'user_id', p_user_id, 'q_index', p_question_index));
  RETURN jsonb_build_object('error', SQLERRM);
END;
$$;

-- ╔═══════════════════════════════════════════╗
-- ║  5 тестовых вопросов (general, ru)        ║
-- ╚═══════════════════════════════════════════╝

INSERT INTO questions (category, question, options, correct_index, difficulty, lang) VALUES
('general', 'Какая планета Солнечной системы самая большая?',
 '["Сатурн", "Юпитер", "Нептун", "Уран"]'::JSONB, 1, 1, 'ru'),

('general', 'Сколько костей в теле взрослого человека?',
 '["186", "206", "226", "256"]'::JSONB, 1, 2, 'ru'),

('general', 'Какой химический элемент обозначается символом Au?',
 '["Серебро", "Алюминий", "Золото", "Аргон"]'::JSONB, 2, 1, 'ru'),

('general', 'В каком году человек впервые побывал на Луне?',
 '["1965", "1967", "1969", "1971"]'::JSONB, 2, 1, 'ru'),

('general', 'Какой океан самый глубокий?',
 '["Атлантический", "Индийский", "Тихий", "Северный Ледовитый"]'::JSONB, 2, 1, 'ru');
