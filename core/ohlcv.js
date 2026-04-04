'use strict';

const { toBigIntStrict, toNumericString } = require('../lib/cairo/bigint');
const {
  DEFAULT_SCALE,
  compareBigInt,
  decimalStringToScaled,
  scaledToNumericString,
} = require('../lib/cairo/fixed-point');
const { toJsonbString } = require('./protocols/shared');

async function persistOhlcvForBlock(client, { blockHash, blockNumber, lane, reconciliationTriggered, trades }) {
  if (!trades || trades.length === 0) {
    return {
      realtimeCandles: [],
      summary: {
        fullRebuildCandles: 0,
        incrementalCandles: 0,
        seededCandles: 0,
        touchedCandles: 0,
      },
    };
  }

  const shouldRebuild = reconciliationTriggered === undefined
    ? await isReconciliationTriggered(client, { blockNumber, lane })
    : Boolean(reconciliationTriggered);
  const tradeBuckets = groupTradesByPoolAndBucket(trades);
  const candleRows = [];
  let fullRebuildCandles = 0;
  let incrementalCandles = 0;
  let seededCandles = 0;

  for (const [poolId, poolData] of tradeBuckets.entries()) {
    const buckets = Array.from(poolData.buckets.keys()).sort();
    const firstBucketDate = new Date(buckets[0]);
    let previousCandle = await loadPreviousCandle(client, { beforeBucketStart: firstBucketDate, lane, poolId });
    let previousCloseScaled = previousCandle ? decimalStringToScaled(previousCandle.close, DEFAULT_SCALE) : null;
    let previousBucketDate = previousCandle ? previousCandle.bucketStart : null;

    for (let index = 0; index < buckets.length; index += 1) {
      const bucketStart = new Date(buckets[index]);
      const bucketTrades = poolData.buckets.get(buckets[index]);
      const anchorTrade = bucketTrades[0];

      if (previousCloseScaled !== null) {
        const gapRows = buildGapCandles({
          anchorTrade,
          blockHash,
          blockNumber,
          fromBucketDate: previousBucketDate,
          previousCloseScaled,
          priceIsDecimalsNormalized: previousCandle?.priceIsDecimalsNormalized ?? bucketTrades[0].priceIsDecimalsNormalized,
          toBucketDate: bucketStart,
        });

        for (const row of gapRows) {
          await upsertCandle(client, row);
          candleRows.push(row);
          seededCandles += 1;
        }
      }

      let candle;
      if (shouldRebuild) {
        candle = await rebuildCandleForBucket(client, { bucketStart, lane, poolId });
        if (candle) {
          candle.metadata = {
            ...(candle.metadata ?? {}),
            cache_mode: 'full_rebuild',
            reconciliation_triggered: true,
          };
          fullRebuildCandles += 1;
        }
      } else {
        const existingCandle = await loadExistingCandle(client, { bucketStart, lane, poolId });
        candle = buildIncrementalCandle({
          blockHash,
          blockNumber,
          bucketStart,
          bucketTrades,
          existingCandle,
        });
        incrementalCandles += 1;
      }

      if (!candle) {
        continue;
      }

      await upsertCandle(client, candle);
      candleRows.push(candle);
      previousCloseScaled = candle.closeScaled;
      previousBucketDate = bucketStart;
      previousCandle = {
        bucketStart,
        close: scaledToNumericString(candle.closeScaled, DEFAULT_SCALE),
        priceIsDecimalsNormalized: candle.priceIsDecimalsNormalized,
      };
    }
  }

  return {
    realtimeCandles: candleRows.map(serializeRealtimeCandle),
    summary: {
      fullRebuildCandles,
      incrementalCandles,
      seededCandles,
      touchedCandles: candleRows.length,
    },
  };
}

async function isReconciliationTriggered(client, { blockNumber, lane }) {
  const result = await client.query(
    `SELECT 1
       FROM stark_reconciliation_log
      WHERE lane = $1
        AND status IN ('DETECTED', 'REPLAYING')
        AND from_block_number <= $2
        AND to_block_number >= $2
      LIMIT 1`,
    [lane, toNumericString(blockNumber, 'reconciliation block number')],
  );

  return result.rowCount > 0;
}

