-- =============================================
-- Rocket Engine — close the cron/client race
-- Run AFTER migration_rocket_engine_faster.sql
-- =============================================
--
-- The cron tick calls rocket_ensure_round() and the client (when
-- it sees phase='idle') calls get_or_create_current_rocket_round.
-- The latter takes pg_advisory_xact_lock(72321), but ensure_round
-- did NOT — so a cron tick that fired right while a client also
-- fell into idle could end up with both creating the same "next"
-- round before either committed. Result: two rounds back-to-back
-- with overlapping betting_until.
--
-- Fix: take the same advisory lock at the top of ensure_round.
-- After the lock is acquired, re-check the latest round's
-- hold_until — if a parallel writer beat us to creation, just
-- return what they made.

CREATE OR REPLACE FUNCTION rocket_ensure_round()
RETURNS rocket_rounds
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_round rocket_rounds;
BEGIN
  -- Same advisory lock id as get_or_create_current_rocket_round so the
  -- two functions serialise against each other.
  PERFORM pg_advisory_xact_lock(72321);

  SELECT * INTO v_round FROM rocket_rounds ORDER BY id DESC LIMIT 1;

  IF v_round.id IS NULL THEN
    v_round := rocket_create_round();
    RETURN v_round;
  END IF;

  IF NOW() < v_round.hold_until THEN
    RETURN v_round;
  END IF;

  v_round := rocket_create_round();
  RETURN v_round;

EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'rpc:rocket_ensure_round', SQLERRM,
    jsonb_build_object('current_id', v_round.id));
  RETURN NULL;
END;
$$;

NOTIFY pgrst, 'reload schema';
