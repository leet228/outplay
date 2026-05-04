-- =============================================
-- client_log_error — frontend error sink
-- Apply if you see PGRST202 "Could not find the function
-- public.client_log_error" on the client.
-- =============================================
--
-- This function existed inside migration_rocket_slot_logging.sql,
-- but if that file was skipped on prod the wrappers in supabase.js
-- (logClientError) call into a missing RPC and PostgREST returns
-- PGRST202 every time. This standalone file just creates the
-- function — safe to run multiple times.

CREATE OR REPLACE FUNCTION client_log_error(
  p_scope    TEXT,
  p_message  TEXT,
  p_payload  JSONB DEFAULT '{}'::jsonb
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM admin_log(
    'error',
    'client:' || COALESCE(LEFT(p_scope, 60),  'unknown'),
    LEFT(COALESCE(p_message, '(no message)'), 500),
    COALESCE(p_payload, '{}'::jsonb)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION client_log_error(TEXT, TEXT, JSONB) TO authenticated, anon;

NOTIFY pgrst, 'reload schema';
