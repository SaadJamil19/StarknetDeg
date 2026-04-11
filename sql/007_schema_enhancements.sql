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
