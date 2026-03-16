-- ╔═════════════════════════════════════════════════════════╗
-- ║  Outplay — Guild Season Finalization Cron              ║
-- ║  Auto-distribute prize pool + rotate seasons           ║
-- ╚═════════════════════════════════════════════════════════╝

-- ═══════════════════════════════════════════
-- 1. Season reward history table
-- ═══════════════════════════════════════════

CREATE TABLE IF NOT EXISTS season_rewards (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id   UUID NOT NULL REFERENCES guild_seasons(id),
  guild_id    UUID NOT NULL REFERENCES guilds(id),
  guild_rank  INTEGER NOT NULL,           -- 1-5
  guild_share INTEGER NOT NULL,           -- amount allocated to this guild
  user_id     UUID NOT NULL REFERENCES users(id),
  reward_type TEXT NOT NULL CHECK (reward_type IN ('creator', 'top_member')),
  member_rank INTEGER,                    -- NULL for creator, 1-5 for top members
  amount      INTEGER NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_season_rewards_season ON season_rewards(season_id);
CREATE INDEX IF NOT EXISTS idx_season_rewards_user ON season_rewards(user_id);


-- ═══════════════════════════════════════════
-- 2. Main finalization function
-- ═══════════════════════════════════════════
--
-- Distribution between top 5 guilds (by season PnL):
--   1st: 40%  |  2nd: 25%  |  3rd: 15%  |  4th: 12%  |  5th: 8%
--
-- Distribution within each guild:
--   Creator:  20% (always, regardless of PnL rank)
--   ALL other members with pnl > 0 share 80%, weighted by rank:
--     weight(rank) = (N - rank + 1), where N = total eligible members
--     share = weight / sum_of_all_weights * 80% of guild_share
--
-- If creator IS top 1 in PnL → they get 20% (creator share only).
-- Their PnL rank slot cascades: everyone below shifts up.
-- Only members with pnl > 0 are eligible for rewards.
--

CREATE OR REPLACE FUNCTION finalize_guild_season()
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_season_id         UUID;
  v_prize_pool        INTEGER;
  v_end_date          TIMESTAMPTZ;
  v_new_season_id     UUID;
  v_start_date        TIMESTAMPTZ;

  -- Guild distribution: top 5 guilds
  v_guild_pcts        INTEGER[] := ARRAY[40, 25, 15, 12, 8];

  -- Creator always gets 20%, remaining 80% split among all members by rank weight
  v_creator_pct       INTEGER := 20;
  v_member_pool_pct   INTEGER := 80;

  v_guild             RECORD;
  v_guild_share       INTEGER;
  v_guild_rank        INTEGER := 0;

  v_member            RECORD;
  v_creator_id        UUID;
  v_member_share      INTEGER;
  v_member_rank       INTEGER;
  v_member_count      INTEGER;
  v_weight_sum        INTEGER;
  v_member_pool       INTEGER;  -- 80% of guild share in stars
  v_guild_distributed INTEGER;
  v_total_distributed INTEGER := 0;
  v_guilds_rewarded   INTEGER := 0;
  v_results           JSONB := '[]'::JSONB;
BEGIN
  -- 1. Get active season
  SELECT id, prize_pool, end_date
  INTO v_season_id, v_prize_pool, v_end_date
  FROM guild_seasons
  WHERE is_active = true
  LIMIT 1;

  IF v_season_id IS NULL THEN
    RETURN jsonb_build_object('status', 'error', 'error', 'no_active_season');
  END IF;

  -- 2. Check if season ended
  IF v_end_date > NOW() THEN
    RETURN jsonb_build_object('status', 'not_ended', 'end_date', v_end_date);
  END IF;

  -- 3. If prize pool is 0 or negative — just rotate
  IF v_prize_pool <= 0 THEN
    UPDATE guild_seasons SET is_active = false WHERE id = v_season_id;

    v_start_date := NOW();
    INSERT INTO guild_seasons (start_date, end_date, prize_pool, is_active)
    VALUES (v_start_date, v_start_date + INTERVAL '30 days', 0, true)
    RETURNING id INTO v_new_season_id;

    RETURN jsonb_build_object(
      'status', 'rotated',
      'old_season_id', v_season_id,
      'new_season_id', v_new_season_id,
      'prize_distributed', 0
    );
  END IF;

  -- 4. Distribute to top 5 guilds
  FOR v_guild IN
    SELECT gss.guild_id, gss.pnl, g.creator_id, g.name AS guild_name
    FROM guild_season_stats gss
    JOIN guilds g ON g.id = gss.guild_id
    WHERE gss.season_id = v_season_id
      AND gss.pnl > 0
    ORDER BY gss.pnl DESC
    LIMIT 5
  LOOP
    v_guild_rank := v_guild_rank + 1;
    v_guilds_rewarded := v_guilds_rewarded + 1;
    v_guild_share := FLOOR(v_prize_pool * v_guild_pcts[v_guild_rank]::NUMERIC / 100);
    v_creator_id := v_guild.creator_id;
    v_guild_distributed := 0;

    -- ── Creator share (20%) ──
    v_member_share := FLOOR(v_guild_share * v_creator_pct::NUMERIC / 100);
    IF v_member_share > 0 THEN
      UPDATE users SET balance = balance + v_member_share WHERE id = v_creator_id;

      INSERT INTO transactions (user_id, type, amount, ref_id)
      VALUES (v_creator_id, 'season_reward', v_member_share, v_season_id);

      INSERT INTO season_rewards (season_id, guild_id, guild_rank, guild_share, user_id, reward_type, member_rank, amount)
      VALUES (v_season_id, v_guild.guild_id, v_guild_rank, v_guild_share, v_creator_id, 'creator', NULL, v_member_share);

      v_guild_distributed := v_guild_distributed + v_member_share;
    END IF;

    -- ── ALL non-creator members share 80%, weighted by rank ──
    -- Count eligible members first (pnl > 0, not creator)
    SELECT COUNT(*) INTO v_member_count
    FROM guild_member_stats gms
    WHERE gms.guild_id = v_guild.guild_id
      AND gms.season_id = v_season_id
      AND gms.user_id != v_creator_id
      AND gms.pnl > 0;

    IF v_member_count > 0 THEN
      -- Weight sum = N*(N+1)/2 where N = member_count
      v_weight_sum := v_member_count * (v_member_count + 1) / 2;
      v_member_pool := FLOOR(v_guild_share * v_member_pool_pct::NUMERIC / 100);

      v_member_rank := 0;
      FOR v_member IN
        SELECT gms.user_id, gms.pnl
        FROM guild_member_stats gms
        WHERE gms.guild_id = v_guild.guild_id
          AND gms.season_id = v_season_id
          AND gms.user_id != v_creator_id   -- skip creator (already paid)
          AND gms.pnl > 0
        ORDER BY gms.pnl DESC
      LOOP
        v_member_rank := v_member_rank + 1;
        -- weight = N - rank + 1 (top 1 gets highest weight)
        v_member_share := FLOOR(v_member_pool * (v_member_count - v_member_rank + 1)::NUMERIC / v_weight_sum);

        IF v_member_share > 0 THEN
          UPDATE users SET balance = balance + v_member_share WHERE id = v_member.user_id;

          INSERT INTO transactions (user_id, type, amount, ref_id)
          VALUES (v_member.user_id, 'season_reward', v_member_share, v_season_id);

          INSERT INTO season_rewards (season_id, guild_id, guild_rank, guild_share, user_id, reward_type, member_rank, amount)
          VALUES (v_season_id, v_guild.guild_id, v_guild_rank, v_guild_share, v_member.user_id, 'top_member', v_member_rank, v_member_share);

          v_guild_distributed := v_guild_distributed + v_member_share;
        END IF;
      END LOOP;
    END IF;

    v_total_distributed := v_total_distributed + v_guild_distributed;

    -- Build per-guild result summary
    v_results := v_results || jsonb_build_object(
      'rank', v_guild_rank,
      'guild', v_guild.guild_name,
      'guild_share', v_guild_share,
      'distributed', v_guild_distributed
    );
  END LOOP;

  -- 5. Deactivate old season
  UPDATE guild_seasons SET is_active = false WHERE id = v_season_id;

  -- 6. Create new season (30 days)
  v_start_date := NOW();
  INSERT INTO guild_seasons (start_date, end_date, prize_pool, is_active)
  VALUES (v_start_date, v_start_date + INTERVAL '30 days', 0, true)
  RETURNING id INTO v_new_season_id;

  -- 7. Log
  PERFORM admin_log('info', 'cron:finalize_guild_season',
    'Season finalized: distributed ' || v_total_distributed || ' to ' || v_guilds_rewarded || ' guilds',
    jsonb_build_object(
      'old_season_id', v_season_id,
      'new_season_id', v_new_season_id,
      'prize_pool', v_prize_pool,
      'distributed', v_total_distributed,
      'guilds', v_results
    )
  );

  RETURN jsonb_build_object(
    'status', 'finalized',
    'old_season_id', v_season_id,
    'new_season_id', v_new_season_id,
    'prize_pool', v_prize_pool,
    'total_distributed', v_total_distributed,
    'guilds_rewarded', v_guilds_rewarded,
    'details', v_results
  );

EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'cron:finalize_guild_season', SQLERRM,
    jsonb_build_object('season_id', v_season_id));
  RETURN jsonb_build_object('status', 'error', 'error', SQLERRM);
END;
$$;


-- ═══════════════════════════════════════════
-- 3. Schedule: run daily at 00:05 UTC
-- ═══════════════════════════════════════════
--
-- Run in Supabase SQL Editor AFTER enabling pg_cron:
--
--   SELECT cron.schedule(
--     'finalize-guild-season',
--     '5 0 * * *',
--     'SELECT finalize_guild_season()'
--   );
--
-- This runs at 00:05 UTC every day. If the season hasn't
-- ended yet, it returns 'not_ended' and does nothing.
-- When the season IS over, it distributes prizes and
-- creates a new 30-day season automatically.
