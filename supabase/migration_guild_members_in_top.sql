-- ╔═══════════════════════════════════════════════════╗
-- ║  1. Seed guild PnL stats                         ║
-- ║  2. Update get_guild_data to include members in   ║
-- ║     top_guilds (not just my_guild)                ║
-- ╚═══════════════════════════════════════════════════╝


-- ═══ 1. Seed guild season stats (PnL per guild) ═══

-- First ensure there's an active season
INSERT INTO guild_seasons (id, start_date, end_date, prize_pool, is_active)
VALUES ('s0000000-0000-0000-0000-000000000001', CURRENT_DATE - 30, CURRENT_DATE + 60, 5000, true)
ON CONFLICT DO NOTHING;

-- Guild PnL (Outplay Elite = +12500, Phantom = +8400)
INSERT INTO guild_season_stats (guild_id, season_id, pnl)
VALUES
  ('a0000000-0000-0000-0000-100000000001', (SELECT id FROM guild_seasons WHERE is_active = true LIMIT 1), 12500),
  ('a0000000-0000-0000-0000-200000000002', (SELECT id FROM guild_seasons WHERE is_active = true LIMIT 1), 8400)
ON CONFLICT (guild_id, season_id) DO UPDATE SET pnl = EXCLUDED.pnl;

-- Member PnL within guilds
INSERT INTO guild_member_stats (guild_id, user_id, season_id, pnl)
VALUES
  -- Outplay Elite members
  ('a0000000-0000-0000-0000-100000000001', '309f8ea0-051f-4df5-9312-d77df569d4c9', (SELECT id FROM guild_seasons WHERE is_active = true LIMIT 1), 4200),
  ('a0000000-0000-0000-0000-100000000001', '1a0bcc5c-e0fb-49db-9a96-f10c76fffa1a', (SELECT id FROM guild_seasons WHERE is_active = true LIMIT 1), 3100),
  ('a0000000-0000-0000-0000-100000000001', '39230228-4054-4cec-be1e-0b9511ac2aa5', (SELECT id FROM guild_seasons WHERE is_active = true LIMIT 1), 2400),
  ('a0000000-0000-0000-0000-100000000001', 'f37260c1-d33e-4c8a-842b-f11ad19f0a64', (SELECT id FROM guild_seasons WHERE is_active = true LIMIT 1), 1500),
  ('a0000000-0000-0000-0000-100000000001', '3549c886-da69-4a15-b114-105f0bd493fd', (SELECT id FROM guild_seasons WHERE is_active = true LIMIT 1), 800),
  ('a0000000-0000-0000-0000-100000000001', 'd056212f-1697-44b3-9405-ce2106a79d18', (SELECT id FROM guild_seasons WHERE is_active = true LIMIT 1), 500),

  -- Phantom members
  ('a0000000-0000-0000-0000-200000000002', '95bf05ae-f585-449b-9afd-61eea72cf364', (SELECT id FROM guild_seasons WHERE is_active = true LIMIT 1), 3200),
  ('a0000000-0000-0000-0000-200000000002', '1c181a0b-b9d6-4780-9aac-7f7b98cf554b', (SELECT id FROM guild_seasons WHERE is_active = true LIMIT 1), 2500),
  ('a0000000-0000-0000-0000-200000000002', '91596299-24f8-474b-9943-8e6fe8ce0b30', (SELECT id FROM guild_seasons WHERE is_active = true LIMIT 1), 1800),
  ('a0000000-0000-0000-0000-200000000002', '9891e383-650a-4ddd-bb61-808146560b1c', (SELECT id FROM guild_seasons WHERE is_active = true LIMIT 1), 900)
ON CONFLICT (guild_id, user_id, season_id) DO UPDATE SET pnl = EXCLUDED.pnl;


-- ═══ 2. Update get_guild_data — add members to top_guilds ═══

