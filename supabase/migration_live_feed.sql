-- =============================================
-- Live feed of slot wins/losses
-- =============================================
--
-- Drives the activity ribbon shown under the Slots tab on Home. Each
-- row is one slot outcome (win or loss) — real ones come from
-- triggers on slot_rounds and rocket_bets, fake ones are generated
-- by a pg_cron job every few seconds so the feed is always moving
-- even when no one's playing.
--
-- Single source of truth: every client subscribes to INSERTs on this
-- table via Supabase Realtime, so all users see the same ribbon at
-- the same wall-clock moment, with zero polling.
--
-- The table caps at ~200 rows via a cleanup cron job; only the last
-- 30 are ever rendered, so the working set is tiny.

-- ╔═══════════════════════════════════════════╗
-- ║  1. Table                                 ║
-- ╚═══════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS live_feed_events (
  id            BIGSERIAL PRIMARY KEY,
  user_name     TEXT      NOT NULL,
  avatar_emoji  TEXT      NOT NULL,
  game_id       TEXT      NOT NULL,    -- 'tower-stack' | 'tetris-cascade' | 'rocket'
  game_label    TEXT      NOT NULL,    -- human-readable name
  amount_rub    INTEGER   NOT NULL,    -- positive=win, negative=loss
  is_fake       BOOLEAN   NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_live_feed_events_id_desc
  ON live_feed_events(id DESC);


-- ╔═══════════════════════════════════════════╗
-- ║  2. Read endpoint                         ║
-- ╚═══════════════════════════════════════════╝

CREATE OR REPLACE FUNCTION get_live_feed(p_limit INTEGER DEFAULT 30)
RETURNS SETOF live_feed_events
LANGUAGE sql STABLE
AS $$
  SELECT *
    FROM live_feed_events
   ORDER BY id DESC
   LIMIT GREATEST(1, LEAST(100, p_limit))
$$;


-- ╔═══════════════════════════════════════════╗
-- ║  3. Helper — pick a random fake stake     ║
-- ╚═══════════════════════════════════════════╝
-- Stakes mirror the BETS array used by every slot's UI:
--   [10, 25, 50, 100, 250, 500, 1000, 2000, 4000, 8000, 16000, 25000]
-- Distribution is log-weighted toward the smaller stakes (most
-- players bet 10–500 ₽; 25k is rare).

CREATE OR REPLACE FUNCTION feed_random_stake()
RETURNS INTEGER LANGUAGE plpgsql VOLATILE
AS $$
DECLARE
  v_bets   INTEGER[] := ARRAY[10, 25, 50, 100, 250, 500, 1000, 2000, 4000, 8000, 16000, 25000];
  v_idx    INTEGER;
  r        NUMERIC := random();
BEGIN
  -- 50% small (10-100), 30% medium (250-1000), 15% large (2000-8000),
  -- 5% premium (16000-25000)
  IF    r < 0.50 THEN v_idx := 1 + floor(random() * 4)::INT;        -- 1..4  → 10-100
  ELSIF r < 0.80 THEN v_idx := 5 + floor(random() * 3)::INT;        -- 5..7  → 250-1000
  ELSIF r < 0.95 THEN v_idx := 8 + floor(random() * 3)::INT;        -- 8..10 → 2000-8000
  ELSE                v_idx := 11 + floor(random() * 2)::INT;       -- 11,12 → 16000-25000
  END IF;
  RETURN v_bets[v_idx];
END;
$$;


-- ╔═══════════════════════════════════════════╗
-- ║  4. Helper — fake feed insert             ║
-- ╚═══════════════════════════════════════════╝
-- ~150 hand-curated names + 30 emojis cycled at random. ~65% of
-- events are losses (negative stake), 35% are wins (stake × mul
-- with a long tail).

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

  -- Distribution of |amount|:
  --   95 %  1–199 ₽
  --    3 %  200–1 999 ₽
  --    1 %  2 000–4 999 ₽
  --    1 %  5 000–24 999 ₽
  r := random();
  v_abs := CASE
    WHEN r < 0.95 THEN 1   + floor(random() * 199 )::INT
    WHEN r < 0.98 THEN 200 + floor(random() * 1800)::INT
    WHEN r < 0.99 THEN 2000 + floor(random() * 3000)::INT
    ELSE              5000 + floor(random() * 20000)::INT
  END;

  -- 60 % loss, 40 % win.
  IF random() < 0.60 THEN
    v_amount := -v_abs;
  ELSE
    v_amount :=  v_abs;
  END IF;

  -- user_name / avatar_emoji are kept on the row but not surfaced in
  -- the UI — placeholder values so the columns stay populated.
  INSERT INTO live_feed_events (
    user_name, avatar_emoji, game_id, game_label, amount_rub, is_fake
  ) VALUES (
    'Outplay', '🎰', v_games[v_game_idx][1], v_games[v_game_idx][2], v_amount, true
  );
END;
$$;


-- ╔═══════════════════════════════════════════╗
-- ║  5. Helper — emit real event              ║
-- ╚═══════════════════════════════════════════╝
-- Used by triggers; pulls a display name from users (first_name →
-- username → fallback to a short id stub) and a stable emoji from
-- a hash of the user id so the same player always shows the same
-- avatar.

CREATE OR REPLACE FUNCTION feed_insert_real(
  p_user_id    UUID,
  p_game_id    TEXT,
  p_game_label TEXT,
  p_amount_rub INTEGER
)
RETURNS VOID LANGUAGE plpgsql VOLATILE
AS $$
DECLARE
  v_emojis     TEXT[] := ARRAY[
    '🦁', '🐯', '🐺', '🦊', '🐉', '🦅', '🦄', '👑', '🃏', '🎭',
    '🚀', '⚡', '💎', '🔥', '⭐', '✨', '💰', '🏆', '🎯', '🎰',
    '🦈', '🐲', '🐧', '🦉', '🦇', '🐝', '🌟', '🎪', '🎲', '🎮'
  ];
  v_first  TEXT;
  v_uname  TEXT;
  v_name   TEXT;
  v_emoji  TEXT;
  v_hash   INTEGER;
BEGIN
  SELECT first_name, username
    INTO v_first, v_uname
    FROM users WHERE id = p_user_id;

  v_name := COALESCE(NULLIF(v_first, ''), NULLIF(v_uname, ''),
                     'Игрок_' || SUBSTR(p_user_id::TEXT, 1, 4));

  -- Stable per-user emoji: hash UUID, mod into the array.
  v_hash := abs(hashtext(p_user_id::TEXT));
  v_emoji := v_emojis[1 + (v_hash % array_length(v_emojis, 1))];

  INSERT INTO live_feed_events (
    user_name, avatar_emoji, game_id, game_label, amount_rub, is_fake
  ) VALUES (
    v_name, v_emoji, p_game_id, p_game_label, p_amount_rub, false
  );
END;
$$;


-- ╔═══════════════════════════════════════════╗
-- ║  6. Triggers on slot_rounds, rocket_bets  ║
-- ╚═══════════════════════════════════════════╝
-- slot_rounds covers Tower Stack and Tetris Cascade. We fire on the
-- transition to a terminal state (cashed/fallen). 'aborted' is
-- skipped — that's a UI-leave, not a played round, no spam in the
-- feed.

CREATE OR REPLACE FUNCTION feed_on_slot_round_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_label  TEXT;
  v_amount INTEGER;
BEGIN
  IF NEW.slot_id = 'tower-stack'    THEN v_label := 'Tower Stack';
  ELSIF NEW.slot_id = 'tetris-cascade' THEN v_label := 'Tetris Cascade';
  ELSE
    -- Unknown slot — don't surface it in the feed.
    RETURN NEW;
  END IF;

  IF NEW.outcome = 'cashed' AND NEW.payout_rub > 0 THEN
    v_amount := NEW.payout_rub;  -- positive: win
  ELSIF NEW.outcome = 'fallen' THEN
    v_amount := -NEW.stake_rub;  -- negative: loss
  ELSE
    RETURN NEW;                  -- aborted / pending — skip
  END IF;

  PERFORM feed_insert_real(NEW.user_id, NEW.slot_id, v_label, v_amount);
  RETURN NEW;

EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'trg:feed_on_slot_round_change', SQLERRM,
    jsonb_build_object('round_id', NEW.id));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_live_feed_slot_rounds ON slot_rounds;
