-- =============================================
-- Migration: Slot RTP — cleanup and recompute helpers
-- Запусти в Supabase SQL Editor после migration_slot_rtp.sql
-- =============================================

-- ╔═══════════════════════════════════════════╗
-- ║  1. One-time cleanup of pre-RTP rounds   ║
-- ╚═══════════════════════════════════════════╝
-- Delete test rounds played BEFORE the RTP migration was applied.
-- Pre-RTP rounds have fall_at_level = 99 (the default), since the
-- server didn't pre-decide outcomes back then. Real RTP-controlled
-- rounds have fall_at_level between 1 and 50.

DELETE FROM slot_rounds WHERE fall_at_level = 99;

-- ╔═══════════════════════════════════════════╗
-- ║  2. Recompute slot_stats from valid rounds║
-- ╚═══════════════════════════════════════════╝
-- After cleanup, rebuild aggregates from what's left.

UPDATE slot_stats SET
  total_games = 0,
  total_wagered_rub = 0,
  total_paid_rub = 0,
  current_pnl_rub = 0;

UPDATE slot_stats s SET
  total_games        = agg.total_games,
  total_wagered_rub  = agg.total_wagered,
  total_paid_rub     = agg.total_paid,
  current_pnl_rub    = agg.total_wagered - agg.total_paid,
  updated_at         = NOW()
FROM (
  SELECT
    slot_id,
    COUNT(*)         AS total_games,
    SUM(stake_rub)   AS total_wagered,
    SUM(payout_rub)  AS total_paid
  FROM slot_rounds
  WHERE outcome <> 'pending'
  GROUP BY slot_id
) agg
WHERE s.slot_id = agg.slot_id;


-- ╔═══════════════════════════════════════════╗
-- ║  3. Admin RPC: recompute on demand        ║
-- ╚═══════════════════════════════════════════╝
-- Future-proofing — admins can resync slot_stats with slot_rounds at
-- any time (e.g. after manual data correction).

CREATE OR REPLACE FUNCTION admin_recompute_slot_stats(p_slot_id TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated INTEGER := 0;
BEGIN
  -- Reset rows we're going to update
  IF p_slot_id IS NULL THEN
    UPDATE slot_stats SET
      total_games = 0, total_wagered_rub = 0,
      total_paid_rub = 0, current_pnl_rub = 0;
  ELSE
    UPDATE slot_stats SET
      total_games = 0, total_wagered_rub = 0,
      total_paid_rub = 0, current_pnl_rub = 0
    WHERE slot_id = p_slot_id;
  END IF;

  -- Recompute aggregates
  UPDATE slot_stats s SET
    total_games       = agg.total_games,
    total_wagered_rub = agg.total_wagered,
    total_paid_rub    = agg.total_paid,
    current_pnl_rub   = agg.total_wagered - agg.total_paid,
    updated_at        = NOW()
  FROM (
    SELECT
      slot_id,
      COUNT(*)        AS total_games,
      SUM(stake_rub)  AS total_wagered,
      SUM(payout_rub) AS total_paid
    FROM slot_rounds
    WHERE outcome <> 'pending'
      AND (p_slot_id IS NULL OR slot_id = p_slot_id)
    GROUP BY slot_id
  ) agg
  WHERE s.slot_id = agg.slot_id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'updated_slots', v_updated);

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('error', SQLERRM);
END;
$$;

-- ╔═══════════════════════════════════════════╗
-- ║  4. Admin RPC: hard reset (zero stats)    ║
-- ╚═══════════════════════════════════════════╝
-- Wipe a slot's history clean — for cases where you want to start
-- fresh without keeping test data.

CREATE OR REPLACE FUNCTION admin_reset_slot_stats(p_slot_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Drop all rounds for this slot (cascades to nothing — slot_rounds is leaf)
  DELETE FROM slot_rounds WHERE slot_id = p_slot_id;

  -- Zero out stats
  UPDATE slot_stats SET
    total_games = 0,
    total_wagered_rub = 0,
    total_paid_rub = 0,
    current_pnl_rub = 0,
    updated_at = NOW()
  WHERE slot_id = p_slot_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'slot_not_found');
  END IF;

  RETURN jsonb_build_object('ok', true);

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('error', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION admin_recompute_slot_stats(TEXT) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION admin_reset_slot_stats(TEXT) TO authenticated, anon;

NOTIFY pgrst, 'reload schema';
