-- =============================================
-- Rocket Slot — full error logging
-- Run AFTER migration_rocket_slot_clock_sync.sql
-- =============================================
--
-- Audit of slot RPCs found three round-mutating Rocket functions
-- with no EXCEPTION block — if they raised, the error went straight
-- to the client without ever hitting admin_logs. This patch adds
-- EXCEPTION WHEN OTHERS + admin_log() to each, mirroring the pattern
-- already used by start_/finish_/place_/cashout_ across slots.
--
-- Also adds client_log_error() so the frontend can ship its own
-- failures (RPC errors that fall through, Realtime subscription
-- failures, unhandled exceptions) into admin_logs as source='client'.

-- ── 1. rocket_settle_round_losses ──
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

EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'rpc:rocket_settle_round_losses', SQLERRM,
    jsonb_build_object('round_id', p_round_id));
END;
$$;


-- ── 2. rocket_create_round ──
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

EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'rpc:rocket_create_round', SQLERRM,
    jsonb_build_object('prev_id', v_prev_id, 'bias', v_bias, 'crash', v_crash));
  RAISE;  -- re-raise so the caller (get_or_create) can surface it too
END;
$$;


-- ── 3. get_or_create_current_rocket_round ──
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

  IF v_round.id IS NULL THEN
    PERFORM pg_advisory_xact_lock(72321);
    SELECT * INTO v_round FROM rocket_rounds ORDER BY id DESC LIMIT 1;
    IF v_round.id IS NULL THEN
      v_round := rocket_create_round();
    END IF;
    RETURN v_round;
  END IF;

  IF NOW() < v_round.hold_until THEN
    RETURN v_round;
  END IF;

  PERFORM pg_advisory_xact_lock(72321);
  SELECT * INTO v_round FROM rocket_rounds ORDER BY id DESC LIMIT 1;
  IF NOW() < v_round.hold_until THEN
    RETURN v_round;
  END IF;

  v_round := rocket_create_round();
  RETURN v_round;

EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'rpc:get_or_create_current_rocket_round', SQLERRM,
    jsonb_build_object('current_id', v_round.id));
  RAISE;
END;
$$;


-- ── 4. client_log_error — ingest frontend errors ──
-- Frontend wrappers call this when an RPC returns an error or a
-- Realtime subscription fails. Source is hardcoded to 'client' so
-- we can grep admin_logs by it.
CREATE OR REPLACE FUNCTION client_log_error(
  p_scope    TEXT,
  p_message  TEXT,
  p_payload  JSONB DEFAULT '{}'::jsonb
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Defensive caps so an anon flood can't blow up the column sizes.
  PERFORM admin_log(
    'error',
    'client:' || COALESCE(LEFT(p_scope, 60),  'unknown'),
    LEFT(COALESCE(p_message, '(no message)'), 500),
    COALESCE(p_payload, '{}'::jsonb)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION rocket_settle_round_losses(BIGINT)         TO authenticated, anon;
GRANT EXECUTE ON FUNCTION rocket_create_round()                      TO authenticated, anon;
GRANT EXECUTE ON FUNCTION get_or_create_current_rocket_round()       TO authenticated, anon;
GRANT EXECUTE ON FUNCTION client_log_error(TEXT, TEXT, JSONB)        TO authenticated, anon;

NOTIFY pgrst, 'reload schema';
