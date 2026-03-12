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

-- RPC: credit a crypto deposit with dedup by tx_hash
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
BEGIN
  IF p_stars < 1 THEN
    RETURN jsonb_build_object('error', 'stars must be >= 1');
  END IF;

  -- Deduplication by tx_hash
  IF EXISTS (SELECT 1 FROM crypto_processed_txs WHERE tx_hash = p_tx_hash) THEN
    SELECT balance INTO new_bal FROM users WHERE id = p_user_id;
    RETURN jsonb_build_object('new_balance', new_bal, 'duplicate', true);
  END IF;

  -- Credit balance
  UPDATE users SET balance = balance + p_stars WHERE id = p_user_id
  RETURNING balance INTO new_bal;

  -- Log in transactions
  INSERT INTO transactions (user_id, type, amount, currency_amount, currency_code)
  VALUES (p_user_id, 'deposit', p_stars, p_rub_amount, 'RUB');

  -- Record processed tx
  INSERT INTO crypto_processed_txs (tx_hash, chain, crypto_amt, rub_amount, stars, user_id)
  VALUES (p_tx_hash, p_chain, p_crypto_amt, p_rub_amount, p_stars, p_user_id);

  RETURN jsonb_build_object('new_balance', new_bal, 'credited', true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
