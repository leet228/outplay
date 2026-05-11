-- =============================================
-- Dice — classic above/below threshold game
-- Run AFTER migration_pixel_mine.sql
-- =============================================
--
-- Two RPCs power the production flow:
--
--   start_dice_round  — atomic stake debit, opens a round.
--                       Auto-aborts any prior pending dice round
--                       the player left dangling (crash recovery
--                       so a closed-mid-spin tab doesn't lock the
--                       next roll out).
--
--   finish_dice_round — accepts the client's claimed payout, caps
--                       it at the dice ceiling (stake × 100 000 or
--                       1 000 000 ₽ absolute, whichever is lower)
--                       and applies the deficit circuit breaker if
--                       the slot is past its loss floor. Credits
--                       the user's balance and updates per-user /
--                       per-slot stats.
--
-- The slot is honest-RNG on the client: it samples win/loss from
-- the published chance curve, picks a display value consistent
-- with the outcome, and sends the resulting payout up. Server
-- only enforces the cap.

-- ── 1. Seed slot_stats row for dice if missing ────────────────────
INSERT INTO slot_stats (slot_id, target_rtp, max_house_deficit_rub)
  VALUES ('dice', 0.971, 10000)
  ON CONFLICT (slot_id) DO NOTHING;

-- Older deploys may have created slot_stats with a different RTP —
-- pin it now that the chance curve verifies at 97.1 %.
UPDATE slot_stats SET target_rtp = 0.971 WHERE slot_id = 'dice';


-- ── 2. start_dice_round ──────────────────────────────────────────
DROP FUNCTION IF EXISTS start_dice_round(UUID, INTEGER);

CREATE OR REPLACE FUNCTION start_dice_round(
  p_user_id   UUID,
  p_stake_rub INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance        INTEGER;
  v_round_id       UUID;
  v_pnl            BIGINT;
  v_max_deficit    INTEGER;
  v_enabled        BOOLEAN;
  v_deficit_active BOOLEAN;
  v_bias           TEXT;
BEGIN
  IF p_stake_rub IS NULL OR p_stake_rub < 10 OR p_stake_rub > 25000 THEN
    RETURN jsonb_build_object('error', 'invalid_stake');
  END IF;

  -- Auto-abort prior pending rounds for this slot (crash recovery).
  UPDATE slot_rounds
     SET outcome = 'aborted', finished_at = NOW()
   WHERE user_id = p_user_id AND outcome = 'pending' AND slot_id = 'dice';

  SELECT balance INTO v_balance FROM users WHERE id = p_user_id FOR UPDATE;
  IF v_balance IS NULL THEN
    RETURN jsonb_build_object('error', 'user_not_found');
  END IF;
  IF v_balance < p_stake_rub THEN
    RETURN jsonb_build_object('error', 'insufficient_balance');
  END IF;

  SELECT current_pnl_rub, max_house_deficit_rub, enabled
    INTO v_pnl, v_max_deficit, v_enabled
    FROM slot_stats WHERE slot_id = 'dice';

  IF v_pnl IS NULL THEN
    INSERT INTO slot_stats (slot_id, target_rtp, max_house_deficit_rub)
      VALUES ('dice', 0.971, 10000) ON CONFLICT DO NOTHING;
    v_pnl := 0; v_max_deficit := 10000; v_enabled := true;
  END IF;
  IF NOT v_enabled THEN
    RETURN jsonb_build_object('error', 'slot_disabled');
  END IF;

  v_deficit_active := COALESCE(v_pnl, 0) <= -COALESCE(v_max_deficit, 10000);
  v_bias := CASE WHEN v_deficit_active THEN 'house_recovers' ELSE 'normal' END;

  -- Atomic debit.
  UPDATE users SET balance = balance - p_stake_rub WHERE id = p_user_id;

  INSERT INTO slot_rounds (
    user_id, slot_id, stake_rub, rtp_bias,
    outcome_kind, target_payout_rub, bonus_kind, is_bought
  )
  VALUES (
    p_user_id, 'dice', p_stake_rub, v_bias,
    'open', NULL, NULL, false
  )
  RETURNING id INTO v_round_id;

  INSERT INTO transactions (user_id, type, amount, ref_id)
    VALUES (p_user_id, 'slot_bet', -p_stake_rub, v_round_id);

  RETURN jsonb_build_object(
    'ok', true,
    'round_id', v_round_id,
    'balance', v_balance - p_stake_rub,
    'deficit_active', v_deficit_active
  );

EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'rpc:start_dice_round', SQLERRM,
    jsonb_build_object('user_id', p_user_id, 'stake', p_stake_rub));
  RETURN jsonb_build_object('error', SQLERRM);
END;
$$;


-- ── 3. finish_dice_round ─────────────────────────────────────────
-- Accepts the client's claimed payout. Caps at stake × 100 000 (the
-- top dice multiplier at the extreme thresholds) with an absolute
-- 1 000 000 ₽ ceiling so a runaway client can't drain the house in
-- one round. Applies the deficit circuit breaker.

