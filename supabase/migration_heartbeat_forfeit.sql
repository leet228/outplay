-- ╔═══════════════════════════════════════════════════════════╗
-- ║  Migration: Heartbeat + Forfeit система                   ║
-- ║  Фикс 1: Отмена поиска при выходе из приложения          ║
-- ║  Фикс 2: Автофорфейт при выходе из дуэли                ║
-- ╚═══════════════════════════════════════════════════════════╝

-- 1. Добавляем колонки heartbeat в duels
ALTER TABLE duels ADD COLUMN IF NOT EXISTS creator_heartbeat TIMESTAMPTZ;
ALTER TABLE duels ADD COLUMN IF NOT EXISTS opponent_heartbeat TIMESTAMPTZ;

-- Индекс для быстрого поиска активных дуэлей с протухшим heartbeat
CREATE INDEX IF NOT EXISTS idx_duels_active_heartbeat
  ON duels(status) WHERE status = 'active';

-- ══════════════════════════════════════════════════
-- 2. heartbeat_duel — игрок шлёт пинг каждые 10 сек
-- ══════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION heartbeat_duel(p_duel_id UUID, p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
  UPDATE duels
  SET creator_heartbeat = CASE WHEN creator_id = p_user_id THEN NOW() ELSE creator_heartbeat END,
      opponent_heartbeat = CASE WHEN opponent_id = p_user_id THEN NOW() ELSE opponent_heartbeat END
  WHERE id = p_duel_id
    AND status = 'active'
    AND (creator_id = p_user_id OR opponent_id = p_user_id);
END;
$$;

-- ══════════════════════════════════════════════════
-- 3. forfeit_duel — добровольный форфейт (при выходе из приложения)
--    Работает и для PvP и для бот-игр
-- ══════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION forfeit_duel(p_duel_id UUID, p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_duel        RECORD;
  v_winner      UUID;
  v_loser       UUID;
  v_total_pot   INTEGER;
  v_rake        INTEGER;
  v_guild_fee   INTEGER;
  v_payout      INTEGER;
  v_season_id   UUID;
  v_is_pro      BOOLEAN;
BEGIN
  -- Атомарно захватываем дуэль
  SELECT * INTO v_duel FROM duels
  WHERE id = p_duel_id AND status = 'active'
  FOR UPDATE SKIP LOCKED;

  IF v_duel IS NULL THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  -- Определяем кто проиграл (тот кто вышел) и кто выиграл
  IF v_duel.creator_id = p_user_id THEN
    v_loser  := v_duel.creator_id;
    v_winner := v_duel.opponent_id;
  ELSIF v_duel.opponent_id = p_user_id THEN
    v_loser  := v_duel.opponent_id;
    v_winner := v_duel.creator_id;
  ELSE
    RETURN jsonb_build_object('status', 'not_participant');
  END IF;

  -- PRO проверка для рейка
  SELECT is_pro INTO v_is_pro FROM users WHERE id = v_winner;

  -- Расчёт выплаты
  v_total_pot := v_duel.stake * 2;
  IF v_is_pro THEN
    v_rake := FLOOR(v_total_pot * 25 / 1000);  -- 2.5% для PRO
  ELSE
    v_rake := FLOOR(v_total_pot * 5 / 100);    -- 5% обычный
  END IF;
  v_guild_fee := FLOOR(v_total_pot * 5 / 1000);
  v_payout := v_total_pot - v_rake;

  -- Guild season fee
  SELECT id INTO v_season_id FROM guild_seasons WHERE is_active = true LIMIT 1;
  IF v_season_id IS NOT NULL THEN
    UPDATE guild_seasons SET prize_pool = prize_pool + v_guild_fee WHERE id = v_season_id;
  END IF;

  -- Финализируем дуэль
  IF v_winner = v_duel.creator_id THEN
    UPDATE duels SET creator_score = COALESCE(creator_score, 1), opponent_score = 0,
      status = 'finished', winner_id = v_winner, finished_at = NOW()
    WHERE id = p_duel_id;
  ELSE
    UPDATE duels SET creator_score = 0, opponent_score = COALESCE(opponent_score, 1),
      status = 'finished', winner_id = v_winner, finished_at = NOW()
    WHERE id = p_duel_id;
  END IF;

  -- Баланс и статистика победителя
  UPDATE users SET balance = balance + v_payout, wins = wins + 1 WHERE id = v_winner;
  INSERT INTO transactions (user_id, type, amount, ref_id)
  VALUES (v_winner, 'duel_win', v_payout, p_duel_id);

  INSERT INTO user_daily_stats (user_id, date, pnl, games, wins)
  VALUES (v_winner, CURRENT_DATE, v_payout - v_duel.stake, 1, 1)
  ON CONFLICT (user_id, date)
  DO UPDATE SET pnl = user_daily_stats.pnl + (v_payout - v_duel.stake),
    games = user_daily_stats.games + 1, wins = user_daily_stats.wins + 1;
  PERFORM update_guild_pnl_after_duel(v_winner, v_payout - v_duel.stake);

  -- Статистика проигравшего
  UPDATE users SET losses = losses + 1 WHERE id = v_loser;
  INSERT INTO user_daily_stats (user_id, date, pnl, games, wins)
  VALUES (v_loser, CURRENT_DATE, -v_duel.stake, 1, 0)
  ON CONFLICT (user_id, date)
  DO UPDATE SET pnl = user_daily_stats.pnl - v_duel.stake, games = user_daily_stats.games + 1;
  PERFORM update_guild_pnl_after_duel(v_loser, -v_duel.stake);

  PERFORM admin_log('info', 'duel:forfeit', 'Player forfeited',
    jsonb_build_object('duel_id', p_duel_id, 'loser', v_loser, 'winner', v_winner,
      'game_type', v_duel.game_type, 'stake', v_duel.stake, 'payout', v_payout));

  RETURN jsonb_build_object('status', 'forfeited', 'winner', v_winner, 'loser', v_loser);

EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'duel:forfeit', SQLERRM,
    jsonb_build_object('duel_id', p_duel_id, 'user_id', p_user_id));
  RETURN jsonb_build_object('status', 'error', 'message', SQLERRM);
END;
$$;

-- ══════════════════════════════════════════════════
-- 4. claim_forfeit — оставшийся игрок клеймит победу
--    Проверяет что heartbeat оппонента протух (>20 сек)
-- ══════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION claim_forfeit(p_duel_id UUID, p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_duel           RECORD;
  v_opp_heartbeat  TIMESTAMPTZ;
  v_threshold      INTERVAL := INTERVAL '20 seconds';
BEGIN
  -- Читаем дуэль
  SELECT * INTO v_duel FROM duels
  WHERE id = p_duel_id AND status = 'active';

  IF v_duel IS NULL THEN
    RETURN jsonb_build_object('status', 'not_found');
  END IF;

  -- Определяем heartbeat оппонента
  IF v_duel.creator_id = p_user_id THEN
    v_opp_heartbeat := v_duel.opponent_heartbeat;
  ELSIF v_duel.opponent_id = p_user_id THEN
    v_opp_heartbeat := v_duel.creator_heartbeat;
  ELSE
    RETURN jsonb_build_object('status', 'not_participant');
  END IF;

  -- Проверяем что heartbeat протух
  -- Если heartbeat NULL — оппонент никогда не слал heartbeat (старая дуэль, не форфейтим)
  IF v_opp_heartbeat IS NULL THEN
    RETURN jsonb_build_object('status', 'no_heartbeat');
  END IF;

  IF v_opp_heartbeat > NOW() - v_threshold THEN
    RETURN jsonb_build_object('status', 'opponent_alive', 'last_heartbeat', v_opp_heartbeat);
  END IF;

  -- Heartbeat протух — определяем оппонента и форфейтим
  IF v_duel.creator_id = p_user_id THEN
    -- Оппонент = opponent_id, он ушёл
    RETURN forfeit_duel(p_duel_id, v_duel.opponent_id);
  ELSE
    -- Оппонент = creator_id, он ушёл
    RETURN forfeit_duel(p_duel_id, v_duel.creator_id);
  END IF;
END;
$$;
