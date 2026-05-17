-- !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
-- !!! TODO RUN ON PROD — crypto withdrawals processor cron.   !!!
-- !!! Every minute. Deploy the Edge fn FIRST:                 !!!
-- !!!   supabase functions deploy process-crypto-withdrawals  !!!
-- !!! Run migration_crypto_withdrawals.sql BEFORE this.       !!!
-- !!! Same Vault secrets (project_url, anon_key) as other     !!!
-- !!! crons. Stays idle until app_settings.crypto_payout_     !!!
-- !!! enabled = true.                                         !!!
-- !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'process-crypto-withdrawals') THEN
    PERFORM cron.unschedule('process-crypto-withdrawals');
  END IF;
END $$;

SELECT cron.schedule(
  'process-crypto-withdrawals',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url')
      || '/functions/v1/process-crypto-withdrawals',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'anon_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 280000
  );
  $$
);
