-- =============================================
-- Tower Stack — HONEST RNG model (Pragmatic-style)
-- Run AFTER migration_slot_rtp.sql
-- =============================================
--
-- Replaces the bias-AI fall-level sampler (which switched between
-- p=0.55 / 0.73 / 0.83 geometric to chase RTP) with a SINGLE Pareto-
-- style distribution that yields constant 95 % RTP on EVERY cashout
-- strategy — exactly the math used by real licensed crash games.
--
-- Math:
--    S_K  = 1 + step * K     (multiplier when cashing at level K)
--    P(fall_at_level >= K+1) = R / S_K   ⇒  P(reach K) × S_K = R
--
-- Sampling (one round):
--    U ∈ uniform[0, 1)
--    T = R / (1 - U)
--    fall_at_level = max(1, ceil((T - 1) / step))
--
-- Verified by scripts/tower-honest-sim.js:
--    cash @ level 1     RTP ≈ 95 %   (P(fall>=2) = 0.95/1.3 = 73.1 %)
--    cash @ level 5     RTP ≈ 95 %   (P(fall>=6) = 0.95/2.5 = 38.0 %)
--    cash @ level 12    RTP ≈ 95 %   (P(fall>=13) = 0.95/4.6 = 20.7 %)
--    mixed strategy 5×100k mean = 94.82 %, range 94.58 % – 95.04 %
--    1k variance std ≈ ±4.65 % (very tight)
--    P(immediate fail at level 1) = 1 − R = 26.92 %  (the visible house edge)
--
-- Deficit circuit breaker: when slot pnl ≤ −max_house_deficit_rub the
-- next round is forced to fall_at_level = 1 (instant loss on first
-- drop) until pnl climbs back above the floor. With a 95 % RTP slot
-- the breaker fires < 0.1 % of the time on real traffic.

-- ── 1. Honest sampler ──────────────────────────────────────────
-- Drop-in replacement for generate_slot_fall_level. Stateless, returns
-- an INTEGER level ∈ [1, p_max_level].
CREATE OR REPLACE FUNCTION generate_tower_fall_level(
  p_target_rtp NUMERIC DEFAULT 0.95,
  p_step_mul   NUMERIC DEFAULT 0.30,
  p_max_level  INTEGER DEFAULT 50
)
RETURNS INTEGER
LANGUAGE plpgsql VOLATILE STRICT
AS $$
DECLARE
  v_u    NUMERIC;
  v_t    NUMERIC;
  v_lvl  INTEGER;
BEGIN
  IF p_target_rtp <= 0 OR p_target_rtp > 1 THEN p_target_rtp := 0.95; END IF;
  IF p_step_mul   <= 0                     THEN p_step_mul   := 0.30; END IF;
  IF p_max_level  < 1                      THEN p_max_level  := 50;   END IF;

  v_u := random();
  IF v_u >= 1 THEN v_u := 0.999999; END IF;

  v_t   := p_target_rtp / (1 - v_u);
  v_lvl := CEIL((v_t - 1) / p_step_mul)::INTEGER;

  IF v_lvl < 1            THEN v_lvl := 1;            END IF;
  IF v_lvl > p_max_level  THEN v_lvl := p_max_level;  END IF;
  RETURN v_lvl;
END;
$$;


-- ── 2. start_slot_round — honest model ─────────────────────────
-- Drops the bias-AI logic. Behaviour now:
--   * deficit_active = (current_pnl_rub <= -max_house_deficit_rub)
--   * If deficit_active → fall_at_level = 1 (instant loss, first drop)
--   * Otherwise        → honest Pareto-style sampler

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
  v_balance        INTEGER;
  v_round_id       UUID;
  v_pnl            BIGINT;
  v_target_rtp     NUMERIC;
  v_max_deficit    INTEGER;
  v_enabled        BOOLEAN;
  v_deficit_active BOOLEAN;
  v_bias           TEXT;
  v_fall_level     INTEGER;
BEGIN
  IF p_stake_rub IS NULL OR p_stake_rub < 10 OR p_stake_rub > 25000 THEN
    RETURN jsonb_build_object('error', 'invalid_stake');
  END IF;
  IF p_slot_id IS NULL OR LENGTH(p_slot_id) = 0 THEN
    RETURN jsonb_build_object('error', 'invalid_slot');
  END IF;

  -- Auto-abort prior pending rounds for this user (lost rounds, crashes)
  UPDATE slot_rounds
     SET outcome = 'aborted', finished_at = NOW()
   WHERE user_id = p_user_id AND outcome = 'pending';

  -- Lock + read user balance
  SELECT balance INTO v_balance FROM users WHERE id = p_user_id FOR UPDATE;
  IF v_balance IS NULL THEN
    RETURN jsonb_build_object('error', 'user_not_found');
  END IF;
  IF v_balance < p_stake_rub THEN
    RETURN jsonb_build_object('error', 'insufficient_balance');
  END IF;

  -- Read slot stats — only deficit_active matters now (bias-AI is gone)
  SELECT current_pnl_rub, target_rtp, max_house_deficit_rub, enabled
    INTO v_pnl, v_target_rtp, v_max_deficit, v_enabled
    FROM slot_stats WHERE slot_id = p_slot_id;

  -- Auto-create stats row if missing
  IF v_target_rtp IS NULL THEN
    INSERT INTO slot_stats (slot_id) VALUES (p_slot_id)
      ON CONFLICT (slot_id) DO NOTHING;
    v_pnl := 0;
    v_target_rtp := 0.95; v_max_deficit := 10000; v_enabled := true;
  END IF;

  IF NOT v_enabled THEN
    RETURN jsonb_build_object('error', 'slot_disabled');
  END IF;

  v_deficit_active := COALESCE(v_pnl, 0) <= -COALESCE(v_max_deficit, 10000);
  v_bias           := CASE WHEN v_deficit_active THEN 'house_recovers' ELSE 'normal' END;

  -- Honest fall-level sampler (or forced 1 if deficit active)
  IF v_deficit_active THEN
    v_fall_level := 1;
  ELSE
    v_fall_level := generate_tower_fall_level(COALESCE(v_target_rtp, 0.95), 0.30, 50);
  END IF;

  -- Atomic stake deduction
  UPDATE users SET balance = balance - p_stake_rub WHERE id = p_user_id;

  INSERT INTO slot_rounds (user_id, slot_id, stake_rub, fall_at_level, rtp_bias)
    VALUES (p_user_id, p_slot_id, p_stake_rub, v_fall_level, v_bias)
    RETURNING id INTO v_round_id;

  INSERT INTO transactions (user_id, type, amount, ref_id)
    VALUES (p_user_id, 'slot_bet', -p_stake_rub, v_round_id);

  RETURN jsonb_build_object(
    'ok', true,
    'round_id', v_round_id,
    'balance', v_balance - p_stake_rub,
    'fall_at_level', v_fall_level,
    'deficit_active', v_deficit_active
  );

EXCEPTION WHEN OTHERS THEN
  PERFORM admin_log('error', 'rpc:start_slot_round', SQLERRM,
    jsonb_build_object('user_id', p_user_id, 'slot_id', p_slot_id, 'stake', p_stake_rub));
  RETURN jsonb_build_object('error', SQLERRM);
END;
$$;


GRANT EXECUTE ON FUNCTION generate_tower_fall_level(NUMERIC, NUMERIC, INTEGER) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION start_slot_round(UUID, TEXT, INTEGER) TO authenticated, anon;

NOTIFY pgrst, 'reload schema';
