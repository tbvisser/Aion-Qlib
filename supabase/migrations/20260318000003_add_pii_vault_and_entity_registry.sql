-- PII vault (global deduplication) and thread entity registry (per-thread mapping)
-- Used by the PII anonymization system

-- Global PII vault
CREATE TABLE IF NOT EXISTS pii_vault (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type TEXT NOT NULL,
    original_value TEXT NOT NULL,
    surrogate_value TEXT NOT NULL,
    normalized_key TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (entity_type, normalized_key)
);

CREATE INDEX IF NOT EXISTS idx_pii_vault_entity_normalized ON pii_vault(entity_type, normalized_key);
CREATE INDEX IF NOT EXISTS idx_pii_vault_entity_surrogate ON pii_vault(entity_type, surrogate_value);
CREATE INDEX IF NOT EXISTS idx_pii_vault_surrogate_value ON pii_vault(surrogate_value);

ALTER TABLE pii_vault ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access"
    ON pii_vault FOR ALL
    USING (role() = 'service_role')
    WITH CHECK (role() = 'service_role');

-- Per-thread entity registry
CREATE TABLE IF NOT EXISTS thread_entity_registry (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    thread_id UUID NOT NULL REFERENCES threads(id),
    entity_type TEXT NOT NULL,
    original_value TEXT NOT NULL,
    surrogate_value TEXT NOT NULL,
    normalized_key TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (thread_id, entity_type, normalized_key)
);

CREATE INDEX IF NOT EXISTS idx_thread_entity_lookup ON thread_entity_registry(thread_id, entity_type, normalized_key);
CREATE INDEX IF NOT EXISTS idx_thread_entity_deanon ON thread_entity_registry(thread_id, surrogate_value);

ALTER TABLE thread_entity_registry ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access"
    ON thread_entity_registry FOR ALL
    USING (role() = 'service_role')
    WITH CHECK (role() = 'service_role');
