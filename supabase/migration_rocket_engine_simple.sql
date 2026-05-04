-- =============================================
-- Rocket Engine — simplified to a 10-second cron
-- Run this AFTER any of the previous engine migrations.
-- =============================================
--
-- The procedure-based engine kept tripping over Postgres rules around
-- COMMIT inside plpgsql. It was the wrong tool — we already saw that
-- this Supabase project schedules `check-crypto-deposits` every
-- '30 seconds', so pg_cron here supports sub-minute intervals.
--
-- New design (much simpler):
--   * Schedule a plain cron every 10 seconds.
--   * Each tick just calls rocket_ensure_round() — a normal SQL
--     function that creates the next round if the previous one's
--     hold has expired, otherwise returns the current one (no-op).
--   * No procedure, no COMMIT loop, no pg_sleep, no exception
--     gymnastics. Each call is one tiny transaction.
--
-- 10 seconds is short enough to keep the gap between rounds < 1
-- engine tick, but sparse enough to be free.

-- 1. Drop the old cron job + procedure entirely.
DO $$
BEGIN
  PERFORM cron.unschedule('rocket-engine');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

DROP PROCEDURE IF EXISTS public.rocket_engine_tick();
DROP FUNCTION  IF EXISTS public.rocket_engine_tick();

-- 2. Schedule the simple cron.
SELECT cron.schedule(
  'rocket-engine',
  '10 seconds',
  $$ SELECT public.rocket_ensure_round() $$
);

-- 3. Realtime publication sanity (idempotent).
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
-- a) The engine job should be on a 10-second schedule:
--      SELECT jobid, jobname, schedule, command, active
--        FROM cron.job WHERE jobname = 'rocket-engine';
--
-- b) Wait 30 seconds. The latest few runs MUST be 'succeeded':
--      SELECT runid, status, return_message, start_time, end_time
--        FROM cron.job_run_details
--        WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'rocket-engine')
--        ORDER BY start_time DESC LIMIT 6;
--
-- c) New rocket_rounds rows appear continuously, gap <= 13 s on the
--    longest flights (10 s cron + 3 s hold):
--      SELECT id, crash_at_mul, status, created_at
--        FROM rocket_rounds ORDER BY id DESC LIMIT 10;
