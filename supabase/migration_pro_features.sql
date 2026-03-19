-- ╔════════════════════════════════════════════╗
-- ║  PRO Features: commission + leaderboard    ║
-- ╚════════════════════════════════════════════╝

-- 1. Update get_leaderboard to include is_pro
DROP FUNCTION IF EXISTS get_leaderboard(INTEGER);

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
        'total_pnl',  t.pnl,
        'is_pro',     t.is_pro
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
        u.is_pro AND u.pro_expires > NOW() AS is_pro,
        COALESCE(s.pnl, 0) AS pnl
      FROM users u
      LEFT JOIN (
        SELECT user_id, SUM(pnl) AS pnl
        FROM user_daily_stats
        GROUP BY user_id
      ) s ON s.user_id = u.id
      WHERE u.telegram_id != -1
      ORDER BY COALESCE(s.pnl, 0) DESC
      LIMIT p_limit
    ) t
  );
END;
$$;

-- 2. Update finalize_duel to give PRO users lower commission (2.5% instead of 5%)
CREATE OR REPLACE FUNCTION finalize_duel(p_duel_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  d              duels%ROWTYPE;
  v_winner       UUID;
  v_loser        UUID;
  payout         INTEGER;
  v_total_pot    INTEGER;
  v_rake         INTEGER;
  v_guild_fee    INTEGER;
  v_bot_fee      INTEGER;
  v_ref_id       UUID;
  v_bonus        INTEGER;
  v_creator_time REAL;
  v_opp_time     REAL;
  v_season_id    UUID;
  v_winner_wins  INTEGER;
  v_winner_pro   BOOLEAN;
  v_rake_pct     INTEGER;
BEGIN
  SELECT * INTO d FROM duels WHERE id = p_duel_id FOR UPDATE;

  IF d IS NULL THEN
    RETURN jsonb_build_object('error', 'duel_not_found');
  END IF;

  IF d.status = 'finished' THEN
    RETURN jsonb_build_object('error', 'already_finished');
  END IF;

  IF d.creator_score IS NULL OR d.opponent_score IS NULL THEN
    RETURN jsonb_build_object('error', 'scores_incomplete');
  END IF;

  -- Бот-игра: bot_should_win принудительно определяет победителя
  IF d.is_bot_game AND d.bot_should_win IS NOT NULL THEN
    IF d.bot_should_win THEN
      v_winner := d.opponent_id;
      v_loser  := d.creator_id;
    ELSE
      v_winner := d.creator_id;
      v_loser  := d.opponent_id;
    END IF;
  ELSIF d.creator_score > d.opponent_score THEN
    v_winner := d.creator_id;
    v_loser  := d.opponent_id;
  ELSIF d.opponent_score > d.creator_score THEN
    v_winner := d.opponent_id;
    v_loser  := d.creator_id;
  ELSE
    SELECT COALESCE(SUM(time_spent), 75) INTO v_creator_time
    FROM duel_answers WHERE duel_id = p_duel_id AND user_id = d.creator_id;
    SELECT COALESCE(SUM(time_spent), 75) INTO v_opp_time
    FROM duel_answers WHERE duel_id = p_duel_id AND user_id = d.opponent_id;
    IF v_creator_time <= v_opp_time THEN
      v_winner := d.creator_id;
      v_loser  := d.opponent_id;
    ELSE
      v_winner := d.opponent_id;
      v_loser  := d.creator_id;
    END IF;
  END IF;

  -- Проверяем PRO статус победителя
  SELECT (is_pro AND pro_expires > NOW()) INTO v_winner_pro FROM users WHERE id = v_winner;

  -- Экономика: PRO = 2.5% рейк, обычный = 5% рейк
  v_total_pot := d.stake * 2;
  v_rake_pct  := CASE WHEN v_winner_pro THEN 25 ELSE 50 END;  -- 2.5% или 5% (x10 для точности)
  v_rake      := FLOOR(v_total_pot * v_rake_pct / 1000);
  v_guild_fee := FLOOR(v_total_pot * 5 / 1000);  -- 0.5% всегда

  -- Призовой фонд гильдий
  SELECT id INTO v_season_id FROM guild_seasons WHERE is_active = true LIMIT 1;
  IF v_season_id IS NOT NULL THEN
    UPDATE guild_seasons SET prize_pool = prize_pool + v_guild_fee WHERE id = v_season_id;
  END IF;

  -- Обновляем статистику
  UPDATE users SET wins = wins + 1 WHERE id = v_winner;
  UPDATE users SET losses = losses + 1 WHERE id = v_loser;

  -- Реферальный бонус
  SELECT referrer_id INTO v_ref_id FROM referrals WHERE referred_user_id = v_winner;
  IF v_ref_id IS NOT NULL AND v_winner != '00000000-0000-0000-0000-000000000001' THEN
    SELECT wins INTO v_winner_wins FROM users WHERE id = v_winner;
    IF v_winner_wins % 3 = 0 THEN
      v_bonus := GREATEST(1, FLOOR(v_total_pot * 1 / 100));
      v_bot_fee := v_rake - v_guild_fee - v_bonus;
      UPDATE users SET balance = balance + v_bonus WHERE id = v_ref_id;
      INSERT INTO referral_earnings (referrer_id, from_user_id, duel_id, amount)
      VALUES (v_ref_id, v_winner, p_duel_id, v_bonus);
      INSERT INTO transactions (user_id, type, amount, ref_id)
      VALUES (v_ref_id, 'referral_bonus', v_bonus, p_duel_id);
    ELSE
      v_bot_fee := v_rake - v_guild_fee;
    END IF;
  ELSE
    v_bot_fee := v_rake - v_guild_fee;
  END IF;

  -- Победитель получает pot - rake
  payout := v_total_pot - v_rake;

  -- Обновляем баланс победителя
  UPDATE users SET balance = balance + payout WHERE id = v_winner;

  -- Записываем транзакцию выигрыша
  INSERT INTO transactions (user_id, type, amount, ref_id)
  VALUES (v_winner, 'win', payout, p_duel_id);

  -- Обновляем дуэль
  UPDATE duels SET
    status     = 'finished',
    winner_id  = v_winner,
    finished_at = NOW()
  WHERE id = p_duel_id;

  -- Daily stats
  INSERT INTO user_daily_stats (user_id, date, pnl, games, wins)
  VALUES
    (v_winner, CURRENT_DATE, payout - d.stake, 1, 1),
    (v_loser,  CURRENT_DATE, -d.stake,         1, 0)
  ON CONFLICT (user_id, date) DO UPDATE SET
    pnl   = user_daily_stats.pnl   + EXCLUDED.pnl,
    games = user_daily_stats.games + 1,
    wins  = user_daily_stats.wins  + EXCLUDED.wins;

  -- Guild PnL
  PERFORM update_guild_pnl_after_duel(v_winner, payout - d.stake);
  PERFORM update_guild_pnl_after_duel(v_loser,  -d.stake);

  RETURN jsonb_build_object(
    'winner_id', v_winner,
    'loser_id',  v_loser,
    'payout',    payout,
    'rake',      v_rake,
    'is_pro',    COALESCE(v_winner_pro, false)
  );
EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'rpc:finalize_duel', SQLERRM, jsonb_build_object('duel_id', p_duel_id));
  RETURN jsonb_build_object('error', 'internal_error');
