-- =============================================
-- Migration: Rocket Slot — shared crash-style rounds
-- Run AFTER migration_slot_rtp.sql (depends on slot_stats)
-- =============================================
--
-- Architecture (Aviator-style):
--   * Rounds are SHARED across all players — everyone sees the same
--     multiplier at the same wall-clock moment.
--   * Rounds are created LAZILY (no cron): the first client to call
--     get_or_create_current_rocket_round() after the previous round's
--     end timestamp gets a fresh INSERT; everyone else just reads it.
--   * Clients subscribe to the rocket_rounds table via Realtime so a
--     new round broadcasts to all open tabs the moment it's inserted.
--   * Phase = derived from server timestamps; client computes the
--     current multiplier locally between server polls.
--
-- RTP — server pre-decides crash_at_mul with a bias driven by slot_stats
-- (same machinery Tower / Tetris use). Target 95%; tighter bias bands
-- than the other slots so 1k-round RTP stays within ~1-2% of target.

-- ╔═══════════════════════════════════════════╗
-- ║  1. Seed Rocket in slot_stats             ║
-- ╚═══════════════════════════════════════════╝

INSERT INTO slot_stats (slot_id, target_rtp, max_house_deficit_rub)
  VALUES ('rocket', 0.95, 5000)   -- tighter deficit cap for faster correction
  ON CONFLICT (slot_id) DO NOTHING;


-- ╔═══════════════════════════════════════════╗
-- ║  2. Tables                                ║
-- ╚═══════════════════════════════════════════╝

-- One round = one flight from idle → betting → flying → crashed.
-- Status timeline:
--   'betting'  while NOW() < betting_until
--   'flying'   between betting_until and crashed_at
--   'crashed'  after crashed_at; visible 3s as the result hold
--   'finished' once a later round has been created (terminal)

CREATE TABLE IF NOT EXISTS rocket_rounds (
  id                  BIGSERIAL PRIMARY KEY,
  crash_at_mul        NUMERIC(8, 2) NOT NULL CHECK (crash_at_mul >= 1.00),
  rtp_bias            TEXT          NOT NULL DEFAULT 'normal',
  betting_until       TIMESTAMPTZ   NOT NULL,
  flying_started_at   TIMESTAMPTZ   NOT NULL,
  crashed_at          TIMESTAMPTZ   NOT NULL,
  hold_until          TIMESTAMPTZ   NOT NULL,   -- crashed_at + 3s; lobby moves on after this
  status              TEXT          NOT NULL DEFAULT 'betting'
                      CHECK (status IN ('betting', 'flying', 'crashed', 'finished')),
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rocket_rounds_created
  ON rocket_rounds(created_at DESC);


-- One bet = one player's stake in one round.
-- Status:
--   'pending' bet placed, waiting for outcome
--   'cashed'  player cashed out before crash; payout > 0
--   'lost'    crash happened first; payout = 0
CREATE TABLE IF NOT EXISTS rocket_bets (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id        BIGINT        NOT NULL REFERENCES rocket_rounds(id) ON DELETE CASCADE,
  user_id         UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stake_rub       INTEGER       NOT NULL CHECK (stake_rub >= 10 AND stake_rub <= 25000),
  auto_cash_mul   NUMERIC(8, 2),  -- NULL = manual cashout only
  cashed_at_mul   NUMERIC(8, 2),
  payout_rub      INTEGER       NOT NULL DEFAULT 0 CHECK (payout_rub >= 0),
  status          TEXT          NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'cashed', 'lost')),
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_rocket_bets_round
  ON rocket_bets(round_id);
CREATE INDEX IF NOT EXISTS idx_rocket_bets_user_pending
  ON rocket_bets(user_id) WHERE status = 'pending';


-- ╔═══════════════════════════════════════════╗
-- ║  3. Round timing constants                ║
-- ╚═══════════════════════════════════════════╝
-- The growth function: multiplier(t_seconds) = 1.06 ^ t.
-- crash_at_mul → flight duration (seconds) = log(crash_at_mul) / log(1.06).

