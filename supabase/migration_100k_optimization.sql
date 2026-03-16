-- ╔═════════════════════════════════════════════════════════╗
-- ║  Outplay — 100k Optimization Migration                 ║
-- ║  Materialized views, indexes, atomic ops, cleanup      ║
-- ╚═════════════════════════════════════════════════════════╝

-- ═══════════════════════════════════════════
-- 1. Materialized View: pre-aggregated PnL
-- ═══════════════════════════════════════════

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_user_total_pnl AS
SELECT
  user_id,
  SUM(pnl) AS total_pnl
FROM user_daily_stats
GROUP BY user_id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_pnl_user ON mv_user_total_pnl(user_id);
CREATE INDEX IF NOT EXISTS idx_mv_pnl_desc ON mv_user_total_pnl(total_pnl DESC);

-- Refresh function (call via pg_cron every 60s: SELECT cron.schedule('refresh-mv', '* * * * *', 'SELECT refresh_leaderboard_mv()'))
CREATE OR REPLACE FUNCTION refresh_leaderboard_mv()
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_user_total_pnl;
END;
$$;


-- ═══════════════════════════════════════════
-- 2. Rewrite get_leaderboard → use MV
-- ═══════════════════════════════════════════

CREATE OR REPLACE FUNCTION get_leaderboard(p_limit INTEGER DEFAULT 50)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  RETURN (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'id',         t.id,
        'first_name', t.first_name,
        'username',   t.username,
        'avatar_url', t.avatar_url,
        'balance',    t.balance,
        'wins',       t.wins,
        'losses',     t.losses,
        'total_pnl',  t.pnl
      )
      ORDER BY t.pnl DESC
    ), '[]'::JSONB)
    FROM (
      SELECT
        u.id,
        u.first_name,
        u.username,
        u.avatar_url,
        u.balance,
        u.wins,
        u.losses,
        COALESCE(mv.total_pnl, 0) AS pnl
      FROM users u
      LEFT JOIN mv_user_total_pnl mv ON mv.user_id = u.id
      WHERE u.telegram_id != -1
      ORDER BY COALESCE(mv.total_pnl, 0) DESC
      LIMIT p_limit
    ) t
  );
END;
$$;


-- ═══════════════════════════════════════════
-- 3. Rewrite get_user_profile → rank from MV
-- ═══════════════════════════════════════════

CREATE OR REPLACE FUNCTION get_user_profile(p_user_id UUID, p_days INTEGER DEFAULT 30)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_balance     INTEGER;
  v_rank        INTEGER;
  v_stats       JSONB;
  v_total       INTEGER;
  v_ref_day     INTEGER;
  v_ref_week    INTEGER;
  v_ref_month   INTEGER;
  v_ref_all     INTEGER;
BEGIN
  SELECT balance INTO v_balance FROM users WHERE id = p_user_id;
  IF v_balance IS NULL THEN
    RETURN jsonb_build_object('error', 'user_not_found');
  END IF;

  -- Total PnL: live from user_daily_stats (avoids MV staleness after a game)
  SELECT COALESCE(SUM(pnl), 0) INTO v_total
  FROM user_daily_stats WHERE user_id = p_user_id;

  -- Rank: count users with higher PnL (still uses MV for speed — rank can lag a bit)
  SELECT COUNT(*) + 1 INTO v_rank
  FROM mv_user_total_pnl mv
  JOIN users u ON u.id = mv.user_id
  WHERE u.id != '00000000-0000-0000-0000-000000000001'
    AND mv.total_pnl > v_total;

  -- Daily stats for last N days
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object('date', uds.date, 'pnl', uds.pnl, 'games', uds.games, 'wins', uds.wins)
    ORDER BY uds.date ASC
  ), '[]'::JSONB)
  INTO v_stats
  FROM user_daily_stats uds
  WHERE uds.user_id = p_user_id
    AND uds.date >= CURRENT_DATE - (p_days || ' days')::INTERVAL;

  -- Referral earnings by period
  SELECT COALESCE(SUM(amount), 0) INTO v_ref_day
  FROM referral_earnings WHERE referrer_id = p_user_id AND created_at >= CURRENT_DATE;

  SELECT COALESCE(SUM(amount), 0) INTO v_ref_week
  FROM referral_earnings WHERE referrer_id = p_user_id AND created_at >= CURRENT_DATE - INTERVAL '7 days';

  SELECT COALESCE(SUM(amount), 0) INTO v_ref_month
  FROM referral_earnings WHERE referrer_id = p_user_id AND created_at >= CURRENT_DATE - INTERVAL '30 days';

  SELECT COALESCE(SUM(amount), 0) INTO v_ref_all
  FROM referral_earnings WHERE referrer_id = p_user_id;

  RETURN jsonb_build_object(
    'rank',         v_rank,
    'daily_stats',  v_stats,
    'total_pnl',    v_total,
    'ref_earnings', jsonb_build_object('day', v_ref_day, 'week', v_ref_week, 'month', v_ref_month, 'all', v_ref_all)
  );
