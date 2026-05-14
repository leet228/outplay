-- !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
-- !!! TODO RUN ON PROD — admin USDT (Toncoin) withdrawal RPC.     !!!
-- !!! Mirrors admin_request_withdrawal but inserts asset='usdt-ton'!!!
-- !!! and stores the amount in `usdt_amount` so the Edge Function !!!
-- !!! skips price conversion (just like ton_amount does for TON). !!!
-- !!! Run AFTER migration_usdt_withdrawals.sql.                   !!!
-- !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
-- ╔═══════════════════════════════════════════════════════╗
-- ║  ADMIN USDT WITHDRAWAL — no fees, direct to queue   ║
-- ╚═══════════════════════════════════════════════════════╝

CREATE OR REPLACE FUNCTION admin_request_usdt_withdrawal(
  p_admin_user_id UUID,
  p_ton_address   TEXT,
  p_usdt_amount   NUMERIC,
  p_memo          TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wd_id UUID;
BEGIN
  IF p_usdt_amount <= 0 THEN
    RETURN jsonb_build_object('error', 'invalid_amount');
  END IF;

  IF p_ton_address IS NULL OR LENGTH(TRIM(p_ton_address)) < 10 THEN
    RETURN jsonb_build_object('error', 'invalid_address');
  END IF;

  -- No balance deduction, no fees — admin withdrawal from hot wallet.
  -- usdt_amount is pre-set so process-withdrawals skips the
  -- net_rub / usd-rub-rate conversion. asset='usdt-ton' makes the
  -- Edge Function build a jetton-transfer body for this row.
  INSERT INTO withdrawals (
    user_id, amount_rub, fee_rub, gas_rub, net_rub,
    usdt_amount, ton_address, memo, asset
  )
  VALUES (
    p_admin_user_id,
    0, 0, 0, 0,
    p_usdt_amount, TRIM(p_ton_address), COALESCE(TRIM(p_memo), ''), 'usdt-ton'
  )
  RETURNING id INTO v_wd_id;

  PERFORM admin_log('info', 'rpc:admin_usdt_withdrawal',
    'Admin USDT withdrawal requested',
    jsonb_build_object(
      'withdrawal_id', v_wd_id,
      'usdt_amount',   p_usdt_amount,
      'ton_address',   p_ton_address
    )
  );

  RETURN jsonb_build_object('ok', true, 'withdrawal_id', v_wd_id);
END;
$$;

GRANT EXECUTE ON FUNCTION admin_request_usdt_withdrawal(UUID, TEXT, NUMERIC, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
