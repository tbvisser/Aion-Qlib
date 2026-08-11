-- Budget compliance demo: tables + seed data
-- 3 tables: team_members, travel_expenses, budget_limits

-- ============================================================
-- Tables
-- ============================================================

CREATE TABLE IF NOT EXISTS team_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  department TEXT NOT NULL,
  level TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS travel_expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES team_members(id),
  quarter TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  expense_date DATE NOT NULL
);

CREATE TABLE IF NOT EXISTS budget_limits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  level TEXT NOT NULL,
  category TEXT NOT NULL,
  quarterly_limit DECIMAL(10,2) NOT NULL,
  UNIQUE(level, category)
);

-- ============================================================
-- Seed: Budget Limits
-- ============================================================

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
  ('Director', 'ground_transport', 1200.00);

-- ============================================================
-- Seed: Team Members (20 people)
-- ============================================================

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
  ('a0000001-0000-0000-0000-000000000020', 'Michael Davis', 'michael.davis@company.com', 'Sales', 'Senior');

-- ============================================================
-- Seed: Q3 Travel Expenses
-- ============================================================

-- Sarah Chen (Senior, limit $9,300) — OVER ~$11,500
INSERT INTO travel_expenses (user_id, quarter, category, description, amount, expense_date) VALUES
  ('a0000001-0000-0000-0000-000000000001', 'Q3', 'flights', 'Flight to AWS re:Invent early bird', 1850.00, '2025-07-15'),
  ('a0000001-0000-0000-0000-000000000001', 'Q3', 'flights', 'Flight to GopherCon Denver', 1680.00, '2025-08-05'),
  ('a0000001-0000-0000-0000-000000000001', 'Q3', 'flights', 'Flight to client site NYC', 1670.00, '2025-09-10'),
  ('a0000001-0000-0000-0000-000000000001', 'Q3', 'hotels', 'Hotel AWS re:Invent (4 nights)', 1520.00, '2025-07-16'),
  ('a0000001-0000-0000-0000-000000000001', 'Q3', 'hotels', 'Hotel GopherCon (3 nights)', 1140.00, '2025-08-06'),
  ('a0000001-0000-0000-0000-000000000001', 'Q3', 'hotels', 'Hotel NYC client visit (3 nights)', 1140.00, '2025-09-11'),
  ('a0000001-0000-0000-0000-000000000001', 'Q3', 'meals', 'Conference meals and team dinners', 980.00, '2025-07-18'),
  ('a0000001-0000-0000-0000-000000000001', 'Q3', 'meals', 'Client entertainment dinners NYC', 820.00, '2025-09-12'),
  ('a0000001-0000-0000-0000-000000000001', 'Q3', 'ground_transport', 'Uber/taxi across 3 trips', 700.00, '2025-09-15');

-- Marcus Johnson (Mid, limit $6,100) — OVER ~$7,800
INSERT INTO travel_expenses (user_id, quarter, category, description, amount, expense_date) VALUES
  ('a0000001-0000-0000-0000-000000000002', 'Q3', 'flights', 'Flight to Chicago client meeting', 1200.00, '2025-07-08'),
  ('a0000001-0000-0000-0000-000000000002', 'Q3', 'flights', 'Flight to Miami prospect visit', 1200.00, '2025-08-20'),
  ('a0000001-0000-0000-0000-000000000002', 'Q3', 'hotels', 'Hotel Chicago (2 nights)', 1050.00, '2025-07-09'),
  ('a0000001-0000-0000-0000-000000000002', 'Q3', 'hotels', 'Hotel Miami (2 nights)', 1050.00, '2025-08-21'),
  ('a0000001-0000-0000-0000-000000000002', 'Q3', 'meals', 'Client dinner - Steakhouse Chicago', 680.00, '2025-07-09'),
  ('a0000001-0000-0000-0000-000000000002', 'Q3', 'meals', 'Prospect dinner - Miami Beach', 720.00, '2025-08-21'),
  ('a0000001-0000-0000-0000-000000000002', 'Q3', 'meals', 'Team lunch meetings (monthly)', 550.00, '2025-09-05'),
  ('a0000001-0000-0000-0000-000000000002', 'Q3', 'meals', 'Client happy hour events', 550.00, '2025-09-18'),
  ('a0000001-0000-0000-0000-000000000002', 'Q3', 'ground_transport', 'Uber/taxi Chicago and Miami', 800.00, '2025-08-25');

