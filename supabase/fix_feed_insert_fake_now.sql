-- =============================================
-- Drop-and-recreate feed_insert_fake right now.
-- Run this single block in Supabase SQL Editor.
-- =============================================
--
-- The function currently in the database still has the old INSERT
-- targeting a non-existent `kind` column (created by an earlier draft
-- of migration_plinko.sql / migration_block_blast_rename.sql / v6).
-- CREATE OR REPLACE doesn't always overwrite when the body's column
-- references differ — DROP first, then CREATE, guarantees the new
-- version takes effect on the cron's next tick.

DROP FUNCTION IF EXISTS feed_insert_fake();

CREATE FUNCTION feed_insert_fake()
RETURNS VOID LANGUAGE plpgsql VOLATILE
AS $$
DECLARE
  v_game_ids    TEXT[] := ARRAY['tower-stack', 'tetris-cascade', 'rocket',  'plinko'];
  v_game_labels TEXT[] := ARRAY['Tower Stack', 'Block Blast',    'Rocket',  'Plinko'];
  v_bets INTEGER[] := ARRAY[10, 25, 50, 100, 250, 500, 1000, 2000, 4000, 8000, 16000, 25000];
  v_game_idx INTEGER;
  v_game_id  TEXT;
  v_amount   INTEGER;
  v_is_loss  BOOLEAN;
  r          NUMERIC;
BEGIN
  v_game_idx := 1 + floor(random() * array_length(v_game_ids, 1))::INT;
  v_game_id  := v_game_ids[v_game_idx];

  -- Plinko never shows a loss; other games still get 60 % losses.
  v_is_loss := (v_game_id <> 'plinko') AND (random() < 0.60);

  IF v_is_loss THEN
    r := random();
    v_amount := -CASE
      WHEN r < 0.95 THEN v_bets[1 + floor(random() * 4)::INT]
      WHEN r < 0.98 THEN v_bets[5 + floor(random() * 2)::INT]
      WHEN r < 0.99 THEN v_bets[7 + floor(random() * 2)::INT]
      ELSE              v_bets[9 + floor(random() * 4)::INT]
    END;
  ELSE
    r := random();
    IF r < 0.95 THEN
      v_amount := 10 + floor(random() * 190)::INT;
    ELSIF r < 0.98 THEN
      v_amount := 200 + floor(random() * 1800)::INT;
    ELSIF r < 0.99 THEN
      v_amount := 2000 + floor(random() * 3000)::INT;
    ELSE
      v_amount := 5000 + floor(random() * 20000)::INT;
    END IF;
  END IF;

  INSERT INTO live_feed_events (
    user_name, avatar_emoji, game_id, game_label, amount_rub, is_fake
  ) VALUES (
    'Outplay', '🎰',
    v_game_ids[v_game_idx], v_game_labels[v_game_idx],
    v_amount, true
  );
END;
$$;

NOTIFY pgrst, 'reload schema';

-- Sanity check: run feed_insert_fake() once and verify a row landed.
SELECT public.feed_insert_fake();
SELECT id, user_name, game_id, game_label, amount_rub, is_fake, created_at
FROM live_feed_events
ORDER BY id DESC
LIMIT 1;
