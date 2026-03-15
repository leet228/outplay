-- =============================================
-- Migration: Blackjack PvP Backend
-- Запусти в Supabase SQL Editor
-- =============================================

-- ╔═══════════════════════════════════════════╗
-- ║  1. Новые колонки в duels                ║
-- ╚═══════════════════════════════════════════╝

ALTER TABLE duels ADD COLUMN IF NOT EXISTS game_type TEXT NOT NULL DEFAULT 'quiz';
ALTER TABLE duels ADD COLUMN IF NOT EXISTS bj_deck JSONB;
ALTER TABLE duels ADD COLUMN IF NOT EXISTS bj_state JSONB;

-- Колонка game_type в matchmaking_queue для фильтрации
ALTER TABLE matchmaking_queue ADD COLUMN IF NOT EXISTS game_type TEXT NOT NULL DEFAULT 'quiz';

-- Расширяем CHECK constraint на category чтобы включить 'blackjack' и 'quiz'
ALTER TABLE matchmaking_queue DROP CONSTRAINT IF EXISTS matchmaking_queue_category_check;
ALTER TABLE matchmaking_queue ADD CONSTRAINT matchmaking_queue_category_check
  CHECK (category IN ('general','history','science','sport','movies','music','quiz','blackjack','sequence'));

-- ╔═══════════════════════════════════════════╗
-- ║  2. Таблица blackjack_actions (realtime)  ║
-- ╚═══════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS blackjack_actions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  duel_id UUID NOT NULL REFERENCES duels(id),
  user_id UUID NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,          -- 'hit' | 'stand'
  card_index INTEGER,            -- индекс карты из bj_deck (для hit)
  result_state JSONB,            -- снимок bj_state после действия
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bj_actions_duel ON blackjack_actions(duel_id, created_at);

ALTER TABLE blackjack_actions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "bj_actions_read" ON blackjack_actions;
CREATE POLICY "bj_actions_read" ON blackjack_actions FOR SELECT USING (true);

-- Включить realtime для blackjack_actions
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE blackjack_actions;
EXCEPTION WHEN duplicate_object THEN
  NULL; -- already added
END $$;


-- ╔═══════════════════════════════════════════╗
-- ║  3. Хелпер: генерация колоды из 16 карт  ║
-- ╚═══════════════════════════════════════════╝

CREATE OR REPLACE FUNCTION generate_blackjack_deck()
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_full_deck JSONB := '[]'::jsonb;
  v_suits TEXT[] := ARRAY['♠','♥','♦','♣'];
  v_ranks TEXT[] := ARRAY['4','5','6','7','8','9','10','J','Q','K','A'];
  v_suit TEXT;
  v_rank TEXT;
  v_value INTEGER;
  v_color TEXT;
  v_shuffled JSONB;
BEGIN
  -- Собираем полную колоду (44 карты: 11 рангов × 4 масти)
  FOREACH v_suit IN ARRAY v_suits LOOP
    FOREACH v_rank IN ARRAY v_ranks LOOP
      IF v_rank = 'A' THEN v_value := 11;
      ELSIF v_rank IN ('J','Q','K') THEN v_value := 10;
      ELSE v_value := v_rank::integer;
      END IF;

      IF v_suit IN ('♥','♦') THEN v_color := 'red';
      ELSE v_color := 'black';
      END IF;

      v_full_deck := v_full_deck || jsonb_build_object(
        'suit', v_suit,
        'rank', v_rank,
        'value', v_value,
        'color', v_color,
        'id', v_rank || v_suit
      );
    END LOOP;
  END LOOP;

  -- Перемешиваем и берём 16
  SELECT jsonb_agg(elem)
  INTO v_shuffled
  FROM (
    SELECT elem FROM jsonb_array_elements(v_full_deck) AS elem
    ORDER BY random()
    LIMIT 16
  ) sub;

  RETURN v_shuffled;
END;
$$;


-- ╔═══════════════════════════════════════════╗
-- ║  4. Хелпер: подсчёт очков руки           ║
-- ╚═══════════════════════════════════════════╝

CREATE OR REPLACE FUNCTION calc_blackjack_score(p_deck JSONB, p_hand_indices INTEGER[])
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_sum INTEGER := 0;
  v_aces INTEGER := 0;
  v_card JSONB;
  v_idx INTEGER;
