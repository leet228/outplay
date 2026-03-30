-- ╔═══════════════════════════════════════════════════════╗
-- ║  USER NOTIFICATIONS — Telegram Bot Messages          ║
-- ║  Run after all other migrations                      ║
-- ╚═══════════════════════════════════════════════════════╝

-- ══════════════════════════════════════════
--  0. Add last_reminded column to users
-- ══════════════════════════════════════════
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_reminded TIMESTAMPTZ;

-- ══════════════════════════════════════════
--  1. Core: notify_user() — reusable sender
-- ══════════════════════════════════════════
CREATE OR REPLACE FUNCTION notify_user(
  p_telegram_id BIGINT,
  p_text        TEXT,
  p_reply_markup JSONB DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bot  TEXT;
  v_body JSONB;
BEGIN
  IF p_telegram_id IS NULL OR p_telegram_id <= 0 THEN RETURN; END IF;

  SELECT decrypted_secret INTO v_bot
  FROM vault.decrypted_secrets
  WHERE name = 'telegram_bot_token' LIMIT 1;

  IF v_bot IS NULL THEN RETURN; END IF;

  v_body := jsonb_build_object(
    'chat_id', p_telegram_id,
    'text', p_text,
    'parse_mode', 'HTML',
    'disable_web_page_preview', true
  );

  IF p_reply_markup IS NOT NULL THEN
    v_body := v_body || jsonb_build_object('reply_markup', p_reply_markup);
  END IF;

  PERFORM net.http_post(
    url     := 'https://api.telegram.org/bot' || v_bot || '/sendMessage',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body    := v_body
  );

EXCEPTION WHEN OTHERS THEN
  -- Silent fail — don't break the triggering operation
  NULL;
END;
$$;

-- ══════════════════════════════════════════
--  2. Deposit notification
-- ══════════════════════════════════════════
CREATE OR REPLACE FUNCTION notify_on_deposit()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tg_id  BIGINT;
  v_balance INTEGER;
  v_msg    TEXT;
BEGIN
  IF NEW.type != 'deposit' THEN RETURN NEW; END IF;

  SELECT telegram_id, balance INTO v_tg_id, v_balance
  FROM users WHERE id = NEW.user_id;

  IF v_tg_id IS NULL OR v_tg_id <= 0 THEN RETURN NEW; END IF;

  v_msg := '💰 Баланс пополнен на ' || ABS(NEW.amount) || ' ⭐' || chr(10) ||
           'Текущий баланс: ' || v_balance || ' ₽';

  PERFORM notify_user(v_tg_id, v_msg);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_user_deposit ON transactions;
CREATE TRIGGER trg_notify_user_deposit
  AFTER INSERT ON transactions
  FOR EACH ROW
  WHEN (NEW.type = 'deposit')
  EXECUTE FUNCTION notify_on_deposit();

-- ══════════════════════════════════════════
--  3. Withdrawal notification
-- ══════════════════════════════════════════
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

  v_msg := '💸 Вывод ' || v_amount || ' ₽ оформлен' || chr(10) ||
           'Ожидайте зачисления в течение 2 минут';

  PERFORM notify_user(v_tg_id, v_msg);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_user_withdrawal ON transactions;
CREATE TRIGGER trg_notify_user_withdrawal
  AFTER INSERT ON transactions
  FOR EACH ROW
  WHEN (NEW.type = 'withdrawal')
  EXECUTE FUNCTION notify_on_withdrawal();

-- ══════════════════════════════════════════
--  4. Game invite notification
-- ══════════════════════════════════════════
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

  -- Get recipient telegram_id
  SELECT telegram_id INTO v_tg_id
  FROM users WHERE id = NEW.to_id;

  IF v_tg_id IS NULL OR v_tg_id <= 0 THEN RETURN NEW; END IF;

  -- Get sender name
  SELECT COALESCE(first_name, username, 'Игрок') INTO v_sender
  FROM users WHERE id = NEW.from_id;

  -- Game type label
  CASE NEW.game_type
    WHEN 'quiz' THEN v_game_label := 'Викторина';
    WHEN 'blackjack' THEN v_game_label := 'Блэкджек';
    WHEN 'sequence' THEN v_game_label := 'Последовательность';
    ELSE v_game_label := NEW.game_type;
  END CASE;

  v_msg := '🎮 ' || v_sender || ' зовёт тебя в игру!' || chr(10) ||
           'Ставка: ' || NEW.stake || ' ₽ · ' || v_game_label;

  -- Inline button to open mini app
  v_markup := jsonb_build_object(
    'inline_keyboard', jsonb_build_array(
      jsonb_build_array(
        jsonb_build_object(
          'text', '▶️ Открыть игру',
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

DROP TRIGGER IF EXISTS trg_notify_game_invite ON game_invites;
CREATE TRIGGER trg_notify_game_invite
  AFTER INSERT ON game_invites
  FOR EACH ROW
  WHEN (NEW.status = 'pending')
  EXECUTE FUNCTION notify_on_game_invite();

-- ══════════════════════════════════════════
--  5. Season end notification (manual call)
-- ══════════════════════════════════════════
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
  v_msg := '🏆 Сезон гильдий завершён!' || chr(10) ||
           'Заходи посмотреть результаты';

  v_markup := jsonb_build_object(
    'inline_keyboard', jsonb_build_array(
      jsonb_build_array(
        jsonb_build_object(
          'text', '🏆 Результаты',
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

-- ══════════════════════════════════════════
--  6. Daily retention reminders
-- ══════════════════════════════════════════
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
  v_msg := '💥 Давно не играл — самое время вернуться!';

  v_markup := jsonb_build_object(
    'inline_keyboard', jsonb_build_array(
      jsonb_build_array(
        jsonb_build_object(
          'text', '🎮 Играть',
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

-- ══════════════════════════════════════════
--  7. pg_cron: daily retention at 12:00 UTC
--     (Uncomment if pg_cron is enabled)
-- ══════════════════════════════════════════
-- SELECT cron.schedule(
--   'daily-retention-reminders',
--   '0 12 * * *',
--   $$SELECT send_retention_reminders()$$
-- );
