-- =============================================
-- Rocket Engine — bulletproof reinstall
-- Run this if cron.job_run_details still shows
--   "invalid transaction termination at COMMIT"
-- =============================================
--
-- Symptom: previous CREATE OR REPLACE PROCEDURE didn't actually
-- replace the body — old version with the EXCEPTION-around-COMMIT
-- bug stays in place and the cron keeps failing.
--
-- Likely root cause: an earlier deploy created the object as a
-- FUNCTION (not a procedure), and CREATE OR REPLACE PROCEDURE won't
-- overwrite an existing function with a matching signature, so the
-- buggy one survived.
--
-- Bulletproof reinstall: unschedule cron → drop both function AND
-- procedure aggressively → create the procedure fresh → re-schedule.

-- 1. Drop the cron job first so it can't fire mid-reinstall.
DO $$
BEGIN
  PERFORM cron.unschedule('rocket-engine');
EXCEPTION WHEN OTHERS THEN
  NULL;  -- not scheduled yet, fine
END $$;

-- 2. Nuke any existing object named rocket_engine_tick.
DROP PROCEDURE IF EXISTS public.rocket_engine_tick();
DROP FUNCTION  IF EXISTS public.rocket_engine_tick();

-- 3. Recreate as a procedure with NO inner exception block — COMMIT
--    is the only transaction-control statement and it's at the top
--    level of the loop, which is allowed.
CREATE PROCEDURE public.rocket_engine_tick()
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_started TIMESTAMPTZ := clock_timestamp();
BEGIN
  WHILE EXTRACT(EPOCH FROM (clock_timestamp() - v_started)) < 55 LOOP
    PERFORM public.rocket_ensure_round();
    COMMIT;
    PERFORM pg_sleep(0.5);
  END LOOP;
END;
$$;

-- 4. Re-register the cron job (CALL is procedure-only).
SELECT cron.schedule(
  'rocket-engine',
  '* * * * *',
  $$ CALL public.rocket_engine_tick() $$
);

-- 5. Realtime publication sanity (idempotent).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND tablename = 'rocket_rounds'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE rocket_rounds';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

-- ╔═══════════════════════════════════════════╗
-- ║  Verify after applying                    ║
-- ╚═══════════════════════════════════════════╝
--
-- a) Check it's actually a procedure now (prokind = 'p'):
--      SELECT proname, prokind FROM pg_proc
--       WHERE proname = 'rocket_engine_tick';
--
-- b) Wait ~70 seconds, then look for fresh "succeeded" runs:
--      SELECT runid, status, return_message, start_time
--        FROM cron.job_run_details
--        WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'rocket-engine')
--        ORDER BY start_time DESC LIMIT 5;
--
-- c) New rounds every ~12s:
--      SELECT id, crash_at_mul, status, created_at
--        FROM rocket_rounds ORDER BY id DESC LIMIT 10;