BEGIN
  FOREACH v_idx IN ARRAY p_hand_indices LOOP
    v_card := p_deck->v_idx;
    IF v_card->>'rank' = 'A' THEN
      v_aces := v_aces + 1;
      v_sum := v_sum + 11;
    ELSE
      v_sum := v_sum + (v_card->>'value')::integer;
    END IF;
  END LOOP;

  WHILE v_sum > 21 AND v_aces > 0 LOOP
    v_sum := v_sum - 10;
    v_aces := v_aces - 1;
  END LOOP;

  RETURN v_sum;
END;
$$;


-- ╔═══════════════════════════════════════════╗
-- ║  5. Хелпер: создать начальное bj_state   ║
-- ╚═══════════════════════════════════════════╝

CREATE OR REPLACE FUNCTION init_blackjack_state(p_deck JSONB)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
BEGIN
  -- Карты 0,2 → player1; 1,3 → player2; deck_index = 4
  RETURN jsonb_build_object(
    'player1_hand', ARRAY[0, 2],
    'player2_hand', ARRAY[1, 3],
    'deck_index', 4,
    'player1_stand', false,
    'player2_stand', false,
    'current_turn', 'player1',
    'round', 1,
    'phase', 'playing'
  );
END;
$$;


-- ╔═══════════════════════════════════════════╗
-- ║  6. RPC: submit_blackjack_action          ║
-- ╚═══════════════════════════════════════════╝

