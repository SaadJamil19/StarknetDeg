BEGIN;

CREATE TABLE IF NOT EXISTS stark_index_state (
    indexer_key TEXT NOT NULL,
    lane TEXT NOT NULL,
    last_processed_block_number NUMERIC(78, 0),
    last_processed_block_hash TEXT,
    last_processed_parent_hash TEXT,
    last_processed_old_root TEXT,
    last_processed_new_root TEXT,
    last_finality_status TEXT,
    last_committed_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (indexer_key, lane),
    CHECK (lane IN ('PRE_CONFIRMED', 'ACCEPTED_ON_L2', 'ACCEPTED_ON_L1')),
    CHECK (last_processed_block_number IS NULL OR last_processed_block_number >= 0)
);

CREATE INDEX IF NOT EXISTS stark_index_state_lane_block_idx
    ON stark_index_state (lane, last_processed_block_number);

CREATE TABLE IF NOT EXISTS stark_block_journal (
    lane TEXT NOT NULL,
    block_number NUMERIC(78, 0) NOT NULL,
    block_hash TEXT NOT NULL,
    parent_hash TEXT NOT NULL,
    old_root TEXT,
    new_root TEXT,
    finality_status TEXT NOT NULL,
    block_timestamp NUMERIC(78, 0),
    sequencer_address TEXT,
    starknet_version TEXT,
    l1_da_mode TEXT,
    transaction_count NUMERIC(78, 0) NOT NULL DEFAULT 0,
    event_count NUMERIC(78, 0) NOT NULL DEFAULT 0,
    state_diff_length NUMERIC(78, 0),
    succeeded_transaction_count NUMERIC(78, 0) NOT NULL DEFAULT 0,
    reverted_transaction_count NUMERIC(78, 0) NOT NULL DEFAULT 0,
    l1_handler_transaction_count NUMERIC(78, 0) NOT NULL DEFAULT 0,
    is_orphaned BOOLEAN NOT NULL DEFAULT FALSE,
    orphaned_at TIMESTAMPTZ,
    raw_block JSONB NOT NULL,
    raw_state_update JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (lane, block_number, block_hash),
    CHECK (lane IN ('PRE_CONFIRMED', 'ACCEPTED_ON_L2', 'ACCEPTED_ON_L1')),
    CHECK (finality_status IN ('PRE_CONFIRMED', 'ACCEPTED_ON_L2', 'ACCEPTED_ON_L1')),
    CHECK (block_number >= 0),
    CHECK (block_timestamp IS NULL OR block_timestamp >= 0),
    CHECK (transaction_count >= 0),
    CHECK (event_count >= 0),
    CHECK (state_diff_length IS NULL OR state_diff_length >= 0),
    CHECK (succeeded_transaction_count >= 0),
    CHECK (reverted_transaction_count >= 0),
    CHECK (l1_handler_transaction_count >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS stark_block_journal_active_lane_block_idx
    ON stark_block_journal (lane, block_number)
    WHERE is_orphaned = FALSE;

CREATE INDEX IF NOT EXISTS stark_block_journal_finality_idx
    ON stark_block_journal (finality_status, block_number);

CREATE INDEX IF NOT EXISTS stark_block_journal_parent_idx
    ON stark_block_journal (lane, parent_hash);

CREATE TABLE IF NOT EXISTS stark_reconciliation_log (
    reconciliation_id BIGSERIAL PRIMARY KEY,
    lane TEXT NOT NULL,
    from_block_number NUMERIC(78, 0) NOT NULL,
    to_block_number NUMERIC(78, 0) NOT NULL,
    anchor_block_number NUMERIC(78, 0),
    expected_parent_hash TEXT,
    observed_parent_hash TEXT,
    expected_old_root TEXT,
    observed_old_root TEXT,
    expected_new_root TEXT,
    observed_new_root TEXT,
    status TEXT NOT NULL DEFAULT 'DETECTED',
    reason TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (lane IN ('PRE_CONFIRMED', 'ACCEPTED_ON_L2', 'ACCEPTED_ON_L1')),
    CHECK (from_block_number >= 0),
    CHECK (to_block_number >= 0),
    CHECK (anchor_block_number IS NULL OR anchor_block_number >= 0),
    CHECK (to_block_number >= from_block_number),
    CHECK (status IN ('DETECTED', 'REPLAYING', 'RESOLVED', 'FAILED'))
);

CREATE INDEX IF NOT EXISTS stark_reconciliation_log_lane_idx
    ON stark_reconciliation_log (lane, status, from_block_number, to_block_number);

COMMIT;