CREATE OR REPLACE FUNCTION get_guild_data(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_guild_id    UUID;
  v_season_id   UUID;
  v_my_guild    JSONB := 'null'::JSONB;
  v_top_guilds  JSONB := '[]'::JSONB;
  v_season      JSONB := 'null'::JSONB;
  v_members     JSONB;
  v_rank        INTEGER;
  v_member_count INTEGER;
BEGIN
  -- Active season
  SELECT id INTO v_season_id FROM guild_seasons WHERE is_active = true LIMIT 1;

  IF v_season_id IS NOT NULL THEN
    SELECT jsonb_build_object('prize_pool', prize_pool, 'end_date', end_date)
    INTO v_season FROM guild_seasons WHERE id = v_season_id;
  END IF;

  -- My guild
  SELECT gm.guild_id INTO v_guild_id FROM guild_members gm WHERE gm.user_id = p_user_id LIMIT 1;

  IF v_guild_id IS NOT NULL THEN
    -- Members of my guild
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'user_id',    u.id,
        'first_name', u.first_name,
        'username',   u.username,
        'avatar_url', u.avatar_url,
        'role',       gm.role,
        'is_pro',     u.is_pro AND u.pro_expires > NOW(),
        'pnl',        COALESCE(gms.pnl, 0)
      ) ORDER BY COALESCE(gms.pnl, 0) DESC
    ), '[]'::JSONB) INTO v_members
    FROM guild_members gm
    JOIN users u ON u.id = gm.user_id
    LEFT JOIN guild_member_stats gms ON gms.guild_id = v_guild_id AND gms.user_id = gm.user_id AND gms.season_id = v_season_id
    WHERE gm.guild_id = v_guild_id;

    -- Guild rank
    SELECT COUNT(*) + 1 INTO v_rank
    FROM guild_season_stats gss2
    WHERE gss2.season_id = v_season_id
      AND gss2.pnl > COALESCE((SELECT pnl FROM guild_season_stats WHERE guild_id = v_guild_id AND season_id = v_season_id), 0);

    SELECT COUNT(*) INTO v_member_count FROM guild_members WHERE guild_id = v_guild_id;

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

  -- Top guilds — NOW WITH MEMBERS
  SELECT COALESCE(jsonb_agg(guild_row ORDER BY (guild_row->>'pnl')::int DESC), '[]'::JSONB)
  INTO v_top_guilds
  FROM (
    SELECT jsonb_build_object(
      'id',           g.id,
      'name',         g.name,
      'tag',          LEFT(g.name, 2),
      'member_count', (SELECT COUNT(*) FROM guild_members gm2 WHERE gm2.guild_id = g.id),
      'pnl',          COALESCE(gss.pnl, 0),
      'creator_name', (SELECT first_name FROM users WHERE id = g.creator_id),
      'creator_id',   g.creator_id,
      'description',  g.description,
      'avatar_url',   g.avatar_url,
      'members',      (
        SELECT COALESCE(jsonb_agg(
          jsonb_build_object(
            'user_id',    u.id,
            'first_name', u.first_name,
            'username',   u.username,
            'avatar_url', u.avatar_url,
            'role',       gm3.role,
            'is_pro',     u.is_pro AND u.pro_expires > NOW(),
            'pnl',        COALESCE(gms3.pnl, 0)
          ) ORDER BY COALESCE(gms3.pnl, 0) DESC
        ), '[]'::JSONB)
        FROM guild_members gm3
        JOIN users u ON u.id = gm3.user_id
        LEFT JOIN guild_member_stats gms3 ON gms3.guild_id = g.id AND gms3.user_id = gm3.user_id AND gms3.season_id = v_season_id
        WHERE gm3.guild_id = g.id
      )
    ) AS guild_row
    FROM guilds g
    LEFT JOIN guild_season_stats gss ON gss.guild_id = g.id AND gss.season_id = v_season_id
    LIMIT 20
  ) sub;

  RETURN jsonb_build_object(
    'my_guild',   v_my_guild,
    'top_guilds', v_top_guilds,
    'season',     v_season
  );
END;
$$;
