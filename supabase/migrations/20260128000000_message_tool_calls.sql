-- Add tool_calls column to messages table to persist tool call information
-- This allows tool calls to be displayed when viewing conversation history

ALTER TABLE messages
ADD COLUMN IF NOT EXISTS tool_calls JSONB DEFAULT NULL;

-- Add comment for documentation
COMMENT ON COLUMN messages.tool_calls IS 'Array of tool calls made during this assistant response. Each entry contains tool_name, arguments, status, and result_summary.';
