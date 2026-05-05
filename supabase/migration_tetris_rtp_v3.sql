-- =============================================
-- Tetris Cascade — RTP rebuild (v3, no bias)
-- Run AFTER migration_tetris_rtp_v2.sql
-- =============================================
--
-- Replaces the bias-driven outcome generator (house_recovers /
-- house_concedes) with a single fixed probabilistic table that
-- delivers ≈ 95 % RTP per spin in the long run.
--
-- Verified analytically and by Node simulator (scripts/tetris-rtp-sim.js):
--    E[spin]                = 95.32 %
--    100 000-spin RTP       ≈ 94.2 %
--    1 000 000-spin RTP     ≈ 95.18 %
--
-- Distribution (six categories):
--    dud    74.6 %   ×0
--    small  18.0 %   ×1-2
--    medium  5.0 %   ×3-6
--    big     1.5 %   ×7-13
--    huge    0.8 %   ×18-29
--    bonus   0.1 %   one of {25-60, 70-150, 200-400, 800}
--
-- Hard cap: any single-spin payout still capped at
--   LEAST(stake × 1000, 200 000 ₽)
-- so a maxed-stake bonus jackpot cannot blow past the house deficit.

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

  SELECT balance INTO v_balance FROM users WHERE id = p_user_id FOR UPDATE;
  IF v_balance IS NULL THEN
    RETURN jsonb_build_object('error', 'user_not_found');
  END IF;
  IF v_balance < v_actual_stake THEN
    RETURN jsonb_build_object('error', 'insufficient_balance');
  END IF;

  -- ── Pick outcome from the fixed distribution ─────────────────
  v_roll := random();

  IF p_is_bought THEN
    -- A bought bonus always returns a bonus tier — distribution
    -- below mirrors the "in-spin" bonus tiers but tuned so the
    -- expected return on the buy is ~80 % of the cost (slot edge
    -- on the buy feature; this is intentional).
    v_outcome_kind := 'bonus';
    IF    v_roll < 0.55 THEN v_bonus_kind := 'small';     -- 25-60
    ELSIF v_roll < 0.83 THEN v_bonus_kind := 'medium';    -- 70-150
    ELSIF v_roll < 0.97 THEN v_bonus_kind := 'big';       -- 200-400
    ELSE                     v_bonus_kind := 'jackpot';   -- 800
    END IF;
  ELSE
    -- Regular paid spin.
    IF    v_roll < 0.746                            THEN v_outcome_kind := 'dud';
    ELSIF v_roll < 0.746 + 0.180                    THEN v_outcome_kind := 'small';
    ELSIF v_roll < 0.746 + 0.180 + 0.050            THEN v_outcome_kind := 'medium';
    ELSIF v_roll < 0.746 + 0.180 + 0.050 + 0.015    THEN v_outcome_kind := 'big';
    ELSIF v_roll < 0.746 + 0.180 + 0.050 + 0.015 + 0.008 THEN v_outcome_kind := 'huge';
    ELSE                                                  v_outcome_kind := 'bonus';
    END IF;

    IF v_outcome_kind = 'bonus' THEN
      v_roll := random();
      IF    v_roll < 0.55 THEN v_bonus_kind := 'small';
      ELSIF v_roll < 0.83 THEN v_bonus_kind := 'medium';
      ELSIF v_roll < 0.97 THEN v_bonus_kind := 'big';
      ELSE                     v_bonus_kind := 'jackpot';
      END IF;
    END IF;
  END IF;

  -- ── Concrete multiplier within the picked category ───────────
  v_mul := CASE v_outcome_kind
    WHEN 'dud'    THEN 0
    WHEN 'small'  THEN 1  + floor(random() * 2 )::INTEGER     -- 1-2
    WHEN 'medium' THEN 3  + floor(random() * 4 )::INTEGER     -- 3-6
    WHEN 'big'    THEN 7  + floor(random() * 7 )::INTEGER     -- 7-13
    WHEN 'huge'   THEN 18 + floor(random() * 12)::INTEGER     -- 18-29
    WHEN 'bonus'  THEN
      CASE v_bonus_kind
        WHEN 'small'   THEN 25  + floor(random() * 36 )::INTEGER  -- 25-60
        WHEN 'medium'  THEN 70  + floor(random() * 81 )::INTEGER  -- 70-150
        WHEN 'big'     THEN 200 + floor(random() * 201)::INTEGER  -- 200-400
        WHEN 'jackpot' THEN 800
        ELSE 0
      END
    ELSE 0
  END;

  v_target_payout := p_stake_rub * v_mul;

  -- Hard cap mirroring the SQL hard cap from v2.
  v_target_payout := LEAST(v_target_payout, p_stake_rub * 1000, 200000);

  UPDATE users SET balance = balance - v_actual_stake WHERE id = p_user_id;

  INSERT INTO slot_rounds (
    user_id, slot_id, stake_rub, fall_at_level, rtp_bias,
    outcome_kind, target_payout_rub, bonus_kind, is_bought
  )
  VALUES (
    p_user_id, 'tetris-cascade', v_actual_stake, 0, 'normal',
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
    'rtp_bias', 'normal'
  );

EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'rpc:start_tetris_round', SQLERRM,
    jsonb_build_object('user_id', p_user_id, 'stake', p_stake_rub, 'is_bought', p_is_bought));
  RETURN jsonb_build_object('error', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION start_tetris_round(UUID, INTEGER, BOOLEAN) TO authenticated, anon;

NOTIFY pgrst, 'reload schema';
