-- ====================================================
--  Migration: Capitals — synchronized capital list via seed
--
--  Both players in a capitals duel must see the SAME
--  3 random capitals. We store a shared integer seed on
--  the duel row, and the clients deterministically shuffle
--  the CAPITALS array using that seed.
-- ====================================================


-- ====================================================
--  0. Column
-- ====================================================

ALTER TABLE duels
  ADD COLUMN IF NOT EXISTS capitals_seed INTEGER;


-- ====================================================
--  1. Helper: generate a positive INT seed
-- ====================================================

CREATE OR REPLACE FUNCTION gen_capitals_seed()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Positive 31-bit integer (1..2^31-1), deterministic-shuffle friendly
  RETURN 1 + FLOOR(random() * 2147483646)::INTEGER;
END;
$$;


-- ====================================================
--  2. create_bot_duel — write seed on capitals
-- ====================================================

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
  v_cap_seed      INTEGER;
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

  IF p_game_type = 'quiz' THEN
    IF p_category = 'quiz' THEN
      SELECT ARRAY(SELECT id FROM questions ORDER BY RANDOM() LIMIT 5) INTO v_question_ids;
    ELSE
      SELECT ARRAY(SELECT id FROM questions WHERE category = p_category ORDER BY RANDOM() LIMIT 5) INTO v_question_ids;
    END IF;

    IF v_question_ids IS NULL OR array_length(v_question_ids, 1) IS NULL OR array_length(v_question_ids, 1) < 5 THEN
      RETURN jsonb_build_object('status', 'error', 'error', 'not_enough_questions');
    END IF;
  END IF;

  IF p_game_type = 'blackjack' THEN
    v_bj_deck := generate_blackjack_deck();
    v_bj_state := init_blackjack_state(v_bj_deck);
  END IF;

  IF p_game_type = 'capitals' THEN
    v_cap_seed := gen_capitals_seed();
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

  INSERT INTO duels (
    creator_id, opponent_id, category, stake, status,
    question_ids, is_bot_game, bot_should_win, game_type,
    bj_deck, bj_state, capitals_seed
  )
  VALUES (
    p_user_id, v_bot_id, p_category, v_stake, 'active',
    v_question_ids, true, v_should_win, p_game_type,
    v_bj_deck, v_bj_state, v_cap_seed
  )
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


-- ====================================================
--  3. find_match — write seed on capitals
-- ====================================================

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
  v_cap_seed      INTEGER;
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

  IF p_game_type = 'quiz' THEN
    IF p_category = 'quiz' THEN
      SELECT ARRAY(SELECT id FROM questions ORDER BY RANDOM() LIMIT 5) INTO v_question_ids;
    ELSE
      SELECT ARRAY(SELECT id FROM questions WHERE category = p_category ORDER BY RANDOM() LIMIT 5) INTO v_question_ids;
    END IF;

    IF v_question_ids IS NULL OR array_length(v_question_ids, 1) IS NULL OR array_length(v_question_ids, 1) < 5 THEN
      PERFORM admin_log('error', 'rpc:find_match', 'Not enough questions for category',
        jsonb_build_object('category', p_category, 'found', COALESCE(array_length(v_question_ids, 1), 0)));
      RETURN jsonb_build_object('status', 'error', 'error', 'not_enough_questions');
    END IF;
  END IF;

  IF p_game_type = 'blackjack' THEN
    v_bj_deck := generate_blackjack_deck();
    v_bj_state := init_blackjack_state(v_bj_deck);
  END IF;

  IF p_game_type = 'capitals' THEN
    v_cap_seed := gen_capitals_seed();
  END IF;

  INSERT INTO duels (
    creator_id, opponent_id, category, stake, status,
    question_ids, game_type, bj_deck, bj_state, capitals_seed
  )
  VALUES (
    v_opponent.user_id, p_user_id, p_category, v_stake, 'active',
    v_question_ids, p_game_type, v_bj_deck, v_bj_state, v_cap_seed
  )
  RETURNING id INTO v_duel_id;

  DELETE FROM matchmaking_queue WHERE user_id IN (p_user_id, v_opponent.user_id);

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


-- ====================================================
--  4. accept_game_invite — write seed on capitals
-- ====================================================

