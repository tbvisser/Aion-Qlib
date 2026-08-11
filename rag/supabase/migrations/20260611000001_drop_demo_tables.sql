-- Security/hygiene: remove the demo/sample tables from the main app.
--
-- sales_data, team_members, travel_expenses, budget_limits and the synthetic-PII
-- fixtures test_customer_records / test_employee_directory were all created with
-- NO Row-Level Security, so with Supabase's default table grants any
-- authenticated browser client could read every row. They back only the demo
-- SQL/budget tools, which are disabled by default (disabled_demo_tools +
-- include_sql=False in llm_service.register_native_tools).
--
-- They now live in supabase/demo/demo_content.sql as an OPTIONAL import that
-- recreates them WITH RLS enabled. Run scripts/import-demo-content.ps1 if you
-- want the demos. This migration removes them from every normal install.

DROP TABLE IF EXISTS travel_expenses CASCADE;   -- FK -> team_members, drop first
DROP TABLE IF EXISTS team_members CASCADE;
DROP TABLE IF EXISTS budget_limits CASCADE;
DROP TABLE IF EXISTS sales_data CASCADE;
DROP TABLE IF EXISTS test_customer_records CASCADE;
DROP TABLE IF EXISTS test_employee_directory CASCADE;
