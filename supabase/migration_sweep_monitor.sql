-- !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
-- !!! TODO RUN ON PROD — sweep monitoring overview RPC.      !!!
-- !!! Read-only aggregate for the admin Wallet panel: status !!!
-- !!! counts, problem jobs, per-chain swept totals, freshness.!!!
-- !!! Run AFTER migration_sweep.sql.                          !!!
-- !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

CREATE OR REPLACE FUNCTION admin_sweep_overview()
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_counts   JSONB;
  v_problems JSONB;
  v_bychain  JSONB;
  v_recent   JSONB;
  v_oldest   INTEGER;
BEGIN
  -- Status histogram.
  SELECT COALESCE(jsonb_object_agg(status, c), '{}'::jsonb) INTO v_counts
  FROM (SELECT status, COUNT(*) c FROM sweep_jobs GROUP BY status) s;

  -- Problem jobs: failed, OR stuck (non-terminal, many attempts),
  -- OR non-terminal older than 1h.
  SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.created_at), '[]'::jsonb) INTO v_problems
  FROM (
    SELECT id, chain, amount, status, attempts, last_error,
           gas_txid, sweep_txid, from_address, created_at, updated_at,
           ROUND(EXTRACT(EPOCH FROM (NOW() - created_at)) / 60)::INT AS age_min
    FROM sweep_jobs
    WHERE status = 'failed'
       OR (status NOT IN ('swept','skipped') AND attempts >= 5)
       OR (status NOT IN ('swept','skipped') AND created_at < NOW() - INTERVAL '1 hour')
    ORDER BY created_at
    LIMIT 30
  ) p;

  -- Per-chain swept totals (money actually consolidated).
  SELECT COALESCE(jsonb_agg(to_jsonb(b) ORDER BY b.chain), '[]'::jsonb) INTO v_bychain
  FROM (
    SELECT chain,
           COUNT(*) FILTER (WHERE status = 'swept')          AS swept_count,
           COALESCE(SUM(amount) FILTER (WHERE status = 'swept'), 0) AS swept_amount,
           COUNT(*) FILTER (WHERE status NOT IN ('swept','skipped','failed')) AS active_count
    FROM sweep_jobs GROUP BY chain
  ) b;

  -- Last 15 jobs (any status) for the activity feed.
  SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.created_at DESC), '[]'::jsonb) INTO v_recent
  FROM (
    SELECT chain, amount, status, attempts, last_error,
           sweep_txid, gas_txid,
           ROUND(EXTRACT(EPOCH FROM (NOW() - created_at)) / 60)::INT AS age_min
    FROM sweep_jobs ORDER BY created_at DESC LIMIT 15
  ) r;

  SELECT ROUND(EXTRACT(EPOCH FROM (NOW() - MIN(created_at))) / 60)::INT
    INTO v_oldest
  FROM sweep_jobs WHERE status NOT IN ('swept','skipped','failed');

  RETURN jsonb_build_object(
    'counts',          v_counts,
    'problems',        v_problems,
    'by_chain',        v_bychain,
    'recent',          v_recent,
    'oldest_active_min', COALESCE(v_oldest, 0),
    'generated_at',    NOW()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION admin_sweep_overview() TO authenticated;

NOTIFY pgrst, 'reload schema';
