-- =============================================================================
-- OPTIONAL DEMO CONTENT  (not applied by the normal migration run)
-- =============================================================================
-- Sample tables for the Text-to-SQL, budget-compliance, and PII-redaction demos.
-- The main app drops these (migration 20260611000001); import this only when you
-- want the demos. Apply with:  powershell -File scripts/import-demo-content.ps1
-- (or pipe this file into psql).
--
-- Unlike the original always-on tables, EVERY table here has Row-Level Security
-- ENABLED, so access is explicit instead of relying on Supabase default grants:
--   * sales_data / team_members / travel_expenses / budget_limits
--       -> readable only by the read-only `sql_reader` role (the role the demo
--          SQL/budget agent tools connect as) and the service role. Not exposed
--          to the anon/authenticated browser client. To also let logged-in users
--          read them directly, add:  CREATE POLICY "<t>_auth_read" ON <t>
--          FOR SELECT TO authenticated USING (true);
--   * test_customer_records / test_employee_directory
--       -> RLS on with NO permissive policy, i.e. service-role only (the backend
--          redaction pipeline reads them via the service-role client, which
--          bypasses RLS). The browser client cannot read them.
--
-- All data here is SYNTHETIC. The "PII" (SSNs, cards, IBANs) is fake, generated
-- to exercise the redaction pipeline. Re-running this script is safe (idempotent).
-- =============================================================================

BEGIN;

-- ============================================================
-- sales_data  (Text-to-SQL demo)
-- ============================================================
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

GRANT SELECT ON sales_data TO sql_reader;

-- ============================================================
-- team_members
-- ============================================================
CREATE TABLE IF NOT EXISTS team_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  department TEXT NOT NULL,
  level TEXT NOT NULL
);
ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "team_members_sql_reader_read" ON team_members;
CREATE POLICY "team_members_sql_reader_read" ON team_members FOR SELECT TO sql_reader USING (true);

INSERT INTO team_members (id, name, email, department, level) VALUES
  ('a0000001-0000-0000-0000-000000000001', 'Sarah Chen', 'sarah.chen@company.com', 'Engineering', 'Senior'),
  ('a0000001-0000-0000-0000-000000000002', 'Marcus Johnson', 'marcus.johnson@company.com', 'Sales', 'Mid'),
  ('a0000001-0000-0000-0000-000000000003', 'Emily Rodriguez', 'emily.rodriguez@company.com', 'Marketing', 'Director'),
  ('a0000001-0000-0000-0000-000000000004', 'James Wilson', 'james.wilson@company.com', 'Operations', 'Junior'),
  ('a0000001-0000-0000-0000-000000000005', 'Priya Patel', 'priya.patel@company.com', 'Engineering', 'Mid'),
  ('a0000001-0000-0000-0000-000000000006', 'David Kim', 'david.kim@company.com', 'Sales', 'Senior'),
  ('a0000001-0000-0000-0000-000000000007', 'Lisa Thompson', 'lisa.thompson@company.com', 'Marketing', 'Junior'),
  ('a0000001-0000-0000-0000-000000000008', 'Alex Nguyen', 'alex.nguyen@company.com', 'Engineering', 'Director'),
  ('a0000001-0000-0000-0000-000000000009', 'Rachel Foster', 'rachel.foster@company.com', 'Sales', 'Mid'),
  ('a0000001-0000-0000-0000-000000000010', 'Kevin O''Brien', 'kevin.obrien@company.com', 'Operations', 'Senior'),
  ('a0000001-0000-0000-0000-000000000011', 'Maya Singh', 'maya.singh@company.com', 'Engineering', 'Junior'),
  ('a0000001-0000-0000-0000-000000000012', 'Tom Bradley', 'tom.bradley@company.com', 'Sales', 'Director'),
  ('a0000001-0000-0000-0000-000000000013', 'Jessica Lee', 'jessica.lee@company.com', 'Marketing', 'Mid'),
  ('a0000001-0000-0000-0000-000000000014', 'Daniel Martinez', 'daniel.martinez@company.com', 'Operations', 'Mid'),
  ('a0000001-0000-0000-0000-000000000015', 'Olivia Brown', 'olivia.brown@company.com', 'Engineering', 'Senior'),
  ('a0000001-0000-0000-0000-000000000016', 'Chris Taylor', 'chris.taylor@company.com', 'Sales', 'Junior'),
  ('a0000001-0000-0000-0000-000000000017', 'Natalie White', 'natalie.white@company.com', 'Marketing', 'Senior'),
  ('a0000001-0000-0000-0000-000000000018', 'Ryan Clark', 'ryan.clark@company.com', 'Operations', 'Junior'),
  ('a0000001-0000-0000-0000-000000000019', 'Sophia Adams', 'sophia.adams@company.com', 'Engineering', 'Mid'),
  ('a0000001-0000-0000-0000-000000000020', 'Michael Davis', 'michael.davis@company.com', 'Sales', 'Senior')
ON CONFLICT (id) DO NOTHING;

GRANT SELECT ON team_members TO sql_reader;

-- ============================================================
-- budget_limits
-- ============================================================
CREATE TABLE IF NOT EXISTS budget_limits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  level TEXT NOT NULL,
  category TEXT NOT NULL,
  quarterly_limit DECIMAL(10,2) NOT NULL,
  UNIQUE(level, category)
);
ALTER TABLE budget_limits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "budget_limits_sql_reader_read" ON budget_limits;
CREATE POLICY "budget_limits_sql_reader_read" ON budget_limits FOR SELECT TO sql_reader USING (true);

