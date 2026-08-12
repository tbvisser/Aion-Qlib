-- Add columns that were added directly to the database without migrations

-- PII anonymization columns
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS anonymized_content TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS anonymized_full_markdown TEXT;

-- Folder sharing
ALTER TABLE folders ADD COLUMN IF NOT EXISTS shared_by UUID;

-- Skill marketplace metadata
ALTER TABLE skills ADD COLUMN IF NOT EXISTS license TEXT;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS compatibility TEXT;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS metadata JSONB;

-- Function to cascade user_id to all descendant folders
CREATE OR REPLACE FUNCTION public.cascade_folder_user_id(root_folder_id UUID, new_user_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    updated_count INTEGER;
BEGIN
    WITH RECURSIVE descendants AS (
        -- Direct children of the root folder
        SELECT id FROM public.folders WHERE parent_id = root_folder_id
        UNION ALL
        -- Recursively find all descendants
        SELECT f.id FROM public.folders f
        INNER JOIN descendants d ON f.parent_id = d.id
    )
    UPDATE public.folders
    SET user_id = new_user_id
    WHERE id IN (SELECT id FROM descendants);

    GET DIAGNOSTICS updated_count = ROW_COUNT;
    RETURN updated_count;
END;
$function$;
