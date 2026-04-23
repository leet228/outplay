DROP FUNCTION IF EXISTS get_bootstrap_critical_data(UUID);
DROP FUNCTION IF EXISTS get_bootstrap_deferred_data(UUID, INTEGER, INTEGER, INTEGER);

CREATE OR REPLACE FUNCTION get_bootstrap_critical_data(
  p_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN jsonb_build_object(
    'friends_data', get_friends_data(p_user_id),
    'app_settings', get_app_settings()
  );
END;
$$;

CREATE OR REPLACE FUNCTION get_bootstrap_deferred_data(
  p_user_id UUID,
  p_days INTEGER DEFAULT 30,
  p_leaderboard_limit INTEGER DEFAULT 10,
  p_recent_opponents_limit INTEGER DEFAULT 20
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_profile JSONB;
  v_plans JSONB;
BEGIN
  v_profile := get_user_profile(p_user_id, p_days);

  IF v_profile ? 'error' THEN
    RETURN v_profile;
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', id,
        'months', months,
        'price', price,
        'per_month', per_month,
        'savings', savings
      )
      ORDER BY months ASC
    ),
    '[]'::JSONB
  )
  INTO v_plans
  FROM plans
  WHERE is_active = true;

  RETURN jsonb_build_object(
    'profile', v_profile,
    'plans', v_plans,
    'leaderboard', get_leaderboard(p_leaderboard_limit),
    'guild_data', get_guild_data(p_user_id),
    'recent_opponents', get_recent_opponents(p_user_id, p_recent_opponents_limit)
  );
END;
$$;
