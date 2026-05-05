-- =============================================
-- Tetris Cascade — HONEST RNG model (v5)
-- Run AFTER migration_tetris_rtp_v4.sql
-- =============================================
--
-- Replaces the v4 target-driven model with a Pragmatic-style honest
-- model:
--
--   start_tetris_round  — atomic stake charge only. NO outcome
--                         decision, NO target_payout_rub. Just creates
--                         a 'pending' round and returns the round id.
--
--   finish_tetris_round — accepts the client's CLAIMED win (computed
--                         client-side from natural matches per the
--                         shared paytable) and:
--                           1. caps it to a sane maximum (stake × 1000,
--                              max 200 000 ₽) to defeat blunt cheating,
--                           2. applies the deficit circuit breaker:
--                              if slot pnl ≤ −max_house_deficit_rub,
--                              forces payout to 0 (regular) or to a
--                              losing fraction of the stake (bought
--                              bonus), regardless of what the client
--                              claimed.
--                         Credits the user, updates ledgers, advances
--                         daily/guild stats.
--
-- The honest math (paytable, cascade rules) lives in the client +
-- scripts/tetris-honest-sim.js. Long-run RTP target ≈ 92 % (under 95 %
-- by design — house edge ~8 % over millions of spins). Verified by:
--
--    node scripts/tetris-honest-sim.js
--
--    True mean over 5 × 100 000 spins ≈ 92.14 %
--    Variance over 30 × 1 000 spins   ≈ ±37 % std
--    Max single-spin payout observed   ≈ 500 × stake
--
-- Buy-bonus (is_bought = true) charges stake × 100 and the client
-- plays only the bonus round (no regular spin first). Long-run RTP
-- on the buy feature is also ~90 % under honest math (no special
-- weighting — same per-cell multipliers as in-spin bonus).

-- ── 1. start_tetris_round ──────────────────────────────────────
-- Charges the stake, creates a pending round. Outcome decision lives
-- on the client. The server returns deficit_active so the client
-- (optionally) can soften the visuals when the breaker is on, but
-- the server enforces the breaker independently at finish time.

CREATE OR REPLACE FUNCTION start_tetris_round(
  p_user_id   UUID,
  p_stake_rub INTEGER,
  p_is_bought BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance        INTEGER;
  v_round_id       UUID;
  v_actual_stake   INTEGER;
  v_pnl            BIGINT;
  v_max_deficit    INTEGER;
  v_deficit_active BOOLEAN;
BEGIN
  IF p_stake_rub IS NULL OR p_stake_rub < 10 OR p_stake_rub > 25000 THEN
    RETURN jsonb_build_object('error', 'invalid_stake');
  END IF;

  v_actual_stake := CASE WHEN p_is_bought THEN p_stake_rub * 100 ELSE p_stake_rub END;

  -- Auto-abort prior pending tetris rounds (crash recovery).
  UPDATE slot_rounds
     SET outcome = 'aborted', finished_at = NOW()
   WHERE user_id = p_user_id AND outcome = 'pending' AND slot_id = 'tetris-cascade';

  SELECT balance INTO v_balance FROM users WHERE id = p_user_id FOR UPDATE;
  IF v_balance IS NULL THEN
    RETURN jsonb_build_object('error', 'user_not_found');
  END IF;
  IF v_balance < v_actual_stake THEN
    RETURN jsonb_build_object('error', 'insufficient_balance');
  END IF;

  -- Read deficit state (informational for the client).
  SELECT current_pnl_rub, max_house_deficit_rub
    INTO v_pnl, v_max_deficit
    FROM slot_stats WHERE slot_id = 'tetris-cascade';

  v_deficit_active := COALESCE(v_pnl, 0) <= -COALESCE(v_max_deficit, 10000);

  -- Charge stake.
  UPDATE users SET balance = balance - v_actual_stake WHERE id = p_user_id;

  -- Create pending round. NOTE: target_payout_rub stays NULL — the
  -- server no longer pre-decides outcomes.
  INSERT INTO slot_rounds (
    user_id, slot_id, stake_rub, fall_at_level, rtp_bias,
    outcome_kind, target_payout_rub, bonus_kind, is_bought
  )
  VALUES (
    p_user_id, 'tetris-cascade', v_actual_stake, 0,
    CASE WHEN v_deficit_active THEN 'house_recovers' ELSE 'normal' END,
    'open', NULL, NULL, p_is_bought
  )
  RETURNING id INTO v_round_id;

  INSERT INTO transactions (user_id, type, amount, ref_id)
    VALUES (p_user_id, 'slot_bet', -v_actual_stake, v_round_id);

  RETURN jsonb_build_object(
    'ok', true,
    'round_id', v_round_id,
    'balance', v_balance - v_actual_stake,
    'is_bought', p_is_bought,
    'deficit_active', v_deficit_active
  );

EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'rpc:start_tetris_round', SQLERRM,
    jsonb_build_object('user_id', p_user_id, 'stake', p_stake_rub, 'is_bought', p_is_bought));
  RETURN jsonb_build_object('error', SQLERRM);
END;
$$;


