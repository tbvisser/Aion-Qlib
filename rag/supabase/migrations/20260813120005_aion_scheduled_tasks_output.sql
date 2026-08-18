-- Link each scheduled-task execution to the output it produced.
--
-- macro_refresh and data_refresh create in-memory jobs; run_strategy creates a
-- persisted backtest run. Storing the output ID lets the Scheduled Tasks page
-- preview the result and deep-link into the job/run page.

ALTER TABLE aion.scheduled_tasks
    ADD COLUMN IF NOT EXISTS last_output_id TEXT,
    ADD COLUMN IF NOT EXISTS last_output_kind TEXT CHECK (last_output_kind IN ('macro_job', 'ingest_job', 'run')),
    ADD COLUMN IF NOT EXISTS last_output_summary JSONB;
