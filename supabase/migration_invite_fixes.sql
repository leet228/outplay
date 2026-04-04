-- ╔═══════════════════════════════════════════════════╗
-- ║  Migration: Fix accept_game_invite                ║
-- ║  1. Check sender is still online on accept        ║
-- ║  2. Check neither player is in active duel        ║
-- ║  3. Support all game types (reaction/hearing/grad) ║
-- ╚═══════════════════════════════════════════════════╝

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
  v_last_seen     TIMESTAMPTZ;
  v_active_count  INTEGER;
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

  -- ═══ NEW: Проверяем что отправитель ещё онлайн ═══
  SELECT last_seen INTO v_last_seen FROM users WHERE id = v_inv.from_id;
  IF v_last_seen IS NULL OR v_last_seen < NOW() - INTERVAL '5 minutes' THEN
    UPDATE game_invites SET status = 'cancelled' WHERE id = p_invite_id;
    RETURN jsonb_build_object('error', 'sender_offline');
  END IF;

  -- ═══ NEW: Проверяем что отправитель не в активной дуэли ═══
  SELECT COUNT(*) INTO v_active_count FROM duels
  WHERE status = 'active'
    AND (creator_id = v_inv.from_id OR opponent_id = v_inv.from_id);
  IF v_active_count > 0 THEN
    UPDATE game_invites SET status = 'cancelled' WHERE id = p_invite_id;
    RETURN jsonb_build_object('error', 'sender_in_game');
  END IF;

  -- ═══ NEW: Проверяем что получатель не в активной дуэли ═══
  SELECT COUNT(*) INTO v_active_count FROM duels
  WHERE status = 'active'
    AND (creator_id = v_inv.to_id OR opponent_id = v_inv.to_id);
  IF v_active_count > 0 THEN
    RETURN jsonb_build_object('error', 'recipient_in_game');
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

  -- ═══ UPDATED: Подготовка дуэли — поддержка всех game_type ═══
  IF v_inv.game_type = 'quiz' THEN
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

  ELSIF v_inv.game_type = 'reaction' THEN
    v_category := 'reaction';

  ELSIF v_inv.game_type = 'hearing' THEN
    v_category := 'hearing';

  ELSIF v_inv.game_type = 'gradient' THEN
    v_category := 'gradient';

  ELSE
    RETURN jsonb_build_object('error', 'unknown_game_type');
  END IF;

  -- Создаём дуэль (from_id = creator, to_id = opponent)
  INSERT INTO duels (
    creator_id, opponent_id, category, stake, status,
    question_ids, game_type, bj_deck, bj_state
  )
  VALUES (
    v_inv.from_id, v_inv.to_id, v_category, v_inv.stake, 'active',
    COALESCE(v_question_ids, '{}'), v_inv.game_type, v_bj_deck, v_bj_state
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
  PERFORM admin_log('error', 'rpc:accept_game_invite', SQLERRM,
    jsonb_build_object('invite_id', p_invite_id, 'user_id', p_user_id));
  RETURN jsonb_build_object('error', SQLERRM);
END;
$$;
