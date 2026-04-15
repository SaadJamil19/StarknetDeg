BEGIN;

CREATE TABLE IF NOT EXISTS eth_block_journal (
    block_number BIGINT NOT NULL,
    block_hash TEXT NOT NULL,
    parent_hash TEXT NOT NULL,
    block_timestamp TIMESTAMPTZ NOT NULL,
    transaction_count INTEGER NOT NULL DEFAULT 0,
    gas_used NUMERIC(78, 0),
    base_fee_per_gas NUMERIC(78, 0),
    is_orphaned BOOLEAN NOT NULL DEFAULT FALSE,
    raw_block JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (block_number, block_hash),
    CHECK (block_number >= 0),
    CHECK (transaction_count >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS eth_block_journal_active_idx
    ON eth_block_journal (block_number)
    WHERE is_orphaned = FALSE;

CREATE INDEX IF NOT EXISTS eth_block_journal_ts_idx
    ON eth_block_journal (block_timestamp DESC);

CREATE TABLE IF NOT EXISTS eth_tx_raw (
    transaction_hash TEXT NOT NULL,
    block_number BIGINT NOT NULL,
    block_hash TEXT NOT NULL,
    transaction_index INTEGER NOT NULL,
    from_address TEXT,
    to_address TEXT,
    tx_type TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING',
    execution_status TEXT,
    gas_used NUMERIC(78, 0),
    effective_gas_price NUMERIC(78, 0),
    actual_fee_eth NUMERIC(78, 0),
    log_count INTEGER NOT NULL DEFAULT 0,
    raw_transaction JSONB NOT NULL,
    raw_receipt JSONB NOT NULL,
    processed_at TIMESTAMPTZ,
    decode_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (transaction_hash, block_number),
    CHECK (block_number >= 0),
    CHECK (transaction_index >= 0),
    CHECK (log_count >= 0),
    CHECK (status IN ('PENDING', 'PROCESSED', 'FAILED')),
    CHECK (execution_status IN ('success', 'reverted') OR execution_status IS NULL)
);

CREATE INDEX IF NOT EXISTS eth_tx_raw_block_idx
    ON eth_tx_raw (block_number, transaction_index);

CREATE INDEX IF NOT EXISTS eth_tx_raw_status_idx
    ON eth_tx_raw (status)
    WHERE status <> 'PROCESSED';

CREATE INDEX IF NOT EXISTS eth_tx_raw_from_idx
    ON eth_tx_raw (from_address);

CREATE TABLE IF NOT EXISTS eth_event_raw (
    block_number BIGINT NOT NULL,
    transaction_hash TEXT NOT NULL,
    log_index INTEGER NOT NULL,
    block_hash TEXT NOT NULL,
    block_timestamp TIMESTAMPTZ NOT NULL,
    transaction_index INTEGER NOT NULL,
    emitter_address TEXT NOT NULL,
    topic0 TEXT NOT NULL,
    topic1 TEXT,
    topic2 TEXT,
    topic3 TEXT,
    data TEXT NOT NULL,
    event_type TEXT,
    normalized_status TEXT NOT NULL DEFAULT 'PENDING',
    decode_error TEXT,
    raw_log JSONB NOT NULL,
    processed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (block_number, transaction_hash, log_index),
    CHECK (block_number >= 0),
    CHECK (transaction_index >= 0),
    CHECK (log_index >= 0),
    CHECK (normalized_status IN ('PENDING', 'PROCESSED', 'FAILED', 'UNKNOWN_EVENT'))
);

CREATE INDEX IF NOT EXISTS eth_event_raw_block_idx
    ON eth_event_raw (block_number, transaction_index, log_index);

CREATE INDEX IF NOT EXISTS eth_event_raw_pending_idx
    ON eth_event_raw (normalized_status)
    WHERE normalized_status = 'PENDING';

CREATE INDEX IF NOT EXISTS eth_event_raw_emitter_idx
    ON eth_event_raw (emitter_address, topic0);

CREATE TABLE IF NOT EXISTS eth_starkgate_events (
    event_key TEXT PRIMARY KEY,
    eth_block_number BIGINT NOT NULL,
    eth_block_hash TEXT NOT NULL,
    eth_block_timestamp TIMESTAMPTZ NOT NULL,
    eth_transaction_hash TEXT NOT NULL,
    eth_log_index INTEGER NOT NULL,
    emitter_contract TEXT NOT NULL,
    event_type TEXT NOT NULL,
    l1_sender TEXT,
    l1_recipient TEXT,
    l2_recipient TEXT,
    l2_sender TEXT,
    l1_token_address TEXT,
    l2_token_address TEXT,
    is_native_eth BOOLEAN NOT NULL DEFAULT FALSE,
    token_symbol TEXT,
    amount NUMERIC(78, 0) NOT NULL,
    amount_human NUMERIC(78, 30),
    amount_usd NUMERIC(78, 30),
    nonce NUMERIC(78, 0),
    stark_tx_hash TEXT,
    stark_block_number NUMERIC(78, 0),
    stark_bridge_key TEXT,
    matched_at TIMESTAMPTZ,
    match_status TEXT NOT NULL DEFAULT 'PENDING',
    match_strategy TEXT,
    settlement_seconds INTEGER,
    settlement_blocks_l1 INTEGER,
    settlement_blocks_l2 NUMERIC(78, 0),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (event_type IN ('deposit_initiated', 'withdrawal_completed', 'deposit_cancelled', 'deposit_reclaimed')),
    CHECK (match_status IN ('PENDING', 'MATCHED', 'UNMATCHED', 'CANCELLED')),
    CHECK (eth_block_number >= 0),
    CHECK (eth_log_index >= 0),
    CHECK (amount >= 0),
    CHECK (nonce IS NULL OR nonce >= 0),
    CHECK (stark_block_number IS NULL OR stark_block_number >= 0),
    CHECK (settlement_blocks_l2 IS NULL OR settlement_blocks_l2 >= 0)
);

CREATE INDEX IF NOT EXISTS eth_starkgate_events_block_idx
    ON eth_starkgate_events (eth_block_number);

CREATE INDEX IF NOT EXISTS eth_starkgate_events_l1_sender_idx
    ON eth_starkgate_events (l1_sender, event_type);

CREATE INDEX IF NOT EXISTS eth_starkgate_events_l2_recipient_idx
    ON eth_starkgate_events (l2_recipient);

CREATE INDEX IF NOT EXISTS eth_starkgate_events_match_idx
    ON eth_starkgate_events (match_status, event_type);

CREATE INDEX IF NOT EXISTS eth_starkgate_events_nonce_idx
    ON eth_starkgate_events (nonce)
    WHERE nonce IS NOT NULL;

CREATE INDEX IF NOT EXISTS eth_starkgate_events_token_idx
    ON eth_starkgate_events (l2_token_address, eth_block_number);

CREATE INDEX IF NOT EXISTS eth_starkgate_events_tx_hash_idx
    ON eth_starkgate_events (eth_transaction_hash);

CREATE TABLE IF NOT EXISTS eth_index_state (
    indexer_key TEXT PRIMARY KEY,
    last_processed_block_number BIGINT,
    last_processed_block_hash TEXT,
    last_processed_timestamp TIMESTAMPTZ,
    last_finalized_block_number BIGINT,
    last_error TEXT,
    last_committed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (last_processed_block_number IS NULL OR last_processed_block_number >= 0),
    CHECK (last_finalized_block_number IS NULL OR last_finalized_block_number >= 0)
);

INSERT INTO eth_index_state (indexer_key)
VALUES ('starkgate_l1')
ON CONFLICT (indexer_key) DO NOTHING;

COMMIT;
