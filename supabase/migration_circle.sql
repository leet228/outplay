-- ====================================================
-- Migration: Circle production backend
-- Score = average circle quality percent (higher = better)
-- Tie-break = lower total time wins
-- ====================================================


-- ====================================================
-- 0. Extend checks for circle
-- ====================================================

ALTER TABLE matchmaking_queue DROP CONSTRAINT IF EXISTS matchmaking_queue_category_check;
ALTER TABLE matchmaking_queue ADD CONSTRAINT matchmaking_queue_category_check
  CHECK (category IN ('general','history','science','sport','movies','music','quiz','blackjack','sequence','reaction','hearing','gradient','race','capitals','circle'));

ALTER TABLE game_invites DROP CONSTRAINT IF EXISTS game_invites_game_type_check;
ALTER TABLE game_invites ADD CONSTRAINT game_invites_game_type_check
  CHECK (game_type IN ('quiz', 'blackjack', 'sequence', 'reaction', 'hearing', 'gradient', 'race', 'capitals', 'circle'));


-- ====================================================
-- 1. submit_circle_result
-- ====================================================

CREATE OR REPLACE FUNCTION submit_circle_result(
  p_duel_id UUID,
  p_user_id UUID,
  p_score   INTEGER,
  p_time    REAL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_duel duels%ROWTYPE;
BEGIN
  SELECT * INTO v_duel
  FROM duels
  WHERE id = p_duel_id
  FOR UPDATE;

  IF v_duel IS NULL THEN
    RETURN jsonb_build_object('error', 'duel_not_found');
  END IF;

  IF v_duel.status = 'finished' THEN
    RETURN jsonb_build_object('error', 'already_finished');
  END IF;

  IF v_duel.game_type != 'circle' THEN
    RETURN jsonb_build_object('error', 'not_circle');
  END IF;

  IF p_user_id = v_duel.creator_id THEN
    UPDATE duels
    SET creator_score = p_score,
        creator_time = p_time
    WHERE id = p_duel_id;
  ELSIF p_user_id = v_duel.opponent_id THEN
    UPDATE duels
    SET opponent_score = p_score,
        opponent_time = p_time
    WHERE id = p_duel_id;
  ELSE
    RETURN jsonb_build_object('error', 'not_participant');
  END IF;

  SELECT * INTO v_duel
  FROM duels
  WHERE id = p_duel_id;

  IF v_duel.creator_score IS NOT NULL AND v_duel.opponent_score IS NOT NULL THEN
    RETURN finalize_duel(p_duel_id);
  END IF;

  RETURN jsonb_build_object('status', 'submitted', 'waiting_opponent', true);
END;
$$;


-- ====================================================
-- 2. create_bot_duel
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
-- 3. find_match
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
-- 4. accept_game_invite
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
  ELSIF v_inv.game_type = 'circle' THEN
    v_category := 'circle';
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


-- ====================================================
-- 5. finalize_duel
-- ====================================================

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

  IF d.is_bot_game AND d.bot_should_win IS NOT NULL THEN
    IF d.bot_should_win THEN
      v_winner := d.opponent_id;
      v_loser  := d.creator_id;
    ELSE
      v_winner := d.creator_id;
      v_loser  := d.opponent_id;
    END IF;

  ELSIF d.game_type = 'blackjack' THEN
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

  ELSIF d.game_type = 'reaction' THEN
    v_creator_time := COALESCE(d.creator_time, 5.0);
    v_opp_time := COALESCE(d.opponent_time, 5.0);
    IF v_creator_time < v_opp_time THEN
      v_winner := d.creator_id; v_loser := d.opponent_id;
    ELSIF v_opp_time < v_creator_time THEN
      v_winner := d.opponent_id; v_loser := d.creator_id;
    ELSE
      IF random() < 0.5 THEN
        v_winner := d.creator_id; v_loser := d.opponent_id;
      ELSE
        v_winner := d.opponent_id; v_loser := d.creator_id;
      END IF;
    END IF;

  ELSIF d.game_type IN ('hearing', 'gradient', 'race', 'capitals') THEN
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

  ELSIF d.creator_score > d.opponent_score THEN
    v_winner := d.creator_id;
    v_loser  := d.opponent_id;
  ELSIF d.opponent_score > d.creator_score THEN
    v_winner := d.opponent_id;
    v_loser  := d.creator_id;
  ELSE
    IF d.game_type IN ('sequence', 'circle') THEN
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

  UPDATE users SET wins = wins + 1 WHERE id = v_winner;
  UPDATE users SET losses = losses + 1 WHERE id = v_loser;

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
    DO UPDATE SET pnl = user_daily_stats.pnl + (payout - d.stake),
      games = user_daily_stats.games + 1,
      wins = user_daily_stats.wins + 1;
    PERFORM update_guild_pnl_after_duel(v_winner, payout - d.stake);
  END IF;

  IF v_loser != '00000000-0000-0000-0000-000000000001' THEN
    INSERT INTO user_daily_stats (user_id, date, pnl, games, wins)
    VALUES (v_loser, CURRENT_DATE, -d.stake, 1, 0)
    ON CONFLICT (user_id, date)
    DO UPDATE SET pnl = user_daily_stats.pnl - d.stake,
      games = user_daily_stats.games + 1;
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


-- ====================================================
-- 6. get_user_profile with game_stats
-- ====================================================

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
  v_game_stats  JSONB;
BEGIN
  SELECT balance INTO v_balance FROM users WHERE id = p_user_id;
  IF v_balance IS NULL THEN
    RETURN jsonb_build_object('error', 'user_not_found');
  END IF;

  SELECT COALESCE(SUM(pnl), 0) INTO v_total
  FROM user_daily_stats
  WHERE user_id = p_user_id;

  SELECT COUNT(*) + 1 INTO v_rank
  FROM users u
  WHERE u.id != '00000000-0000-0000-0000-000000000001'
    AND COALESCE((SELECT SUM(pnl) FROM user_daily_stats WHERE user_id = u.id), 0) > v_total;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object('date', uds.date, 'pnl', uds.pnl, 'games', uds.games, 'wins', uds.wins)
    ORDER BY uds.date ASC
  ), '[]'::JSONB)
  INTO v_stats
  FROM user_daily_stats uds
  WHERE uds.user_id = p_user_id
    AND uds.date >= CURRENT_DATE - (p_days || ' days')::INTERVAL;

  SELECT COALESCE(SUM(amount), 0) INTO v_ref_day
  FROM referral_earnings
  WHERE referrer_id = p_user_id AND created_at >= CURRENT_DATE;

  SELECT COALESCE(SUM(amount), 0) INTO v_ref_week
  FROM referral_earnings
  WHERE referrer_id = p_user_id AND created_at >= CURRENT_DATE - INTERVAL '7 days';

  SELECT COALESCE(SUM(amount), 0) INTO v_ref_month
  FROM referral_earnings
  WHERE referrer_id = p_user_id AND created_at >= CURRENT_DATE - INTERVAL '30 days';

  SELECT COALESCE(SUM(amount), 0) INTO v_ref_all
  FROM referral_earnings
  WHERE referrer_id = p_user_id;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'game', gs.game_type,
      'wins', gs.wins,
      'total', gs.total
    )
  ), '[]'::JSONB)
  INTO v_game_stats
  FROM (
    SELECT
      COALESCE(d.game_type, 'quiz') AS game_type,
      COUNT(*) FILTER (WHERE d.winner_id = p_user_id) AS wins,
      COUNT(*) AS total
    FROM duels d
    WHERE d.status = 'finished'
      AND (d.creator_id = p_user_id OR d.opponent_id = p_user_id)
    GROUP BY COALESCE(d.game_type, 'quiz')
  ) gs;

  RETURN jsonb_build_object(
    'rank',         v_rank,
    'daily_stats',  v_stats,
    'total_pnl',    v_total,
    'ref_earnings', jsonb_build_object('day', v_ref_day, 'week', v_ref_week, 'month', v_ref_month, 'all', v_ref_all),
    'game_stats',   v_game_stats
  );
