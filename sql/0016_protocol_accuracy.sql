BEGIN;

ALTER TABLE stark_audit_discrepancies
    ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE stark_audit_discrepancies
    DROP CONSTRAINT IF EXISTS stark_audit_discrepancies_resolution_status_check;

ALTER TABLE stark_audit_discrepancies
    ADD CONSTRAINT stark_audit_discrepancies_resolution_status_check
    CHECK (resolution_status IN ('logged', 'decoder_review_required', 'rpc_repaired', 'rpc_unavailable', 'clamped_zero', 'FATAL_MANUAL_REVIEW'));

COMMIT;
