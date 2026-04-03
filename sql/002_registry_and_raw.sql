BEGIN;

CREATE TABLE IF NOT EXISTS stark_contract_registry (
    contract_address TEXT NOT NULL,
    class_hash TEXT,
    protocol TEXT NOT NULL,
    role TEXT NOT NULL,
    decoder TEXT NOT NULL,
    abi_version TEXT,
    valid_from_block NUMERIC(78, 0),
    valid_to_block NUMERIC(78, 0),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (contract_address, class_hash),
    CHECK (valid_from_block IS NULL OR valid_from_block >= 0),
    CHECK (valid_to_block IS NULL OR valid_to_block >= 0),
    CHECK (valid_to_block IS NULL OR valid_from_block IS NULL OR valid_to_block >= valid_from_block)
);

CREATE INDEX IF NOT EXISTS stark_contract_registry_lookup_idx
    ON stark_contract_registry (contract_address, is_active, valid_from_block, valid_to_block);

CREATE INDEX IF NOT EXISTS stark_contract_registry_class_hash_idx
    ON stark_contract_registry (class_hash)
    WHERE class_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS stark_tx_raw (
    lane TEXT NOT NULL,
    block_number NUMERIC(78, 0) NOT NULL,
    block_hash TEXT NOT NULL,
    transaction_index NUMERIC(78, 0) NOT NULL,
    transaction_hash TEXT NOT NULL,
    tx_type TEXT NOT NULL,
    finality_status TEXT NOT NULL,
    execution_status TEXT NOT NULL,
    sender_address TEXT,
    contract_address TEXT,
    l1_sender_address TEXT,
    nonce TEXT,
    actual_fee_amount NUMERIC(78, 0),
    actual_fee_unit TEXT,
    events_count NUMERIC(78, 0) NOT NULL DEFAULT 0,
    messages_sent_count NUMERIC(78, 0) NOT NULL DEFAULT 0,
    revert_reason TEXT,
    normalized_status TEXT NOT NULL DEFAULT 'PENDING',
    decode_error TEXT,
    calldata JSONB NOT NULL DEFAULT '[]'::jsonb,
    raw_transaction JSONB NOT NULL,
    raw_receipt JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    PRIMARY KEY (lane, block_number, transaction_hash),
    CHECK (lane IN ('PRE_CONFIRMED', 'ACCEPTED_ON_L2', 'ACCEPTED_ON_L1')),
    CHECK (block_number >= 0),
    CHECK (transaction_index >= 0),
    CHECK (events_count >= 0),
    CHECK (messages_sent_count >= 0),
    CHECK (normalized_status IN ('PENDING', 'PROCESSED', 'SKIPPED_REVERTED', 'FAILED'))
);

CREATE INDEX IF NOT EXISTS stark_tx_raw_block_idx
    ON stark_tx_raw (lane, block_number, transaction_index);

CREATE INDEX IF NOT EXISTS stark_tx_raw_hash_idx
    ON stark_tx_raw (transaction_hash);

CREATE TABLE IF NOT EXISTS stark_event_raw (
    lane TEXT NOT NULL,
    block_number NUMERIC(78, 0) NOT NULL,
    block_hash TEXT NOT NULL,
    transaction_hash TEXT NOT NULL,
    transaction_index NUMERIC(78, 0) NOT NULL,
    receipt_event_index NUMERIC(78, 0) NOT NULL,
    finality_status TEXT NOT NULL,
    transaction_execution_status TEXT NOT NULL,
    from_address TEXT NOT NULL,
    selector TEXT NOT NULL,
    resolved_class_hash TEXT,
    normalized_status TEXT NOT NULL DEFAULT 'PENDING',
    decode_error TEXT,
    keys JSONB NOT NULL,
    data JSONB NOT NULL,
    raw_event JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    PRIMARY KEY (lane, block_number, transaction_hash, receipt_event_index),
    CHECK (lane IN ('PRE_CONFIRMED', 'ACCEPTED_ON_L2', 'ACCEPTED_ON_L1')),
    CHECK (block_number >= 0),
    CHECK (transaction_index >= 0),
    CHECK (receipt_event_index >= 0),
    CHECK (normalized_status IN ('PENDING', 'PROCESSED', 'SKIPPED_REVERTED', 'FAILED', 'UNKNOWN'))
);

CREATE INDEX IF NOT EXISTS stark_event_raw_tx_idx
    ON stark_event_raw (lane, block_number, transaction_hash, receipt_event_index);

CREATE INDEX IF NOT EXISTS stark_event_raw_selector_idx
    ON stark_event_raw (selector, from_address);

CREATE INDEX IF NOT EXISTS stark_event_raw_class_hash_idx
    ON stark_event_raw (resolved_class_hash)
    WHERE resolved_class_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS stark_message_l2_to_l1 (
    lane TEXT NOT NULL,
    block_number NUMERIC(78, 0) NOT NULL,
    block_hash TEXT NOT NULL,
    transaction_hash TEXT NOT NULL,
    transaction_index NUMERIC(78, 0) NOT NULL,
    message_index NUMERIC(78, 0) NOT NULL,
    from_address TEXT NOT NULL,
    to_address TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '[]'::jsonb,
    raw_message JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (lane, block_number, transaction_hash, message_index),
    CHECK (lane IN ('PRE_CONFIRMED', 'ACCEPTED_ON_L2', 'ACCEPTED_ON_L1')),
    CHECK (block_number >= 0),
    CHECK (transaction_index >= 0),
    CHECK (message_index >= 0)
);

