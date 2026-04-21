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