CREATE OR REPLACE FUNCTION finish_dice_round(
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
  v_payout_to_pay  INTEGER;
  v_balance_new    INTEGER;
  v_pnl            INTEGER;
  v_house_pnl      BIGINT;
  v_max_deficit    INTEGER;
  v_deficit_active BOOLEAN;
  v_hard_cap       INTEGER;
BEGIN
  IF p_payout_rub IS NULL OR p_payout_rub < 0 THEN p_payout_rub := 0; END IF;

  SELECT user_id, stake_rub, outcome
    INTO v_user_id, v_stake, v_outcome_now
    FROM slot_rounds WHERE id = p_round_id FOR UPDATE;

  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'round_not_found');
  END IF;
  IF v_outcome_now <> 'pending' THEN
    SELECT balance INTO v_balance_new FROM users WHERE id = v_user_id;
    RETURN jsonb_build_object('error', 'already_finished', 'balance', v_balance_new);
  END IF;

  -- Hard cap: stake × 100 000 (max dice multiplier) capped by the
  -- absolute 1 000 000 ₽ ceiling. At the minimum stake (10 ₽) the
  -- two pin exactly at 1 000 000 ₽, so the ceiling is the binding
  -- constraint for every higher stake.
  v_hard_cap := LEAST(v_stake * 100000, 1000000);
  v_payout_to_pay := LEAST(p_payout_rub, v_hard_cap);

  -- Deficit circuit breaker — if the slot has bled past its loss
  -- floor, force the round payout down to the user's stake (so
  -- the UI doesn't look broken) until the slot recovers.
  SELECT current_pnl_rub, max_house_deficit_rub
    INTO v_house_pnl, v_max_deficit
    FROM slot_stats WHERE slot_id = 'dice';
  v_deficit_active := COALESCE(v_house_pnl, 0) <= -COALESCE(v_max_deficit, 10000);

  IF v_deficit_active THEN
    v_payout_to_pay := LEAST(v_payout_to_pay, v_stake);
  END IF;

  IF v_payout_to_pay > 0 THEN
    UPDATE users SET balance = balance + v_payout_to_pay WHERE id = v_user_id;
    INSERT INTO transactions (user_id, type, amount, ref_id)
      VALUES (v_user_id, 'slot_win', v_payout_to_pay, p_round_id);
  END IF;

  UPDATE slot_rounds
     SET outcome     = CASE WHEN v_payout_to_pay > 0 THEN 'cashed' ELSE 'fallen' END,
         payout_rub  = v_payout_to_pay,
         multiplier  = CASE WHEN v_stake > 0
                            THEN ROUND(v_payout_to_pay::NUMERIC / v_stake, 4)
                            ELSE 0 END,
         finished_at = NOW()
   WHERE id = p_round_id;

  INSERT INTO slot_stats (slot_id, total_games, total_wagered_rub, total_paid_rub, current_pnl_rub)
    VALUES ('dice', 1, v_stake, v_payout_to_pay, v_stake - v_payout_to_pay)
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
  PERFORM admin_log('error', 'rpc:finish_dice_round', SQLERRM,
    jsonb_build_object('round_id', p_round_id, 'payout', p_payout_rub));
  RETURN jsonb_build_object('error', SQLERRM);
END;
$$;


-- ── 4. Live feed: recognise dice ─────────────────────────────────
CREATE OR REPLACE FUNCTION feed_on_slot_round_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_label  TEXT;
  v_amount INTEGER;
BEGIN
  IF    NEW.slot_id = 'tower-stack'    THEN v_label := 'Tower Stack';
  ELSIF NEW.slot_id = 'tetris-cascade' THEN v_label := 'Block Blast';
  ELSIF NEW.slot_id = 'plinko'         THEN v_label := 'Plinko';
  ELSIF NEW.slot_id = 'pixel-mine'     THEN v_label := 'Pixel Mine';
  ELSIF NEW.slot_id = 'dice'           THEN v_label := 'Dice';
  ELSE
    RETURN NEW;
  END IF;

  IF NEW.outcome = 'cashed' AND NEW.payout_rub > 0 THEN
    v_amount := NEW.payout_rub - NEW.stake_rub;
    IF v_amount <= 0 THEN
      v_amount := -NEW.stake_rub;
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


-- ── 5. Live feed: include dice in fake-event seeder ──────────────
CREATE OR REPLACE FUNCTION feed_insert_fake()
RETURNS VOID LANGUAGE plpgsql VOLATILE
AS $$
DECLARE
  v_game_ids    TEXT[] := ARRAY['tower-stack', 'tetris-cascade', 'rocket', 'plinko', 'pixel-mine', 'dice'];
  v_game_labels TEXT[] := ARRAY['Tower Stack', 'Block Blast', 'Rocket', 'Plinko', 'Pixel Mine', 'Dice'];
  v_bets        INTEGER[] := ARRAY[10, 25, 50, 100, 250, 500, 1000, 2000, 4000, 8000, 16000, 25000];
  v_game_idx    INTEGER;
  v_amount      INTEGER;
  r             NUMERIC;
  v_is_plinko   BOOLEAN;
BEGIN
  v_game_idx := 1 + floor(random() * array_length(v_game_ids, 1))::INT;
  v_is_plinko := v_game_ids[v_game_idx] = 'plinko';

  -- Plinko ALWAYS pays something (min mul = 0.1) so it never shows
  -- a clean loss in the feed. Other slots split 60/40 loss/win.
  IF NOT v_is_plinko AND random() < 0.60 THEN
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

  INSERT INTO live_feed_events (
    user_name, avatar_emoji, game_id, game_label, amount_rub, is_fake
  ) VALUES (
    'Outplay', '🎰',
    v_game_ids[v_game_idx], v_game_labels[v_game_idx],
    v_amount, true
  );
END;
$$;


GRANT EXECUTE ON FUNCTION start_dice_round(UUID, INTEGER)  TO authenticated, anon;
GRANT EXECUTE ON FUNCTION finish_dice_round(UUID, INTEGER) TO authenticated, anon;

NOTIFY pgrst, 'reload schema';
