-- ====================================================
--  Migration: Capitals backend support
--  Score = total km error across rounds
--  (lower = better, like hearing/gradient/race)
-- ====================================================


-- ====================================================
--  0. Extend CHECK constraints for 'capitals'
-- ====================================================

ALTER TABLE matchmaking_queue DROP CONSTRAINT IF EXISTS matchmaking_queue_category_check;
ALTER TABLE matchmaking_queue ADD CONSTRAINT matchmaking_queue_category_check
  CHECK (category IN ('general','history','science','sport','movies','music','quiz','blackjack','sequence','reaction','hearing','gradient','race','capitals'));

ALTER TABLE game_invites DROP CONSTRAINT IF EXISTS game_invites_game_type_check;
ALTER TABLE game_invites ADD CONSTRAINT game_invites_game_type_check
  CHECK (game_type IN ('quiz', 'blackjack', 'sequence', 'reaction', 'hearing', 'gradient', 'race', 'capitals'));


-- ====================================================
--  1. submit_capitals_result
-- ====================================================

CREATE OR REPLACE FUNCTION submit_capitals_result(
  p_duel_id  UUID,
  p_user_id  UUID,
  p_score    INTEGER,   -- total km error (lower = better)
  p_time     REAL       -- total elapsed seconds
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

  IF v_duel.game_type != 'capitals' THEN
    RETURN jsonb_build_object('status', 'error', 'error', 'not_capitals');
  END IF;

  -- Store score (total km diff) + time for the correct player
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
    -- Both submitted, finalize
    RETURN finalize_duel(p_duel_id);
  END IF;

  RETURN jsonb_build_object('status', 'submitted', 'waiting_opponent', true);

EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'rpc:submit_capitals_result', SQLERRM,
    jsonb_build_object('duel_id', p_duel_id, 'user_id', p_user_id));
  RETURN jsonb_build_object('status', 'error', 'error', SQLERRM);
END;
$$;


-- ====================================================
--  2. Update finalize_duel - capitals support
--     Capitals: lower score (total km diff) wins
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

  -- ========================================
  -- Winner selection
  -- ========================================

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
    -- Reaction: lower average time wins
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
    -- Hearing / Gradient / Race / Capitals: lower score wins
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
    -- Tie-break by time
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

  -- Update stats
  UPDATE users SET wins = wins + 1 WHERE id = v_winner;
  UPDATE users SET losses = losses + 1 WHERE id = v_loser;

  -- Referral bonus
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


-- ====================================================
--  3. Update accept_game_invite for capitals
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
  ELSE
    RETURN jsonb_build_object('error', 'unknown_game_type');
  END IF;

  INSERT INTO duels (creator_id, opponent_id, category, stake, status, question_ids, game_type, bj_deck, bj_state)
  VALUES (v_inv.from_id, v_inv.to_id, v_category, v_inv.stake, 'active', COALESCE(v_question_ids, '{}'), v_inv.game_type, v_bj_deck, v_bj_state)
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
