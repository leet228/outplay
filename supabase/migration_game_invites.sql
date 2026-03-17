-- =============================================
-- Migration: Game Invites (Friend-to-Friend)
-- Запусти в Supabase SQL Editor
-- =============================================

-- ╔═══════════════════════════════════════════╗
-- ║  1. Таблица game_invites                 ║
-- ╚═══════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS game_invites (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_id     UUID NOT NULL REFERENCES users(id),
  to_id       UUID NOT NULL REFERENCES users(id),
  game_type   TEXT NOT NULL CHECK (game_type IN ('quiz', 'blackjack', 'sequence')),
  stake       INTEGER NOT NULL CHECK (stake > 0),
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled', 'expired')),
  duel_id     UUID REFERENCES duels(id),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  expires_at  TIMESTAMPTZ DEFAULT NOW() + INTERVAL '5 minutes'
);

CREATE INDEX IF NOT EXISTS idx_game_invites_to ON game_invites(to_id, status);
CREATE INDEX IF NOT EXISTS idx_game_invites_from ON game_invites(from_id, status);

-- RLS
ALTER TABLE game_invites ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "game_invites_read" ON game_invites;
CREATE POLICY "game_invites_read" ON game_invites FOR SELECT
  USING (from_id = auth.uid() OR to_id = auth.uid() OR true);
-- Note: SECURITY DEFINER RPCs bypass RLS; "true" allows realtime to work for anon key

-- Realtime
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE game_invites;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;


-- ╔═══════════════════════════════════════════╗
-- ║  2. RPC: send_game_invite                ║
-- ╚═══════════════════════════════════════════╝

