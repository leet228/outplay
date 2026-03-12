-- ╔═══════════════════════════════════════════╗
-- ║  Crypto deposits — auto-crediting        ║
-- ╚═══════════════════════════════════════════╝

-- Processed crypto transactions (deduplication)
CREATE TABLE IF NOT EXISTS crypto_processed_txs (
  tx_hash    TEXT PRIMARY KEY,
  chain      TEXT NOT NULL,
  crypto_amt NUMERIC(20,8) NOT NULL,
  rub_amount NUMERIC(12,2) NOT NULL,
  stars      INTEGER NOT NULL,
  user_id    UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crypto_tx_user ON crypto_processed_txs(user_id, created_at DESC);

-- RPC: credit a crypto deposit with ATOMIC dedup by tx_hash
CREATE OR REPLACE FUNCTION process_crypto_deposit(
  p_user_id      UUID,
  p_stars        INTEGER,
  p_tx_hash      TEXT,
  p_chain        TEXT,
  p_crypto_amt   NUMERIC,
  p_rub_amount   NUMERIC
) RETURNS JSONB AS $$
DECLARE
  new_bal INTEGER;
  inserted BOOLEAN;
BEGIN
  IF p_stars < 1 THEN
    RETURN jsonb_build_object('error', 'stars must be >= 1');
  END IF;

  -- Atomic dedup: INSERT ON CONFLICT eliminates race condition
  INSERT INTO crypto_processed_txs (tx_hash, chain, crypto_amt, rub_amount, stars, user_id)
  VALUES (p_tx_hash, p_chain, p_crypto_amt, p_rub_amount, p_stars, p_user_id)
  ON CONFLICT (tx_hash) DO NOTHING;

  GET DIAGNOSTICS inserted = ROW_COUNT;

  IF NOT inserted THEN
    SELECT balance INTO new_bal FROM users WHERE id = p_user_id;
    RETURN jsonb_build_object('new_balance', new_bal, 'duplicate', true);
  END IF;

  -- Credit balance (UPDATE ... SET balance = balance + X is atomic per row)
  UPDATE users SET balance = balance + p_stars WHERE id = p_user_id
  RETURNING balance INTO new_bal;

  -- Log in transactions
  INSERT INTO transactions (user_id, type, amount, currency_amount, currency_code)
  VALUES (p_user_id, 'deposit', p_stars, p_rub_amount, 'RUB');

  RETURN jsonb_build_object('new_balance', new_bal, 'credited', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
