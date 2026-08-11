-- Module 7: Additional Tools
-- Text-to-SQL demo table + read-only user, web search settings

-- 1. Sample data table for Text-to-SQL demo
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

-- 2. Read-only user for SQL agent
-- NOTE: Create this user manually in Supabase Dashboard > SQL Editor:
--
--   CREATE USER sql_reader WITH PASSWORD 'your-secure-password';
--   GRANT USAGE ON SCHEMA public TO sql_reader;
--   GRANT SELECT ON sales_data TO sql_reader;
--
-- Then add the connection string to your .env:
--   SQL_READER_DATABASE_URL=postgresql://sql_reader:your-secure-password@db.your-project.supabase.co:5432/postgres

-- 3. Web search settings columns
ALTER TABLE global_settings
  ADD COLUMN IF NOT EXISTS web_search_provider TEXT DEFAULT 'tavily',
  ADD COLUMN IF NOT EXISTS web_search_api_key TEXT,
  ADD COLUMN IF NOT EXISTS web_search_enabled BOOLEAN DEFAULT false;

-- 4. Seed sample sales data (only if table is empty)
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

-- 5. Clean up old RPC function if it exists
DROP FUNCTION IF EXISTS execute_sql_as_reader(TEXT);
DROP ROLE IF EXISTS sql_agent_reader;

-- 6. Grant SELECT on sales_data to sql_reader (created in earlier migration)
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'sql_reader') THEN
    EXECUTE 'GRANT SELECT ON sales_data TO sql_reader';
  END IF;
END $$;
