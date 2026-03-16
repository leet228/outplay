-- Fix: get_user_profile reads total_pnl live from user_daily_stats
-- instead of mv_user_total_pnl (which refreshes every 60s via cron).
-- This ensures totalPnl is accurate immediately after a game finishes.

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
