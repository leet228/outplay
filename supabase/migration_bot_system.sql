-- =============================================
-- Migration: Bot Opponent System
-- Запусти в Supabase SQL Editor
-- =============================================

-- 1. Новые колонки в duels
ALTER TABLE duels ADD COLUMN IF NOT EXISTS is_bot_game BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE duels ADD COLUMN IF NOT EXISTS bot_should_win BOOLEAN;

-- 2. Бот-юзер
INSERT INTO users (id, telegram_id, username, first_name, balance, wins, losses)
VALUES ('00000000-0000-0000-0000-000000000001', -1, 'outplay_bot', 'Outplay Bot', 999999999, 0, 0)
ON CONFLICT (telegram_id) DO NOTHING;

-- 3. App settings для бота
INSERT INTO app_settings (key, value) VALUES
  ('bot_enabled',       'true'::jsonb),
  ('bot_total_games',   '0'::jsonb),
  ('bot_total_wagered', '0'::jsonb),
  ('bot_total_paid',    '0'::jsonb),
  ('bot_current_pnl',   '0'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- 4. RPC: create_bot_duel
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

  SELECT ARRAY(
    SELECT id FROM questions WHERE category = p_category ORDER BY RANDOM() LIMIT 5
  ) INTO v_question_ids;

  IF v_question_ids IS NULL OR array_length(v_question_ids, 1) IS NULL OR array_length(v_question_ids, 1) < 5 THEN
    RETURN jsonb_build_object('status', 'error', 'error', 'not_enough_questions');
  END IF;

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

  INSERT INTO duels (creator_id, opponent_id, category, stake, status, question_ids, is_bot_game, bot_should_win)
  VALUES (p_user_id, v_bot_id, p_category, v_stake, 'active', v_question_ids, true, v_should_win)
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

-- 5. Обновляем finalize_duel — пропускаем бота для дневной статы/гильдий/рефералов
-- ВАЖНО: перезапусти весь finalize_duel и get_leaderboard из schema.sql
-- или примени вручную нужные IF-блоки

-- 6. Обновляем leaderboard — исключаем бота
-- В get_leaderboard добавить: WHERE u.telegram_id != -1

-- 7. Обновляем search_users — исключаем бота
-- В search_users добавить: AND u.telegram_id != -1
