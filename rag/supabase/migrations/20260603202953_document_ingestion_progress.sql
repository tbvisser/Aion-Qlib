-- Live document ingestion progress for the documents UI.

ALTER TABLE documents ADD COLUMN IF NOT EXISTS ingestion_stage TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS ingestion_progress INTEGER NOT NULL DEFAULT 0;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS ingestion_message TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'documents_ingestion_progress_range'
    ) THEN
        ALTER TABLE documents
            ADD CONSTRAINT documents_ingestion_progress_range
            CHECK (ingestion_progress >= 0 AND ingestion_progress <= 100);
    END IF;
END $$;

UPDATE documents
SET
    ingestion_stage = CASE status
        WHEN 'completed' THEN 'completed'
        WHEN 'failed' THEN 'failed'
        WHEN 'processing' THEN 'processing'
        ELSE 'pending'
    END,
    ingestion_progress = CASE status
        WHEN 'completed' THEN 100
        WHEN 'failed' THEN 100
        WHEN 'processing' THEN GREATEST(ingestion_progress, 5)
        ELSE ingestion_progress
    END,
    ingestion_message = COALESCE(
        ingestion_message,
        CASE status
            WHEN 'completed' THEN 'Ready'
            WHEN 'failed' THEN COALESCE(error_message, 'Import failed')
            WHEN 'processing' THEN 'Processing document'
            ELSE 'Queued for processing'
        END
    );
