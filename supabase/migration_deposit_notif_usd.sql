-- !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
-- !!! TODO RUN ON PROD — deposit notification in USD.             !!!
-- !!! Adds the `usd_rub_rate` app_settings key (kept fresh by the !!!
-- !!! crypto-deposit / withdrawal Edge Functions, which already   !!!
-- !!! fetch the live exchangerate-api USD→RUB number) and rewrites !!!
-- !!! notify_on_deposit() so the Telegram message shows the       !!!
-- !!! topped-up amount AND the current balance hard-coded in USD  !!!
-- !!! instead of stars.                                           !!!
-- !!! Run AFTER migration_english_notifications.sql (this is a    !!!
-- !!! CREATE OR REPLACE so it just supersedes that copy).         !!!
-- !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

-- 1. Live USD→RUB rate cache --------------------------------------
-- Balance is stored in RUB / stars (1 ⭐ = 1 ₽). To show dollars we
-- divide by the current USD→RUB rate. A Postgres trigger can't make
-- an outbound HTTP call synchronously, so the rate is mirrored into
-- app_settings by the Edge Functions that already pull it from
-- exchangerate-api on every run (check-crypto-deposits,
-- check-usdt-deposits, process-withdrawals — all fire frequently
-- via pg_cron + the frontend ping, so the value stays minutes-fresh).
-- The seeded 90 is only the cold-start fallback before the first
-- Edge run overwrites it.
INSERT INTO app_settings (key, value) VALUES
  ('usd_rub_rate', '90'::jsonb)
ON CONFLICT (key) DO NOTHING;


-- 2. notify_on_deposit — amounts hard-coded to USD ----------------
CREATE OR REPLACE FUNCTION notify_on_deposit()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tg_id    BIGINT;
  v_balance  INTEGER;
  v_rate     NUMERIC;
  v_top_usd  NUMERIC;
  v_bal_usd  NUMERIC;
  v_msg      TEXT;
BEGIN
  IF NEW.type != 'deposit' THEN RETURN NEW; END IF;

  SELECT telegram_id, balance INTO v_tg_id, v_balance
  FROM users WHERE id = NEW.user_id;

  IF v_tg_id IS NULL OR v_tg_id <= 0 THEN RETURN NEW; END IF;

  -- Pull the cached USD→RUB rate; fall back to 90 if missing or
  -- somehow non-positive so we never divide by zero.
  SELECT NULLIF((value::text)::numeric, 0)
    INTO v_rate
  FROM app_settings WHERE key = 'usd_rub_rate';
  IF v_rate IS NULL OR v_rate <= 0 THEN
    v_rate := 90;
  END IF;

  -- RUB → USD. NEW.amount and v_balance are both in RUB/stars.
  v_top_usd := ABS(NEW.amount) / v_rate;
  v_bal_usd := v_balance        / v_rate;

  v_msg := '💰 Balance topped up by $' || TO_CHAR(v_top_usd, 'FM999999990.00') || chr(10) ||
           'Current balance: $' || TO_CHAR(v_bal_usd, 'FM999999990.00');

  PERFORM notify_user(v_tg_id, v_msg);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$$;

-- Trigger already binds to notify_on_deposit() by name; CREATE OR
-- REPLACE above keeps it wired. Re-assert it for a clean re-run.
DROP TRIGGER IF EXISTS trg_notify_user_deposit ON transactions;
CREATE TRIGGER trg_notify_user_deposit
  AFTER INSERT ON transactions
  FOR EACH ROW
  WHEN (NEW.type = 'deposit')
  EXECUTE FUNCTION notify_on_deposit();

NOTIFY pgrst, 'reload schema';
