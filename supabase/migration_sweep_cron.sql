-- !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
-- !!! TODO RUN ON PROD — sweep-deposits cron (every 5 min).  !!!
-- !!! Run AFTER migration_sweep.sql AND after deploying:     !!!
-- !!!   supabase functions deploy sweep-deposits             !!!
-- !!! Same Vault secrets (project_url, anon_key) as the      !!!
-- !!! other indexer crons.                                   !!!
-- !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sweep-deposits') THEN
    PERFORM cron.unschedule('sweep-deposits');
  END IF;
END $$;

SELECT cron.schedule(
  'sweep-deposits',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url')
      || '/functions/v1/sweep-deposits',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'anon_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
