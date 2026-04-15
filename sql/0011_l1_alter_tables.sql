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
