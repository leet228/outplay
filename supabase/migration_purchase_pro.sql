-- ╔════════════════════════════════════════════╗
-- ║  PRO Purchase RPC (atomic, bypasses RLS)   ║
-- ╚════════════════════════════════════════════╝

CREATE OR REPLACE FUNCTION purchase_pro(p_user_id UUID, p_price INTEGER, p_months INTEGER)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance INTEGER;
  v_new_balance INTEGER;
  v_expires TIMESTAMPTZ;
BEGIN
  -- Lock user row
  SELECT balance INTO v_balance FROM users WHERE id = p_user_id FOR UPDATE;

  IF v_balance IS NULL THEN
    RETURN jsonb_build_object('error', 'user_not_found');
  END IF;

  IF v_balance < p_price THEN
    RETURN jsonb_build_object('error', 'insufficient_balance');
  END IF;

  v_new_balance := v_balance - p_price;
  v_expires := NOW() + (p_months * 30 || ' days')::INTERVAL;

  -- Update user
  UPDATE users SET
    balance = v_new_balance,
    is_pro = true,
    pro_expires = v_expires
  WHERE id = p_user_id;

  -- Record transaction
  INSERT INTO transactions (user_id, type, amount)
  VALUES (p_user_id, 'pro_subscription', -p_price);

  RETURN jsonb_build_object(
    'ok', true,
    'new_balance', v_new_balance,
    'pro_expires', v_expires
  );
END;
$$;
