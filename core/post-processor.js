'use strict';

const { randomUUID } = require('node:crypto');

const { absBigInt } = require('../lib/cairo/fixed-point');
const { toBigIntStrict, toNumericString } = require('../lib/cairo/bigint');
const { toJsonbString } = require('./protocols/shared');

const DEFAULT_CHAIN_JITTER_BPS = 1n;

function buildTradeChainAnnotations(trades, options = {}) {
  const maxJitterBps = normalizeJitterBps(options.maxJitterBps);
  const groupedByTransaction = groupTradesByTransaction(trades);
  const annotations = [];
  const summary = {
    chainsDetected: 0,
    maxChainLength: 0,
    linkedRows: 0,
    standaloneRows: 0,
    transactionsScanned: groupedByTransaction.size,
  };

  for (const transactionTrades of groupedByTransaction.values()) {
    const ordered = [...transactionTrades].sort(compareTradeOrder);
    const groups = buildValueFlowGroups(ordered, maxJitterBps);

    for (const group of groups) {
      const annotatedGroup = annotateGroup(group, maxJitterBps);
      annotations.push(...annotatedGroup);

      if (group.length > 1) {
        summary.chainsDetected += 1;
        summary.linkedRows += group.length;
      } else {
        summary.standaloneRows += 1;
      }

      summary.maxChainLength = Math.max(summary.maxChainLength, group.length);
    }
  }

  return {
    annotations,
    summary,
  };
}

function buildValueFlowGroups(orderedTrades, maxJitterBps) {
  if (!Array.isArray(orderedTrades) || orderedTrades.length === 0) {
    return [];
  }

  const groups = [];
  let current = [orderedTrades[0]];

  for (let index = 1; index < orderedTrades.length; index += 1) {
    const previous = current[current.length - 1];
    const next = orderedTrades[index];

    if (canChainTrades(previous, next, maxJitterBps)) {
      current.push(next);
      continue;
    }

    groups.push(current);
    current = [next];
  }

  if (current.length > 0) {
    groups.push(current);
  }

  return groups;
}

function annotateGroup(group, maxJitterBps) {
  const totalHops = BigInt(group.length);
  const routeGroupKey = group.length > 1 ? randomUUID() : null;

  return group.map((trade, index) => {
    const sequenceId = BigInt(index + 1);
    const hopIndex = BigInt(index);
    const isMultiHop = group.length > 1;

    return {
      sourceEventIndex: toBigIntStrict(trade.sourceEventIndex, 'trade chain source event index'),
      routeGroupKey,
      sequenceId,
      hopIndex,
      totalHops,
      isMultiHop,
      metadata: {
        chain_max_jitter_bps: maxJitterBps.toString(10),
        chain_mode: isMultiHop ? 'value_flow_chain' : 'singleton_trade',
        hop_index: hopIndex.toString(10),
        is_multi_hop: isMultiHop,
        route_group_key: routeGroupKey,
        sequence_id: sequenceId.toString(10),
        total_hops: totalHops.toString(10),
      },
    };
  });
}

function canChainTrades(previous, next, maxJitterBps) {
  if (!previous || !next) {
    return false;
  }

  if (previous.transactionHash !== next.transactionHash) {
    return false;
  }

  if (!previous.tokenOutAddress || !next.tokenInAddress) {
    return false;
  }

  if (previous.tokenOutAddress !== next.tokenInAddress) {
    return false;
  }

  const previousAmountOut = toBigIntStrict(previous.amountOut, 'trade chain previous amount out');
  const nextAmountIn = toBigIntStrict(next.amountIn, 'trade chain next amount in');
  if (previousAmountOut <= 0n || nextAmountIn <= 0n) {
    return false;
  }

  const diff = absBigInt(previousAmountOut - nextAmountIn);
  const reference = previousAmountOut > nextAmountIn ? previousAmountOut : nextAmountIn;
  return diff * 10_000n <= reference * maxJitterBps;
}

