-- !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
-- !!! TODO RUN ON PROD — withdrawal notification in USD.          !!!
-- !!! "💸 Withdrawal requested: <amount> ⭐" → hard-coded in USD.  !!!
-- !!! Same approach as migration_deposit_notif_usd.sql: balance   !!!
-- !!! is RUB/stars (1 ⭐ = 1 ₽); divide by the cached usd_rub_rate !!!
-- !!! (kept fresh by the Edge Functions). Run AFTER               !!!
-- !!! migration_english_notifications.sql — CREATE OR REPLACE so  !!!
-- !!! it just supersedes that copy.                               !!!
-- !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

INSERT INTO app_settings (key, value) VALUES
  ('usd_rub_rate', '90'::jsonb)
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION notify_on_withdrawal()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tg_id  BIGINT;
  v_rate   NUMERIC;
  v_usd    NUMERIC;
  v_msg    TEXT;
BEGIN
  IF NEW.type != 'withdrawal' THEN RETURN NEW; END IF;

  SELECT telegram_id INTO v_tg_id
  FROM users WHERE id = NEW.user_id;

  IF v_tg_id IS NULL OR v_tg_id <= 0 THEN RETURN NEW; END IF;

  -- Cached USD→RUB rate; fall back to 90 so we never divide by zero.
  SELECT NULLIF((value::text)::numeric, 0)
    INTO v_rate
  FROM app_settings WHERE key = 'usd_rub_rate';
  IF v_rate IS NULL OR v_rate <= 0 THEN
    v_rate := 90;
  END IF;

  -- NEW.amount is in RUB/stars (negative for withdrawals).
  v_usd := ABS(NEW.amount) / v_rate;

  v_msg := '💸 Withdrawal requested: $' ||
           TO_CHAR(v_usd, 'FM999999990.00') || chr(10) ||
           'Estimated payout time: up to 2 minutes';

  PERFORM notify_user(v_tg_id, v_msg);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$$;

-- Re-assert the trigger binding (CREATE OR REPLACE keeps it, this
-- is just for a clean stand-alone re-run).
DROP TRIGGER IF EXISTS trg_notify_user_withdrawal ON transactions;
CREATE TRIGGER trg_notify_user_withdrawal
  AFTER INSERT ON transactions
  FOR EACH ROW
  WHEN (NEW.type = 'withdrawal')
  EXECUTE FUNCTION notify_on_withdrawal();

NOTIFY pgrst, 'reload schema';
