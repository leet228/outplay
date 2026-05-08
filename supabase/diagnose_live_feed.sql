-- =============================================
-- Live feed diagnostic — runs a few checks to see why the feed
-- isn't moving. Each block returns a tiny result; read top-down.
-- =============================================

-- 1. Is pg_cron extension installed at all?
SELECT
  CASE WHEN EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
    THEN '✅ pg_cron is installed'
    ELSE '❌ pg_cron is NOT installed — go to Database → Extensions → enable pg_cron'
  END AS pg_cron_check;

-- 2. Is the live-feed-fake job scheduled?
SELECT
  jobid, schedule, command, active, jobname
FROM cron.job
WHERE jobname IN ('live-feed-fake', 'live-feed-cleanup');

-- 3. Did it actually run recently? (last 10 runs)
SELECT
  jobid, status, return_message, start_time, end_time
FROM cron.job_run_details
WHERE jobid IN (SELECT jobid FROM cron.job WHERE jobname = 'live-feed-fake')
ORDER BY start_time DESC
LIMIT 10;

-- 4. Are NEW events landing in the table? (last 60 seconds)
SELECT
  COUNT(*) FILTER (WHERE is_fake = true)  AS fakes_last_minute,
  COUNT(*) FILTER (WHERE is_fake = false) AS reals_last_minute,
  MAX(created_at) AS most_recent_event
FROM live_feed_events
WHERE created_at > NOW() - INTERVAL '60 seconds';

-- 5. Latest 5 events period (any age)
SELECT id, game_id, game_label, amount_rub, is_fake, created_at
FROM live_feed_events
ORDER BY created_at DESC
LIMIT 5;

-- 6. Is the trigger function the v6 one (returns gross payout, not -stake)?
SELECT
  CASE WHEN prosrc LIKE '%v_amount := NEW.payout_rub;%'
    AND prosrc NOT LIKE '%v_amount := NEW.payout_rub - NEW.stake_rub%'
    THEN '✅ v6 trigger applied (shows gross payout)'
    ELSE '❌ OLD trigger still active — re-run migration_live_feed_v6.sql'
  END AS trigger_version
FROM pg_proc
WHERE proname = 'feed_on_slot_round_change';

-- 7. Is Realtime enabled for live_feed_events?
SELECT
  CASE WHEN EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'live_feed_events'
  )
    THEN '✅ Realtime is publishing live_feed_events'
    ELSE '❌ Realtime NOT enabled — Database → Replication → enable for live_feed_events'
  END AS realtime_check;
