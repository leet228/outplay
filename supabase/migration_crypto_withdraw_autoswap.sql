-- ╔═══════════════════════════════════════════════════════════╗
-- ║  CRYPTO WITHDRAW — auto-swap funding                       ║
-- ║  If the treasury is short of the requested coin but holds  ║
-- ║  enough of its backup asset, the processor swaps backup→   ║
-- ║  target first, waits for it to land, then pays out.        ║
-- ║  State machine: pending → processing → swapping →          ║
-- ║  processing(verify) → completed | failed(refund).          ║
-- ╚═══════════════════════════════════════════════════════════╝
-- Run AFTER migration_crypto_withdrawals.sql.

ALTER TABLE crypto_withdrawals
  ADD COLUMN IF NOT EXISTS swap_txid       TEXT,
  ADD COLUMN IF NOT EXISTS swap_started_at TIMESTAMPTZ;

ALTER TABLE crypto_withdrawals DROP CONSTRAINT IF EXISTS crypto_withdrawals_status_check;
ALTER TABLE crypto_withdrawals ADD CONSTRAINT crypto_withdrawals_status_check
  CHECK (status IN ('pending','processing','swapping','completed','failed'));

-- Re-pick: one row in flight at a time. A 'swapping' row that has
-- had ≥45s to settle is flipped back to 'processing' so the
-- processor re-checks the balance and sends. Stuck guards refund.
CREATE OR REPLACE FUNCTION pick_pending_crypto_withdrawal()
RETURNS SETOF crypto_withdrawals
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_row   crypto_withdrawals;
  v_stuck RECORD;
BEGIN
  -- crashed 'processing' (>5 min) → fail + refund
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

  -- swap never landed (>12 min) → fail + refund
  FOR v_stuck IN
    SELECT id, user_id, amount_rub FROM crypto_withdrawals
    WHERE status = 'swapping' AND swap_started_at < NOW() - INTERVAL '12 minutes'
    FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE crypto_withdrawals
    SET status = 'failed', error = 'Swap funding timeout (12min)', processed_at = NOW()
    WHERE id = v_stuck.id;
    UPDATE users SET balance = balance + v_stuck.amount_rub WHERE id = v_stuck.user_id;
    INSERT INTO transactions (user_id, type, amount, ref_id)
    VALUES (v_stuck.user_id, 'withdrawal_refund', v_stuck.amount_rub, v_stuck.id);
    PERFORM admin_log('warn', 'rpc:pick_pending_crypto_withdrawal',
      'Auto-failed stuck swap-funded withdrawal',
      jsonb_build_object('id', v_stuck.id, 'refunded', v_stuck.amount_rub));
  END LOOP;

  -- one at a time (a swap holds the slot until it lands)
  IF EXISTS (SELECT 1 FROM crypto_withdrawals WHERE status = 'processing') THEN
    RETURN;
  END IF;

  -- a swap that has had time to settle → re-verify
  SELECT * INTO v_row FROM crypto_withdrawals
  WHERE status = 'swapping' AND swap_started_at <= NOW() - INTERVAL '45 seconds'
  ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF v_row.id IS NOT NULL THEN
    UPDATE crypto_withdrawals SET status = 'processing' WHERE id = v_row.id;
    v_row.status := 'processing';
    RETURN NEXT v_row;
    RETURN;
  END IF;

  -- a swap is still mid-air (not yet re-checkable) → don't start
  -- new work, keep strictly one withdrawal flowing end-to-end
  IF EXISTS (SELECT 1 FROM crypto_withdrawals WHERE status = 'swapping') THEN
    RETURN;
  END IF;

  -- otherwise the oldest fresh pending
  SELECT * INTO v_row FROM crypto_withdrawals
  WHERE status = 'pending' ORDER BY created_at ASC
  LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF v_row.id IS NULL THEN RETURN; END IF;

  UPDATE crypto_withdrawals SET status = 'processing' WHERE id = v_row.id;
  v_row.status := 'processing';
  RETURN NEXT v_row;
END;
$$;

-- swap fired → park the row until it lands
CREATE OR REPLACE FUNCTION mark_crypto_swapping(p_id UUID, p_txid TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE crypto_withdrawals
  SET status = 'swapping', swap_txid = p_txid, swap_started_at = NOW()
  WHERE id = p_id AND status = 'processing';
  PERFORM admin_log('info', 'rpc:mark_crypto_swapping',
    'Swap funding started', jsonb_build_object('id', p_id, 'swap_txid', p_txid));
END;
$$;

-- approve sent (allowance) — retry the whole thing next tick
CREATE OR REPLACE FUNCTION requeue_crypto_pending(p_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE crypto_withdrawals SET status = 'pending'
  WHERE id = p_id AND status = 'processing';
END;
$$;

-- swap not landed yet — keep waiting (re-checked after 45s)
CREATE OR REPLACE FUNCTION crypto_back_to_swapping(p_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE crypto_withdrawals SET status = 'swapping'
  WHERE id = p_id AND status = 'processing';
END;
$$;
