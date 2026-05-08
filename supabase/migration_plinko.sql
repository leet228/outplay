-- =============================================
-- Plinko — production flow (server round + RTP guards + live feed)
-- Run AFTER migration_tetris_honest_v5.sql / migration_tower_honest.sql
-- =============================================
--
-- Adds the same honest-RNG, deficit-breaker, capped-payout pipeline
-- the other slots use:
--
--   start_plinko_round  — atomic stake debit (stake × balls_count).
--                         Reads slot_stats, returns deficit_active flag.
--                         Creates a 'pending' slot_rounds row.
--
--   finish_plinko_round — accepts the client's claimed total payout
--                         (sum across all balls in the launch). Caps
--                         it at the theoretical max (balls_count × base
--                         stake × 10000), applies the deficit breaker
--                         if pnl is past floor, credits balance.
--
-- Plinko has no per-ball "fall floor", so we don't run the
-- generate_tower_fall_level sampler. The client samples each ball's
-- landing slot via fair binomial(16, 0.5) coins; the server only
-- validates the total and caps abuse.

-- ── 1. Seed slot_stats row for plinko if missing ─────────────────
INSERT INTO slot_stats (slot_id, target_rtp, max_house_deficit_rub)
  VALUES ('plinko', 0.94, 10000)
  ON CONFLICT (slot_id) DO NOTHING;

-- ── 2. start_plinko_round ────────────────────────────────────────
-- Charges base_stake × balls_count atomically. Stores balls_count
-- in slot_rounds.fall_at_level so the finish RPC can compute the
-- theoretical max payout cap.

CREATE OR REPLACE FUNCTION start_plinko_round(
  p_user_id     UUID,
  p_stake_rub   INTEGER,
  p_balls_count INTEGER DEFAULT 1
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance        INTEGER;
  v_round_id       UUID;
  v_total_cost     INTEGER;
  v_pnl            BIGINT;
  v_max_deficit    INTEGER;
  v_enabled        BOOLEAN;
  v_deficit_active BOOLEAN;
  v_bias           TEXT;
BEGIN
  IF p_stake_rub IS NULL OR p_stake_rub < 10 OR p_stake_rub > 25000 THEN
    RETURN jsonb_build_object('error', 'invalid_stake');
  END IF;
  IF p_balls_count IS NULL OR p_balls_count < 1 OR p_balls_count > 100 THEN
    RETURN jsonb_build_object('error', 'invalid_balls_count');
  END IF;

  v_total_cost := p_stake_rub * p_balls_count;

  -- Auto-abort prior pending plinko rounds (crash recovery).
  UPDATE slot_rounds
     SET outcome = 'aborted', finished_at = NOW()
   WHERE user_id = p_user_id AND outcome = 'pending' AND slot_id = 'plinko';

  SELECT balance INTO v_balance FROM users WHERE id = p_user_id FOR UPDATE;
  IF v_balance IS NULL THEN
    RETURN jsonb_build_object('error', 'user_not_found');
  END IF;
  IF v_balance < v_total_cost THEN
    RETURN jsonb_build_object('error', 'insufficient_balance');
  END IF;

  SELECT current_pnl_rub, max_house_deficit_rub, enabled
    INTO v_pnl, v_max_deficit, v_enabled
    FROM slot_stats WHERE slot_id = 'plinko';

  IF v_pnl IS NULL THEN
    INSERT INTO slot_stats (slot_id, target_rtp, max_house_deficit_rub)
      VALUES ('plinko', 0.94, 10000) ON CONFLICT DO NOTHING;
    v_pnl := 0; v_max_deficit := 10000; v_enabled := true;
  END IF;
  IF NOT v_enabled THEN
    RETURN jsonb_build_object('error', 'slot_disabled');
  END IF;

  v_deficit_active := COALESCE(v_pnl, 0) <= -COALESCE(v_max_deficit, 10000);
  v_bias := CASE WHEN v_deficit_active THEN 'house_recovers' ELSE 'normal' END;

  UPDATE users SET balance = balance - v_total_cost WHERE id = p_user_id;

  -- Re-use slot_rounds.fall_at_level to record balls_count for this
  -- round — finish_plinko_round needs it to compute the per-launch cap.
  INSERT INTO slot_rounds (
    user_id, slot_id, stake_rub, fall_at_level, rtp_bias,
    outcome_kind, target_payout_rub, bonus_kind, is_bought
  )
  VALUES (
    p_user_id, 'plinko', v_total_cost, p_balls_count, v_bias,
    'open', NULL, NULL, false
  )
  RETURNING id INTO v_round_id;

  INSERT INTO transactions (user_id, type, amount, ref_id)
    VALUES (p_user_id, 'slot_bet', -v_total_cost, v_round_id);

  RETURN jsonb_build_object(
    'ok', true,
    'round_id', v_round_id,
    'balance', v_balance - v_total_cost,
    'balls_count', p_balls_count,
    'deficit_active', v_deficit_active
  );

EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'rpc:start_plinko_round', SQLERRM,
    jsonb_build_object('user_id', p_user_id, 'stake', p_stake_rub, 'balls', p_balls_count));
  RETURN jsonb_build_object('error', SQLERRM);
