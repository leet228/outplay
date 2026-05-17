-- !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
-- !!! TODO RUN ON PROD — sweep ledger (Step 4 foundation).   !!!
-- !!! Tracks moving each CREDITED multi-chain deposit from    !!!
-- !!! the user's derived address → the treasury (HD index 0). !!!
-- !!! No signing here — the sweep-deposits Edge Function owns  !!!
-- !!! that. This migration only owns the audited job ledger   !!!
-- !!! so every on-chain move is traceable and idempotent.     !!!
-- !!! Run AFTER migration_user_deposit_addresses.sql.         !!!
-- !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
-- =============================================
-- sweep_jobs
-- =============================================
--
-- Treasury wallet = HD derivation index 0 (the user index
-- sequence starts at 1, so 0 is reserved). The server can derive
-- its key from HD_MASTER_MNEMONIC, so it doubles as the gas
-- source (funds a user address with native coin so a token can
-- be moved) AND the sweep destination — no extra key secrets.
--
-- One job per credited deposit tx (tx_hash FK → the dedup table
-- the indexer already writes). Lifecycle:
--   pending   → not yet processed
--   needs_gas → token sweep blocked: user addr lacks native gas
--   gassing   → gas top-up tx broadcast, waiting for confirm
--   sweeping  → sweep tx broadcast, waiting for confirm
--   swept     → done (sweep_txid set)
--   failed    → gave up after retries (last_error set)
--   skipped   → below dust / nothing to move

CREATE TABLE IF NOT EXISTS sweep_jobs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tx_hash          TEXT NOT NULL UNIQUE
                     REFERENCES crypto_processed_txs(tx_hash) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chain            TEXT NOT NULL,        -- btc/ltc/eth/bnb/trx/usdt-*/usdc-*
  derivation_index INTEGER NOT NULL,
  from_address     TEXT NOT NULL,        -- the user's derived address
  amount           NUMERIC(30,10) NOT NULL DEFAULT 0,  -- credited amount (audit)
  status           TEXT NOT NULL DEFAULT 'pending',
  gas_txid         TEXT,
  sweep_txid       TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sweep_status   ON sweep_jobs (status, created_at);
CREATE INDEX IF NOT EXISTS idx_sweep_user     ON sweep_jobs (user_id);

-- Native coin / token classification helpers shared with the
-- Edge Function (kept here as plain values for documentation).
--   native chains : btc, ltc, eth, bnb, trx
--   token chains  : usdt-trc20, usdt-erc20, usdc-erc20,
--                    usdt-bep20, usdc-bep20

-- ── enqueue_sweep_jobs ───────────────────────────────────────────
-- Idempotent: for every credited multi-chain deposit that has no
-- sweep_job yet, insert a pending job pointing at the right
-- derived address for that chain. Returns the number queued.
CREATE OR REPLACE FUNCTION enqueue_sweep_jobs()
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  INSERT INTO sweep_jobs (tx_hash, user_id, chain, derivation_index, from_address, amount)
  SELECT
    cpt.tx_hash,
    cpt.user_id,
    cpt.chain,
    uda.derivation_index,
    CASE
      WHEN cpt.chain IN ('trx', 'usdt-trc20')                       THEN uda.tron_address
      WHEN cpt.chain IN ('eth', 'bnb', 'usdt-erc20', 'usdc-erc20',
                         'usdt-bep20', 'usdc-bep20')                THEN uda.evm_address
      WHEN cpt.chain = 'btc'                                        THEN uda.btc_address
      WHEN cpt.chain = 'ltc'                                        THEN uda.ltc_address
    END,
    cpt.crypto_amt
  FROM crypto_processed_txs cpt
  JOIN user_deposit_addresses uda ON uda.user_id = cpt.user_id
  WHERE cpt.chain IN ('trx','usdt-trc20','eth','bnb','usdt-erc20',
                      'usdc-erc20','usdt-bep20','usdc-bep20','btc','ltc')
    AND uda.ready = true
    AND NOT EXISTS (SELECT 1 FROM sweep_jobs sj WHERE sj.tx_hash = cpt.tx_hash)
  ON CONFLICT (tx_hash) DO NOTHING;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;


-- ── claim_sweep_jobs ─────────────────────────────────────────────
-- Returns up to p_limit actionable jobs (pending / needs_gas /
-- gassing / sweeping — i.e. anything not terminal) as JSONB, and
-- bumps their attempt counter so a poison job can't be retried
-- forever (the Edge Function caps on `attempts`).
CREATE OR REPLACE FUNCTION claim_sweep_jobs(p_limit INTEGER DEFAULT 25)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lim INTEGER := GREATEST(1, LEAST(p_limit, 100));
  v_rows JSONB;
BEGIN
  WITH picked AS (
    SELECT id
    FROM sweep_jobs
    WHERE status IN ('pending','needs_gas','gassing','sweeping')
      AND attempts < 30
    ORDER BY created_at
    LIMIT v_lim
    FOR UPDATE SKIP LOCKED
  ),
  bumped AS (
    UPDATE sweep_jobs s
       SET attempts = s.attempts + 1, updated_at = NOW()
      FROM picked
     WHERE s.id = picked.id
    RETURNING s.*
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(b.*) ORDER BY b.created_at), '[]'::jsonb)
    INTO v_rows
  FROM bumped b;

  RETURN v_rows;
END;
$$;


-- ── update_sweep_job ─────────────────────────────────────────────
-- Single mutator the Edge Function calls to advance a job. NULL
-- args leave that column unchanged.
CREATE OR REPLACE FUNCTION update_sweep_job(
  p_id         UUID,
  p_status     TEXT DEFAULT NULL,
  p_gas_txid   TEXT DEFAULT NULL,
  p_sweep_txid TEXT DEFAULT NULL,
  p_error      TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE sweep_jobs
     SET status     = COALESCE(p_status, status),
         gas_txid   = COALESCE(p_gas_txid, gas_txid),
         sweep_txid = COALESCE(p_sweep_txid, sweep_txid),
         last_error = p_error,
         updated_at = NOW()
   WHERE id = p_id;
END;
$$;


-- Admin read: recent sweep activity for the wallet dashboard.
CREATE OR REPLACE FUNCTION admin_get_sweep_jobs(p_limit INTEGER DEFAULT 50)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN COALESCE((
    SELECT jsonb_agg(to_jsonb(s.*) ORDER BY s.created_at DESC)
    FROM (
      SELECT * FROM sweep_jobs ORDER BY created_at DESC
      LIMIT GREATEST(1, LEAST(p_limit, 200))
    ) s
  ), '[]'::jsonb);
END;
$$;

NOTIFY pgrst, 'reload schema';