-- Emily Rodriguez (Director, limit $13,700) — BORDERLINE OVER ~$14,000
INSERT INTO travel_expenses (user_id, quarter, category, description, amount, expense_date) VALUES
  ('a0000001-0000-0000-0000-000000000003', 'Q3', 'flights', 'Flight to Cannes Lions festival', 2400.00, '2025-07-01'),
  ('a0000001-0000-0000-0000-000000000003', 'Q3', 'flights', 'Flight to NYC brand summit', 1800.00, '2025-08-12'),
  ('a0000001-0000-0000-0000-000000000003', 'Q3', 'flights', 'Flight to LA agency review', 2000.00, '2025-09-03'),
  ('a0000001-0000-0000-0000-000000000003', 'Q3', 'hotels', 'Hotel Cannes (4 nights)', 2100.00, '2025-07-02'),
  ('a0000001-0000-0000-0000-000000000003', 'Q3', 'hotels', 'Hotel NYC summit (3 nights)', 1350.00, '2025-08-13'),
  ('a0000001-0000-0000-0000-000000000003', 'Q3', 'hotels', 'Hotel LA review (2 nights)', 850.00, '2025-09-04'),
  ('a0000001-0000-0000-0000-000000000003', 'Q3', 'meals', 'Cannes networking dinners', 1100.00, '2025-07-04'),
  ('a0000001-0000-0000-0000-000000000003', 'Q3', 'meals', 'NYC/LA client meals', 1000.00, '2025-09-06'),
  ('a0000001-0000-0000-0000-000000000003', 'Q3', 'ground_transport', 'Car services across 3 trips', 1400.00, '2025-09-10');

-- Alex Nguyen (Director, limit $13,700) — OVER ~$15,200
INSERT INTO travel_expenses (user_id, quarter, category, description, amount, expense_date) VALUES
  ('a0000001-0000-0000-0000-000000000008', 'Q3', 'flights', 'Flight to team offsite Aspen', 2800.00, '2025-07-20'),
  ('a0000001-0000-0000-0000-000000000008', 'Q3', 'flights', 'Flight to board meeting SF', 1600.00, '2025-08-15'),
  ('a0000001-0000-0000-0000-000000000008', 'Q3', 'flights', 'Flight to hiring event Austin', 1400.00, '2025-09-01'),
  ('a0000001-0000-0000-0000-000000000008', 'Q3', 'flights', 'Flight to vendor summit Seattle', 1200.00, '2025-09-18'),
  ('a0000001-0000-0000-0000-000000000008', 'Q3', 'hotels', 'Hotel team offsite Aspen (5 nights)', 2400.00, '2025-07-21'),
  ('a0000001-0000-0000-0000-000000000008', 'Q3', 'hotels', 'Hotel SF board meeting (2 nights)', 1200.00, '2025-08-16'),
  ('a0000001-0000-0000-0000-000000000008', 'Q3', 'hotels', 'Hotel Austin hiring (2 nights)', 1200.00, '2025-09-02'),
  ('a0000001-0000-0000-0000-000000000008', 'Q3', 'meals', 'Team offsite catering and dinners', 1200.00, '2025-07-23'),
  ('a0000001-0000-0000-0000-000000000008', 'Q3', 'meals', 'Board dinner and candidate meals', 1000.00, '2025-09-05'),
  ('a0000001-0000-0000-0000-000000000008', 'Q3', 'ground_transport', 'Car services all trips', 1200.00, '2025-09-20');

-- James Wilson (Junior, limit $3,700) — Under ~$1,800
INSERT INTO travel_expenses (user_id, quarter, category, description, amount, expense_date) VALUES
  ('a0000001-0000-0000-0000-000000000004', 'Q3', 'flights', 'Flight to training workshop', 650.00, '2025-08-01'),
  ('a0000001-0000-0000-0000-000000000004', 'Q3', 'hotels', 'Hotel training (2 nights)', 480.00, '2025-08-02'),
  ('a0000001-0000-0000-0000-000000000004', 'Q3', 'meals', 'Meals during training', 320.00, '2025-08-03'),
  ('a0000001-0000-0000-0000-000000000004', 'Q3', 'ground_transport', 'Airport shuttle', 350.00, '2025-08-04');

