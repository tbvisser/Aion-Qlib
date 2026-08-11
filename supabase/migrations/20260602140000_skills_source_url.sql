-- Track the origin URL when a skill is imported from a remote registry
-- (skills.sh / GitHub). NULL for manually-created or locally-imported skills.
ALTER TABLE skills ADD COLUMN IF NOT EXISTS source_url text;

COMMENT ON COLUMN skills.source_url IS 'Origin URL when the skill was imported from a remote registry (skills.sh / GitHub).';
