-- =============================================
-- Migration: Slot Rounds (Tower Stack & future slots)
-- Запусти в Supabase SQL Editor
-- =============================================

-- ╔═══════════════════════════════════════════╗
-- ║  0. Снимаем CHECK на transactions.type   ║
-- ╚═══════════════════════════════════════════╝
-- За время разработки в таблицу попали типы которых нет в исходном
-- списке (crypto_deposit, pro_purchase и т.п.), поэтому пересоздать
-- CHECK уже нельзя — он валится на существующих строках. Просто
-- снимаем его: типы валидируются на уровне функций/приложения.

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_type_check;


-- ╔═══════════════════════════════════════════╗
-- ║  1. Таблица slot_rounds                  ║
-- ╚═══════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS slot_rounds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slot_id TEXT NOT NULL,
  stake_rub INTEGER NOT NULL CHECK (stake_rub >= 10 AND stake_rub <= 25000),
  payout_rub INTEGER NOT NULL DEFAULT 0 CHECK (payout_rub >= 0),
  floors INTEGER NOT NULL DEFAULT 0 CHECK (floors >= 0),
  multiplier NUMERIC(8, 2) NOT NULL DEFAULT 1.0 CHECK (multiplier >= 0),
  outcome TEXT NOT NULL DEFAULT 'pending'
    CHECK (outcome IN ('pending', 'cashed', 'fallen', 'aborted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_slot_rounds_user_created
  ON slot_rounds(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_slot_rounds_pending
  ON slot_rounds(user_id) WHERE outcome = 'pending';


-- ╔═══════════════════════════════════════════╗
-- ║  2. RPC: start_slot_round                 ║
-- ╚═══════════════════════════════════════════╝
-- Списывает ставку с баланса, создаёт раунд (status=pending),
-- возвращает round_id и новый баланс.

CREATE OR REPLACE FUNCTION start_slot_round(
  p_user_id   UUID,
  p_slot_id   TEXT,
  p_stake_rub INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_balance  INTEGER;
  v_round_id UUID;
BEGIN
  IF p_stake_rub IS NULL OR p_stake_rub < 10 OR p_stake_rub > 25000 THEN
    RETURN jsonb_build_object('error', 'invalid_stake');
  END IF;

  IF p_slot_id IS NULL OR LENGTH(p_slot_id) = 0 THEN
    RETURN jsonb_build_object('error', 'invalid_slot');
  END IF;

  -- Закрываем все висящие pending раунды юзера как aborted
  -- (защита от ситуаций когда юзер вышел не закончив раунд)
  UPDATE slot_rounds
     SET outcome = 'aborted',
         finished_at = NOW()
   WHERE user_id = p_user_id
     AND outcome = 'pending';

  -- Лочим юзера, проверяем баланс
  SELECT balance INTO v_balance
    FROM users
   WHERE id = p_user_id
   FOR UPDATE;

  IF v_balance IS NULL THEN
    RETURN jsonb_build_object('error', 'user_not_found');
  END IF;

  IF v_balance < p_stake_rub THEN
    RETURN jsonb_build_object('error', 'insufficient_balance');
  END IF;

  -- Списываем ставку
  UPDATE users SET balance = balance - p_stake_rub WHERE id = p_user_id;

  -- Создаём раунд
  INSERT INTO slot_rounds (user_id, slot_id, stake_rub)
    VALUES (p_user_id, p_slot_id, p_stake_rub)
    RETURNING id INTO v_round_id;

  -- Транзакция (slot_bet, отрицательная)
  INSERT INTO transactions (user_id, type, amount, ref_id)
    VALUES (p_user_id, 'slot_bet', -p_stake_rub, v_round_id);

  RETURN jsonb_build_object(
    'ok', true,
    'round_id', v_round_id,
    'balance', v_balance - p_stake_rub
  );

EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'rpc:start_slot_round', SQLERRM,
    jsonb_build_object('user_id', p_user_id, 'slot_id', p_slot_id, 'stake', p_stake_rub));
  RETURN jsonb_build_object('error', SQLERRM);
END;
$$;


-- ╔═══════════════════════════════════════════╗
-- ║  3. RPC: finish_slot_round                ║
-- ╚═══════════════════════════════════════════╝
-- Финализирует раунд: 'cashed' → начисляет payout, 'fallen' / 'aborted' → 0.
-- Обновляет user_daily_stats и creates 'slot_win' транзакцию.

CREATE OR REPLACE FUNCTION finish_slot_round(
  p_round_id    UUID,
  p_outcome     TEXT,
  p_payout_rub  INTEGER,
  p_floors      INTEGER,
  p_multiplier  NUMERIC DEFAULT 1.0
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id     UUID;
  v_stake       INTEGER;
  v_outcome_now TEXT;
  v_pnl         INTEGER;
  v_balance_new INTEGER;
  v_payout_capped INTEGER;
BEGIN
  IF p_outcome NOT IN ('cashed', 'fallen', 'aborted') THEN
    RETURN jsonb_build_object('error', 'invalid_outcome');
  END IF;

  IF p_payout_rub IS NULL OR p_payout_rub < 0 THEN
    p_payout_rub := 0;
  END IF;

  IF p_floors IS NULL OR p_floors < 0 THEN
    p_floors := 0;
  END IF;

  -- Лочим раунд
  SELECT user_id, stake_rub, outcome
    INTO v_user_id, v_stake, v_outcome_now
    FROM slot_rounds
   WHERE id = p_round_id
   FOR UPDATE;

  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'round_not_found');
  END IF;

  IF v_outcome_now <> 'pending' THEN
    -- Уже закрыт — возвращаем текущий баланс
    SELECT balance INTO v_balance_new FROM users WHERE id = v_user_id;
    RETURN jsonb_build_object('error', 'already_finished', 'balance', v_balance_new);
  END IF;

  -- 'fallen' или 'aborted' = выигрыш 0
  IF p_outcome <> 'cashed' THEN
    p_payout_rub := 0;
  END IF;

  -- Cap payout: max 100x ставки (защита от багов на клиенте)
  v_payout_capped := LEAST(p_payout_rub, v_stake * 100);

  -- Начисление выигрыша
  IF v_payout_capped > 0 THEN
    UPDATE users SET balance = balance + v_payout_capped WHERE id = v_user_id;

    INSERT INTO transactions (user_id, type, amount, ref_id)
      VALUES (v_user_id, 'slot_win', v_payout_capped, p_round_id);
  END IF;

  -- Закрываем раунд
  UPDATE slot_rounds
     SET outcome = p_outcome,
         payout_rub = v_payout_capped,
         floors = p_floors,
         multiplier = COALESCE(p_multiplier, 1.0),
         finished_at = NOW()
   WHERE id = p_round_id;

  -- PnL для user_daily_stats: payout - stake
  v_pnl := v_payout_capped - v_stake;

  -- Обновляем daily stats (slot games считаются как games)
  INSERT INTO user_daily_stats (user_id, date, pnl, games, wins)
    VALUES (
      v_user_id,
      CURRENT_DATE,
      v_pnl,
      1,
      CASE WHEN v_payout_capped > v_stake THEN 1 ELSE 0 END
    )
    ON CONFLICT (user_id, date)
    DO UPDATE SET
      pnl = user_daily_stats.pnl + v_pnl,
      games = user_daily_stats.games + 1,
      wins = user_daily_stats.wins + CASE WHEN v_payout_capped > v_stake THEN 1 ELSE 0 END;

  -- Гильдийский PnL
  PERFORM update_guild_pnl_after_duel(v_user_id, v_pnl);

  -- Возвращаем итог
  SELECT balance INTO v_balance_new FROM users WHERE id = v_user_id;

  RETURN jsonb_build_object(
    'ok', true,
    'balance', v_balance_new,
    'payout', v_payout_capped,
    'pnl', v_pnl
  );

EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'rpc:finish_slot_round', SQLERRM,
    jsonb_build_object('round_id', p_round_id, 'outcome', p_outcome, 'payout', p_payout_rub));
  RETURN jsonb_build_object('error', SQLERRM);
END;
$$;


-- ╔═══════════════════════════════════════════╗
-- ║  4. RLS + grants                          ║
-- ╚═══════════════════════════════════════════╝

ALTER TABLE slot_rounds ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "slot_rounds_read_own" ON slot_rounds;
CREATE POLICY "slot_rounds_read_own" ON slot_rounds FOR SELECT USING (true);

GRANT EXECUTE ON FUNCTION start_slot_round(UUID, TEXT, INTEGER) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION finish_slot_round(UUID, TEXT, INTEGER, INTEGER, NUMERIC) TO authenticated, anon;


-- ╔═══════════════════════════════════════════╗
-- ║  5. Перезагрузка PostgREST schema cache   ║
-- ╚═══════════════════════════════════════════╝
-- Без этого PostgREST может не увидеть новые функции до рестарта.

NOTIFY pgrst, 'reload schema';


-- ╔═══════════════════════════════════════════╗
-- ║  DONE! Slot backend migration ready       ║
-- ╚═══════════════════════════════════════════╝
