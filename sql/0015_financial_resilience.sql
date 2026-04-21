BEGIN;

ALTER TABLE stark_wallet_positions
    ADD COLUMN IF NOT EXISTS dust_loss_usd NUMERIC NOT NULL DEFAULT 0;

ALTER TABLE stark_wallet_stats
    ADD COLUMN IF NOT EXISTS total_dust_loss_usd NUMERIC NOT NULL DEFAULT 0;

ALTER TABLE stark_audit_discrepancies
    DROP CONSTRAINT IF EXISTS stark_audit_discrepancies_discrepancy_type_check;

ALTER TABLE stark_audit_discrepancies
    ADD CONSTRAINT stark_audit_discrepancies_discrepancy_type_check
    CHECK (discrepancy_type IN ('NEGATIVE_BALANCE_REPLAY', 'PRICE_MISSING_AUDIT'));

COMMIT;
