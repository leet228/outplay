-- ╔═══════════════════════════════════════════════════════╗
-- ║  ADMIN NOTIFICATIONS — RPCs + Triggers              ║
-- ║  Run after migration_bug_reports.sql                 ║
-- ╚═══════════════════════════════════════════════════════╝

-- 1. get_bug_reports — list reports with user info
CREATE OR REPLACE FUNCTION get_bug_reports(p_status TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN (
    SELECT COALESCE(jsonb_agg(row_to_json(r) ORDER BY r.created_at DESC), '[]'::jsonb)
    FROM (
      SELECT
        br.id, br.description, br.photos, br.device_info,
        br.app_version, br.context, br.status, br.created_at,
        u.username, u.first_name, u.telegram_id
      FROM bug_reports br
      JOIN users u ON u.id = br.user_id
      WHERE (p_status IS NULL OR br.status = p_status)
      ORDER BY br.created_at DESC
      LIMIT 100
    ) r
  );
END;
$$;

GRANT EXECUTE ON FUNCTION get_bug_reports(TEXT) TO anon, authenticated;

-- 2. update_bug_report_status
CREATE OR REPLACE FUNCTION update_bug_report_status(
  p_report_id UUID,
  p_status TEXT
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_status NOT IN ('new', 'seen', 'resolved', 'closed') THEN
    RETURN jsonb_build_object('error', 'invalid_status');
  END IF;

  UPDATE bug_reports SET status = p_status WHERE id = p_report_id;

  PERFORM admin_log('info', 'rpc:update_bug_report_status',
    'Bug report status updated',
    jsonb_build_object('report_id', p_report_id, 'new_status', p_status)
  );

  RETURN jsonb_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION update_bug_report_status(UUID, TEXT) TO anon, authenticated;

-- 3. Trigger: notify admin on error/warn logs
--    Sends directly to Telegram API via pg_net (no Edge Function needed)
--    Uses Edge Function URL with service role key from Supabase project settings
CREATE OR REPLACE FUNCTION notify_admin_on_log()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_url TEXT := 'https://aakczalawsfnwykzpcsc.supabase.co/functions/v1/notify-admin';
  v_key TEXT;
BEGIN
  IF NEW.level IN ('error', 'warn') THEN
    -- Get service role key from vault (stored by Supabase automatically)
    SELECT decrypted_secret INTO v_key
    FROM vault.decrypted_secrets
    WHERE name = 'service_role_key'
    LIMIT 1;

    -- Fallback: skip notification if key not found
    IF v_key IS NULL THEN
      RETURN NEW;
    END IF;

    PERFORM net.http_post(
      url := v_url,
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || v_key,
        'Content-Type', 'application/json'
      ),
      body := jsonb_build_object(
        'type', 'log',
        'data', jsonb_build_object(
          'level', NEW.level,
          'source', NEW.source,
          'message', NEW.message,
          'details', NEW.details,
          'created_at', NEW.created_at
        )
      )
    );
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never block inserts if notification fails
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_admin_log ON admin_logs;
CREATE TRIGGER trg_notify_admin_log
  AFTER INSERT ON admin_logs
  FOR EACH ROW
  EXECUTE FUNCTION notify_admin_on_log();

-- 4. Trigger: notify admin on new bug report
CREATE OR REPLACE FUNCTION notify_admin_on_bug_report()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_username TEXT;
  v_url TEXT := 'https://aakczalawsfnwykzpcsc.supabase.co/functions/v1/notify-admin';
  v_key TEXT;
BEGIN
  SELECT username INTO v_username FROM users WHERE id = NEW.user_id;

  SELECT decrypted_secret INTO v_key
  FROM vault.decrypted_secrets
  WHERE name = 'service_role_key'
  LIMIT 1;

  IF v_key IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_key,
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object(
      'type', 'bug_report',
      'data', jsonb_build_object(
        'username', COALESCE(v_username, 'unknown'),
        'description', LEFT(NEW.description, 300),
        'photos', COALESCE(NEW.photos, ARRAY[]::TEXT[]),
        'photos_count', COALESCE(array_length(NEW.photos, 1), 0),
        'device_info', COALESCE(NEW.device_info, ''),
        'created_at', NEW.created_at
      )
    )
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_admin_bug_report ON bug_reports;
CREATE TRIGGER trg_notify_admin_bug_report
  AFTER INSERT ON bug_reports
  FOR EACH ROW
  EXECUTE FUNCTION notify_admin_on_bug_report();
