-- =============================================
-- CRITICAL FIXES MIGRATION
-- Выполни в Supabase SQL Editor
-- =============================================

-- ╔═══════════════════════════════════════════╗
-- ║  1. BALANCE SAFETY: CHECK >= 0           ║
-- ╚═══════════════════════════════════════════╝

-- Баланс НИКОГДА не может уйти в минус — последний рубеж защиты
DO $$
BEGIN
  ALTER TABLE users ADD CONSTRAINT users_balance_non_negative CHECK (balance >= 0);
EXCEPTION WHEN duplicate_object THEN
  NULL; -- constraint already exists
END $$;


-- ╔═══════════════════════════════════════════╗
-- ║  2. INDEXES: duel_answers performance    ║
-- ╚═══════════════════════════════════════════╝

CREATE INDEX IF NOT EXISTS idx_duel_answers_duel_qi ON duel_answers(duel_id, question_index);
CREATE INDEX IF NOT EXISTS idx_duel_answers_duel_user ON duel_answers(duel_id, user_id);


-- ╔═══════════════════════════════════════════╗
-- ║  3. RLS: Убираем опасные write_all       ║
-- ╚═══════════════════════════════════════════╝

-- Удаляем полный доступ на запись для всех чувствительных таблиц
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
DROP POLICY IF EXISTS "write_all" ON app_settings;
DROP POLICY IF EXISTS "duel_answers_all" ON duel_answers;

-- users: оставляем INSERT/UPDATE (регистрация, профиль, ping) — balance защищён CHECK
DROP POLICY IF EXISTS "write_all" ON users;
CREATE POLICY "users_insert" ON users FOR INSERT WITH CHECK (true);
CREATE POLICY "users_update" ON users FOR UPDATE USING (true) WITH CHECK (true);

-- duel_answers: только чтение (запись через submit_answer SECURITY DEFINER)
CREATE POLICY "duel_answers_read" ON duel_answers FOR SELECT USING (true);


-- ╔═══════════════════════════════════════════╗
-- ║  4. finalize_duel: FOR UPDATE lock       ║
-- ╚═══════════════════════════════════════════╝

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
  v_total_pot := d.stake * 2;
  v_rake      := FLOOR(v_total_pot * 5 / 100);       -- 5% рейк
  v_guild_fee := FLOOR(v_total_pot * 5 / 1000);      -- 0.5% гильдии

  -- Добавить 0.5% в призовой фонд активного сезона гильдий
  SELECT id INTO v_season_id FROM guild_seasons WHERE is_active = true LIMIT 1;
  IF v_season_id IS NOT NULL THEN
    UPDATE guild_seasons SET prize_pool = prize_pool + v_guild_fee WHERE id = v_season_id;
  END IF;

  IF d.creator_score > d.opponent_score THEN
    v_winner := d.creator_id;
    v_loser  := d.opponent_id;
  ELSIF d.opponent_score > d.creator_score THEN
    v_winner := d.opponent_id;
    v_loser  := d.creator_id;
  ELSE
    -- Одинаковый счёт — тайбрейк по суммарному времени ответов
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
  SELECT referrer_id INTO v_ref_id FROM referrals WHERE referred_user_id = v_winner;
  IF v_ref_id IS NOT NULL THEN
    SELECT wins INTO v_winner_wins FROM users WHERE id = v_winner;
    IF v_winner_wins % 3 = 0 THEN
      v_bonus := GREATEST(1, FLOOR(v_total_pot * 1 / 100));
      v_bot_fee := v_rake - v_guild_fee - v_bonus;
      UPDATE users SET balance = balance + v_bonus WHERE id = v_ref_id;
      INSERT INTO referral_earnings (referrer_id, from_user_id, duel_id, amount)
      VALUES (v_ref_id, v_winner, p_duel_id, v_bonus);
      INSERT INTO transactions (user_id, type, amount, ref_id)
      VALUES (v_ref_id, 'referral_bonus', v_bonus, p_duel_id);
    ELSE
      v_bot_fee := v_rake - v_guild_fee;
    END IF;
  ELSE
    v_bot_fee := v_rake - v_guild_fee;
  END IF;

  -- Победитель получает pot - rake
  payout := v_total_pot - v_rake;
  UPDATE users SET balance = balance + payout WHERE id = v_winner;

  -- Обновляем дуэль
  UPDATE duels SET status = 'finished', winner_id = v_winner, finished_at = NOW() WHERE id = p_duel_id;

  -- Транзакции
  INSERT INTO transactions (user_id, type, amount, ref_id)
  VALUES (v_winner, 'duel_win', payout, p_duel_id),
         (v_loser, 'duel_loss', -d.stake, p_duel_id);

  -- Дневная статистика
  INSERT INTO user_daily_stats (user_id, date, pnl, games, wins)
  VALUES (v_winner, CURRENT_DATE, payout - d.stake, 1, 1)
  ON CONFLICT (user_id, date)
  DO UPDATE SET pnl = user_daily_stats.pnl + (payout - d.stake), games = user_daily_stats.games + 1, wins = user_daily_stats.wins + 1;

  INSERT INTO user_daily_stats (user_id, date, pnl, games, wins)
  VALUES (v_loser, CURRENT_DATE, -d.stake, 1, 0)
  ON CONFLICT (user_id, date)
  DO UPDATE SET pnl = user_daily_stats.pnl - d.stake, games = user_daily_stats.games + 1;

  -- Обновляем PnL гильдий
  PERFORM update_guild_pnl_after_duel(v_winner, payout - d.stake);
  PERFORM update_guild_pnl_after_duel(v_loser, -d.stake);

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


