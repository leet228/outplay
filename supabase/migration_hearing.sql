-- ╔═══════════════════════════════════════════════════╗
-- ║  Migration: Hearing game support                 ║
-- ║  Reuses creator_score/opponent_score (total diff) ║
-- ║  and creator_time/opponent_time columns           ║
-- ╚═══════════════════════════════════════════════════╝


-- ╔═══════════════════════════════════════════════════╗
-- ║  0. Extend category CHECK to include 'hearing'   ║
-- ╚═══════════════════════════════════════════════════╝

ALTER TABLE matchmaking_queue DROP CONSTRAINT IF EXISTS matchmaking_queue_category_check;
ALTER TABLE matchmaking_queue ADD CONSTRAINT matchmaking_queue_category_check
  CHECK (category IN ('general','history','science','sport','movies','music','quiz','blackjack','sequence','reaction','hearing'));

-- Also update game_invites CHECK to support new game types
ALTER TABLE game_invites DROP CONSTRAINT IF EXISTS game_invites_game_type_check;
ALTER TABLE game_invites ADD CONSTRAINT game_invites_game_type_check
  CHECK (game_type IN ('quiz', 'blackjack', 'sequence', 'reaction', 'hearing'));


-- ╔═══════════════════════════════════════════════════╗
-- ║  1. submit_hearing_result                        ║
-- ╚═══════════════════════════════════════════════════╝

CREATE OR REPLACE FUNCTION submit_hearing_result(
  p_duel_id  UUID,
  p_user_id  UUID,
  p_score    INTEGER,   -- total Hz difference (lower = better)
  p_time     REAL       -- not used for winner, but stored for reference
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

  IF v_duel.game_type != 'hearing' THEN
    RETURN jsonb_build_object('status', 'error', 'error', 'not_hearing');
  END IF;

  -- Store score (total diff) + time for the correct player
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
  PERFORM admin_log('error', 'rpc:submit_hearing_result', SQLERRM,
    jsonb_build_object('duel_id', p_duel_id, 'user_id', p_user_id));
  RETURN jsonb_build_object('status', 'error', 'error', SQLERRM);
END;
$$;


-- ╔═══════════════════════════════════════════════════╗
-- ║  2. Update finalize_duel — hearing support       ║
-- ║     Hearing: lower score (total Hz diff) wins    ║
-- ║     Added alongside reaction block               ║
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
    -- Реакция: побеждает меньшее среднее время
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

  ELSIF d.game_type = 'hearing' THEN
    -- Слух: побеждает меньшая суммарная разница Hz (score = total diff, lower = better)
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
