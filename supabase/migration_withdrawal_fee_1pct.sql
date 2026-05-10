-- =============================================
-- Withdrawal platform fee: 2 % → 1 %
-- Run AFTER migration_withdrawals.sql
-- =============================================
--
-- The original request_withdrawal RPC used a hard-coded FEE_RATE of
-- 0.02 (2 %). Per business decision we're cutting the platform fee
-- in half — to 1 %. This migration redefines the function with the
-- new rate. Existing pending / completed withdrawal rows keep their
-- historical fee_rub values; only NEW withdrawals charge the new
-- rate.
--
-- Gas (~3 ₽) is unchanged.

CREATE OR REPLACE FUNCTION request_withdrawal(
  p_user_id     UUID,
  p_amount_rub  INTEGER,
  p_ton_address TEXT,
  p_memo        TEXT DEFAULT ''
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_balance   INTEGER;
  v_fee       INTEGER;
  v_gas       INTEGER;
  v_net       INTEGER;
  v_wd_id     UUID;
  MIN_AMOUNT  CONSTANT INTEGER := 50;
  FEE_RATE    CONSTANT NUMERIC := 0.01;  -- ← cut from 0.02 (2 %) to 0.01 (1 %)
  GAS_RUB     CONSTANT INTEGER := 3;     -- ~0.01 TON ≈ 2.5 RUB, rounded up
BEGIN
  -- Validate amount
  IF p_amount_rub < MIN_AMOUNT THEN
    RETURN jsonb_build_object('error', 'min_amount', 'min', MIN_AMOUNT);
  END IF;

  -- Lock user row & check balance
  SELECT balance INTO v_balance
  FROM users WHERE id = p_user_id FOR UPDATE;

  IF v_balance IS NULL THEN
    RETURN jsonb_build_object('error', 'user_not_found');
  END IF;

  IF v_balance < p_amount_rub THEN
    RETURN jsonb_build_object('error', 'insufficient_balance', 'balance', v_balance);
  END IF;

  -- Calculate fees
  v_fee := CEIL(p_amount_rub * FEE_RATE);
  v_gas := GAS_RUB;
  v_net := p_amount_rub - v_fee - v_gas;

  IF v_net <= 0 THEN
    RETURN jsonb_build_object('error', 'amount_too_small_after_fees');
  END IF;

  -- Deduct balance atomically
  UPDATE users SET balance = balance - p_amount_rub WHERE id = p_user_id;

  -- Insert withdrawal
  INSERT INTO withdrawals (user_id, amount_rub, fee_rub, gas_rub, net_rub, ton_address, memo)
  VALUES (p_user_id, p_amount_rub, v_fee, v_gas, v_net, p_ton_address, COALESCE(p_memo, ''))
  RETURNING id INTO v_wd_id;

  -- Log transaction
  INSERT INTO transactions (user_id, type, amount, ref_id)
  VALUES (p_user_id, 'withdrawal', -p_amount_rub, v_wd_id);

  -- Admin log
  PERFORM admin_log('info', 'rpc:request_withdrawal',
    'Withdrawal requested',
    jsonb_build_object(
      'withdrawal_id', v_wd_id,
      'user_id', p_user_id,
      'amount_rub', p_amount_rub,
      'net_rub', v_net,
      'ton_address', p_ton_address
    )
  );

  RETURN jsonb_build_object('ok', true, 'withdrawal_id', v_wd_id, 'new_balance', v_balance - p_amount_rub);
END;
$$;

NOTIFY pgrst, 'reload schema';
