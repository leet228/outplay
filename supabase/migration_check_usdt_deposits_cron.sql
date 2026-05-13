-- !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
-- !!! TODO RUN ON PROD — schedules pg_cron to invoke the          !!!
-- !!! check-usdt-deposits Edge Function every 30 seconds.         !!!
-- !!!                                                              !!!
-- !!! Prereqs (same as the TON-indexer cron):                      !!!
-- !!!   1. pg_cron + pg_net extensions enabled                    !!!
-- !!!   2. Vault secrets present:                                 !!!
-- !!!        - project_url                                         !!!
-- !!!        - anon_key                                            !!!
-- !!!   3. Edge Function check-usdt-deposits deployed              !!!
-- !!!      (supabase functions deploy check-usdt-deposits)        !!!
-- !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
-- =============================================
-- check-usdt-deposits cron schedule
-- Mirror of migration_check_crypto_deposits_cron.sql but for the
-- USDT-on-TON jetton indexer. Runs every 30 seconds in parallel
-- with the TON-native indexer.
-- =============================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM cron.job
    WHERE jobname = 'check-usdt-deposits'
  ) THEN
    PERFORM cron.unschedule('check-usdt-deposits');
  END IF;
END $$;

SELECT cron.schedule(
  'check-usdt-deposits',
  '30 seconds',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url')
      || '/functions/v1/check-usdt-deposits',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'anon_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
