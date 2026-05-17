-- !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
-- !!! TODO RUN ON PROD — daily admin Telegram report cron.   !!!
-- !!! 07:00 UTC = 10:00 МСК, every day. Deploy the Edge fn    !!!
-- !!! FIRST:  supabase functions deploy daily-admin-report    !!!
-- !!! Same Vault secrets (project_url, anon_key) as the other !!!
-- !!! crons.                                                  !!!
-- !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'daily-admin-report') THEN
    PERFORM cron.unschedule('daily-admin-report');
  END IF;
END $$;

SELECT cron.schedule(
  'daily-admin-report',
  '0 7 * * *',                    -- 07:00 UTC = 10:00 Moscow
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url')
      || '/functions/v1/daily-admin-report',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'anon_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