CREATE OR REPLACE FUNCTION rocket_flight_seconds(p_crash_at_mul NUMERIC)
RETURNS NUMERIC LANGUAGE plpgsql IMMUTABLE STRICT
AS $$
BEGIN
  IF p_crash_at_mul <= 1.0 THEN RETURN 0; END IF;
  RETURN ln(p_crash_at_mul) / ln(1.06);
END;
$$;


-- ╔═══════════════════════════════════════════╗
-- ║  4. Crash sampler with RTP bias           ║
-- ╚═══════════════════════════════════════════╝
-- Inverse-CDF sample of P(crash > x) = house_rtp / x, clamped to [1, 100].
-- house_rtp is driven by the bias picked from slot_stats:
--   normal           → 0.95   → 95% RTP
--   house_recovers   → 0.70   → 70% RTP, lots of early crashes
--   house_concedes   → 1.05   → 105% RTP, fatter winning tail

CREATE OR REPLACE FUNCTION rocket_pick_crash(p_bias TEXT)
RETURNS NUMERIC LANGUAGE plpgsql VOLATILE
AS $$
DECLARE
  v_house_rtp NUMERIC;
  v_u         NUMERIC;
  v_raw       NUMERIC;
BEGIN
  v_house_rtp := CASE p_bias
    WHEN 'house_recovers' THEN 0.70
    WHEN 'house_concedes' THEN 1.05
    ELSE                       0.95
  END;
  v_u   := random();
  v_raw := v_house_rtp / GREATEST(0.0001, 1 - v_u);
  RETURN GREATEST(1.00, LEAST(100.00, ROUND(v_raw, 2)));
END;
$$;


-- ╔═══════════════════════════════════════════╗
-- ║  5. Bias selector                         ║
-- ╚═══════════════════════════════════════════╝
-- Tighter bands (±0.03) than Tower / Tetris (±0.05) so the rocket
-- corrects RTP drift faster on the 1k-round horizon.

CREATE OR REPLACE FUNCTION rocket_decide_bias()
RETURNS TEXT LANGUAGE plpgsql VOLATILE
AS $$
DECLARE
  v_pnl         BIGINT;
  v_wagered     BIGINT;
  v_paid        BIGINT;
  v_target      NUMERIC;
  v_max_deficit INTEGER;
  v_current_rtp NUMERIC;
BEGIN
  SELECT current_pnl_rub, total_wagered_rub, total_paid_rub,
         target_rtp,      max_house_deficit_rub
    INTO v_pnl, v_wagered, v_paid, v_target, v_max_deficit
    FROM slot_stats WHERE slot_id = 'rocket';

  IF v_target IS NULL THEN RETURN 'normal'; END IF;

  IF v_pnl <= -v_max_deficit THEN RETURN 'house_recovers'; END IF;
  IF v_wagered < 10000        THEN RETURN 'normal'; END IF;

  v_current_rtp := v_paid::NUMERIC / NULLIF(v_wagered, 0);
  IF v_current_rtp > v_target + 0.03 THEN RETURN 'house_recovers'; END IF;
  IF v_current_rtp < v_target - 0.03 AND v_pnl > 0 THEN RETURN 'house_concedes'; END IF;
  RETURN 'normal';
END;
$$;


-- ╔═══════════════════════════════════════════╗
-- ║  6. Round timing & lazy creation          ║
-- ╚═══════════════════════════════════════════╝
-- Phase durations:
--   betting → 5 seconds
--   flying  → derived from crash_at_mul
--   crash hold → 3 seconds (visible result, then we move on)

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
  -- Settle the previous round's leftover pending bets and mark it
  -- finished, all in this same transaction.
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
  v_hold_until    := v_crashed_at + INTERVAL '3 seconds';

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