END;
$$;

-- 3. Update get_friends_data to include is_pro
DROP FUNCTION IF EXISTS get_friends_data(UUID);

CREATE OR REPLACE FUNCTION get_friends_data(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_friends  JSONB;
  v_incoming JSONB;
  v_outgoing JSONB;
BEGIN
  -- Confirmed friends
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id',         u.id,
      'first_name', u.first_name,
      'username',   u.username,
      'avatar_url', u.avatar_url,
      'last_seen',  u.last_seen,
      'is_pro',     u.is_pro AND u.pro_expires > NOW()
    ) ORDER BY u.last_seen DESC NULLS LAST
  ), '[]'::JSONB)
  INTO v_friends
  FROM friends f
  JOIN users u ON u.id = f.friend_id
  WHERE f.user_id = p_user_id;

  -- Incoming pending requests
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'request_id', fr.id,
      'from_user',  jsonb_build_object(
        'id',         u.id,
        'first_name', u.first_name,
        'username',   u.username,
        'avatar_url', u.avatar_url,
        'is_pro',     u.is_pro AND u.pro_expires > NOW()
      ),
      'created_at', fr.created_at
    ) ORDER BY fr.created_at DESC
  ), '[]'::JSONB)
  INTO v_incoming
  FROM friend_requests fr
  JOIN users u ON u.id = fr.from_id
  WHERE fr.to_id = p_user_id AND fr.status = 'pending';

  -- Outgoing pending request target IDs
  SELECT COALESCE(jsonb_agg(fr.to_id), '[]'::JSONB)
  INTO v_outgoing
  FROM friend_requests fr
  WHERE fr.from_id = p_user_id AND fr.status = 'pending';

  RETURN jsonb_build_object(
    'friends',              v_friends,
    'incoming_requests',    v_incoming,
    'outgoing_request_ids', v_outgoing
  );
END;
$$;

-- 4. Update search_users to include is_pro
DROP FUNCTION IF EXISTS search_users(UUID, TEXT, INTEGER);