-- Priya Patel (Mid, limit $6,100) — Under ~$3,200
INSERT INTO travel_expenses (user_id, quarter, category, description, amount, expense_date) VALUES
  ('a0000001-0000-0000-0000-000000000005', 'Q3', 'flights', 'Flight to PyCon', 980.00, '2025-07-10'),
  ('a0000001-0000-0000-0000-000000000005', 'Q3', 'hotels', 'Hotel PyCon (3 nights)', 900.00, '2025-07-11'),
  ('a0000001-0000-0000-0000-000000000005', 'Q3', 'meals', 'Conference meals', 520.00, '2025-07-13'),
  ('a0000001-0000-0000-0000-000000000005', 'Q3', 'ground_transport', 'Taxi to/from airport', 250.00, '2025-07-14');

-- David Kim (Senior, limit $9,300) — Under ~$4,500
INSERT INTO travel_expenses (user_id, quarter, category, description, amount, expense_date) VALUES
  ('a0000001-0000-0000-0000-000000000006', 'Q3', 'flights', 'Flight to regional sales conf', 1400.00, '2025-08-18'),
  ('a0000001-0000-0000-0000-000000000006', 'Q3', 'hotels', 'Hotel sales conf (3 nights)', 1200.00, '2025-08-19'),
  ('a0000001-0000-0000-0000-000000000006', 'Q3', 'meals', 'Client dinners', 750.00, '2025-08-20'),
  ('a0000001-0000-0000-0000-000000000006', 'Q3', 'ground_transport', 'Rental car', 350.00, '2025-08-22');

-- Lisa Thompson (Junior, limit $3,700) — Under ~$1,200
INSERT INTO travel_expenses (user_id, quarter, category, description, amount, expense_date) VALUES
  ('a0000001-0000-0000-0000-000000000007', 'Q3', 'flights', 'Flight to marketing bootcamp', 520.00, '2025-09-08'),
  ('a0000001-0000-0000-0000-000000000007', 'Q3', 'hotels', 'Hotel bootcamp (2 nights)', 420.00, '2025-09-09'),
  ('a0000001-0000-0000-0000-000000000007', 'Q3', 'meals', 'Meals during bootcamp', 260.00, '2025-09-10');

-- Rachel Foster (Mid, limit $6,100) — Under ~$2,800
INSERT INTO travel_expenses (user_id, quarter, category, description, amount, expense_date) VALUES
  ('a0000001-0000-0000-0000-000000000009', 'Q3', 'flights', 'Flight to prospect meeting', 850.00, '2025-07-22'),
  ('a0000001-0000-0000-0000-000000000009', 'Q3', 'hotels', 'Hotel prospect visit (2 nights)', 780.00, '2025-07-23'),
  ('a0000001-0000-0000-0000-000000000009', 'Q3', 'meals', 'Prospect lunch and dinner', 420.00, '2025-07-24'),
  ('a0000001-0000-0000-0000-000000000009', 'Q3', 'ground_transport', 'Uber rides', 280.00, '2025-07-25');

-- Kevin O'Brien (Senior, limit $9,300) — Under ~$3,900
INSERT INTO travel_expenses (user_id, quarter, category, description, amount, expense_date) VALUES
  ('a0000001-0000-0000-0000-000000000010', 'Q3', 'flights', 'Flight to ops summit', 1350.00, '2025-08-25'),
  ('a0000001-0000-0000-0000-000000000010', 'Q3', 'hotels', 'Hotel ops summit (3 nights)', 1100.00, '2025-08-26'),
  ('a0000001-0000-0000-0000-000000000010', 'Q3', 'meals', 'Summit meals', 650.00, '2025-08-28'),
  ('a0000001-0000-0000-0000-000000000010', 'Q3', 'ground_transport', 'Ground transport', 300.00, '2025-08-29');