CREATE OR REPLACE FUNCTION submit_blackjack_action(
  p_duel_id UUID,
  p_user_id UUID,
  p_action  TEXT    -- 'hit' | 'stand'
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_duel         duels%ROWTYPE;
  v_state        JSONB;
  v_deck         JSONB;
  v_my_role      TEXT;       -- 'player1' | 'player2'
  v_my_hand_key  TEXT;
  v_my_stand_key TEXT;
  v_my_hand      INTEGER[];
  v_my_score     INTEGER;
  v_opp_hand_key TEXT;
  v_opp_stand_key TEXT;
  v_opp_hand     INTEGER[];
  v_opp_score    INTEGER;
  v_deck_index   INTEGER;
  v_card_idx     INTEGER := NULL;
  v_my_stand     BOOLEAN;
  v_opp_stand    BOOLEAN;
  v_both_done    BOOLEAN;
  v_p1_score     INTEGER;
  v_p2_score     INTEGER;
  v_is_draw      BOOLEAN;
  v_new_deck     JSONB;
  v_new_state    JSONB;
BEGIN
  -- Валидация действия
  IF p_action NOT IN ('hit', 'stand') THEN
    RETURN jsonb_build_object('error', 'invalid_action');
  END IF;

  -- Блокируем дуэль
  SELECT * INTO v_duel FROM duels WHERE id = p_duel_id FOR UPDATE;

  IF v_duel IS NULL THEN
    RETURN jsonb_build_object('error', 'duel_not_found');
  END IF;

  IF v_duel.status != 'active' THEN
    RETURN jsonb_build_object('error', 'duel_not_active');
  END IF;

  IF v_duel.game_type != 'blackjack' THEN
    RETURN jsonb_build_object('error', 'not_blackjack_duel');
  END IF;

  v_state := v_duel.bj_state;
  v_deck  := v_duel.bj_deck;

  IF v_state IS NULL OR v_deck IS NULL THEN
    RETURN jsonb_build_object('error', 'no_game_state');
  END IF;

  -- Определяем роль игрока
  IF p_user_id = v_duel.creator_id THEN
    v_my_role := 'player1';
  ELSIF p_user_id = v_duel.opponent_id THEN
    v_my_role := 'player2';
  ELSE
    RETURN jsonb_build_object('error', 'not_participant');
  END IF;

  -- Проверяем что сейчас мой ход
  IF v_state->>'current_turn' != v_my_role THEN
    RETURN jsonb_build_object('error', 'not_your_turn');
  END IF;

  -- Настраиваем ключи
  v_my_hand_key  := v_my_role || '_hand';
  v_my_stand_key := v_my_role || '_stand';
  v_opp_hand_key := CASE WHEN v_my_role = 'player1' THEN 'player2_hand' ELSE 'player1_hand' END;
  v_opp_stand_key := CASE WHEN v_my_role = 'player1' THEN 'player2_stand' ELSE 'player1_stand' END;

  -- Парсим состояние
  SELECT array_agg(val::integer) INTO v_my_hand
  FROM jsonb_array_elements_text(v_state->v_my_hand_key) AS val;

  SELECT array_agg(val::integer) INTO v_opp_hand
  FROM jsonb_array_elements_text(v_state->v_opp_hand_key) AS val;

  v_my_stand  := (v_state->>v_my_stand_key)::boolean;
  v_opp_stand := (v_state->>v_opp_stand_key)::boolean;
  v_deck_index := (v_state->>'deck_index')::integer;

  -- Уже stand — нельзя действовать
  IF v_my_stand THEN
    RETURN jsonb_build_object('error', 'already_standing');
  END IF;

  -- Обрабатываем действие
  IF p_action = 'hit' THEN
    -- Проверяем что есть карты
    IF v_deck_index >= jsonb_array_length(v_deck) THEN
      RETURN jsonb_build_object('error', 'no_cards_left');
    END IF;

    v_card_idx := v_deck_index;
    v_my_hand := v_my_hand || v_card_idx;
    v_deck_index := v_deck_index + 1;

    -- Проверяем bust
    v_my_score := calc_blackjack_score(v_deck, v_my_hand);
    IF v_my_score > 21 THEN
      v_my_stand := true;
    END IF;

  ELSIF p_action = 'stand' THEN
    v_my_stand := true;
  END IF;

  -- Считаем мой score
  v_my_score := calc_blackjack_score(v_deck, v_my_hand);

  -- Переключаем ход
  -- Если оппонент уже stand → остаёмся на текущем игроке (или завершаем)
  -- Иначе → передаём ход оппоненту
  IF v_my_stand AND v_opp_stand THEN
    v_both_done := true;
  ELSIF v_my_stand AND NOT v_opp_stand THEN
    -- Мой ход закончен, оппонент ещё играет
    v_state := jsonb_set(v_state, ARRAY['current_turn'],
      to_jsonb(CASE WHEN v_my_role = 'player1' THEN 'player2' ELSE 'player1' END));
    v_both_done := false;
  ELSIF NOT v_my_stand AND v_opp_stand THEN
    -- Я ещё играю, оппонент уже stand → мой ход снова
    v_state := jsonb_set(v_state, ARRAY['current_turn'], to_jsonb(v_my_role));
    v_both_done := false;
  ELSE
    -- Оба ещё играют → передаём ход
    v_state := jsonb_set(v_state, ARRAY['current_turn'],
      to_jsonb(CASE WHEN v_my_role = 'player1' THEN 'player2' ELSE 'player1' END));
    v_both_done := false;
  END IF;

  -- Обновляем state
  v_state := jsonb_set(v_state, ARRAY[v_my_hand_key], to_jsonb(v_my_hand));
  v_state := jsonb_set(v_state, ARRAY[v_my_stand_key], to_jsonb(v_my_stand));
  v_state := jsonb_set(v_state, ARRAY['deck_index'], to_jsonb(v_deck_index));

  -- Сохраняем
  UPDATE duels SET bj_state = v_state WHERE id = p_duel_id;

  -- Записываем action для realtime
  INSERT INTO blackjack_actions (duel_id, user_id, action, card_index, result_state)
  VALUES (p_duel_id, p_user_id, p_action, v_card_idx, v_state);

  -- Проверяем завершение
  IF v_both_done THEN
    -- Считаем финальные очки
    SELECT array_agg(val::integer) INTO v_my_hand
    FROM jsonb_array_elements_text(v_state->'player1_hand') AS val;
    v_p1_score := calc_blackjack_score(v_deck, v_my_hand);

    SELECT array_agg(val::integer) INTO v_opp_hand
    FROM jsonb_array_elements_text(v_state->'player2_hand') AS val;
    v_p2_score := calc_blackjack_score(v_deck, v_opp_hand);

    -- Проверяем ничью
    -- Логика: оба bust и одинаковый score = ничья, оба не bust и одинаковый score = ничья
    v_is_draw := false;
    IF v_p1_score > 21 AND v_p2_score > 21 AND v_p1_score = v_p2_score THEN
      v_is_draw := true;
    ELSIF v_p1_score <= 21 AND v_p2_score <= 21 AND v_p1_score = v_p2_score THEN
      v_is_draw := true;
    END IF;

    IF v_is_draw THEN
      -- Ничья → новый раунд с новой колодой
      v_new_deck := generate_blackjack_deck();
      v_new_state := init_blackjack_state(v_new_deck);
      v_new_state := jsonb_set(v_new_state, ARRAY['round'],
        to_jsonb(COALESCE((v_state->>'round')::integer, 1) + 1));

      UPDATE duels SET bj_deck = v_new_deck, bj_state = v_new_state WHERE id = p_duel_id;

      -- Записываем action "draw" для realtime
      INSERT INTO blackjack_actions (duel_id, user_id, action, result_state)
      VALUES (p_duel_id, p_user_id, 'draw', v_new_state);

      RETURN jsonb_build_object(
        'status', 'draw',
        'p1_score', v_p1_score,
        'p2_score', v_p2_score,
        'new_state', v_new_state,
        'new_deck', v_new_deck,
        'round', (v_new_state->>'round')::integer
      );
    END IF;

    -- Не ничья → финализируем
    v_state := jsonb_set(v_state, ARRAY['phase'], '"finished"'::jsonb);
    UPDATE duels SET
      bj_state = v_state,
      creator_score = v_p1_score,
      opponent_score = v_p2_score
    WHERE id = p_duel_id;

    -- Записываем action "finished" для realtime
    INSERT INTO blackjack_actions (duel_id, user_id, action, result_state)
    VALUES (p_duel_id, p_user_id, 'finished', v_state);

    -- Финализируем дуэль (payout, stats, etc.)
    PERFORM finalize_duel(p_duel_id);

    RETURN jsonb_build_object(
      'status', 'finished',
      'p1_score', v_p1_score,
      'p2_score', v_p2_score,
      'state', v_state
    );
  END IF;

  -- Игра продолжается
  RETURN jsonb_build_object(
    'status', 'ok',
    'state', v_state,
    'my_score', v_my_score,
    'card_index', v_card_idx
  );

EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'rpc:submit_blackjack_action', SQLERRM,
    jsonb_build_object('duel_id', p_duel_id, 'user_id', p_user_id, 'action', p_action));
  RETURN jsonb_build_object('error', SQLERRM);