END;
$$;


-- ═══════════════════════════════════════════
-- 4. Fast question selection (rand_key)
-- ═══════════════════════════════════════════

-- Add random key column for indexed random selection
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'questions' AND column_name = 'rand_key') THEN
    ALTER TABLE questions ADD COLUMN rand_key INTEGER DEFAULT floor(random() * 1000000);
  END IF;
END $$;

UPDATE questions SET rand_key = floor(random() * 1000000) WHERE rand_key IS NULL;
CREATE INDEX IF NOT EXISTS idx_questions_cat_lang_rand ON questions(category, lang, rand_key);
CREATE INDEX IF NOT EXISTS idx_questions_lang_rand ON questions(lang, rand_key);

-- Helper: select N random questions using indexed range scan
CREATE OR REPLACE FUNCTION get_random_questions(p_category TEXT, p_lang TEXT DEFAULT 'ru', p_limit INTEGER DEFAULT 5)
RETURNS UUID[]
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_seed    INTEGER := floor(random() * 1000000);
  v_ids     UUID[];
BEGIN
  -- Try from seed point forward
  IF p_category = 'quiz' THEN
    -- All categories
    SELECT ARRAY(
      SELECT id FROM questions WHERE lang = p_lang AND rand_key >= v_seed ORDER BY rand_key LIMIT p_limit
    ) INTO v_ids;
    -- Wraparound if not enough
    IF v_ids IS NULL OR array_length(v_ids, 1) IS NULL OR array_length(v_ids, 1) < p_limit THEN
      SELECT ARRAY(
        SELECT id FROM questions WHERE lang = p_lang ORDER BY rand_key LIMIT p_limit
      ) INTO v_ids;
    END IF;
  ELSE
    SELECT ARRAY(
      SELECT id FROM questions WHERE category = p_category AND lang = p_lang AND rand_key >= v_seed ORDER BY rand_key LIMIT p_limit
    ) INTO v_ids;
    IF v_ids IS NULL OR array_length(v_ids, 1) IS NULL OR array_length(v_ids, 1) < p_limit THEN
      SELECT ARRAY(
        SELECT id FROM questions WHERE category = p_category AND lang = p_lang ORDER BY rand_key LIMIT p_limit
      ) INTO v_ids;
    END IF;
  END IF;

  RETURN v_ids;
END;
$$;


-- ═══════════════════════════════════════════
-- 5. Rewrite find_match → use get_random_questions
-- ═══════════════════════════════════════════

