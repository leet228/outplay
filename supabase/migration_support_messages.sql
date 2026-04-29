-- Support bot message history for compact admin context cards.

CREATE TABLE IF NOT EXISTS support_messages (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id  BIGINT NOT NULL,
  username     TEXT,
  first_name   TEXT,
  message_id   BIGINT,
  direction    TEXT NOT NULL CHECK (direction IN ('user', 'admin')),
  message_type TEXT NOT NULL DEFAULT 'text',
  body         TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_support_messages_user_created
  ON support_messages (telegram_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_support_messages_created
  ON support_messages (created_at DESC);

ALTER TABLE support_messages ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS support_admin_message_refs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id     BIGINT NOT NULL,
  message_id      BIGINT NOT NULL UNIQUE,
  root_message_id BIGINT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_support_admin_refs_root
  ON support_admin_message_refs (root_message_id);

CREATE INDEX IF NOT EXISTS idx_support_admin_refs_created
  ON support_admin_message_refs (created_at DESC);

ALTER TABLE support_admin_message_refs ENABLE ROW LEVEL SECURITY;