END;
$$;


-- ====================================================
-- 7. notify_on_game_invite
-- ====================================================

CREATE OR REPLACE FUNCTION notify_on_game_invite()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tg_id      BIGINT;
  v_sender     TEXT;
  v_game_label TEXT;
  v_msg        TEXT;
  v_markup     JSONB;
BEGIN
  IF NEW.status != 'pending' THEN
    RETURN NEW;
  END IF;

  SELECT telegram_id INTO v_tg_id
  FROM users
  WHERE id = NEW.to_id;

  IF v_tg_id IS NULL OR v_tg_id <= 0 THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(first_name, username, 'Player') INTO v_sender
  FROM users
  WHERE id = NEW.from_id;

  CASE NEW.game_type
    WHEN 'quiz' THEN v_game_label := 'Quiz';
    WHEN 'blackjack' THEN v_game_label := 'Blackjack';
    WHEN 'sequence' THEN v_game_label := 'Memory';
    WHEN 'reaction' THEN v_game_label := 'Reaction';
    WHEN 'hearing' THEN v_game_label := 'Hearing';
    WHEN 'gradient' THEN v_game_label := 'Gradient';
    WHEN 'race' THEN v_game_label := 'Race';
    WHEN 'capitals' THEN v_game_label := 'Capitals';
    WHEN 'circle' THEN v_game_label := 'Circle';
    ELSE v_game_label := NEW.game_type;
  END CASE;

  v_msg := '🎮 ' || v_sender || ' invited you to a duel!' || chr(10) ||
           'Stake: ' || NEW.stake || ' ⭐ · ' || v_game_label;

  v_markup := jsonb_build_object(
    'inline_keyboard', jsonb_build_array(
      jsonb_build_array(
        jsonb_build_object(
          'text', '▶️ Open game',
          'url', 'https://t.me/outplaymoneybot/app'
        )
      )
    )
  );

  PERFORM notify_user(v_tg_id, v_msg, v_markup);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$$;