INSERT INTO budget_limits (level, category, quarterly_limit) VALUES
  ('Junior', 'flights', 1500.00),
  ('Junior', 'hotels', 1200.00),
  ('Junior', 'meals', 600.00),
  ('Junior', 'ground_transport', 400.00),
  ('Mid', 'flights', 2500.00),
  ('Mid', 'hotels', 2000.00),
  ('Mid', 'meals', 1000.00),
  ('Mid', 'ground_transport', 600.00),
  ('Senior', 'flights', 4000.00),
  ('Senior', 'hotels', 3000.00),
  ('Senior', 'meals', 1500.00),
  ('Senior', 'ground_transport', 800.00),
  ('Director', 'flights', 6000.00),
  ('Director', 'hotels', 4500.00),
  ('Director', 'meals', 2000.00),
  ('Director', 'ground_transport', 1200.00)
ON CONFLICT (level, category) DO NOTHING;

GRANT SELECT ON budget_limits TO sql_reader;

-- ============================================================
-- travel_expenses  (FK -> team_members; seeded only when empty)
-- ============================================================
CREATE TABLE IF NOT EXISTS travel_expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES team_members(id),
  quarter TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  expense_date DATE NOT NULL
);
ALTER TABLE travel_expenses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "travel_expenses_sql_reader_read" ON travel_expenses;
CREATE POLICY "travel_expenses_sql_reader_read" ON travel_expenses FOR SELECT TO sql_reader USING (true);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM travel_expenses LIMIT 1) THEN
    INSERT INTO travel_expenses (user_id, quarter, category, description, amount, expense_date) VALUES
      ('a0000001-0000-0000-0000-000000000001', 'Q3', 'flights', 'Flight to AWS re:Invent early bird', 1850.00, '2025-07-15'),
      ('a0000001-0000-0000-0000-000000000001', 'Q3', 'flights', 'Flight to GopherCon Denver', 1680.00, '2025-08-05'),
      ('a0000001-0000-0000-0000-000000000001', 'Q3', 'flights', 'Flight to client site NYC', 1670.00, '2025-09-10'),
      ('a0000001-0000-0000-0000-000000000001', 'Q3', 'hotels', 'Hotel AWS re:Invent (4 nights)', 1520.00, '2025-07-16'),
      ('a0000001-0000-0000-0000-000000000001', 'Q3', 'hotels', 'Hotel GopherCon (3 nights)', 1140.00, '2025-08-06'),
      ('a0000001-0000-0000-0000-000000000001', 'Q3', 'hotels', 'Hotel NYC client visit (3 nights)', 1140.00, '2025-09-11'),
      ('a0000001-0000-0000-0000-000000000001', 'Q3', 'meals', 'Conference meals and team dinners', 980.00, '2025-07-18'),
      ('a0000001-0000-0000-0000-000000000001', 'Q3', 'meals', 'Client entertainment dinners NYC', 820.00, '2025-09-12'),
      ('a0000001-0000-0000-0000-000000000001', 'Q3', 'ground_transport', 'Uber/taxi across 3 trips', 700.00, '2025-09-15'),
      ('a0000001-0000-0000-0000-000000000002', 'Q3', 'flights', 'Flight to Chicago client meeting', 1200.00, '2025-07-08'),
      ('a0000001-0000-0000-0000-000000000002', 'Q3', 'flights', 'Flight to Miami prospect visit', 1200.00, '2025-08-20'),
      ('a0000001-0000-0000-0000-000000000002', 'Q3', 'hotels', 'Hotel Chicago (2 nights)', 1050.00, '2025-07-09'),
      ('a0000001-0000-0000-0000-000000000002', 'Q3', 'hotels', 'Hotel Miami (2 nights)', 1050.00, '2025-08-21'),
      ('a0000001-0000-0000-0000-000000000002', 'Q3', 'meals', 'Client dinner - Steakhouse Chicago', 680.00, '2025-07-09'),
      ('a0000001-0000-0000-0000-000000000002', 'Q3', 'meals', 'Prospect dinner - Miami Beach', 720.00, '2025-08-21'),
      ('a0000001-0000-0000-0000-000000000002', 'Q3', 'meals', 'Team lunch meetings (monthly)', 550.00, '2025-09-05'),
      ('a0000001-0000-0000-0000-000000000002', 'Q3', 'meals', 'Client happy hour events', 550.00, '2025-09-18'),
      ('a0000001-0000-0000-0000-000000000002', 'Q3', 'ground_transport', 'Uber/taxi Chicago and Miami', 800.00, '2025-08-25'),
      ('a0000001-0000-0000-0000-000000000003', 'Q3', 'flights', 'Flight to Cannes Lions festival', 2400.00, '2025-07-01'),
      ('a0000001-0000-0000-0000-000000000003', 'Q3', 'flights', 'Flight to NYC brand summit', 1800.00, '2025-08-12'),
      ('a0000001-0000-0000-0000-000000000003', 'Q3', 'flights', 'Flight to LA agency review', 2000.00, '2025-09-03'),
      ('a0000001-0000-0000-0000-000000000003', 'Q3', 'hotels', 'Hotel Cannes (4 nights)', 2100.00, '2025-07-02'),
      ('a0000001-0000-0000-0000-000000000003', 'Q3', 'hotels', 'Hotel NYC summit (3 nights)', 1350.00, '2025-08-13'),
      ('a0000001-0000-0000-0000-000000000003', 'Q3', 'hotels', 'Hotel LA review (2 nights)', 850.00, '2025-09-04'),
      ('a0000001-0000-0000-0000-000000000003', 'Q3', 'meals', 'Cannes networking dinners', 1100.00, '2025-07-04'),
      ('a0000001-0000-0000-0000-000000000003', 'Q3', 'meals', 'NYC/LA client meals', 1000.00, '2025-09-06'),
      ('a0000001-0000-0000-0000-000000000003', 'Q3', 'ground_transport', 'Car services across 3 trips', 1400.00, '2025-09-10'),
      ('a0000001-0000-0000-0000-000000000008', 'Q3', 'flights', 'Flight to team offsite Aspen', 2800.00, '2025-07-20'),
      ('a0000001-0000-0000-0000-000000000008', 'Q3', 'flights', 'Flight to board meeting SF', 1600.00, '2025-08-15'),
      ('a0000001-0000-0000-0000-000000000008', 'Q3', 'flights', 'Flight to hiring event Austin', 1400.00, '2025-09-01'),
      ('a0000001-0000-0000-0000-000000000008', 'Q3', 'flights', 'Flight to vendor summit Seattle', 1200.00, '2025-09-18'),
      ('a0000001-0000-0000-0000-000000000008', 'Q3', 'hotels', 'Hotel team offsite Aspen (5 nights)', 2400.00, '2025-07-21'),
      ('a0000001-0000-0000-0000-000000000008', 'Q3', 'hotels', 'Hotel SF board meeting (2 nights)', 1200.00, '2025-08-16'),
      ('a0000001-0000-0000-0000-000000000008', 'Q3', 'hotels', 'Hotel Austin hiring (2 nights)', 1200.00, '2025-09-02'),
      ('a0000001-0000-0000-0000-000000000008', 'Q3', 'meals', 'Team offsite catering and dinners', 1200.00, '2025-07-23'),
      ('a0000001-0000-0000-0000-000000000008', 'Q3', 'meals', 'Board dinner and candidate meals', 1000.00, '2025-09-05'),
      ('a0000001-0000-0000-0000-000000000008', 'Q3', 'ground_transport', 'Car services all trips', 1200.00, '2025-09-20'),
      ('a0000001-0000-0000-0000-000000000004', 'Q3', 'flights', 'Flight to training workshop', 650.00, '2025-08-01'),
      ('a0000001-0000-0000-0000-000000000004', 'Q3', 'hotels', 'Hotel training (2 nights)', 480.00, '2025-08-02'),
      ('a0000001-0000-0000-0000-000000000004', 'Q3', 'meals', 'Meals during training', 320.00, '2025-08-03'),
      ('a0000001-0000-0000-0000-000000000004', 'Q3', 'ground_transport', 'Airport shuttle', 350.00, '2025-08-04'),
      ('a0000001-0000-0000-0000-000000000005', 'Q3', 'flights', 'Flight to PyCon', 980.00, '2025-07-10'),
      ('a0000001-0000-0000-0000-000000000005', 'Q3', 'hotels', 'Hotel PyCon (3 nights)', 900.00, '2025-07-11'),
      ('a0000001-0000-0000-0000-000000000005', 'Q3', 'meals', 'Conference meals', 520.00, '2025-07-13'),
      ('a0000001-0000-0000-0000-000000000005', 'Q3', 'ground_transport', 'Taxi to/from airport', 250.00, '2025-07-14'),
      ('a0000001-0000-0000-0000-000000000006', 'Q3', 'flights', 'Flight to regional sales conf', 1400.00, '2025-08-18'),
      ('a0000001-0000-0000-0000-000000000006', 'Q3', 'hotels', 'Hotel sales conf (3 nights)', 1200.00, '2025-08-19'),
      ('a0000001-0000-0000-0000-000000000006', 'Q3', 'meals', 'Client dinners', 750.00, '2025-08-20'),
      ('a0000001-0000-0000-0000-000000000006', 'Q3', 'ground_transport', 'Rental car', 350.00, '2025-08-22'),
      ('a0000001-0000-0000-0000-000000000007', 'Q3', 'flights', 'Flight to marketing bootcamp', 520.00, '2025-09-08'),
      ('a0000001-0000-0000-0000-000000000007', 'Q3', 'hotels', 'Hotel bootcamp (2 nights)', 420.00, '2025-09-09'),
      ('a0000001-0000-0000-0000-000000000007', 'Q3', 'meals', 'Meals during bootcamp', 260.00, '2025-09-10'),
      ('a0000001-0000-0000-0000-000000000009', 'Q3', 'flights', 'Flight to prospect meeting', 850.00, '2025-07-22'),
      ('a0000001-0000-0000-0000-000000000009', 'Q3', 'hotels', 'Hotel prospect visit (2 nights)', 780.00, '2025-07-23'),
      ('a0000001-0000-0000-0000-000000000009', 'Q3', 'meals', 'Prospect lunch and dinner', 420.00, '2025-07-24'),
      ('a0000001-0000-0000-0000-000000000009', 'Q3', 'ground_transport', 'Uber rides', 280.00, '2025-07-25'),
      ('a0000001-0000-0000-0000-000000000010', 'Q3', 'flights', 'Flight to ops summit', 1350.00, '2025-08-25'),
      ('a0000001-0000-0000-0000-000000000010', 'Q3', 'hotels', 'Hotel ops summit (3 nights)', 1100.00, '2025-08-26'),
      ('a0000001-0000-0000-0000-000000000010', 'Q3', 'meals', 'Summit meals', 650.00, '2025-08-28'),
      ('a0000001-0000-0000-0000-000000000010', 'Q3', 'ground_transport', 'Ground transport', 300.00, '2025-08-29'),
      ('a0000001-0000-0000-0000-000000000011', 'Q3', 'flights', 'Flight to intern meetup', 380.00, '2025-09-15'),
      ('a0000001-0000-0000-0000-000000000011', 'Q3', 'hotels', 'Hotel intern meetup (1 night)', 320.00, '2025-09-16'),
      ('a0000001-0000-0000-0000-000000000011', 'Q3', 'meals', 'Meetup meals', 200.00, '2025-09-16'),
      ('a0000001-0000-0000-0000-000000000012', 'Q3', 'flights', 'Flight to leadership retreat', 2200.00, '2025-07-28'),
      ('a0000001-0000-0000-0000-000000000012', 'Q3', 'hotels', 'Hotel retreat (3 nights)', 1800.00, '2025-07-29'),
      ('a0000001-0000-0000-0000-000000000012', 'Q3', 'meals', 'Retreat dinners', 1100.00, '2025-07-31'),
      ('a0000001-0000-0000-0000-000000000012', 'Q3', 'ground_transport', 'Car service', 600.00, '2025-08-01'),
      ('a0000001-0000-0000-0000-000000000013', 'Q3', 'flights', 'Flight to content strategy conf', 780.00, '2025-08-05'),
      ('a0000001-0000-0000-0000-000000000013', 'Q3', 'hotels', 'Hotel conf (2 nights)', 720.00, '2025-08-06'),
      ('a0000001-0000-0000-0000-000000000013', 'Q3', 'meals', 'Conference meals', 450.00, '2025-08-07'),
      ('a0000001-0000-0000-0000-000000000013', 'Q3', 'ground_transport', 'Taxi', 180.00, '2025-08-08'),
      ('a0000001-0000-0000-0000-000000000014', 'Q3', 'flights', 'Flight to vendor audit', 900.00, '2025-09-02'),
      ('a0000001-0000-0000-0000-000000000014', 'Q3', 'hotels', 'Hotel audit (2 nights)', 780.00, '2025-09-03'),
      ('a0000001-0000-0000-0000-000000000014', 'Q3', 'meals', 'Audit working meals', 380.00, '2025-09-04'),
      ('a0000001-0000-0000-0000-000000000014', 'Q3', 'ground_transport', 'Rental car', 280.00, '2025-09-05'),
      ('a0000001-0000-0000-0000-000000000015', 'Q3', 'flights', 'Flight to tech lead summit', 1800.00, '2025-07-14'),
      ('a0000001-0000-0000-0000-000000000015', 'Q3', 'hotels', 'Hotel summit (3 nights)', 1350.00, '2025-07-15'),
      ('a0000001-0000-0000-0000-000000000015', 'Q3', 'meals', 'Summit meals and networking', 680.00, '2025-07-17'),
      ('a0000001-0000-0000-0000-000000000015', 'Q3', 'ground_transport', 'Uber rides', 350.00, '2025-07-18'),
      ('a0000001-0000-0000-0000-000000000016', 'Q3', 'flights', 'Flight to sales onboarding', 580.00, '2025-08-11'),
      ('a0000001-0000-0000-0000-000000000016', 'Q3', 'hotels', 'Hotel onboarding (2 nights)', 460.00, '2025-08-12'),
      ('a0000001-0000-0000-0000-000000000016', 'Q3', 'meals', 'Onboarding meals', 240.00, '2025-08-13'),
      ('a0000001-0000-0000-0000-000000000016', 'Q3', 'ground_transport', 'Airport shuttle', 120.00, '2025-08-14'),
      ('a0000001-0000-0000-0000-000000000017', 'Q3', 'flights', 'Flight to AdWeek NYC', 1800.00, '2025-07-06'),
      ('a0000001-0000-0000-0000-000000000017', 'Q3', 'flights', 'Flight to brand conference LA', 1600.00, '2025-09-08'),
      ('a0000001-0000-0000-0000-000000000017', 'Q3', 'hotels', 'Hotel AdWeek (3 nights)', 1500.00, '2025-07-07'),
      ('a0000001-0000-0000-0000-000000000017', 'Q3', 'hotels', 'Hotel LA conf (3 nights)', 1350.00, '2025-09-09'),
      ('a0000001-0000-0000-0000-000000000017', 'Q3', 'meals', 'AdWeek networking meals', 750.00, '2025-07-09'),
      ('a0000001-0000-0000-0000-000000000017', 'Q3', 'meals', 'LA conference meals', 650.00, '2025-09-11'),
      ('a0000001-0000-0000-0000-000000000017', 'Q3', 'ground_transport', 'Car services NYC and LA', 650.00, '2025-09-12'),
      ('a0000001-0000-0000-0000-000000000018', 'Q3', 'flights', 'Flight to ops training', 420.00, '2025-09-22'),
      ('a0000001-0000-0000-0000-000000000018', 'Q3', 'hotels', 'Hotel training (1 night)', 280.00, '2025-09-23'),
      ('a0000001-0000-0000-0000-000000000018', 'Q3', 'meals', 'Training meals', 100.00, '2025-09-23'),
      ('a0000001-0000-0000-0000-000000000019', 'Q3', 'flights', 'Flight to hackathon', 950.00, '2025-08-28'),
      ('a0000001-0000-0000-0000-000000000019', 'Q3', 'hotels', 'Hotel hackathon (3 nights)', 870.00, '2025-08-29'),
      ('a0000001-0000-0000-0000-000000000019', 'Q3', 'meals', 'Hackathon meals', 480.00, '2025-08-31'),
      ('a0000001-0000-0000-0000-000000000019', 'Q3', 'ground_transport', 'Uber rides', 220.00, '2025-09-01'),
      ('a0000001-0000-0000-0000-000000000020', 'Q3', 'flights', 'Flight to partner meeting', 1600.00, '2025-07-18'),
      ('a0000001-0000-0000-0000-000000000020', 'Q3', 'hotels', 'Hotel partner visit (3 nights)', 1300.00, '2025-07-19'),
      ('a0000001-0000-0000-0000-000000000020', 'Q3', 'meals', 'Partner dinners', 680.00, '2025-07-21'),
      ('a0000001-0000-0000-0000-000000000020', 'Q3', 'ground_transport', 'Car rental', 400.00, '2025-07-22');
  END IF;
