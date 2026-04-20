-- ====================================================
--  Migration: Game invite notification labels refresh
--  Ensures all current game types have human-readable
--  labels in Telegram invite notifications.
-- ====================================================

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
  IF NEW.status != 'pending' THEN
    RETURN NEW;
  END IF;

  SELECT telegram_id INTO v_tg_id
  FROM users
  WHERE id = NEW.to_id;

  IF v_tg_id IS NULL OR v_tg_id <= 0 THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(first_name, username, 'Игрок') INTO v_sender
  FROM users
  WHERE id = NEW.from_id;

  CASE NEW.game_type
    WHEN 'quiz' THEN v_game_label := 'Викторина';
    WHEN 'blackjack' THEN v_game_label := 'Блэкджек';
    WHEN 'sequence' THEN v_game_label := 'Последовательность';
    WHEN 'reaction' THEN v_game_label := 'Реакция';
    WHEN 'hearing' THEN v_game_label := 'Слух';
    WHEN 'gradient' THEN v_game_label := 'Градиент';
    WHEN 'race' THEN v_game_label := 'Гонка';
    WHEN 'capitals' THEN v_game_label := 'Столицы';
    ELSE v_game_label := NEW.game_type;
  END CASE;

  v_msg := '🎮 ' || v_sender || ' зовёт тебя в игру!' || chr(10) ||
           'Ставка: ' || NEW.stake || ' ₽ · ' || v_game_label;

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