CREATE TRIGGER trg_live_feed_slot_rounds
AFTER UPDATE OF outcome ON slot_rounds
FOR EACH ROW
WHEN (OLD.outcome = 'pending' AND NEW.outcome IN ('cashed', 'fallen'))
EXECUTE FUNCTION feed_on_slot_round_change();


-- rocket_bets fires on the bet's transition to cashed (win) or lost.
CREATE OR REPLACE FUNCTION feed_on_rocket_bet_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_amount INTEGER;
BEGIN
  IF NEW.status = 'cashed' AND NEW.payout_rub > 0 THEN
    v_amount := NEW.payout_rub;
  ELSIF NEW.status = 'lost' THEN
    v_amount := -NEW.stake_rub;
  ELSE
    RETURN NEW;
  END IF;

  PERFORM feed_insert_real(NEW.user_id, 'rocket', 'Rocket', v_amount);
  RETURN NEW;

EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'trg:feed_on_rocket_bet_change', SQLERRM,
    jsonb_build_object('bet_id', NEW.id));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_live_feed_rocket_bets ON rocket_bets;
CREATE TRIGGER trg_live_feed_rocket_bets
AFTER UPDATE OF status ON rocket_bets
FOR EACH ROW
WHEN (OLD.status = 'pending' AND NEW.status IN ('cashed', 'lost'))
EXECUTE FUNCTION feed_on_rocket_bet_change();