-- get_or_create_current_rocket_round() — main read endpoint.
-- Reads the most recent round and returns it if still within
-- hold_until. Otherwise lazily creates the next round (which also
-- settles the previous round's pending bets in the same transaction).
-- NEVER writes on the hot path — phase is computed by the caller from
-- timestamps, so we don't need to bump status row-by-row.
CREATE OR REPLACE FUNCTION get_or_create_current_rocket_round()
RETURNS rocket_rounds
LANGUAGE plpgsql VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_round rocket_rounds;
BEGIN
  SELECT * INTO v_round
    FROM rocket_rounds
   ORDER BY id DESC
   LIMIT 1;

  -- No rounds at all → create the first under an advisory lock so two
  -- concurrent first-callers don't both INSERT.
  IF v_round.id IS NULL THEN
    PERFORM pg_advisory_xact_lock(72321);
    SELECT * INTO v_round FROM rocket_rounds ORDER BY id DESC LIMIT 1;
    IF v_round.id IS NULL THEN
      v_round := rocket_create_round();
    END IF;
    RETURN v_round;
  END IF;

  -- Current round still within its visible window → no writes.
  IF NOW() < v_round.hold_until THEN
    RETURN v_round;
  END IF;

  -- Hold expired → spawn next round (under advisory lock, with a
  -- second peek inside the lock in case another client beat us to it).
  PERFORM pg_advisory_xact_lock(72321);
  SELECT * INTO v_round FROM rocket_rounds ORDER BY id DESC LIMIT 1;
  IF NOW() < v_round.hold_until THEN
    RETURN v_round;
  END IF;

  v_round := rocket_create_round();
  RETURN v_round;

EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'rpc:get_or_create_current_rocket_round', SQLERRM,
    jsonb_build_object('current_id', v_round.id));
  RAISE;
END;
$$;


-- Pure helper: marks every still-pending bet on a round as 'lost' and
-- bumps slot_stats accordingly. Idempotent — calling twice is a no-op.
CREATE OR REPLACE FUNCTION rocket_settle_round_losses(p_round_id BIGINT)
RETURNS VOID
LANGUAGE plpgsql VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lost_count   INTEGER;
  v_lost_wagered BIGINT;
BEGIN
  -- Pending bets become losses; their stake adds to slot_stats wagered
  -- (paid stays at 0 → full house pnl gain).
  WITH closed AS (
    UPDATE rocket_bets
       SET status = 'lost', finished_at = NOW()
     WHERE round_id = p_round_id AND status = 'pending'
     RETURNING stake_rub
  )
  SELECT COUNT(*), COALESCE(SUM(stake_rub), 0)
    INTO v_lost_count, v_lost_wagered
    FROM closed;

  IF v_lost_count > 0 THEN
    UPDATE slot_stats
       SET total_games        = total_games + v_lost_count,
           total_wagered_rub  = total_wagered_rub + v_lost_wagered,
           current_pnl_rub    = current_pnl_rub + v_lost_wagered,
           updated_at         = NOW()
     WHERE slot_id = 'rocket';
  END IF;

EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'rpc:rocket_settle_round_losses', SQLERRM,
    jsonb_build_object('round_id', p_round_id));
END;
$$;


-- ╔═══════════════════════════════════════════╗
-- ║  7. Place bet                             ║
-- ╚═══════════════════════════════════════════╝
-- Validates: round exists, NOW() < betting_until, user has balance,
-- user doesn't already have a pending bet on this round (one bet per
-- round per user).

