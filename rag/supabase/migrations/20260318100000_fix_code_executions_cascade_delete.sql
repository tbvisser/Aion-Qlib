-- Fix: thread deletion fails because code_executions has a foreign key without CASCADE
-- Drop the existing constraint and re-add with ON DELETE CASCADE

ALTER TABLE code_executions
    DROP CONSTRAINT code_executions_thread_id_fkey;

ALTER TABLE code_executions
    ADD CONSTRAINT code_executions_thread_id_fkey
    FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE;
