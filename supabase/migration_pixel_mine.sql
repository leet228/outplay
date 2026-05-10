-- =============================================
-- Pixel Mine — Minecraft-style mining slot (Mine Slot clone)
-- Run AFTER migration_plinko.sql
-- =============================================
--
-- Two RPCs power the production flow:
--
--   start_pixel_mine_round  — atomic stake debit. Optional
--                             p_is_buy_bonus = true charges
--                             100 × stake instead of 1 × stake
--                             (the Buy Bonus surcharge that
--                             guarantees a 3+ scatter trigger
--                             on the next spin client-side).
--                             Stores the BASE stake in
--                             slot_rounds.stake_rub so the
--                             finalize cap math stays consistent
--                             between buy-bonus and normal rounds.
--
--   finish_pixel_mine_round — accepts the client's claimed total
--                             payout (cluster wins from the
--                             trigger spin + 4 free-spin
--                             iterations + chest multipliers).
--                             Caps it at stake × 5000 (matches the
--                             Mine Slot reference 5000× max win)
--                             with a hard 1 000 000 ₽ absolute
--                             ceiling. Applies the deficit
--                             circuit breaker if the slot is past
--                             its loss floor.
--
-- The slot is honest-RNG: the client samples symbols, drops
-- pickaxes, explodes TNT, opens chests, and runs the bonus loop.
-- Server only validates the FINAL payout vs. stake × cap.

-- ── 1. Seed slot_stats row for pixel-mine if missing ─────────────
INSERT INTO slot_stats (slot_id, target_rtp, max_house_deficit_rub)
  VALUES ('pixel-mine', 0.95, 10000)
  ON CONFLICT (slot_id) DO NOTHING;

-- Older deploys may have created slot_stats with a 0.94 target —
-- bump it now that the Monte-Carlo sim verifies long-run RTP at
-- ≈ 94.7 %.
UPDATE slot_stats SET target_rtp = 0.95 WHERE slot_id = 'pixel-mine';

-- ── 2. start_pixel_mine_round ────────────────────────────────────
-- Drop the old 2-arg signature (if a previous deploy created it)
-- before recreating with the new optional p_is_buy_bonus parameter.
DROP FUNCTION IF EXISTS start_pixel_mine_round(UUID, INTEGER);

CREATE OR REPLACE FUNCTION start_pixel_mine_round(
  p_user_id      UUID,
  p_stake_rub    INTEGER,
  p_is_buy_bonus BOOLEAN DEFAULT false
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
  v_cost_rub       INTEGER;   -- actual amount debited (stake or 100 × stake)
BEGIN
  IF p_stake_rub IS NULL OR p_stake_rub < 10 OR p_stake_rub > 25000 THEN
    RETURN jsonb_build_object('error', 'invalid_stake');
  END IF;

  -- Buy Bonus surcharge — pays 100 × stake up front to start a
  -- spin guaranteed to trigger Free Spins on the client. The
  -- BASE stake (per-spin reference) is still recorded on the
  -- round so the finalize cap stays at base × 5000.
  v_cost_rub := CASE
    WHEN p_is_buy_bonus THEN p_stake_rub * 100
    ELSE p_stake_rub
  END;

  -- Auto-abort prior pending rounds (crash recovery).
  UPDATE slot_rounds
     SET outcome = 'aborted', finished_at = NOW()
   WHERE user_id = p_user_id AND outcome = 'pending' AND slot_id = 'pixel-mine';

  SELECT balance INTO v_balance FROM users WHERE id = p_user_id FOR UPDATE;
  IF v_balance IS NULL THEN
    RETURN jsonb_build_object('error', 'user_not_found');
  END IF;
  IF v_balance < v_cost_rub THEN
    RETURN jsonb_build_object('error', 'insufficient_balance');
  END IF;

  SELECT current_pnl_rub, max_house_deficit_rub, enabled
    INTO v_pnl, v_max_deficit, v_enabled
    FROM slot_stats WHERE slot_id = 'pixel-mine';

  IF v_pnl IS NULL THEN
    INSERT INTO slot_stats (slot_id, target_rtp, max_house_deficit_rub)
      VALUES ('pixel-mine', 0.95, 10000) ON CONFLICT DO NOTHING;
    v_pnl := 0; v_max_deficit := 10000; v_enabled := true;
  END IF;
  IF NOT v_enabled THEN
    RETURN jsonb_build_object('error', 'slot_disabled');
  END IF;

  v_deficit_active := COALESCE(v_pnl, 0) <= -COALESCE(v_max_deficit, 10000);
  v_bias := CASE WHEN v_deficit_active THEN 'house_recovers' ELSE 'normal' END;

  -- Atomic debit (1 × stake or 100 × stake depending on buy-bonus flag).
  UPDATE users SET balance = balance - v_cost_rub WHERE id = p_user_id;

  INSERT INTO slot_rounds (
    user_id, slot_id, stake_rub, rtp_bias,
    outcome_kind, target_payout_rub, bonus_kind, is_bought
  )
  VALUES (
    p_user_id, 'pixel-mine', p_stake_rub, v_bias,
    'open', NULL, NULL, p_is_buy_bonus
  )
  RETURNING id INTO v_round_id;

  INSERT INTO transactions (user_id, type, amount, ref_id)
    VALUES (p_user_id, 'slot_bet', -v_cost_rub, v_round_id);

  RETURN jsonb_build_object(
    'ok', true,
    'round_id', v_round_id,
    'balance', v_balance - v_cost_rub,
    'cost_rub', v_cost_rub,
    'is_buy_bonus', p_is_buy_bonus,
    'deficit_active', v_deficit_active
  );

EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'rpc:start_pixel_mine_round', SQLERRM,
    jsonb_build_object('user_id', p_user_id, 'stake', p_stake_rub, 'buy_bonus', p_is_buy_bonus));
  RETURN jsonb_build_object('error', SQLERRM);
