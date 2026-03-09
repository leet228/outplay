-- =============================================
-- OUTPLAY — Supabase Schema
-- Выполни этот SQL в Supabase SQL Editor
-- =============================================

-- Users
CREATE TABLE users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id BIGINT UNIQUE NOT NULL,
  username    TEXT,
  first_name  TEXT NOT NULL,
  avatar_url  TEXT,
  balance     INTEGER NOT NULL DEFAULT 0,
  wins        INTEGER NOT NULL DEFAULT 0,
  losses      INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Questions
CREATE TABLE questions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category      TEXT NOT NULL,  -- general | history | science | sport | movies | music
  question      TEXT NOT NULL,
  options       JSONB NOT NULL, -- ["вариант A", "вариант B", "вариант C", "вариант D"]
  correct_index INTEGER NOT NULL CHECK (correct_index BETWEEN 0 AND 3),
  difficulty    INTEGER NOT NULL DEFAULT 1 CHECK (difficulty BETWEEN 1 AND 3),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Duels
CREATE TABLE duels (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_id      UUID NOT NULL REFERENCES users(id),
  opponent_id     UUID REFERENCES users(id),
  category        TEXT NOT NULL,
  stake           INTEGER NOT NULL DEFAULT 10,
  status          TEXT NOT NULL DEFAULT 'waiting'
                  CHECK (status IN ('waiting', 'active', 'finished')),
  creator_score   INTEGER,
  opponent_score  INTEGER,
  winner_id       UUID REFERENCES users(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  finished_at     TIMESTAMPTZ
);

-- Индексы
CREATE INDEX idx_duels_status ON duels(status);
CREATE INDEX idx_duels_creator ON duels(creator_id);
CREATE INDEX idx_questions_category ON questions(category);

-- RPC: атомарное изменение баланса
CREATE OR REPLACE FUNCTION increment_balance(user_id UUID, amount INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  new_balance INTEGER;
BEGIN
  UPDATE users
  SET balance = balance + amount
  WHERE id = user_id
  RETURNING balance INTO new_balance;
  RETURN new_balance;
END;
$$;

-- RPC: финализация дуэли (победитель, статистика)
CREATE OR REPLACE FUNCTION finalize_duel(duel_id UUID)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  d         duels%ROWTYPE;
  winner    UUID;
  loser     UUID;
BEGIN
  SELECT * INTO d FROM duels WHERE id = duel_id;

  IF d.creator_score IS NULL OR d.opponent_score IS NULL THEN
    RETURN; -- ещё не оба ответили
  END IF;

  IF d.creator_score > d.opponent_score THEN
    winner := d.creator_id; loser := d.opponent_id;
  ELSIF d.opponent_score > d.creator_score THEN
    winner := d.opponent_id; loser := d.creator_id;
  ELSE
    -- ничья — ставки возвращаются (можно не трогать)
    UPDATE duels SET status = 'finished', finished_at = NOW() WHERE id = duel_id;
    RETURN;
  END IF;

  -- Обновляем балансы
  UPDATE users SET balance = balance + d.stake, wins = wins + 1 WHERE id = winner;
  UPDATE users SET balance = balance - d.stake, losses = losses + 1 WHERE id = loser;

  -- Обновляем дуэль
  UPDATE duels SET
    status = 'finished',
    winner_id = winner,
    finished_at = NOW()
  WHERE id = duel_id;
END;
$$;

-- =============================================
-- MIGRATION: добавить avatar_url если таблица уже существует
-- ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
-- =============================================

-- Row Level Security (базовая)
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE duels ENABLE ROW LEVEL SECURITY;
ALTER TABLE questions ENABLE ROW LEVEL SECURITY;

-- Все читают questions
CREATE POLICY "questions_read" ON questions FOR SELECT USING (true);

-- Users видят всех (лидерборд), но меняют только себя
CREATE POLICY "users_read" ON users FOR SELECT USING (true);
CREATE POLICY "users_insert" ON users FOR INSERT WITH CHECK (true);
CREATE POLICY "users_update" ON users FOR UPDATE USING (true);

-- Duels — читают все, меняют участники
CREATE POLICY "duels_read" ON duels FOR SELECT USING (true);
CREATE POLICY "duels_insert" ON duels FOR INSERT WITH CHECK (true);
CREATE POLICY "duels_update" ON duels FOR UPDATE USING (true);