END;
$$;


-- ╔═══════════════════════════════════════════╗
-- ║  7. Обновляем find_match для game_type    ║
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
    SELECT ARRAY(
      SELECT id FROM questions
      WHERE category = p_category
      ORDER BY RANDOM()
      LIMIT 5
    ) INTO v_question_ids;

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
-- ║  8. Обновляем create_bot_duel             ║
-- ╚═══════════════════════════════════════════╝

DROP FUNCTION IF EXISTS create_bot_duel(UUID, TEXT, INTEGER[]);

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
    SELECT ARRAY(
      SELECT id FROM questions WHERE category = p_category ORDER BY RANDOM() LIMIT 5
    ) INTO v_question_ids;

    IF v_question_ids IS NULL OR array_length(v_question_ids, 1) IS NULL OR array_length(v_question_ids, 1) < 5 THEN
      RETURN jsonb_build_object('status', 'error', 'error', 'not_enough_questions');
    END IF;
  END IF;

  -- Для blackjack: колода
  IF p_game_type = 'blackjack' THEN
    v_bj_deck := generate_blackjack_deck();
    v_bj_state := init_blackjack_state(v_bj_deck);
  END IF;

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


-- ╔═══════════════════════════════════════════╗
-- ║  9. RPC: finalize_blackjack (bot games)   ║
-- ╚═══════════════════════════════════════════╝

-- Для бот-игр: клиент сам считает scores (с фейковыми картами), отправляет на сервер
CREATE OR REPLACE FUNCTION finalize_blackjack(
  p_duel_id        UUID,
  p_creator_score  INTEGER,
  p_opponent_score INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_duel duels%ROWTYPE;
BEGIN
  SELECT * INTO v_duel FROM duels WHERE id = p_duel_id FOR UPDATE;

  IF v_duel IS NULL THEN
    RETURN jsonb_build_object('error', 'duel_not_found');
  END IF;

  IF v_duel.status = 'finished' THEN
    RETURN jsonb_build_object('error', 'already_finished');
  END IF;

  IF v_duel.game_type != 'blackjack' THEN
    RETURN jsonb_build_object('error', 'not_blackjack');
  END IF;

  -- Записываем scores
  UPDATE duels
  SET creator_score = p_creator_score,
      opponent_score = p_opponent_score
  WHERE id = p_duel_id;

  -- Финализируем (payout, stats, etc.)
  RETURN finalize_duel(p_duel_id);

EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'rpc:finalize_blackjack', SQLERRM,
    jsonb_build_object('duel_id', p_duel_id));
  RETURN jsonb_build_object('error', SQLERRM);
END;
$$;


-- ╔═══════════════════════════════════════════╗
-- ║  DONE! Blackjack backend migration ready  ║
-- ╚═══════════════════════════════════════════╝