CREATE OR REPLACE FUNCTION search_users(p_user_id UUID, p_query TEXT, p_limit INTEGER DEFAULT 20)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  RETURN COALESCE((
    SELECT jsonb_agg(
      jsonb_build_object(
        'id',              sub.id,
        'first_name',      sub.first_name,
        'username',        sub.username,
        'avatar_url',      sub.avatar_url,
        'is_pro',          sub.is_pro,
        'is_friend',       sub.is_friend,
        'request_pending', sub.request_pending
      )
    )
    FROM (
      SELECT
        u.id,
        u.first_name,
        u.username,
        u.avatar_url,
        u.is_pro AND u.pro_expires > NOW() AS is_pro,
        EXISTS (
          SELECT 1 FROM friends f
          WHERE f.user_id = p_user_id AND f.friend_id = u.id
        ) AS is_friend,
        EXISTS (
          SELECT 1 FROM friend_requests fr
          WHERE fr.from_id = p_user_id AND fr.to_id = u.id AND fr.status = 'pending'
        ) AS request_pending
      FROM users u
      WHERE u.id != p_user_id
        AND u.telegram_id != -1
        AND (
          u.first_name ILIKE '%' || p_query || '%'
          OR u.username ILIKE '%' || p_query || '%'
        )
      ORDER BY u.last_seen DESC NULLS LAST
      LIMIT p_limit
    ) sub
  ), '[]'::JSONB);
END;
$$;

-- 5. Patch get_guild_data: add is_pro to member objects
DROP FUNCTION IF EXISTS get_guild_data(UUID);

CREATE OR REPLACE FUNCTION get_guild_data(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_guild_id   UUID;
  v_season_id  UUID;
  v_my_guild   JSONB := 'null'::JSONB;
  v_top_guilds JSONB := '[]'::JSONB;
  v_season     JSONB := 'null'::JSONB;
  v_members    JSONB;
  v_rank       INTEGER;
  v_member_count INTEGER;
BEGIN
  SELECT id INTO v_season_id FROM guild_seasons WHERE is_active = true LIMIT 1;
  IF v_season_id IS NULL THEN
    SELECT id INTO v_season_id FROM guild_seasons ORDER BY end_date DESC LIMIT 1;
  END IF;

  IF v_season_id IS NOT NULL THEN
    SELECT jsonb_build_object('prize_pool', prize_pool, 'end_date', end_date)
    INTO v_season
    FROM guild_seasons WHERE id = v_season_id;
  END IF;

  SELECT gm.guild_id INTO v_guild_id
  FROM guild_members gm WHERE gm.user_id = p_user_id LIMIT 1;

  IF v_guild_id IS NOT NULL THEN
    SELECT COUNT(*) INTO v_member_count FROM guild_members WHERE guild_id = v_guild_id;

    SELECT COALESCE(pos, 999) INTO v_rank
    FROM (
      SELECT g2.id AS guild_id, ROW_NUMBER() OVER (ORDER BY COALESCE(gss2.pnl, 0) DESC) AS pos
      FROM guilds g2
      LEFT JOIN guild_season_stats gss2 ON gss2.guild_id = g2.id AND gss2.season_id = v_season_id
    ) ranked
    WHERE guild_id = v_guild_id;

    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'user_id',    u.id,
        'first_name', u.first_name,
        'username',   u.username,
        'avatar_url', u.avatar_url,
        'role',       gm.role,
        'pnl',        COALESCE(gms.pnl, 0),
        'is_pro',     u.is_pro AND u.pro_expires > NOW()
      ) ORDER BY COALESCE(gms.pnl, 0) DESC
    ), '[]'::JSONB) INTO v_members
    FROM guild_members gm
    JOIN users u ON u.id = gm.user_id
    LEFT JOIN guild_member_stats gms
      ON gms.guild_id = v_guild_id AND gms.user_id = gm.user_id AND gms.season_id = v_season_id
    WHERE gm.guild_id = v_guild_id;

    SELECT jsonb_build_object(
      'id',           g.id,
      'name',         g.name,
      'description',  g.description,
      'avatar_url',   g.avatar_url,
      'creator_id',   g.creator_id,
      'rank',         v_rank,
      'member_count', v_member_count,
      'pnl',          COALESCE(gss.pnl, 0),
      'members',      v_members,
      'creator_name', (SELECT first_name FROM users WHERE id = g.creator_id)
    ) INTO v_my_guild
    FROM guilds g
    LEFT JOIN guild_season_stats gss ON gss.guild_id = g.id AND gss.season_id = v_season_id
    WHERE g.id = v_guild_id;
  END IF;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'id',           g.id,
      'name',         g.name,
      'tag',          LEFT(g.name, 2),
      'member_count', (SELECT COUNT(*) FROM guild_members gm2 WHERE gm2.guild_id = g.id),
      'pnl',          COALESCE(gss.pnl, 0),
      'creator_name', (SELECT first_name FROM users WHERE id = g.creator_id)
    ) ORDER BY COALESCE(gss.pnl, 0) DESC
  ), '[]'::JSONB)
  INTO v_top_guilds
  FROM guilds g
  LEFT JOIN guild_season_stats gss ON gss.guild_id = g.id AND gss.season_id = v_season_id
  LIMIT 20;

  RETURN jsonb_build_object(
    'my_guild',   v_my_guild,
    'top_guilds', v_top_guilds,
    'season',     v_season
  );
END;
$$;
