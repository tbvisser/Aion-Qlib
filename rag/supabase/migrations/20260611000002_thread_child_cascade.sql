-- Fix: threads that had a harness run or PII entity-registry entries could not
-- be deleted -- DELETE /threads 500'd with a foreign-key violation -- because
-- these two child-table FKs were created without ON DELETE CASCADE, unlike every
-- other thread child table (messages, agent_todos, workspace_files,
-- code_executions, thread_compactions, answer_citations all cascade). Bring them
-- in line so deleting a thread cleans up its harness runs and entity registry.

ALTER TABLE harness_runs DROP CONSTRAINT IF EXISTS harness_runs_thread_id_fkey;
ALTER TABLE harness_runs
  ADD CONSTRAINT harness_runs_thread_id_fkey
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE;

ALTER TABLE thread_entity_registry DROP CONSTRAINT IF EXISTS thread_entity_registry_thread_id_fkey;
ALTER TABLE thread_entity_registry
  ADD CONSTRAINT thread_entity_registry_thread_id_fkey
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE;
