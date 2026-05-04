-- =============================================
-- Rocket Slot — server clock RPC for client skew compensation
-- Run AFTER migration_rocket_slot_optimize.sql
-- =============================================
--
-- The countdown / multiplier are computed from
--   betting_until (server timestamp)  −  client local Date.now()
--
-- If a player's PC clock is off by even 2 seconds (very common on
-- desktop without NTP sync), the betting countdown shows 7-8s instead
-- of 5s and the live multiplier drifts. Phones are usually fine
-- because they auto-sync with the carrier.
--
-- Fix: client asks the server for its current epoch_ms once on mount,
-- computes a clockOffsetMs = serverNow − Date.now(), and uses
-- (Date.now() + clockOffsetMs) for all phase / multiplier math.

CREATE OR REPLACE FUNCTION get_server_now()
RETURNS BIGINT
LANGUAGE sql STABLE
AS $$
  SELECT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
$$;

GRANT EXECUTE ON FUNCTION get_server_now() TO authenticated, anon;

-- History filter: any round whose flight is over (crashed_at in the
-- past) is "history". Old behaviour filtered by status IN ('crashed',
-- 'finished'), but the optimize migration removed the 'crashed'
-- status entirely — and any legacy rounds that finished BEFORE the
-- optimize patch may still carry stale 'flying' / 'betting' status.
-- Filtering by timestamp is what we actually mean.
CREATE OR REPLACE FUNCTION get_rocket_history(p_limit INTEGER DEFAULT 24)
RETURNS TABLE(round_id BIGINT, crash_at_mul NUMERIC, crashed_at TIMESTAMPTZ)
LANGUAGE sql STABLE
AS $$
  SELECT id, crash_at_mul, crashed_at
    FROM rocket_rounds
   WHERE crashed_at < NOW()
   ORDER BY id DESC
   LIMIT p_limit
$$;

GRANT EXECUTE ON FUNCTION get_rocket_history(INTEGER) TO authenticated, anon;

NOTIFY pgrst, 'reload schema';
