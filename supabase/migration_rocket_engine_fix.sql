-- =============================================
-- Rocket Engine — fix the procedure's EXCEPTION block
-- Run AFTER migration_rocket_engine.sql
-- =============================================
--
-- The original procedure wrapped each iteration in
--   BEGIN PERFORM ...; COMMIT; EXCEPTION WHEN OTHERS THEN ROLLBACK ...
-- but Postgres forbids transaction-control (COMMIT/ROLLBACK) inside
-- a plpgsql EXCEPTION block — every cron tick failed with
--   ERROR: invalid transaction termination
--
-- rocket_ensure_round() already catches errors internally (its own
-- EXCEPTION handler logs to admin_logs and returns NULL), so the
-- outer try/catch in the procedure is redundant. Drop it; if a real
-- exception still bubbles out, the current cron tick aborts and the
-- next minute's tick recovers automatically.

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

-- Sanity: make sure rocket_rounds is in the Realtime publication.
-- If a previous migration ran but the publication step failed, the
-- client never gets INSERT broadcasts and ends up sitting on a
-- crashed round forever.
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
