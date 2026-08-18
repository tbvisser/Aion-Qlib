-- Make aion.projects match its two siblings: one `spec` jsonb holding the
-- pydantic model, with `name` denormalised alongside it for sorting.
--
-- 20260813120001 gave projects dedicated array columns for its member ids. That
-- was a second source of truth -- the same lists would also live inside the
-- serialised spec -- and it made projects the one table needing bespoke read and
-- write code instead of sharing the generic repository. The columns are dropped
-- here rather than in the original migration so the change is legible in
-- history; the table has no rows yet, so nothing is lost.

ALTER TABLE aion.projects ADD COLUMN IF NOT EXISTS spec JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE aion.projects DROP COLUMN IF EXISTS description;
ALTER TABLE aion.projects DROP COLUMN IF EXISTS strategy_ids;
ALTER TABLE aion.projects DROP COLUMN IF EXISTS portfolio_ids;
ALTER TABLE aion.projects DROP COLUMN IF EXISTS thread_ids;
ALTER TABLE aion.projects DROP COLUMN IF EXISTS document_ids;
