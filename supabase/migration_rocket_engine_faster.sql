-- =============================================
-- Rocket Engine — tighten the gap between rounds
-- Run AFTER migration_rocket_engine_simple.sql
-- =============================================
--
-- The 3-second crash hold + the up-to-10-second cron interval add up
-- to a 3–13 s "dead time" between rounds. This patch tightens both:
--   * Hold goes 3s → 1s (final multiplier still visible long enough)
--   * Cron goes 10s → 3s (next round catches up almost instantly)
--
-- Worst-case gap drops to ~2 s; average ~1 s.

-- ── 1. Hold = 1 second instead of 3 ──────────────────────────────
CREATE OR REPLACE FUNCTION rocket_create_round()
RETURNS rocket_rounds
LANGUAGE plpgsql VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bias            TEXT;
  v_crash           NUMERIC;
  v_flight_seconds  NUMERIC;
  v_betting_until   TIMESTAMPTZ;
  v_crashed_at      TIMESTAMPTZ;
  v_hold_until      TIMESTAMPTZ;
  v_round           rocket_rounds;
  v_prev_id         BIGINT;
BEGIN
  SELECT id INTO v_prev_id
    FROM rocket_rounds
   WHERE status <> 'finished'
   ORDER BY id DESC
   LIMIT 1;
  IF v_prev_id IS NOT NULL THEN
    PERFORM rocket_settle_round_losses(v_prev_id);
    UPDATE rocket_rounds SET status = 'finished' WHERE id = v_prev_id;
  END IF;

  v_bias := rocket_decide_bias();
  v_crash := rocket_pick_crash(v_bias);
  v_flight_seconds := rocket_flight_seconds(v_crash);
  v_betting_until := NOW() + INTERVAL '5 seconds';
  v_crashed_at    := v_betting_until + (v_flight_seconds || ' seconds')::INTERVAL;
  -- Hold tightened from 3s → 1s.
  v_hold_until    := v_crashed_at + INTERVAL '1 second';

  INSERT INTO rocket_rounds (
    crash_at_mul, rtp_bias, betting_until, flying_started_at,
    crashed_at, hold_until, status
  )
  VALUES (
    v_crash, v_bias, v_betting_until, v_betting_until,
    v_crashed_at, v_hold_until, 'betting'
  )
  RETURNING * INTO v_round;

  RETURN v_round;

EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'rpc:rocket_create_round', SQLERRM,
    jsonb_build_object('prev_id', v_prev_id, 'bias', v_bias, 'crash', v_crash));
  RAISE;
END;
$$;


-- ── 2. Cron job: 10s → 3s ────────────────────────────────────────
DO $$
BEGIN
  PERFORM cron.unschedule('rocket-engine');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'rocket-engine',
  '3 seconds',
  $$ SELECT public.rocket_ensure_round() $$
);

NOTIFY pgrst, 'reload schema';

-- ╔═══════════════════════════════════════════╗
-- ║  Verify after applying                    ║
-- ╚═══════════════════════════════════════════╝
--
-- a) cron now runs every 3 seconds:
--      SELECT jobid, jobname, schedule FROM cron.job WHERE jobname = 'rocket-engine';
--
-- b) Wait ~30s. Watch rounds appear with gaps <= ~2s after hold:
--      SELECT id, crash_at_mul, status, created_at, hold_until
--        FROM rocket_rounds ORDER BY id DESC LIMIT 10;
