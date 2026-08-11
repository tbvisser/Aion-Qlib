-- Remove system settings columns from global_settings table.
-- These are now read from environment variables via backend config.
-- Only metadata_schema (dynamic content config) remains in the DB.

ALTER TABLE global_settings
  DROP COLUMN IF EXISTS llm_model,
  DROP COLUMN IF EXISTS llm_base_url,
  DROP COLUMN IF EXISTS llm_api_key,
  DROP COLUMN IF EXISTS embedding_model,
  DROP COLUMN IF EXISTS embedding_base_url,
  DROP COLUMN IF EXISTS embedding_api_key,
  DROP COLUMN IF EXISTS embedding_dimensions,
  DROP COLUMN IF EXISTS rerank_model,
  DROP COLUMN IF EXISTS rerank_base_url,
  DROP COLUMN IF EXISTS rerank_api_key,
  DROP COLUMN IF EXISTS rerank_top_n,
  DROP COLUMN IF EXISTS web_search_provider,
  DROP COLUMN IF EXISTS web_search_api_key,
  DROP COLUMN IF EXISTS web_search_enabled,
  DROP COLUMN IF EXISTS local_llm_model,
  DROP COLUMN IF EXISTS local_llm_base_url;
