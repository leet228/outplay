-- =============================================
-- Optimization: Rocket Slot — drop hot-path UPDATEs
-- Run AFTER migration_rocket_slot_fix_rls.sql
-- =============================================
--
-- Old hot path (per client poll, every 2s):
--   advisory_lock → SELECT round → UPDATE status='flying' or 'crashed'
--                → settle_round_losses → maybe rocket_create_round
-- → many UPDATEs broadcast through Realtime to every subscriber.
--
-- New hot path: client polls almost never; phase is computed from
-- timestamps. The only writes happen inside rocket_create_round() — one
-- INSERT for the new round + one UPDATE marking the previous one as
-- 'finished' + one settle-losses pass. That's it.
--
-- get_or_create_current_rocket_round() now:
--   * returns the latest round if it's still within hold_until
--   * otherwise lazily creates the next one (which also settles the
--     previous round's pending bets)
--
-- The 'status' column stays — it lets old finished rounds be filtered
-- out of get_rocket_history without re-deriving from timestamps.

-- ── 1. rocket_create_round — now also settles the previous round ──
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
  v_prev_id         BIGINT;
BEGIN
  -- Settle the previous round's leftover pending bets and mark it
  -- finished, all in this same transaction.
  SELECT id INTO v_prev_id
    FROM rocket_rounds
   WHERE status <> 'finished'
   ORDER BY id DESC
   LIMIT 1;
  IF v_prev_id IS NOT NULL THEN
    PERFORM rocket_settle_round_losses(v_prev_id);
    UPDATE rocket_rounds SET status = 'finished' WHERE id = v_prev_id;
  END IF;

  v_bias := rocket_decide_bias();
  v_crash := rocket_pick_crash(v_bias);
  v_flight_seconds := rocket_flight_seconds(v_crash);
  v_betting_until := NOW() + INTERVAL '5 seconds';
  v_crashed_at    := v_betting_until + (v_flight_seconds || ' seconds')::INTERVAL;
  v_hold_until    := v_crashed_at + INTERVAL '3 seconds';

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


-- ── 2. get_or_create — no more status-sync UPDATEs ──
-- Phase is computed by the caller from timestamps. We only ever write
-- when we genuinely need a new round.
CREATE OR REPLACE FUNCTION get_or_create_current_rocket_round()
RETURNS rocket_rounds
LANGUAGE plpgsql VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_round rocket_rounds;
BEGIN
  SELECT * INTO v_round
    FROM rocket_rounds
   ORDER BY id DESC
   LIMIT 1;

  -- No rounds at all → create the first one.
  IF v_round.id IS NULL THEN
    PERFORM pg_advisory_xact_lock(72321);
    -- Re-check inside the lock — another client may have just created it.
    SELECT * INTO v_round FROM rocket_rounds ORDER BY id DESC LIMIT 1;
    IF v_round.id IS NULL THEN
      v_round := rocket_create_round();
    END IF;
    RETURN v_round;
  END IF;

  -- Current round still within hold window → return as-is, no writes.
  IF NOW() < v_round.hold_until THEN
    RETURN v_round;
  END IF;

  -- Hold expired → create the next round (advisory lock prevents two
  -- concurrent clients from racing to create the same one).
  PERFORM pg_advisory_xact_lock(72321);
  SELECT * INTO v_round FROM rocket_rounds ORDER BY id DESC LIMIT 1;
  IF NOW() < v_round.hold_until THEN
    -- Another client beat us to it.
    RETURN v_round;
  END IF;

  v_round := rocket_create_round();
  RETURN v_round;
END;
$$;


GRANT EXECUTE ON FUNCTION rocket_create_round()                TO authenticated, anon;
GRANT EXECUTE ON FUNCTION get_or_create_current_rocket_round() TO authenticated, anon;

NOTIFY pgrst, 'reload schema';
