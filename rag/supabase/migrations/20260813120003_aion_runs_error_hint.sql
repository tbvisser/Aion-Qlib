-- `error_hint` is the plain-sentence diagnosis runner._diagnose() derives from a
-- failed run's log tail -- the thing that turns a traceback into "a feature held
-- an infinite value where the model needs a number".
--
-- It belongs beside `error` as a lifecycle field rather than inside `params`,
-- which holds the strategy knobs the run was launched with.

ALTER TABLE aion.runs ADD COLUMN IF NOT EXISTS error_hint TEXT;
