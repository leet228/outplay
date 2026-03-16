-- ╔═══════════════════════════════════════════════════════╗
-- ║  BUG REPORTS — table + RPC                           ║
-- ╚═══════════════════════════════════════════════════════╝

CREATE TABLE IF NOT EXISTS bug_reports (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id),
  description TEXT NOT NULL,
  photos      TEXT[] DEFAULT '{}',
  device_info TEXT,
  app_version TEXT DEFAULT '0.1.0',
  context     JSONB DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'new'
              CHECK (status IN ('new','seen','resolved','closed')),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_br_status ON bug_reports(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_br_user   ON bug_reports(user_id, created_at DESC);

ALTER TABLE bug_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "service_role_full" ON bug_reports;
CREATE POLICY "service_role_full" ON bug_reports
  FOR ALL USING (auth.role() = 'service_role');

-- RPC: submit_bug_report
CREATE OR REPLACE FUNCTION submit_bug_report(
  p_user_id     UUID,
  p_description TEXT,
  p_photos      TEXT[] DEFAULT '{}',
  p_device_info TEXT DEFAULT '',
  p_context     JSONB DEFAULT '{}'
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
  v_report_id UUID;
BEGIN
  INSERT INTO bug_reports (user_id, description, photos, device_info, context)
  VALUES (p_user_id, p_description, COALESCE(p_photos, '{}'), p_device_info, COALESCE(p_context, '{}'))
  RETURNING id INTO v_report_id;

  PERFORM admin_log('info', 'rpc:submit_bug_report',
    'Bug report submitted',
    jsonb_build_object(
      'report_id', v_report_id,
      'user_id', p_user_id,
      'description', LEFT(p_description, 100),
      'photos_count', COALESCE(array_length(p_photos, 1), 0)
    )
  );

  RETURN jsonb_build_object('ok', true, 'report_id', v_report_id);
END;
$$;
