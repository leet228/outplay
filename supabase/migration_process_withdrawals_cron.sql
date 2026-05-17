-- !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
-- !!! TODO RUN ON PROD — TON/USDT-TON withdrawals processor   !!!
-- !!! cron. Every minute. The original migration_withdrawals  !!!
-- !!! only had this as a COMMENTED instruction, so on prod it  !!!
-- !!! likely never got scheduled — TON payouts relied solely  !!!
-- !!! on the frontend's one-shot ping. This makes it a real,  !!!
-- !!! reliable cron like every other recurring function.      !!!
-- !!! Deploy the Edge fn FIRST:                                !!!
-- !!!   supabase functions deploy process-withdrawals          !!!
-- !!! Same Vault secrets (project_url, anon_key) as the other  !!!
-- !!! crons.                                                   !!!
-- !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'process-withdrawals') THEN
    PERFORM cron.unschedule('process-withdrawals');
  END IF;
END $$;

SELECT cron.schedule(
  'process-withdrawals',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url')
      || '/functions/v1/process-withdrawals',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'anon_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 280000
  );
  $$
);
