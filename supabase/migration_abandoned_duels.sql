-- ╔═══════════════════════════════════════════════════════════╗
-- ║  Migration: Автоматический таймаут заброшенных PvP-дуэлей ║
-- ╚═══════════════════════════════════════════════════════════╝

-- 1. Индекс для быстрого поиска зависших активных дуэлей
CREATE INDEX IF NOT EXISTS idx_duels_active_created
  ON duels(created_at) WHERE status = 'active';

-- 2. Функция автоматической очистки заброшенных дуэлей
--    Логика:
--      • Один играл, другой вышел → победа тому, кто играл (payout с рейком)
--      • Оба вышли → ставки сгорают (cancelled, без возврата)
--      • Бот-игры пропускаются
--    Таймаут: 3 минуты для всех типов игр

DROP FUNCTION IF EXISTS cleanup_abandoned_duels();

CREATE OR REPLACE FUNCTION cleanup_abandoned_duels()
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_duel           RECORD;
  v_creator_played BOOLEAN;
  v_opponent_played BOOLEAN;
  v_winner         UUID;
  v_loser          UUID;
  v_total_pot      INTEGER;
  v_rake           INTEGER;
  v_guild_fee      INTEGER;
  v_payout         INTEGER;
  v_season_id      UUID;
  v_actual_score   INTEGER;
  v_count_win      INTEGER := 0;
  v_count_burn     INTEGER := 0;
  v_count_skip     INTEGER := 0;
  v_answer_count   INTEGER;
