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

NOTIFY pgrst, 'reload schema';