async function enqueueTradeChainingTransactions(client, trades) {
  const grouped = new Map();

  for (const trade of trades ?? []) {
    if (!trade?.transactionHash || !trade?.lane) {
      continue;
    }

    const key = `${trade.lane}:${trade.transactionHash}`;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, {
        queueKey: key,
        lane: trade.lane,
        transactionHash: trade.transactionHash,
        blockNumber: trade.blockNumber,
        metadata: {
          pool_ids: trade.poolId ? [trade.poolId] : [],
          route_scan_signal: Boolean(trade.metadata?.route_scan_signal ?? trade.lockerAddress),
        },
      });
      continue;
    }

    if (trade.blockNumber < existing.blockNumber) {
      existing.blockNumber = trade.blockNumber;
    }
    if (trade.poolId && !existing.metadata.pool_ids.includes(trade.poolId)) {
      existing.metadata.pool_ids.push(trade.poolId);
    }
    existing.metadata.route_scan_signal = existing.metadata.route_scan_signal || Boolean(trade.metadata?.route_scan_signal ?? trade.lockerAddress);
  }

  for (const item of grouped.values()) {
    await client.query(
      `INSERT INTO stark_trade_enrichment_queue (
           queue_key,
           lane,
           transaction_hash,
           block_number,
           status,
           metadata,
           enqueued_at,
           updated_at
       ) VALUES (
           $1, $2, $3, $4, 'pending', $5::jsonb, NOW(), NOW()
       )
       ON CONFLICT (queue_key)
       DO UPDATE SET
           block_number = LEAST(stark_trade_enrichment_queue.block_number, EXCLUDED.block_number),
           status = 'pending',
           processing_started_at = NULL,
           processed_at = NULL,
           last_error = NULL,
           metadata = COALESCE(stark_trade_enrichment_queue.metadata, '{}'::jsonb) || EXCLUDED.metadata,
           updated_at = NOW()`,
      [
        item.queueKey,
        item.lane,
        item.transactionHash,
        toNumericString(item.blockNumber, 'trade chaining queue block number'),
        toJsonbString(item.metadata),
      ],
    );
  }

  return grouped.size;
}

async function claimTradeChainQueueItems(client, { limit, stuckAfterMs }) {
  const result = await client.query(
    `WITH candidate_rows AS (
         SELECT queue_key
           FROM stark_trade_enrichment_queue
          WHERE status IN ('pending', 'failed')
             OR (
                  status = 'processing'
              AND processing_started_at IS NOT NULL
              AND processing_started_at < NOW() - ($2::numeric * INTERVAL '1 millisecond')
             )
          ORDER BY block_number ASC, enqueued_at ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED
     )
     UPDATE stark_trade_enrichment_queue AS queue
        SET status = 'processing',
            attempts = queue.attempts + 1,
            processing_started_at = NOW(),
            updated_at = NOW()
       FROM candidate_rows
      WHERE queue.queue_key = candidate_rows.queue_key
      RETURNING queue.queue_key,
                queue.lane,
                queue.transaction_hash,
                queue.block_number,
                queue.metadata`,
    [limit, stuckAfterMs],
  );

  return result.rows.map((row) => ({
    blockNumber: toBigIntStrict(row.block_number, 'claimed queue block number'),
    lane: row.lane,
    metadata: row.metadata ?? {},
    queueKey: row.queue_key,
    transactionHash: row.transaction_hash,
  }));
}

async function loadTradesForTransaction(client, { lane, transactionHash }) {
  const result = await client.query(
    `SELECT trade_key,
            lane,
            protocol,
            transaction_hash,
            transaction_index,
            source_event_index,
            pool_id,
            token_in_address,
            token_out_address,
            amount_in,
            amount_out,
            metadata
       FROM stark_trades
      WHERE lane = $1
        AND transaction_hash = $2
      ORDER BY transaction_index ASC, source_event_index ASC`,
    [lane, transactionHash],
  );

  return result.rows.map((row) => ({
    lane: row.lane,
    metadata: row.metadata ?? {},
    amountIn: toBigIntStrict(row.amount_in, 'queue trade amount in'),
    amountOut: toBigIntStrict(row.amount_out, 'queue trade amount out'),
    poolId: row.pool_id,
    protocol: row.protocol,
    sourceEventIndex: toBigIntStrict(row.source_event_index, 'queue trade source event index'),
    tokenInAddress: row.token_in_address,
    tokenOutAddress: row.token_out_address,
    tradeKey: row.trade_key,
    transactionHash: row.transaction_hash,
    transactionIndex: toBigIntStrict(row.transaction_index, 'queue trade transaction index'),
  }));
}

