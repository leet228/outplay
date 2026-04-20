-- ====================================================
--  Migration: Tiebreak-by-time for capitals/hearing/gradient
--
--  Before: when scores tied, winner was chosen by random()
--          — this created a visual mismatch with the client,
--          which shows "you were faster by X sec → win/loss".
--
--  After: on a tie, compare creator_time / opponent_time and
--         award the win to whoever finished faster (lower time).
--         Falls back to random() only if times are ALSO equal
--         or both are NULL (unlikely with REAL seconds).
--
--  Race is intentionally NOT included — its score IS the time
--  in ms, so equal scores already mean equal times. Leaving it
--  on random() keeps behaviour identical for that game.
--
--  Reaction already uses time as the primary criterion.
--  Blackjack has no time tracking.
--  Sequence / Circle already tiebreak by time.
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

  -- Bot game: bot_should_win forces winner regardless of scores
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

  -- ═════════════════════════════════════════════════════════
  -- CHANGED: capitals / hearing / gradient now tie-break by
  -- time (lower wins) instead of random.
  -- ═════════════════════════════════════════════════════════
  ELSIF d.game_type IN ('hearing', 'gradient', 'capitals') THEN
    IF d.creator_score < d.opponent_score THEN
      v_winner := d.creator_id; v_loser := d.opponent_id;
    ELSIF d.opponent_score < d.creator_score THEN
      v_winner := d.opponent_id; v_loser := d.creator_id;
    ELSE
      -- Scores tied — break by time (lower total_time wins)
      v_creator_time := d.creator_time;
      v_opp_time := d.opponent_time;

      IF v_creator_time IS NOT NULL AND v_opp_time IS NOT NULL THEN
        IF v_creator_time < v_opp_time THEN
          v_winner := d.creator_id; v_loser := d.opponent_id;
        ELSIF v_opp_time < v_creator_time THEN
          v_winner := d.opponent_id; v_loser := d.creator_id;
        ELSE
          -- Times ALSO tied — last-resort random
          IF random() < 0.5 THEN
            v_winner := d.creator_id; v_loser := d.opponent_id;
          ELSE
            v_winner := d.opponent_id; v_loser := d.creator_id;
          END IF;
        END IF;
      ELSE
        -- One side has no time (legacy rows) — random
        IF random() < 0.5 THEN
          v_winner := d.creator_id; v_loser := d.opponent_id;
        ELSE
          v_winner := d.opponent_id; v_loser := d.creator_id;
        END IF;
      END IF;
    END IF;

  -- Race: score IS the time in ms, so equal scores already mean
  -- equal times. Keeping random as the last-resort tiebreak.
  ELSIF d.game_type = 'race' THEN
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

  -- Default branch (quiz, sequence, circle): higher score wins,
  -- tied → time-based tiebreak.
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