CREATE INDEX IF NOT EXISTS stark_message_l2_to_l1_tx_idx
    ON stark_message_l2_to_l1 (lane, block_number, transaction_hash, message_index);

CREATE TABLE IF NOT EXISTS stark_unknown_event_audit (
    audit_id BIGSERIAL PRIMARY KEY,
    lane TEXT NOT NULL,
    block_number NUMERIC(78, 0) NOT NULL,
    block_hash TEXT NOT NULL,
    transaction_hash TEXT NOT NULL,
    transaction_index NUMERIC(78, 0) NOT NULL,
    source_event_index NUMERIC(78, 0),
    emitter_address TEXT,
    selector TEXT,
    reason TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (lane IN ('PRE_CONFIRMED', 'ACCEPTED_ON_L2', 'ACCEPTED_ON_L1')),
    CHECK (block_number >= 0),
    CHECK (transaction_index >= 0),
    CHECK (source_event_index IS NULL OR source_event_index >= 0)
);

CREATE INDEX IF NOT EXISTS stark_unknown_event_audit_block_idx
    ON stark_unknown_event_audit (lane, block_number, transaction_hash);

CREATE TABLE IF NOT EXISTS stark_action_norm (
    action_key TEXT PRIMARY KEY,
    lane TEXT NOT NULL,
    block_number NUMERIC(78, 0) NOT NULL,
    block_hash TEXT NOT NULL,
    transaction_hash TEXT NOT NULL,
    transaction_index NUMERIC(78, 0) NOT NULL,
    source_event_index NUMERIC(78, 0),
    protocol TEXT NOT NULL,
    action_type TEXT NOT NULL,
    emitter_address TEXT,
    account_address TEXT,
    pool_id TEXT,
    token0_address TEXT,
    token1_address TEXT,
    token_address TEXT,
    amount0 NUMERIC(78, 0),
    amount1 NUMERIC(78, 0),
    amount NUMERIC(78, 0),
    router_protocol TEXT,
    execution_protocol TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (lane IN ('PRE_CONFIRMED', 'ACCEPTED_ON_L2', 'ACCEPTED_ON_L1')),
    CHECK (block_number >= 0),
    CHECK (transaction_index >= 0),
    CHECK (source_event_index IS NULL OR source_event_index >= 0)
);

CREATE INDEX IF NOT EXISTS stark_action_norm_block_idx
    ON stark_action_norm (lane, block_number, transaction_index, source_event_index);

CREATE INDEX IF NOT EXISTS stark_action_norm_protocol_idx
    ON stark_action_norm (protocol, action_type);

CREATE TABLE IF NOT EXISTS stark_transfers (
    transfer_key TEXT PRIMARY KEY,
    lane TEXT NOT NULL,
    block_number NUMERIC(78, 0) NOT NULL,
    block_hash TEXT NOT NULL,
    transaction_hash TEXT NOT NULL,
    transaction_index NUMERIC(78, 0) NOT NULL,
    source_event_index NUMERIC(78, 0) NOT NULL,
    token_address TEXT NOT NULL,
    from_address TEXT NOT NULL,
    to_address TEXT NOT NULL,
    amount NUMERIC(78, 0) NOT NULL,
    protocol TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (lane IN ('PRE_CONFIRMED', 'ACCEPTED_ON_L2', 'ACCEPTED_ON_L1')),
    CHECK (block_number >= 0),
    CHECK (transaction_index >= 0),
    CHECK (source_event_index >= 0)
);

CREATE INDEX IF NOT EXISTS stark_transfers_block_idx
    ON stark_transfers (lane, block_number, transaction_index, source_event_index);

CREATE INDEX IF NOT EXISTS stark_transfers_token_idx
    ON stark_transfers (token_address, block_number);

CREATE INDEX IF NOT EXISTS stark_transfers_address_idx
    ON stark_transfers (from_address, to_address);

CREATE TABLE IF NOT EXISTS stark_bridge_activities (
    bridge_key TEXT PRIMARY KEY,
    lane TEXT NOT NULL,
    block_number NUMERIC(78, 0) NOT NULL,
    block_hash TEXT NOT NULL,
    transaction_hash TEXT NOT NULL,
    transaction_index NUMERIC(78, 0) NOT NULL,
    source_event_index NUMERIC(78, 0),
    direction TEXT NOT NULL,
    l1_sender TEXT,
    l1_recipient TEXT,
    l2_contract_address TEXT,
    l2_wallet_address TEXT,
    token_address TEXT,
    amount NUMERIC(78, 0),
    message_to_address TEXT,
    payload JSONB NOT NULL DEFAULT '[]'::jsonb,
    classification TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (lane IN ('PRE_CONFIRMED', 'ACCEPTED_ON_L2', 'ACCEPTED_ON_L1')),
    CHECK (block_number >= 0),
    CHECK (transaction_index >= 0),
    CHECK (source_event_index IS NULL OR source_event_index >= 0),
    CHECK (direction IN ('bridge_in', 'bridge_out'))
);

CREATE INDEX IF NOT EXISTS stark_bridge_activities_block_idx
    ON stark_bridge_activities (lane, block_number, transaction_index, source_event_index);

CREATE INDEX IF NOT EXISTS stark_bridge_activities_direction_idx
    ON stark_bridge_activities (direction, classification);

COMMIT;
