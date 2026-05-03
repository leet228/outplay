-- =============================================
-- Migration: Tetris Cascade — RTP-controlled outcomes
-- Run AFTER migration_slot_rtp.sql
-- =============================================
-- The Tetris Cascade slot uses the same slot_stats/slot_rounds plumbing
-- as Tower Stack, but its outcome model is different. Tower Stack only
-- needs a "fall_at_level" decision; Tetris needs a category + concrete
-- target payout that the frontend then animates a spin around.
--
-- Outcomes (paid spins):
--   dud    → no clears, payout = 0
--   small  → 1-3× stake
--   medium → 5-14× stake
--   big    → 20-39× stake
--   huge   → 50-99× stake
--   bonus  → triggers the 10-spin free-spin round; bonus_kind decides size
--
-- Bonus kinds:
--   empty  → 1-30× stake total
--   small  → 50-150× stake total
--   medium → 200-500× stake total
--   big    → 500-2000× stake total
--   jackpot→ 5000× stake (Perfect Clear)
--
-- A bought bonus (the "Купить бонус" button) deducts stake × 100 up
-- front and ALWAYS returns a bonus, but the size still follows RTP —
-- when the house is recovering, "empty" bonuses become more likely so
-- the buy-in actually pays back less than the cost. That's by design.

-- ╔═══════════════════════════════════════════╗
-- ║  1. Seed Tetris in slot_stats             ║
-- ╚═══════════════════════════════════════════╝

INSERT INTO slot_stats (slot_id, target_rtp, max_house_deficit_rub)
  VALUES ('tetris-cascade', 0.95, 10000)
  ON CONFLICT (slot_id) DO NOTHING;


-- ╔═══════════════════════════════════════════╗
-- ║  2. Tetris-specific columns on slot_rounds ║
-- ╚═══════════════════════════════════════════╝

ALTER TABLE slot_rounds ADD COLUMN IF NOT EXISTS outcome_kind      TEXT;
ALTER TABLE slot_rounds ADD COLUMN IF NOT EXISTS target_payout_rub INTEGER;
ALTER TABLE slot_rounds ADD COLUMN IF NOT EXISTS bonus_kind        TEXT;
ALTER TABLE slot_rounds ADD COLUMN IF NOT EXISTS is_bought         BOOLEAN NOT NULL DEFAULT false;


