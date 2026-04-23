-- StarknetDeg consolidated schema
-- Generated from sql/*.sql migrations in numeric order

-- ==================================================
-- Source: sql/001_foundation.sql
-- ==================================================
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

-- ==================================================
-- Source: sql/002_registry_and_raw.sql
-- ==================================================
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

-- ==================================================
-- Source: sql/003_trading.sql
-- ==================================================
BEGIN;

CREATE TABLE IF NOT EXISTS stark_trades (
    trade_key TEXT PRIMARY KEY,
    lane TEXT NOT NULL,
    block_number NUMERIC(78, 0) NOT NULL,
    block_hash TEXT NOT NULL,
    block_timestamp TIMESTAMPTZ NOT NULL,
    transaction_hash TEXT NOT NULL,
    transaction_index NUMERIC(78, 0) NOT NULL,
    source_event_index NUMERIC(78, 0) NOT NULL,
    protocol TEXT NOT NULL,
    router_protocol TEXT,
    execution_protocol TEXT NOT NULL,
    pool_id TEXT NOT NULL,
    trader_address TEXT,
    token0_address TEXT NOT NULL,
    token1_address TEXT NOT NULL,
    token_in_address TEXT NOT NULL,
    token_out_address TEXT NOT NULL,
    amount0_delta NUMERIC(78, 0) NOT NULL,
    amount1_delta NUMERIC(78, 0) NOT NULL,
    volume_token0 NUMERIC(78, 0) NOT NULL,
    volume_token1 NUMERIC(78, 0) NOT NULL,
    amount_in NUMERIC(78, 0) NOT NULL,
    amount_out NUMERIC(78, 0) NOT NULL,
    price_raw_token1_per_token0 NUMERIC NOT NULL,
    price_raw_token0_per_token1 NUMERIC NOT NULL,
    price_token1_per_token0 NUMERIC NOT NULL,
    price_token0_per_token1 NUMERIC NOT NULL,
    price_is_decimals_normalized BOOLEAN NOT NULL DEFAULT FALSE,
    price_source TEXT NOT NULL,
    notional_usd NUMERIC,
    bucket_1m TIMESTAMPTZ NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (transaction_hash, source_event_index),
    CHECK (lane IN ('PRE_CONFIRMED', 'ACCEPTED_ON_L2', 'ACCEPTED_ON_L1')),
    CHECK (block_number >= 0),
    CHECK (transaction_index >= 0),
    CHECK (source_event_index >= 0),
    CHECK (volume_token0 >= 0),
    CHECK (volume_token1 >= 0),
    CHECK (amount_in >= 0),
    CHECK (amount_out >= 0)
);

CREATE INDEX IF NOT EXISTS stark_trades_block_idx
    ON stark_trades (lane, block_number, transaction_index, source_event_index);

CREATE INDEX IF NOT EXISTS stark_trades_pool_idx
    ON stark_trades (lane, pool_id, block_timestamp);

CREATE INDEX IF NOT EXISTS stark_trades_bucket_idx
    ON stark_trades (lane, bucket_1m, pool_id);

CREATE INDEX IF NOT EXISTS stark_trades_token_idx
    ON stark_trades (token_in_address, token_out_address, block_number);

CREATE TABLE IF NOT EXISTS stark_pool_state_history (
    pool_state_key TEXT PRIMARY KEY,
    lane TEXT NOT NULL,
    pool_id TEXT NOT NULL,
    protocol TEXT NOT NULL,
    token0_address TEXT NOT NULL,
    token1_address TEXT NOT NULL,
    block_number NUMERIC(78, 0) NOT NULL,
    block_hash TEXT NOT NULL,
    block_timestamp TIMESTAMPTZ NOT NULL,
    transaction_hash TEXT NOT NULL,
    transaction_index NUMERIC(78, 0) NOT NULL,
    source_event_index NUMERIC(78, 0) NOT NULL,
    reserve0 NUMERIC(78, 0),
    reserve1 NUMERIC(78, 0),
    liquidity NUMERIC(78, 0),
    sqrt_ratio NUMERIC(78, 0),
    price_token1_per_token0 NUMERIC,
    price_token0_per_token1 NUMERIC,
    price_is_decimals_normalized BOOLEAN NOT NULL DEFAULT FALSE,
    tvl_usd NUMERIC,
    snapshot_kind TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (lane, pool_id, transaction_hash, source_event_index),
    CHECK (lane IN ('PRE_CONFIRMED', 'ACCEPTED_ON_L2', 'ACCEPTED_ON_L1')),
    CHECK (block_number >= 0),
    CHECK (transaction_index >= 0),
    CHECK (source_event_index >= 0)
);

CREATE INDEX IF NOT EXISTS stark_pool_state_history_lineage_idx
    ON stark_pool_state_history (lane, block_number, transaction_index, source_event_index);

CREATE INDEX IF NOT EXISTS stark_pool_state_history_pool_idx
    ON stark_pool_state_history (lane, pool_id, block_timestamp DESC);

CREATE TABLE IF NOT EXISTS stark_pool_latest (
    lane TEXT NOT NULL,
    pool_id TEXT NOT NULL,
    protocol TEXT NOT NULL,
    token0_address TEXT NOT NULL,
    token1_address TEXT NOT NULL,
    block_number NUMERIC(78, 0) NOT NULL,
    block_hash TEXT NOT NULL,
    block_timestamp TIMESTAMPTZ NOT NULL,
    transaction_hash TEXT NOT NULL,
    transaction_index NUMERIC(78, 0) NOT NULL,
    source_event_index NUMERIC(78, 0) NOT NULL,
    reserve0 NUMERIC(78, 0),
    reserve1 NUMERIC(78, 0),
    liquidity NUMERIC(78, 0),
    sqrt_ratio NUMERIC(78, 0),
    price_token1_per_token0 NUMERIC,
    price_token0_per_token1 NUMERIC,
    price_is_decimals_normalized BOOLEAN NOT NULL DEFAULT FALSE,
    tvl_usd NUMERIC,
    snapshot_kind TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (lane, pool_id),
    CHECK (lane IN ('PRE_CONFIRMED', 'ACCEPTED_ON_L2', 'ACCEPTED_ON_L1')),
    CHECK (block_number >= 0),
    CHECK (transaction_index >= 0),
    CHECK (source_event_index >= 0)
);

CREATE INDEX IF NOT EXISTS stark_pool_latest_lineage_idx
    ON stark_pool_latest (lane, block_number, transaction_index, source_event_index);

CREATE TABLE IF NOT EXISTS stark_prices (
    lane TEXT NOT NULL,
    token_address TEXT NOT NULL,
    block_number NUMERIC(78, 0) NOT NULL,
    block_hash TEXT NOT NULL,
    block_timestamp TIMESTAMPTZ NOT NULL,
    transaction_hash TEXT NOT NULL,
    transaction_index NUMERIC(78, 0) NOT NULL,
    source_event_index NUMERIC(78, 0) NOT NULL,
    source_pool_id TEXT,
    quote_token_address TEXT,
    price_quote NUMERIC,
    price_usd NUMERIC NOT NULL,
    price_source TEXT NOT NULL,
    price_is_stale BOOLEAN NOT NULL DEFAULT FALSE,
    price_updated_at_block NUMERIC(78, 0) NOT NULL DEFAULT 0,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (lane, token_address),
    CHECK (lane IN ('PRE_CONFIRMED', 'ACCEPTED_ON_L2', 'ACCEPTED_ON_L1')),
    CHECK (block_number >= 0),
    CHECK (transaction_index >= 0),
    CHECK (source_event_index >= 0),
    CHECK (price_updated_at_block >= 0)
);

ALTER TABLE stark_prices
    ADD COLUMN IF NOT EXISTS price_is_stale BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE stark_prices
    ADD COLUMN IF NOT EXISTS price_updated_at_block NUMERIC(78, 0) NOT NULL DEFAULT 0;

UPDATE stark_prices
   SET price_updated_at_block = block_number
 WHERE price_updated_at_block = 0;

CREATE INDEX IF NOT EXISTS stark_prices_lineage_idx
    ON stark_prices (lane, block_number, transaction_index, source_event_index);

CREATE TABLE IF NOT EXISTS stark_price_ticks (
    tick_key TEXT PRIMARY KEY,
    lane TEXT NOT NULL,
    block_number NUMERIC(78, 0) NOT NULL,
    block_hash TEXT NOT NULL,
    block_timestamp TIMESTAMPTZ NOT NULL,
    transaction_hash TEXT NOT NULL,
    transaction_index NUMERIC(78, 0) NOT NULL,
    source_event_index NUMERIC(78, 0) NOT NULL,
    token_address TEXT NOT NULL,
    source_pool_id TEXT,
    quote_token_address TEXT,
    price_quote NUMERIC,
    price_usd NUMERIC NOT NULL,
    price_source TEXT NOT NULL,
    price_is_stale BOOLEAN NOT NULL DEFAULT FALSE,
    price_updated_at_block NUMERIC(78, 0) NOT NULL DEFAULT 0,
    bucket_1m TIMESTAMPTZ NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (lane, token_address, transaction_hash, source_event_index, source_pool_id),
    CHECK (lane IN ('PRE_CONFIRMED', 'ACCEPTED_ON_L2', 'ACCEPTED_ON_L1')),
    CHECK (block_number >= 0),
    CHECK (transaction_index >= 0),
    CHECK (source_event_index >= 0),
    CHECK (price_updated_at_block >= 0)
);

ALTER TABLE stark_price_ticks
    ADD COLUMN IF NOT EXISTS price_is_stale BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE stark_price_ticks
    ADD COLUMN IF NOT EXISTS price_updated_at_block NUMERIC(78, 0) NOT NULL DEFAULT 0;

UPDATE stark_price_ticks
   SET price_updated_at_block = block_number
 WHERE price_updated_at_block = 0;

CREATE INDEX IF NOT EXISTS stark_price_ticks_token_idx
    ON stark_price_ticks (lane, token_address, block_number, transaction_index, source_event_index);

CREATE INDEX IF NOT EXISTS stark_price_ticks_pool_idx
    ON stark_price_ticks (lane, source_pool_id, block_timestamp);

CREATE TABLE IF NOT EXISTS stark_ohlcv_1m (
    candle_key TEXT PRIMARY KEY,
    lane TEXT NOT NULL,
    pool_id TEXT NOT NULL,
    protocol TEXT NOT NULL,
    token0_address TEXT NOT NULL,
    token1_address TEXT NOT NULL,
    bucket_start TIMESTAMPTZ NOT NULL,
    block_number NUMERIC(78, 0) NOT NULL,
    block_hash TEXT NOT NULL,
    transaction_hash TEXT,
    transaction_index NUMERIC(78, 0),
    source_event_index NUMERIC(78, 0),
    open NUMERIC NOT NULL,
    high NUMERIC NOT NULL,
    low NUMERIC NOT NULL,
    close NUMERIC NOT NULL,
    price_is_decimals_normalized BOOLEAN NOT NULL DEFAULT FALSE,
    volume0 NUMERIC(78, 0) NOT NULL DEFAULT 0,
    volume1 NUMERIC(78, 0) NOT NULL DEFAULT 0,
    volume_usd NUMERIC NOT NULL DEFAULT 0,
    trade_count NUMERIC(78, 0) NOT NULL DEFAULT 0,
    seeded_from_previous_close BOOLEAN NOT NULL DEFAULT FALSE,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (lane, pool_id, bucket_start),
    CHECK (lane IN ('PRE_CONFIRMED', 'ACCEPTED_ON_L2', 'ACCEPTED_ON_L1')),
    CHECK (block_number >= 0),
    CHECK (transaction_index IS NULL OR transaction_index >= 0),
    CHECK (source_event_index IS NULL OR source_event_index >= 0),
    CHECK (volume0 >= 0),
    CHECK (volume1 >= 0),
    CHECK (volume_usd >= 0),
    CHECK (trade_count >= 0)
);

CREATE INDEX IF NOT EXISTS stark_ohlcv_1m_pool_idx
    ON stark_ohlcv_1m (lane, pool_id, bucket_start DESC);

CREATE INDEX IF NOT EXISTS stark_ohlcv_1m_block_idx
    ON stark_ohlcv_1m (lane, block_number, pool_id);

DO $$
BEGIN
    IF to_regclass('public.stark_pool_state') IS NOT NULL THEN
        INSERT INTO stark_pool_latest (
            lane,
            pool_id,
            protocol,
            token0_address,
            token1_address,
            block_number,
            block_hash,
            block_timestamp,
            transaction_hash,
            transaction_index,
            source_event_index,
            reserve0,
            reserve1,
            liquidity,
            sqrt_ratio,
            price_token1_per_token0,
            price_token0_per_token1,
            price_is_decimals_normalized,
            tvl_usd,
            snapshot_kind,
            metadata,
            created_at,
            updated_at
        )
        SELECT
            lane,
            pool_id,
            protocol,
            token0_address,
            token1_address,
            block_number,
            block_hash,
            block_timestamp,
            transaction_hash,
            transaction_index,
            source_event_index,
            reserve0,
            reserve1,
            liquidity,
            sqrt_ratio,
            price_token1_per_token0,
            price_token0_per_token1,
            price_is_decimals_normalized,
            tvl_usd,
            snapshot_kind,
            metadata,
            created_at,
            updated_at
        FROM stark_pool_state
        ON CONFLICT (lane, pool_id) DO NOTHING;

        INSERT INTO stark_pool_state_history (
            pool_state_key,
            lane,
            pool_id,
            protocol,
            token0_address,
            token1_address,
            block_number,
            block_hash,
            block_timestamp,
            transaction_hash,
            transaction_index,
            source_event_index,
            reserve0,
            reserve1,
            liquidity,
            sqrt_ratio,
            price_token1_per_token0,
            price_token0_per_token1,
            price_is_decimals_normalized,
            tvl_usd,
            snapshot_kind,
            metadata,
            created_at,
            updated_at
        )
        SELECT
            lane || ':' || pool_id || ':' || transaction_hash || ':' || source_event_index,
            lane,
            pool_id,
            protocol,
            token0_address,
            token1_address,
            block_number,
            block_hash,
            block_timestamp,
            transaction_hash,
            transaction_index,
            source_event_index,
            reserve0,
            reserve1,
            liquidity,
            sqrt_ratio,
            price_token1_per_token0,
            price_token0_per_token1,
            price_is_decimals_normalized,
            tvl_usd,
            snapshot_kind,
            metadata,
            created_at,
            updated_at
        FROM stark_pool_state
        ON CONFLICT (pool_state_key) DO NOTHING;
    END IF;
END $$;

COMMIT;

-- ==================================================
-- Source: sql/004_metadata_and_security.sql
-- ==================================================
BEGIN;

CREATE TABLE IF NOT EXISTS stark_block_state_updates (
    lane TEXT NOT NULL,
    block_number NUMERIC(78, 0) NOT NULL,
    block_hash TEXT NOT NULL,
    old_root TEXT,
    new_root TEXT,
    state_diff_length NUMERIC(78, 0) NOT NULL DEFAULT 0,
    declared_classes JSONB NOT NULL DEFAULT '[]'::jsonb,
    deployed_contracts JSONB NOT NULL DEFAULT '[]'::jsonb,
    deprecated_declared_classes JSONB NOT NULL DEFAULT '[]'::jsonb,
    nonce_updates JSONB NOT NULL DEFAULT '[]'::jsonb,
    replaced_classes JSONB NOT NULL DEFAULT '[]'::jsonb,
    storage_diffs JSONB NOT NULL DEFAULT '{}'::jsonb,
    raw_state_update JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (lane, block_number, block_hash),
    CHECK (lane IN ('PRE_CONFIRMED', 'ACCEPTED_ON_L2', 'ACCEPTED_ON_L1')),
    CHECK (block_number >= 0),
    CHECK (state_diff_length >= 0)
);

CREATE INDEX IF NOT EXISTS stark_block_state_updates_block_idx
    ON stark_block_state_updates (lane, block_number);

CREATE INDEX IF NOT EXISTS stark_block_state_updates_hash_idx
    ON stark_block_state_updates (block_hash);

INSERT INTO stark_block_state_updates (
    lane,
    block_number,
    block_hash,
    old_root,
    new_root,
    state_diff_length,
    declared_classes,
    deployed_contracts,
    deprecated_declared_classes,
    nonce_updates,
    replaced_classes,
    storage_diffs,
    raw_state_update,
    created_at,
    updated_at
)
SELECT
    journal.lane,
    journal.block_number,
    journal.block_hash,
    journal.old_root,
    journal.new_root,
    COALESCE(journal.state_diff_length, 0),
    COALESCE(journal.raw_state_update #> '{state_diff,declared_classes}', '[]'::jsonb),
    COALESCE(journal.raw_state_update #> '{state_diff,deployed_contracts}', '[]'::jsonb),
    COALESCE(journal.raw_state_update #> '{state_diff,deprecated_declared_classes}', '[]'::jsonb),
    COALESCE(journal.raw_state_update #> '{state_diff,nonces}', '[]'::jsonb),
    COALESCE(journal.raw_state_update #> '{state_diff,replaced_classes}', '[]'::jsonb),
    COALESCE(journal.raw_state_update #> '{state_diff,storage_diffs}', '{}'::jsonb),
    journal.raw_state_update,
    journal.created_at,
    journal.updated_at
FROM stark_block_journal AS journal
ON CONFLICT (lane, block_number, block_hash) DO NOTHING;

CREATE TABLE IF NOT EXISTS stark_token_metadata (
    token_address TEXT PRIMARY KEY,
    name TEXT,
    symbol TEXT,
    decimals NUMERIC(78, 0),
    total_supply NUMERIC(78, 0),
    is_verified BOOLEAN NOT NULL DEFAULT FALSE,
    last_refreshed_block NUMERIC(78, 0),
    last_refreshed_at TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (decimals IS NULL OR decimals >= 0),
    CHECK (total_supply IS NULL OR total_supply >= 0),
    CHECK (last_refreshed_block IS NULL OR last_refreshed_block >= 0)
);

CREATE INDEX IF NOT EXISTS stark_token_metadata_symbol_idx
    ON stark_token_metadata (symbol);

CREATE INDEX IF NOT EXISTS stark_token_metadata_verified_idx
    ON stark_token_metadata (is_verified, symbol);

CREATE TABLE IF NOT EXISTS stark_contract_security (
    contract_address TEXT PRIMARY KEY,
    is_upgradeable BOOLEAN NOT NULL DEFAULT FALSE,
    owner_address TEXT,
    class_hash TEXT,
    risk_label TEXT NOT NULL DEFAULT 'Unknown',
    security_flags JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_scanned_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS stark_contract_security_risk_idx
    ON stark_contract_security (risk_label, is_upgradeable);

ALTER TABLE stark_trades
    ADD COLUMN IF NOT EXISTS pending_enrichment BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE stark_trades
   SET pending_enrichment = TRUE
 WHERE pending_enrichment = FALSE
   AND price_is_decimals_normalized = FALSE;

CREATE INDEX IF NOT EXISTS stark_trades_pending_enrichment_idx
    ON stark_trades (pending_enrichment, lane, block_number)
    WHERE pending_enrichment = TRUE;

ALTER TABLE stark_ohlcv_1m
    ADD COLUMN IF NOT EXISTS pending_enrichment BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE stark_ohlcv_1m
   SET pending_enrichment = TRUE
 WHERE pending_enrichment = FALSE
   AND price_is_decimals_normalized = FALSE;

CREATE INDEX IF NOT EXISTS stark_ohlcv_1m_pending_enrichment_idx
    ON stark_ohlcv_1m (pending_enrichment, lane, pool_id, bucket_start)
    WHERE pending_enrichment = TRUE;

ALTER TABLE stark_contract_registry
    ADD COLUMN IF NOT EXISTS abi_json JSONB;

ALTER TABLE stark_contract_registry
    ADD COLUMN IF NOT EXISTS abi_refreshed_at TIMESTAMPTZ;

ALTER TABLE stark_contract_registry
    ADD COLUMN IF NOT EXISTS abi_refreshed_at_block NUMERIC(78, 0);

CREATE INDEX IF NOT EXISTS stark_contract_registry_active_idx
    ON stark_contract_registry (contract_address, is_active, valid_from_block, valid_to_block);

COMMIT;

-- ==================================================
-- Source: sql/006_analytics.sql
-- ==================================================
BEGIN;

CREATE TABLE IF NOT EXISTS stark_wallet_bridge_flows (
    lane TEXT NOT NULL,
    wallet_address TEXT NOT NULL,
    token_address TEXT NOT NULL,
    bridge_in_amount NUMERIC(78, 0) NOT NULL DEFAULT 0,
    bridge_out_amount NUMERIC(78, 0) NOT NULL DEFAULT 0,
    net_bridge_flow NUMERIC(78, 0) NOT NULL DEFAULT 0,
    bridge_inflow_usd NUMERIC,
    bridge_outflow_usd NUMERIC,
    net_bridge_flow_usd NUMERIC,
    bridge_in_count NUMERIC(78, 0) NOT NULL DEFAULT 0,
    bridge_out_count NUMERIC(78, 0) NOT NULL DEFAULT 0,
    unresolved_activity_count NUMERIC(78, 0) NOT NULL DEFAULT 0,
    price_source TEXT,
    price_is_stale BOOLEAN NOT NULL DEFAULT FALSE,
    price_updated_at_block NUMERIC(78, 0),
    last_bridge_block_number NUMERIC(78, 0),
    last_bridge_transaction_hash TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (lane, wallet_address, token_address),
    CHECK (lane IN ('PRE_CONFIRMED', 'ACCEPTED_ON_L2', 'ACCEPTED_ON_L1')),
    CHECK (bridge_in_amount >= 0),
    CHECK (bridge_out_amount >= 0),
    CHECK (bridge_in_count >= 0),
    CHECK (bridge_out_count >= 0),
    CHECK (unresolved_activity_count >= 0),
    CHECK (price_updated_at_block IS NULL OR price_updated_at_block >= 0),
    CHECK (last_bridge_block_number IS NULL OR last_bridge_block_number >= 0)
);

CREATE INDEX IF NOT EXISTS stark_wallet_bridge_flows_wallet_idx
    ON stark_wallet_bridge_flows (lane, wallet_address);

CREATE INDEX IF NOT EXISTS stark_wallet_bridge_flows_token_idx
    ON stark_wallet_bridge_flows (lane, token_address, net_bridge_flow DESC);

CREATE TABLE IF NOT EXISTS stark_wallet_pnl_events (
    pnl_event_key TEXT PRIMARY KEY,
    lane TEXT NOT NULL,
    wallet_address TEXT NOT NULL,
    token_address TEXT NOT NULL,
    trade_key TEXT NOT NULL,
    block_number NUMERIC(78, 0) NOT NULL,
    block_hash TEXT NOT NULL,
    block_timestamp TIMESTAMPTZ NOT NULL,
    transaction_hash TEXT NOT NULL,
    transaction_index NUMERIC(78, 0) NOT NULL,
    source_event_index NUMERIC(78, 0) NOT NULL,
    side TEXT NOT NULL,
    quantity NUMERIC(78, 0) NOT NULL,
    external_quantity NUMERIC(78, 0) NOT NULL DEFAULT 0,
    traded_quantity NUMERIC(78, 0) NOT NULL DEFAULT 0,
    gas_fee_amount NUMERIC(78, 0),
    gas_fee_token_address TEXT,
    gas_fee_usd NUMERIC,
    proceeds_usd NUMERIC,
    cost_basis_usd NUMERIC,
    realized_pnl_usd NUMERIC,
    position_amount_after NUMERIC(78, 0) NOT NULL DEFAULT 0,
    remaining_cost_basis_usd NUMERIC,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (lane, trade_key, token_address, side),
    CHECK (lane IN ('PRE_CONFIRMED', 'ACCEPTED_ON_L2', 'ACCEPTED_ON_L1')),
    CHECK (block_number >= 0),
    CHECK (transaction_index >= 0),
    CHECK (source_event_index >= 0),
    CHECK (side IN ('buy', 'sell')),
    CHECK (quantity >= 0),
    CHECK (external_quantity >= 0),
    CHECK (traded_quantity >= 0),
    CHECK (position_amount_after >= 0),
    CHECK (external_quantity + traded_quantity <= quantity)
);

CREATE INDEX IF NOT EXISTS stark_wallet_pnl_events_wallet_idx
    ON stark_wallet_pnl_events (lane, wallet_address, block_number, transaction_index, source_event_index);

CREATE INDEX IF NOT EXISTS stark_wallet_pnl_events_token_idx
    ON stark_wallet_pnl_events (lane, token_address, block_number);

CREATE TABLE IF NOT EXISTS stark_wallet_positions (
    lane TEXT NOT NULL,
    wallet_address TEXT NOT NULL,
    token_address TEXT NOT NULL,
    traded_quantity NUMERIC(78, 0) NOT NULL DEFAULT 0,
    external_quantity NUMERIC(78, 0) NOT NULL DEFAULT 0,
    total_quantity NUMERIC(78, 0) NOT NULL DEFAULT 0,
    traded_cost_basis_usd NUMERIC NOT NULL DEFAULT 0,
    external_cost_basis_usd NUMERIC NOT NULL DEFAULT 0,
    average_traded_entry_price_usd NUMERIC,
    last_price_usd NUMERIC,
    realized_pnl_usd NUMERIC NOT NULL DEFAULT 0,
    unrealized_pnl_usd NUMERIC,
    trade_count NUMERIC(78, 0) NOT NULL DEFAULT 0,
    bridge_in_count NUMERIC(78, 0) NOT NULL DEFAULT 0,
    bridge_out_count NUMERIC(78, 0) NOT NULL DEFAULT 0,
    first_activity_block_number NUMERIC(78, 0),
    last_activity_block_number NUMERIC(78, 0),
    last_activity_timestamp TIMESTAMPTZ,
    pending_pricing BOOLEAN NOT NULL DEFAULT FALSE,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (lane, wallet_address, token_address),
    CHECK (lane IN ('PRE_CONFIRMED', 'ACCEPTED_ON_L2', 'ACCEPTED_ON_L1')),
    CHECK (traded_quantity >= 0),
    CHECK (external_quantity >= 0),
    CHECK (total_quantity >= 0),
    CHECK (trade_count >= 0),
    CHECK (bridge_in_count >= 0),
    CHECK (bridge_out_count >= 0),
    CHECK (first_activity_block_number IS NULL OR first_activity_block_number >= 0),
    CHECK (last_activity_block_number IS NULL OR last_activity_block_number >= 0)
);

CREATE INDEX IF NOT EXISTS stark_wallet_positions_wallet_idx
    ON stark_wallet_positions (lane, wallet_address, total_quantity DESC);

CREATE INDEX IF NOT EXISTS stark_wallet_positions_token_idx
    ON stark_wallet_positions (lane, token_address, total_quantity DESC);

CREATE TABLE IF NOT EXISTS stark_wallet_stats (
    lane TEXT NOT NULL,
    wallet_address TEXT NOT NULL,
    first_trade_block_number NUMERIC(78, 0),
    last_trade_block_number NUMERIC(78, 0),
    total_trades NUMERIC(78, 0) NOT NULL DEFAULT 0,
    total_volume_usd NUMERIC NOT NULL DEFAULT 0,
    total_gas_fees_usd NUMERIC NOT NULL DEFAULT 0,
    realized_pnl_usd NUMERIC NOT NULL DEFAULT 0,
    unrealized_pnl_usd NUMERIC NOT NULL DEFAULT 0,
    net_pnl_usd NUMERIC NOT NULL DEFAULT 0,
    bridge_inflow_usd NUMERIC NOT NULL DEFAULT 0,
    bridge_outflow_usd NUMERIC NOT NULL DEFAULT 0,
    net_bridge_flow_usd NUMERIC NOT NULL DEFAULT 0,
    bridge_activity_count NUMERIC(78, 0) NOT NULL DEFAULT 0,
    winning_trade_count NUMERIC(78, 0) NOT NULL DEFAULT 0,
    losing_trade_count NUMERIC(78, 0) NOT NULL DEFAULT 0,
    win_rate NUMERIC,
    best_trade_pnl_usd NUMERIC,
    best_trade_tx_hash TEXT,
    best_trade_token_address TEXT,
    best_trade_at_block NUMERIC(78, 0),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (lane, wallet_address),
    CHECK (lane IN ('PRE_CONFIRMED', 'ACCEPTED_ON_L2', 'ACCEPTED_ON_L1')),
    CHECK (first_trade_block_number IS NULL OR first_trade_block_number >= 0),
    CHECK (last_trade_block_number IS NULL OR last_trade_block_number >= 0),
    CHECK (best_trade_at_block IS NULL OR best_trade_at_block >= 0),
    CHECK (total_trades >= 0),
    CHECK (bridge_activity_count >= 0),
    CHECK (winning_trade_count >= 0),
    CHECK (losing_trade_count >= 0)
);

CREATE INDEX IF NOT EXISTS stark_wallet_stats_realized_idx
    ON stark_wallet_stats (lane, realized_pnl_usd DESC);

CREATE INDEX IF NOT EXISTS stark_wallet_stats_volume_idx
    ON stark_wallet_stats (lane, total_volume_usd DESC);

CREATE TABLE IF NOT EXISTS stark_holder_balance_deltas (
    delta_key TEXT PRIMARY KEY,
    lane TEXT NOT NULL,
    block_number NUMERIC(78, 0) NOT NULL,
    block_hash TEXT NOT NULL,
    transaction_hash TEXT NOT NULL,
    transaction_index NUMERIC(78, 0) NOT NULL,
    source_event_index NUMERIC(78, 0) NOT NULL,
    transfer_key TEXT NOT NULL,
    token_address TEXT NOT NULL,
    holder_address TEXT NOT NULL,
    delta_amount NUMERIC(78, 0) NOT NULL,
    balance_direction TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (lane, transfer_key, holder_address, balance_direction),
    CHECK (lane IN ('PRE_CONFIRMED', 'ACCEPTED_ON_L2', 'ACCEPTED_ON_L1')),
    CHECK (block_number >= 0),
    CHECK (transaction_index >= 0),
    CHECK (source_event_index >= 0),
    CHECK (balance_direction IN ('credit', 'debit'))
);

CREATE INDEX IF NOT EXISTS stark_holder_balance_deltas_block_idx
    ON stark_holder_balance_deltas (lane, block_number, transaction_index, source_event_index);

CREATE INDEX IF NOT EXISTS stark_holder_balance_deltas_holder_idx
    ON stark_holder_balance_deltas (lane, token_address, holder_address);

CREATE TABLE IF NOT EXISTS stark_holder_balances (
    lane TEXT NOT NULL,
    token_address TEXT NOT NULL,
    holder_address TEXT NOT NULL,
    balance NUMERIC(78, 0) NOT NULL DEFAULT 0,
    first_seen_block_number NUMERIC(78, 0),
    last_updated_block_number NUMERIC(78, 0),
    last_transaction_hash TEXT,
    last_transaction_index NUMERIC(78, 0),
    last_source_event_index NUMERIC(78, 0),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (lane, token_address, holder_address),
    CHECK (lane IN ('PRE_CONFIRMED', 'ACCEPTED_ON_L2', 'ACCEPTED_ON_L1')),
    CHECK (balance >= 0),
    CHECK (first_seen_block_number IS NULL OR first_seen_block_number >= 0),
    CHECK (last_updated_block_number IS NULL OR last_updated_block_number >= 0),
    CHECK (last_transaction_index IS NULL OR last_transaction_index >= 0),
    CHECK (last_source_event_index IS NULL OR last_source_event_index >= 0)
);

CREATE INDEX IF NOT EXISTS stark_holder_balances_holder_idx
    ON stark_holder_balances (lane, holder_address, balance DESC);

CREATE INDEX IF NOT EXISTS stark_holder_balances_token_idx
    ON stark_holder_balances (lane, token_address, balance DESC);

CREATE TABLE IF NOT EXISTS stark_token_concentration (
    lane TEXT NOT NULL,
    token_address TEXT NOT NULL,
    holder_address TEXT NOT NULL,
    block_number NUMERIC(78, 0) NOT NULL,
    balance NUMERIC(78, 0) NOT NULL,
    total_supply NUMERIC,
    balance_usd NUMERIC,
    concentration_ratio NUMERIC,
    concentration_bps NUMERIC,
    holder_rank NUMERIC(78, 0) NOT NULL,
    is_whale BOOLEAN NOT NULL DEFAULT FALSE,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (lane, token_address, holder_address),
    CHECK (lane IN ('PRE_CONFIRMED', 'ACCEPTED_ON_L2', 'ACCEPTED_ON_L1')),
    CHECK (block_number >= 0),
    CHECK (balance >= 0),
    CHECK (holder_rank >= 0)
);

CREATE INDEX IF NOT EXISTS stark_token_concentration_rank_idx
    ON stark_token_concentration (lane, token_address, holder_rank);

CREATE INDEX IF NOT EXISTS stark_token_concentration_whale_idx
    ON stark_token_concentration (lane, is_whale, concentration_bps DESC);

CREATE TABLE IF NOT EXISTS stark_leaderboards (
    lane TEXT NOT NULL,
    leaderboard_name TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_key TEXT NOT NULL,
    rank NUMERIC(78, 0) NOT NULL,
    metric_value NUMERIC NOT NULL,
    as_of_block_number NUMERIC(78, 0) NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (lane, leaderboard_name, entity_key),
    CHECK (lane IN ('PRE_CONFIRMED', 'ACCEPTED_ON_L2', 'ACCEPTED_ON_L1')),
    CHECK (rank >= 0),
    CHECK (as_of_block_number >= 0)
);

CREATE INDEX IF NOT EXISTS stark_leaderboards_rank_idx
    ON stark_leaderboards (lane, leaderboard_name, rank);

CREATE TABLE IF NOT EXISTS stark_whale_alert_candidates (
    alert_key TEXT PRIMARY KEY,
    lane TEXT NOT NULL,
    block_number NUMERIC(78, 0) NOT NULL,
    wallet_address TEXT,
    token_address TEXT,
    alert_type TEXT NOT NULL,
    severity TEXT NOT NULL,
    velocity_score NUMERIC,
    metric_amount NUMERIC,
    metric_usd NUMERIC,
    related_trade_key TEXT,
    related_bridge_key TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (lane IN ('PRE_CONFIRMED', 'ACCEPTED_ON_L2', 'ACCEPTED_ON_L1')),
    CHECK (block_number >= 0),
    CHECK (severity IN ('info', 'warning', 'critical'))
);

CREATE INDEX IF NOT EXISTS stark_whale_alert_candidates_lane_idx
    ON stark_whale_alert_candidates (lane, alert_type, block_number DESC);

ALTER TABLE stark_wallet_pnl_events
    ADD COLUMN IF NOT EXISTS gas_fee_amount NUMERIC(78, 0);

ALTER TABLE stark_wallet_pnl_events
    ADD COLUMN IF NOT EXISTS gas_fee_token_address TEXT;

ALTER TABLE stark_wallet_pnl_events
    ADD COLUMN IF NOT EXISTS gas_fee_usd NUMERIC;

ALTER TABLE stark_wallet_stats
    ADD COLUMN IF NOT EXISTS total_gas_fees_usd NUMERIC NOT NULL DEFAULT 0;

ALTER TABLE stark_whale_alert_candidates
    ADD COLUMN IF NOT EXISTS velocity_score NUMERIC;

COMMIT;

-- ==================================================
-- Source: sql/007_schema_enhancements.sql
-- ==================================================
BEGIN;

CREATE TABLE IF NOT EXISTS tokens (
    address TEXT PRIMARY KEY,
    symbol TEXT,
    name TEXT,
    decimals INTEGER,
    token_type TEXT NOT NULL DEFAULT 'ERC20',
    is_stable BOOLEAN NOT NULL DEFAULT FALSE,
    is_verified BOOLEAN NOT NULL DEFAULT FALSE,
    verified_at_block NUMERIC(78, 0),
    verification_source TEXT,
    coingecko_id TEXT,
    logo_url TEXT,
    deploy_tx_hash TEXT,
    deployed_at TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (decimals IS NULL OR decimals >= 0)
);

ALTER TABLE tokens
    ADD COLUMN IF NOT EXISTS verified_at_block NUMERIC(78, 0),
    ADD COLUMN IF NOT EXISTS verification_source TEXT;

CREATE INDEX IF NOT EXISTS tokens_symbol_idx
    ON tokens (symbol);

CREATE INDEX IF NOT EXISTS tokens_stable_verified_idx
    ON tokens (is_stable, is_verified, symbol);

CREATE INDEX IF NOT EXISTS tokens_verified_at_block_idx
    ON tokens (verified_at_block);

INSERT INTO tokens (address, symbol, name, decimals, is_stable, is_verified, verification_source, metadata)
VALUES
('0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7', 'ETH',  'Ether',          18, FALSE, TRUE, 'schema_seed', '{"seed":"schema_report"}'::jsonb),
('0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8', 'USDC', 'USD Coin',        6,  TRUE,  TRUE, 'schema_seed', '{"seed":"schema_report"}'::jsonb),
('0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8', 'USDT', 'Tether USD',      6,  TRUE,  TRUE, 'schema_seed', '{"seed":"schema_report"}'::jsonb),
('0x00da114221cb83fa859dbdb4c44beeaa0bb37c7537ad5ae66fe5e0efd20e6eb3', 'DAI',  'Dai Stablecoin',  18, TRUE,  TRUE, 'schema_seed', '{"seed":"schema_report"}'::jsonb),
('0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d', 'STRK', 'Starknet Token',  18, FALSE, TRUE, 'schema_seed', '{"seed":"schema_report"}'::jsonb),
('0x03fe2b97c1fd336e750087d68b9b867997fd64a2661ff3ca5a7c771641e8e7ac', 'WBTC', 'Wrapped Bitcoin',  8, FALSE, TRUE, 'schema_seed', '{"seed":"schema_report"}'::jsonb)
ON CONFLICT (address) DO UPDATE
SET
    symbol = COALESCE(EXCLUDED.symbol, tokens.symbol),
    name = COALESCE(EXCLUDED.name, tokens.name),
    decimals = COALESCE(EXCLUDED.decimals, tokens.decimals),
    is_stable = EXCLUDED.is_stable OR tokens.is_stable,
    is_verified = EXCLUDED.is_verified OR tokens.is_verified,
    verification_source = COALESCE(EXCLUDED.verification_source, tokens.verification_source),
    metadata = COALESCE(EXCLUDED.metadata, tokens.metadata),
    updated_at = NOW();

INSERT INTO tokens (
    address,
    symbol,
    name,
    decimals,
    token_type,
    is_stable,
    is_verified,
    verified_at_block,
    verification_source,
    metadata,
    created_at,
    updated_at
)
SELECT
    token_address,
    symbol,
    name,
    CASE WHEN decimals IS NULL THEN NULL ELSE decimals::INTEGER END,
    'ERC20',
    CASE WHEN UPPER(COALESCE(symbol, '')) IN ('USDC', 'USDT', 'DAI', 'CASH') THEN TRUE ELSE FALSE END,
    is_verified,
    CASE WHEN last_refreshed_block IS NULL THEN NULL ELSE last_refreshed_block::NUMERIC END,
    'stark_token_metadata',
    jsonb_build_object('source', 'stark_token_metadata', 'stark_token_metadata', metadata),
    created_at,
    updated_at
FROM stark_token_metadata
ON CONFLICT (address) DO UPDATE
SET
    symbol = COALESCE(EXCLUDED.symbol, tokens.symbol),
    name = COALESCE(EXCLUDED.name, tokens.name),
    decimals = COALESCE(EXCLUDED.decimals, tokens.decimals),
    is_stable = EXCLUDED.is_stable OR tokens.is_stable,
    is_verified = EXCLUDED.is_verified OR tokens.is_verified,
    verified_at_block = COALESCE(EXCLUDED.verified_at_block, tokens.verified_at_block),
    verification_source = COALESCE(EXCLUDED.verification_source, tokens.verification_source),
    metadata = tokens.metadata || EXCLUDED.metadata,
    updated_at = NOW();

ALTER TABLE stark_trades
    ADD COLUMN IF NOT EXISTS locker_address TEXT,
    ADD COLUMN IF NOT EXISTS liquidity_after NUMERIC(78, 0),
    ADD COLUMN IF NOT EXISTS sqrt_ratio_after NUMERIC(78, 0),
    ADD COLUMN IF NOT EXISTS tick_after NUMERIC(78, 0),
    ADD COLUMN IF NOT EXISTS tick_spacing NUMERIC(78, 0),
    ADD COLUMN IF NOT EXISTS fee_tier NUMERIC(78, 0),
    ADD COLUMN IF NOT EXISTS extension_address TEXT,
    ADD COLUMN IF NOT EXISTS is_multi_hop BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS hop_index NUMERIC(78, 0),
    ADD COLUMN IF NOT EXISTS total_hops NUMERIC(78, 0),
    ADD COLUMN IF NOT EXISTS route_group_key TEXT,
    ADD COLUMN IF NOT EXISTS price_raw_execution NUMERIC,
    ADD COLUMN IF NOT EXISTS price_deviation_pct NUMERIC,
    ADD COLUMN IF NOT EXISTS hops_from_stable NUMERIC(78, 0),
    ADD COLUMN IF NOT EXISTS is_aggregator_derived BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS stark_trades_route_group_idx
    ON stark_trades (lane, route_group_key, transaction_hash);

ALTER TABLE stark_price_ticks
    ADD COLUMN IF NOT EXISTS hops_from_stable NUMERIC(78, 0),
    ADD COLUMN IF NOT EXISTS low_confidence BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS is_aggregator_derived BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS sell_amount_raw NUMERIC(78, 0),
    ADD COLUMN IF NOT EXISTS buy_amount_raw NUMERIC(78, 0),
    ADD COLUMN IF NOT EXISTS price_raw_execution NUMERIC,
    ADD COLUMN IF NOT EXISTS price_deviation_pct NUMERIC;

ALTER TABLE stark_prices
    ADD COLUMN IF NOT EXISTS bucket_1m TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS hops_from_stable NUMERIC(78, 0),
    ADD COLUMN IF NOT EXISTS low_confidence BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS is_aggregator_derived BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS sell_amount_raw NUMERIC(78, 0),
    ADD COLUMN IF NOT EXISTS buy_amount_raw NUMERIC(78, 0),
    ADD COLUMN IF NOT EXISTS price_raw_execution NUMERIC,
    ADD COLUMN IF NOT EXISTS price_deviation_pct NUMERIC;

UPDATE stark_prices
   SET bucket_1m = date_trunc('minute', block_timestamp)
 WHERE bucket_1m IS NULL;

ALTER TABLE stark_pool_state_history
    ADD COLUMN IF NOT EXISTS tick_after NUMERIC(78, 0),
    ADD COLUMN IF NOT EXISTS tick_spacing NUMERIC(78, 0),
    ADD COLUMN IF NOT EXISTS fee_tier NUMERIC(78, 0),
    ADD COLUMN IF NOT EXISTS extension_address TEXT,
    ADD COLUMN IF NOT EXISTS locker_address TEXT,
    ADD COLUMN IF NOT EXISTS amount0_delta NUMERIC(78, 0),
    ADD COLUMN IF NOT EXISTS amount1_delta NUMERIC(78, 0);

ALTER TABLE stark_pool_latest
    ADD COLUMN IF NOT EXISTS tick_after NUMERIC(78, 0),
    ADD COLUMN IF NOT EXISTS tick_spacing NUMERIC(78, 0),
    ADD COLUMN IF NOT EXISTS fee_tier NUMERIC(78, 0),
    ADD COLUMN IF NOT EXISTS extension_address TEXT,
    ADD COLUMN IF NOT EXISTS locker_address TEXT,
    ADD COLUMN IF NOT EXISTS amount0_delta NUMERIC(78, 0),
    ADD COLUMN IF NOT EXISTS amount1_delta NUMERIC(78, 0);

ALTER TABLE stark_ohlcv_1m
    ADD COLUMN IF NOT EXISTS tick_open NUMERIC(78, 0),
    ADD COLUMN IF NOT EXISTS tick_close NUMERIC(78, 0),
    ADD COLUMN IF NOT EXISTS sqrt_ratio_open NUMERIC(78, 0),
    ADD COLUMN IF NOT EXISTS sqrt_ratio_close NUMERIC(78, 0),
    ADD COLUMN IF NOT EXISTS fee_tier_bps NUMERIC(78, 0),
    ADD COLUMN IF NOT EXISTS tick_spacing NUMERIC(78, 0),
    ADD COLUMN IF NOT EXISTS volume0_usd NUMERIC,
    ADD COLUMN IF NOT EXISTS volume1_usd NUMERIC,
    ADD COLUMN IF NOT EXISTS vwap NUMERIC;

ALTER TABLE stark_transfers
    ADD COLUMN IF NOT EXISTS amount_human NUMERIC,
    ADD COLUMN IF NOT EXISTS amount_usd NUMERIC,
    ADD COLUMN IF NOT EXISTS token_symbol TEXT,
    ADD COLUMN IF NOT EXISTS token_name TEXT,
    ADD COLUMN IF NOT EXISTS token_decimals NUMERIC(78, 0),
    ADD COLUMN IF NOT EXISTS transfer_type TEXT,
    ADD COLUMN IF NOT EXISTS is_internal BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS counterparty_type TEXT;

COMMIT;

-- ==================================================
-- Source: sql/008_preproduction_hardening.sql
-- ==================================================
BEGIN;

ALTER TABLE stark_transfers
    ALTER COLUMN amount_human TYPE NUMERIC(78, 30)
        USING amount_human::NUMERIC(78, 30),
    ALTER COLUMN amount_usd TYPE NUMERIC(78, 30)
        USING amount_usd::NUMERIC(78, 30);

ALTER TABLE stark_ohlcv_1m
    ALTER COLUMN vwap TYPE NUMERIC(78, 30)
        USING vwap::NUMERIC(78, 30);

CREATE OR REPLACE VIEW view_unidentified_protocols AS
SELECT
    COALESCE(NULLIF(router_protocol, ''), COALESCE(locker_address, 'unknown_locker_untracked')) AS locker_identifier,
    router_protocol,
    locker_address,
    execution_protocol,
    protocol,
    COUNT(*) AS occurrence_count,
    MIN(block_number) AS first_seen_block_number,
    MAX(block_number) AS last_seen_block_number,
    MIN(created_at) AS first_seen_at,
    MAX(created_at) AS last_seen_at
FROM stark_trades
WHERE router_protocol LIKE 'unknown_locker_%'
GROUP BY
    COALESCE(NULLIF(router_protocol, ''), COALESCE(locker_address, 'unknown_locker_untracked')),
    router_protocol,
    locker_address,
    execution_protocol,
    protocol;

COMMIT;

-- ==================================================
-- Source: sql/009_trade_chaining.sql
-- ==================================================
BEGIN;

ALTER TABLE stark_trades
    ADD COLUMN IF NOT EXISTS sequence_id NUMERIC(78, 0),
    ADD COLUMN IF NOT EXISTS amount_in_human NUMERIC(78, 30),
    ADD COLUMN IF NOT EXISTS amount_out_human NUMERIC(78, 30);

CREATE INDEX IF NOT EXISTS stark_trades_tx_sequence_idx
    ON stark_trades (lane, transaction_hash, transaction_index, source_event_index);

CREATE INDEX IF NOT EXISTS stark_trades_route_sequence_idx
    ON stark_trades (lane, route_group_key, sequence_id);

CREATE TABLE IF NOT EXISTS stark_trade_enrichment_queue (
    queue_key TEXT PRIMARY KEY,
    lane TEXT NOT NULL,
    transaction_hash TEXT NOT NULL,
    block_number NUMERIC(78, 0) NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    enqueued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processing_started_at TIMESTAMPTZ,
    processed_at TIMESTAMPTZ,
    last_error TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (lane IN ('PRE_CONFIRMED', 'ACCEPTED_ON_L2', 'ACCEPTED_ON_L1')),
    CHECK (block_number >= 0),
    CHECK (status IN ('pending', 'processing', 'processed', 'failed'))
);

CREATE INDEX IF NOT EXISTS stark_trade_enrichment_queue_status_idx
    ON stark_trade_enrichment_queue (status, block_number, enqueued_at);

CREATE INDEX IF NOT EXISTS stark_trade_enrichment_queue_tx_idx
    ON stark_trade_enrichment_queue (lane, transaction_hash);

INSERT INTO stark_trade_enrichment_queue (
    queue_key,
    lane,
    transaction_hash,
    block_number,
    status,
    metadata,
    enqueued_at,
    created_at,
    updated_at
)
SELECT
    lane || ':' || transaction_hash AS queue_key,
    lane,
    transaction_hash,
    MIN(block_number) AS block_number,
    'pending' AS status,
    jsonb_build_object(
        'backfill_seed', TRUE,
        'pool_ids', to_jsonb(array_agg(DISTINCT pool_id) FILTER (WHERE pool_id IS NOT NULL))
    ) AS metadata,
    NOW(),
    NOW(),
    NOW()
FROM stark_trades
GROUP BY lane, transaction_hash
ON CONFLICT (queue_key)
DO UPDATE SET
    block_number = LEAST(stark_trade_enrichment_queue.block_number, EXCLUDED.block_number),
    status = 'pending',
    processing_started_at = NULL,
    processed_at = NULL,
    last_error = NULL,
    metadata = COALESCE(stark_trade_enrichment_queue.metadata, '{}'::jsonb) || EXCLUDED.metadata,
    updated_at = NOW();

UPDATE stark_trades AS trade
   SET amount_in_human = CASE
           WHEN token_in.decimals IS NULL THEN NULL
           ELSE trade.amount_in::NUMERIC / power(
               10::NUMERIC,
               GREATEST(token_in.decimals::INTEGER, 0)
           )
       END,
       amount_out_human = CASE
           WHEN token_out.decimals IS NULL THEN NULL
           ELSE trade.amount_out::NUMERIC / power(
               10::NUMERIC,
               GREATEST(token_out.decimals::INTEGER, 0)
           )
       END,
       updated_at = NOW()
  FROM stark_token_metadata AS token_in,
       stark_token_metadata AS token_out
 WHERE trade.token_in_address = token_in.token_address
   AND trade.token_out_address = token_out.token_address
   AND (
        trade.amount_in_human IS NULL
        OR (trade.amount_in_human = 0 AND trade.amount_in > 0)
        OR trade.amount_out_human IS NULL
        OR (trade.amount_out_human = 0 AND trade.amount_out > 0)
   );

COMMIT;

-- ==================================================
-- Source: sql/0010_l1_new_tables.sql
-- ==================================================
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

-- ==================================================
-- Source: sql/0011_l1_alter_tables.sql
-- ==================================================
BEGIN;

ALTER TABLE stark_bridge_activities
    ADD COLUMN IF NOT EXISTS eth_tx_hash TEXT,
    ADD COLUMN IF NOT EXISTS eth_block_number BIGINT,
    ADD COLUMN IF NOT EXISTS eth_block_timestamp TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS eth_log_index INTEGER,
    ADD COLUMN IF NOT EXISTS eth_event_key TEXT,
    ADD COLUMN IF NOT EXISTS l1_match_status TEXT NOT NULL DEFAULT 'PENDING',
    ADD COLUMN IF NOT EXISTS settlement_seconds INTEGER,
    ADD COLUMN IF NOT EXISTS settlement_blocks_l1 INTEGER,
    ADD COLUMN IF NOT EXISTS settlement_blocks_l2 NUMERIC(78, 0);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'sba_l1_match_check'
    ) THEN
        ALTER TABLE stark_bridge_activities
            ADD CONSTRAINT sba_l1_match_check
            CHECK (l1_match_status IN ('PENDING', 'MATCHED', 'UNMATCHED'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS sba_eth_tx_idx
    ON stark_bridge_activities (eth_tx_hash)
    WHERE eth_tx_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS sba_match_idx
    ON stark_bridge_activities (l1_match_status, direction, created_at);

ALTER TABLE stark_wallet_bridge_flows
    ADD COLUMN IF NOT EXISTS avg_settlement_seconds INTEGER,
    ADD COLUMN IF NOT EXISTS min_settlement_seconds INTEGER,
    ADD COLUMN IF NOT EXISTS max_settlement_seconds INTEGER,
    ADD COLUMN IF NOT EXISTS pending_l1_match_count NUMERIC(78, 0) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS l1_verified_inflow_usd NUMERIC,
    ADD COLUMN IF NOT EXISTS l1_verified_outflow_usd NUMERIC;

ALTER TABLE stark_wallet_stats
    ADD COLUMN IF NOT EXISTS l1_wallet_address TEXT,
    ADD COLUMN IF NOT EXISTS l1_bridge_inflow_usd NUMERIC NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS l1_bridge_outflow_usd NUMERIC NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS avg_bridge_settlement_s INTEGER,
    ADD COLUMN IF NOT EXISTS first_l1_activity_block BIGINT,
    ADD COLUMN IF NOT EXISTS last_l1_activity_block BIGINT;

CREATE INDEX IF NOT EXISTS sws_l1_wallet_idx
    ON stark_wallet_stats (l1_wallet_address)
    WHERE l1_wallet_address IS NOT NULL;

ALTER TABLE stark_message_l2_to_l1
    ADD COLUMN IF NOT EXISTS l1_consumed_tx_hash TEXT,
    ADD COLUMN IF NOT EXISTS l1_consumed_block BIGINT,
    ADD COLUMN IF NOT EXISTS l1_consumed_timestamp TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS message_status TEXT NOT NULL DEFAULT 'SENT',
    ADD COLUMN IF NOT EXISTS settlement_seconds INTEGER;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'sml_status_check'
    ) THEN
        ALTER TABLE stark_message_l2_to_l1
            ADD CONSTRAINT sml_status_check
            CHECK (message_status IN ('SENT', 'CONSUMED', 'CANCELLED'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS sml_status_idx
    ON stark_message_l2_to_l1 (message_status);

ALTER TABLE stark_trades
    ADD COLUMN IF NOT EXISTS l1_deposit_tx_hash TEXT,
    ADD COLUMN IF NOT EXISTS l1_deposit_block BIGINT,
    ADD COLUMN IF NOT EXISTS l1_deposit_timestamp TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS l1_wallet_address TEXT,
    ADD COLUMN IF NOT EXISTS seconds_since_deposit INTEGER,
    ADD COLUMN IF NOT EXISTS is_post_bridge_trade BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS st_l1_wallet_idx
    ON stark_trades (l1_wallet_address)
    WHERE l1_wallet_address IS NOT NULL;

CREATE INDEX IF NOT EXISTS st_post_bridge_idx
    ON stark_trades (is_post_bridge_trade, block_timestamp)
    WHERE is_post_bridge_trade = TRUE;

ALTER TABLE stark_whale_alert_candidates
    ADD COLUMN IF NOT EXISTS eth_tx_hash TEXT,
    ADD COLUMN IF NOT EXISTS eth_block_number BIGINT,
    ADD COLUMN IF NOT EXISTS l1_trigger_type TEXT,
    ADD COLUMN IF NOT EXISTS l1_trigger_amount NUMERIC,
    ADD COLUMN IF NOT EXISTS l1_trigger_usd NUMERIC,
    ADD COLUMN IF NOT EXISTS l1_to_l2_seconds INTEGER;

COMMIT;

-- ==================================================
-- Source: sql/0012_metadata_sync_and_transfer_enrichment.sql
-- ==================================================
BEGIN;

CREATE TABLE IF NOT EXISTS stark_token_metadata_refresh_queue (
    queue_key TEXT PRIMARY KEY,
    token_address TEXT NOT NULL,
    first_seen_block NUMERIC(78, 0),
    latest_seen_block NUMERIC(78, 0),
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    enqueued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processing_started_at TIMESTAMPTZ,
    processed_at TIMESTAMPTZ,
    last_error TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (status IN ('pending', 'processing', 'processed', 'failed')),
    CHECK (first_seen_block IS NULL OR first_seen_block >= 0),
    CHECK (latest_seen_block IS NULL OR latest_seen_block >= 0)
);

CREATE INDEX IF NOT EXISTS stark_token_metadata_refresh_queue_status_idx
    ON stark_token_metadata_refresh_queue (status, latest_seen_block, enqueued_at);

CREATE INDEX IF NOT EXISTS stark_token_metadata_refresh_queue_token_idx
    ON stark_token_metadata_refresh_queue (token_address);

CREATE INDEX IF NOT EXISTS stark_transfers_tx_idx
    ON stark_transfers (lane, transaction_hash, source_event_index);

CREATE INDEX IF NOT EXISTS stark_action_norm_tx_action_idx
    ON stark_action_norm (lane, transaction_hash, action_type, source_event_index);

WITH trade_decimal_resolution AS (
    SELECT trade.trade_key,
           token_in.decimals AS token_in_decimals,
           token_out.decimals AS token_out_decimals
      FROM stark_trades AS trade
      LEFT JOIN tokens AS token_in
        ON token_in.address = trade.token_in_address
      LEFT JOIN tokens AS token_out
        ON token_out.address = trade.token_out_address
)
UPDATE stark_trades AS trade
   SET amount_in_human = CASE
           WHEN resolution.token_in_decimals IS NULL THEN NULL
           ELSE trade.amount_in::NUMERIC / power(
               10::NUMERIC,
               GREATEST(resolution.token_in_decimals::INTEGER, 0)
           )
       END,
       amount_out_human = CASE
           WHEN resolution.token_out_decimals IS NULL THEN NULL
           ELSE trade.amount_out::NUMERIC / power(
               10::NUMERIC,
               GREATEST(resolution.token_out_decimals::INTEGER, 0)
           )
       END,
       pending_enrichment = CASE
           WHEN resolution.token_in_decimals IS NULL OR resolution.token_out_decimals IS NULL THEN TRUE
           ELSE trade.pending_enrichment
       END,
       metadata = (
           COALESCE(trade.metadata, '{}'::jsonb) - 'default_decimals_applied'
       ) || jsonb_build_object(
           'decimal_resolution_state',
           CASE
               WHEN resolution.token_in_decimals IS NULL OR resolution.token_out_decimals IS NULL THEN 'pending_metadata'
               ELSE COALESCE(trade.metadata ->> 'decimal_resolution_state', 'resolved')
           END,
           'missing_decimals_for',
           to_jsonb(array_remove(ARRAY[
               CASE WHEN resolution.token_in_decimals IS NULL THEN trade.token_in_address ELSE NULL END,
               CASE WHEN resolution.token_out_decimals IS NULL THEN trade.token_out_address ELSE NULL END
           ], NULL))
       ),
       updated_at = NOW()
  FROM trade_decimal_resolution AS resolution
 WHERE resolution.trade_key = trade.trade_key;

UPDATE stark_transfers AS transfer
   SET token_symbol = COALESCE(registry.symbol, transfer.token_symbol),
       token_name = COALESCE(registry.name, transfer.token_name),
       token_decimals = CASE
           WHEN registry.decimals IS NULL THEN NULL
           ELSE registry.decimals::NUMERIC
       END,
       amount_human = CASE
           WHEN registry.decimals IS NULL THEN NULL
           ELSE transfer.amount::NUMERIC / power(
               10::NUMERIC,
               GREATEST(registry.decimals::INTEGER, 0)
           )
       END,
       metadata = COALESCE(transfer.metadata, '{}'::jsonb) || jsonb_build_object(
           'decimal_resolution_state',
           CASE
               WHEN registry.decimals IS NULL THEN 'pending_metadata'
               ELSE 'resolved'
           END
       ),
       updated_at = NOW()
  FROM tokens AS registry
 WHERE registry.address = transfer.token_address
   AND (
        transfer.token_decimals IS DISTINCT FROM registry.decimals::NUMERIC
        OR transfer.amount_human IS NULL
        OR transfer.token_symbol IS NULL
        OR transfer.token_name IS NULL
   );

INSERT INTO stark_token_metadata_refresh_queue (
    queue_key,
    token_address,
    first_seen_block,
    latest_seen_block,
    status,
    metadata,
    enqueued_at,
    created_at,
    updated_at
)
SELECT
    token_address AS queue_key,
    token_address,
    MIN(first_seen_block) AS first_seen_block,
    MAX(latest_seen_block) AS latest_seen_block,
    'pending' AS status,
    jsonb_build_object(
        'seed_reason', 'migration_backfill',
        'source_tables', to_jsonb(array_agg(DISTINCT source_table))
    ) AS metadata,
    NOW(),
    NOW(),
    NOW()
FROM (
    SELECT token0_address AS token_address,
           MIN(block_number) AS first_seen_block,
           MAX(block_number) AS latest_seen_block,
           'stark_trades' AS source_table
      FROM stark_trades
     WHERE pending_enrichment = TRUE
     GROUP BY token0_address
    UNION ALL
    SELECT token1_address AS token_address,
           MIN(block_number) AS first_seen_block,
           MAX(block_number) AS latest_seen_block,
           'stark_trades' AS source_table
      FROM stark_trades
     WHERE pending_enrichment = TRUE
     GROUP BY token1_address
    UNION ALL
    SELECT token_address,
           MIN(block_number) AS first_seen_block,
           MAX(block_number) AS latest_seen_block,
           'stark_transfers' AS source_table
      FROM stark_transfers
     WHERE token_decimals IS NULL
        OR amount_human IS NULL
     GROUP BY token_address
) AS unresolved
WHERE token_address IS NOT NULL
GROUP BY token_address
ON CONFLICT (queue_key)
DO UPDATE SET
    first_seen_block = CASE
        WHEN stark_token_metadata_refresh_queue.first_seen_block IS NULL THEN EXCLUDED.first_seen_block
        WHEN EXCLUDED.first_seen_block IS NULL THEN stark_token_metadata_refresh_queue.first_seen_block
        ELSE LEAST(stark_token_metadata_refresh_queue.first_seen_block, EXCLUDED.first_seen_block)
    END,
    latest_seen_block = CASE
        WHEN stark_token_metadata_refresh_queue.latest_seen_block IS NULL THEN EXCLUDED.latest_seen_block
        WHEN EXCLUDED.latest_seen_block IS NULL THEN stark_token_metadata_refresh_queue.latest_seen_block
        ELSE GREATEST(stark_token_metadata_refresh_queue.latest_seen_block, EXCLUDED.latest_seen_block)
    END,
    status = 'pending',
    processing_started_at = NULL,
    processed_at = NULL,
    last_error = NULL,
    metadata = COALESCE(stark_token_metadata_refresh_queue.metadata, '{}'::jsonb) || EXCLUDED.metadata,
    updated_at = NOW();

COMMIT;

-- ==================================================
-- Source: sql/0013_pool_taxonomy_registry.sql
-- ==================================================
BEGIN;

CREATE TABLE IF NOT EXISTS stark_pool_registry (
    pool_key TEXT PRIMARY KEY,
    protocol TEXT,
    contract_address TEXT,
    pool_id TEXT NOT NULL,
    class_hash TEXT,
    factory_address TEXT,
    token0_address TEXT,
    token1_address TEXT,
    pool_family TEXT,
    pool_model TEXT,
    stable_flag BOOLEAN,
    confidence_level TEXT NOT NULL DEFAULT 'candidate',
    first_seen_block NUMERIC(78, 0),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (pool_id),
    CHECK (first_seen_block IS NULL OR first_seen_block >= 0),
    CHECK (confidence_level IN (
        'candidate',
        'history_hint',
        'low_rpc_probe',
        'verified_class_hash',
        'verified_static_registry'
    ))
);

CREATE INDEX IF NOT EXISTS stark_pool_registry_protocol_idx
    ON stark_pool_registry (protocol, pool_family, pool_model);

CREATE INDEX IF NOT EXISTS stark_pool_registry_contract_idx
    ON stark_pool_registry (contract_address)
    WHERE contract_address IS NOT NULL;

CREATE INDEX IF NOT EXISTS stark_pool_registry_class_hash_idx
    ON stark_pool_registry (class_hash)
    WHERE class_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS stark_pool_registry_family_idx
    ON stark_pool_registry (pool_family, pool_model);

ALTER TABLE stark_pool_state_history
    ADD COLUMN IF NOT EXISTS pool_family TEXT,
    ADD COLUMN IF NOT EXISTS pool_model TEXT;

ALTER TABLE stark_pool_latest
    ADD COLUMN IF NOT EXISTS pool_family TEXT,
    ADD COLUMN IF NOT EXISTS pool_model TEXT;

CREATE INDEX IF NOT EXISTS stark_pool_state_history_taxonomy_idx
    ON stark_pool_state_history (lane, pool_family, pool_model, block_number);

CREATE INDEX IF NOT EXISTS stark_pool_latest_taxonomy_idx
    ON stark_pool_latest (lane, pool_family, pool_model);

COMMIT;

-- ==================================================
-- Source: sql/0014_full_node_plan2.sql
-- ==================================================
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

-- ==================================================
-- Source: sql/0015_financial_resilience.sql
-- ==================================================
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

-- ==================================================
-- Source: sql/0016_protocol_accuracy.sql
-- ==================================================
BEGIN;

ALTER TABLE stark_audit_discrepancies
    ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE stark_audit_discrepancies
    DROP CONSTRAINT IF EXISTS stark_audit_discrepancies_resolution_status_check;

ALTER TABLE stark_audit_discrepancies
    ADD CONSTRAINT stark_audit_discrepancies_resolution_status_check
    CHECK (resolution_status IN ('logged', 'decoder_review_required', 'rpc_repaired', 'rpc_unavailable', 'clamped_zero', 'FATAL_MANUAL_REVIEW'));

COMMIT;

-- ==================================================
-- Source: sql/0017_integrity_and_maintenance.sql
-- ==================================================
BEGIN;

CREATE TABLE IF NOT EXISTS stark_pnl_audit_trail (
    audit_trail_key TEXT PRIMARY KEY,
    lane TEXT NOT NULL,
    wallet_address TEXT NOT NULL,
    token_address TEXT NOT NULL,
    buy_trade_key TEXT,
    buy_tx_hash TEXT,
    sell_trade_key TEXT NOT NULL,
    sell_tx_hash TEXT NOT NULL,
    sell_block_number NUMERIC(78, 0) NOT NULL,
    sell_source_event_index NUMERIC(78, 0) NOT NULL,
    relieved_quantity NUMERIC(78, 0) NOT NULL,
    relieved_cost_basis_usd NUMERIC,
    relieved_proceeds_usd NUMERIC,
    relieved_realized_pnl_usd NUMERIC,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (lane IN ('PRE_CONFIRMED', 'ACCEPTED_ON_L2', 'ACCEPTED_ON_L1')),
    CHECK (sell_block_number >= 0),
    CHECK (sell_source_event_index >= 0),
    CHECK (relieved_quantity >= 0)
);

CREATE INDEX IF NOT EXISTS stark_pnl_audit_trail_sell_idx
    ON stark_pnl_audit_trail (lane, sell_tx_hash, token_address, wallet_address);

CREATE INDEX IF NOT EXISTS stark_pnl_audit_trail_buy_idx
    ON stark_pnl_audit_trail (lane, buy_tx_hash, token_address, wallet_address)
    WHERE buy_tx_hash IS NOT NULL;

COMMIT;

-- ==================================================
-- Source: sql/0018_absolute_finality.sql
-- ==================================================
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