CREATE OR REPLACE FUNCTION place_rocket_bet(
  p_user_id        UUID,
  p_round_id       BIGINT,
  p_stake_rub      INTEGER,
  p_auto_cash_mul  NUMERIC DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_round   rocket_rounds;
  v_balance INTEGER;
  v_bet_id  UUID;
  v_existing UUID;
BEGIN
  IF p_stake_rub IS NULL OR p_stake_rub < 10 OR p_stake_rub > 25000 THEN
    RETURN jsonb_build_object('error', 'invalid_stake');
  END IF;

  IF p_auto_cash_mul IS NOT NULL AND p_auto_cash_mul <= 1.00 THEN
    RETURN jsonb_build_object('error', 'invalid_auto_cash');
  END IF;

  SELECT * INTO v_round FROM rocket_rounds WHERE id = p_round_id FOR UPDATE;
  IF v_round.id IS NULL THEN
    RETURN jsonb_build_object('error', 'round_not_found');
  END IF;

  IF v_round.status <> 'betting' OR NOW() >= v_round.betting_until THEN
    RETURN jsonb_build_object('error', 'betting_closed');
  END IF;

  -- One bet per round per user.
  SELECT id INTO v_existing
    FROM rocket_bets
   WHERE round_id = p_round_id AND user_id = p_user_id;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('error', 'bet_already_placed');
  END IF;

  -- Lock + debit balance.
  SELECT balance INTO v_balance FROM users WHERE id = p_user_id FOR UPDATE;
  IF v_balance IS NULL THEN
    RETURN jsonb_build_object('error', 'user_not_found');
  END IF;
  IF v_balance < p_stake_rub THEN
    RETURN jsonb_build_object('error', 'insufficient_balance');
  END IF;

  UPDATE users SET balance = balance - p_stake_rub WHERE id = p_user_id;

  INSERT INTO rocket_bets (round_id, user_id, stake_rub, auto_cash_mul)
    VALUES (p_round_id, p_user_id, p_stake_rub, p_auto_cash_mul)
    RETURNING id INTO v_bet_id;

  INSERT INTO transactions (user_id, type, amount, ref_id)
    VALUES (p_user_id, 'slot_bet', -p_stake_rub, v_bet_id);

  RETURN jsonb_build_object(
    'ok', true,
    'bet_id', v_bet_id,
    'balance', v_balance - p_stake_rub
  );

EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'rpc:place_rocket_bet', SQLERRM,
    jsonb_build_object('user_id', p_user_id, 'round_id', p_round_id, 'stake', p_stake_rub));
  RETURN jsonb_build_object('error', SQLERRM);
END;
$$;


-- ╔═══════════════════════════════════════════╗
-- ║  8. Cash out                              ║
-- ╚═══════════════════════════════════════════╝
-- Server computes the live multiplier from (NOW() - flying_started_at)
-- and verifies it's still below crash_at_mul. Auto-cash hits (sent by
-- the client when the local multiplier crosses the threshold) are
-- accepted up to the auto value as long as that value is also < crash.

