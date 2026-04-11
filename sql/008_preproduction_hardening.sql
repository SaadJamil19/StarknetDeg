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
