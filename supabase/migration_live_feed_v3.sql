-- =============================================
-- Live feed v3 — bursty 2-per-second cadence
-- Run AFTER migration_live_feed_v2.sql
-- =============================================
--
-- New cadence: ~2 fake events per second on average, but bursty —
-- sometimes two land back-to-back, sometimes a quiet half-second
-- pause. Achieved with a per-tick burst function:
--
--   pg_cron 'live-feed-fake'  every 1 s
--     ↓
--   feed_insert_fake_burst()
--     · randomly picks 0–3 events
--     · pauses 50–500 ms between each (pg_sleep)
--
-- That gives the ribbon a natural lifelike rhythm without ever
-- staying silent for too long.
--
-- Cleanup retention is left at ~200 rows from v1 (5-minute cron).

-- ── Burst inserter ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION feed_insert_fake_burst()
RETURNS VOID LANGUAGE plpgsql VOLATILE
AS $$
DECLARE
  v_count INTEGER;
  i       INTEGER;
BEGIN
  -- Distribution per second:
  --   10 % → 0 events (quiet beat)
  --   30 % → 1 event
  --   40 % → 2 events
  --   20 % → 3 events
  -- Mean ≈ 1.7 / sec. Combined with the trigger-driven real events
  -- this lands close to the target 2-ish per second the user wanted.
  v_count := CASE
    WHEN random() < 0.10 THEN 0
    WHEN random() < 0.40 THEN 1
    WHEN random() < 0.80 THEN 2
    ELSE                     3
  END;

  FOR i IN 1..v_count LOOP
    PERFORM feed_insert_fake();
    -- Random small pause so the events arrive on uneven beats inside
    -- the same cron tick — 50-500 ms.
    PERFORM pg_sleep(0.05 + random() * 0.45);
  END LOOP;
END;
$$;


-- ── Reschedule cron to fire every second ─────────────────────────
DO $$ BEGIN PERFORM cron.unschedule('live-feed-fake'); EXCEPTION WHEN OTHERS THEN NULL; END $$;

SELECT cron.schedule(
  'live-feed-fake',
  '1 second',
  $$ SELECT public.feed_insert_fake_burst() $$
);

NOTIFY pgrst, 'reload schema';