CREATE OR REPLACE FUNCTION accept_game_invite(
  p_invite_id UUID,
  p_user_id   UUID
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_inv           game_invites%ROWTYPE;
  v_duel_id       UUID;
  v_question_ids  UUID[];
  v_from_balance  INTEGER;
  v_to_balance    INTEGER;
  v_affected      INTEGER;
  v_bj_deck       JSONB;
  v_bj_state      JSONB;
  v_category      TEXT;
  v_last_seen     TIMESTAMPTZ;
  v_active_count  INTEGER;
  v_cap_seed      INTEGER;
BEGIN
  SELECT * INTO v_inv FROM game_invites WHERE id = p_invite_id FOR UPDATE;

  IF v_inv IS NULL THEN
    RETURN jsonb_build_object('error', 'invite_not_found');
  END IF;

  IF v_inv.to_id != p_user_id THEN
    RETURN jsonb_build_object('error', 'not_recipient');
  END IF;

  IF v_inv.status != 'pending' THEN
    RETURN jsonb_build_object('error', 'invite_not_pending');
  END IF;

  IF v_inv.expires_at < NOW() THEN
    UPDATE game_invites SET status = 'expired' WHERE id = p_invite_id;
    RETURN jsonb_build_object('error', 'invite_expired');
  END IF;

  SELECT last_seen INTO v_last_seen FROM users WHERE id = v_inv.from_id;
  IF v_last_seen IS NULL OR v_last_seen < NOW() - INTERVAL '5 minutes' THEN
    UPDATE game_invites SET status = 'cancelled' WHERE id = p_invite_id;
    RETURN jsonb_build_object('error', 'sender_offline');
  END IF;

  SELECT COUNT(*) INTO v_active_count
  FROM duels
  WHERE status = 'active'
    AND (creator_id = v_inv.from_id OR opponent_id = v_inv.from_id);

  IF v_active_count > 0 THEN
    UPDATE game_invites SET status = 'cancelled' WHERE id = p_invite_id;
    RETURN jsonb_build_object('error', 'sender_in_game');
  END IF;

  SELECT COUNT(*) INTO v_active_count
  FROM duels
  WHERE status = 'active'
    AND (creator_id = v_inv.to_id OR opponent_id = v_inv.to_id);

  IF v_active_count > 0 THEN
    RETURN jsonb_build_object('error', 'recipient_in_game');
  END IF;

  SELECT balance INTO v_from_balance FROM users WHERE id = v_inv.from_id;
  SELECT balance INTO v_to_balance FROM users WHERE id = v_inv.to_id;

  IF v_from_balance IS NULL OR v_from_balance < v_inv.stake THEN
    UPDATE game_invites SET status = 'cancelled' WHERE id = p_invite_id;
    RETURN jsonb_build_object('error', 'sender_insufficient_balance');
  END IF;

  IF v_to_balance IS NULL OR v_to_balance < v_inv.stake THEN
    RETURN jsonb_build_object('error', 'insufficient_balance');
  END IF;

  IF v_inv.game_type = 'quiz' THEN
    SELECT ARRAY(SELECT id FROM questions ORDER BY RANDOM() LIMIT 5) INTO v_question_ids;
    IF v_question_ids IS NULL OR array_length(v_question_ids, 1) IS NULL OR array_length(v_question_ids, 1) < 5 THEN
      RETURN jsonb_build_object('error', 'not_enough_questions');
    END IF;
    v_category := 'quiz';
  ELSIF v_inv.game_type = 'blackjack' THEN
    v_bj_deck := generate_blackjack_deck();
    v_bj_state := init_blackjack_state(v_bj_deck);
    v_category := 'blackjack';
  ELSIF v_inv.game_type = 'sequence' THEN
    v_category := 'sequence';
  ELSIF v_inv.game_type = 'reaction' THEN
    v_category := 'reaction';
  ELSIF v_inv.game_type = 'hearing' THEN
    v_category := 'hearing';
  ELSIF v_inv.game_type = 'gradient' THEN
    v_category := 'gradient';
  ELSIF v_inv.game_type = 'race' THEN
    v_category := 'race';
  ELSIF v_inv.game_type = 'capitals' THEN
    v_category := 'capitals';
    v_cap_seed := gen_capitals_seed();
  ELSE
    RETURN jsonb_build_object('error', 'unknown_game_type');
  END IF;

  INSERT INTO duels (
    creator_id, opponent_id, category, stake, status,
    question_ids, game_type, bj_deck, bj_state, capitals_seed
  )
  VALUES (
    v_inv.from_id, v_inv.to_id, v_category, v_inv.stake, 'active',
    COALESCE(v_question_ids, '{}'), v_inv.game_type, v_bj_deck, v_bj_state, v_cap_seed
  )
  RETURNING id INTO v_duel_id;

  UPDATE users
  SET balance = balance - v_inv.stake
  WHERE id = v_inv.from_id AND balance >= v_inv.stake;

  GET DIAGNOSTICS v_affected = ROW_COUNT;
  IF v_affected = 0 THEN
    DELETE FROM duels WHERE id = v_duel_id;
    UPDATE game_invites SET status = 'cancelled' WHERE id = p_invite_id;
    RETURN jsonb_build_object('error', 'sender_insufficient_balance');
  END IF;

  UPDATE users
  SET balance = balance - v_inv.stake
  WHERE id = v_inv.to_id AND balance >= v_inv.stake;

  GET DIAGNOSTICS v_affected = ROW_COUNT;
  IF v_affected = 0 THEN
    UPDATE users SET balance = balance + v_inv.stake WHERE id = v_inv.from_id;
    DELETE FROM duels WHERE id = v_duel_id;
    RETURN jsonb_build_object('error', 'insufficient_balance');
  END IF;

  INSERT INTO transactions (user_id, type, amount, ref_id)
  VALUES (v_inv.from_id, 'duel_loss', -v_inv.stake, v_duel_id),
         (v_inv.to_id, 'duel_loss', -v_inv.stake, v_duel_id);

  UPDATE game_invites
  SET status = 'accepted', duel_id = v_duel_id
  WHERE id = p_invite_id;

  RETURN jsonb_build_object('status', 'accepted', 'duel_id', v_duel_id, 'game_type', v_inv.game_type);
EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'rpc:accept_game_invite', SQLERRM, jsonb_build_object('invite_id', p_invite_id, 'user_id', p_user_id));
  RETURN jsonb_build_object('error', SQLERRM);
END;
$$;
