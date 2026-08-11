-- Trigger function to prevent cycles in folder hierarchy
CREATE OR REPLACE FUNCTION prevent_folder_cycle()
RETURNS TRIGGER AS $$
BEGIN
    -- Trivial case: cannot be own parent
    IF NEW.parent_id = NEW.id THEN
        RAISE EXCEPTION 'Folder cannot be its own parent';
    END IF;

    -- NULL parent is always valid (moving to root)
    IF NEW.parent_id IS NULL THEN
        RETURN NEW;
    END IF;

    -- Check if the new parent is a descendant of this folder (would create cycle)
    IF EXISTS (
        WITH RECURSIVE ancestors AS (
            -- Start from the proposed new parent
            SELECT id, parent_id
            FROM folders
            WHERE id = NEW.parent_id

            UNION ALL

            -- Walk up the ancestor chain
            SELECT f.id, f.parent_id
            FROM folders f
            INNER JOIN ancestors a ON f.id = a.parent_id
        )
        SELECT 1 FROM ancestors WHERE id = NEW.id
    ) THEN
        RAISE EXCEPTION 'Moving folder would create a circular reference';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger fires before parent_id is updated on folders table
CREATE TRIGGER check_folder_cycle
    BEFORE UPDATE OF parent_id ON folders
    FOR EACH ROW
    EXECUTE FUNCTION prevent_folder_cycle();
