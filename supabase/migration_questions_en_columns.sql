-- ╔════════════════════════════════════════════╗
-- ║  Add English translation columns          ║
-- ╚════════════════════════════════════════════╝

ALTER TABLE questions ADD COLUMN IF NOT EXISTS question_en TEXT;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS options_en JSONB;
