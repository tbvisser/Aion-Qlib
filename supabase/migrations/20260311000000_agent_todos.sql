-- Story 1.1: agent_todos table for deep mode planning

-- Create agent_todos table
CREATE TABLE IF NOT EXISTS agent_todos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id UUID NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'completed')),
    position INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_agent_todos_thread_id ON agent_todos(thread_id);
CREATE INDEX IF NOT EXISTS idx_agent_todos_thread_position ON agent_todos(thread_id, position);

-- Enable Row Level Security
ALTER TABLE agent_todos ENABLE ROW LEVEL SECURITY;

-- RLS Policies: thread-ownership join pattern (same as messages)
CREATE POLICY "Users can view todos in their own threads"
    ON agent_todos FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM threads
            WHERE threads.id = agent_todos.thread_id
            AND threads.user_id = auth.uid()
        )
    );

CREATE POLICY "Users can create todos in their own threads"
    ON agent_todos FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM threads
            WHERE threads.id = agent_todos.thread_id
            AND threads.user_id = auth.uid()
        )
    );

CREATE POLICY "Users can update todos in their own threads"
    ON agent_todos FOR UPDATE
    USING (
        EXISTS (
            SELECT 1 FROM threads
            WHERE threads.id = agent_todos.thread_id
            AND threads.user_id = auth.uid()
        )
    );

CREATE POLICY "Users can delete todos in their own threads"
    ON agent_todos FOR DELETE
    USING (
        EXISTS (
            SELECT 1 FROM threads
            WHERE threads.id = agent_todos.thread_id
            AND threads.user_id = auth.uid()
        )
    );

-- Trigger for updated_at (reuses existing function from initial_schema)
DROP TRIGGER IF EXISTS update_agent_todos_updated_at ON agent_todos;
CREATE TRIGGER update_agent_todos_updated_at
    BEFORE UPDATE ON agent_todos
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
