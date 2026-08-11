-- Navigation Tools: get_folder_tree function
-- Provides recursive folder hierarchy traversal for navigation tools

CREATE OR REPLACE FUNCTION get_folder_tree(
    start_folder_id UUID,
    max_depth INTEGER DEFAULT 3
)
RETURNS TABLE (
    id UUID,
    name TEXT,
    parent_id UUID,
    user_id UUID,
    depth INTEGER
) AS $$
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
$$ LANGUAGE plpgsql STABLE;

-- Grant execute permission to authenticated users
GRANT EXECUTE ON FUNCTION get_folder_tree(UUID, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION get_folder_tree(UUID, INTEGER) TO anon;

COMMENT ON FUNCTION get_folder_tree IS 'Returns folder hierarchy with depth tracking. Uses SECURITY INVOKER (default) so RLS policies are enforced.';
