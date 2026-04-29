-- check-crypto-deposits cron schedule
-- Run in Supabase SQL Editor after enabling pg_cron + pg_net.
-- This invokes the Edge Function every 30 seconds.
--
-- Required Vault secrets:
--   select vault.create_secret('https://your-project-ref.supabase.co', 'project_url');
--   select vault.create_secret('YOUR_SUPABASE_ANON_KEY', 'anon_key');

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM cron.job
    WHERE jobname = 'check-crypto-deposits'
  ) THEN
    PERFORM cron.unschedule('check-crypto-deposits');
  END IF;
END $$;

SELECT cron.schedule(
  'check-crypto-deposits',
  '30 seconds',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url')
      || '/functions/v1/check-crypto-deposits',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'anon_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
