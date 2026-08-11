-- Remove Checked Citations (Deep-Mode citation verification). See
-- .agent/plans/17.remove-checked-citations.md.
--
-- claim_states was populated only by the citation verifier (per-claim
-- verification status), which has been removed. Quick-mode citations never
-- wrote to it. Dropping it is safe; the answer_citations table is shared with
-- Quick mode and is intentionally left intact (its support_score / claim_id /
-- problem / verification_mode columns simply stay null/'unverified' for Quick
-- citations).

DROP TABLE IF EXISTS claim_states CASCADE;