-- ╔═══════════════════════════════════════════╗
-- ║  3. start_tetris_round                    ║
-- ╚═══════════════════════════════════════════╝
-- The server picks the outcome category and the exact target payout
-- before the player ever sees a piece drop. The frontend just animates
-- around the target.

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

  -- A bought bonus deducts stake × 100 up front; a regular spin just stake.
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

  -- Read slot stats (no lock; advisory for bias).
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
  ELSIF v_wagered < 50 THEN
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
    -- Bought bonus always returns a bonus; size follows bias.
    v_outcome_kind := 'bonus';
    IF v_bias = 'house_recovers' THEN
      IF    v_roll < 0.50 THEN v_bonus_kind := 'empty';
      ELSIF v_roll < 0.85 THEN v_bonus_kind := 'small';
      ELSIF v_roll < 0.97 THEN v_bonus_kind := 'medium';
      ELSE                     v_bonus_kind := 'big';
      END IF;
    ELSIF v_bias = 'house_concedes' THEN
      IF    v_roll < 0.10 THEN v_bonus_kind := 'small';
      ELSIF v_roll < 0.40 THEN v_bonus_kind := 'medium';
      ELSIF v_roll < 0.85 THEN v_bonus_kind := 'big';
      ELSE                     v_bonus_kind := 'jackpot';
      END IF;
    ELSE
      IF    v_roll < 0.20 THEN v_bonus_kind := 'empty';
      ELSIF v_roll < 0.55 THEN v_bonus_kind := 'small';
      ELSIF v_roll < 0.85 THEN v_bonus_kind := 'medium';
      ELSIF v_roll < 0.985 THEN v_bonus_kind := 'big';
      ELSE                     v_bonus_kind := 'jackpot';
      END IF;
    END IF;
  ELSE
    IF v_bias = 'house_recovers' THEN
      IF    v_roll < 0.70 THEN v_outcome_kind := 'dud';
      ELSIF v_roll < 0.92 THEN v_outcome_kind := 'small';
      ELSIF v_roll < 0.99 THEN v_outcome_kind := 'medium';
      ELSE                     v_outcome_kind := 'big';
      END IF;
    ELSIF v_bias = 'house_concedes' THEN
      IF    v_roll < 0.30 THEN v_outcome_kind := 'dud';
      ELSIF v_roll < 0.55 THEN v_outcome_kind := 'small';
      ELSIF v_roll < 0.80 THEN v_outcome_kind := 'medium';
      ELSIF v_roll < 0.94 THEN v_outcome_kind := 'big';
      ELSIF v_roll < 0.985 THEN v_outcome_kind := 'huge';
      ELSE                     v_outcome_kind := 'bonus';
      END IF;
    ELSE
      IF    v_roll < 0.55 THEN v_outcome_kind := 'dud';
      ELSIF v_roll < 0.80 THEN v_outcome_kind := 'small';
      ELSIF v_roll < 0.93 THEN v_outcome_kind := 'medium';
      ELSIF v_roll < 0.985 THEN v_outcome_kind := 'big';
      ELSIF v_roll < 0.997 THEN v_outcome_kind := 'huge';
      ELSE                     v_outcome_kind := 'bonus';
      END IF;
    END IF;

    IF v_outcome_kind = 'bonus' THEN
      v_roll := random();
      IF    v_roll < 0.30 THEN v_bonus_kind := 'small';
      ELSIF v_roll < 0.75 THEN v_bonus_kind := 'medium';
      ELSIF v_roll < 0.95 THEN v_bonus_kind := 'big';
      ELSE                     v_bonus_kind := 'jackpot';
      END IF;
    END IF;
  END IF;

  -- Pick the concrete target multiplier (× p_stake_rub).
  v_mul := CASE v_outcome_kind
    WHEN 'dud'    THEN 0
    WHEN 'small'  THEN floor(random() * 3 + 1)::INTEGER
    WHEN 'medium' THEN floor(random() * 10 + 5)::INTEGER
    WHEN 'big'    THEN floor(random() * 20 + 20)::INTEGER
    WHEN 'huge'   THEN floor(random() * 50 + 50)::INTEGER
    WHEN 'bonus'  THEN
      CASE v_bonus_kind
        WHEN 'empty'   THEN floor(random() * 30 + 1)::INTEGER
        WHEN 'small'   THEN floor(random() * 100 + 50)::INTEGER
        WHEN 'medium'  THEN floor(random() * 300 + 200)::INTEGER
        WHEN 'big'     THEN floor(random() * 1500 + 500)::INTEGER
        WHEN 'jackpot' THEN 5000
        ELSE 0
      END
    ELSE 0
  END;

  v_target_payout := p_stake_rub * v_mul;

  -- Deduct.
  UPDATE users SET balance = balance - v_actual_stake WHERE id = p_user_id;

  -- Create the round.
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


-- ╔═══════════════════════════════════════════╗
-- ║  4. finish_tetris_round                   ║
-- ╚═══════════════════════════════════════════╝
-- Server clamps the payout to the pre-decided target — clients can't
-- claim more. Any value the client sends gets capped at target_payout_rub.

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
  v_stake          INTEGER;
  v_outcome_now    TEXT;
  v_target_payout  INTEGER;
  v_payout_to_pay  INTEGER;
  v_balance_new    INTEGER;
  v_pnl            INTEGER;
BEGIN
  IF p_payout_rub IS NULL OR p_payout_rub < 0 THEN p_payout_rub := 0; END IF;

  SELECT user_id, stake_rub, outcome, target_payout_rub
    INTO v_user_id, v_stake, v_outcome_now, v_target_payout
    FROM slot_rounds WHERE id = p_round_id FOR UPDATE;

  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'round_not_found');
  END IF;
  IF v_outcome_now <> 'pending' THEN
    SELECT balance INTO v_balance_new FROM users WHERE id = v_user_id;
    RETURN jsonb_build_object('error', 'already_finished', 'balance', v_balance_new);
  END IF;

  -- Clamp at the pre-decided target. The client may overshoot due to
  -- visual jitter, undershoot if the player exited mid-round, etc.
  v_payout_to_pay := LEAST(COALESCE(p_payout_rub, 0), COALESCE(v_target_payout, 0));

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

  -- Stats update — atomic upsert on the global slot_stats row.
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
    'pnl', v_pnl
  );

EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'rpc:finish_tetris_round', SQLERRM,
    jsonb_build_object('round_id', p_round_id, 'payout', p_payout_rub));
  RETURN jsonb_build_object('error', SQLERRM);
END;
$$;


-- ╔═══════════════════════════════════════════╗
-- ║  5. Grants + cache reload                 ║
-- ╚═══════════════════════════════════════════╝

GRANT EXECUTE ON FUNCTION start_tetris_round(UUID, INTEGER, BOOLEAN) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION finish_tetris_round(UUID, INTEGER)         TO authenticated, anon;

NOTIFY pgrst, 'reload schema';

-- ╔═══════════════════════════════════════════╗
-- ║  DONE!                                    ║
-- ╚═══════════════════════════════════════════╝
