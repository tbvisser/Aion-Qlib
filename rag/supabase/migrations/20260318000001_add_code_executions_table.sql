-- Code executions table for sandbox code execution tracking

CREATE TABLE IF NOT EXISTS code_executions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id),
    thread_id UUID NOT NULL REFERENCES threads(id),
    language TEXT NOT NULL DEFAULT 'python',
    code TEXT NOT NULL,
    stdout TEXT,
    stderr TEXT,
    exit_code INTEGER,
    libraries TEXT[],
    execution_time_ms INTEGER,
    status TEXT NOT NULL DEFAULT 'running',
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_code_executions_thread_id ON code_executions(thread_id);
CREATE INDEX IF NOT EXISTS idx_code_executions_user_id ON code_executions(user_id);

-- RLS
ALTER TABLE code_executions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access to code_executions"
    ON code_executions FOR ALL
    USING (role() = 'service_role');

CREATE POLICY "Users can view own code executions"
    ON code_executions FOR SELECT
    USING (uid() = user_id);

CREATE POLICY "Users can insert own code executions"
    ON code_executions FOR INSERT
    WITH CHECK (uid() = user_id);

CREATE POLICY "Users can update own code executions"
    ON code_executions FOR UPDATE
    USING (uid() = user_id);
