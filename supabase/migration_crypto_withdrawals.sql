-- ╔═══════════════════════════════════════════════════════════╗
-- ║  CRYPTO WITHDRAWALS — multi-chain user payouts            ║
-- ║  TON + USDT-TON stay on the existing proven path.         ║
-- ║  This adds the 6 new rails (auto-paid from HD-0 treasury):║
-- ║   usdt-trc20 · trx · eth · usdt-erc20 · usdc-erc20 ·      ║
-- ║   usdc-bep20                                              ║
-- ╚═══════════════════════════════════════════════════════════╝
-- Run AFTER migration_withdrawals.sql.

-- ── 1. Per-chain config (admin-tunable, no redeploy) ──
-- app_settings.value JSON: { "<chain>": { "min": <rub>, "gas": <rub> } }
-- gas ≈ real network cost in RUB; keep it close to reality.
INSERT INTO app_settings (key, value)
VALUES ('crypto_withdraw_cfg', '{
  "trx":         { "min": 500,  "gas": 20  },
  "usdt-trc20":  { "min": 500,  "gas": 120 },
  "eth":         { "min": 2500, "gas": 400 },
  "usdt-erc20":  { "min": 3000, "gas": 600 },
  "usdc-erc20":  { "min": 3000, "gas": 600 },
  "usdc-bep20":  { "min": 700,  "gas": 30  }
}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Arming switch — payouts only fire when this is true.
INSERT INTO app_settings (key, value)
VALUES ('crypto_payout_enabled', 'false'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION get_crypto_withdraw_cfg()
RETURNS JSONB LANGUAGE sql SECURITY DEFINER AS $$
  SELECT COALESCE(
    (SELECT value FROM app_settings WHERE key = 'crypto_withdraw_cfg'),
    '{}'::jsonb)
$$;
GRANT EXECUTE ON FUNCTION get_crypto_withdraw_cfg() TO anon;

-- ── 2. Table ──
CREATE TABLE IF NOT EXISTS crypto_withdrawals (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id),
  amount_rub   INTEGER NOT NULL,            -- total deducted from balance
  fee_rub      INTEGER NOT NULL DEFAULT 0,  -- platform 1%
  gas_rub      INTEGER NOT NULL DEFAULT 0,  -- network gas (RUB, from cfg)
  net_rub      INTEGER NOT NULL,            -- what gets converted to coin
  chain        TEXT NOT NULL                -- treasury-withdraw chain key
               CHECK (chain IN ('trx','usdt-trc20','eth',
                                 'usdt-erc20','usdc-erc20','usdc-bep20')),
  to_address   TEXT NOT NULL,
  coin_amount  NUMERIC(38,18),              -- actual coin sent (server)
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','processing','completed','failed')),
  tx_hash      TEXT,
  error        TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_cwd_status ON crypto_withdrawals(status, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_cwd_user   ON crypto_withdrawals(user_id, created_at DESC);

ALTER TABLE crypto_withdrawals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_full" ON crypto_withdrawals;
CREATE POLICY "service_role_full" ON crypto_withdrawals
  FOR ALL USING (auth.role() = 'service_role');

-- ── 3. request_crypto_withdrawal — atomic deduct + queue ──
CREATE OR REPLACE FUNCTION request_crypto_withdrawal(
  p_user_id    UUID,
  p_amount_rub INTEGER,
  p_chain      TEXT,
  p_to         TEXT
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_cfg     JSONB;
  v_min     INTEGER;
  v_gas     INTEGER;
  v_balance INTEGER;
  v_fee     INTEGER;
  v_net     INTEGER;
  v_id      UUID;
  FEE_RATE  CONSTANT NUMERIC := 0.01;
BEGIN
  IF p_chain NOT IN ('trx','usdt-trc20','eth','usdt-erc20','usdc-erc20','usdc-bep20') THEN
    RETURN jsonb_build_object('error', 'bad_chain');
  END IF;
  IF p_to IS NULL OR length(trim(p_to)) < 10 THEN
    RETURN jsonb_build_object('error', 'bad_address');
  END IF;

  v_cfg := COALESCE((SELECT value FROM app_settings WHERE key = 'crypto_withdraw_cfg'), '{}'::jsonb);
  v_min := COALESCE((v_cfg -> p_chain ->> 'min')::INTEGER, 500);
  v_gas := COALESCE((v_cfg -> p_chain ->> 'gas')::INTEGER, 100);

  IF p_amount_rub < v_min THEN
    RETURN jsonb_build_object('error', 'min_amount', 'min', v_min);
  END IF;

  SELECT balance INTO v_balance FROM users WHERE id = p_user_id FOR UPDATE;
  IF v_balance IS NULL THEN
    RETURN jsonb_build_object('error', 'user_not_found');
  END IF;
  IF v_balance < p_amount_rub THEN
    RETURN jsonb_build_object('error', 'insufficient_balance', 'balance', v_balance);
  END IF;

  v_fee := CEIL(p_amount_rub * FEE_RATE);
  v_net := p_amount_rub - v_fee - v_gas;
  IF v_net <= 0 THEN
    RETURN jsonb_build_object('error', 'amount_too_small_after_fees');
  END IF;

  UPDATE users SET balance = balance - p_amount_rub WHERE id = p_user_id;

  INSERT INTO crypto_withdrawals
    (user_id, amount_rub, fee_rub, gas_rub, net_rub, chain, to_address)
  VALUES
    (p_user_id, p_amount_rub, v_fee, v_gas, v_net, p_chain, trim(p_to))
  RETURNING id INTO v_id;

  INSERT INTO transactions (user_id, type, amount, ref_id)
  VALUES (p_user_id, 'withdrawal', -p_amount_rub, v_id);

  PERFORM admin_log('info', 'rpc:request_crypto_withdrawal',
    'Crypto withdrawal requested',
    jsonb_build_object('id', v_id, 'user_id', p_user_id,
      'amount_rub', p_amount_rub, 'net_rub', v_net,
      'chain', p_chain, 'to', trim(p_to)));

  RETURN jsonb_build_object('ok', true, 'withdrawal_id', v_id,
    'new_balance', v_balance - p_amount_rub);
END;
$$;
GRANT EXECUTE ON FUNCTION request_crypto_withdrawal(UUID, INTEGER, TEXT, TEXT) TO anon;

-- ── 4. pick / complete / fail (mirror the TON queue) ──
CREATE OR REPLACE FUNCTION pick_pending_crypto_withdrawal()
RETURNS SETOF crypto_withdrawals
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_row   crypto_withdrawals;
  v_stuck RECORD;
BEGIN
  -- Auto-fail + refund crashed 'processing' rows (> 5 min).
  FOR v_stuck IN
    SELECT id, user_id, amount_rub FROM crypto_withdrawals
    WHERE status = 'processing' AND created_at < NOW() - INTERVAL '5 minutes'
    FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE crypto_withdrawals
    SET status = 'failed', error = 'Processing timeout (5min)', processed_at = NOW()
    WHERE id = v_stuck.id;
    UPDATE users SET balance = balance + v_stuck.amount_rub WHERE id = v_stuck.user_id;
    INSERT INTO transactions (user_id, type, amount, ref_id)
    VALUES (v_stuck.user_id, 'withdrawal_refund', v_stuck.amount_rub, v_stuck.id);
    PERFORM admin_log('warn', 'rpc:pick_pending_crypto_withdrawal',
      'Auto-failed stuck crypto withdrawal',
      jsonb_build_object('id', v_stuck.id, 'refunded', v_stuck.amount_rub));
  END LOOP;

  IF EXISTS (SELECT 1 FROM crypto_withdrawals WHERE status = 'processing') THEN
    RETURN;
  END IF;

  SELECT * INTO v_row FROM crypto_withdrawals
  WHERE status = 'pending' ORDER BY created_at ASC
  LIMIT 1 FOR UPDATE SKIP LOCKED;

  IF v_row.id IS NULL THEN RETURN; END IF;

  UPDATE crypto_withdrawals SET status = 'processing' WHERE id = v_row.id;
  v_row.status := 'processing';
  RETURN NEXT v_row;
END;
$$;

CREATE OR REPLACE FUNCTION complete_crypto_withdrawal(
  p_id UUID, p_tx_hash TEXT, p_coin_amount NUMERIC
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE crypto_withdrawals
  SET status = 'completed', tx_hash = p_tx_hash,
      coin_amount = p_coin_amount, processed_at = NOW()
  WHERE id = p_id AND status = 'processing';
  PERFORM admin_log('info', 'rpc:complete_crypto_withdrawal',
    'Crypto withdrawal completed',
    jsonb_build_object('id', p_id, 'tx_hash', p_tx_hash, 'coin', p_coin_amount));
END;
$$;

CREATE OR REPLACE FUNCTION fail_crypto_withdrawal(
  p_id UUID, p_error TEXT
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_user_id    UUID;
  v_amount_rub INTEGER;
BEGIN
  UPDATE crypto_withdrawals
  SET status = 'failed', error = p_error, processed_at = NOW()
  WHERE id = p_id AND status = 'processing'
  RETURNING user_id, amount_rub INTO v_user_id, v_amount_rub;

  IF v_user_id IS NULL THEN RETURN; END IF;

  UPDATE users SET balance = balance + v_amount_rub WHERE id = v_user_id;
  INSERT INTO transactions (user_id, type, amount, ref_id)
  VALUES (v_user_id, 'withdrawal_refund', v_amount_rub, p_id);
  PERFORM admin_log('warn', 'rpc:fail_crypto_withdrawal',
    'Crypto withdrawal failed — balance refunded',
    jsonb_build_object('id', p_id, 'user_id', v_user_id,
      'refunded', v_amount_rub, 'error', p_error));
END;
$$;
