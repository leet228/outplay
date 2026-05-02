-- =============================================
-- Migration: Server-controlled RTP for slots
-- Запусти в Supabase SQL Editor после migration_slot_rounds.sql
-- =============================================

-- ╔═══════════════════════════════════════════╗
-- ║  1. Per-slot stats (driver of RTP logic) ║
-- ╚═══════════════════════════════════════════╝
-- Single row per slot. We update it atomically inside finish_slot_round
-- via INSERT ... ON CONFLICT DO UPDATE so high concurrency is handled
-- by Postgres row-level locking. Reads in start_slot_round are NOT
-- locked (the value is advisory for the bias decision).

CREATE TABLE IF NOT EXISTS slot_stats (
  slot_id               TEXT PRIMARY KEY,
  total_games           BIGINT NOT NULL DEFAULT 0,
  total_wagered_rub     BIGINT NOT NULL DEFAULT 0,
  total_paid_rub        BIGINT NOT NULL DEFAULT 0,
  current_pnl_rub       BIGINT NOT NULL DEFAULT 0,  -- wagered - paid (positive = house up)
  target_rtp            NUMERIC(5,4) NOT NULL DEFAULT 0.95
                        CHECK (target_rtp > 0 AND target_rtp <= 1.5),
  max_house_deficit_rub INTEGER NOT NULL DEFAULT 10000
                        CHECK (max_house_deficit_rub >= 0),
  enabled               BOOLEAN NOT NULL DEFAULT true,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed Tower Stack
INSERT INTO slot_stats (slot_id, target_rtp, max_house_deficit_rub)
  VALUES ('tower-stack', 0.95, 10000)
  ON CONFLICT (slot_id) DO NOTHING;


-- ╔═══════════════════════════════════════════╗
-- ║  2. fall_at_level + bias on slot_rounds   ║
-- ╚═══════════════════════════════════════════╝
-- The server pre-decides at which floor the tower will collapse and
-- which RTP bias drove that decision (for analytics / debugging).

ALTER TABLE slot_rounds ADD COLUMN IF NOT EXISTS fall_at_level INTEGER NOT NULL DEFAULT 99;
ALTER TABLE slot_rounds ADD COLUMN IF NOT EXISTS rtp_bias TEXT NOT NULL DEFAULT 'normal';

CREATE INDEX IF NOT EXISTS idx_slot_rounds_slot_created
  ON slot_rounds(slot_id, created_at DESC);


-- ╔═══════════════════════════════════════════╗
-- ║  3. fall-level sampler (geometric)        ║
-- ╚═══════════════════════════════════════════╝
-- Survival probability per level → fall level. With p=0.73 the
-- expected return for a player who always cashes at level 1 is
-- 0.73 × 1.3 = 0.949 ≈ 95% RTP. Greedier strategies pay out less.

CREATE OR REPLACE FUNCTION generate_slot_fall_level(p_survival_prob NUMERIC)
RETURNS INTEGER LANGUAGE plpgsql IMMUTABLE STRICT
AS $$
DECLARE
  v_level  INTEGER := 1;
  v_safety INTEGER := 0;
BEGIN
  IF p_survival_prob <= 0 THEN RETURN 1; END IF;
  IF p_survival_prob >= 1 THEN RETURN 50; END IF;

  WHILE random() < p_survival_prob LOOP
    v_level := v_level + 1;
    v_safety := v_safety + 1;
    IF v_safety >= 50 THEN EXIT; END IF;
  END LOOP;

  RETURN v_level;
END;
$$;


-- ╔═══════════════════════════════════════════╗
-- ║  4. start_slot_round (RTP-aware)          ║
-- ╚═══════════════════════════════════════════╝

CREATE OR REPLACE FUNCTION start_slot_round(
  p_user_id   UUID,
  p_slot_id   TEXT,
  p_stake_rub INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance       INTEGER;
  v_round_id      UUID;
  v_pnl           BIGINT;
  v_wagered       BIGINT;
  v_paid          BIGINT;
  v_target_rtp    NUMERIC;
  v_max_deficit   INTEGER;
  v_enabled       BOOLEAN;
  v_current_rtp   NUMERIC;
  v_bias          TEXT;
  v_survival_prob NUMERIC;
  v_fall_level    INTEGER;
BEGIN
  -- Validate inputs
  IF p_stake_rub IS NULL OR p_stake_rub < 10 OR p_stake_rub > 25000 THEN
    RETURN jsonb_build_object('error', 'invalid_stake');
  END IF;
  IF p_slot_id IS NULL OR LENGTH(p_slot_id) = 0 THEN
    RETURN jsonb_build_object('error', 'invalid_slot');
  END IF;

  -- Auto-abort prior pending rounds for this user (lost rounds, crashes)
  UPDATE slot_rounds
     SET outcome = 'aborted', finished_at = NOW()
   WHERE user_id = p_user_id AND outcome = 'pending';

  -- Lock + read user balance
  SELECT balance INTO v_balance FROM users WHERE id = p_user_id FOR UPDATE;
  IF v_balance IS NULL THEN
    RETURN jsonb_build_object('error', 'user_not_found');
  END IF;
  IF v_balance < p_stake_rub THEN
    RETURN jsonb_build_object('error', 'insufficient_balance');
  END IF;

  -- Read slot stats (no lock — values are advisory for outcome decision)
  SELECT current_pnl_rub, total_wagered_rub, total_paid_rub,
         target_rtp, max_house_deficit_rub, enabled
    INTO v_pnl, v_wagered, v_paid,
         v_target_rtp, v_max_deficit, v_enabled
    FROM slot_stats WHERE slot_id = p_slot_id;

  -- Auto-create stats row if missing
  IF v_target_rtp IS NULL THEN
    INSERT INTO slot_stats (slot_id) VALUES (p_slot_id)
      ON CONFLICT (slot_id) DO NOTHING;
    v_pnl := 0; v_wagered := 0; v_paid := 0;
    v_target_rtp := 0.95; v_max_deficit := 10000; v_enabled := true;
  END IF;

  IF NOT v_enabled THEN
    RETURN jsonb_build_object('error', 'slot_disabled');
  END IF;

  -- Decide bias
  v_current_rtp := CASE WHEN v_wagered > 0 THEN v_paid::NUMERIC / v_wagered ELSE 0 END;

  IF v_pnl <= -v_max_deficit THEN
    v_bias := 'house_recovers';            -- house bleeding too much, force losses
  ELSIF v_wagered < 50 THEN
    v_bias := 'normal';                    -- cold start, no statistical signal yet
  ELSIF v_current_rtp > v_target_rtp + 0.05 THEN
    v_bias := 'house_recovers';            -- RTP drift too high
  ELSIF v_current_rtp < v_target_rtp - 0.05 AND v_pnl > 0 THEN
    v_bias := 'house_concedes';            -- house ahead, treat the player
  ELSE
    v_bias := 'normal';
  END IF;

  -- Survival probability per level
  -- normal:           0.73 → ~95% RTP for level-1 cash-out
  -- house_recovers:   0.55 → shorter survival, lower payouts
  -- house_concedes:   0.83 → longer survival, higher payouts
  v_survival_prob := CASE v_bias
    WHEN 'house_recovers' THEN 0.55
    WHEN 'house_concedes' THEN 0.83
    ELSE                       0.73
  END;

  v_fall_level := generate_slot_fall_level(v_survival_prob);

  -- Atomic stake deduction
  UPDATE users SET balance = balance - p_stake_rub WHERE id = p_user_id;

  -- Create the round with the predetermined outcome
  INSERT INTO slot_rounds (user_id, slot_id, stake_rub, fall_at_level, rtp_bias)
    VALUES (p_user_id, p_slot_id, p_stake_rub, v_fall_level, v_bias)
    RETURNING id INTO v_round_id;

  -- Bet transaction
  INSERT INTO transactions (user_id, type, amount, ref_id)
    VALUES (p_user_id, 'slot_bet', -p_stake_rub, v_round_id);

  RETURN jsonb_build_object(
    'ok', true,
    'round_id', v_round_id,
    'balance', v_balance - p_stake_rub,
    'fall_at_level', v_fall_level
  );

EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'rpc:start_slot_round', SQLERRM,
    jsonb_build_object('user_id', p_user_id, 'slot_id', p_slot_id, 'stake', p_stake_rub));
  RETURN jsonb_build_object('error', SQLERRM);
END;
$$;


-- ╔═══════════════════════════════════════════╗
-- ║  5. finish_slot_round (with stats update) ║
-- ╚═══════════════════════════════════════════╝

CREATE OR REPLACE FUNCTION finish_slot_round(
  p_round_id   UUID,
  p_outcome    TEXT,
  p_payout_rub INTEGER,
  p_floors     INTEGER,
  p_multiplier NUMERIC DEFAULT 1.0
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id       UUID;
  v_stake         INTEGER;
  v_outcome_now   TEXT;
  v_pnl           INTEGER;
  v_balance_new   INTEGER;
  v_payout_capped INTEGER;
  v_slot_id       TEXT;
  v_fall_level    INTEGER;
  v_forced        BOOLEAN := false;
BEGIN
  IF p_outcome NOT IN ('cashed', 'fallen', 'aborted') THEN
    RETURN jsonb_build_object('error', 'invalid_outcome');
  END IF;
  IF p_payout_rub IS NULL OR p_payout_rub < 0 THEN p_payout_rub := 0; END IF;
  IF p_floors IS NULL OR p_floors < 0 THEN p_floors := 0; END IF;

  -- Lock the round
  SELECT user_id, stake_rub, outcome, slot_id, fall_at_level
    INTO v_user_id, v_stake, v_outcome_now, v_slot_id, v_fall_level
    FROM slot_rounds WHERE id = p_round_id FOR UPDATE;

  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'round_not_found');
  END IF;
  IF v_outcome_now <> 'pending' THEN
    SELECT balance INTO v_balance_new FROM users WHERE id = v_user_id;
    RETURN jsonb_build_object('error', 'already_finished', 'balance', v_balance_new);
  END IF;

  -- Fallen / aborted always pay 0
  IF p_outcome <> 'cashed' THEN p_payout_rub := 0; END IF;

  -- ENFORCE server outcome: if user claims cash-out at or past the
  -- predetermined fall level, the round actually fell. The server is
  -- the source of truth — clients can't cheat by reporting outcomes.
  IF p_outcome = 'cashed' AND p_floors >= v_fall_level THEN
    p_outcome := 'fallen';
    p_payout_rub := 0;
    v_forced := true;
  END IF;

  -- Defensive cap: payout never exceeds 100x stake
  v_payout_capped := LEAST(p_payout_rub, v_stake * 100);

  -- Credit + transaction (only for actual cash-outs)
  IF v_payout_capped > 0 THEN
    UPDATE users SET balance = balance + v_payout_capped WHERE id = v_user_id;
    INSERT INTO transactions (user_id, type, amount, ref_id)
      VALUES (v_user_id, 'slot_win', v_payout_capped, p_round_id);
  END IF;

  -- Close the round
  UPDATE slot_rounds
     SET outcome = p_outcome,
         payout_rub = v_payout_capped,
         floors = p_floors,
         multiplier = COALESCE(p_multiplier, 1.0),
         finished_at = NOW()
   WHERE id = p_round_id;

  -- Update slot_stats atomically (single row UPSERT — Postgres handles
  -- concurrency via row-level locks; transactions are short-lived).
  -- Aborted rounds DON'T contribute to wagered/paid since the user
  -- got nothing AND is not really playing — but we still count the bet
  -- because the stake was already deducted.
  IF p_outcome IN ('cashed', 'fallen', 'aborted') THEN
    INSERT INTO slot_stats (slot_id, total_games, total_wagered_rub, total_paid_rub, current_pnl_rub)
      VALUES (v_slot_id, 1, v_stake, v_payout_capped, v_stake - v_payout_capped)
      ON CONFLICT (slot_id) DO UPDATE SET
        total_games        = slot_stats.total_games + 1,
        total_wagered_rub  = slot_stats.total_wagered_rub + v_stake,
        total_paid_rub     = slot_stats.total_paid_rub + v_payout_capped,
        current_pnl_rub    = slot_stats.current_pnl_rub + (v_stake - v_payout_capped),
        updated_at         = NOW();
  END IF;

  -- Player daily stats + guild PnL
  v_pnl := v_payout_capped - v_stake;

  INSERT INTO user_daily_stats (user_id, date, pnl, games, wins)
    VALUES (
      v_user_id, CURRENT_DATE, v_pnl, 1,
      CASE WHEN v_payout_capped > v_stake THEN 1 ELSE 0 END
    )
    ON CONFLICT (user_id, date)
    DO UPDATE SET
      pnl = user_daily_stats.pnl + v_pnl,
      games = user_daily_stats.games + 1,
      wins = user_daily_stats.wins + CASE WHEN v_payout_capped > v_stake THEN 1 ELSE 0 END;

  PERFORM update_guild_pnl_after_duel(v_user_id, v_pnl);

  SELECT balance INTO v_balance_new FROM users WHERE id = v_user_id;

  RETURN jsonb_build_object(
    'ok', true,
    'balance', v_balance_new,
    'payout', v_payout_capped,
    'pnl', v_pnl,
    'forced_fall', v_forced
  );

EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'rpc:finish_slot_round', SQLERRM,
    jsonb_build_object('round_id', p_round_id, 'outcome', p_outcome, 'payout', p_payout_rub));
  RETURN jsonb_build_object('error', SQLERRM);
