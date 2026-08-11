-- Security: stop anon/authenticated from calling the SECURITY DEFINER search &
-- maintenance functions directly.
--
-- These run as their owner (RLS-bypassing) and trust a caller-supplied user_id,
-- so any GRANT to anon/authenticated let a browser anon-key client call them
-- with someone else's user_id (or NULL) and read/modify other tenants' data:
--   keyword_search_chunks / get_chunks_by_ranges / match_chunks -> read any user's chunk text
--   cascade_folder_user_id                                      -> reassign any folder subtree
--   update_harness_phase_atomic                                 -> overwrite any user's harness run
--   next_message_sequence / get_folder_tree                     -> metadata oracle
--
-- The backend only ever calls these through the service-role client, so revoking
-- anon/authenticated EXECUTE removes the attack surface without affecting the
-- app. Looped over pg_proc so every overload is covered regardless of exact
-- signature, and so the migration is idempotent.

DO $$
DECLARE
  fn record;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'match_chunks',
        'keyword_search_chunks',
        'get_chunks_by_ranges',
        'cascade_folder_user_id',
        'update_harness_phase_atomic',
        'next_message_sequence',
        'get_folder_tree'
      )
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn.sig);
  END LOOP;
END $$;

-- Pin search_path on keyword_search_chunks — it was the one DEFINER search
-- function created without it (function/operator hijack risk via a hostile
-- object earlier on the search_path).
DO $$
DECLARE
  fn record;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'keyword_search_chunks'
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path TO ''public''', fn.sig);
  END LOOP;
END $$;
