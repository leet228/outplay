-- ╔══════════════════════════════════════════════════╗
-- ║  Season Prize Distribution                       ║
-- ║  Called when season ends — distributes prize pool ║
-- ║  among top 5 guilds and their members            ║
-- ╚══════════════════════════════════════════════════╝

CREATE OR REPLACE FUNCTION distribute_season_prizes(p_season_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prize_pool   INTEGER;
  v_guild_count  INTEGER;
  v_total_share  NUMERIC;
  v_guild        RECORD;
  v_member       RECORD;
  v_guild_prize  INTEGER;
  v_creator_share INTEGER;
  v_members_pool INTEGER;
  v_total_pos_pnl NUMERIC;
  v_member_share INTEGER;
  v_distributed  INTEGER := 0;
  v_results      JSONB := '[]'::JSONB;

  -- Guild prize percentages by rank (1st to 5th)
  v_percentages  NUMERIC[] := ARRAY[40, 25, 15, 12, 8];
  v_rank         INTEGER := 0;
BEGIN
  -- Get season prize pool
  SELECT prize_pool INTO v_prize_pool
  FROM guild_seasons WHERE id = p_season_id;

  IF v_prize_pool IS NULL THEN
    RETURN jsonb_build_object('error', 'season_not_found');
  END IF;

  IF v_prize_pool <= 0 THEN
    RETURN jsonb_build_object('error', 'empty_prize_pool', 'prize_pool', 0);
  END IF;

  -- Get top guilds by PnL this season (max 5)
  -- Only guilds with positive PnL qualify
  SELECT COUNT(*) INTO v_guild_count
  FROM guild_season_stats
  WHERE season_id = p_season_id AND pnl > 0;

  IF v_guild_count = 0 THEN
    RETURN jsonb_build_object('error', 'no_qualifying_guilds', 'prize_pool', v_prize_pool);
  END IF;

  -- Cap at 5
  IF v_guild_count > 5 THEN v_guild_count := 5; END IF;

  -- Calculate total share percentage (for proportional redistribution if < 5 guilds)
  v_total_share := 0;
  FOR i IN 1..v_guild_count LOOP
    v_total_share := v_total_share + v_percentages[i];
  END LOOP;

  -- Distribute to each qualifying guild
  FOR v_guild IN
    SELECT gss.guild_id, gss.pnl, g.creator_id
    FROM guild_season_stats gss
    JOIN guilds g ON g.id = gss.guild_id
    WHERE gss.season_id = p_season_id AND gss.pnl > 0
    ORDER BY gss.pnl DESC
    LIMIT 5
  LOOP
    v_rank := v_rank + 1;

    -- Guild's share of prize pool (proportionally redistributed)
    v_guild_prize := FLOOR(v_prize_pool * v_percentages[v_rank] / v_total_share);

    IF v_guild_prize <= 0 THEN CONTINUE; END IF;

    -- Creator gets 20% fixed
    v_creator_share := FLOOR(v_guild_prize * 20 / 100);
    v_members_pool := v_guild_prize - v_creator_share;

    -- Credit creator
    UPDATE users SET balance = balance + v_creator_share WHERE id = v_guild.creator_id;
    INSERT INTO transactions (user_id, type, amount, ref_id)
    VALUES (v_guild.creator_id, 'guild_prize', v_creator_share, p_season_id);
    v_distributed := v_distributed + v_creator_share;

    -- Get total positive PnL of non-creator members
    SELECT COALESCE(SUM(gms.pnl), 0) INTO v_total_pos_pnl
    FROM guild_member_stats gms
    JOIN guild_members gm ON gm.guild_id = v_guild.guild_id AND gm.user_id = gms.user_id
    WHERE gms.guild_id = v_guild.guild_id
      AND gms.season_id = p_season_id
      AND gms.user_id != v_guild.creator_id
      AND gms.pnl > 0;

    IF v_total_pos_pnl > 0 AND v_members_pool > 0 THEN
      -- Distribute 80% proportionally by PnL among positive-PnL members
      FOR v_member IN
        SELECT gms.user_id, gms.pnl
        FROM guild_member_stats gms
        JOIN guild_members gm ON gm.guild_id = v_guild.guild_id AND gm.user_id = gms.user_id
        WHERE gms.guild_id = v_guild.guild_id
          AND gms.season_id = p_season_id
          AND gms.user_id != v_guild.creator_id
          AND gms.pnl > 0
        ORDER BY gms.pnl DESC
      LOOP
        v_member_share := FLOOR(v_members_pool * v_member.pnl / v_total_pos_pnl);
        IF v_member_share <= 0 THEN CONTINUE; END IF;

        UPDATE users SET balance = balance + v_member_share WHERE id = v_member.user_id;
        INSERT INTO transactions (user_id, type, amount, ref_id)
        VALUES (v_member.user_id, 'guild_prize', v_member_share, p_season_id);
        v_distributed := v_distributed + v_member_share;
      END LOOP;
    ELSE
      -- No positive-PnL members → creator gets the members pool too
      UPDATE users SET balance = balance + v_members_pool WHERE id = v_guild.creator_id;
      INSERT INTO transactions (user_id, type, amount, ref_id)
      VALUES (v_guild.creator_id, 'guild_prize', v_members_pool, p_season_id);
      v_distributed := v_distributed + v_members_pool;
    END IF;

    v_results := v_results || jsonb_build_object(
      'rank', v_rank,
      'guild_id', v_guild.guild_id,
      'prize', v_guild_prize,
      'creator_share', v_creator_share
    );
  END LOOP;

  -- Log
  PERFORM admin_log('info', 'rpc:distribute_season_prizes',
    'Season prizes distributed',
    jsonb_build_object(
      'season_id', p_season_id,
      'prize_pool', v_prize_pool,
      'distributed', v_distributed,
      'guilds_count', v_rank,
      'details', v_results
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'prize_pool', v_prize_pool,
    'distributed', v_distributed,
    'guilds', v_results
  );
END;
$$;