END $$;

GRANT SELECT ON travel_expenses TO sql_reader;

-- ============================================================
-- test_customer_records  (synthetic PII — service-role only)
-- ============================================================
CREATE TABLE IF NOT EXISTS test_customer_records (
    id SERIAL PRIMARY KEY,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    full_name TEXT,
    email TEXT,
    phone TEXT,
    date_of_birth DATE,
    ssn_last_four TEXT,
    home_address TEXT,
    city TEXT,
    state TEXT,
    zip_code TEXT,
    country TEXT DEFAULT 'US',
    account_number TEXT,
    credit_card_number TEXT,
    credit_card_expiry TEXT,
    credit_card_type TEXT,
    iban TEXT,
    passport_number TEXT,
    drivers_license TEXT,
    ip_address TEXT,
    last_login TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now()
);
-- RLS on with no permissive policy => service-role only (browser cannot read).
ALTER TABLE test_customer_records ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM test_customer_records LIMIT 1) THEN
    INSERT INTO test_customer_records (first_name, last_name, full_name, email, phone, date_of_birth, ssn_last_four, home_address, city, state, zip_code, country, account_number, credit_card_number, credit_card_expiry, credit_card_type, iban, passport_number, drivers_license, ip_address, last_login) VALUES
    ('Margaret', 'Thompson', 'Margaret Thompson', 'maggie.t85@gmail.com', '(628) 555-0234', '1985-03-14', '3891', '1847 Oak Valley Drive, Apt 12B', 'San Francisco', 'CA', '94110', 'US', 'CUST-884729', '4539-1488-0343-6467', '08/2026', 'Visa', NULL, '542817396', 'CA D4829103', '73.162.45.198', '2025-01-20 17:15:00+00'),
    ('James', 'Chen', 'James Chen', 'jrchen90@yahoo.com', '(510) 555-0876', '1990-11-22', '4720', '3256 Sunset Boulevard, Unit 4A', 'Oakland', 'CA', '94601', 'US', 'CUST-556391', '5425-2334-9871-0044', '11/2027', 'Mastercard', NULL, '681234957', 'CA D5918234', '98.42.176.55', '2025-01-19 22:32:00+00'),
    ('Sarah', 'Williams', 'Sarah Williams', 'swilliams78@outlook.com', '(415) 555-0667', '1978-07-08', '9085', '920 Pacific Heights Lane', 'San Francisco', 'CA', '94115', 'US', 'CUST-771024', '4532-8921-0045-6789', '09/2027', 'Visa', NULL, '423918567', 'CA D1347290', '104.172.89.33', '2025-01-20 19:45:00+00'),
    ('Michael', 'O''Brien', 'Michael O''Brien', 'mikeob92@icloud.com', '(650) 555-0198', '1992-05-30', '4539', '4501 El Camino Real, Suite 200', 'Palo Alto', 'CA', '94306', 'US', 'CUST-339128', '4916-3389-0145-2678', '12/2028', 'Visa', 'GB29 NWBK 6016 1331 9268 19', '789456123', 'CA D8762145', '76.218.33.142', '2025-01-19 00:20:00+00'),
    ('Elena', 'Vasquez', 'Elena Vasquez', 'elenavasquez87@protonmail.com', '(415) 555-0891', '1987-09-17', '2197', '2710 Mission Street, Apt 8C', 'San Francisco', 'CA', '94110', 'US', 'CUST-445672', '5287-1943-0067-8834', '05/2027', 'Mastercard', NULL, '912345678', 'CA D4568321', '192.168.1.47', '2025-01-20 16:05:00+00'),
    ('Robert', 'Thompson', 'Robert Thompson', 'robthompson83@gmail.com', '(415) 555-0923', '1983-06-21', '6789', '1847 Oak Valley Drive, Apt 12B', 'San Francisco', 'CA', '94110', 'US', 'CUST-884730', '4716-8234-9012-3456', '03/2027', 'Visa', NULL, '234567891', 'CA D3124567', '73.162.45.199', '2025-01-17 18:30:00+00'),
    ('Katherine', 'O''Brien', 'Katherine O''Brien', 'katieob93@outlook.com', '(650) 555-0488', '1993-08-12', '1098', '4501 El Camino Real, Suite 200', 'Palo Alto', 'CA', '94306', 'US', 'CUST-339129', '4024-0071-8834-5629', '10/2026', 'Visa', NULL, '345678912', 'CA D6543210', '76.218.33.143', '2025-01-19 20:15:00+00'),
    ('Patricia', 'Donovan', 'Patricia Donovan', 'pat.donovan@gmail.com', '(917) 555-0412', '1980-04-22', '6789', '88 Greenwich Street, Apt 42F', 'New York', 'NY', '10006', 'US', 'CUST-991234', '3782-822463-10005', '06/2027', 'Amex', NULL, '456789123', 'NY D2234567', '72.134.89.201', '2025-01-16 13:45:00+00'),
    ('Ahmad', 'Hassan', 'Ahmad Hassan', 'ahmad.hassan.sec@protonmail.com', '(408) 555-0293', '1975-12-03', '8901', '5600 Almaden Expressway, Unit 7', 'San Jose', 'CA', '95118', 'US', 'CUST-778456', '6011-4928-3371-0056', '09/2026', 'Discover', NULL, 'A12345678', 'CA D4456789', '104.56.178.92', '2025-01-15 22:00:00+00'),
    ('Jennifer', 'Martinez', 'Jennifer Martinez', 'jenn.martinez88@hotmail.com', '(415) 555-0847', '1988-08-29', '9012', '3400 California Street, Apt 6D', 'San Francisco', 'CA', '94118', 'US', 'CUST-665789', '5105-1051-0510-5100', '01/2028', 'Mastercard', NULL, '567891234', 'CA D5567890', '50.184.72.113', '2025-01-20 15:30:00+00'),
    ('Richard', 'Blackwell', 'Richard Blackwell', 'rich.blackwell@gmail.com', '+44 7911 555 678', '1970-11-05', NULL, '25 Canary Wharf', 'London', NULL, 'E14 5AB', 'UK', 'CUST-112233', '4462-0012-3456-7890', '08/2027', 'Visa', 'GB82 WEST 1234 5698 7654 32', '987654321', NULL, '185.45.23.89', '2025-01-14 09:00:00+00'),
    ('Yuki', 'Tanaka', 'Yuki Tanaka', 'y.tanaka@novatech-pharma.com', '+81 90-5555-1234', '1982-03-28', NULL, '2-4-7 Marunouchi, Chiyoda-ku', 'Tokyo', NULL, '100-0005', 'JP', 'CUST-445566', '3530-1113-3330-0000', '04/2028', 'JCB', NULL, 'TK1234567', NULL, '202.214.56.78', '2025-01-13 02:00:00+00'),
    ('Hannah', 'Fischer', 'Hannah Fischer', 'hannah.fischer.bio@gmail.com', '+49 171 5555 4321', '1979-07-12', NULL, 'Friedrichstrasse 123', 'Berlin', NULL, '10117', 'DE', 'CUST-778899', '5425-9012-3456-7890', '02/2028', 'Mastercard', 'DE44 5004 0000 0123 4567 89', 'C01234567', NULL, '88.76.54.32', '2025-01-12 14:30:00+00'),
    ('Klaus', 'Weber', 'Klaus Weber', 'k.weber@meridian-supplies.de', '+49 170 5555 6789', '1968-02-14', NULL, 'Hauptwache 12', 'Frankfurt am Main', NULL, '60313', 'DE', 'CUST-334455', '4000-0012-3456-7899', '11/2027', 'Visa', 'DE89 3704 0044 0532 0130 00', 'T220001293', NULL, '91.23.145.67', '2025-01-11 09:15:00+00'),
    ('David', 'Park', 'David Park', 'davidpark.esq@gmail.com', '(415) 555-2100', '1974-01-30', '0123', '425 Market Street, 32nd Floor', 'San Francisco', 'CA', '94105', 'US', 'CUST-556677', '4111-1111-1111-1111', '12/2027', 'Visa', NULL, '678912345', 'CA D6678901', '66.249.79.45', '2025-01-11 00:45:00+00');
  END IF;
