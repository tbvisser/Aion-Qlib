-- Fix SQL agent: Create dedicated read-only user
-- This user can ONLY SELECT from sales_data - database enforces security

-- Clean up broken RPC function from previous migration
DROP FUNCTION IF EXISTS execute_sql_as_reader(TEXT);

-- Revoke privileges from old role before dropping (if it exists)
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'sql_agent_reader') THEN
    REVOKE ALL ON SCHEMA public FROM sql_agent_reader;
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM sql_agent_reader;
    DROP ROLE sql_agent_reader;
  END IF;
END $$;

-- Create the read-only user (if it doesn't exist) with a RANDOM password.
-- We deliberately do NOT commit a real password. The SQL agent is optional and
-- off by default; when you enable it, set a known password (and the matching
-- SQL_READER_DATABASE_URL) with scripts/rotate-sql-reader-password.ps1.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'sql_reader') THEN
    EXECUTE format('CREATE USER sql_reader WITH PASSWORD %L', gen_random_uuid()::text);
  END IF;
END $$;

-- Grant minimal permissions
GRANT USAGE ON SCHEMA public TO sql_reader;
-- Grant SELECT on sales_data if it exists (may be created by a later migration)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'sales_data') THEN
    EXECUTE 'GRANT SELECT ON sales_data TO sql_reader';
  END IF;
END $$;