END;
$$;


-- ── 3. finish_pixel_mine_round ───────────────────────────────────
-- Accepts the client's claimed total payout for the round (trigger
-- spin + any FS iterations + chest multipliers). Caps at base
-- stake × 5000 (matches the Mine Slot reference's 5000× max win)
-- with a 1 000 000 ₽ absolute ceiling. Buy-bonus rounds use the
-- SAME cap — players paid 100 × stake to enter, but the per-spin
-- max-win cap doesn't change.

CREATE OR REPLACE FUNCTION finish_pixel_mine_round(
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
  v_is_bought      BOOLEAN;
  v_actual_cost    INTEGER;   -- what the user actually paid (1× or 100× stake)
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

  -- Hard cap: base stake × 5000 (Mine Slot reference's documented
  -- 5000× max win). Plus a hard 1 000 000 ₽ absolute ceiling so a
  -- runaway client can't drain the house in one round.
  v_hard_cap := LEAST(v_stake * 5000, 1000000);
  v_payout_to_pay := LEAST(p_payout_rub, v_hard_cap);

  -- Deficit circuit breaker — if the slot has bled past its loss
  -- floor, force the round payout down to the user's stake (so
  -- the UI doesn't look broken) until the slot recovers.
  SELECT current_pnl_rub, max_house_deficit_rub
    INTO v_house_pnl, v_max_deficit
    FROM slot_stats WHERE slot_id = 'pixel-mine';
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

  -- For stat aggregation, count the ACTUAL amount the user paid
  -- (100 × stake for buy-bonus, 1 × stake otherwise) so RTP and
  -- deficit math stay accurate.
  v_actual_cost := CASE WHEN v_is_bought THEN v_stake * 100 ELSE v_stake END;

  INSERT INTO slot_stats (slot_id, total_games, total_wagered_rub, total_paid_rub, current_pnl_rub)
    VALUES ('pixel-mine', 1, v_actual_cost, v_payout_to_pay, v_actual_cost - v_payout_to_pay)
    ON CONFLICT (slot_id) DO UPDATE SET
      total_games        = slot_stats.total_games + 1,
      total_wagered_rub  = slot_stats.total_wagered_rub + v_actual_cost,
      total_paid_rub     = slot_stats.total_paid_rub + v_payout_to_pay,
      current_pnl_rub    = slot_stats.current_pnl_rub + (v_actual_cost - v_payout_to_pay),
      updated_at         = NOW();

  v_pnl := v_payout_to_pay - v_actual_cost;

  INSERT INTO user_daily_stats (user_id, date, pnl, games, wins)
    VALUES (
      v_user_id, CURRENT_DATE, v_pnl, 1,
      CASE WHEN v_payout_to_pay > v_actual_cost THEN 1 ELSE 0 END
    )
    ON CONFLICT (user_id, date)
    DO UPDATE SET
      pnl   = user_daily_stats.pnl + v_pnl,
      games = user_daily_stats.games + 1,
      wins  = user_daily_stats.wins + CASE WHEN v_payout_to_pay > v_actual_cost THEN 1 ELSE 0 END;

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
  PERFORM admin_log('error', 'rpc:finish_pixel_mine_round', SQLERRM,
    jsonb_build_object('round_id', p_round_id, 'payout', p_payout_rub));
  RETURN jsonb_build_object('error', SQLERRM);
END;
$$;


-- ── 4. Live feed: recognise pixel-mine ───────────────────────────
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


-- ── 5. Live feed: include pixel-mine in fake-event seeder ────────
CREATE OR REPLACE FUNCTION feed_insert_fake()
RETURNS VOID LANGUAGE plpgsql VOLATILE
AS $$
DECLARE
  v_game_ids    TEXT[] := ARRAY['tower-stack', 'tetris-cascade', 'rocket', 'plinko', 'pixel-mine'];
  v_game_labels TEXT[] := ARRAY['Tower Stack', 'Block Blast', 'Rocket', 'Plinko', 'Pixel Mine'];
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


GRANT EXECUTE ON FUNCTION start_pixel_mine_round(UUID, INTEGER, BOOLEAN)  TO authenticated, anon;
GRANT EXECUTE ON FUNCTION finish_pixel_mine_round(UUID, INTEGER)          TO authenticated, anon;

NOTIFY pgrst, 'reload schema';
