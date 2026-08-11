-- Module 7 (Episode 1) text-to-SQL: re-seed the sales_data demo table.
--
-- Background: 20260611000001_drop_demo_tables.sql removed sales_data because the
-- ORIGINAL demo tables had NO Row-Level Security (any authenticated browser client
-- could read every row). This migration recreates ONLY sales_data, this time WITH
-- RLS enabled and a SELECT policy scoped to the dedicated read-only `sql_reader`
-- role (the same RLS-safe definition kept in supabase/demo/demo_content.sql).
--
-- This restores the text-to-SQL demo. The browser/anon client still cannot read
-- the table (RLS on, no anon policy); only the backend service role (RLS bypass)
-- and the `sql_reader` role (read-only, used by the SQL agent) can.

CREATE TABLE IF NOT EXISTS sales_data (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_date DATE NOT NULL,
  customer_name TEXT NOT NULL,
  product_name TEXT NOT NULL,
  category TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  unit_price DECIMAL(10,2) NOT NULL,
  total_amount DECIMAL(10,2) GENERATED ALWAYS AS (quantity * unit_price) STORED,
  region TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'shipped', 'delivered', 'returned'))
);

ALTER TABLE sales_data ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sales_data_sql_reader_read" ON sales_data;
CREATE POLICY "sales_data_sql_reader_read" ON sales_data FOR SELECT TO sql_reader USING (true);

INSERT INTO sales_data (order_date, customer_name, product_name, category, quantity, unit_price, region, status)
SELECT * FROM (VALUES
  ('2024-01-15'::date, 'Acme Corp', 'Widget Pro', 'Electronics', 50, 29.99, 'North', 'delivered'),
  ('2024-01-18'::date, 'TechStart Inc', 'Widget Pro', 'Electronics', 25, 29.99, 'West', 'delivered'),
  ('2024-01-20'::date, 'Global Supplies', 'Gadget Basic', 'Electronics', 100, 14.99, 'South', 'shipped'),
  ('2024-02-01'::date, 'Acme Corp', 'Office Chair', 'Furniture', 10, 199.99, 'North', 'delivered'),
  ('2024-02-05'::date, 'StartUp Labs', 'Standing Desk', 'Furniture', 5, 449.99, 'East', 'pending'),
  ('2024-02-10'::date, 'TechStart Inc', 'Monitor 27"', 'Electronics', 15, 299.99, 'West', 'shipped'),
  ('2024-02-15'::date, 'Metro Office', 'Keyboard Pro', 'Electronics', 30, 79.99, 'South', 'delivered'),
  ('2024-02-20'::date, 'Global Supplies', 'Mouse Wireless', 'Electronics', 75, 34.99, 'South', 'delivered'),
  ('2024-03-01'::date, 'Acme Corp', 'Webcam HD', 'Electronics', 20, 89.99, 'North', 'returned'),
  ('2024-03-05'::date, 'StartUp Labs', 'Laptop Stand', 'Furniture', 8, 59.99, 'East', 'delivered'),
  ('2024-03-10'::date, 'Metro Office', 'Desk Lamp', 'Furniture', 25, 44.99, 'South', 'shipped'),
  ('2024-03-15'::date, 'TechStart Inc', 'USB Hub', 'Electronics', 40, 24.99, 'West', 'delivered')
) AS v(order_date, customer_name, product_name, category, quantity, unit_price, region, status)
WHERE NOT EXISTS (SELECT 1 FROM sales_data LIMIT 1);

GRANT USAGE ON SCHEMA public TO sql_reader;
GRANT SELECT ON sales_data TO sql_reader;
