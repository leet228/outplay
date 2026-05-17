-- ╔═══════════════════════════════════════════════════════════╗
-- ║  TREASURY LOCK — global per-chain serialization           ║
-- ║  Every Edge fn that spends from the shared HD-0 treasury   ║
-- ║  (dex-swap, process-crypto-withdrawals, treasury-withdraw) ║
-- ║  must hold the channel lock while building+broadcasting a  ║
-- ║  tx, so EVM nonce / TRON / UTXO never race across funcs.   ║
-- ║  TON is NOT covered — it uses the Highload V3 wallet.      ║
-- ╚═══════════════════════════════════════════════════════════╝
-- Channels: 'eth' · 'bsc' · 'tron' · 'btc' · 'ltc'
-- (ETH and BSC have independent nonce sequences → separate
--  channels so they don't block each other.)

CREATE TABLE IF NOT EXISTS treasury_locks (
  channel     TEXT PRIMARY KEY,
  holder      TEXT,
  token       TEXT,
  acquired_at TIMESTAMPTZ DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);

ALTER TABLE treasury_locks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_full" ON treasury_locks;
CREATE POLICY "service_role_full" ON treasury_locks
  FOR ALL USING (auth.role() = 'service_role');

-- Acquire: insert if free, or STEAL only if the current holder's
-- lock has expired (crash safety). Atomic via the PK + ON CONFLICT.
CREATE OR REPLACE FUNCTION acquire_treasury_lock(
  p_channel TEXT, p_holder TEXT, p_ttl INTEGER DEFAULT 120
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_token TEXT := gen_random_uuid()::text;
BEGIN
  INSERT INTO treasury_locks (channel, holder, token, acquired_at, expires_at)
  VALUES (p_channel, p_holder, v_token, now(),
          now() + make_interval(secs => GREATEST(p_ttl, 10)))
  ON CONFLICT (channel) DO UPDATE
     SET holder = EXCLUDED.holder, token = EXCLUDED.token,
         acquired_at = now(), expires_at = EXCLUDED.expires_at
   WHERE treasury_locks.expires_at < now();   -- only steal a stale lock

  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'token', v_token);
  END IF;
  RETURN jsonb_build_object('ok', false);
END;
$$;
GRANT EXECUTE ON FUNCTION acquire_treasury_lock(TEXT, TEXT, INTEGER) TO anon;

-- Release: only the exact token holder can free it.
CREATE OR REPLACE FUNCTION release_treasury_lock(
  p_channel TEXT, p_token TEXT
)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  DELETE FROM treasury_locks
  WHERE channel = p_channel AND token = p_token;
  RETURN TRUE;
END;
$$;
GRANT EXECUTE ON FUNCTION release_treasury_lock(TEXT, TEXT) TO anon;