function buildGapCandles({ anchorTrade, blockHash, blockNumber, fromBucketDate, previousCloseScaled, priceIsDecimalsNormalized, toBucketDate }) {
  if (!fromBucketDate) {
    return [];
  }

  const rows = [];
  let cursor = new Date(fromBucketDate.getTime() + 60_000);

  while (cursor < toBucketDate) {
    rows.push({
      blockHash,
      blockNumber,
      bucketStart: new Date(cursor),
      closeScaled: previousCloseScaled,
      highScaled: previousCloseScaled,
      lane: anchorTrade.lane,
      lowScaled: previousCloseScaled,
      metadata: {
        cache_mode: 'gap_seed',
        reconciliation_triggered: false,
        source: 'seeded_from_previous_close',
      },
      openScaled: previousCloseScaled,
      poolId: anchorTrade.poolId,
      priceIsDecimalsNormalized,
      protocol: anchorTrade.protocol,
      seededFromPreviousClose: true,
      sourceEventIndex: anchorTrade.sourceEventIndex,
      token0Address: anchorTrade.token0Address,
      token1Address: anchorTrade.token1Address,
      tradeCount: 0n,
      transactionHash: anchorTrade.transactionHash,
      transactionIndex: anchorTrade.transactionIndex,
      volume0: 0n,
      volume1: 0n,
      volumeUsdScaled: 0n,
    });
    cursor = new Date(cursor.getTime() + 60_000);
  }

  return rows;
}

function buildIncrementalCandle({ blockHash, blockNumber, bucketStart, bucketTrades, existingCandle }) {
  const tradeAggregate = aggregateBucketTrades(bucketTrades);
  if (!tradeAggregate) {
    return null;
  }

  const shouldDiscardSeed = existingCandle?.seededFromPreviousClose && existingCandle.tradeCount === 0n;

  if (!existingCandle || shouldDiscardSeed) {
    return {
      blockHash,
      blockNumber,
      bucketStart,
      closeScaled: tradeAggregate.closeScaled,
      highScaled: tradeAggregate.highScaled,
      lane: tradeAggregate.lane,
      lowScaled: tradeAggregate.lowScaled,
      metadata: {
        cache_mode: 'incremental_new',
        reconciliation_triggered: false,
        source: 'current_block_trades',
      },
      openScaled: tradeAggregate.openScaled,
      poolId: tradeAggregate.poolId,
      priceIsDecimalsNormalized: tradeAggregate.priceIsDecimalsNormalized,
      protocol: tradeAggregate.protocol,
      seededFromPreviousClose: false,
      sourceEventIndex: tradeAggregate.sourceEventIndex,
      token0Address: tradeAggregate.token0Address,
      token1Address: tradeAggregate.token1Address,
      tradeCount: tradeAggregate.tradeCount,
      transactionHash: tradeAggregate.transactionHash,
      transactionIndex: tradeAggregate.transactionIndex,
      volume0: tradeAggregate.volume0,
      volume1: tradeAggregate.volume1,
      volumeUsdScaled: tradeAggregate.volumeUsdScaled,
    };
  }

  return {
    blockHash,
    blockNumber,
    bucketStart,
    closeScaled: tradeAggregate.closeScaled,
    highScaled: compareBigInt(existingCandle.highScaled, tradeAggregate.highScaled) >= 0 ? existingCandle.highScaled : tradeAggregate.highScaled,
    lane: tradeAggregate.lane,
    lowScaled: compareBigInt(existingCandle.lowScaled, tradeAggregate.lowScaled) <= 0 ? existingCandle.lowScaled : tradeAggregate.lowScaled,
    metadata: {
      cache_mode: 'incremental_append',
      previous_trade_count: existingCandle.tradeCount.toString(10),
      reconciliation_triggered: false,
      source: 'existing_candle_plus_current_block_trades',
    },
    openScaled: existingCandle.openScaled,
    poolId: tradeAggregate.poolId,
    priceIsDecimalsNormalized: existingCandle.priceIsDecimalsNormalized || tradeAggregate.priceIsDecimalsNormalized,
    protocol: tradeAggregate.protocol,
    seededFromPreviousClose: false,
    sourceEventIndex: tradeAggregate.sourceEventIndex,
    token0Address: tradeAggregate.token0Address,
    token1Address: tradeAggregate.token1Address,
    tradeCount: existingCandle.tradeCount + tradeAggregate.tradeCount,
    transactionHash: tradeAggregate.transactionHash,
    transactionIndex: tradeAggregate.transactionIndex,
    volume0: existingCandle.volume0 + tradeAggregate.volume0,
    volume1: existingCandle.volume1 + tradeAggregate.volume1,
    volumeUsdScaled: existingCandle.volumeUsdScaled + tradeAggregate.volumeUsdScaled,
  };
}

