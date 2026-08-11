-- Add harness_mode column to messages table for domain harness engine
-- deep_mode (boolean) remains — harness_mode stores the harness type (e.g. 'contract_review')

ALTER TABLE messages ADD COLUMN IF NOT EXISTS harness_mode TEXT;