CREATE OR REPLACE FUNCTION send_game_invite(
  p_from_id   UUID,
  p_to_id     UUID,
  p_game_type TEXT,
  p_stake     INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_invite_id   UUID;
  v_balance     INTEGER;
  v_last_seen   TIMESTAMPTZ;
BEGIN
  -- Нельзя пригласить себя
  IF p_from_id = p_to_id THEN
    RETURN jsonb_build_object('error', 'cannot_invite_self');
  END IF;

  -- Проверяем дружбу
  IF NOT EXISTS (
    SELECT 1 FROM friends WHERE user_id = p_from_id AND friend_id = p_to_id
  ) THEN
    RETURN jsonb_build_object('error', 'not_friends');
  END IF;

  -- Проверяем что получатель онлайн (last_seen < 5 мин)
  SELECT last_seen INTO v_last_seen FROM users WHERE id = p_to_id;
  IF v_last_seen IS NULL OR v_last_seen < NOW() - INTERVAL '5 minutes' THEN
    RETURN jsonb_build_object('error', 'friend_offline');
  END IF;

  -- Проверяем баланс отправителя
  SELECT balance INTO v_balance FROM users WHERE id = p_from_id;
  IF v_balance IS NULL OR v_balance < p_stake THEN
    RETURN jsonb_build_object('error', 'insufficient_balance');
  END IF;

  -- Отменяем все pending инвайты от этого пользователя
  UPDATE game_invites SET status = 'cancelled'
  WHERE from_id = p_from_id AND status = 'pending';

  -- Создаём инвайт
  INSERT INTO game_invites (from_id, to_id, game_type, stake)
  VALUES (p_from_id, p_to_id, p_game_type, p_stake)
  RETURNING id INTO v_invite_id;

  RETURN jsonb_build_object('status', 'sent', 'invite_id', v_invite_id);

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('error', SQLERRM);
END;
$$;


-- ╔═══════════════════════════════════════════╗
-- ║  3. RPC: accept_game_invite              ║
-- ╚═══════════════════════════════════════════╝

CREATE OR REPLACE FUNCTION accept_game_invite(
  p_invite_id UUID,
  p_user_id   UUID
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_inv           game_invites%ROWTYPE;
  v_duel_id       UUID;
  v_question_ids  UUID[];
  v_from_balance  INTEGER;
  v_to_balance    INTEGER;
  v_affected      INTEGER;
  v_bj_deck       JSONB;
  v_bj_state      JSONB;
  v_category      TEXT;
BEGIN
  -- Блокируем инвайт
  SELECT * INTO v_inv FROM game_invites WHERE id = p_invite_id FOR UPDATE;

  IF v_inv IS NULL THEN
    RETURN jsonb_build_object('error', 'invite_not_found');
  END IF;

  IF v_inv.to_id != p_user_id THEN
    RETURN jsonb_build_object('error', 'not_recipient');
  END IF;

  IF v_inv.status != 'pending' THEN
    RETURN jsonb_build_object('error', 'invite_not_pending');
  END IF;

  IF v_inv.expires_at < NOW() THEN
    UPDATE game_invites SET status = 'expired' WHERE id = p_invite_id;
    RETURN jsonb_build_object('error', 'invite_expired');
  END IF;

  -- Проверяем баланс обоих
  SELECT balance INTO v_from_balance FROM users WHERE id = v_inv.from_id;
  SELECT balance INTO v_to_balance FROM users WHERE id = v_inv.to_id;

  IF v_from_balance IS NULL OR v_from_balance < v_inv.stake THEN
    UPDATE game_invites SET status = 'cancelled' WHERE id = p_invite_id;
    RETURN jsonb_build_object('error', 'sender_insufficient_balance');
  END IF;

  IF v_to_balance IS NULL OR v_to_balance < v_inv.stake THEN
    RETURN jsonb_build_object('error', 'insufficient_balance');
  END IF;

  -- Подготовка дуэли в зависимости от game_type
  IF v_inv.game_type = 'quiz' THEN
    -- Вопросы из всех категорий
    SELECT ARRAY(
      SELECT id FROM questions ORDER BY RANDOM() LIMIT 5
    ) INTO v_question_ids;

    IF v_question_ids IS NULL OR array_length(v_question_ids, 1) IS NULL OR array_length(v_question_ids, 1) < 5 THEN
      RETURN jsonb_build_object('error', 'not_enough_questions');
    END IF;
    v_category := 'quiz';

  ELSIF v_inv.game_type = 'blackjack' THEN
    v_bj_deck := generate_blackjack_deck();
    v_bj_state := init_blackjack_state(v_bj_deck);
    v_category := 'blackjack';

  ELSIF v_inv.game_type = 'sequence' THEN
    v_category := 'sequence';
    -- sequence is fully client-side, no questions needed
  END IF;

  -- Создаём дуэль (from_id = creator, to_id = opponent)
  INSERT INTO duels (
    creator_id, opponent_id, category, stake, status,
    question_ids, game_type, bj_deck, bj_state
  )
  VALUES (
    v_inv.from_id, v_inv.to_id, v_category, v_inv.stake, 'active',
    v_question_ids, v_inv.game_type, v_bj_deck, v_bj_state
  )
  RETURNING id INTO v_duel_id;

  -- Списываем ставку с обоих
  UPDATE users SET balance = balance - v_inv.stake
  WHERE id = v_inv.from_id AND balance >= v_inv.stake;
  GET DIAGNOSTICS v_affected = ROW_COUNT;
  IF v_affected = 0 THEN
    DELETE FROM duels WHERE id = v_duel_id;
    UPDATE game_invites SET status = 'cancelled' WHERE id = p_invite_id;
    RETURN jsonb_build_object('error', 'sender_insufficient_balance');
  END IF;

  UPDATE users SET balance = balance - v_inv.stake
  WHERE id = v_inv.to_id AND balance >= v_inv.stake;
  GET DIAGNOSTICS v_affected = ROW_COUNT;
  IF v_affected = 0 THEN
    -- Rollback sender deduction
    UPDATE users SET balance = balance + v_inv.stake WHERE id = v_inv.from_id;
    DELETE FROM duels WHERE id = v_duel_id;
    RETURN jsonb_build_object('error', 'insufficient_balance');
  END IF;

  -- Transactions
  INSERT INTO transactions (user_id, type, amount, ref_id)
  VALUES
    (v_inv.from_id, 'duel_loss', -v_inv.stake, v_duel_id),
    (v_inv.to_id, 'duel_loss', -v_inv.stake, v_duel_id);

  -- Обновляем инвайт
  UPDATE game_invites
  SET status = 'accepted', duel_id = v_duel_id
  WHERE id = p_invite_id;

  RETURN jsonb_build_object(
    'status', 'accepted',
    'duel_id', v_duel_id,
    'game_type', v_inv.game_type
  );

EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('error', SQLERRM);
END;
$$;


-- ╔═══════════════════════════════════════════╗
-- ║  4. RPC: reject_game_invite              ║
-- ╚═══════════════════════════════════════════╝

CREATE OR REPLACE FUNCTION reject_game_invite(
  p_invite_id UUID,
  p_user_id   UUID
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  UPDATE game_invites SET status = 'rejected'
  WHERE id = p_invite_id AND to_id = p_user_id AND status = 'pending';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'invite_not_found_or_not_pending');
  END IF;

  RETURN jsonb_build_object('status', 'rejected');
END;
$$;


-- ╔═══════════════════════════════════════════╗
-- ║  5. RPC: cancel_game_invite              ║
-- ╚═══════════════════════════════════════════╝

CREATE OR REPLACE FUNCTION cancel_game_invite(
  p_invite_id UUID,
  p_user_id   UUID
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  UPDATE game_invites SET status = 'cancelled'
  WHERE id = p_invite_id AND from_id = p_user_id AND status = 'pending';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'invite_not_found_or_not_pending');
  END IF;

  RETURN jsonb_build_object('status', 'cancelled');
END;
$$;


-- ╔═══════════════════════════════════════════╗
-- ║  6. RPC: cancel_all_pending_invites      ║
-- ╚═══════════════════════════════════════════╝

CREATE OR REPLACE FUNCTION cancel_all_pending_invites(p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  UPDATE game_invites SET status = 'cancelled'
  WHERE from_id = p_user_id AND status = 'pending';
END;
$$;


-- ╔═══════════════════════════════════════════╗
-- ║  DONE! Game invites migration ready      ║
-- ╚═══════════════════════════════════════════╝