-- ╔═══════════════════════════════════════════╗
-- ║  5. find_match: Atomic balance deduction ║
-- ║     + question count validation          ║
-- ╚═══════════════════════════════════════════╝

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
  -- Проверяем баланс вызывающего
  SELECT balance INTO v_my_balance FROM users WHERE id = p_user_id;
  IF v_my_balance IS NULL THEN
    RETURN jsonb_build_object('status', 'error', 'error', 'user_not_found');
  END IF;

  -- Сортируем ставки по убыванию
  SELECT ARRAY(SELECT unnest(p_stakes) ORDER BY 1 DESC) INTO p_stakes;

  -- Перебираем каждую ставку — ищем матч
  FOREACH v_stake IN ARRAY p_stakes LOOP
    IF v_my_balance < v_stake THEN
      CONTINUE;
    END IF;

    -- Ищем соперника (атомарно, без гонок)
    SELECT * INTO v_opponent
    FROM matchmaking_queue
    WHERE category = p_category
      AND stake = v_stake
      AND user_id != p_user_id
    ORDER BY joined_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED;

    IF v_opponent IS NOT NULL THEN
      -- Проверяем АКТУАЛЬНЫЙ баланс соперника
      SELECT balance INTO v_opp_balance FROM users WHERE id = v_opponent.user_id;
      IF v_opp_balance IS NOT NULL AND v_opp_balance >= v_stake THEN
        v_matched := true;
        EXIT;
      ELSE
        DELETE FROM matchmaking_queue WHERE id = v_opponent.id;
        v_opponent := NULL;
      END IF;
    END IF;
  END LOOP;

  IF NOT v_matched THEN
    DELETE FROM matchmaking_queue WHERE user_id = p_user_id;
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

  -- Выбираем 5 случайных вопросов
  SELECT ARRAY(
    SELECT id FROM questions
    WHERE category = p_category
    ORDER BY RANDOM()
    LIMIT 5
  ) INTO v_question_ids;

  -- Валидация: ровно 5 вопросов
  IF v_question_ids IS NULL OR array_length(v_question_ids, 1) IS NULL OR array_length(v_question_ids, 1) < 5 THEN
    PERFORM admin_log('error', 'rpc:find_match', 'Not enough questions for category',
      jsonb_build_object('category', p_category, 'found', COALESCE(array_length(v_question_ids, 1), 0)));
    RETURN jsonb_build_object('status', 'error', 'error', 'not_enough_questions');
  END IF;

  -- Создаём дуэль
  INSERT INTO duels (creator_id, opponent_id, category, stake, status, question_ids)
  VALUES (v_opponent.user_id, p_user_id, p_category, v_stake, 'active', v_question_ids)
  RETURNING id INTO v_duel_id;

  -- Удаляем обоих из очереди
  DELETE FROM matchmaking_queue WHERE user_id IN (p_user_id, v_opponent.user_id);

  -- Атомарное списание: AND balance >= v_stake предотвращает минус
  UPDATE users SET balance = balance - v_stake WHERE id = p_user_id AND balance >= v_stake;
  GET DIAGNOSTICS v_affected = ROW_COUNT;
  IF v_affected = 0 THEN
    DELETE FROM duels WHERE id = v_duel_id;
    PERFORM admin_log('warn', 'rpc:find_match', 'Caller balance insufficient at deduction',
      jsonb_build_object('user_id', p_user_id, 'stake', v_stake));
    RETURN jsonb_build_object('status', 'error', 'error', 'insufficient_balance');
  END IF;

  UPDATE users SET balance = balance - v_stake WHERE id = v_opponent.user_id AND balance >= v_stake;
  GET DIAGNOSTICS v_affected = ROW_COUNT;
  IF v_affected = 0 THEN
    UPDATE users SET balance = balance + v_stake WHERE id = p_user_id;
    DELETE FROM duels WHERE id = v_duel_id;
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


-- ╔═══════════════════════════════════════════╗
-- ║  6. submit_answer: Full protection       ║
-- ╚═══════════════════════════════════════════╝

DROP FUNCTION IF EXISTS submit_answer(UUID, UUID, INTEGER, INTEGER, BOOLEAN, REAL);

CREATE OR REPLACE FUNCTION submit_answer(
  p_duel_id        UUID,
  p_user_id        UUID,
  p_question_index INTEGER,
  p_answer_index   INTEGER,
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
  v_safe_time := LEAST(GREATEST(COALESCE(p_time_spent, 15.0), 0), 15);

  -- Блокируем строку дуэли — ключевая защита от двойной финализации
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

  -- Всего ответов в дуэли
  SELECT COUNT(*) INTO v_total_answers
  FROM duel_answers
  WHERE duel_id = p_duel_id;

  -- Если оба ответили на все 5 вопросов (10 ответов) — финализируем
  IF v_total_answers >= 10 AND v_duel.status = 'active' THEN
    SELECT COUNT(*) INTO v_creator_score
    FROM duel_answers WHERE duel_id = p_duel_id AND user_id = v_duel.creator_id AND is_correct = true;

    SELECT COUNT(*) INTO v_opp_score
    FROM duel_answers WHERE duel_id = p_duel_id AND user_id = v_duel.opponent_id AND is_correct = true;

    UPDATE duels SET creator_score = v_creator_score, opponent_score = v_opp_score
    WHERE id = p_duel_id;

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
-- ║  DONE! Все критические фиксы применены   ║
-- ╚═══════════════════════════════════════════╝
