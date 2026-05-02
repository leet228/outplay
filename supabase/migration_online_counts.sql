-- =============================================
-- Migration: Per-game online counters
-- Запусти в Supabase SQL Editor
-- =============================================

-- ╔═══════════════════════════════════════════╗
-- ║  Indexes (defensive — likely already      ║
-- ║  present from prior migrations)           ║
-- ╚═══════════════════════════════════════════╝

CREATE INDEX IF NOT EXISTS idx_matchmaking_queue_game_type
  ON matchmaking_queue(game_type);

CREATE INDEX IF NOT EXISTS idx_duels_active_game_type
  ON duels(game_type) WHERE status = 'active';


-- ╔═══════════════════════════════════════════╗
-- ║  RPC: get_game_online_counts              ║
-- ╚═══════════════════════════════════════════╝
-- Returns { game_type → number_of_online_players }
-- "Online" = users currently in matchmaking queue PLUS players in
-- active duels (each active duel contributes 2 players).
-- Indexes above keep this query in the sub-millisecond range even at
-- thousands of concurrent users.

CREATE OR REPLACE FUNCTION get_game_online_counts()
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result JSONB := '{}'::JSONB;
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT
      COALESCE(q.game_type, d.game_type) AS game_type,
      COALESCE(q.cnt, 0) + COALESCE(d.cnt * 2, 0) AS total
    FROM (
      SELECT game_type, COUNT(*)::INTEGER AS cnt
      FROM matchmaking_queue
      GROUP BY game_type
    ) q
    FULL OUTER JOIN (
      SELECT game_type, COUNT(*)::INTEGER AS cnt
      FROM duels
      WHERE status = 'active'
      GROUP BY game_type
    ) d ON q.game_type = d.game_type
  LOOP
    v_result := v_result || jsonb_build_object(rec.game_type, rec.total);
  END LOOP;

  RETURN v_result;

EXCEPTION WHEN OTHERS THEN
  -- On any error, return empty object — front-end falls back to fake-only.
  RETURN '{}'::JSONB;
END;
$$;

GRANT EXECUTE ON FUNCTION get_game_online_counts() TO authenticated, anon;

NOTIFY pgrst, 'reload schema';
