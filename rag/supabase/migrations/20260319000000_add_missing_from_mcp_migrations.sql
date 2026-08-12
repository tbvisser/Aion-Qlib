-- Backfill migration: captures 6 items that were applied via MCP apply_migration
-- but never written to on-disk migration files. Without this file a fresh install
-- would be missing these objects.
--
-- Source MCP migrations consolidated here:
--   - add_message_sequence_and_phases  (sequence_number, harness_phases_before, next_message_sequence(), index)
--   - add_user_filter_to_get_folder_tree  (get_folder_tree with p_user_id param)
--   - enable_realtime_threads  (realtime publication + replica identity)

-- ============================================================
-- 1. messages.sequence_number column
-- ============================================================
ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS sequence_number INTEGER NOT NULL DEFAULT 0;

-- ============================================================
-- 2. messages.harness_phases_before column
-- ============================================================
ALTER TABLE messages
    ADD COLUMN IF NOT EXISTS harness_phases_before JSONB;

-- ============================================================
-- 3. Index on (thread_id, sequence_number)
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_messages_thread_sequence
    ON messages (thread_id, sequence_number);

-- ============================================================
-- 4. next_message_sequence() function
--    Uses an advisory lock to safely generate sequential message
--    numbers within a thread.
-- ============================================================
CREATE OR REPLACE FUNCTION public.next_message_sequence(p_thread_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    next_seq INTEGER;
BEGIN
    -- Advisory lock scoped to transaction, keyed on thread_id
    PERFORM pg_advisory_xact_lock(hashtext(p_thread_id::text));
    SELECT COALESCE(MAX(sequence_number), 0) + 1 INTO next_seq
    FROM messages WHERE thread_id = p_thread_id;
    RETURN next_seq;
END;
$function$;

-- ============================================================
-- 5. get_folder_tree() — add p_user_id parameter for visibility
--    Replaces the 2-param version from 20260205100000 with a
--    3-param version that filters by user ownership.
-- ============================================================
DROP FUNCTION IF EXISTS get_folder_tree(UUID, INTEGER);

CREATE OR REPLACE FUNCTION public.get_folder_tree(
    start_folder_id uuid,
    max_depth integer DEFAULT 3,
    p_user_id uuid DEFAULT NULL::uuid
)
 RETURNS TABLE(id uuid, name text, parent_id uuid, user_id uuid, depth integer)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
BEGIN
    RETURN QUERY
    WITH RECURSIVE folder_tree AS (
        -- Anchor: immediate children of start folder (or root folders if NULL)
        SELECT
            f.id,
            f.name,
            f.parent_id,
            f.user_id,
            0 AS depth
        FROM folders f
        WHERE
            CASE
                WHEN start_folder_id IS NULL THEN f.parent_id IS NULL
                ELSE f.parent_id = start_folder_id
            END
            -- User visibility filter: global folders OR user's own folders
            AND (f.user_id IS NULL OR f.user_id = p_user_id)

        UNION ALL

        -- Recursive: children of current level
        SELECT
            f.id,
            f.name,
            f.parent_id,
            f.user_id,
            ft.depth + 1
        FROM folders f
        INNER JOIN folder_tree ft ON f.parent_id = ft.id
        WHERE ft.depth < max_depth - 1
            -- User visibility filter on recursive children too
            AND (f.user_id IS NULL OR f.user_id = p_user_id)
    )
    SELECT
        folder_tree.id,
        folder_tree.name,
        folder_tree.parent_id,
        folder_tree.user_id,
        folder_tree.depth
    FROM folder_tree
    ORDER BY folder_tree.depth, folder_tree.name;
END;
$function$;

-- Re-grant execute permissions
GRANT EXECUTE ON FUNCTION get_folder_tree(UUID, INTEGER, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION get_folder_tree(UUID, INTEGER, UUID) TO anon;

-- ============================================================
-- 6. Enable Realtime for threads table
-- ============================================================
ALTER TABLE threads REPLICA IDENTITY FULL;

DO $$
BEGIN
    -- Only add if not already in the publication
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND tablename = 'threads'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE threads;
    END IF;
END $$;