-- ╔═══════════════════════════════════════════╗
-- ║  7. pg_cron: fake events + cleanup        ║
-- ╚═══════════════════════════════════════════╝

DO $$ BEGIN PERFORM cron.unschedule('live-feed-fake');    EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN PERFORM cron.unschedule('live-feed-cleanup'); EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- One fake event every 4 seconds. Sub-minute schedules are supported
-- on this Supabase project (rocket-engine runs every 3 seconds too).
SELECT cron.schedule(
  'live-feed-fake',
  '4 seconds',
  $$ SELECT public.feed_insert_fake() $$
);

-- Cleanup every 5 minutes — keep the last 200 rows, drop the rest.
SELECT cron.schedule(
  'live-feed-cleanup',
  '*/5 * * * *',
  $$
    DELETE FROM live_feed_events
     WHERE id < (SELECT COALESCE(MAX(id), 0) - 200 FROM live_feed_events)
  $$
);


-- ╔═══════════════════════════════════════════╗
-- ║  8. RLS, Realtime, Grants                 ║
-- ╚═══════════════════════════════════════════╝

ALTER TABLE live_feed_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS live_feed_read_all ON live_feed_events;
CREATE POLICY live_feed_read_all ON live_feed_events FOR SELECT USING (true);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND tablename = 'live_feed_events'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE live_feed_events';
  END IF;
END $$;

GRANT EXECUTE ON FUNCTION get_live_feed(INTEGER)  TO authenticated, anon;
-- feed_insert_fake / feed_insert_real / feed_random_stake are
-- internal — no public grants.

NOTIFY pgrst, 'reload schema';

-- ╔═══════════════════════════════════════════╗
-- ║  Verify after applying                    ║
-- ╚═══════════════════════════════════════════╝
--
-- a) Wait 10s, then:
--      SELECT id, user_name, avatar_emoji, game_label, amount_rub, is_fake, created_at
--        FROM live_feed_events ORDER BY id DESC LIMIT 10;
--    Fake rows should be appearing every ~4s.
--
-- b) Cron jobs:
--      SELECT jobid, jobname, schedule, command FROM cron.job
--       WHERE jobname LIKE 'live-feed-%' ORDER BY jobid;
