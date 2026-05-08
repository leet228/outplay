-- =============================================
-- Live feed v6 — show real win amount, never auto-flip to "loss"
-- Run AFTER migration_block_blast_rename.sql
-- =============================================
--
-- The previous trigger flipped any "payout < stake" round into a
-- "−stake" loss row. That's wrong:
--
--   * Plinko ALWAYS pays something (min mul = 0.1 on HIGH risk),
--     so a 100-ball launch with stake 100 ₽ that pays back 5 000 ₽
--     was being shown as "−10 000 ₽" (full launch stake) in the feed,
--     even though the player got 5 000 ₽ back.
--
--   * Feed should report what the player actually saw on the win
--     bar — gross payout, not net pnl. Net pnl is for stats / admin,
--     not a public ticker.
--
-- New rule, applied to every slot:
--   * payout > 0 → display +payout (the gross amount they won)
--   * payout = 0 → display -stake   (clean wipeout, real loss)
--
-- Plus: the fake-event seeder now special-cases plinko so its fake
-- entries are ALWAYS positive (matches the math — you can't lose
-- in plinko, you can only get less than your stake back). Other
-- slots keep the 60 % loss / 40 % win mix.
--
-- Also re-asserts the pg_cron schedule (4 seconds) in case the
-- previous job got dropped.

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

  -- Show GROSS payout if any was credited, otherwise the lost stake.
  -- Don't fold "payout < stake" into a fake loss — the player did get
  -- a win, the feed should reflect what they actually saw.
  IF NEW.outcome = 'cashed' AND NEW.payout_rub > 0 THEN
    v_amount := NEW.payout_rub;
  ELSIF NEW.outcome IN ('cashed', 'fallen') THEN
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
-- Plinko gets ONLY positive entries (matches the math).
-- Other games keep the 60/40 loss/win split.
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
  v_game_id  TEXT;
  v_amount   INTEGER;
  v_is_loss  BOOLEAN;
  r          NUMERIC;
BEGIN
  v_game_idx := 1 + floor(random() * array_length(v_games, 1))::INT;
  v_game_id  := v_games[v_game_idx][1];

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
    v_games[v_game_idx][1], v_games[v_game_idx][2],
    v_amount, true
  );
END;
$$;


-- ── 3. Re-assert pg_cron schedule ────────────────────────────────
-- If the live-feed-fake job is missing (cron was reset / migration
-- skipped), re-schedule it. Idempotent: existing schedule is replaced.
DO $$ BEGIN PERFORM cron.unschedule('live-feed-fake'); EXCEPTION WHEN OTHERS THEN NULL; END $$;

SELECT cron.schedule(
  'live-feed-fake',
  '4 seconds',
  $$ SELECT public.feed_insert_fake() $$
);

NOTIFY pgrst, 'reload schema';