END;
$$;


-- ╔═══════════════════════════════════════════╗
-- ║  6. Admin RPCs                            ║
-- ╚═══════════════════════════════════════════╝

CREATE OR REPLACE FUNCTION admin_get_slot_stats()
RETURNS TABLE(
  slot_id                TEXT,
  total_games            BIGINT,
  total_wagered_rub      BIGINT,
  total_paid_rub         BIGINT,
  current_pnl_rub        BIGINT,
  current_rtp            NUMERIC,
  target_rtp             NUMERIC,
  max_house_deficit_rub  INTEGER,
  enabled                BOOLEAN,
  updated_at             TIMESTAMPTZ,
  active_rounds          INTEGER,
  rounds_today           INTEGER,
  pnl_today              BIGINT
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    s.slot_id,
    s.total_games,
    s.total_wagered_rub,
    s.total_paid_rub,
    s.current_pnl_rub,
    CASE WHEN s.total_wagered_rub > 0
         THEN ROUND(s.total_paid_rub::NUMERIC / s.total_wagered_rub, 4)
         ELSE 0
    END AS current_rtp,
    s.target_rtp,
    s.max_house_deficit_rub,
    s.enabled,
    s.updated_at,
    (SELECT COUNT(*)::INTEGER FROM slot_rounds r
       WHERE r.slot_id = s.slot_id AND r.outcome = 'pending') AS active_rounds,
    (SELECT COUNT(*)::INTEGER FROM slot_rounds r
       WHERE r.slot_id = s.slot_id
         AND r.created_at >= CURRENT_DATE) AS rounds_today,
    (SELECT COALESCE(SUM(r.stake_rub - r.payout_rub), 0)::BIGINT
       FROM slot_rounds r
       WHERE r.slot_id = s.slot_id
         AND r.outcome <> 'pending'
         AND r.finished_at >= CURRENT_DATE) AS pnl_today
  FROM slot_stats s
  ORDER BY s.slot_id;
END;
$$;

CREATE OR REPLACE FUNCTION admin_update_slot_settings(
  p_slot_id      TEXT,
  p_target_rtp   NUMERIC DEFAULT NULL,
  p_max_deficit  INTEGER DEFAULT NULL,
  p_enabled      BOOLEAN DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_target_rtp IS NOT NULL AND (p_target_rtp <= 0 OR p_target_rtp > 1.5) THEN
    RETURN jsonb_build_object('error', 'invalid_target_rtp');
  END IF;
  IF p_max_deficit IS NOT NULL AND p_max_deficit < 0 THEN
    RETURN jsonb_build_object('error', 'invalid_max_deficit');
  END IF;

  UPDATE slot_stats
     SET target_rtp           = COALESCE(p_target_rtp, target_rtp),
         max_house_deficit_rub = COALESCE(p_max_deficit, max_house_deficit_rub),
         enabled              = COALESCE(p_enabled, enabled),
         updated_at           = NOW()
   WHERE slot_id = p_slot_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'slot_not_found');
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$;


-- ╔═══════════════════════════════════════════╗
-- ║  7. Grants + cache reload                 ║
-- ╚═══════════════════════════════════════════╝

GRANT EXECUTE ON FUNCTION generate_slot_fall_level(NUMERIC) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION start_slot_round(UUID, TEXT, INTEGER) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION finish_slot_round(UUID, TEXT, INTEGER, INTEGER, NUMERIC) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION admin_get_slot_stats() TO authenticated, anon;
GRANT EXECUTE ON FUNCTION admin_update_slot_settings(TEXT, NUMERIC, INTEGER, BOOLEAN) TO authenticated, anon;

NOTIFY pgrst, 'reload schema';

-- ╔═══════════════════════════════════════════╗
-- ║  DONE!                                    ║
-- ╚═══════════════════════════════════════════╝
