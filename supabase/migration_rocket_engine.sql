-- =============================================
-- Rocket Slot — server-driven 24/7 engine
-- Run AFTER migration_rocket_slot_logging.sql
-- =============================================
--
-- Replaces the lazy client-driven round creation with a real game
-- engine that runs inside Postgres via pg_cron. Result: rounds are
-- ALWAYS being created in the background, regardless of how many
-- players are online. Clients become pure readers — they only ever
-- fetch the current round and subscribe to Realtime.
--
-- Architecture:
--   * pg_cron job "rocket-engine" fires every minute
--   * It calls a STORED PROCEDURE rocket_engine_tick() which loops
--     for ~55 seconds, calling rocket_ensure_round() every 500ms.
--     Each iteration runs in its own transaction (COMMIT inside the
--     procedure) so new rounds are visible / Realtime-broadcast the
--     instant they're inserted.
--   * Between two cron firings there is a ~3-5 second gap where the
--     engine isn't actively ticking; that's fine because rounds are
--     ~12 s long, and the next minute's tick catches up immediately.
--
-- Client side:
--   * get_current_rocket_round() — STABLE, read-only. The new
--     endpoint clients call. They no longer trigger creation.
--   * The old get_or_create_current_rocket_round() is kept in place
--     as a safety net (e.g. if the cron job is paused) but the
--     refreshed client doesn't call it anymore.

-- ── 1. Enable pg_cron ────────────────────────────────────────────
-- On Supabase the extension lives in the "extensions" schema.
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;


-- ── 2. Read-only client endpoint ─────────────────────────────────
CREATE OR REPLACE FUNCTION get_current_rocket_round()
RETURNS rocket_rounds
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT * FROM rocket_rounds ORDER BY id DESC LIMIT 1
$$;


-- ── 3. Engine helper — create next round if needed ───────────────
-- Same advisory lock id as get_or_create_current_rocket_round so the
-- cron tick (this) and the client's idle re-fetch can't both create
-- the same "next" round in parallel. After the lock is acquired we
-- re-check the latest round's hold_until in case the other writer
-- beat us to creation.
CREATE OR REPLACE FUNCTION rocket_ensure_round()
RETURNS rocket_rounds
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_round rocket_rounds;
BEGIN
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


-- ── 4. Engine procedure ──────────────────────────────────────────
-- A PROCEDURE (not a function) so we can COMMIT inside the loop.
-- That's the critical bit — without per-iteration COMMITs, the new
-- rocket_rounds INSERTs would be invisible to Realtime / clients
-- until the whole 55-second tick finished.
--
-- IMPORTANT: no inner EXCEPTION block around the COMMIT — Postgres
-- forbids transaction control inside an exception handler. Errors
-- inside rocket_ensure_round() are caught by ITS exception handler
-- (logs to admin_logs, returns NULL), so they never bubble up here.
-- A truly unexpected raise will abort this cron tick; the next
-- minute's tick recovers automatically.
CREATE OR REPLACE PROCEDURE rocket_engine_tick()
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_started TIMESTAMPTZ := clock_timestamp();
BEGIN
  WHILE EXTRACT(EPOCH FROM (clock_timestamp() - v_started)) < 55 LOOP
    PERFORM rocket_ensure_round();
    COMMIT;
    PERFORM pg_sleep(0.5);
  END LOOP;
END;
$$;


-- ── 5. Schedule with pg_cron ─────────────────────────────────────
-- Re-schedule idempotently: if the job already exists, drop it first.
DO $$
BEGIN
  PERFORM cron.unschedule('rocket-engine');
EXCEPTION WHEN OTHERS THEN
  -- Job didn't exist yet — that's fine.
  NULL;
END $$;

SELECT cron.schedule(
  'rocket-engine',
  '* * * * *',
  $$ CALL public.rocket_engine_tick() $$
);


-- ── 6. Optional cleanup of old rounds (weekly retention) ─────────
DO $$
BEGIN
  PERFORM cron.unschedule('rocket-cleanup');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'rocket-cleanup',
  '17 3 * * *',  -- daily at 03:17 UTC
  $$ DELETE FROM rocket_rounds WHERE created_at < NOW() - INTERVAL '7 days' $$
);


-- ── 7. Grants ────────────────────────────────────────────────────
-- Clients only read the current round.
GRANT EXECUTE ON FUNCTION get_current_rocket_round() TO authenticated, anon;
-- rocket_ensure_round / rocket_engine_tick run as the postgres role
-- inside the cron worker; they intentionally have no public grants.

NOTIFY pgrst, 'reload schema';

-- ╔═══════════════════════════════════════════╗
-- ║  DONE!                                    ║
-- ╚═══════════════════════════════════════════╝
-- After applying:
--   * Wait 60 seconds for the first cron tick.
--   * Verify with:
--       SELECT id, crash_at_mul, status, betting_until
--         FROM rocket_rounds ORDER BY id DESC LIMIT 5;
--     New rows should appear ~every 12 seconds, 24/7.
--   * Cron run history:
--       SELECT * FROM cron.job_run_details
--         WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'rocket-engine')
--         ORDER BY start_time DESC LIMIT 10;
