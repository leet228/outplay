-- !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
-- !!! TODO RUN ON PROD — daily treasury rebalance cron.       !!!
-- !!! 00:00 UTC = 03:00 МСК, every day. Deploy the Edge fn     !!!
-- !!! FIRST:  supabase functions deploy rebalance              !!!
-- !!! Same Vault secrets (project_url, anon_key) as the other  !!!
-- !!! crons. Runs DRY-RUN until app_settings.rebalance_live=on. !!!
-- !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'rebalance') THEN
    PERFORM cron.unschedule('rebalance');
  END IF;
END $$;

SELECT cron.schedule(
  'rebalance',
  '0 0 * * *',                    -- 00:00 UTC = 03:00 Moscow
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url')
      || '/functions/v1/rebalance',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'anon_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 280000
  );
  $$
);
