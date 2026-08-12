-- Add anonymized_content column to messages table.
-- Caches the PII-anonymized version of each message so we don't
-- re-run Presidio NER on historical messages every request.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS anonymized_content TEXT;
