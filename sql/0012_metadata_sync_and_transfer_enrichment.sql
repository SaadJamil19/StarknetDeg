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
