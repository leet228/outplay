-- !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
-- !!! TODO RUN ON PROD — adds USDT (Toncoin) withdrawals to the   !!!
-- !!! existing `withdrawals` table + queue. Adds an `asset`       !!!
-- !!! column (default 'ton'), a sibling `usdt_amount` column,     !!!
-- !!! request_usdt_withdrawal RPC, and a complete_usdt_withdrawal !!!
-- !!! RPC. The Edge Function (process-withdrawals) handles both   !!!
-- !!! asset types in the same pass.                               !!!
-- !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
-- ╔═══════════════════════════════════════════════════════╗
-- ║  USDT (Toncoin) withdrawals — schema + RPCs           ║
-- ║  Run after migration_withdrawals.sql                  ║
-- ╚═══════════════════════════════════════════════════════╝

-- 1. Schema additions ------------------------------------------------
-- `asset`        — which crypto is being sent. Existing rows default
--                  to 'ton' so the indexer's existing flow keeps
--                  working without backfill.
-- `usdt_amount`  — actual USDT credited to the recipient, in plain
--                  USDT units (6 decimals supported). Filled by the
--                  Edge Function on completion. Stays NULL for
--                  TON withdrawals.
ALTER TABLE withdrawals
  ADD COLUMN IF NOT EXISTS asset       TEXT          NOT NULL DEFAULT 'ton',
  ADD COLUMN IF NOT EXISTS usdt_amount NUMERIC(20,6);

-- Replace the asset CHECK constraint idempotently.
ALTER TABLE withdrawals DROP CONSTRAINT IF EXISTS withdrawals_asset_check;
ALTER TABLE withdrawals
  ADD CONSTRAINT withdrawals_asset_check
  CHECK (asset IN ('ton', 'usdt-ton'));

-- Index for the worker's per-asset poll.
CREATE INDEX IF NOT EXISTS idx_wd_asset_status_created
  ON withdrawals(asset, status, created_at ASC);


-- 2. request_usdt_withdrawal — mirror of request_withdrawal --------
-- Same fee shape (1 % platform + flat gas in RUB) and same atomic
-- balance deduction. Differences from the TON version:
--   - inserts `asset = 'usdt-ton'` so the Edge Function knows to
--     build a jetton-transfer body instead of a native TON message;
--   - the on-chain gas estimate is higher because USDT transfers
--     pay TON for our jetton-wallet hop + recipient notification.
--
-- The user's input is still in RUB / stars — the server converts to
-- USDT at the moment of dispatch using the live USD-RUB rate (USDT
-- is pegged to USD).
CREATE OR REPLACE FUNCTION request_usdt_withdrawal(
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
  FEE_RATE    CONSTANT NUMERIC := 0.01;
  GAS_RUB     CONSTANT INTEGER := 25;   -- ≈ 0.07 TON @ 250 ₽/TON
BEGIN
  IF p_amount_rub < MIN_AMOUNT THEN
    RETURN jsonb_build_object('error', 'min_amount', 'min', MIN_AMOUNT);
  END IF;

  SELECT balance INTO v_balance
  FROM users WHERE id = p_user_id FOR UPDATE;

  IF v_balance IS NULL THEN
    RETURN jsonb_build_object('error', 'user_not_found');
  END IF;

  IF v_balance < p_amount_rub THEN
    RETURN jsonb_build_object('error', 'insufficient_balance', 'balance', v_balance);
  END IF;

  v_fee := CEIL(p_amount_rub * FEE_RATE);
  v_gas := GAS_RUB;
  v_net := p_amount_rub - v_fee - v_gas;

  IF v_net <= 0 THEN
    RETURN jsonb_build_object('error', 'amount_too_small_after_fees');
  END IF;

  UPDATE users SET balance = balance - p_amount_rub WHERE id = p_user_id;

  INSERT INTO withdrawals (
    user_id, amount_rub, fee_rub, gas_rub, net_rub,
    ton_address, memo, asset
  )
  VALUES (
    p_user_id, p_amount_rub, v_fee, v_gas, v_net,
    p_ton_address, COALESCE(p_memo, ''), 'usdt-ton'
  )
  RETURNING id INTO v_wd_id;

  INSERT INTO transactions (user_id, type, amount, ref_id)
  VALUES (p_user_id, 'withdrawal', -p_amount_rub, v_wd_id);

  PERFORM admin_log('info', 'rpc:request_usdt_withdrawal',
    'USDT withdrawal requested',
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


-- 3. complete_usdt_withdrawal --------------------------------------
-- Mirror of complete_withdrawal but for asset='usdt-ton'. Stores the
-- actual USDT amount sent (not TON) so the admin / user history can
-- show "X USDT" instead of guessing.
CREATE OR REPLACE FUNCTION complete_usdt_withdrawal(
  p_withdrawal_id UUID,
  p_tx_hash       TEXT,
  p_usdt_amount   NUMERIC
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  UPDATE withdrawals
  SET status       = 'completed',
      tx_hash      = p_tx_hash,
      usdt_amount  = p_usdt_amount,
      processed_at = NOW()
  WHERE id = p_withdrawal_id
    AND status = 'processing'
    AND asset  = 'usdt-ton';

  PERFORM admin_log('info', 'rpc:complete_usdt_withdrawal',
    'USDT withdrawal completed',
    jsonb_build_object(
      'withdrawal_id', p_withdrawal_id,
      'tx_hash', p_tx_hash,
      'usdt_amount', p_usdt_amount
    )
  );
END;
$$;


-- 4. Grants ----------------------------------------------------------
GRANT EXECUTE ON FUNCTION request_usdt_withdrawal(UUID, INTEGER, TEXT, TEXT) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION complete_usdt_withdrawal(UUID, TEXT, NUMERIC)      TO authenticated, anon, service_role;

NOTIFY pgrst, 'reload schema';
