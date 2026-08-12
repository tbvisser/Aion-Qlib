-- Harness runs table for domain harness engine workflow tracking

CREATE TABLE IF NOT EXISTS harness_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id UUID NOT NULL REFERENCES threads(id),
    harness_type TEXT NOT NULL,
    status TEXT NOT NULL,
    current_phase INTEGER NOT NULL DEFAULT 0,
    phase_results JSONB DEFAULT '{}'::jsonb,
    input_file_ids UUID[] DEFAULT '{}'::uuid[],
    config JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_harness_runs_thread_id ON harness_runs(thread_id);
-- Only one active harness run per thread at a time
CREATE UNIQUE INDEX IF NOT EXISTS idx_harness_runs_active_per_thread
    ON harness_runs(thread_id)
    WHERE status IN ('pending', 'running', 'paused');

-- Updated_at trigger (reuses existing update_updated_at_column function)
CREATE TRIGGER update_harness_runs_updated_at
    BEFORE UPDATE ON harness_runs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- RLS
ALTER TABLE harness_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view harness runs in their own threads"
    ON harness_runs FOR SELECT
    USING (EXISTS (
        SELECT 1 FROM threads WHERE threads.id = harness_runs.thread_id AND threads.user_id = uid()
    ));

CREATE POLICY "Users can create harness runs in their own threads"
    ON harness_runs FOR INSERT
    WITH CHECK (EXISTS (
        SELECT 1 FROM threads WHERE threads.id = harness_runs.thread_id AND threads.user_id = uid()
    ));

CREATE POLICY "Users can update harness runs in their own threads"
    ON harness_runs FOR UPDATE
    USING (EXISTS (
        SELECT 1 FROM threads WHERE threads.id = harness_runs.thread_id AND threads.user_id = uid()
    ));

CREATE POLICY "Users can delete harness runs in their own threads"
    ON harness_runs FOR DELETE
    USING (EXISTS (
        SELECT 1 FROM threads WHERE threads.id = harness_runs.thread_id AND threads.user_id = uid()
    ));

-- Atomic phase update function (used by harness engine to advance phases)
CREATE OR REPLACE FUNCTION public.update_harness_phase_atomic(
    p_run_id UUID,
    p_user_id UUID,
    p_phase_key TEXT,
    p_phase_result JSONB,
    p_next_phase INTEGER
)
RETURNS SETOF harness_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
    RETURN QUERY
    UPDATE harness_runs
    SET
        phase_results = jsonb_set(
            COALESCE(phase_results, '{}'::jsonb),
            ARRAY[p_phase_key],
            p_phase_result
        ),
        current_phase = p_next_phase,
        updated_at = now()
    WHERE id = p_run_id
      AND thread_id IN (SELECT id FROM threads WHERE user_id = p_user_id)
    RETURNING *;
END;
$function$;