function aggregateBucketTrades(bucketTrades) {
  if (!bucketTrades || bucketTrades.length === 0) {
    return null;
  }

  const sortedTrades = [...bucketTrades].sort((left, right) => {
    if (left.transactionIndex !== right.transactionIndex) {
      return left.transactionIndex < right.transactionIndex ? -1 : 1;
    }

    if (left.sourceEventIndex !== right.sourceEventIndex) {
      return left.sourceEventIndex < right.sourceEventIndex ? -1 : 1;
    }

    return left.tradeKey < right.tradeKey ? -1 : 1;
  });

  const prices = sortedTrades.map((trade) => trade.priceToken1PerToken0Scaled);
  let highScaled = prices[0];
  let lowScaled = prices[0];
  let volume0 = 0n;
  let volume1 = 0n;
  let volumeUsdScaled = 0n;

  for (let index = 0; index < sortedTrades.length; index += 1) {
    const trade = sortedTrades[index];
    const priceScaled = prices[index];

    if (compareBigInt(priceScaled, highScaled) > 0) {
      highScaled = priceScaled;
    }

    if (compareBigInt(priceScaled, lowScaled) < 0) {
      lowScaled = priceScaled;
    }

    volume0 += trade.volumeToken0;
    volume1 += trade.volumeToken1;

    if (trade.notionalUsdScaled !== null) {
      volumeUsdScaled += trade.notionalUsdScaled;
    }
  }

  const first = sortedTrades[0];
  const last = sortedTrades[sortedTrades.length - 1];

  return {
    closeScaled: prices[prices.length - 1],
    highScaled,
    lane: first.lane,
    lowScaled,
    openScaled: prices[0],
    poolId: first.poolId,
    priceIsDecimalsNormalized: last.priceIsDecimalsNormalized,
    protocol: first.protocol,
    sourceEventIndex: last.sourceEventIndex,
    token0Address: first.token0Address,
    token1Address: first.token1Address,
    tradeCount: BigInt(sortedTrades.length),
    transactionHash: last.transactionHash,
    transactionIndex: last.transactionIndex,
    volume0,
    volume1,
    volumeUsdScaled,
  };
}

function groupTradesByPoolAndBucket(trades) {
  const map = new Map();

  for (const trade of trades) {
    const bucketKey = trade.bucketStart.toISOString();

    if (!map.has(trade.poolId)) {
      map.set(trade.poolId, {
        buckets: new Map(),
      });
    }

    const poolData = map.get(trade.poolId);
    if (!poolData.buckets.has(bucketKey)) {
      poolData.buckets.set(bucketKey, []);
    }
    poolData.buckets.get(bucketKey).push(trade);
  }

  return map;
}

async function loadExistingCandle(client, { bucketStart, lane, poolId }) {
  const result = await client.query(
    `SELECT protocol,
            token0_address,
            token1_address,
            open,
            high,
            low,
            close,
            price_is_decimals_normalized,
            volume0,
            volume1,
            volume_usd,
            trade_count,
            seeded_from_previous_close
       FROM stark_ohlcv_1m
      WHERE lane = $1
        AND pool_id = $2
        AND bucket_start = $3
      LIMIT 1`,
    [lane, poolId, bucketStart],
  );

  if (result.rowCount === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    closeScaled: decimalStringToScaled(row.close, DEFAULT_SCALE),
    highScaled: decimalStringToScaled(row.high, DEFAULT_SCALE),
    lowScaled: decimalStringToScaled(row.low, DEFAULT_SCALE),
    openScaled: decimalStringToScaled(row.open, DEFAULT_SCALE),
    priceIsDecimalsNormalized: row.price_is_decimals_normalized,
    protocol: row.protocol,
    seededFromPreviousClose: row.seeded_from_previous_close,
    token0Address: row.token0_address,
    token1Address: row.token1_address,
    tradeCount: toBigIntStrict(row.trade_count, 'existing candle trade count'),
    volume0: toBigIntStrict(row.volume0, 'existing candle volume0'),
    volume1: toBigIntStrict(row.volume1, 'existing candle volume1'),
    volumeUsdScaled: decimalStringToScaled(row.volume_usd, DEFAULT_SCALE),
  };
}

