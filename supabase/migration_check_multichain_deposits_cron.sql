-- !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
-- !!! TODO RUN ON PROD — multi-chain deposit indexer cron.   !!!
-- !!! Invokes check-multichain-deposits every minute         !!!
-- !!! ('* * * * *' — pg_cron rejects '60 seconds'; the       !!!
-- !!! seconds-interval form only accepts 1..59). Mirrors     !!!
-- !!! migration_check_crypto_deposits_cron.sql (same Vault    !!!
-- !!! secrets project_url + anon_key, pg_cron + pg_net).      !!!
-- !!! Deploy the Edge Function FIRST:                          !!!
-- !!!   supabase functions deploy check-multichain-deposits   !!!
-- !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'check-multichain-deposits'
  ) THEN
    PERFORM cron.unschedule('check-multichain-deposits');
  END IF;
END $$;

SELECT cron.schedule(
  'check-multichain-deposits',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url')
      || '/functions/v1/check-multichain-deposits',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'anon_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
