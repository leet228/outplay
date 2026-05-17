-- !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
-- !!! TODO RUN ON PROD — per-user HD deposit addresses.      !!!
-- !!! Foundation for the deposit→credit→sweep pipeline:      !!!
-- !!! every user gets ONE derivation index → 4 unique        !!!
-- !!! addresses (EVM / TRON / BTC / LTC) from the single HD   !!!
-- !!! master (scripts/hd-derive.js; Supabase secret           !!!
-- !!! HD_MASTER_MNEMONIC). Addresses are filled by the        !!!
-- !!! derive-deposit-address Edge Function (next step) — this !!!
-- !!! migration only owns the schema + index allocation.     !!!
-- !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
-- =============================================
-- user_deposit_addresses
-- =============================================

CREATE TABLE IF NOT EXISTS user_deposit_addresses (
  user_id          UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- Global, monotonically-increasing BIP44 child index. Stable
  -- forever per user so the server can always re-derive the
  -- private key for sweeping.
  derivation_index INTEGER NOT NULL UNIQUE,
  evm_address      TEXT,   -- 0x… — ETH + BSC + USDT/USDC ERC20/BEP20
  tron_address     TEXT,   -- T…  — TRX + USDT-TRC20
  btc_address      TEXT,   -- bc1…
  ltc_address      TEXT,   -- ltc1…
  -- false until the Edge Function has written all 4 addresses.
  ready            BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Reverse lookups for the deposit indexer (address → which user).
CREATE INDEX IF NOT EXISTS idx_uda_evm  ON user_deposit_addresses (evm_address);
CREATE INDEX IF NOT EXISTS idx_uda_tron ON user_deposit_addresses (tron_address);
CREATE INDEX IF NOT EXISTS idx_uda_btc  ON user_deposit_addresses (btc_address);
CREATE INDEX IF NOT EXISTS idx_uda_ltc  ON user_deposit_addresses (ltc_address);

-- Derivation index allocator. Starts at 1 (index 0 stays free as
-- a reserved/sentinel slot).
CREATE SEQUENCE IF NOT EXISTS deposit_addr_index_seq START WITH 1;


-- ── claim_user_deposit_index ─────────────────────────────────────
-- Idempotent: returns the user's existing row, or atomically
-- allocates the next index and inserts a not-yet-ready row. The
-- Edge Function then derives the 4 addresses for `index` and calls
-- set_user_deposit_addresses(). Returns the full row as JSONB.
CREATE OR REPLACE FUNCTION claim_user_deposit_index(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rec user_deposit_addresses%ROWTYPE;
BEGIN
  SELECT * INTO v_rec FROM user_deposit_addresses WHERE user_id = p_user_id;

  IF NOT FOUND THEN
    INSERT INTO user_deposit_addresses (user_id, derivation_index)
      VALUES (p_user_id, nextval('deposit_addr_index_seq'))
      ON CONFLICT (user_id) DO NOTHING;
    SELECT * INTO v_rec FROM user_deposit_addresses WHERE user_id = p_user_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'user_id', v_rec.user_id,
    'index', v_rec.derivation_index,
    'evm',  v_rec.evm_address,
    'tron', v_rec.tron_address,
    'btc',  v_rec.btc_address,
    'ltc',  v_rec.ltc_address,
    'ready', v_rec.ready
  );
EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'rpc:claim_user_deposit_index', SQLERRM,
    jsonb_build_object('user_id', p_user_id));
  RETURN jsonb_build_object('error', SQLERRM);
END;
$$;


-- ── set_user_deposit_addresses ───────────────────────────────────
-- Called ONLY by the derive-deposit-address Edge Function (service
-- role) once it has derived the 4 addresses for the user's index.
-- Never overwrites an already-ready row (addresses are immutable
-- once set — they must keep matching the on-chain history).
CREATE OR REPLACE FUNCTION set_user_deposit_addresses(
  p_user_id UUID,
  p_evm     TEXT,
  p_tron    TEXT,
  p_btc     TEXT,
  p_ltc     TEXT
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ready BOOLEAN;
BEGIN
  SELECT ready INTO v_ready FROM user_deposit_addresses WHERE user_id = p_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'no_index_claimed');
  END IF;
  IF v_ready THEN
    RETURN jsonb_build_object('ok', true, 'already_ready', true);
  END IF;

  UPDATE user_deposit_addresses
     SET evm_address  = p_evm,
         tron_address = p_tron,
         btc_address  = p_btc,
         ltc_address  = p_ltc,
         ready        = true,
         updated_at   = NOW()
   WHERE user_id = p_user_id;

  RETURN jsonb_build_object('ok', true);
EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'rpc:set_user_deposit_addresses', SQLERRM,
    jsonb_build_object('user_id', p_user_id));
  RETURN jsonb_build_object('error', SQLERRM);
END;
$$;


-- claim is safe for the app role; set_* is service-role only
-- (Edge Function), so it is intentionally NOT granted to anon.
GRANT EXECUTE ON FUNCTION claim_user_deposit_index(UUID) TO authenticated, anon;

NOTIFY pgrst, 'reload schema';
