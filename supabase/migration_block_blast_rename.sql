-- =============================================
-- Rename "Tetris Cascade" → "Block Blast" in live-feed display
-- Run AFTER migration_plinko.sql
-- =============================================
--
-- The slot_id stays 'tetris-cascade' so existing rounds / stats / FK
-- references aren't orphaned. Only the human-readable label that
-- surfaces in the LiveFeed component is rebranded.
--
-- Two functions need updating:
--   1. feed_on_slot_round_change — trigger on slot_rounds that posts
--      real wins/losses to the feed
--   2. feed_insert_fake — pg_cron job that seeds the feed with fake
--      events between real ones

-- ── 1. Real-event trigger ────────────────────────────────────────
CREATE OR REPLACE FUNCTION feed_on_slot_round_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_label  TEXT;
  v_amount INTEGER;
BEGIN
  IF    NEW.slot_id = 'tower-stack'    THEN v_label := 'Tower Stack';
  ELSIF NEW.slot_id = 'tetris-cascade' THEN v_label := 'Block Blast';
  ELSIF NEW.slot_id = 'plinko'         THEN v_label := 'Plinko';
  ELSE
    RETURN NEW;
  END IF;

  IF NEW.outcome = 'cashed' AND NEW.payout_rub > 0 THEN
    v_amount := NEW.payout_rub - NEW.stake_rub;
    IF v_amount <= 0 THEN
      v_amount := -NEW.stake_rub;
    END IF;
  ELSIF NEW.outcome = 'fallen' THEN
    v_amount := -NEW.stake_rub;
  ELSE
    RETURN NEW;
  END IF;

  PERFORM feed_insert_real(NEW.user_id, NEW.slot_id, v_label, v_amount);
  RETURN NEW;

EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'trg:feed_on_slot_round_change', SQLERRM,
    jsonb_build_object('round_id', NEW.id));
  RETURN NEW;
END;
$$;


-- ── 2. Fake-event seeder ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION feed_insert_fake()
RETURNS VOID LANGUAGE plpgsql VOLATILE
AS $$
DECLARE
  v_games TEXT[][] := ARRAY[
    ARRAY['tower-stack',    'Tower Stack'],
    ARRAY['tetris-cascade', 'Block Blast'],
    ARRAY['rocket',         'Rocket'],
    ARRAY['plinko',         'Plinko']
  ];
  v_bets INTEGER[] := ARRAY[10, 25, 50, 100, 250, 500, 1000, 2000, 4000, 8000, 16000, 25000];
  v_game_idx INTEGER;
  v_amount   INTEGER;
  r          NUMERIC;
BEGIN
  v_game_idx := 1 + floor(random() * array_length(v_games, 1))::INT;

  IF random() < 0.60 THEN
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
    v_games[v_game_idx][1], v_games[v_game_idx][2],
    v_amount, true
  );
END;
$$;

NOTIFY pgrst, 'reload schema';
