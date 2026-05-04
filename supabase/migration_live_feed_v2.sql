-- =============================================
-- Live feed v2 — new amount distribution, simplified payload
-- Run AFTER migration_live_feed.sql
-- =============================================
--
-- Tightens the fake events:
--   * 95 % of events have |amount| < 200 ₽
--   *  3 % between 200–2 000 ₽
--   *  1 % between 2 000–5 000 ₽
--   *  1 % between 5 000–25 000 ₽
--   * 60 % losses, 40 % wins (so the ribbon reads more like a real
--     casino feed where most spins lose)
--
-- The user_name / avatar_emoji columns are kept for backwards
-- compatibility but no longer appear in the UI — the new design
-- only shows the slot's icon + name + payout. We populate them with
-- harmless placeholders so the column constraints stay happy.

CREATE OR REPLACE FUNCTION feed_insert_fake()
RETURNS VOID LANGUAGE plpgsql VOLATILE
AS $$
DECLARE
  v_games TEXT[][] := ARRAY[
    ARRAY['tower-stack',    'Tower Stack'],
    ARRAY['tetris-cascade', 'Tetris Cascade'],
    ARRAY['rocket',         'Rocket']
  ];
  v_game_idx INTEGER;
  v_amount   INTEGER;
  v_abs      INTEGER;
  r          NUMERIC;
BEGIN
  v_game_idx := 1 + floor(random() * 3)::INT;

  -- Magnitude. Independent of win/loss so both sides share the same
  -- distribution; matches "ставки" reality (most plays are tiny).
  r := random();
  v_abs := CASE
    WHEN r < 0.95 THEN 1   + floor(random() * 199 )::INT      --   1–199
    WHEN r < 0.98 THEN 200 + floor(random() * 1800)::INT      -- 200–1 999
    WHEN r < 0.99 THEN 2000 + floor(random() * 3000)::INT     -- 2 000–4 999
    ELSE              5000 + floor(random() * 20000)::INT     -- 5 000–24 999
  END;

  -- 60 % loss, 40 % win (matches the live casino vibe in the user's
  -- reference screenshot — most lines are red).
  IF random() < 0.60 THEN
    v_amount := -v_abs;
  ELSE
    v_amount :=  v_abs;
  END IF;

  INSERT INTO live_feed_events (
    user_name, avatar_emoji, game_id, game_label, amount_rub, is_fake
  ) VALUES (
    'Outplay', '🎰', v_games[v_game_idx][1], v_games[v_game_idx][2], v_amount, true
  );
END;
$$;

NOTIFY pgrst, 'reload schema';
