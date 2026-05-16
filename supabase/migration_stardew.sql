-- !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
-- !!! TODO RUN ON PROD — Stardew Spins server round wiring.  !!!
-- !!! Run AFTER migration_magnetic.sql (same slot_round      !!!
-- !!! pattern; this just adds the 'stardew-spins' variant).  !!!
-- !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
-- =============================================
-- Stardew Spins — 6×5 Pay-Anywhere tumble + "Year of Harvest" FS
-- =============================================
--
-- Same single-round wrap as Magnetic so the bonus winnings can
-- never be orphaned:
--
--   start_stardew_round  — atomic stake debit, opens ONE round.
--                          Buy-bonus debits stake × 100 and tags
--                          the round is_bought=true. Auto-aborts
--                          any prior pending stardew round.
--                          Returns deficit_active so the client
--                          can deliberately deal an HONESTLY
--                          empty base grid (no 8+ clusters at all)
--                          and a poor-payout bonus while the house
--                          is recovering — never a fake-suppressed
--                          win, the symbols genuinely don't line up.
--
--   finish_stardew_round — accepts the client's claimed total
--                          (base cascade + full bonus harvest,
--                          summed). No cap — we trust the math.
--                          Deficit breaker is the only limiter:
--                          while the slot is past its loss floor
--                          the payout is clamped to the debited
--                          amount so each round at worst breaks
--                          even on the cost of the spin/buy.
--
-- The client wraps start → animate base cascade → (optional
-- bonus FS) → finish in ONE round and only calls finish ONCE at
-- the very end with base+bonus summed. The Spin button stays
-- disabled until finish returns — that is the user's "buy a
-- bonus, play it, then a normal spin must not eat the bonus
-- win" guarantee.
--
-- RTP target: 95 % (scripts/stardew-rtp-sim.js — measured
--             94.5 %, buy-bonus EV 97.6 %).

-- ── 1. Seed slot_stats row for stardew-spins if missing ───────────
INSERT INTO slot_stats (slot_id, target_rtp, max_house_deficit_rub)
  VALUES ('stardew-spins', 0.95, 10000)
  ON CONFLICT (slot_id) DO NOTHING;
UPDATE slot_stats SET target_rtp = 0.95 WHERE slot_id = 'stardew-spins';


-- ── 2. start_stardew_round ───────────────────────────────────────
-- Two debit paths share one function:
--   p_is_buy_bonus = false  → debit stake_rub  (regular spin)
--   p_is_buy_bonus = true   → debit stake_rub × 100 (buy bonus)
DROP FUNCTION IF EXISTS start_stardew_round(UUID, INTEGER, BOOLEAN);