BEGIN
  -- Активный сезон гильдий (для guild_fee)
  SELECT id INTO v_season_id FROM guild_seasons WHERE is_active = true LIMIT 1;

  -- Перебираем все зависшие активные PvP-дуэли (3 мин для всех типов)
  FOR v_duel IN
    SELECT * FROM duels
    WHERE status = 'active'
      AND is_bot_game = false
      AND created_at < NOW() - INTERVAL '3 minutes'
    FOR UPDATE SKIP LOCKED
  LOOP
    v_creator_played := false;
    v_opponent_played := false;
    v_winner := NULL;

    -- ── Определяем кто играл ──────────────────────────
    IF v_duel.game_type = 'quiz' THEN
      SELECT COUNT(*) INTO v_answer_count
      FROM duel_answers WHERE duel_id = v_duel.id AND user_id = v_duel.creator_id;
      v_creator_played := v_answer_count > 0;

      SELECT COUNT(*) INTO v_answer_count
      FROM duel_answers WHERE duel_id = v_duel.id AND user_id = v_duel.opponent_id;
      v_opponent_played := v_answer_count > 0;

    ELSIF v_duel.game_type = 'sequence' THEN
      v_creator_played := v_duel.creator_score IS NOT NULL;
      v_opponent_played := v_duel.opponent_score IS NOT NULL;

    ELSIF v_duel.game_type = 'blackjack' THEN
      SELECT COUNT(*) INTO v_answer_count
      FROM blackjack_actions WHERE duel_id = v_duel.id AND user_id = v_duel.creator_id;
      v_creator_played := v_answer_count > 0;

      SELECT COUNT(*) INTO v_answer_count
      FROM blackjack_actions WHERE duel_id = v_duel.id AND user_id = v_duel.opponent_id;
      v_opponent_played := v_answer_count > 0;
    END IF;

    -- Оба играли — должно было финализироваться само, пропускаем
    IF v_creator_played AND v_opponent_played THEN
      v_count_skip := v_count_skip + 1;
      CONTINUE;
    END IF;

    -- ── КЕЙС 1: один играл, другой вышел → победа активному ──
    IF v_creator_played AND NOT v_opponent_played THEN
      v_winner := v_duel.creator_id;
      v_loser  := v_duel.opponent_id;
    ELSIF v_opponent_played AND NOT v_creator_played THEN
      v_winner := v_duel.opponent_id;
      v_loser  := v_duel.creator_id;
    END IF;

    IF v_winner IS NOT NULL THEN
      v_total_pot := v_duel.stake * 2;
      v_rake      := FLOOR(v_total_pot * 5 / 100);
      v_guild_fee := FLOOR(v_total_pot * 5 / 1000);
      v_payout    := v_total_pot - v_rake;

      -- Guild season fee
      IF v_season_id IS NOT NULL THEN
        UPDATE guild_seasons SET prize_pool = prize_pool + v_guild_fee WHERE id = v_season_id;
      END IF;

      -- Реальный счёт для quiz, имеющийся для остальных
      IF v_duel.game_type = 'quiz' THEN
        SELECT COUNT(*) INTO v_actual_score
        FROM duel_answers WHERE duel_id = v_duel.id AND user_id = v_winner AND is_correct = true;
      ELSE
        IF v_winner = v_duel.creator_id THEN
          v_actual_score := COALESCE(v_duel.creator_score, 1);
        ELSE
          v_actual_score := COALESCE(v_duel.opponent_score, 1);
        END IF;
      END IF;

      -- Финализируем дуэль
      IF v_winner = v_duel.creator_id THEN
        UPDATE duels SET creator_score = v_actual_score, opponent_score = 0,
          status = 'finished', winner_id = v_winner, finished_at = NOW()
        WHERE id = v_duel.id;
      ELSE
        UPDATE duels SET creator_score = 0, opponent_score = v_actual_score,
          status = 'finished', winner_id = v_winner, finished_at = NOW()
        WHERE id = v_duel.id;
      END IF;

      -- Баланс и статистика победителя
      UPDATE users SET balance = balance + v_payout, wins = wins + 1 WHERE id = v_winner;
      INSERT INTO transactions (user_id, type, amount, ref_id)
      VALUES (v_winner, 'duel_win', v_payout, v_duel.id);

      INSERT INTO user_daily_stats (user_id, date, pnl, games, wins)
      VALUES (v_winner, CURRENT_DATE, v_payout - v_duel.stake, 1, 1)
      ON CONFLICT (user_id, date)
      DO UPDATE SET pnl = user_daily_stats.pnl + (v_payout - v_duel.stake),
        games = user_daily_stats.games + 1, wins = user_daily_stats.wins + 1;
      PERFORM update_guild_pnl_after_duel(v_winner, v_payout - v_duel.stake);

      -- Статистика проигравшего (баланс уже списан при матчинге)
      UPDATE users SET losses = losses + 1 WHERE id = v_loser;
      INSERT INTO user_daily_stats (user_id, date, pnl, games, wins)
      VALUES (v_loser, CURRENT_DATE, -v_duel.stake, 1, 0)
      ON CONFLICT (user_id, date)
      DO UPDATE SET pnl = user_daily_stats.pnl - v_duel.stake, games = user_daily_stats.games + 1;
      PERFORM update_guild_pnl_after_duel(v_loser, -v_duel.stake);

      PERFORM admin_log('info', 'cleanup:abandoned_duels', 'Winner awarded',
        jsonb_build_object('duel_id', v_duel.id, 'winner', v_winner, 'loser', v_loser,
          'game_type', v_duel.game_type, 'stake', v_duel.stake, 'payout', v_payout));
      v_count_win := v_count_win + 1;

    ELSE
      -- ── КЕЙС 2: оба вышли → ставки сгорают ──
      UPDATE duels SET status = 'cancelled', finished_at = NOW() WHERE id = v_duel.id;

      -- Статистика проигрыша для обоих
      UPDATE users SET losses = losses + 1 WHERE id = v_duel.creator_id;
      UPDATE users SET losses = losses + 1 WHERE id = v_duel.opponent_id;

      INSERT INTO user_daily_stats (user_id, date, pnl, games, wins)
      VALUES (v_duel.creator_id, CURRENT_DATE, -v_duel.stake, 1, 0)
      ON CONFLICT (user_id, date)
      DO UPDATE SET pnl = user_daily_stats.pnl - v_duel.stake, games = user_daily_stats.games + 1;

      INSERT INTO user_daily_stats (user_id, date, pnl, games, wins)
      VALUES (v_duel.opponent_id, CURRENT_DATE, -v_duel.stake, 1, 0)
      ON CONFLICT (user_id, date)
      DO UPDATE SET pnl = user_daily_stats.pnl - v_duel.stake, games = user_daily_stats.games + 1;

      PERFORM admin_log('info', 'cleanup:abandoned_duels', 'Both abandoned — stakes burned',
        jsonb_build_object('duel_id', v_duel.id, 'creator_id', v_duel.creator_id,
          'opponent_id', v_duel.opponent_id, 'game_type', v_duel.game_type, 'stake', v_duel.stake));
      v_count_burn := v_count_burn + 1;
    END IF;
  END LOOP;

  IF v_count_win > 0 OR v_count_burn > 0 THEN
    PERFORM admin_log('info', 'cleanup:abandoned_duels', 'Cleanup completed',
      jsonb_build_object('wins_awarded', v_count_win, 'stakes_burned', v_count_burn, 'skipped', v_count_skip));
  END IF;

  RETURN jsonb_build_object('wins_awarded', v_count_win, 'stakes_burned', v_count_burn, 'skipped', v_count_skip);
EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'cleanup:abandoned_duels', SQLERRM, '{}'::jsonb);
  RETURN jsonb_build_object('error', SQLERRM);
END;
$$;

-- 3. Расписание pg_cron (выполнить вручную в Supabase SQL Editor):
-- SELECT cron.schedule('cleanup-abandoned-duels', '*/2 * * * *', 'SELECT cleanup_abandoned_duels()');