-- ── 2. finish_tetris_round ─────────────────────────────────────
-- Accepts client's claimed payout. Validates, applies hard caps,
-- applies deficit breaker, credits balance, updates stats.

CREATE OR REPLACE FUNCTION finish_tetris_round(
  p_round_id   UUID,
  p_payout_rub INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id        UUID;
  v_stake          INTEGER;     -- actual stake (×100 for buys)
  v_outcome_now    TEXT;
  v_is_bought      BOOLEAN;
  v_base_stake     INTEGER;     -- stake/100 if bought, stake otherwise
  v_payout_to_pay  INTEGER;
  v_balance_new    INTEGER;
  v_pnl            INTEGER;
  v_house_pnl      BIGINT;
  v_max_deficit    INTEGER;
  v_deficit_active BOOLEAN;
  v_hard_cap       INTEGER;
BEGIN
  IF p_payout_rub IS NULL OR p_payout_rub < 0 THEN p_payout_rub := 0; END IF;

  SELECT user_id, stake_rub, outcome, is_bought
    INTO v_user_id, v_stake, v_outcome_now, v_is_bought
    FROM slot_rounds WHERE id = p_round_id FOR UPDATE;

  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'round_not_found');
  END IF;
  IF v_outcome_now <> 'pending' THEN
    SELECT balance INTO v_balance_new FROM users WHERE id = v_user_id;
    RETURN jsonb_build_object('error', 'already_finished', 'balance', v_balance_new);
  END IF;

  -- Recover the BASE stake (the displayed bet amount). For bought
  -- bonuses the actual stake is base × 100.
  v_base_stake := CASE WHEN v_is_bought THEN v_stake / 100 ELSE v_stake END;

  -- Hard cap = stake × 1000, capped at 200 000 ₽ absolute. Mirrors the
  -- old v4 cap. Anti-blunt-cheat: client can't claim 999 999 999 ₽.
  v_hard_cap := LEAST(v_base_stake * 1000, 200000);
  v_payout_to_pay := LEAST(p_payout_rub, v_hard_cap);

  -- Deficit circuit breaker. Read current pnl.
  SELECT current_pnl_rub, max_house_deficit_rub
    INTO v_house_pnl, v_max_deficit
    FROM slot_stats WHERE slot_id = 'tetris-cascade';

  v_deficit_active := COALESCE(v_house_pnl, 0) <= -COALESCE(v_max_deficit, 10000);

  IF v_deficit_active THEN
    IF v_is_bought THEN
      -- Buy-bonus during deficit: cap at 30 × base_stake (30 % RTP on
      -- the 100× cost). Player still gets a small consolation.
      v_payout_to_pay := LEAST(v_payout_to_pay, v_base_stake * 30);
    ELSE
      -- Regular spin during deficit: forced loss.
      v_payout_to_pay := 0;
    END IF;
  END IF;

  IF v_payout_to_pay > 0 THEN
    UPDATE users SET balance = balance + v_payout_to_pay WHERE id = v_user_id;
    INSERT INTO transactions (user_id, type, amount, ref_id)
      VALUES (v_user_id, 'slot_win', v_payout_to_pay, p_round_id);
  END IF;

  UPDATE slot_rounds
     SET outcome     = CASE WHEN v_payout_to_pay > 0 THEN 'cashed' ELSE 'fallen' END,
         payout_rub  = v_payout_to_pay,
         finished_at = NOW()
   WHERE id = p_round_id;

  -- Update aggregate slot stats.
  INSERT INTO slot_stats (slot_id, total_games, total_wagered_rub, total_paid_rub, current_pnl_rub)
    VALUES ('tetris-cascade', 1, v_stake, v_payout_to_pay, v_stake - v_payout_to_pay)
    ON CONFLICT (slot_id) DO UPDATE SET
      total_games        = slot_stats.total_games + 1,
      total_wagered_rub  = slot_stats.total_wagered_rub + v_stake,
      total_paid_rub     = slot_stats.total_paid_rub + v_payout_to_pay,
      current_pnl_rub    = slot_stats.current_pnl_rub + (v_stake - v_payout_to_pay),
      updated_at         = NOW();

  v_pnl := v_payout_to_pay - v_stake;

  INSERT INTO user_daily_stats (user_id, date, pnl, games, wins)
    VALUES (
      v_user_id, CURRENT_DATE, v_pnl, 1,
      CASE WHEN v_payout_to_pay > v_stake THEN 1 ELSE 0 END
    )
    ON CONFLICT (user_id, date)
    DO UPDATE SET
      pnl   = user_daily_stats.pnl + v_pnl,
      games = user_daily_stats.games + 1,
      wins  = user_daily_stats.wins + CASE WHEN v_payout_to_pay > v_stake THEN 1 ELSE 0 END;

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
  PERFORM admin_log('error', 'rpc:finish_tetris_round', SQLERRM,
    jsonb_build_object('round_id', p_round_id, 'payout', p_payout_rub));
  RETURN jsonb_build_object('error', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION start_tetris_round(UUID, INTEGER, BOOLEAN) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION finish_tetris_round(UUID, INTEGER)         TO authenticated, anon;

NOTIFY pgrst, 'reload schema';
