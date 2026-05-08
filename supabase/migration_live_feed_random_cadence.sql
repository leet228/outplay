-- =============================================
-- Live feed — random 0.5-1.5 s cadence for fake events
-- Run AFTER fix_feed_insert_fake_now.sql
-- =============================================
--
-- Goal: fake events spawn at irregular intervals between 0.5 and 1.5
-- seconds, not on a metronomic 4-second beat.
--
-- pg_cron on Supabase requires interval >= 1 second, so we can't tick
-- below that. Instead each cron tick pre-sleeps a random 0-500 ms
-- before inserting. With ticks aligned to 1 s boundaries, the
-- effective gap between consecutive INSERTs is:
--
--   (1 s + random_b) - (0 s + random_a)
--      with random_a, random_b ∈ [0, 0.5 s] uniform
--
--   → gap is uniform in [0.5 s, 1.5 s], avg 1 s.
--
-- Cleanup: drops the unused feed_fake_state table left over from the
-- previous draft of this migration.

-- ── 1. Tick wrapper with pre-insert jitter ───────────────────────
CREATE OR REPLACE FUNCTION feed_fake_tick()
RETURNS VOID
LANGUAGE plpgsql VOLATILE
AS $$
BEGIN
  -- Random 0-500 ms delay before the insert. Combined with the 1-s
  -- cron cadence above, neighbouring inserts land 0.5-1.5 s apart.
  PERFORM pg_sleep(random() * 0.5);
  PERFORM public.feed_insert_fake();
EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('warn', 'feed_fake_tick', SQLERRM, NULL);
END;
$$;


-- ── 2. Replace the cron job at 1-second cadence ──────────────────
DO $$ BEGIN PERFORM cron.unschedule('live-feed-fake'); EXCEPTION WHEN OTHERS THEN NULL; END $$;

SELECT cron.schedule(
  'live-feed-fake',
  '1 seconds',
  $$ SELECT public.feed_fake_tick() $$
);


-- ── 3. Drop the unused state table from the previous draft ───────
DROP TABLE IF EXISTS feed_fake_state;

NOTIFY pgrst, 'reload schema';