CREATE OR REPLACE FUNCTION start_stardew_round(
  p_user_id      UUID,
  p_stake_rub    INTEGER,
  p_is_buy_bonus BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_debit          INTEGER;
  v_balance        INTEGER;
  v_round_id       UUID;
  v_max_deficit    INTEGER;
  v_house_pnl      BIGINT;
  v_enabled        BOOLEAN;
  v_deficit_active BOOLEAN;
  v_bias           TEXT;
BEGIN
  IF p_stake_rub IS NULL OR p_stake_rub < 10 OR p_stake_rub > 25000 THEN
    RETURN jsonb_build_object('error', 'invalid_stake');
  END IF;
  IF p_is_buy_bonus IS NULL THEN p_is_buy_bonus := false; END IF;

  v_debit := CASE WHEN p_is_buy_bonus THEN p_stake_rub * 100 ELSE p_stake_rub END;

  -- Auto-abort prior pending stardew rounds for this user (crash
  -- recovery: tab closed mid-spin shouldn't lock the next start).
  -- The aborted round's stake is forfeited — standard slot
  -- behaviour across the codebase.
  UPDATE slot_rounds
     SET outcome = 'aborted', finished_at = NOW()
   WHERE user_id = p_user_id AND outcome = 'pending' AND slot_id = 'stardew-spins';

  SELECT balance INTO v_balance FROM users WHERE id = p_user_id FOR UPDATE;
  IF v_balance IS NULL THEN
    RETURN jsonb_build_object('error', 'user_not_found');
  END IF;
  IF v_balance < v_debit THEN
    RETURN jsonb_build_object('error', 'insufficient_balance');
  END IF;

  SELECT current_pnl_rub, max_house_deficit_rub, enabled
    INTO v_house_pnl, v_max_deficit, v_enabled
    FROM slot_stats WHERE slot_id = 'stardew-spins';

  IF v_house_pnl IS NULL THEN
    INSERT INTO slot_stats (slot_id, target_rtp, max_house_deficit_rub)
      VALUES ('stardew-spins', 0.95, 10000) ON CONFLICT DO NOTHING;
    v_house_pnl := 0; v_max_deficit := 10000; v_enabled := true;
  END IF;
  IF NOT v_enabled THEN
    RETURN jsonb_build_object('error', 'slot_disabled');
  END IF;

  v_deficit_active := COALESCE(v_house_pnl, 0) <= -COALESCE(v_max_deficit, 10000);
  v_bias := CASE WHEN v_deficit_active THEN 'house_recovers' ELSE 'normal' END;

  -- Atomic debit.
  UPDATE users SET balance = balance - v_debit WHERE id = p_user_id;

  INSERT INTO slot_rounds (
    user_id, slot_id, stake_rub, rtp_bias,
    outcome_kind, target_payout_rub, bonus_kind, is_bought
  )
  VALUES (
    p_user_id, 'stardew-spins', p_stake_rub, v_bias,
    'open', NULL,
    CASE WHEN p_is_buy_bonus THEN 'buy' ELSE NULL END,
    p_is_buy_bonus
  )
  RETURNING id INTO v_round_id;

  INSERT INTO transactions (user_id, type, amount, ref_id)
    VALUES (p_user_id, 'slot_bet', -v_debit, v_round_id);

  RETURN jsonb_build_object(
    'ok', true,
    'round_id', v_round_id,
    'balance', v_balance - v_debit,
    'deficit_active', v_deficit_active,
    'is_buy_bonus', p_is_buy_bonus,
    'debited_rub', v_debit
  );

EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'rpc:start_stardew_round', SQLERRM,
    jsonb_build_object('user_id', p_user_id, 'stake', p_stake_rub, 'buy', p_is_buy_bonus));
  RETURN jsonb_build_object('error', SQLERRM);
END;
$$;


-- ── 3. finish_stardew_round ──────────────────────────────────────
-- Accepts the client's claimed payout (base cascade + bonus FS
-- harvest sum). No payout cap — trust the client's math, pay the
-- full claim. Deficit circuit breaker is the only limiter.
CREATE OR REPLACE FUNCTION finish_stardew_round(
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
  v_is_bought      BOOLEAN;
  v_debited        INTEGER;
  v_payout_to_pay  INTEGER;
  v_balance_new    INTEGER;
  v_pnl            INTEGER;
  v_house_pnl      BIGINT;
  v_max_deficit    INTEGER;
  v_deficit_active BOOLEAN;
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

  -- No payout cap — we trust the client's claimed total. Any
  -- legitimate win, however large, pays out in full (the Postgres
  -- INTEGER ceiling on the cast is the only structural limit).
  v_payout_to_pay := GREATEST(p_payout_rub, 0);

  -- Deficit circuit breaker — slot bled past its loss floor: clamp
  -- the payout to the debited amount so the round at worst breaks
  -- even on the cost of the spin/buy until the house recovers.
  SELECT current_pnl_rub, max_house_deficit_rub
    INTO v_house_pnl, v_max_deficit
    FROM slot_stats WHERE slot_id = 'stardew-spins';
  v_deficit_active := COALESCE(v_house_pnl, 0) <= -COALESCE(v_max_deficit, 10000);
  v_debited := CASE WHEN v_is_bought THEN v_stake * 100 ELSE v_stake END;

  IF v_deficit_active THEN
    v_payout_to_pay := LEAST(v_payout_to_pay, v_debited);
  END IF;

  IF v_payout_to_pay > 0 THEN
    UPDATE users SET balance = balance + v_payout_to_pay WHERE id = v_user_id;
    INSERT INTO transactions (user_id, type, amount, ref_id)
      VALUES (v_user_id, 'slot_win', v_payout_to_pay, p_round_id);
  END IF;

  UPDATE slot_rounds
     SET outcome     = CASE WHEN v_payout_to_pay > 0 THEN 'cashed' ELSE 'fallen' END,
         payout_rub  = v_payout_to_pay,
         multiplier  = CASE WHEN v_debited > 0
                            THEN ROUND(v_payout_to_pay::NUMERIC / v_debited, 4)
                            ELSE 0 END,
         finished_at = NOW()
   WHERE id = p_round_id;

  -- Slot-level stats track the EFFECTIVE wager (debited amount,
  -- including the buy-bonus surcharge) and payout so RTP stays
  -- accurate across the mixed flow.
  INSERT INTO slot_stats (slot_id, total_games, total_wagered_rub, total_paid_rub, current_pnl_rub)
    VALUES ('stardew-spins', 1, v_debited, v_payout_to_pay, v_debited - v_payout_to_pay)
    ON CONFLICT (slot_id) DO UPDATE SET
      total_games        = slot_stats.total_games + 1,
      total_wagered_rub  = slot_stats.total_wagered_rub + v_debited,
      total_paid_rub     = slot_stats.total_paid_rub + v_payout_to_pay,
      current_pnl_rub    = slot_stats.current_pnl_rub + (v_debited - v_payout_to_pay),
      updated_at         = NOW();

  v_pnl := v_payout_to_pay - v_debited;

  INSERT INTO user_daily_stats (user_id, date, pnl, games, wins)
    VALUES (
      v_user_id, CURRENT_DATE, v_pnl, 1,
      CASE WHEN v_payout_to_pay > v_debited THEN 1 ELSE 0 END
    )
    ON CONFLICT (user_id, date)
    DO UPDATE SET
      pnl   = user_daily_stats.pnl + v_pnl,
      games = user_daily_stats.games + 1,
      wins  = user_daily_stats.wins + CASE WHEN v_payout_to_pay > v_debited THEN 1 ELSE 0 END;

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
  PERFORM admin_log('error', 'rpc:finish_stardew_round', SQLERRM,
    jsonb_build_object('round_id', p_round_id, 'payout', p_payout_rub));
  RETURN jsonb_build_object('error', SQLERRM);
END;
$$;


-- ── 4. Live feed: recognise stardew-spins ────────────────────────
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
  ELSIF NEW.slot_id = 'magnetic'       THEN v_label := 'Magnetic';
  ELSIF NEW.slot_id = 'stardew-spins'  THEN v_label := 'Stardew Spins';
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


-- ── 5. Live feed: include stardew-spins in fake-event seeder ─────
CREATE OR REPLACE FUNCTION feed_insert_fake()
RETURNS VOID LANGUAGE plpgsql VOLATILE
AS $$
DECLARE
  v_game_ids    TEXT[]    := ARRAY['tower-stack', 'tetris-cascade', 'rocket', 'plinko', 'pixel-mine', 'dice', 'magnetic', 'stardew-spins'];
  v_game_labels TEXT[]    := ARRAY['Tower Stack', 'Block Blast', 'Rocket', 'Plinko', 'Pixel Mine', 'Dice', 'Magnetic', 'Stardew Spins'];
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


GRANT EXECUTE ON FUNCTION start_stardew_round(UUID, INTEGER, BOOLEAN) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION finish_stardew_round(UUID, INTEGER)         TO authenticated, anon;

NOTIFY pgrst, 'reload schema';
