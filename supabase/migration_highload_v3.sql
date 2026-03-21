-- ╔══════════════════════════════════════════════╗
-- ║  Highload V3: cleanup stuck withdrawals RPC ║
-- ╚══════════════════════════════════════════════╝

-- Auto-fail withdrawals stuck in 'processing' for >5 min (worker crashed)
CREATE OR REPLACE FUNCTION cleanup_stuck_withdrawals()
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_stuck RECORD;
  v_count INTEGER := 0;
BEGIN
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

    PERFORM admin_log('warn', 'rpc:cleanup_stuck_withdrawals',
      'Auto-failed stuck withdrawal',
      jsonb_build_object('withdrawal_id', v_stuck.id, 'refunded', v_stuck.amount_rub)
    );

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;