END $$;

-- ============================================================
-- test_employee_directory  (synthetic PII — service-role only)
-- ============================================================
CREATE TABLE IF NOT EXISTS test_employee_directory (
    id SERIAL PRIMARY KEY,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    full_name TEXT,
    preferred_name TEXT,
    email TEXT,
    personal_email TEXT,
    phone TEXT,
    mobile TEXT,
    date_of_birth DATE,
    ssn TEXT,
    passport_number TEXT,
    drivers_license TEXT,
    home_address TEXT,
    city TEXT,
    state TEXT,
    zip_code TEXT,
    country TEXT DEFAULT 'US',
    department TEXT,
    title TEXT,
    salary NUMERIC,
    bank_name TEXT,
    bank_routing TEXT,
    bank_account TEXT,
    iban TEXT,
    swift_code TEXT,
    credit_card_number TEXT,
    credit_card_expiry TEXT,
    credit_card_cvv TEXT,
    health_insurance_id TEXT,
    blood_type TEXT,
    emergency_contact_name TEXT,
    emergency_contact_phone TEXT,
    emergency_contact_relation TEXT,
    ip_address TEXT,
    mac_address TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);
-- RLS on with no permissive policy => service-role only (browser cannot read).
ALTER TABLE test_employee_directory ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM test_employee_directory LIMIT 1) THEN
    INSERT INTO test_employee_directory (first_name, last_name, full_name, preferred_name, email, personal_email, phone, mobile, date_of_birth, ssn, passport_number, drivers_license, home_address, city, state, zip_code, country, department, title, salary, bank_name, bank_routing, bank_account, iban, swift_code, credit_card_number, credit_card_expiry, credit_card_cvv, health_insurance_id, blood_type, emergency_contact_name, emergency_contact_phone, emergency_contact_relation, ip_address, mac_address) VALUES
    ('Margaret', 'Thompson', 'Margaret Thompson', 'Maggie', 'margaret.thompson@acmetech.com', 'maggie.t85@gmail.com', '(415) 555-0187', '+1-628-555-0234', '1985-03-14', '287-54-3891', '542817396', 'CA D4829103', '1847 Oak Valley Drive, Apt 12B', 'San Francisco', 'CA', '94110', 'US', 'Engineering', 'Senior Software Engineer', 165000, 'Chase Bank', '021000021', '483291076524', NULL, NULL, '4539-1488-0343-6467', '08/2026', '315', 'BCBS-4829-3017-5543', 'O+', 'Robert Thompson', '(415) 555-0923', 'Husband', '73.162.45.198', 'A4:83:E7:2B:91:F0'),
    ('James', 'Chen', 'James Chen', 'Jim', 'james.chen@acmetech.com', 'jrchen90@yahoo.com', '(415) 555-0291', '+1-510-555-0876', '1990-11-22', '591-38-4720', '681234957', 'CA D5918234', '3256 Sunset Boulevard, Unit 4A', 'Oakland', 'CA', '94601', 'US', 'Data Science', 'Machine Learning Engineer', 155000, 'Wells Fargo', '121000248', '7291038456', NULL, NULL, '5425-2334-9871-0044', '11/2027', '847', 'BCBS-5918-2034-7761', 'A-', 'Lisa Chen', '(510) 555-0344', 'Mother', '98.42.176.55', 'B2:94:C8:3D:A1:E5'),
    ('Sarah', 'Williams', 'Sarah Williams', 'Sarah', 'sarah.williams@acmetech.com', 'swilliams78@outlook.com', '(415) 555-0445', '+1-415-555-0667', '1978-07-08', '134-72-9085', '423918567', 'CA D1347290', '920 Pacific Heights Lane', 'San Francisco', 'CA', '94115', 'US', 'Finance', 'VP of Financial Operations', 210000, 'Bank of America', '026009593', '1928374650', NULL, NULL, '4532-8921-0045-6789', '09/2027', '831', 'BCBS-1347-9028-3345', 'B+', 'David Williams', '(312) 555-0891', 'Brother', '104.172.89.33', 'C7:28:D4:1E:B9:F3'),
    ('Michael', 'O''Brien', 'Michael O''Brien', 'Mike', 'michael.obrien@acmetech.com', 'mikeob92@icloud.com', '(415) 555-0712', '+1-650-555-0198', '1992-05-30', '876-21-4539', '789456123', 'CA D8762145', '4501 El Camino Real, Suite 200', 'Palo Alto', 'CA', '94306', 'US', 'Sales', 'Regional Sales Director - West Coast', 145000, 'US Bank', '091000019', '3847291056', 'GB29 NWBK 6016 1331 9268 19', 'NWBKGB2L', '4916-3389-0145-2678', '12/2028', '592', 'AETNA-8762-1045-9923', 'AB+', 'Katie O''Brien', '(650) 555-0377', 'Wife', '76.218.33.142', 'D1:5A:E9:2F:C3:87'),
    ('Elena', 'Vasquez', 'Elena Vasquez', 'Elena', 'elena.vasquez@acmetech.com', 'elenavasquez87@protonmail.com', '(415) 555-0534', '+1-415-555-0891', '1987-09-17', '456-83-2197', '912345678', 'CA D4568321', '2710 Mission Street, Apt 8C', 'San Francisco', 'CA', '94110', 'US', 'Legal', 'General Counsel', 225000, 'Citibank', '021000089', '5647382910', NULL, NULL, '5287-1943-0067-8834', '05/2027', '219', 'UNITED-4568-3021-8890', 'O-', 'Maria Vasquez', '(213) 555-0456', 'Mother', '192.168.1.47', 'E3:7B:F2:48:A6:D1'),
    ('Robert', 'Thompson', 'Robert Thompson', 'Rob', 'robert.thompson@acmetech.com', 'robthompson83@gmail.com', '(415) 555-0923', '+1-415-555-1234', '1983-06-21', '312-45-6789', '234567891', 'CA D3124567', '1847 Oak Valley Drive, Apt 12B', 'San Francisco', 'CA', '94110', 'US', 'Marketing', 'Marketing Manager', 125000, 'Chase Bank', '021000021', '293847561024', NULL, NULL, '4716-8234-9012-3456', '03/2027', '441', 'BCBS-3124-5678-9900', 'A+', 'Margaret Thompson', '(628) 555-0234', 'Wife', '73.162.45.199', 'F4:8C:A1:3D:B7:E2'),
    ('Katherine', 'O''Brien', 'Katherine O''Brien', 'Katie', 'katie.obrien@acmetech.com', 'katieob93@outlook.com', '(650) 555-0377', '+1-650-555-0488', '1993-08-12', '654-32-1098', '345678912', 'CA D6543210', '4501 El Camino Real, Suite 200', 'Palo Alto', 'CA', '94306', 'US', 'Product', 'Product Manager', 140000, 'US Bank', '091000019', '4928371065', NULL, NULL, '4024-0071-8834-5629', '10/2026', '773', 'AETNA-6543-2109-8811', 'B-', 'Michael O''Brien', '(650) 555-0198', 'Husband', '76.218.33.143', 'A8:2D:C5:7F:E1:B4'),
    ('Patricia', 'Donovan', 'Patricia Donovan', 'Pat', 'patricia.d@cloudscale.io', 'pat.donovan@gmail.com', '(212) 555-0934', '+1-917-555-0412', '1980-04-22', '223-45-6789', '456789123', 'NY D2234567', '88 Greenwich Street, Apt 42F', 'New York', 'NY', '10006', 'US', 'External - Vendor', 'VP Enterprise Sales (CloudScale)', 195000, 'JPMorgan Chase', '021000021', '829174635028', NULL, 'CHASUS33', '3782-822463-10005', '06/2027', '9281', NULL, 'AB-', 'Thomas Donovan', '(212) 555-1847', 'Husband', '72.134.89.201', 'B5:3E:D8:1A:C9:F7'),
    ('Ahmad', 'Hassan', 'Ahmad Hassan', NULL, 'a.hassan@dataguard.com', 'ahmad.hassan.sec@protonmail.com', '(408) 555-0712', '+1-408-555-0293', '1975-12-03', '445-67-8901', 'A12345678', 'CA D4456789', '5600 Almaden Expressway, Unit 7', 'San Jose', 'CA', '95118', 'US', 'External - Vendor', 'Director Professional Services (DataGuard)', 175000, 'Silicon Valley Bank', '121140399', '3918274650', NULL, 'SVBKUS6S', '6011-4928-3371-0056', '09/2026', '884', NULL, 'O+', 'Fatima Hassan', '(408) 555-0847', 'Wife', '104.56.178.92', 'C2:7A:E4:8B:D3:F6'),
    ('Jennifer', 'Martinez', 'Jennifer Martinez', 'Jenn', 'j.martinez@techtalent.com', 'jenn.martinez88@hotmail.com', '(415) 555-0623', '+1-415-555-0847', '1988-08-29', '556-78-9012', '567891234', 'CA D5567890', '3400 California Street, Apt 6D', 'San Francisco', 'CA', '94118', 'US', 'External - Vendor', 'Sr Account Executive (TechTalent)', 130000, 'First Republic Bank', '321081669', '4827391056', NULL, NULL, '5105-1051-0510-5100', '01/2028', '256', NULL, 'A+', 'Carlos Martinez', '(415) 555-2938', 'Husband', '50.184.72.113', 'D9:1B:F3:5C:A7:E8'),
    ('Klaus', 'Weber', 'Klaus Weber', NULL, 'k.weber@meridian-supplies.de', NULL, '+49 69 5555 1234', '+49 170 5555 6789', '1968-02-14', NULL, 'T220001293', NULL, 'Hauptwache 12', 'Frankfurt am Main', NULL, '60313', 'US', 'External - Vendor', 'Intl Sales Manager (Meridian Supplies)', 95000, 'Deutsche Bank', NULL, NULL, 'DE89 3704 0044 0532 0130 00', 'COBADEFFXXX', '4000-0012-3456-7899', '11/2027', '432', NULL, 'B+', 'Helga Weber', '+49 69 5555 4321', 'Wife', '91.23.145.67', NULL),
    ('Richard', 'Blackwell', 'Richard Blackwell', NULL, 'r.blackwell@meridianglobal.com', 'rich.blackwell@gmail.com', '+44 20 7946 0958', '+44 7911 555 678', '1970-11-05', NULL, '987654321', NULL, '25 Canary Wharf', 'London', NULL, 'E14 5AB', 'US', 'External - Client', 'CEO (Meridian Global Industries)', 350000, 'Barclays Bank', NULL, NULL, 'GB82 WEST 1234 5698 7654 32', 'BARCGB22', '4462-0012-3456-7890', '08/2027', '567', NULL, 'O+', 'Victoria Blackwell', '+44 20 7946 1111', 'Wife', '185.45.23.89', NULL),
    ('Yuki', 'Tanaka', 'Yuki Tanaka', NULL, 'y.tanaka@novatech-pharma.com', NULL, '+81 3-5555-0847', '+81 90-5555-1234', '1982-03-28', NULL, 'TK1234567', NULL, '2-4-7 Marunouchi, Chiyoda-ku', 'Tokyo', NULL, '100-0005', 'US', 'External - Client', 'VP Research (NovaTech Pharmaceuticals)', 280000, 'MUFG Bank', NULL, NULL, NULL, 'BOTKJPJT', '3530-1113-3330-0000', '04/2028', '123', NULL, 'A-', 'Kenji Tanaka', '+81 3-5555-0999', 'Husband', '202.214.56.78', NULL),
    ('Hannah', 'Fischer', 'Hannah Fischer', NULL, 'h.fischer@bioventure.de', 'hannah.fischer.bio@gmail.com', '+49 30 5555 7890', '+49 171 5555 4321', '1979-07-12', NULL, 'C01234567', NULL, 'Friedrichstrasse 123', 'Berlin', NULL, '10117', 'US', 'External - Prospect', 'CTO (BioVenture Labs)', 220000, 'Commerzbank', NULL, NULL, 'DE44 5004 0000 0123 4567 89', 'COBADEFFXXX', '5425-9012-3456-7890', '02/2028', '891', NULL, 'AB+', 'Thomas Fischer', '+49 30 5555 1111', 'Husband', '88.76.54.32', NULL),
    ('David', 'Park', 'David Park', NULL, 'd.park@mofo.com', 'davidpark.esq@gmail.com', '(415) 555-2000', '+1-415-555-2100', '1974-01-30', '667-89-0123', '678912345', 'CA D6678901', '425 Market Street, 32nd Floor', 'San Francisco', 'CA', '94105', 'US', 'External - Legal Counsel', 'Partner (Morrison & Foerster)', 450000, 'Wells Fargo', '121000248', '8192734650', NULL, NULL, '4111-1111-1111-1111', '12/2027', '123', NULL, 'A+', 'Susan Park', '(415) 555-2222', 'Wife', '66.249.79.45', NULL);
  END IF;
END $$;

COMMIT;
