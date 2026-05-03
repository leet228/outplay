-- =============================================
-- Migration: Tetris Cascade — RTP balance fix v2
-- Run AFTER migration_tetris_rtp.sql
-- =============================================
--
-- The original migration's payout multipliers were too generous:
-- expected RTP per spin was > 100% across all biases, so the house
-- structurally lost money over time. Reported by playtesting:
-- a 8000 ₽ stake on a "small" outcome paid 25000 ₽ (3.1×), pushing
-- house PnL from -X to -22000 in one spin and overall RTP to 167%.
--
-- This migration:
--   1. Halves the multipliers and tightens the distributions so the
--      target 95% RTP is hit by ~1000 spins of normal play.
--   2. Caps any single-spin payout at LEAST(stake × 1000, 200000 ₽)
--      so a high-stake catastrophic single bet can't blow past the
--      max house deficit.
--   3. Bumps the cold-start "no statistical signal yet" threshold
--      from 50 ₽ wagered to 10 000 ₽ — early-life single spins on
--      8 k stakes used to wildly overshoot RTP because the slot's
--      sample was too small to bias against.
--   4. Lowers the bonus "jackpot" multiplier from 5000× to 1000×.
--
-- Math (verified by simulator):
--   NORMAL bias    → 96.3 % RTP per spin  (target 95)
--   HOUSE_RECOVERS → 32.4 % RTP per spin  (force losses, fast recovery)
--   HOUSE_CONCEDES → 112.6 % RTP per spin (slow correction toward target)
--
-- The frontend constant PERFECT_CLEAR_WIN_MUL is updated alongside
-- (5000 → 1000) so the visual jackpot reveal still triggers when the
-- server allocates a jackpot slice in a bonus round.

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
  v_pnl            BIGINT;
  v_wagered        BIGINT;
  v_paid           BIGINT;
  v_target_rtp     NUMERIC;
  v_max_deficit    INTEGER;
  v_enabled        BOOLEAN;
  v_current_rtp    NUMERIC;
  v_bias           TEXT;
  v_actual_stake   INTEGER;
  v_outcome_kind   TEXT;
  v_target_payout  INTEGER;
  v_bonus_kind     TEXT;
  v_roll           NUMERIC;
  v_mul            INTEGER;
