-- ╔═══════════════════════════════════════════════════════╗
-- ║  WITHDRAWALS — table + RPCs                          ║
-- ║  Run after schema.sql & crypto_deposits.sql          ║
-- ╚═══════════════════════════════════════════════════════╝

-- 1. Extend transactions type to include withdrawal_refund
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_type_check
  CHECK (type IN (
    'deposit','withdrawal','withdrawal_refund',
    'duel_win','duel_loss','duel_draw',
    'referral_bonus',
    'guild_create','guild_edit',
    'guild_prize',
    'subscription'
  ));

-- 2. Withdrawals table
CREATE TABLE IF NOT EXISTS withdrawals (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id),
  amount_rub   INTEGER NOT NULL,            -- total amount deducted from balance
  fee_rub      INTEGER NOT NULL DEFAULT 0,  -- platform fee (2%)
  gas_rub      INTEGER NOT NULL DEFAULT 0,  -- estimated gas cost in RUB
  net_rub      INTEGER NOT NULL,            -- amount_rub - fee - gas (what gets converted to TON)
  ton_amount   NUMERIC(20,9),               -- actual TON sent (filled by server)
  ton_address  TEXT NOT NULL,
  memo         TEXT DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','processing','completed','failed')),
  tx_hash      TEXT,                        -- TON blockchain tx hash
  error        TEXT,                        -- error message if failed
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_wd_status ON withdrawals(status, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_wd_user   ON withdrawals(user_id, created_at DESC);

-- RLS: only service_role can access directly (RPCs use SECURITY DEFINER)
ALTER TABLE withdrawals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_full" ON withdrawals
  FOR ALL USING (auth.role() = 'service_role');

-- 3. request_withdrawal — atomic balance deduction + insert
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
  FEE_RATE    CONSTANT NUMERIC := 0.02;
  GAS_RUB     CONSTANT INTEGER := 3;  -- ~0.01 TON ≈ 2.5 RUB, rounded up
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

-- 4. pick_pending_withdrawal — atomically pick + mark as processing
--    Guards against concurrent execution:
--    - If any withdrawal is 'processing' (< 5 min) → returns nothing (another worker active)
--    - Auto-fails + refunds stuck 'processing' withdrawals (> 5 min = crashed worker)
CREATE OR REPLACE FUNCTION pick_pending_withdrawal()
RETURNS SETOF withdrawals
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_row withdrawals;
  v_stuck RECORD;
BEGIN
  -- Auto-fail stuck 'processing' withdrawals (worker crashed / timed out)
  FOR v_stuck IN
    SELECT id, user_id, amount_rub
    FROM withdrawals
    WHERE status = 'processing'
      AND created_at < NOW() - INTERVAL '5 minutes'
    FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE withdrawals
    SET status = 'failed', error = 'Processing timeout (5min)', processed_at = NOW()
    WHERE id = v_stuck.id;

    UPDATE users SET balance = balance + v_stuck.amount_rub WHERE id = v_stuck.user_id;

    INSERT INTO transactions (user_id, type, amount, ref_id)
    VALUES (v_stuck.user_id, 'withdrawal_refund', v_stuck.amount_rub, v_stuck.id);

    PERFORM admin_log('warn', 'rpc:pick_pending_withdrawal',
      'Auto-failed stuck withdrawal',
      jsonb_build_object('withdrawal_id', v_stuck.id, 'refunded', v_stuck.amount_rub)
    );
  END LOOP;

  -- If any withdrawal is currently processing → another worker is active, skip
  IF EXISTS (SELECT 1 FROM withdrawals WHERE status = 'processing') THEN
    RETURN;
  END IF;

  -- Pick oldest pending
  SELECT * INTO v_row
  FROM withdrawals
  WHERE status = 'pending'
  ORDER BY created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF v_row.id IS NULL THEN
    RETURN;
  END IF;

  UPDATE withdrawals SET status = 'processing' WHERE id = v_row.id;
  v_row.status := 'processing';
  RETURN NEXT v_row;
END;
$$;

-- 5. complete_withdrawal — called by server after successful TON send
CREATE OR REPLACE FUNCTION complete_withdrawal(
  p_withdrawal_id UUID,
  p_tx_hash       TEXT,
  p_ton_amount    NUMERIC
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  UPDATE withdrawals
  SET status = 'completed',
      tx_hash = p_tx_hash,
      ton_amount = p_ton_amount,
      processed_at = NOW()
  WHERE id = p_withdrawal_id AND status = 'processing';

  PERFORM admin_log('info', 'rpc:complete_withdrawal',
    'Withdrawal completed',
    jsonb_build_object(
      'withdrawal_id', p_withdrawal_id,
      'tx_hash', p_tx_hash,
      'ton_amount', p_ton_amount
    )
  );
END;
$$;

-- 5. fail_withdrawal — refund balance on failure
CREATE OR REPLACE FUNCTION fail_withdrawal(
  p_withdrawal_id UUID,
  p_error         TEXT
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_user_id    UUID;
  v_amount_rub INTEGER;
BEGIN
  -- Get withdrawal info & mark failed
  UPDATE withdrawals
  SET status = 'failed',
      error = p_error,
      processed_at = NOW()
  WHERE id = p_withdrawal_id AND status = 'processing'
  RETURNING user_id, amount_rub INTO v_user_id, v_amount_rub;

  IF v_user_id IS NULL THEN
    RETURN; -- already processed or not found
  END IF;

  -- Refund balance
  UPDATE users SET balance = balance + v_amount_rub WHERE id = v_user_id;

  -- Log refund transaction
  INSERT INTO transactions (user_id, type, amount, ref_id)
  VALUES (v_user_id, 'withdrawal_refund', v_amount_rub, p_withdrawal_id);

  PERFORM admin_log('warn', 'rpc:fail_withdrawal',
    'Withdrawal failed — balance refunded',
    jsonb_build_object(
      'withdrawal_id', p_withdrawal_id,
      'user_id', v_user_id,
      'refunded', v_amount_rub,
      'error', p_error
    )
  );
END;
$$;

-- ═══════════════════════════════════════════════════════
-- 6. pg_cron — process withdrawals every minute
-- ═══════════════════════════════════════════════════════
--
-- Run in Supabase SQL Editor AFTER enabling pg_cron + pg_net:
--
--   SELECT cron.schedule(
--     'process-withdrawals',
--     '* * * * *',
--     $$
--     SELECT net.http_post(
--       url := current_setting('app.settings.supabase_url') || '/functions/v1/process-withdrawals',
--       headers := jsonb_build_object(
--         'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
--         'Content-Type', 'application/json'
--       ),
--       body := '{}'::jsonb
--     );
--     $$
--   );
--
-- This calls the Edge Function every minute.
-- The frontend also pings it immediately after creating a withdrawal.
