BEGIN;

CREATE TABLE IF NOT EXISTS stark_audit_discrepancies (
    audit_id BIGSERIAL PRIMARY KEY,
    lane TEXT NOT NULL,
    discrepancy_type TEXT NOT NULL,
    block_number NUMERIC(78, 0) NOT NULL,
    block_hash TEXT NOT NULL,
    transaction_hash TEXT NOT NULL,
    transaction_index NUMERIC(78, 0) NOT NULL,
    source_event_index NUMERIC(78, 0) NOT NULL,
    transfer_key TEXT,
    token_address TEXT NOT NULL,
    holder_address TEXT NOT NULL,
    balance_before NUMERIC(78, 0) NOT NULL,
    delta_amount NUMERIC(78, 0) NOT NULL,
    attempted_balance_after NUMERIC(78, 0) NOT NULL,
    resolved_balance NUMERIC(78, 0),
    resolution_status TEXT NOT NULL DEFAULT 'logged',
    suspected_cause TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (lane IN ('PRE_CONFIRMED', 'ACCEPTED_ON_L2', 'ACCEPTED_ON_L1')),
    CHECK (discrepancy_type IN ('NEGATIVE_BALANCE_REPLAY', 'PRICE_MISSING_AUDIT')),
    CHECK (block_number >= 0),
    CHECK (transaction_index >= 0),
    CHECK (source_event_index >= 0),
    CHECK (resolution_status IN ('logged', 'decoder_review_required', 'rpc_repaired', 'rpc_unavailable', 'clamped_zero'))
);

CREATE INDEX IF NOT EXISTS stark_audit_discrepancies_block_idx
    ON stark_audit_discrepancies (lane, block_number, transaction_index, source_event_index);

CREATE INDEX IF NOT EXISTS stark_audit_discrepancies_holder_idx
    ON stark_audit_discrepancies (lane, token_address, holder_address, created_at DESC);

COMMIT;
