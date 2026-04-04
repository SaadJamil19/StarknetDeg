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
