-- ╔═══════════════════════════════════════════════════════════╗
-- ║  Migration: Sequence Game Support                        ║
-- ║  Adds sequence game type to matchmaking + finalization   ║
-- ╚═══════════════════════════════════════════════════════════╝


-- ╔═══════════════════════════════════════════╗
-- ║  1. Add time columns to duels            ║
-- ╚═══════════════════════════════════════════╝

ALTER TABLE duels ADD COLUMN IF NOT EXISTS creator_time REAL;
ALTER TABLE duels ADD COLUMN IF NOT EXISTS opponent_time REAL;


-- ╔═══════════════════════════════════════════╗
-- ║  2. Update find_match for sequence       ║
-- ╚═══════════════════════════════════════════╝

CREATE OR REPLACE FUNCTION find_match(
  p_user_id   UUID,
  p_category  TEXT,
  p_stakes    INTEGER[],
  p_game_type TEXT DEFAULT 'quiz'
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
  v_bj_deck       JSONB;
  v_bj_state      JSONB;
BEGIN
  SELECT balance INTO v_my_balance FROM users WHERE id = p_user_id;
  IF v_my_balance IS NULL THEN
    RETURN jsonb_build_object('status', 'error', 'error', 'user_not_found');
  END IF;

  SELECT ARRAY(SELECT unnest(p_stakes) ORDER BY 1 DESC) INTO p_stakes;

  FOREACH v_stake IN ARRAY p_stakes LOOP
    IF v_my_balance < v_stake THEN
      CONTINUE;
    END IF;

    -- Ищем соперника с тем же game_type
    SELECT * INTO v_opponent
    FROM matchmaking_queue
    WHERE category = p_category
      AND stake = v_stake
      AND user_id != p_user_id
      AND game_type = p_game_type
    ORDER BY joined_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED;

    IF v_opponent IS NOT NULL THEN
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
        INSERT INTO matchmaking_queue (user_id, category, stake, game_type)
        VALUES (p_user_id, p_category, v_stake, p_game_type)
        ON CONFLICT (user_id, stake) DO UPDATE
          SET category = EXCLUDED.category, joined_at = NOW(), game_type = EXCLUDED.game_type;
      END IF;
    END LOOP;
    RETURN jsonb_build_object('status', 'queued');
  END IF;

  -- Для quiz: вопросы
  IF p_game_type = 'quiz' THEN
    IF p_category = 'quiz' THEN
      SELECT ARRAY(
        SELECT id FROM questions ORDER BY RANDOM() LIMIT 5
      ) INTO v_question_ids;
    ELSE
      SELECT ARRAY(
        SELECT id FROM questions WHERE category = p_category ORDER BY RANDOM() LIMIT 5
      ) INTO v_question_ids;
    END IF;

    IF v_question_ids IS NULL OR array_length(v_question_ids, 1) IS NULL OR array_length(v_question_ids, 1) < 5 THEN
      PERFORM admin_log('error', 'rpc:find_match', 'Not enough questions for category',
        jsonb_build_object('category', p_category, 'found', COALESCE(array_length(v_question_ids, 1), 0)));
      RETURN jsonb_build_object('status', 'error', 'error', 'not_enough_questions');
    END IF;
  END IF;

  -- Для blackjack: колода
  IF p_game_type = 'blackjack' THEN
    v_bj_deck := generate_blackjack_deck();
    v_bj_state := init_blackjack_state(v_bj_deck);
  END IF;

  -- Для sequence: ничего дополнительного не нужно (игра генерируется на клиенте)

  -- Создаём дуэль
  INSERT INTO duels (creator_id, opponent_id, category, stake, status, question_ids, game_type, bj_deck, bj_state)
  VALUES (v_opponent.user_id, p_user_id, p_category, v_stake, 'active', v_question_ids, p_game_type, v_bj_deck, v_bj_state)
  RETURNING id INTO v_duel_id;

  DELETE FROM matchmaking_queue WHERE user_id IN (p_user_id, v_opponent.user_id);

  -- Атомарное списание
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
-- ║  3. Update create_bot_duel for sequence  ║
-- ╚═══════════════════════════════════════════╝

DROP FUNCTION IF EXISTS create_bot_duel(UUID, TEXT, INTEGER[]);
DROP FUNCTION IF EXISTS create_bot_duel(UUID, TEXT, INTEGER[], TEXT);

CREATE OR REPLACE FUNCTION create_bot_duel(
  p_user_id   UUID,
  p_category  TEXT,
  p_stakes    INTEGER[],
  p_game_type TEXT DEFAULT 'quiz'
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
  v_bj_deck       JSONB;
  v_bj_state      JSONB;
BEGIN
  SELECT (value)::boolean INTO v_bot_enabled FROM app_settings WHERE key = 'bot_enabled';
  IF NOT COALESCE(v_bot_enabled, true) THEN
    RETURN jsonb_build_object('status', 'error', 'error', 'bot_disabled');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM matchmaking_queue WHERE user_id = p_user_id) THEN
    RETURN jsonb_build_object('status', 'error', 'error', 'not_in_queue');
  END IF;

  DELETE FROM matchmaking_queue WHERE user_id = p_user_id;

  SELECT balance INTO v_my_balance FROM users WHERE id = p_user_id;
  IF v_my_balance IS NULL THEN
    RETURN jsonb_build_object('status', 'error', 'error', 'user_not_found');
  END IF;

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

  -- Для quiz: вопросы
  IF p_game_type = 'quiz' THEN
    IF p_category = 'quiz' THEN
      SELECT ARRAY(
        SELECT id FROM questions ORDER BY RANDOM() LIMIT 5
      ) INTO v_question_ids;
    ELSE
      SELECT ARRAY(
        SELECT id FROM questions WHERE category = p_category ORDER BY RANDOM() LIMIT 5
      ) INTO v_question_ids;
    END IF;

    IF v_question_ids IS NULL OR array_length(v_question_ids, 1) IS NULL OR array_length(v_question_ids, 1) < 5 THEN
      RETURN jsonb_build_object('status', 'error', 'error', 'not_enough_questions');
    END IF;
  END IF;

  -- Для blackjack: колода
  IF p_game_type = 'blackjack' THEN
    v_bj_deck := generate_blackjack_deck();
    v_bj_state := init_blackjack_state(v_bj_deck);
  END IF;

  -- Для sequence: ничего дополнительного не нужно

  -- RTP логика
  SELECT COALESCE((value)::integer, 0) INTO v_total_games   FROM app_settings WHERE key = 'bot_total_games';
  SELECT COALESCE((value)::integer, 0) INTO v_total_wagered FROM app_settings WHERE key = 'bot_total_wagered';
  SELECT COALESCE((value)::integer, 0) INTO v_total_paid    FROM app_settings WHERE key = 'bot_total_paid';
  SELECT COALESCE((value)::integer, 0) INTO v_current_pnl   FROM app_settings WHERE key = 'bot_current_pnl';

  v_payout := FLOOR(v_stake * 2 * 0.95);

  IF v_current_pnl <= -2000 THEN
    v_should_win := true;
  ELSIF v_total_games < 5 THEN
    v_should_win := random() < 0.55;
  ELSE
    v_current_rtp := (v_total_paid::numeric / NULLIF(v_total_wagered, 0)) * 100;
    IF v_current_rtp IS NULL THEN
      v_should_win := random() < 0.55;
    ELSIF v_current_rtp > 95 THEN
      v_should_win := true;
    ELSIF v_current_rtp < 95 THEN
      v_should_win := false;
    ELSE
      v_should_win := random() < 0.5;
    END IF;
  END IF;

  INSERT INTO duels (creator_id, opponent_id, category, stake, status, question_ids, is_bot_game, bot_should_win, game_type, bj_deck, bj_state)
  VALUES (p_user_id, v_bot_id, p_category, v_stake, 'active', v_question_ids, true, v_should_win, p_game_type, v_bj_deck, v_bj_state)
  RETURNING id INTO v_duel_id;

  UPDATE users SET balance = balance - v_stake WHERE id = p_user_id AND balance >= v_stake;
  GET DIAGNOSTICS v_affected = ROW_COUNT;
  IF v_affected = 0 THEN
    DELETE FROM duels WHERE id = v_duel_id;
    RETURN jsonb_build_object('status', 'error', 'error', 'insufficient_balance');
  END IF;

  UPDATE users SET balance = balance - v_stake WHERE id = v_bot_id;

  INSERT INTO transactions (user_id, type, amount, ref_id)
  VALUES (p_user_id, 'duel_loss', -v_stake, v_duel_id),
         (v_bot_id, 'duel_loss', -v_stake, v_duel_id);

  UPDATE app_settings SET value = to_jsonb(v_total_games + 1), updated_at = NOW() WHERE key = 'bot_total_games';
  UPDATE app_settings SET value = to_jsonb(v_total_wagered + v_stake), updated_at = NOW() WHERE key = 'bot_total_wagered';

  IF NOT v_should_win THEN
    UPDATE app_settings SET value = to_jsonb(v_total_paid + v_payout), updated_at = NOW() WHERE key = 'bot_total_paid';
    UPDATE app_settings SET value = to_jsonb(v_current_pnl - (v_payout - v_stake)), updated_at = NOW() WHERE key = 'bot_current_pnl';
  ELSE
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


-- ╔═══════════════════════════════════════════════════╗
-- ║  4. submit_sequence_result RPC                    ║
-- ║  Each player submits their score+time once.       ║
-- ║  When both present → auto finalize.               ║
-- ╚═══════════════════════════════════════════════════╝

CREATE OR REPLACE FUNCTION submit_sequence_result(
  p_duel_id  UUID,
  p_user_id  UUID,
  p_score    INTEGER,
  p_time     REAL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_duel duels%ROWTYPE;
BEGIN
  SELECT * INTO v_duel FROM duels WHERE id = p_duel_id FOR UPDATE;

  IF v_duel IS NULL THEN
    RETURN jsonb_build_object('status', 'error', 'error', 'duel_not_found');
  END IF;

  IF v_duel.status = 'finished' THEN
    RETURN jsonb_build_object('status', 'already_finished');
  END IF;

  IF v_duel.game_type != 'sequence' THEN
    RETURN jsonb_build_object('status', 'error', 'error', 'not_sequence');
  END IF;

  -- Store score + time for the correct player
  IF p_user_id = v_duel.creator_id THEN
    IF v_duel.creator_score IS NOT NULL THEN
      RETURN jsonb_build_object('status', 'already_submitted');
    END IF;
    UPDATE duels
    SET creator_score = p_score, creator_time = p_time
    WHERE id = p_duel_id;
  ELSIF p_user_id = v_duel.opponent_id THEN
    IF v_duel.opponent_score IS NOT NULL THEN
      RETURN jsonb_build_object('status', 'already_submitted');
    END IF;
    UPDATE duels
    SET opponent_score = p_score, opponent_time = p_time
    WHERE id = p_duel_id;
  ELSE
    RETURN jsonb_build_object('status', 'error', 'error', 'user_not_in_duel');
  END IF;

  -- Re-read to check if both scores are now present
  SELECT * INTO v_duel FROM duels WHERE id = p_duel_id;

  IF v_duel.creator_score IS NOT NULL AND v_duel.opponent_score IS NOT NULL THEN
    -- Both submitted — finalize
    RETURN finalize_duel(p_duel_id);
  END IF;

  RETURN jsonb_build_object('status', 'submitted', 'waiting_opponent', true);

EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'rpc:submit_sequence_result', SQLERRM,
    jsonb_build_object('duel_id', p_duel_id, 'user_id', p_user_id));
  RETURN jsonb_build_object('status', 'error', 'error', SQLERRM);
END;
$$;


-- ╔═══════════════════════════════════════════════════╗
-- ║  5. Update finalize_duel for sequence tiebreak   ║
-- ╚═══════════════════════════════════════════════════╝

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

  v_total_pot := d.stake * 2;
  v_rake      := FLOOR(v_total_pot * 5 / 100);
  v_guild_fee := FLOOR(v_total_pot * 5 / 1000);

  SELECT id INTO v_season_id FROM guild_seasons WHERE is_active = true LIMIT 1;
  IF v_season_id IS NOT NULL THEN
    UPDATE guild_seasons SET prize_pool = prize_pool + v_guild_fee WHERE id = v_season_id;
  END IF;

  -- ════════════════════════════════════════
  -- Определение победителя
  -- ════════════════════════════════════════

  IF d.is_bot_game AND d.bot_should_win IS NOT NULL THEN
    -- Бот-игра: bot_should_win определяет победителя
    IF d.bot_should_win THEN
      v_winner := d.opponent_id;
      v_loser  := d.creator_id;
    ELSE
      v_winner := d.creator_id;
      v_loser  := d.opponent_id;
    END IF;

  ELSIF d.game_type = 'blackjack' THEN
    -- Блэкджек: bust (>21) = проигрыш
    IF d.creator_score > 21 AND d.opponent_score > 21 THEN
      IF d.creator_score < d.opponent_score THEN
        v_winner := d.creator_id; v_loser := d.opponent_id;
      ELSIF d.opponent_score < d.creator_score THEN
        v_winner := d.opponent_id; v_loser := d.creator_id;
      ELSE
        IF random() < 0.5 THEN
          v_winner := d.creator_id; v_loser := d.opponent_id;
        ELSE
          v_winner := d.opponent_id; v_loser := d.creator_id;
        END IF;
      END IF;
    ELSIF d.creator_score > 21 THEN
      v_winner := d.opponent_id; v_loser := d.creator_id;
    ELSIF d.opponent_score > 21 THEN
      v_winner := d.creator_id; v_loser := d.opponent_id;
    ELSIF d.creator_score > d.opponent_score THEN
      v_winner := d.creator_id; v_loser := d.opponent_id;
    ELSIF d.opponent_score > d.creator_score THEN
      v_winner := d.opponent_id; v_loser := d.creator_id;
    ELSE
      IF random() < 0.5 THEN
        v_winner := d.creator_id; v_loser := d.opponent_id;
      ELSE
        v_winner := d.opponent_id; v_loser := d.creator_id;
      END IF;
    END IF;

  ELSIF d.creator_score > d.opponent_score THEN
    v_winner := d.creator_id;
    v_loser  := d.opponent_id;
  ELSIF d.opponent_score > d.creator_score THEN
    v_winner := d.opponent_id;
    v_loser  := d.creator_id;
  ELSE
    -- Тай-брейк: sequence использует creator_time/opponent_time, quiz — duel_answers
    IF d.game_type = 'sequence' THEN
      v_creator_time := COALESCE(d.creator_time, 45);
      v_opp_time := COALESCE(d.opponent_time, 45);
    ELSE
      SELECT COALESCE(SUM(time_spent), 75) INTO v_creator_time
      FROM duel_answers WHERE duel_id = p_duel_id AND user_id = d.creator_id;

      SELECT COALESCE(SUM(time_spent), 75) INTO v_opp_time
      FROM duel_answers WHERE duel_id = p_duel_id AND user_id = d.opponent_id;
    END IF;

    IF v_creator_time <= v_opp_time THEN
      v_winner := d.creator_id; v_loser := d.opponent_id;
    ELSE
      v_winner := d.opponent_id; v_loser := d.creator_id;
    END IF;
  END IF;

  -- Обновляем статистику
  UPDATE users SET wins = wins + 1 WHERE id = v_winner;
  UPDATE users SET losses = losses + 1 WHERE id = v_loser;

  -- Реферальный бонус
  SELECT referrer_id INTO v_ref_id FROM referrals WHERE referred_user_id = v_winner;
  IF v_ref_id IS NOT NULL AND v_winner != '00000000-0000-0000-0000-000000000001' THEN
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

  payout := v_total_pot - v_rake;

  UPDATE users SET balance = balance + payout WHERE id = v_winner;

  UPDATE duels SET status = 'finished', winner_id = v_winner, finished_at = NOW() WHERE id = p_duel_id;

  INSERT INTO transactions (user_id, type, amount, ref_id)
  VALUES (v_winner, 'duel_win', payout, p_duel_id),
         (v_loser, 'duel_loss', -d.stake, p_duel_id);

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