async function applyTradeChainAnnotations(client, { lane, transactionHash, annotations }) {
  for (const annotation of annotations) {
    await client.query(
      `UPDATE stark_trades
          SET route_group_key = $4,
              sequence_id = $5,
              is_multi_hop = $6,
              hop_index = $7,
              total_hops = $8,
              metadata = COALESCE(metadata, '{}'::jsonb) || $9::jsonb,
              updated_at = NOW()
        WHERE lane = $1
          AND transaction_hash = $2
          AND source_event_index = $3`,
      [
        lane,
        transactionHash,
        toNumericString(annotation.sourceEventIndex, 'trade chain update source event index'),
        annotation.routeGroupKey,
        toNumericString(annotation.sequenceId, 'trade chain update sequence id'),
        annotation.isMultiHop,
        toNumericString(annotation.hopIndex, 'trade chain update hop index'),
        toNumericString(annotation.totalHops, 'trade chain update total hops'),
        toJsonbString(annotation.metadata),
      ],
    );
  }
}

async function markTradeChainQueueProcessed(client, queueKey, details) {
  await client.query(
    `UPDATE stark_trade_enrichment_queue
        SET status = 'processed',
            processed_at = NOW(),
            processing_started_at = NULL,
            last_error = NULL,
            metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
            updated_at = NOW()
      WHERE queue_key = $1`,
    [queueKey, toJsonbString(details ?? {})],
  );
}

async function markTradeChainQueueFailed(client, queueKey, error) {
  await client.query(
    `UPDATE stark_trade_enrichment_queue
        SET status = 'failed',
            processing_started_at = NULL,
            last_error = $2,
            updated_at = NOW()
      WHERE queue_key = $1`,
    [queueKey, truncateError(error)],
  );
}

function groupTradesByTransaction(trades) {
  const grouped = new Map();

  for (const trade of trades ?? []) {
    if (!trade?.transactionHash) {
      continue;
    }

    if (!grouped.has(trade.transactionHash)) {
      grouped.set(trade.transactionHash, []);
    }

    grouped.get(trade.transactionHash).push(trade);
  }

  return grouped;
}

function compareTradeOrder(left, right) {
  if (left.transactionIndex !== right.transactionIndex) {
    return left.transactionIndex < right.transactionIndex ? -1 : 1;
  }

  if (left.sourceEventIndex !== right.sourceEventIndex) {
    return left.sourceEventIndex < right.sourceEventIndex ? -1 : 1;
  }

  return left.tradeKey < right.tradeKey ? -1 : 1;
}

function normalizeJitterBps(value) {
  const parsed = value === undefined || value === null
    ? DEFAULT_CHAIN_JITTER_BPS
    : toBigIntStrict(value, 'trade chain max jitter bps');

  if (parsed <= 0n) {
    return DEFAULT_CHAIN_JITTER_BPS;
  }

  return parsed;
}

function truncateError(error) {
  const message = error?.stack || error?.message || String(error);
  return message.length > 4000 ? message.slice(0, 4000) : message;
}

module.exports = {
  DEFAULT_CHAIN_JITTER_BPS,
  applyTradeChainAnnotations,
  buildTradeChainAnnotations,
  claimTradeChainQueueItems,
  enqueueTradeChainingTransactions,
  loadTradesForTransaction,
  markTradeChainQueueFailed,
  markTradeChainQueueProcessed,
};
