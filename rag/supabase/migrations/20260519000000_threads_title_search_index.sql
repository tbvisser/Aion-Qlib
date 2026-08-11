-- Enable pg_trgm for fast ILIKE on titles (idempotent)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN trigram index makes `title ILIKE '%term%'` index-backed.
CREATE INDEX IF NOT EXISTS idx_threads_title_trgm
    ON public.threads
    USING gin (title gin_trgm_ops);
