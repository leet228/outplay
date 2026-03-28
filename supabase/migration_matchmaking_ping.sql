-- ╔═══════════════════════════════════════════════════════════╗
-- ║  Migration: Matchmaking ping — TTL для записей в очереди  ║
-- ║  Фикс: принудительное закрытие при поиске                 ║
-- ╚═══════════════════════════════════════════════════════════╝

-- 1. Добавляем last_ping в matchmaking_queue
ALTER TABLE matchmaking_queue ADD COLUMN IF NOT EXISTS last_ping TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- 2. RPC: ping_matchmaking — клиент шлёт каждые 5 сек во время поиска
CREATE OR REPLACE FUNCTION ping_matchmaking(p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  UPDATE matchmaking_queue SET last_ping = NOW() WHERE user_id = p_user_id;
END;
$$;

-- 3. Обновляем find_match — игнорируем записи с протухшим last_ping (>15 сек)
--    Единственное изменение: добавляем AND last_ping > NOW() - INTERVAL '15 seconds'

CREATE OR REPLACE FUNCTION find_match(
  p_user_id  UUID,
  p_category TEXT,
  p_stakes   INTEGER[],
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
    -- ВАЖНО: last_ping > NOW() - 15s — игнорируем мёртвых игроков
    SELECT * INTO v_opponent
    FROM matchmaking_queue
    WHERE category = p_category
      AND stake = v_stake
      AND user_id != p_user_id
      AND last_ping > NOW() - INTERVAL '15 seconds'
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
        INSERT INTO matchmaking_queue (user_id, category, stake, last_ping)
        VALUES (p_user_id, p_category, v_stake, NOW())
        ON CONFLICT (user_id, stake) DO UPDATE
          SET category = EXCLUDED.category, joined_at = NOW(), last_ping = NOW();
      END IF;
    END LOOP;
    RETURN jsonb_build_object('status', 'queued');
  END IF;

  -- Матч найден! v_opponent и v_stake заполнены
  -- Выбираем вопросы в зависимости от типа игры
  IF p_game_type = 'quiz' THEN
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
  ELSE
    v_question_ids := '{}';
  END IF;

  -- Создаём дуэль
  INSERT INTO duels (creator_id, opponent_id, category, stake, status, question_ids, game_type)
  VALUES (v_opponent.user_id, p_user_id, p_category, v_stake, 'active', v_question_ids, p_game_type)
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
    'stake', v_stake
  );

EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'rpc:find_match', SQLERRM,
    jsonb_build_object('user_id', p_user_id, 'category', p_category));
  RETURN jsonb_build_object('status', 'error', 'error', 'internal_error');
END;
$$;

-- 4. Обновляем cleanup — чистим записи с протухшим ping (>30 сек)
CREATE OR REPLACE FUNCTION cleanup_matchmaking_queue()
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  DELETE FROM matchmaking_queue
  WHERE last_ping < NOW() - INTERVAL '30 seconds'
     OR joined_at < NOW() - INTERVAL '3 minutes';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
