-- =============================================
-- Live feed diagnostic (single-result version)
-- Supabase SQL Editor shows only the LAST result of a multi-statement
-- script, so we squash everything into one UNION result.
-- =============================================
-- TIP: if cron_last_status = 'failed', also run the second query at
-- the very bottom of this file separately to see the full error
-- message (Supabase truncates wide cells in the result table).

WITH
  cron_installed AS (
    SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') AS yes
  ),
  cron_job AS (
    SELECT
      (SELECT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'live-feed-fake')) AS scheduled,
      (SELECT schedule FROM cron.job WHERE jobname = 'live-feed-fake' LIMIT 1) AS sched
  ),
  last_run AS (
    SELECT
      MAX(start_time) AS last_start,
      (ARRAY_AGG(status ORDER BY start_time DESC))[1] AS last_status,
      (ARRAY_AGG(return_message ORDER BY start_time DESC))[1] AS last_msg
    FROM cron.job_run_details
    WHERE jobid IN (SELECT jobid FROM cron.job WHERE jobname = 'live-feed-fake')
  ),
  recent_events AS (
    SELECT
      COUNT(*) FILTER (WHERE is_fake = true)  AS fakes_60s,
      COUNT(*) FILTER (WHERE is_fake = false) AS reals_60s,
      MAX(created_at) AS most_recent
    FROM live_feed_events
    WHERE created_at > NOW() - INTERVAL '60 seconds'
  ),
  trigger_check AS (
    SELECT
      CASE WHEN prosrc LIKE '%v_amount := NEW.payout_rub;%'
        AND prosrc NOT LIKE '%NEW.payout_rub - NEW.stake_rub%'
        THEN 'v6 (correct)'
        ELSE 'OLD (re-run migration_live_feed_v6.sql)'
      END AS version
    FROM pg_proc
    WHERE proname = 'feed_on_slot_round_change'
  ),
  realtime_check AS (
    SELECT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND tablename = 'live_feed_events'
    ) AS published
  )
SELECT
  (SELECT yes FROM cron_installed)               AS pg_cron_installed,
  (SELECT scheduled FROM cron_job)               AS cron_job_scheduled,
  (SELECT sched     FROM cron_job)               AS cron_schedule,
  (SELECT last_start  FROM last_run)             AS cron_last_start,
  (SELECT last_status FROM last_run)             AS cron_last_status,
  (SELECT last_msg    FROM last_run)             AS cron_last_msg,
  (SELECT fakes_60s   FROM recent_events)        AS fakes_in_last_60s,
  (SELECT reals_60s   FROM recent_events)        AS reals_in_last_60s,
  (SELECT most_recent FROM recent_events)        AS most_recent_event,
  (SELECT version     FROM trigger_check)        AS trigger_version,
  (SELECT published   FROM realtime_check)       AS realtime_publishing;

-- ───── If cron is failing: select THIS one and run separately ─────
-- Last 3 cron failures with the FULL untruncated error text. Click
-- a single cell in the result to see the whole message.
SELECT start_time, return_message AS full_error
FROM cron.job_run_details
WHERE jobid IN (SELECT jobid FROM cron.job WHERE jobname = 'live-feed-fake')
  AND status = 'failed'
ORDER BY start_time DESC
LIMIT 3;
