-- ╔═══════════════════════════════════════════════════════════╗
-- ║  send_admin_telegram — the ONE reliable admin TG sender    ║
-- ║  Same proven path as the admin_log notifications: vault    ║
-- ║  secrets + net.http_post. Edge fns that build a report     ║
-- ║  (daily-admin-report, rebalance) call this RPC instead of  ║
-- ║  fetching Telegram with a Deno env token that may be unset.║
-- ╚═══════════════════════════════════════════════════════════╝

CREATE OR REPLACE FUNCTION send_admin_telegram(p_text TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_bot  TEXT;
  v_chat TEXT;
BEGIN
  SELECT decrypted_secret INTO v_bot  FROM vault.decrypted_secrets WHERE name = 'telegram_bot_token' LIMIT 1;
  SELECT decrypted_secret INTO v_chat FROM vault.decrypted_secrets WHERE name = 'admin_tg_id'        LIMIT 1;
  IF v_bot IS NULL THEN RETURN FALSE; END IF;
  v_chat := COALESCE(v_chat, '945676433');

  PERFORM net.http_post(
    url := 'https://api.telegram.org/bot' || v_bot || '/sendMessage',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := jsonb_build_object(
      'chat_id', v_chat,
      'text', p_text,
      'parse_mode', 'HTML',
      'disable_web_page_preview', true
    )
  );
  RETURN TRUE;
EXCEPTION WHEN OTHERS THEN
  RETURN FALSE;
END;
$$;
GRANT EXECUTE ON FUNCTION send_admin_telegram(TEXT) TO anon;