CREATE OR REPLACE FUNCTION find_match(
  p_user_id   UUID,
  p_category  TEXT,
  p_stakes    INTEGER[],
  p_game_type TEXT DEFAULT 'quiz'
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_opponent      matchmaking_queue%ROWTYPE;
  v_duel_id       UUID;
  v_question_ids  UUID[];
  v_my_balance    INTEGER;
  v_opp_balance   INTEGER;
  v_stake         INTEGER;
  v_matched       BOOLEAN := false;
  v_affected      INTEGER;
  v_bj_deck       JSONB;
  v_bj_state      JSONB;
BEGIN
  SELECT balance INTO v_my_balance FROM users WHERE id = p_user_id;
  IF v_my_balance IS NULL THEN
    RETURN jsonb_build_object('status', 'error', 'error', 'user_not_found');
  END IF;

  SELECT ARRAY(SELECT unnest(p_stakes) ORDER BY 1 DESC) INTO p_stakes;

  FOREACH v_stake IN ARRAY p_stakes LOOP
    IF v_my_balance < v_stake THEN CONTINUE; END IF;

    SELECT * INTO v_opponent
    FROM matchmaking_queue
    WHERE category = p_category
      AND stake = v_stake
      AND user_id != p_user_id
      AND game_type = p_game_type
    ORDER BY joined_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED;

    IF v_opponent IS NOT NULL THEN
      SELECT balance INTO v_opp_balance FROM users WHERE id = v_opponent.user_id;
      IF v_opp_balance IS NOT NULL AND v_opp_balance >= v_stake THEN
        v_matched := true;
        EXIT;
      ELSE
        DELETE FROM matchmaking_queue WHERE id = v_opponent.id;
        v_opponent := NULL;
      END IF;
    END IF;
  END LOOP;

  IF NOT v_matched THEN
    DELETE FROM matchmaking_queue WHERE user_id = p_user_id;
    FOREACH v_stake IN ARRAY p_stakes LOOP
      IF v_my_balance >= v_stake THEN
        INSERT INTO matchmaking_queue (user_id, category, stake, game_type)
        VALUES (p_user_id, p_category, v_stake, p_game_type)
        ON CONFLICT (user_id, stake) DO UPDATE
          SET category = EXCLUDED.category, joined_at = NOW(), game_type = EXCLUDED.game_type;
      END IF;
    END LOOP;
    RETURN jsonb_build_object('status', 'queued');
  END IF;

  -- Questions: use indexed random selection
  IF p_game_type = 'quiz' THEN
    v_question_ids := get_random_questions(p_category, 'ru', 5);

    IF v_question_ids IS NULL OR array_length(v_question_ids, 1) IS NULL OR array_length(v_question_ids, 1) < 5 THEN
      PERFORM admin_log('error', 'rpc:find_match', 'Not enough questions for category',
        jsonb_build_object('category', p_category, 'found', COALESCE(array_length(v_question_ids, 1), 0)));
      RETURN jsonb_build_object('status', 'error', 'error', 'not_enough_questions');
    END IF;
  END IF;

  -- Blackjack deck
  IF p_game_type = 'blackjack' THEN
    v_bj_deck := generate_blackjack_deck();
    v_bj_state := init_blackjack_state(v_bj_deck);
  END IF;

  INSERT INTO duels (creator_id, opponent_id, category, stake, status, question_ids, game_type, bj_deck, bj_state)
  VALUES (v_opponent.user_id, p_user_id, p_category, v_stake, 'active', v_question_ids, p_game_type, v_bj_deck, v_bj_state)
  RETURNING id INTO v_duel_id;

  DELETE FROM matchmaking_queue WHERE user_id IN (p_user_id, v_opponent.user_id);

  UPDATE users SET balance = balance - v_stake WHERE id = p_user_id AND balance >= v_stake;
  GET DIAGNOSTICS v_affected = ROW_COUNT;
  IF v_affected = 0 THEN
    DELETE FROM duels WHERE id = v_duel_id;
    RETURN jsonb_build_object('status', 'error', 'error', 'insufficient_balance');
  END IF;

  UPDATE users SET balance = balance - v_stake WHERE id = v_opponent.user_id AND balance >= v_stake;
  GET DIAGNOSTICS v_affected = ROW_COUNT;
  IF v_affected = 0 THEN
    UPDATE users SET balance = balance + v_stake WHERE id = p_user_id;
    DELETE FROM duels WHERE id = v_duel_id;
    DELETE FROM matchmaking_queue WHERE user_id = v_opponent.user_id AND stake = v_stake;
    RETURN jsonb_build_object('status', 'error', 'error', 'opponent_balance_insufficient');
  END IF;

  INSERT INTO transactions (user_id, type, amount, ref_id)
  VALUES
    (p_user_id, 'duel_loss', -v_stake, v_duel_id),
    (v_opponent.user_id, 'duel_loss', -v_stake, v_duel_id);

  RETURN jsonb_build_object(
    'status', 'matched',
    'duel_id', v_duel_id,
    'opponent_id', v_opponent.user_id,
    'stake', v_stake
  );
EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'rpc:find_match', SQLERRM,
    jsonb_build_object('user_id', p_user_id, 'category', p_category, 'stakes', p_stakes));
  RETURN jsonb_build_object('status', 'error', 'error', SQLERRM);
END;
$$;


-- ═══════════════════════════════════════════
-- 6. Rewrite create_bot_duel → atomic settings
-- ═══════════════════════════════════════════