async function loadPreviousCandle(client, { beforeBucketStart, lane, poolId }) {
  const result = await client.query(
    `SELECT bucket_start,
            close,
            price_is_decimals_normalized
       FROM stark_ohlcv_1m
      WHERE lane = $1
        AND pool_id = $2
        AND bucket_start < $3
      ORDER BY bucket_start DESC
      LIMIT 1`,
    [lane, poolId, beforeBucketStart],
  );

  if (result.rowCount === 0) {
    return null;
  }

  return {
    bucketStart: result.rows[0].bucket_start,
    close: result.rows[0].close,
    priceIsDecimalsNormalized: result.rows[0].price_is_decimals_normalized,
  };
}

async function rebuildCandleForBucket(client, { bucketStart, lane, poolId }) {
  const result = await client.query(
    `SELECT protocol,
            token0_address,
            token1_address,
            price_token1_per_token0,
            price_is_decimals_normalized,
            volume_token0,
            volume_token1,
            notional_usd,
            block_number,
            block_hash,
            transaction_hash,
            transaction_index,
            source_event_index
       FROM stark_trades
      WHERE lane = $1
        AND pool_id = $2
        AND bucket_1m = $3
      ORDER BY transaction_index ASC, source_event_index ASC, trade_key ASC`,
    [lane, poolId, bucketStart],
  );

  if (result.rowCount === 0) {
    return null;
  }

  const prices = result.rows.map((row) => decimalStringToScaled(row.price_token1_per_token0, DEFAULT_SCALE));
  let highScaled = prices[0];
  let lowScaled = prices[0];
  let volume0 = 0n;
  let volume1 = 0n;
  let volumeUsdScaled = 0n;

  for (let index = 0; index < result.rows.length; index += 1) {
    const row = result.rows[index];
    const priceScaled = prices[index];

    if (compareBigInt(priceScaled, highScaled) > 0) {
      highScaled = priceScaled;
    }

    if (compareBigInt(priceScaled, lowScaled) < 0) {
      lowScaled = priceScaled;
    }

    volume0 += toBigIntStrict(row.volume_token0, 'candle volume0');
    volume1 += toBigIntStrict(row.volume_token1, 'candle volume1');

    if (row.notional_usd !== null) {
      volumeUsdScaled += decimalStringToScaled(row.notional_usd, DEFAULT_SCALE);
    }
  }

  const first = result.rows[0];
  const last = result.rows[result.rows.length - 1];

  return {
    blockHash: last.block_hash,
    blockNumber: toBigIntStrict(last.block_number, 'candle block number'),
    bucketStart,
    closeScaled: prices[prices.length - 1],
    highScaled,
    lane,
    lowScaled,
    metadata: {
      source: 'trades',
    },
    openScaled: prices[0],
    poolId,
    priceIsDecimalsNormalized: last.price_is_decimals_normalized,
    protocol: first.protocol,
    seededFromPreviousClose: false,
    sourceEventIndex: toBigIntStrict(last.source_event_index, 'candle source event index'),
    token0Address: first.token0_address,
    token1Address: first.token1_address,
    tradeCount: BigInt(result.rowCount),
    transactionHash: last.transaction_hash,
    transactionIndex: toBigIntStrict(last.transaction_index, 'candle transaction index'),
    volume0,
    volume1,
    volumeUsdScaled,
  };
}