CREATE OR REPLACE FUNCTION cashout_rocket_bet(
  p_bet_id       UUID,
  p_at_mul       NUMERIC DEFAULT NULL  -- optional client-claimed multiplier (auto-cash)
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bet         rocket_bets;
  v_round       rocket_rounds;
  v_now         TIMESTAMPTZ;
  v_elapsed     NUMERIC;
  v_live_mul    NUMERIC;
  v_cash_at     NUMERIC;
  v_payout      INTEGER;
  v_new_balance INTEGER;
BEGIN
  SELECT * INTO v_bet FROM rocket_bets WHERE id = p_bet_id FOR UPDATE;
  IF v_bet.id IS NULL THEN
    RETURN jsonb_build_object('error', 'bet_not_found');
  END IF;
  IF v_bet.status <> 'pending' THEN
    RETURN jsonb_build_object('error', 'already_settled');
  END IF;

  SELECT * INTO v_round FROM rocket_rounds WHERE id = v_bet.round_id FOR SHARE;
  IF v_round.id IS NULL THEN
    RETURN jsonb_build_object('error', 'round_not_found');
  END IF;

  v_now := NOW();
  IF v_now < v_round.flying_started_at THEN
    RETURN jsonb_build_object('error', 'not_flying_yet');
  END IF;

  -- Compute the live multiplier as of NOW(). 1.06 ^ elapsed_seconds.
  v_elapsed  := EXTRACT(EPOCH FROM (v_now - v_round.flying_started_at));
  v_live_mul := POWER(1.06, v_elapsed);

  -- If the live multiplier already crossed the crash → too late.
  IF v_live_mul >= v_round.crash_at_mul OR v_now >= v_round.crashed_at THEN
    -- Settle as a loss now.
    UPDATE rocket_bets SET status = 'lost', finished_at = v_now WHERE id = p_bet_id;
    UPDATE slot_stats
       SET total_games       = total_games + 1,
           total_wagered_rub = total_wagered_rub + v_bet.stake_rub,
           current_pnl_rub   = current_pnl_rub + v_bet.stake_rub,
           updated_at        = NOW()
     WHERE slot_id = 'rocket';
    RETURN jsonb_build_object('error', 'too_late', 'crash_at_mul', v_round.crash_at_mul);
  END IF;

  -- Pick the cash-out multiplier: server's live value clamped by the
  -- client's claim (auto-cash should fire AT its target, not later).
  v_cash_at := v_live_mul;
  IF p_at_mul IS NOT NULL AND p_at_mul > 1.00 AND p_at_mul < v_live_mul THEN
    v_cash_at := p_at_mul;
  END IF;
  v_cash_at := ROUND(v_cash_at, 2);

  v_payout := FLOOR(v_bet.stake_rub * v_cash_at)::INTEGER;

  UPDATE rocket_bets
     SET status        = 'cashed',
         cashed_at_mul = v_cash_at,
         payout_rub    = v_payout,
         finished_at   = v_now
   WHERE id = p_bet_id;

  UPDATE users SET balance = balance + v_payout WHERE id = v_bet.user_id;

  INSERT INTO transactions (user_id, type, amount, ref_id)
    VALUES (v_bet.user_id, 'slot_win', v_payout, p_bet_id);

  -- Update the player's daily stats and the slot's running totals.
  UPDATE slot_stats
     SET total_games        = total_games + 1,
         total_wagered_rub  = total_wagered_rub + v_bet.stake_rub,
         total_paid_rub     = total_paid_rub + v_payout,
         current_pnl_rub    = current_pnl_rub + (v_bet.stake_rub - v_payout),
         updated_at         = NOW()
   WHERE slot_id = 'rocket';

  INSERT INTO user_daily_stats (user_id, date, pnl, games, wins)
    VALUES (
      v_bet.user_id, CURRENT_DATE, v_payout - v_bet.stake_rub, 1,
      CASE WHEN v_payout > v_bet.stake_rub THEN 1 ELSE 0 END
    )
    ON CONFLICT (user_id, date)
    DO UPDATE SET
      pnl   = user_daily_stats.pnl + (v_payout - v_bet.stake_rub),
      games = user_daily_stats.games + 1,
      wins  = user_daily_stats.wins + CASE WHEN v_payout > v_bet.stake_rub THEN 1 ELSE 0 END;

  PERFORM update_guild_pnl_after_duel(v_bet.user_id, v_payout - v_bet.stake_rub);

  SELECT balance INTO v_new_balance FROM users WHERE id = v_bet.user_id;

  RETURN jsonb_build_object(
    'ok', true,
    'cashed_at_mul', v_cash_at,
    'payout', v_payout,
    'balance', v_new_balance
  );

EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'rpc:cashout_rocket_bet', SQLERRM,
    jsonb_build_object('bet_id', p_bet_id, 'at_mul', p_at_mul));
  RETURN jsonb_build_object('error', SQLERRM);
END;
$$;


-- ╔═══════════════════════════════════════════╗
-- ║  9. Recent history                        ║
-- ╚═══════════════════════════════════════════╝
-- Returns the last N finished/crashed crash multipliers — drives the
-- chip strip in the UI.

-- Server clock — clients use this once on mount to compensate for
-- desktop clock drift (countdown / multiplier all driven by it).
CREATE OR REPLACE FUNCTION get_server_now()
RETURNS BIGINT
LANGUAGE sql STABLE
AS $$
  SELECT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
$$;


