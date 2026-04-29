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
--    Sends DIRECTLY to Telegram API via pg_net — no Edge Function needed
CREATE OR REPLACE FUNCTION notify_admin_on_log()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bot TEXT;
  v_chat TEXT;
  v_icon TEXT;
  v_msg TEXT;
  v_details TEXT;
BEGIN
  IF NEW.level NOT IN ('error', 'warn') THEN
    RETURN NEW;
  END IF;

  SELECT decrypted_secret INTO v_bot FROM vault.decrypted_secrets WHERE name = 'telegram_bot_token' LIMIT 1;
  SELECT decrypted_secret INTO v_chat FROM vault.decrypted_secrets WHERE name = 'admin_tg_id' LIMIT 1;
  IF v_bot IS NULL THEN RETURN NEW; END IF;
  v_chat := COALESCE(v_chat, '945676433');

  IF NEW.level = 'error' THEN v_icon := '🔴'; ELSE v_icon := '🟡'; END IF;

  v_msg := v_icon || ' <b>' || UPPER(NEW.level) || '</b> | <code>' ||
           COALESCE(NEW.source, '') || '</code>' || chr(10) ||
           COALESCE(NEW.message, '');

  IF NEW.details IS NOT NULL AND NEW.details::text != '{}' AND NEW.details::text != 'null' THEN
    v_details := LEFT(NEW.details::text, 500);
    -- Escape HTML entities to prevent Telegram parse errors
    v_details := REPLACE(v_details, '&', '&amp;');
    v_details := REPLACE(v_details, '<', '&lt;');
    v_details := REPLACE(v_details, '>', '&gt;');
    v_msg := v_msg || chr(10) || '<pre>' || v_details || '</pre>';
  END IF;

  PERFORM net.http_post(
    url := 'https://api.telegram.org/bot' || v_bot || '/sendMessage',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := jsonb_build_object(
      'chat_id', v_chat,
      'text', v_msg,
      'parse_mode', 'HTML',
      'disable_web_page_preview', true
    )
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_admin_log ON admin_logs;
CREATE TRIGGER trg_notify_admin_log
  AFTER INSERT ON admin_logs
  FOR EACH ROW
  EXECUTE FUNCTION notify_admin_on_log();

-- 4. Trigger: notify admin on new bug report (text + photos)
CREATE OR REPLACE FUNCTION notify_admin_on_bug_report()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bot TEXT;
  v_chat TEXT;
  v_username TEXT;
  v_msg TEXT;
  v_photo TEXT;
  v_photo_count INT;
BEGIN
  SELECT decrypted_secret INTO v_bot FROM vault.decrypted_secrets WHERE name = 'telegram_bot_token' LIMIT 1;
  SELECT decrypted_secret INTO v_chat FROM vault.decrypted_secrets WHERE name = 'admin_tg_id' LIMIT 1;
  IF v_bot IS NULL THEN RETURN NEW; END IF;
  v_chat := COALESCE(v_chat, '945676433');

  SELECT username INTO v_username FROM users WHERE id = NEW.user_id;

  v_msg := '🐛 <b>New bug report</b>' || chr(10) ||
           '👤 @' || COALESCE(v_username, 'unknown') || chr(10) ||
           '📝 ' || LEFT(COALESCE(NEW.description, ''), 300);

  v_photo_count := COALESCE(array_length(NEW.photos, 1), 0);
  IF v_photo_count > 0 THEN
    v_msg := v_msg || chr(10) || '📎 Photos: ' || v_photo_count;
  END IF;

  IF NEW.device_info IS NOT NULL AND NEW.device_info != '' THEN
    v_msg := v_msg || chr(10) || '📱 ' || NEW.device_info;
  END IF;

  -- Send text message
  PERFORM net.http_post(
    url := 'https://api.telegram.org/bot' || v_bot || '/sendMessage',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := jsonb_build_object(
      'chat_id', v_chat,
      'text', v_msg,
      'parse_mode', 'HTML',
      'disable_web_page_preview', true
    )
  );

  -- Send each photo
  IF v_photo_count > 0 THEN
    FOREACH v_photo IN ARRAY NEW.photos LOOP
      IF v_photo IS NOT NULL AND v_photo LIKE 'http%' THEN
        PERFORM net.http_post(
          url := 'https://api.telegram.org/bot' || v_bot || '/sendPhoto',
          headers := '{"Content-Type": "application/json"}'::jsonb,
          body := jsonb_build_object(
            'chat_id', v_chat,
            'photo', v_photo
          )
        );
      END IF;
    END LOOP;
  END IF;

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