-- ====================================================
-- 8. cleanup_abandoned_duels
-- ====================================================

DROP FUNCTION IF EXISTS cleanup_abandoned_duels();

CREATE OR REPLACE FUNCTION cleanup_abandoned_duels()
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_duel            RECORD;
  v_creator_played  BOOLEAN;
  v_opponent_played BOOLEAN;
  v_winner          UUID;
  v_loser           UUID;
  v_total_pot       INTEGER;
  v_rake            INTEGER;
  v_guild_fee       INTEGER;
  v_payout          INTEGER;
  v_season_id       UUID;
  v_actual_score    INTEGER;
  v_count_win       INTEGER := 0;
  v_count_burn      INTEGER := 0;
  v_count_skip      INTEGER := 0;
  v_answer_count    INTEGER;
BEGIN
  SELECT id INTO v_season_id FROM guild_seasons WHERE is_active = true LIMIT 1;

  FOR v_duel IN
    SELECT * FROM duels
    WHERE status = 'active'
      AND is_bot_game = false
      AND created_at < NOW() - INTERVAL '3 minutes'
    FOR UPDATE SKIP LOCKED
  LOOP
    v_creator_played := false;
    v_opponent_played := false;
    v_winner := NULL;

    IF v_duel.game_type = 'quiz' THEN
      SELECT COUNT(*) INTO v_answer_count
      FROM duel_answers WHERE duel_id = v_duel.id AND user_id = v_duel.creator_id;
      v_creator_played := v_answer_count > 0;

      SELECT COUNT(*) INTO v_answer_count
      FROM duel_answers WHERE duel_id = v_duel.id AND user_id = v_duel.opponent_id;
      v_opponent_played := v_answer_count > 0;

    ELSIF v_duel.game_type IN ('sequence', 'circle') THEN
      v_creator_played := v_duel.creator_score IS NOT NULL;
      v_opponent_played := v_duel.opponent_score IS NOT NULL;

    ELSIF v_duel.game_type = 'blackjack' THEN
      SELECT COUNT(*) INTO v_answer_count
      FROM blackjack_actions WHERE duel_id = v_duel.id AND user_id = v_duel.creator_id;
      v_creator_played := v_answer_count > 0;

      SELECT COUNT(*) INTO v_answer_count
      FROM blackjack_actions WHERE duel_id = v_duel.id AND user_id = v_duel.opponent_id;
      v_opponent_played := v_answer_count > 0;
    END IF;

    IF v_creator_played AND v_opponent_played THEN
      v_count_skip := v_count_skip + 1;
      CONTINUE;
    END IF;

    IF v_creator_played AND NOT v_opponent_played THEN
      v_winner := v_duel.creator_id;
      v_loser  := v_duel.opponent_id;
    ELSIF v_opponent_played AND NOT v_creator_played THEN
      v_winner := v_duel.opponent_id;
      v_loser  := v_duel.creator_id;
    END IF;

    IF v_winner IS NOT NULL THEN
      v_total_pot := v_duel.stake * 2;
      v_rake      := FLOOR(v_total_pot * 5 / 100);
      v_guild_fee := FLOOR(v_total_pot * 5 / 1000);
      v_payout    := v_total_pot - v_rake;

      IF v_season_id IS NOT NULL THEN
        UPDATE guild_seasons SET prize_pool = prize_pool + v_guild_fee WHERE id = v_season_id;
      END IF;

      IF v_duel.game_type = 'quiz' THEN
        SELECT COUNT(*) INTO v_actual_score
        FROM duel_answers
        WHERE duel_id = v_duel.id AND user_id = v_winner AND is_correct = true;
      ELSE
        IF v_winner = v_duel.creator_id THEN
          v_actual_score := COALESCE(v_duel.creator_score, 1);
        ELSE
          v_actual_score := COALESCE(v_duel.opponent_score, 1);
        END IF;
      END IF;

      IF v_winner = v_duel.creator_id THEN
        UPDATE duels
        SET creator_score = v_actual_score,
            opponent_score = 0,
            status = 'finished',
            winner_id = v_winner,
            finished_at = NOW()
        WHERE id = v_duel.id;
      ELSE
        UPDATE duels
        SET creator_score = 0,
            opponent_score = v_actual_score,
            status = 'finished',
            winner_id = v_winner,
            finished_at = NOW()
        WHERE id = v_duel.id;
      END IF;

      UPDATE users SET balance = balance + v_payout, wins = wins + 1 WHERE id = v_winner;
      INSERT INTO transactions (user_id, type, amount, ref_id)
      VALUES (v_winner, 'duel_win', v_payout, v_duel.id);

      INSERT INTO user_daily_stats (user_id, date, pnl, games, wins)
      VALUES (v_winner, CURRENT_DATE, v_payout - v_duel.stake, 1, 1)
      ON CONFLICT (user_id, date)
      DO UPDATE SET pnl = user_daily_stats.pnl + (v_payout - v_duel.stake),
        games = user_daily_stats.games + 1,
        wins = user_daily_stats.wins + 1;
      PERFORM update_guild_pnl_after_duel(v_winner, v_payout - v_duel.stake);

      UPDATE users SET losses = losses + 1 WHERE id = v_loser;
      INSERT INTO user_daily_stats (user_id, date, pnl, games, wins)
      VALUES (v_loser, CURRENT_DATE, -v_duel.stake, 1, 0)
      ON CONFLICT (user_id, date)
      DO UPDATE SET pnl = user_daily_stats.pnl - v_duel.stake,
        games = user_daily_stats.games + 1;
      PERFORM update_guild_pnl_after_duel(v_loser, -v_duel.stake);

      PERFORM admin_log('info', 'cleanup:abandoned_duels', 'Winner awarded',
        jsonb_build_object('duel_id', v_duel.id, 'winner', v_winner, 'loser', v_loser,
          'game_type', v_duel.game_type, 'stake', v_duel.stake, 'payout', v_payout));
      v_count_win := v_count_win + 1;
    ELSE
      UPDATE duels SET status = 'cancelled', finished_at = NOW() WHERE id = v_duel.id;

      UPDATE users SET losses = losses + 1 WHERE id = v_duel.creator_id;
      UPDATE users SET losses = losses + 1 WHERE id = v_duel.opponent_id;

      INSERT INTO user_daily_stats (user_id, date, pnl, games, wins)
      VALUES (v_duel.creator_id, CURRENT_DATE, -v_duel.stake, 1, 0)
      ON CONFLICT (user_id, date)
      DO UPDATE SET pnl = user_daily_stats.pnl - v_duel.stake,
        games = user_daily_stats.games + 1;

      INSERT INTO user_daily_stats (user_id, date, pnl, games, wins)
      VALUES (v_duel.opponent_id, CURRENT_DATE, -v_duel.stake, 1, 0)
      ON CONFLICT (user_id, date)
      DO UPDATE SET pnl = user_daily_stats.pnl - v_duel.stake,
        games = user_daily_stats.games + 1;

      PERFORM admin_log('info', 'cleanup:abandoned_duels', 'Both abandoned - stakes burned',
        jsonb_build_object('duel_id', v_duel.id, 'creator_id', v_duel.creator_id,
          'opponent_id', v_duel.opponent_id, 'game_type', v_duel.game_type, 'stake', v_duel.stake));
      v_count_burn := v_count_burn + 1;
    END IF;
  END LOOP;

  IF v_count_win > 0 OR v_count_burn > 0 THEN
    PERFORM admin_log('info', 'cleanup:abandoned_duels', 'Cleanup completed',
      jsonb_build_object('wins_awarded', v_count_win, 'stakes_burned', v_count_burn, 'skipped', v_count_skip));
  END IF;

  RETURN jsonb_build_object('wins_awarded', v_count_win, 'stakes_burned', v_count_burn, 'skipped', v_count_skip);
EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'cleanup:abandoned_duels', SQLERRM, '{}'::jsonb);
  RETURN jsonb_build_object('error', SQLERRM);
END;
$$;