-- Frontend error sink — wrappers in supabase.js call this when a
-- Rocket RPC returns an error or a Realtime subscription fails, so
-- the failure shows up in admin_logs alongside server-side ones.
CREATE OR REPLACE FUNCTION client_log_error(
  p_scope    TEXT,
  p_message  TEXT,
  p_payload  JSONB DEFAULT '{}'::jsonb
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM admin_log(
    'error',
    'client:' || COALESCE(LEFT(p_scope, 60),  'unknown'),
    LEFT(COALESCE(p_message, '(no message)'), 500),
    COALESCE(p_payload, '{}'::jsonb)
  );
END;
$$;


-- Filter by timestamp, not status — any round whose flight is over
-- counts as history regardless of how its status column ended up.
CREATE OR REPLACE FUNCTION get_rocket_history(p_limit INTEGER DEFAULT 24)
RETURNS TABLE(round_id BIGINT, crash_at_mul NUMERIC, crashed_at TIMESTAMPTZ)
LANGUAGE sql STABLE
AS $$
  SELECT id, crash_at_mul, crashed_at
    FROM rocket_rounds
   WHERE crashed_at < NOW()
   ORDER BY id DESC
   LIMIT p_limit
$$;


-- ╔═══════════════════════════════════════════╗
-- ║ 10. Player's bet for a round              ║
-- ╚═══════════════════════════════════════════╝
-- Lets the client check whether the user already has a bet on the
-- current round (e.g., after a page reload during flight).

CREATE OR REPLACE FUNCTION get_my_rocket_bet(p_user_id UUID, p_round_id BIGINT)
RETURNS rocket_bets
LANGUAGE sql STABLE
AS $$
  SELECT * FROM rocket_bets
   WHERE user_id = p_user_id AND round_id = p_round_id
   LIMIT 1
$$;


-- ╔═══════════════════════════════════════════╗
-- ║ 11. RLS, Realtime, Grants                 ║
-- ╚═══════════════════════════════════════════╝

ALTER TABLE rocket_rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE rocket_bets   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rocket_rounds_read_all ON rocket_rounds;
CREATE POLICY rocket_rounds_read_all ON rocket_rounds FOR SELECT USING (true);

DROP POLICY IF EXISTS rocket_bets_read_own ON rocket_bets;
CREATE POLICY rocket_bets_read_own ON rocket_bets FOR SELECT USING (true);

-- Realtime: clients subscribe to inserts on rocket_rounds so they
-- learn about new rounds the moment they're created.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND tablename = 'rocket_rounds'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE rocket_rounds';
  END IF;
END $$;

GRANT EXECUTE ON FUNCTION rocket_flight_seconds(NUMERIC)              TO authenticated, anon;
GRANT EXECUTE ON FUNCTION rocket_pick_crash(TEXT)                     TO authenticated, anon;
GRANT EXECUTE ON FUNCTION rocket_decide_bias()                        TO authenticated, anon;
GRANT EXECUTE ON FUNCTION rocket_create_round()                       TO authenticated, anon;
GRANT EXECUTE ON FUNCTION rocket_settle_round_losses(BIGINT)          TO authenticated, anon;
GRANT EXECUTE ON FUNCTION get_or_create_current_rocket_round()        TO authenticated, anon;
GRANT EXECUTE ON FUNCTION place_rocket_bet(UUID, BIGINT, INTEGER, NUMERIC)
                                                                       TO authenticated, anon;
GRANT EXECUTE ON FUNCTION cashout_rocket_bet(UUID, NUMERIC)           TO authenticated, anon;
GRANT EXECUTE ON FUNCTION get_rocket_history(INTEGER)                 TO authenticated, anon;
GRANT EXECUTE ON FUNCTION get_my_rocket_bet(UUID, BIGINT)             TO authenticated, anon;
GRANT EXECUTE ON FUNCTION get_server_now()                            TO authenticated, anon;
GRANT EXECUTE ON FUNCTION client_log_error(TEXT, TEXT, JSONB)         TO authenticated, anon;

NOTIFY pgrst, 'reload schema';

-- ╔═══════════════════════════════════════════╗
-- ║  DONE!                                    ║
-- ╚═══════════════════════════════════════════╝