-- Maya Singh (Junior, limit $3,700) — Under ~$900
INSERT INTO travel_expenses (user_id, quarter, category, description, amount, expense_date) VALUES
  ('a0000001-0000-0000-0000-000000000011', 'Q3', 'flights', 'Flight to intern meetup', 380.00, '2025-09-15'),
  ('a0000001-0000-0000-0000-000000000011', 'Q3', 'hotels', 'Hotel intern meetup (1 night)', 320.00, '2025-09-16'),
  ('a0000001-0000-0000-0000-000000000011', 'Q3', 'meals', 'Meetup meals', 200.00, '2025-09-16');

-- Tom Bradley (Director, limit $13,700) — Under ~$6,500
INSERT INTO travel_expenses (user_id, quarter, category, description, amount, expense_date) VALUES
  ('a0000001-0000-0000-0000-000000000012', 'Q3', 'flights', 'Flight to leadership retreat', 2200.00, '2025-07-28'),
  ('a0000001-0000-0000-0000-000000000012', 'Q3', 'hotels', 'Hotel retreat (3 nights)', 1800.00, '2025-07-29'),
  ('a0000001-0000-0000-0000-000000000012', 'Q3', 'meals', 'Retreat dinners', 1100.00, '2025-07-31'),
  ('a0000001-0000-0000-0000-000000000012', 'Q3', 'ground_transport', 'Car service', 600.00, '2025-08-01');

-- Jessica Lee (Mid, limit $6,100) — Under ~$2,400
INSERT INTO travel_expenses (user_id, quarter, category, description, amount, expense_date) VALUES
  ('a0000001-0000-0000-0000-000000000013', 'Q3', 'flights', 'Flight to content strategy conf', 780.00, '2025-08-05'),
  ('a0000001-0000-0000-0000-000000000013', 'Q3', 'hotels', 'Hotel conf (2 nights)', 720.00, '2025-08-06'),
  ('a0000001-0000-0000-0000-000000000013', 'Q3', 'meals', 'Conference meals', 450.00, '2025-08-07'),
  ('a0000001-0000-0000-0000-000000000013', 'Q3', 'ground_transport', 'Taxi', 180.00, '2025-08-08');

-- Daniel Martinez (Mid, limit $6,100) — Under ~$2,600
INSERT INTO travel_expenses (user_id, quarter, category, description, amount, expense_date) VALUES
  ('a0000001-0000-0000-0000-000000000014', 'Q3', 'flights', 'Flight to vendor audit', 900.00, '2025-09-02'),
  ('a0000001-0000-0000-0000-000000000014', 'Q3', 'hotels', 'Hotel audit (2 nights)', 780.00, '2025-09-03'),
  ('a0000001-0000-0000-0000-000000000014', 'Q3', 'meals', 'Audit working meals', 380.00, '2025-09-04'),
  ('a0000001-0000-0000-0000-000000000014', 'Q3', 'ground_transport', 'Rental car', 280.00, '2025-09-05');

-- Olivia Brown (Senior, limit $9,300) — Under ~$5,100
INSERT INTO travel_expenses (user_id, quarter, category, description, amount, expense_date) VALUES
  ('a0000001-0000-0000-0000-000000000015', 'Q3', 'flights', 'Flight to tech lead summit', 1800.00, '2025-07-14'),
  ('a0000001-0000-0000-0000-000000000015', 'Q3', 'hotels', 'Hotel summit (3 nights)', 1350.00, '2025-07-15'),
  ('a0000001-0000-0000-0000-000000000015', 'Q3', 'meals', 'Summit meals and networking', 680.00, '2025-07-17'),
  ('a0000001-0000-0000-0000-000000000015', 'Q3', 'ground_transport', 'Uber rides', 350.00, '2025-07-18');

