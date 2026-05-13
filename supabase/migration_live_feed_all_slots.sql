-- !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
-- !!! TODO RERUN ON PROD — live-feed canonical fixup for all slots !!!
-- !!! Re-creates feed_insert_fake() and feed_on_slot_round_change   !!!
-- !!! with the FULL slot list, in case earlier slot-specific        !!!
-- !!! migrations were applied in the wrong order on prod and        !!!
-- !!! stripped slots from the rotation.                             !!!
-- !!! Run this LAST so it overrides every prior definition.         !!!
-- !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
-- =============================================
-- Migration: Live Feed — canonical "all slots" fixup
-- Run AFTER every other migration_*.sql in this directory.
-- =============================================
--
-- Background: each slot-specific migration (plinko / pixel_mine /
-- dice / magnetic) re-creates feed_insert_fake() with the full
-- game_ids array AT THE TIME it was written. Since they're
-- non-idempotent and the slot list grows over time, applying
-- them out of order on prod can leave the array shorter than
-- expected — and the missing slots vanish from the fake-event
-- rotation. (E.g. running migration_dice.sql AFTER
-- migration_magnetic.sql wipes 'magnetic' from the array.)
--
-- This file is the canonical definition. Keep it the LAST file
-- you apply when seeding/refreshing prod. If a new slot ships,
-- update THIS file to include it AND re-run.

CREATE OR REPLACE FUNCTION feed_insert_fake()
RETURNS VOID LANGUAGE plpgsql VOLATILE
AS $$
DECLARE
  v_game_ids    TEXT[]    := ARRAY['tower-stack', 'tetris-cascade', 'rocket', 'plinko', 'pixel-mine', 'dice', 'magnetic'];
  v_game_labels TEXT[]    := ARRAY['Tower Stack', 'Block Blast',    'Rocket', 'Plinko', 'Pixel Mine', 'Dice', 'Magnetic'];
  v_bets        INTEGER[] := ARRAY[10, 25, 50, 100, 250, 500, 1000, 2000, 4000, 8000, 16000, 25000];
  v_game_idx    INTEGER;
  v_amount      INTEGER;
  r             NUMERIC;
  v_is_plinko   BOOLEAN;
BEGIN
  -- Uniform pick across every active slot. If you need to weight
  -- the rotation per-slot in the future, swap this for a weighted
  -- sampler.
  v_game_idx := 1 + floor(random() * array_length(v_game_ids, 1))::INT;
  v_is_plinko := v_game_ids[v_game_idx] = 'plinko';

  -- Plinko ALWAYS pays something (min mul = 0.1) so it never shows
  -- a clean loss in the feed. Other slots split 60/40 loss/win.
  IF NOT v_is_plinko AND random() < 0.60 THEN
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


-- Canonical real-round → feed trigger. Same slot list — keeps the
-- player-visible label consistent regardless of which migration
-- was last applied.
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
  ELSIF NEW.slot_id = 'rocket'         THEN v_label := 'Rocket';
  ELSIF NEW.slot_id = 'plinko'         THEN v_label := 'Plinko';
  ELSIF NEW.slot_id = 'pixel-mine'     THEN v_label := 'Pixel Mine';
  ELSIF NEW.slot_id = 'dice'           THEN v_label := 'Dice';
  ELSIF NEW.slot_id = 'magnetic'       THEN v_label := 'Magnetic';
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


NOTIFY pgrst, 'reload schema';
