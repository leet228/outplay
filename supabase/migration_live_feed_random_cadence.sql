-- =============================================
-- Live feed — random 0.5-1.5 s cadence for fake events
-- Run AFTER fix_feed_insert_fake_now.sql
-- =============================================
--
-- The previous schedule was a flat "1 fake every 4 seconds" tick,
-- which felt too metronomic. The user wants fake events to spawn at
-- a JITTERED interval, anywhere from 0.5 to 1.5 seconds apart.
--
-- pg_cron's minimum tick is sub-second on Supabase but the natural
-- way to express "fire at irregular gaps" is to:
--   1. Track the next-target firing time in a tiny state table.
--   2. Have a fast (250 ms) cron tick check whether NOW() >= target.
--   3. When it does fire, randomise the next target 0.5-1.5 s out.
--
-- Average gap ≈ 1 s, never less than 0.5 s, never more than 1.5 s.

-- ── 1. Tiny state table (single row) ─────────────────────────────
CREATE TABLE IF NOT EXISTS feed_fake_state (
  id            INTEGER     PRIMARY KEY DEFAULT 1,
  next_fire_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO feed_fake_state (id, next_fire_at)
  VALUES (1, NOW())
  ON CONFLICT (id) DO NOTHING;


-- ── 2. Tick wrapper that respects the random next-fire target ────
CREATE OR REPLACE FUNCTION feed_fake_tick()
RETURNS VOID
LANGUAGE plpgsql VOLATILE
AS $$
DECLARE
  v_fire_at TIMESTAMPTZ;
BEGIN
  SELECT next_fire_at INTO v_fire_at FROM feed_fake_state WHERE id = 1 FOR UPDATE;

  IF v_fire_at IS NULL OR v_fire_at <= NOW() THEN
    PERFORM public.feed_insert_fake();

    -- Random gap in [0.5, 1.5] seconds.
    UPDATE feed_fake_state
       SET next_fire_at = NOW() + ((0.5 + random()) * INTERVAL '1 second')
     WHERE id = 1;
  END IF;
EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('warn', 'feed_fake_tick', SQLERRM, NULL);
END;
$$;


-- ── 3. Replace the cron job — fire 4 times a second, function gates ─
DO $$ BEGIN PERFORM cron.unschedule('live-feed-fake'); EXCEPTION WHEN OTHERS THEN NULL; END $$;

SELECT cron.schedule(
  'live-feed-fake',
  '250 milliseconds',
  $$ SELECT public.feed_fake_tick() $$
);

NOTIFY pgrst, 'reload schema';
