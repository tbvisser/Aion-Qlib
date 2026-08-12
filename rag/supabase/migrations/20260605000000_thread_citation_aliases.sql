-- Plan 23 Phase B: thread-stable citation numbering.
--
-- A passage's {[S#]} display number is assigned once and reused for the whole
-- thread, so prior-turn passages stay citable with the same token and a number
-- never resolves to a different span across turns (which the per-turn-local
-- numbering allowed). The registry is a JSONB map keyed by canonical span_id:
--
--   { "<span_id>": { "n": <display_number>, "s": { <EvidenceSpan fields> } } }
--
-- Loaded once at the start of each assistant turn to seed numbering, and merged
-- with the turn's newly-numbered spans at finalize. RLS is inherited from the
-- existing threads policies; no embeddings/search paths are affected.

ALTER TABLE threads
    ADD COLUMN IF NOT EXISTS citation_aliases jsonb NOT NULL DEFAULT '{}'::jsonb;
