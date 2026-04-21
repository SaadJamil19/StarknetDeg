BEGIN;

ALTER TABLE stark_pnl_audit_trail
    ADD COLUMN IF NOT EXISTS lot_id TEXT;

UPDATE stark_pnl_audit_trail
   SET lot_id = COALESCE(lot_id, buy_trade_key, audit_trail_key)
 WHERE lot_id IS NULL;

DELETE FROM stark_pnl_audit_trail AS audit
 USING (
    SELECT ctid,
           ROW_NUMBER() OVER (
             PARTITION BY sell_tx_hash, buy_tx_hash, lot_id
             ORDER BY updated_at DESC, created_at DESC, audit_trail_key DESC
           ) AS row_rank
      FROM stark_pnl_audit_trail
 ) AS ranked
 WHERE audit.ctid = ranked.ctid
   AND ranked.row_rank > 1;

ALTER TABLE stark_pnl_audit_trail
    ALTER COLUMN lot_id SET NOT NULL;

ALTER TABLE stark_pnl_audit_trail
    DROP CONSTRAINT IF EXISTS stark_pnl_audit_trail_sell_buy_lot_key;

ALTER TABLE stark_pnl_audit_trail
    ADD CONSTRAINT stark_pnl_audit_trail_sell_buy_lot_key
    UNIQUE (sell_tx_hash, buy_tx_hash, lot_id);

ALTER TABLE stark_audit_discrepancies
    DROP CONSTRAINT IF EXISTS stark_audit_discrepancies_resolution_status_check;

ALTER TABLE stark_audit_discrepancies
    ADD CONSTRAINT stark_audit_discrepancies_resolution_status_check
    CHECK (resolution_status IN (
        'logged',
        'PENDING_REDECODE',
        'decoder_review_required',
        'rpc_repaired',
        'rpc_unavailable',
        'clamped_zero',
        'FATAL_MANUAL_REVIEW'
    ));

CREATE INDEX IF NOT EXISTS stark_audit_discrepancies_pending_redecode_idx
    ON stark_audit_discrepancies (lane, block_number)
    WHERE resolution_status = 'PENDING_REDECODE';

COMMIT;