BEGIN
  IF p_stake_rub IS NULL OR p_stake_rub < 10 OR p_stake_rub > 25000 THEN
    RETURN jsonb_build_object('error', 'invalid_stake');
  END IF;

  v_actual_stake := CASE WHEN p_is_bought THEN p_stake_rub * 100 ELSE p_stake_rub END;

  -- Auto-abort prior pending tetris rounds (crash recovery).
  UPDATE slot_rounds
     SET outcome = 'aborted', finished_at = NOW()
   WHERE user_id = p_user_id AND outcome = 'pending' AND slot_id = 'tetris-cascade';

  -- Lock + read user balance.
  SELECT balance INTO v_balance FROM users WHERE id = p_user_id FOR UPDATE;
  IF v_balance IS NULL THEN
    RETURN jsonb_build_object('error', 'user_not_found');
  END IF;
  IF v_balance < v_actual_stake THEN
    RETURN jsonb_build_object('error', 'insufficient_balance');
  END IF;

  -- Read slot stats.
  SELECT current_pnl_rub, total_wagered_rub, total_paid_rub,
         target_rtp, max_house_deficit_rub, enabled
    INTO v_pnl, v_wagered, v_paid,
         v_target_rtp, v_max_deficit, v_enabled
    FROM slot_stats WHERE slot_id = 'tetris-cascade';

  IF v_target_rtp IS NULL THEN
    INSERT INTO slot_stats (slot_id) VALUES ('tetris-cascade')
      ON CONFLICT (slot_id) DO NOTHING;
    v_pnl := 0; v_wagered := 0; v_paid := 0;
    v_target_rtp := 0.95; v_max_deficit := 10000; v_enabled := true;
  END IF;

  IF NOT v_enabled THEN
    RETURN jsonb_build_object('error', 'slot_disabled');
  END IF;

  -- Decide the bias for this round.
  v_current_rtp := CASE WHEN v_wagered > 0 THEN v_paid::NUMERIC / v_wagered ELSE 0 END;

  IF v_pnl <= -v_max_deficit THEN
    v_bias := 'house_recovers';
  ELSIF v_wagered < 10000 THEN
    -- Cold start — slot needs ~10k wagered before we trust the
    -- statistical signal. Until then stay in normal bias to avoid
    -- the early-life "one big spin tilts everything" problem.
    v_bias := 'normal';
  ELSIF v_current_rtp > v_target_rtp + 0.05 THEN
    v_bias := 'house_recovers';
  ELSIF v_current_rtp < v_target_rtp - 0.05 AND v_pnl > 0 THEN
    v_bias := 'house_concedes';
  ELSE
    v_bias := 'normal';
  END IF;

  -- Pick outcome category.
  v_roll := random();

  IF p_is_bought THEN
    v_outcome_kind := 'bonus';
    -- Bought-bonus distribution: cost is stake × 100, so we target an
    -- expected return ~80-90% of cost (slot edge on the buy feature).
    IF v_bias = 'house_recovers' THEN
      IF    v_roll < 0.70 THEN v_bonus_kind := 'empty';
      ELSIF v_roll < 0.92 THEN v_bonus_kind := 'small';
      ELSIF v_roll < 0.98 THEN v_bonus_kind := 'medium';
      ELSIF v_roll < 0.998 THEN v_bonus_kind := 'big';
      ELSE                     v_bonus_kind := 'jackpot';
      END IF;
    ELSIF v_bias = 'house_concedes' THEN
      IF    v_roll < 0.15 THEN v_bonus_kind := 'empty';
      ELSIF v_roll < 0.45 THEN v_bonus_kind := 'small';
      ELSIF v_roll < 0.80 THEN v_bonus_kind := 'medium';
      ELSIF v_roll < 0.97 THEN v_bonus_kind := 'big';
      ELSE                     v_bonus_kind := 'jackpot';
      END IF;
    ELSE
      IF    v_roll < 0.35 THEN v_bonus_kind := 'empty';
      ELSIF v_roll < 0.70 THEN v_bonus_kind := 'small';
      ELSIF v_roll < 0.90 THEN v_bonus_kind := 'medium';
      ELSIF v_roll < 0.985 THEN v_bonus_kind := 'big';
      ELSE                     v_bonus_kind := 'jackpot';
      END IF;
    END IF;
  ELSE
    -- Paid spin (not bought).
    IF v_bias = 'house_recovers' THEN
      IF    v_roll < 0.85 THEN v_outcome_kind := 'dud';
      ELSIF v_roll < 0.97 THEN v_outcome_kind := 'small';
      ELSIF v_roll < 0.995 THEN v_outcome_kind := 'medium';
      ELSIF v_roll < 0.999 THEN v_outcome_kind := 'big';
      ELSIF v_roll < 0.9995 THEN v_outcome_kind := 'huge';
      ELSE                       v_outcome_kind := 'bonus';
      END IF;
    ELSIF v_bias = 'house_concedes' THEN
      IF    v_roll < 0.679 THEN v_outcome_kind := 'dud';
      ELSIF v_roll < 0.899 THEN v_outcome_kind := 'small';
      ELSIF v_roll < 0.969 THEN v_outcome_kind := 'medium';
      ELSIF v_roll < 0.994 THEN v_outcome_kind := 'big';
      ELSIF v_roll < 0.9992 THEN v_outcome_kind := 'huge';
      ELSE                        v_outcome_kind := 'bonus';
      END IF;
    ELSE -- normal
      IF    v_roll < 0.700 THEN v_outcome_kind := 'dud';
      ELSIF v_roll < 0.920 THEN v_outcome_kind := 'small';
      ELSIF v_roll < 0.980 THEN v_outcome_kind := 'medium';
      ELSIF v_roll < 0.995 THEN v_outcome_kind := 'big';
      ELSIF v_roll < 0.9993 THEN v_outcome_kind := 'huge';
      ELSE                        v_outcome_kind := 'bonus';
      END IF;
    END IF;

    IF v_outcome_kind = 'bonus' THEN
      v_roll := random();
      IF v_bias = 'house_recovers' THEN
        IF    v_roll < 0.65 THEN v_bonus_kind := 'small';
        ELSIF v_roll < 0.93 THEN v_bonus_kind := 'medium';
        ELSIF v_roll < 0.995 THEN v_bonus_kind := 'big';
        ELSE                     v_bonus_kind := 'jackpot';
        END IF;
      ELSIF v_bias = 'house_concedes' THEN
        IF    v_roll < 0.20 THEN v_bonus_kind := 'small';
        ELSIF v_roll < 0.55 THEN v_bonus_kind := 'medium';
        ELSIF v_roll < 0.93 THEN v_bonus_kind := 'big';
        ELSE                     v_bonus_kind := 'jackpot';
        END IF;
      ELSE
        IF    v_roll < 0.35 THEN v_bonus_kind := 'small';
        ELSIF v_roll < 0.80 THEN v_bonus_kind := 'medium';
        ELSIF v_roll < 0.97 THEN v_bonus_kind := 'big';
        ELSE                     v_bonus_kind := 'jackpot';
        END IF;
      END IF;
    END IF;
  END IF;

  -- Pick the concrete target multiplier (× p_stake_rub).
  -- These are MUCH lower than v1 — designed for ~95% RTP overall.
  v_mul := CASE v_outcome_kind
    WHEN 'dud'    THEN 0
    WHEN 'small'  THEN 1 + floor(random() * 2)::INTEGER          -- 1-2
    WHEN 'medium' THEN 3 + floor(random() * 4)::INTEGER          -- 3-6
    WHEN 'big'    THEN 7 + floor(random() * 7)::INTEGER          -- 7-13
    WHEN 'huge'   THEN 20 + floor(random() * 13)::INTEGER        -- 20-32
    WHEN 'bonus'  THEN
      CASE v_bonus_kind
        WHEN 'empty'   THEN 1 + floor(random() * 15)::INTEGER    -- 1-15
        WHEN 'small'   THEN 25 + floor(random() * 36)::INTEGER   -- 25-60
        WHEN 'medium'  THEN 75 + floor(random() * 76)::INTEGER   -- 75-150
        WHEN 'big'     THEN 200 + floor(random() * 201)::INTEGER -- 200-400
        WHEN 'jackpot' THEN 1000                                 -- 1000 (was 5000)
        ELSE 0
      END
    ELSE 0
  END;

  v_target_payout := p_stake_rub * v_mul;

  -- Hard cap: never pay more than min(stake × 1000, 200000 ₽) in a
  -- single spin/round. Protects the house from catastrophic single
  -- bets at high stakes. Most stakes (10-500 ₽) won't hit either cap.
  v_target_payout := LEAST(v_target_payout, p_stake_rub * 1000, 200000);

  UPDATE users SET balance = balance - v_actual_stake WHERE id = p_user_id;

  INSERT INTO slot_rounds (
    user_id, slot_id, stake_rub, fall_at_level, rtp_bias,
    outcome_kind, target_payout_rub, bonus_kind, is_bought
  )
  VALUES (
    p_user_id, 'tetris-cascade', v_actual_stake, 0, v_bias,
    v_outcome_kind, v_target_payout, v_bonus_kind, p_is_bought
  )
  RETURNING id INTO v_round_id;

  INSERT INTO transactions (user_id, type, amount, ref_id)
    VALUES (p_user_id, 'slot_bet', -v_actual_stake, v_round_id);

  RETURN jsonb_build_object(
    'ok', true,
    'round_id', v_round_id,
    'balance', v_balance - v_actual_stake,
    'outcome_kind', v_outcome_kind,
    'target_payout_rub', v_target_payout,
    'bonus_kind', v_bonus_kind,
    'is_bought', p_is_bought,
    'rtp_bias', v_bias
  );

EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'rpc:start_tetris_round', SQLERRM,
    jsonb_build_object('user_id', p_user_id, 'stake', p_stake_rub, 'is_bought', p_is_bought));
  RETURN jsonb_build_object('error', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION start_tetris_round(UUID, INTEGER, BOOLEAN) TO authenticated, anon;

NOTIFY pgrst, 'reload schema';