CREATE OR REPLACE FUNCTION create_bot_duel(
  p_user_id  UUID,
  p_category TEXT,
  p_stakes   INTEGER[]
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_bot_id        UUID := '00000000-0000-0000-0000-000000000001';
  v_my_balance    INTEGER;
  v_stake         INTEGER;
  v_question_ids  UUID[];
  v_duel_id       UUID;
  v_bot_enabled   BOOLEAN;
  v_total_games   INTEGER;
  v_total_wagered INTEGER;
  v_total_paid    INTEGER;
  v_current_pnl   INTEGER;
  v_current_rtp   NUMERIC;
  v_should_win    BOOLEAN;
  v_payout        INTEGER;
  v_affected      INTEGER;
BEGIN
  SELECT (value)::boolean INTO v_bot_enabled FROM app_settings WHERE key = 'bot_enabled';
  IF NOT COALESCE(v_bot_enabled, true) THEN
    RETURN jsonb_build_object('status', 'error', 'error', 'bot_disabled');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM matchmaking_queue WHERE user_id = p_user_id) THEN
    RETURN jsonb_build_object('status', 'error', 'error', 'not_in_queue');
  END IF;

  DELETE FROM matchmaking_queue WHERE user_id = p_user_id;

  SELECT balance INTO v_my_balance FROM users WHERE id = p_user_id;
  IF v_my_balance IS NULL THEN
    RETURN jsonb_build_object('status', 'error', 'error', 'user_not_found');
  END IF;

  SELECT ARRAY(SELECT unnest(p_stakes) ORDER BY 1 DESC) INTO p_stakes;
  v_stake := NULL;
  FOR i IN 1..array_length(p_stakes, 1) LOOP
    IF v_my_balance >= p_stakes[i] THEN
      v_stake := p_stakes[i];
      EXIT;
    END IF;
  END LOOP;

  IF v_stake IS NULL THEN
    RETURN jsonb_build_object('status', 'error', 'error', 'insufficient_balance');
  END IF;

  -- Use indexed random question selection
  v_question_ids := get_random_questions(p_category, 'ru', 5);

  IF v_question_ids IS NULL OR array_length(v_question_ids, 1) IS NULL OR array_length(v_question_ids, 1) < 5 THEN
    RETURN jsonb_build_object('status', 'error', 'error', 'not_enough_questions');
  END IF;

  -- ATOMIC: read all 4 bot settings in one query with FOR UPDATE lock
  SELECT
    MAX(CASE WHEN key = 'bot_total_games'   THEN COALESCE((value)::integer, 0) END),
    MAX(CASE WHEN key = 'bot_total_wagered' THEN COALESCE((value)::integer, 0) END),
    MAX(CASE WHEN key = 'bot_total_paid'    THEN COALESCE((value)::integer, 0) END),
    MAX(CASE WHEN key = 'bot_current_pnl'   THEN COALESCE((value)::integer, 0) END)
  INTO v_total_games, v_total_wagered, v_total_paid, v_current_pnl
  FROM app_settings
  WHERE key IN ('bot_total_games', 'bot_total_wagered', 'bot_total_paid', 'bot_current_pnl')
  FOR UPDATE;

  v_payout := FLOOR(v_stake * 2 * 0.95);

  IF v_current_pnl <= -2000 THEN
    v_should_win := true;
  ELSIF v_total_games < 5 THEN
    v_should_win := random() < 0.55;
  ELSE
    v_current_rtp := (v_total_paid::numeric / NULLIF(v_total_wagered, 0)) * 100;
    IF v_current_rtp IS NULL THEN
      v_should_win := random() < 0.55;
    ELSIF v_current_rtp > 95 THEN
      v_should_win := true;
    ELSIF v_current_rtp < 95 THEN
      v_should_win := false;
    ELSE
      v_should_win := random() < 0.5;
    END IF;
  END IF;

  INSERT INTO duels (creator_id, opponent_id, category, stake, status, question_ids, is_bot_game, bot_should_win)
  VALUES (p_user_id, v_bot_id, p_category, v_stake, 'active', v_question_ids, true, v_should_win)
  RETURNING id INTO v_duel_id;

  UPDATE users SET balance = balance - v_stake WHERE id = p_user_id AND balance >= v_stake;
  GET DIAGNOSTICS v_affected = ROW_COUNT;
  IF v_affected = 0 THEN
    DELETE FROM duels WHERE id = v_duel_id;
    RETURN jsonb_build_object('status', 'error', 'error', 'insufficient_balance');
  END IF;

  UPDATE users SET balance = balance - v_stake WHERE id = v_bot_id;

  INSERT INTO transactions (user_id, type, amount, ref_id)
  VALUES (p_user_id, 'duel_loss', -v_stake, v_duel_id),
         (v_bot_id, 'duel_loss', -v_stake, v_duel_id);

  -- ATOMIC: update all bot settings together
  UPDATE app_settings SET value = to_jsonb(v_total_games + 1), updated_at = NOW() WHERE key = 'bot_total_games';
  UPDATE app_settings SET value = to_jsonb(v_total_wagered + v_stake), updated_at = NOW() WHERE key = 'bot_total_wagered';

  IF NOT v_should_win THEN
    UPDATE app_settings SET value = to_jsonb(v_total_paid + v_payout), updated_at = NOW() WHERE key = 'bot_total_paid';
    UPDATE app_settings SET value = to_jsonb(v_current_pnl - (v_payout - v_stake)), updated_at = NOW() WHERE key = 'bot_current_pnl';
  ELSE
    UPDATE app_settings SET value = to_jsonb(v_current_pnl + v_stake), updated_at = NOW() WHERE key = 'bot_current_pnl';
  END IF;

  RETURN jsonb_build_object(
    'status', 'matched',
    'duel_id', v_duel_id,
    'bot_should_win', v_should_win,
    'stake', v_stake
  );
EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'rpc:create_bot_duel', SQLERRM,
    jsonb_build_object('user_id', p_user_id, 'category', p_category));
  RETURN jsonb_build_object('status', 'error', 'error', SQLERRM);
END;
$$;


-- ═══════════════════════════════════════════
-- 7. Advisory lock for guild PnL updates
-- ═══════════════════════════════════════════

CREATE OR REPLACE FUNCTION update_guild_pnl_after_duel(p_user_id UUID, p_amount INTEGER)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_guild_id  UUID;
  v_season_id UUID;
BEGIN
  SELECT guild_id INTO v_guild_id FROM guild_members WHERE user_id = p_user_id LIMIT 1;
  IF v_guild_id IS NULL THEN RETURN; END IF;

  SELECT id INTO v_season_id FROM guild_seasons WHERE is_active = true LIMIT 1;
  IF v_season_id IS NULL THEN RETURN; END IF;

  -- Serialize updates per guild to prevent deadlocks
  PERFORM pg_advisory_xact_lock(hashtext(v_guild_id::text));

  INSERT INTO guild_member_stats (guild_id, user_id, season_id, pnl)
  VALUES (v_guild_id, p_user_id, v_season_id, p_amount)
  ON CONFLICT (guild_id, user_id, season_id)
  DO UPDATE SET pnl = guild_member_stats.pnl + p_amount;

  INSERT INTO guild_season_stats (guild_id, season_id, pnl)
  VALUES (v_guild_id, v_season_id, p_amount)
  ON CONFLICT (guild_id, season_id)
  DO UPDATE SET pnl = guild_season_stats.pnl + p_amount;
END;
$$;


-- ═══════════════════════════════════════════
-- 8. Missing indexes
-- ═══════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users(last_seen);
CREATE INDEX IF NOT EXISTS idx_game_invites_to_status ON game_invites(to_id, status);
CREATE INDEX IF NOT EXISTS idx_guild_season_stats_guild ON guild_season_stats(guild_id);
CREATE INDEX IF NOT EXISTS idx_duels_winner ON duels(winner_id);


-- ═══════════════════════════════════════════
-- 9. Cleanup expired data
-- ═══════════════════════════════════════════

CREATE OR REPLACE FUNCTION cleanup_expired_data()
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  -- Expire pending game invites
  UPDATE game_invites SET status = 'expired'
  WHERE status = 'pending' AND expires_at < NOW();

  -- Delete old game invites (24h)
  DELETE FROM game_invites WHERE created_at < NOW() - INTERVAL '24 hours';

  -- Cleanup stale matchmaking entries (older than 10 minutes)
  DELETE FROM matchmaking_queue WHERE joined_at < NOW() - INTERVAL '10 minutes';
END;
$$;

-- Schedule: SELECT cron.schedule('cleanup-expired', '*/5 * * * *', 'SELECT cleanup_expired_data()');


-- ═══════════════════════════════════════════
-- 10. Enable realtime on app_settings
-- ═══════════════════════════════════════════

ALTER PUBLICATION supabase_realtime ADD TABLE app_settings;
