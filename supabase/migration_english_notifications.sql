-- English Telegram notification texts.
-- Re-run safe: all functions are CREATE OR REPLACE.

CREATE OR REPLACE FUNCTION notify_on_deposit()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tg_id   BIGINT;
  v_balance INTEGER;
  v_msg     TEXT;
  v_paid    TEXT := '';
BEGIN
  IF NEW.type != 'deposit' THEN RETURN NEW; END IF;

  SELECT telegram_id, balance INTO v_tg_id, v_balance
  FROM users WHERE id = NEW.user_id;

  IF v_tg_id IS NULL OR v_tg_id <= 0 THEN RETURN NEW; END IF;

  IF NEW.currency_amount IS NOT NULL AND NEW.currency_code IS NOT NULL THEN
    v_paid := chr(10) || 'Paid: ' ||
      TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM TO_CHAR(ABS(NEW.currency_amount), 'FM999999990.00'))) ||
      ' ' || UPPER(NEW.currency_code);
  END IF;

  v_msg := '💰 Balance topped up by ' || ABS(NEW.amount) || ' ⭐' ||
           v_paid || chr(10) ||
           'Current balance: ' || v_balance || ' ⭐';

  PERFORM notify_user(v_tg_id, v_msg);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION notify_on_withdrawal()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tg_id BIGINT;
  v_msg   TEXT;
  v_amount TEXT;
BEGIN
  IF NEW.type != 'withdrawal' THEN RETURN NEW; END IF;

  SELECT telegram_id INTO v_tg_id
  FROM users WHERE id = NEW.user_id;

  IF v_tg_id IS NULL OR v_tg_id <= 0 THEN RETURN NEW; END IF;

  v_amount := ABS(NEW.amount)::TEXT;

  v_msg := '💸 Withdrawal requested: ' || v_amount || ' ⭐' || chr(10) ||
           'Estimated payout time: up to 2 minutes';

  PERFORM notify_user(v_tg_id, v_msg);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION notify_on_game_invite()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tg_id      BIGINT;
  v_sender     TEXT;
  v_game_label TEXT;
  v_msg        TEXT;
  v_markup     JSONB;
BEGIN
  IF NEW.status != 'pending' THEN RETURN NEW; END IF;

  SELECT telegram_id INTO v_tg_id
  FROM users
  WHERE id = NEW.to_id;

  IF v_tg_id IS NULL OR v_tg_id <= 0 THEN RETURN NEW; END IF;

  SELECT COALESCE(first_name, username, 'Player') INTO v_sender
  FROM users
  WHERE id = NEW.from_id;

  CASE NEW.game_type
    WHEN 'quiz' THEN v_game_label := 'Quiz';
    WHEN 'blackjack' THEN v_game_label := 'Blackjack';
    WHEN 'sequence' THEN v_game_label := 'Memory';
    WHEN 'reaction' THEN v_game_label := 'Reaction';
    WHEN 'hearing' THEN v_game_label := 'Hearing';
    WHEN 'gradient' THEN v_game_label := 'Gradient';
    WHEN 'race' THEN v_game_label := 'Race';
    WHEN 'capitals' THEN v_game_label := 'Capitals';
    WHEN 'circle' THEN v_game_label := 'Circle';
    ELSE v_game_label := INITCAP(REPLACE(NEW.game_type, '_', ' '));
  END CASE;

  v_msg := '🎮 ' || v_sender || ' invited you to a duel!' || chr(10) ||
           'Stake: ' || NEW.stake || ' ⭐ · ' || v_game_label;

  v_markup := jsonb_build_object(
    'inline_keyboard', jsonb_build_array(
      jsonb_build_array(
        jsonb_build_object(
          'text', '▶️ Open game',
          'url', 'https://t.me/outplaymoneybot/app'
        )
      )
    )
  );

  PERFORM notify_user(v_tg_id, v_msg, v_markup);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION notify_season_end()
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER := 0;
  v_rec   RECORD;
  v_msg   TEXT;
  v_markup JSONB;
BEGIN
  v_msg := '🏆 The guild season is over!' || chr(10) ||
           'Open Outplay to see the results.';

  v_markup := jsonb_build_object(
    'inline_keyboard', jsonb_build_array(
      jsonb_build_array(
        jsonb_build_object(
          'text', '🏆 Results',
          'url', 'https://t.me/outplaymoneybot/app'
        )
      )
    )
  );

  FOR v_rec IN
    SELECT telegram_id FROM users
    WHERE telegram_id > 0
      AND last_seen > NOW() - INTERVAL '30 days'
  LOOP
    PERFORM notify_user(v_rec.telegram_id, v_msg, v_markup);
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION send_retention_reminders()
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count  INTEGER := 0;
  v_rec    RECORD;
  v_msg    TEXT;
  v_markup JSONB;
BEGIN
  v_msg := '💥 You have not played for a while — jump back in and outplay everyone!';

  v_markup := jsonb_build_object(
    'inline_keyboard', jsonb_build_array(
      jsonb_build_array(
        jsonb_build_object(
          'text', '🎮 Play',
          'url', 'https://t.me/outplaymoneybot/app'
        )
      )
    )
  );

  FOR v_rec IN
    SELECT id, telegram_id FROM users
    WHERE telegram_id > 0
      AND last_seen < NOW() - INTERVAL '1 day'
      AND last_seen > NOW() - INTERVAL '7 days'
      AND (last_reminded IS NULL OR last_reminded < NOW() - INTERVAL '1 day')
  LOOP
    PERFORM notify_user(v_rec.telegram_id, v_msg, v_markup);
    UPDATE users SET last_reminded = NOW() WHERE id = v_rec.id;
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

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

