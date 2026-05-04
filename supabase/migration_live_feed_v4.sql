-- =============================================
-- Live feed v4 — revert cadence to 1 fake every 4 seconds
-- Run AFTER migration_live_feed_v3.sql
-- =============================================
--
-- Reverts the bursty 2-per-second cadence from v3 back to a steady
-- 1 fake every 4 seconds (the original v1 rhythm). Real events from
-- the slot_rounds / rocket_bets triggers continue to flow on top.

DO $$ BEGIN PERFORM cron.unschedule('live-feed-fake'); EXCEPTION WHEN OTHERS THEN NULL; END $$;

SELECT cron.schedule(
  'live-feed-fake',
  '4 seconds',
  $$ SELECT public.feed_insert_fake() $$
);

NOTIFY pgrst, 'reload schema';