-- Chris Taylor (Junior, limit $3,700) — Under ~$1,400
INSERT INTO travel_expenses (user_id, quarter, category, description, amount, expense_date) VALUES
  ('a0000001-0000-0000-0000-000000000016', 'Q3', 'flights', 'Flight to sales onboarding', 580.00, '2025-08-11'),
  ('a0000001-0000-0000-0000-000000000016', 'Q3', 'hotels', 'Hotel onboarding (2 nights)', 460.00, '2025-08-12'),
  ('a0000001-0000-0000-0000-000000000016', 'Q3', 'meals', 'Onboarding meals', 240.00, '2025-08-13'),
  ('a0000001-0000-0000-0000-000000000016', 'Q3', 'ground_transport', 'Airport shuttle', 120.00, '2025-08-14');

-- Natalie White (Senior, limit $9,300) — BORDERLINE UNDER ~$9,100
INSERT INTO travel_expenses (user_id, quarter, category, description, amount, expense_date) VALUES
  ('a0000001-0000-0000-0000-000000000017', 'Q3', 'flights', 'Flight to AdWeek NYC', 1800.00, '2025-07-06'),
  ('a0000001-0000-0000-0000-000000000017', 'Q3', 'flights', 'Flight to brand conference LA', 1600.00, '2025-09-08'),
  ('a0000001-0000-0000-0000-000000000017', 'Q3', 'hotels', 'Hotel AdWeek (3 nights)', 1500.00, '2025-07-07'),
  ('a0000001-0000-0000-0000-000000000017', 'Q3', 'hotels', 'Hotel LA conf (3 nights)', 1350.00, '2025-09-09'),
  ('a0000001-0000-0000-0000-000000000017', 'Q3', 'meals', 'AdWeek networking meals', 750.00, '2025-07-09'),
  ('a0000001-0000-0000-0000-000000000017', 'Q3', 'meals', 'LA conference meals', 650.00, '2025-09-11'),
  ('a0000001-0000-0000-0000-000000000017', 'Q3', 'ground_transport', 'Car services NYC and LA', 650.00, '2025-09-12');

-- Ryan Clark (Junior, limit $3,700) — Under ~$800
INSERT INTO travel_expenses (user_id, quarter, category, description, amount, expense_date) VALUES
  ('a0000001-0000-0000-0000-000000000018', 'Q3', 'flights', 'Flight to ops training', 420.00, '2025-09-22'),
  ('a0000001-0000-0000-0000-000000000018', 'Q3', 'hotels', 'Hotel training (1 night)', 280.00, '2025-09-23'),
  ('a0000001-0000-0000-0000-000000000018', 'Q3', 'meals', 'Training meals', 100.00, '2025-09-23');

-- Sophia Adams (Mid, limit $6,100) — Under ~$2,900
INSERT INTO travel_expenses (user_id, quarter, category, description, amount, expense_date) VALUES
  ('a0000001-0000-0000-0000-000000000019', 'Q3', 'flights', 'Flight to hackathon', 950.00, '2025-08-28'),
  ('a0000001-0000-0000-0000-000000000019', 'Q3', 'hotels', 'Hotel hackathon (3 nights)', 870.00, '2025-08-29'),
  ('a0000001-0000-0000-0000-000000000019', 'Q3', 'meals', 'Hackathon meals', 480.00, '2025-08-31'),
  ('a0000001-0000-0000-0000-000000000019', 'Q3', 'ground_transport', 'Uber rides', 220.00, '2025-09-01');

-- Michael Davis (Senior, limit $9,300) — Under ~$4,800
INSERT INTO travel_expenses (user_id, quarter, category, description, amount, expense_date) VALUES
  ('a0000001-0000-0000-0000-000000000020', 'Q3', 'flights', 'Flight to partner meeting', 1600.00, '2025-07-18'),
  ('a0000001-0000-0000-0000-000000000020', 'Q3', 'hotels', 'Hotel partner visit (3 nights)', 1300.00, '2025-07-19'),
  ('a0000001-0000-0000-0000-000000000020', 'Q3', 'meals', 'Partner dinners', 680.00, '2025-07-21'),
  ('a0000001-0000-0000-0000-000000000020', 'Q3', 'ground_transport', 'Car rental', 400.00, '2025-07-22');

-- ============================================================
-- Grants
-- ============================================================

GRANT SELECT ON team_members TO sql_reader;
GRANT SELECT ON travel_expenses TO sql_reader;
GRANT SELECT ON budget_limits TO sql_reader;
