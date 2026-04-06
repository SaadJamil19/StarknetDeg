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
