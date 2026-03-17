-- ╔═══════════════════════════════════════════════════════╗
-- ║  ADMIN WITHDRAWAL — no fees, direct to queue        ║
-- ╚═══════════════════════════════════════════════════════╝

CREATE OR REPLACE FUNCTION admin_request_withdrawal(
  p_admin_user_id UUID,
  p_ton_address   TEXT,
  p_ton_amount    NUMERIC,
  p_memo          TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wd_id UUID;
BEGIN
  IF p_ton_amount <= 0 THEN
    RETURN jsonb_build_object('error', 'invalid_amount');
  END IF;

  IF p_ton_address IS NULL OR LENGTH(TRIM(p_ton_address)) < 10 THEN
    RETURN jsonb_build_object('error', 'invalid_address');
  END IF;

  -- No balance deduction, no fees — admin withdrawal from hot wallet
  -- ton_amount is pre-set so process-withdrawals skips price conversion
  INSERT INTO withdrawals (
    user_id, amount_rub, fee_rub, gas_rub, net_rub,
    ton_amount, ton_address, memo
  )
  VALUES (
    p_admin_user_id,
    0, 0, 0, 0,
    p_ton_amount, TRIM(p_ton_address), COALESCE(TRIM(p_memo), '')
  )
  RETURNING id INTO v_wd_id;

  PERFORM admin_log('info', 'rpc:admin_withdrawal',
    'Admin withdrawal requested',
    jsonb_build_object(
      'withdrawal_id', v_wd_id,
      'ton_amount', p_ton_amount,
      'ton_address', p_ton_address
    )
  );

  RETURN jsonb_build_object('ok', true, 'withdrawal_id', v_wd_id);
END;
$$;

GRANT EXECUTE ON FUNCTION admin_request_withdrawal(UUID, TEXT, NUMERIC, TEXT) TO authenticated;