END;
$$;


-- ── 3. finish_plinko_round ───────────────────────────────────────
-- Accepts the client's claimed total payout for the launch (sum
-- across all balls). Caps + applies deficit breaker.

CREATE OR REPLACE FUNCTION finish_plinko_round(
  p_round_id   UUID,
  p_payout_rub INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id        UUID;
  v_total_stake    INTEGER;     -- base_stake × balls_count (already charged)
  v_balls_count    INTEGER;     -- stored in fall_at_level
  v_base_stake     INTEGER;
  v_outcome_now    TEXT;
  v_payout_to_pay  INTEGER;
  v_balance_new    INTEGER;
  v_pnl            INTEGER;
  v_house_pnl      BIGINT;
  v_max_deficit    INTEGER;
  v_deficit_active BOOLEAN;
  v_hard_cap       INTEGER;
BEGIN
  IF p_payout_rub IS NULL OR p_payout_rub < 0 THEN p_payout_rub := 0; END IF;

  SELECT user_id, stake_rub, outcome, fall_at_level
    INTO v_user_id, v_total_stake, v_outcome_now, v_balls_count
    FROM slot_rounds WHERE id = p_round_id FOR UPDATE;

  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'round_not_found');
  END IF;
  IF v_outcome_now <> 'pending' THEN
    SELECT balance INTO v_balance_new FROM users WHERE id = v_user_id;
    RETURN jsonb_build_object('error', 'already_finished', 'balance', v_balance_new);
  END IF;

  -- Recover the per-ball stake; balls_count is in fall_at_level.
  IF v_balls_count IS NULL OR v_balls_count < 1 THEN v_balls_count := 1; END IF;
  v_base_stake := v_total_stake / v_balls_count;

  -- Hard cap: a player can win at most (balls_count × base_stake × 10000)
  -- — every ball's max multiplier is 10000 on HIGH risk. Plus an
  -- absolute 1 000 000 ₽ ceiling so a runaway client can't drain
  -- the house in one launch.
  v_hard_cap := LEAST(v_balls_count * v_base_stake * 10000, 1000000);
  v_payout_to_pay := LEAST(p_payout_rub, v_hard_cap);

  -- Deficit circuit breaker: if the slot is past its loss floor, force
  -- the launch to a stake refund minus a small house tax (50 % of total
  -- stake). Player still gets something so the UI doesn't look broken,
  -- but the house claws back regardless of what the client claimed.
  SELECT current_pnl_rub, max_house_deficit_rub
    INTO v_house_pnl, v_max_deficit
    FROM slot_stats WHERE slot_id = 'plinko';
  v_deficit_active := COALESCE(v_house_pnl, 0) <= -COALESCE(v_max_deficit, 10000);

  IF v_deficit_active THEN
    v_payout_to_pay := LEAST(v_payout_to_pay, v_total_stake / 2);
  END IF;

  IF v_payout_to_pay > 0 THEN
    UPDATE users SET balance = balance + v_payout_to_pay WHERE id = v_user_id;
    INSERT INTO transactions (user_id, type, amount, ref_id)
      VALUES (v_user_id, 'slot_win', v_payout_to_pay, p_round_id);
  END IF;

  UPDATE slot_rounds
     SET outcome     = CASE WHEN v_payout_to_pay > 0 THEN 'cashed' ELSE 'fallen' END,
         payout_rub  = v_payout_to_pay,
         floors      = v_balls_count,
         multiplier  = CASE WHEN v_total_stake > 0
                            THEN ROUND(v_payout_to_pay::NUMERIC / v_total_stake, 4)
                            ELSE 0 END,
         finished_at = NOW()
   WHERE id = p_round_id;

  -- Aggregate slot stats.
  INSERT INTO slot_stats (slot_id, total_games, total_wagered_rub, total_paid_rub, current_pnl_rub)
    VALUES ('plinko', 1, v_total_stake, v_payout_to_pay, v_total_stake - v_payout_to_pay)
    ON CONFLICT (slot_id) DO UPDATE SET
      total_games        = slot_stats.total_games + 1,
      total_wagered_rub  = slot_stats.total_wagered_rub + v_total_stake,
      total_paid_rub     = slot_stats.total_paid_rub + v_payout_to_pay,
      current_pnl_rub    = slot_stats.current_pnl_rub + (v_total_stake - v_payout_to_pay),
      updated_at         = NOW();

  v_pnl := v_payout_to_pay - v_total_stake;

  INSERT INTO user_daily_stats (user_id, date, pnl, games, wins)
    VALUES (
      v_user_id, CURRENT_DATE, v_pnl, 1,
      CASE WHEN v_payout_to_pay > v_total_stake THEN 1 ELSE 0 END
    )
    ON CONFLICT (user_id, date)
    DO UPDATE SET
      pnl   = user_daily_stats.pnl + v_pnl,
      games = user_daily_stats.games + 1,
      wins  = user_daily_stats.wins + CASE WHEN v_payout_to_pay > v_total_stake THEN 1 ELSE 0 END;

  PERFORM update_guild_pnl_after_duel(v_user_id, v_pnl);

  SELECT balance INTO v_balance_new FROM users WHERE id = v_user_id;

  RETURN jsonb_build_object(
    'ok', true,
    'balance', v_balance_new,
    'payout', v_payout_to_pay,
    'pnl', v_pnl,
    'deficit_active', v_deficit_active
  );

EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'rpc:finish_plinko_round', SQLERRM,
    jsonb_build_object('round_id', p_round_id, 'payout', p_payout_rub));
  RETURN jsonb_build_object('error', SQLERRM);
END;
$$;


-- ── 4. Live feed: recognise plinko ───────────────────────────────
-- The feed_on_slot_round_change trigger drops events with an unknown
-- slot_id. Add 'plinko' to the dispatch so wins/losses surface in the
-- LiveFeed UI on Home.

CREATE OR REPLACE FUNCTION feed_on_slot_round_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_label  TEXT;
  v_amount INTEGER;
BEGIN
  IF    NEW.slot_id = 'tower-stack'    THEN v_label := 'Tower Stack';
  ELSIF NEW.slot_id = 'tetris-cascade' THEN v_label := 'Tetris Cascade';
  ELSIF NEW.slot_id = 'plinko'         THEN v_label := 'Plinko';
  ELSE
    RETURN NEW;
  END IF;

  IF NEW.outcome = 'cashed' AND NEW.payout_rub > 0 THEN
    v_amount := NEW.payout_rub - NEW.stake_rub;  -- net profit
    IF v_amount <= 0 THEN
      v_amount := -NEW.stake_rub;  -- net loss / break-even shows as loss
    END IF;
  ELSIF NEW.outcome = 'fallen' THEN
    v_amount := -NEW.stake_rub;
  ELSE
    RETURN NEW;
  END IF;

  PERFORM feed_insert_real(NEW.user_id, NEW.slot_id, v_label, v_amount);
  RETURN NEW;

EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'trg:feed_on_slot_round_change', SQLERRM,
    jsonb_build_object('round_id', NEW.id));
  RETURN NEW;
END;
$$;


-- ── 5. Live feed: include plinko in fake-event seeder ────────────
CREATE OR REPLACE FUNCTION feed_insert_fake()
RETURNS VOID LANGUAGE plpgsql VOLATILE
AS $$
DECLARE
  v_games TEXT[][] := ARRAY[
    ARRAY['tower-stack',    'Tower Stack'],
    ARRAY['tetris-cascade', 'Tetris Cascade'],
    ARRAY['rocket',         'Rocket'],
    ARRAY['plinko',         'Plinko']
  ];
  v_bets INTEGER[] := ARRAY[10, 25, 50, 100, 250, 500, 1000, 2000, 4000, 8000, 16000, 25000];
  v_game_idx INTEGER;
  v_amount   INTEGER;
  r          NUMERIC;
BEGIN
  v_game_idx := 1 + floor(random() * array_length(v_games, 1))::INT;

  IF random() < 0.60 THEN
    r := random();
    v_amount := -CASE
      WHEN r < 0.95 THEN v_bets[1 + floor(random() * 4)::INT]
      WHEN r < 0.98 THEN v_bets[5 + floor(random() * 2)::INT]
      WHEN r < 0.99 THEN v_bets[7 + floor(random() * 2)::INT]
      ELSE              v_bets[9 + floor(random() * 4)::INT]
    END;
  ELSE
    r := random();
    IF r < 0.95 THEN
      v_amount := 10 + floor(random() * 190)::INT;
    ELSIF r < 0.98 THEN
      v_amount := 200 + floor(random() * 1800)::INT;
    ELSIF r < 0.99 THEN
      v_amount := 2000 + floor(random() * 3000)::INT;
    ELSE
      v_amount := 5000 + floor(random() * 20000)::INT;
    END IF;
  END IF;

  INSERT INTO live_feed_events (game_id, game_label, amount_rub, kind, created_at)
    VALUES (
      v_games[v_game_idx][1],
      v_games[v_game_idx][2],
      v_amount,
      'fake',
      NOW()
    );
END;
$$;


GRANT EXECUTE ON FUNCTION start_plinko_round(UUID, INTEGER, INTEGER) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION finish_plinko_round(UUID, INTEGER)         TO authenticated, anon;

NOTIFY pgrst, 'reload schema';
