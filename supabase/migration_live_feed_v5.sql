-- =============================================
-- Live feed v5 — losses snap to real stake values
-- Run AFTER migration_live_feed_v4.sql
-- =============================================
--
-- A loss is just "the player's stake burned" — so it can only be one
-- of the values from the BETS array used by every slot's UI:
--   10, 25, 50, 100, 250, 500, 1000, 2000, 4000, 8000, 16000, 25000
--
-- Wins are freeform (stake × multiplier ⇒ any rounded number) so we
-- keep the wide distribution there.
--
-- Distribution targets (same as v2):
--   95 % < 200 ₽
--    3 % 200–2 000 ₽
--    1 % 2 000–5 000 ₽
--    1 % 5 000–25 000 ₽
-- and 60 % loss / 40 % win.

CREATE OR REPLACE FUNCTION feed_insert_fake()
RETURNS VOID LANGUAGE plpgsql VOLATILE
AS $$
DECLARE
  v_games TEXT[][] := ARRAY[
    ARRAY['tower-stack',    'Tower Stack'],
    ARRAY['tetris-cascade', 'Tetris Cascade'],
    ARRAY['rocket',         'Rocket']
  ];
  v_bets INTEGER[] := ARRAY[10, 25, 50, 100, 250, 500, 1000, 2000, 4000, 8000, 16000, 25000];
  v_game_idx INTEGER;
  v_amount   INTEGER;
  v_abs      INTEGER;
  r          NUMERIC;
BEGIN
  v_game_idx := 1 + floor(random() * 3)::INT;

  -- 60 % loss, 40 % win.
  IF random() < 0.60 THEN
    -- LOSS: must be one of the real stake values. Bucketed so the
    -- amount distribution still hits the 95/3/1/1 split.
    r := random();
    v_amount := -CASE
      WHEN r < 0.95 THEN v_bets[1 + floor(random() * 4)::INT]   -- idx 1..4 → 10/25/50/100
      WHEN r < 0.98 THEN v_bets[5 + floor(random() * 2)::INT]   -- idx 5..6 → 250/500
      WHEN r < 0.99 THEN v_bets[7 + floor(random() * 2)::INT]   -- idx 7..8 → 1000/2000
      ELSE              v_bets[9 + floor(random() * 4)::INT]    -- idx 9..12 → 4000-25000
    END;
  ELSE
    -- WIN: any amount, same magnitude distribution as before.
    r := random();
    v_abs := CASE
      WHEN r < 0.95 THEN 1   + floor(random() * 199 )::INT
      WHEN r < 0.98 THEN 200 + floor(random() * 1800)::INT
      WHEN r < 0.99 THEN 2000 + floor(random() * 3000)::INT
      ELSE              5000 + floor(random() * 20000)::INT
    END;
    v_amount := v_abs;
  END IF;

  INSERT INTO live_feed_events (
    user_name, avatar_emoji, game_id, game_label, amount_rub, is_fake
  ) VALUES (
    'Outplay', '🎰', v_games[v_game_idx][1], v_games[v_game_idx][2], v_amount, true
  );
END;
$$;

NOTIFY pgrst, 'reload schema';
