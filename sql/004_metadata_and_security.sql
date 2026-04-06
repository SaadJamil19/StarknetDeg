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
