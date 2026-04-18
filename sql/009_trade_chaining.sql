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
