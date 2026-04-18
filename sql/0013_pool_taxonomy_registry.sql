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
