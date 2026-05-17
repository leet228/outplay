-- !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
-- !!! TODO RUN ON PROD — multi-chain deposit wallet config.  !!!
-- !!! Seeds one app_settings key per extra chain holding the !!!
-- !!! admin's MAIN receiving wallet address for that network.!!!
-- !!! Empty by default → the deposit sheet keeps showing its !!!
-- !!! placeholder until you paste the real address in        !!!
-- !!! Admin → Control → "Кошельки пополнения".               !!!
-- !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
-- =============================================
-- Crypto deposit wallets (TRC20/BEP20/ERC20/BTC/ETH/BNB/TRX/LTC)
-- =============================================
--
-- TON / USDT(TON) keep their hardcoded Highload-V3 address in
-- src/lib/addresses.js — untouched. These keys are ONLY for the
-- new chains. Values are plain JSON strings (the address). The
-- existing get_app_settings() exposes them to the client and
-- update_app_setting() (used by the admin panel) writes them, so
-- no new RPC is needed.
--
-- ON CONFLICT DO NOTHING → re-running is safe and never wipes an
-- address an admin already set.

INSERT INTO app_settings (key, value) VALUES
  ('deposit_addr_usdt_trc20', '""'::jsonb),
  ('deposit_addr_usdt_bep20', '""'::jsonb),
  ('deposit_addr_trx',        '""'::jsonb),
  ('deposit_addr_eth',        '""'::jsonb),
  ('deposit_addr_btc',        '""'::jsonb),
  ('deposit_addr_usdt_erc20', '""'::jsonb),
  ('deposit_addr_usdc_erc20', '""'::jsonb),
  ('deposit_addr_bnb',        '""'::jsonb),
  ('deposit_addr_ltc',        '""'::jsonb),
  ('deposit_addr_usdc_bep20', '""'::jsonb)
ON CONFLICT (key) DO NOTHING;

NOTIFY pgrst, 'reload schema';
