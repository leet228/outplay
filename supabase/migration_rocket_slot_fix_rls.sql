-- =============================================
-- Fix-up: Rocket Slot — RLS / SECURITY DEFINER
-- Run AFTER migration_rocket_slot.sql
-- =============================================
--
-- The original migration enabled RLS on rocket_rounds / rocket_bets
-- but only added SELECT policies. The "writer" RPCs were created
-- without SECURITY DEFINER, so the anon role hit:
--
--   42501: new row violates row-level security policy for table
--          "rocket_rounds"
--
-- Fix: every RPC that mutates rocket_rounds, rocket_bets, slot_stats,
-- transactions, users or user_daily_stats runs as the function owner
-- (postgres) via SECURITY DEFINER + a pinned search_path. The
-- "rocket_rounds_read_all" / "rocket_bets_read_own" SELECT policies
-- stay in place so clients can still read freely.

CREATE OR REPLACE FUNCTION rocket_settle_round_losses(p_round_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lost_count   INTEGER;
  v_lost_wagered BIGINT;
BEGIN
  WITH closed AS (
    UPDATE rocket_bets
       SET status = 'lost', finished_at = NOW()
     WHERE round_id = p_round_id AND status = 'pending'
     RETURNING stake_rub
  )
  SELECT COUNT(*), COALESCE(SUM(stake_rub), 0)
    INTO v_lost_count, v_lost_wagered
    FROM closed;

  IF v_lost_count > 0 THEN
    UPDATE slot_stats
       SET total_games        = total_games + v_lost_count,
           total_wagered_rub  = total_wagered_rub + v_lost_wagered,
           current_pnl_rub    = current_pnl_rub + v_lost_wagered,
           updated_at         = NOW()
     WHERE slot_id = 'rocket';
  END IF;
END;
$$;


CREATE OR REPLACE FUNCTION rocket_create_round()
RETURNS rocket_rounds
LANGUAGE plpgsql VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bias            TEXT;
  v_crash           NUMERIC;
  v_flight_seconds  NUMERIC;
  v_betting_until   TIMESTAMPTZ;
  v_crashed_at      TIMESTAMPTZ;
  v_hold_until      TIMESTAMPTZ;
  v_round           rocket_rounds;
BEGIN
  v_bias := rocket_decide_bias();
  v_crash := rocket_pick_crash(v_bias);
  v_flight_seconds := rocket_flight_seconds(v_crash);
  v_betting_until := NOW() + INTERVAL '5 seconds';
  v_crashed_at    := v_betting_until + (v_flight_seconds || ' seconds')::INTERVAL;
  v_hold_until    := v_crashed_at + INTERVAL '3 seconds';

  UPDATE rocket_rounds SET status = 'finished'
   WHERE status <> 'finished';

  INSERT INTO rocket_rounds (
    crash_at_mul, rtp_bias, betting_until, flying_started_at,
    crashed_at, hold_until, status
  )
  VALUES (
    v_crash, v_bias, v_betting_until, v_betting_until,
    v_crashed_at, v_hold_until, 'betting'
  )
  RETURNING * INTO v_round;

  RETURN v_round;
END;
$$;


CREATE OR REPLACE FUNCTION get_or_create_current_rocket_round()
RETURNS rocket_rounds
LANGUAGE plpgsql VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_round rocket_rounds;
BEGIN
  PERFORM pg_advisory_xact_lock(72321);

  SELECT * INTO v_round
    FROM rocket_rounds
   ORDER BY id DESC
   LIMIT 1;

  IF v_round.id IS NULL THEN
    v_round := rocket_create_round();
    RETURN v_round;
  END IF;

  IF NOW() < v_round.hold_until THEN
    IF v_round.status = 'betting' AND NOW() >= v_round.betting_until THEN
      UPDATE rocket_rounds SET status = 'flying' WHERE id = v_round.id;
      v_round.status := 'flying';
    END IF;
    IF v_round.status = 'flying' AND NOW() >= v_round.crashed_at THEN
      UPDATE rocket_rounds SET status = 'crashed' WHERE id = v_round.id;
      v_round.status := 'crashed';
      PERFORM rocket_settle_round_losses(v_round.id);
    END IF;
    RETURN v_round;
  END IF;

  IF v_round.status <> 'finished' THEN
    PERFORM rocket_settle_round_losses(v_round.id);
    UPDATE rocket_rounds SET status = 'finished' WHERE id = v_round.id;
  END IF;

  v_round := rocket_create_round();
  RETURN v_round;
END;
$$;


-- Re-grant (CREATE OR REPLACE preserves grants but doesn't hurt to be explicit).
GRANT EXECUTE ON FUNCTION rocket_settle_round_losses(BIGINT)         TO authenticated, anon;
GRANT EXECUTE ON FUNCTION rocket_create_round()                      TO authenticated, anon;
GRANT EXECUTE ON FUNCTION get_or_create_current_rocket_round()       TO authenticated, anon;

NOTIFY pgrst, 'reload schema';