async function upsertCandle(client, candle) {
  await client.query(
    `INSERT INTO stark_ohlcv_1m (
         candle_key,
         lane,
         pool_id,
         protocol,
         token0_address,
         token1_address,
         bucket_start,
         block_number,
         block_hash,
         transaction_hash,
         transaction_index,
         source_event_index,
         open,
         high,
         low,
         close,
         price_is_decimals_normalized,
         volume0,
         volume1,
         volume_usd,
         trade_count,
         seeded_from_previous_close,
         metadata,
         created_at,
         updated_at
     ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
         $21, $22, $23::jsonb, NOW(), NOW()
     )
     ON CONFLICT (lane, pool_id, bucket_start)
     DO UPDATE SET
         protocol = EXCLUDED.protocol,
         token0_address = EXCLUDED.token0_address,
         token1_address = EXCLUDED.token1_address,
         block_number = EXCLUDED.block_number,
         block_hash = EXCLUDED.block_hash,
         transaction_hash = EXCLUDED.transaction_hash,
         transaction_index = EXCLUDED.transaction_index,
         source_event_index = EXCLUDED.source_event_index,
         open = EXCLUDED.open,
         high = EXCLUDED.high,
         low = EXCLUDED.low,
         close = EXCLUDED.close,
         price_is_decimals_normalized = EXCLUDED.price_is_decimals_normalized,
         volume0 = EXCLUDED.volume0,
         volume1 = EXCLUDED.volume1,
         volume_usd = EXCLUDED.volume_usd,
         trade_count = EXCLUDED.trade_count,
         seeded_from_previous_close = EXCLUDED.seeded_from_previous_close,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()`,
    [
      buildCandleKey(candle),
      candle.lane,
      candle.poolId,
      candle.protocol,
      candle.token0Address,
      candle.token1Address,
      candle.bucketStart,
      toNumericString(candle.blockNumber, 'candle block number'),
      candle.blockHash,
      candle.transactionHash ?? null,
      candle.transactionIndex === null || candle.transactionIndex === undefined ? null : toNumericString(candle.transactionIndex, 'candle transaction index'),
      candle.sourceEventIndex === null || candle.sourceEventIndex === undefined ? null : toNumericString(candle.sourceEventIndex, 'candle source event index'),
      scaledToNumericString(candle.openScaled, DEFAULT_SCALE),
      scaledToNumericString(candle.highScaled, DEFAULT_SCALE),
      scaledToNumericString(candle.lowScaled, DEFAULT_SCALE),
      scaledToNumericString(candle.closeScaled, DEFAULT_SCALE),
      candle.priceIsDecimalsNormalized,
      toNumericString(candle.volume0, 'candle volume0'),
      toNumericString(candle.volume1, 'candle volume1'),
      scaledToNumericString(candle.volumeUsdScaled, DEFAULT_SCALE),
      toNumericString(candle.tradeCount, 'candle trade count'),
      candle.seededFromPreviousClose,
      toJsonbString(candle.metadata ?? {}),
    ],
  );
}

function buildCandleKey(candle) {
  return `${candle.lane}:${candle.poolId}:${candle.bucketStart.toISOString()}`;
}

function serializeRealtimeCandle(candle) {
  return {
    blockNumber: candle.blockNumber.toString(10),
    bucketStart: candle.bucketStart.toISOString(),
    close: scaledToNumericString(candle.closeScaled, DEFAULT_SCALE),
    high: scaledToNumericString(candle.highScaled, DEFAULT_SCALE),
    lane: candle.lane,
    low: scaledToNumericString(candle.lowScaled, DEFAULT_SCALE),
    open: scaledToNumericString(candle.openScaled, DEFAULT_SCALE),
    poolId: candle.poolId,
    priceIsDecimalsNormalized: candle.priceIsDecimalsNormalized,
    protocol: candle.protocol,
    seededFromPreviousClose: candle.seededFromPreviousClose,
    tradeCount: candle.tradeCount.toString(10),
    volume0: candle.volume0.toString(10),
    volume1: candle.volume1.toString(10),
    volumeUsd: scaledToNumericString(candle.volumeUsdScaled, DEFAULT_SCALE),
  };
}

module.exports = {
  persistOhlcvForBlock,
};
