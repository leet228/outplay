-- =============================================
-- Tetris Cascade — RTP v4 (deficit breaker + buy-bonus tuning)
-- Run AFTER migration_tetris_rtp_v3.sql
-- =============================================
--
-- Adds two safeguards on top of v3:
--
-- 1. **Deficit circuit breaker**. When the house pnl on this slot
--    falls below `slot_stats.max_house_deficit_rub`, every roll is
--    forced to the loss path until pnl claws back above the floor.
--      regular spin → forced dud (mul 0)
--      buy bonus    → forced floor of the smallest tier (mul 25-30,
--                     against a 100× cost ⇒ deep loss every time)
--
-- 2. **Separate buy-bonus distribution** that targets ~80 % RTP on
--    the buy feature (intentional house edge — buying a bonus is
--    convenience, not a math bargain).
--
-- Verified by scripts/tetris-rtp-sim.js:
--    Regular RTP @ 1M spins      ≈ 95.0 %
--    Buy-bonus RTP @ 100k buys   ≈ 81.1 %  (E = 81.05 %)
--    Breaker recovery from −15 k ₽ deficit:
--      after 1k spins:  pnl  −14 000 ₽ (still recovering)
--      after 10k spins: pnl   −9 387 ₽ (breaker stopped at floor)
--      after 100k:      pnl   −2 739 ₽ (normal play resumed)
--
-- Intentional design: with a 95 % RTP, the house is in the black on
-- average, so the breaker is a SAFETY NET, not an active throttle —
-- it fires only when a streak of lucky players pushes the slot past
-- the configured floor. Most of the time it does nothing.

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
  v_pnl            BIGINT;
  v_max_deficit    INTEGER;
  v_force_loss     BOOLEAN;
  v_bias_label     TEXT;
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

  -- ── Read deficit state for the circuit breaker ───────────────
  SELECT current_pnl_rub, max_house_deficit_rub
    INTO v_pnl, v_max_deficit
    FROM slot_stats WHERE slot_id = 'tetris-cascade';

  v_force_loss := COALESCE(v_pnl, 0) <= -COALESCE(v_max_deficit, 10000);
  v_bias_label := CASE WHEN v_force_loss THEN 'house_recovers' ELSE 'normal' END;

  -- ── Pick outcome ─────────────────────────────────────────────
  v_roll := random();

  IF p_is_bought THEN
    v_outcome_kind := 'bonus';

    IF v_force_loss THEN
      -- Forced loss on a bought bonus: smallest tier, lowest end.
      v_bonus_kind := 'small';
      v_mul        := 25 + floor(random() * 6)::INTEGER;   -- 25-30
    ELSE
      -- Buy-bonus distribution: weighted to ~80 % RTP on buy.
      IF    v_roll < 0.70 THEN v_bonus_kind := 'small';      -- 25-60
      ELSIF v_roll < 0.93 THEN v_bonus_kind := 'medium';     -- 70-150
      ELSIF v_roll < 0.99 THEN v_bonus_kind := 'big';        -- 200-400
      ELSE                     v_bonus_kind := 'jackpot';    -- 800
      END IF;

      v_mul := CASE v_bonus_kind
        WHEN 'small'   THEN 25  + floor(random() * 36 )::INTEGER
        WHEN 'medium'  THEN 70  + floor(random() * 81 )::INTEGER
        WHEN 'big'     THEN 200 + floor(random() * 201)::INTEGER
        WHEN 'jackpot' THEN 800
        ELSE 0
      END;
    END IF;

  ELSE
    -- Regular paid spin.
    IF v_force_loss THEN
      v_outcome_kind := 'dud';
      v_mul          := 0;
    ELSE
      IF    v_roll < 0.746                                   THEN v_outcome_kind := 'dud';
      ELSIF v_roll < 0.746 + 0.180                           THEN v_outcome_kind := 'small';
      ELSIF v_roll < 0.746 + 0.180 + 0.050                   THEN v_outcome_kind := 'medium';
      ELSIF v_roll < 0.746 + 0.180 + 0.050 + 0.015           THEN v_outcome_kind := 'big';
      ELSIF v_roll < 0.746 + 0.180 + 0.050 + 0.015 + 0.008   THEN v_outcome_kind := 'huge';
      ELSE                                                       v_outcome_kind := 'bonus';
      END IF;

      IF v_outcome_kind = 'bonus' THEN
        v_roll := random();
        IF    v_roll < 0.55 THEN v_bonus_kind := 'small';
        ELSIF v_roll < 0.83 THEN v_bonus_kind := 'medium';
        ELSIF v_roll < 0.97 THEN v_bonus_kind := 'big';
        ELSE                     v_bonus_kind := 'jackpot';
        END IF;
      END IF;

      v_mul := CASE v_outcome_kind
        WHEN 'dud'    THEN 0
        WHEN 'small'  THEN 1  + floor(random() * 2 )::INTEGER
        WHEN 'medium' THEN 3  + floor(random() * 4 )::INTEGER
        WHEN 'big'    THEN 7  + floor(random() * 7 )::INTEGER
        WHEN 'huge'   THEN 18 + floor(random() * 12)::INTEGER
        WHEN 'bonus'  THEN
          CASE v_bonus_kind
            WHEN 'small'   THEN 25  + floor(random() * 36 )::INTEGER
            WHEN 'medium'  THEN 70  + floor(random() * 81 )::INTEGER
            WHEN 'big'     THEN 200 + floor(random() * 201)::INTEGER
            WHEN 'jackpot' THEN 800
            ELSE 0
          END
        ELSE 0
      END;
    END IF;
  END IF;

  v_target_payout := p_stake_rub * v_mul;

  -- Hard cap: stake × 1000 OR 200 000 ₽, whichever is smaller.
  v_target_payout := LEAST(v_target_payout, p_stake_rub * 1000, 200000);

  UPDATE users SET balance = balance - v_actual_stake WHERE id = p_user_id;

  INSERT INTO slot_rounds (
    user_id, slot_id, stake_rub, fall_at_level, rtp_bias,
    outcome_kind, target_payout_rub, bonus_kind, is_bought
  )
  VALUES (
    p_user_id, 'tetris-cascade', v_actual_stake, 0, v_bias_label,
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
    'rtp_bias', v_bias_label
  );

EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'rpc:start_tetris_round', SQLERRM,
    jsonb_build_object('user_id', p_user_id, 'stake', p_stake_rub, 'is_bought', p_is_bought));
  RETURN jsonb_build_object('error', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION start_tetris_round(UUID, INTEGER, BOOLEAN) TO authenticated, anon;

NOTIFY pgrst, 'reload schema';
