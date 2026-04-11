'use strict';

const { toBigIntStrict, toNumericString } = require('../lib/cairo/bigint');
const {
  DEFAULT_SCALE,
  absBigInt,
  compareBigInt,
  decimalStringToScaled,
  scaledDivide,
  scaledMultiply,
  scaledToNumericString,
} = require('../lib/cairo/fixed-point');
const { toJsonbString } = require('./protocols/shared');

async function persistOhlcvForBlock(client, { blockHash, blockNumber, lane, reconciliationTriggered, trades }) {
  const candleEligibleTrades = filterTradesForOhlcv(trades);
  if (!candleEligibleTrades || candleEligibleTrades.length === 0) {
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
  const tradeBuckets = groupTradesByPoolAndBucket(candleEligibleTrades);
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
          previousPendingEnrichment: previousCandle?.pendingEnrichment ?? false,
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
        pendingEnrichment: candle.pendingEnrichment,
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

function filterTradesForOhlcv(trades) {
  const maxHopsFromStable = parseNonNegativeBigInt(process.env.PHASE3_MAX_OHLCV_HOPS_FROM_STABLE, 2n);
  return (trades ?? []).filter((trade) => {
    if (!trade) {
      return false;
    }

    if (trade.isAggregatorDerived) {
      return false;
    }

    if (trade.hopsFromStable !== null && trade.hopsFromStable !== undefined && trade.hopsFromStable > maxHopsFromStable) {
      return false;
    }

    return true;
  });
}

function deriveCanonicalTradeVolumes(trade) {
  const hasCanonicalDeltas = trade.amount0Delta !== undefined && trade.amount0Delta !== null &&
    trade.amount1Delta !== undefined && trade.amount1Delta !== null;

  if (hasCanonicalDeltas) {
    return {
      volume0: absBigInt(toBigIntStrict(trade.amount0Delta, 'ohlcv trade amount0 delta')),
      volume1: absBigInt(toBigIntStrict(trade.amount1Delta, 'ohlcv trade amount1 delta')),
    };
  }

  return {
    volume0: toBigIntStrict(trade.volumeToken0, 'ohlcv trade volume0'),
    volume1: toBigIntStrict(trade.volumeToken1, 'ohlcv trade volume1'),
  };
}

function getNormalizedExecutionPriceScaled(trade) {
  return toBigIntStrict(trade.priceToken1PerToken0Scaled, 'ohlcv normalized execution price');
}

function buildGapCandles({
  anchorTrade,
  blockHash,
  blockNumber,
  fromBucketDate,
  previousCloseScaled,
  previousPendingEnrichment,
  priceIsDecimalsNormalized,
  toBucketDate,
}) {
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
        pending_enrichment: Boolean(previousPendingEnrichment),
        reconciliation_triggered: false,
        source: 'seeded_from_previous_close',
      },
      openScaled: previousCloseScaled,
      poolId: anchorTrade.poolId,
      pendingEnrichment: Boolean(previousPendingEnrichment),
      priceIsDecimalsNormalized,
      protocol: anchorTrade.protocol,
      feeTierBps: anchorTrade.feeTier ?? null,
      seededFromPreviousClose: true,
      sourceEventIndex: anchorTrade.sourceEventIndex,
      sqrtRatioClose: anchorTrade.sqrtRatioAfter ?? null,
      sqrtRatioOpen: anchorTrade.sqrtRatioAfter ?? null,
      tickClose: anchorTrade.tickAfter ?? null,
      tickOpen: anchorTrade.tickAfter ?? null,
      tickSpacing: anchorTrade.tickSpacing ?? null,
      token0Address: anchorTrade.token0Address,
      token1Address: anchorTrade.token1Address,
      tradeCount: 0n,
      transactionHash: anchorTrade.transactionHash,
      transactionIndex: anchorTrade.transactionIndex,
      volume0: 0n,
      volume0UsdScaled: 0n,
      volume1: 0n,
      volume1UsdScaled: 0n,
      volumeUsdScaled: 0n,
      vwapScaled: previousCloseScaled,
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
        pending_enrichment: tradeAggregate.pendingEnrichment,
        reconciliation_triggered: false,
        source: 'current_block_trades',
        vwap_price_source: 'normalized_execution_price',
        volume_source: 'canonical_amount_deltas',
      },
      openScaled: tradeAggregate.openScaled,
      pendingEnrichment: tradeAggregate.pendingEnrichment,
      poolId: tradeAggregate.poolId,
      priceIsDecimalsNormalized: tradeAggregate.priceIsDecimalsNormalized,
      protocol: tradeAggregate.protocol,
      feeTierBps: tradeAggregate.feeTierBps,
      seededFromPreviousClose: false,
      sourceEventIndex: tradeAggregate.sourceEventIndex,
      sqrtRatioClose: tradeAggregate.sqrtRatioClose,
      sqrtRatioOpen: tradeAggregate.sqrtRatioOpen,
      tickClose: tradeAggregate.tickClose,
      tickOpen: tradeAggregate.tickOpen,
      tickSpacing: tradeAggregate.tickSpacing,
      token0Address: tradeAggregate.token0Address,
      token1Address: tradeAggregate.token1Address,
      tradeCount: tradeAggregate.tradeCount,
      transactionHash: tradeAggregate.transactionHash,
      transactionIndex: tradeAggregate.transactionIndex,
      volume0: tradeAggregate.volume0,
      volume0UsdScaled: tradeAggregate.volume0UsdScaled,
      volume1: tradeAggregate.volume1,
      volume1UsdScaled: tradeAggregate.volume1UsdScaled,
      volumeUsdScaled: tradeAggregate.volumeUsdScaled,
      vwapScaled: tradeAggregate.vwapScaled,
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
      pending_enrichment: existingCandle.pendingEnrichment || tradeAggregate.pendingEnrichment,
      previous_trade_count: existingCandle.tradeCount.toString(10),
      reconciliation_triggered: false,
      source: 'existing_candle_plus_current_block_trades',
      vwap_price_source: 'normalized_execution_price',
      volume_source: 'canonical_amount_deltas',
    },
    openScaled: existingCandle.openScaled,
    pendingEnrichment: existingCandle.pendingEnrichment || tradeAggregate.pendingEnrichment,
    poolId: tradeAggregate.poolId,
    priceIsDecimalsNormalized: existingCandle.priceIsDecimalsNormalized || tradeAggregate.priceIsDecimalsNormalized,
    protocol: tradeAggregate.protocol,
    feeTierBps: existingCandle.feeTierBps ?? tradeAggregate.feeTierBps,
    seededFromPreviousClose: false,
    sourceEventIndex: tradeAggregate.sourceEventIndex,
    sqrtRatioClose: tradeAggregate.sqrtRatioClose,
    sqrtRatioOpen: existingCandle.sqrtRatioOpen ?? tradeAggregate.sqrtRatioOpen,
    tickClose: tradeAggregate.tickClose,
    tickOpen: existingCandle.tickOpen ?? tradeAggregate.tickOpen,
    tickSpacing: existingCandle.tickSpacing ?? tradeAggregate.tickSpacing,
    token0Address: tradeAggregate.token0Address,
    token1Address: tradeAggregate.token1Address,
    tradeCount: existingCandle.tradeCount + tradeAggregate.tradeCount,
    transactionHash: tradeAggregate.transactionHash,
    transactionIndex: tradeAggregate.transactionIndex,
    volume0: existingCandle.volume0 + tradeAggregate.volume0,
    volume0UsdScaled: existingCandle.volume0UsdScaled + tradeAggregate.volume0UsdScaled,
    volume1: existingCandle.volume1 + tradeAggregate.volume1,
    volume1UsdScaled: existingCandle.volume1UsdScaled + tradeAggregate.volume1UsdScaled,
    volumeUsdScaled: existingCandle.volumeUsdScaled + tradeAggregate.volumeUsdScaled,
    vwapScaled: combineVwap(existingCandle, tradeAggregate),
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

  const prices = sortedTrades.map((trade) => getNormalizedExecutionPriceScaled(trade));
  let highScaled = prices[0];
  let lowScaled = prices[0];
  let volume0 = 0n;
  let volume1 = 0n;
  let volume0UsdScaled = 0n;
  let volume1UsdScaled = 0n;
  let volumeUsdScaled = 0n;
  let weightedPriceNumerator = 0n;
  let weightedPriceDenominator = 0n;
  let pendingEnrichment = false;

  for (let index = 0; index < sortedTrades.length; index += 1) {
    const trade = sortedTrades[index];
    const priceScaled = prices[index];
    const canonicalVolumes = deriveCanonicalTradeVolumes(trade);

    if (compareBigInt(priceScaled, highScaled) > 0) {
      highScaled = priceScaled;
    }

    if (compareBigInt(priceScaled, lowScaled) < 0) {
      lowScaled = priceScaled;
    }

    volume0 += canonicalVolumes.volume0;
    volume1 += canonicalVolumes.volume1;
    if (trade.notionalUsdScaled !== null) {
      volume0UsdScaled += trade.notionalUsdScaled;
      volume1UsdScaled += trade.notionalUsdScaled;
      volumeUsdScaled += trade.notionalUsdScaled;
    }
    weightedPriceNumerator += scaledMultiply(priceScaled, canonicalVolumes.volume0, DEFAULT_SCALE);
    weightedPriceDenominator += canonicalVolumes.volume0;
    pendingEnrichment = pendingEnrichment || Boolean(trade.pendingEnrichment);
  }

  const first = sortedTrades[0];
  const last = sortedTrades[sortedTrades.length - 1];

  return {
    closeScaled: prices[prices.length - 1],
    feeTierBps: last.feeTier ?? null,
    highScaled,
    lane: first.lane,
    lowScaled,
    metadata: {
      vwap_price_source: 'normalized_execution_price',
      volume_source: 'canonical_amount_deltas',
    },
    openScaled: prices[0],
    pendingEnrichment,
    poolId: first.poolId,
    priceIsDecimalsNormalized: last.priceIsDecimalsNormalized,
    protocol: first.protocol,
    sourceEventIndex: last.sourceEventIndex,
    sqrtRatioClose: last.sqrtRatioAfter ?? null,
    sqrtRatioOpen: first.sqrtRatioAfter ?? null,
    tickClose: last.tickAfter ?? null,
    tickOpen: first.tickAfter ?? null,
    tickSpacing: last.tickSpacing ?? first.tickSpacing ?? null,
    token0Address: first.token0Address,
    token1Address: first.token1Address,
    tradeCount: BigInt(sortedTrades.length),
    transactionHash: last.transactionHash,
    transactionIndex: last.transactionIndex,
    volume0,
    volume0UsdScaled,
    volume1,
    volume1UsdScaled,
    volumeUsdScaled,
    vwapScaled: weightedPriceDenominator === 0n ? prices[prices.length - 1] : scaledDivide(weightedPriceNumerator, weightedPriceDenominator, DEFAULT_SCALE),
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
            pending_enrichment,
            tick_open,
            tick_close,
            sqrt_ratio_open,
            sqrt_ratio_close,
            fee_tier_bps,
            tick_spacing,
            volume0,
            volume1,
            volume0_usd,
            volume1_usd,
            volume_usd,
            vwap,
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
    feeTierBps: row.fee_tier_bps === null ? null : toBigIntStrict(row.fee_tier_bps, 'existing candle fee tier bps'),
    highScaled: decimalStringToScaled(row.high, DEFAULT_SCALE),
    lowScaled: decimalStringToScaled(row.low, DEFAULT_SCALE),
    openScaled: decimalStringToScaled(row.open, DEFAULT_SCALE),
    pendingEnrichment: row.pending_enrichment,
    priceIsDecimalsNormalized: row.price_is_decimals_normalized,
    protocol: row.protocol,
    seededFromPreviousClose: row.seeded_from_previous_close,
    sqrtRatioClose: row.sqrt_ratio_close === null ? null : toBigIntStrict(row.sqrt_ratio_close, 'existing candle sqrt ratio close'),
    sqrtRatioOpen: row.sqrt_ratio_open === null ? null : toBigIntStrict(row.sqrt_ratio_open, 'existing candle sqrt ratio open'),
    tickClose: row.tick_close === null ? null : toBigIntStrict(row.tick_close, 'existing candle tick close'),
    tickOpen: row.tick_open === null ? null : toBigIntStrict(row.tick_open, 'existing candle tick open'),
    tickSpacing: row.tick_spacing === null ? null : toBigIntStrict(row.tick_spacing, 'existing candle tick spacing'),
    token0Address: row.token0_address,
    token1Address: row.token1_address,
    tradeCount: toBigIntStrict(row.trade_count, 'existing candle trade count'),
    volume0: toBigIntStrict(row.volume0, 'existing candle volume0'),
    volume0UsdScaled: row.volume0_usd === null ? 0n : decimalStringToScaled(row.volume0_usd, DEFAULT_SCALE),
    volume1: toBigIntStrict(row.volume1, 'existing candle volume1'),
    volume1UsdScaled: row.volume1_usd === null ? 0n : decimalStringToScaled(row.volume1_usd, DEFAULT_SCALE),
    volumeUsdScaled: decimalStringToScaled(row.volume_usd, DEFAULT_SCALE),
    vwapScaled: row.vwap === null ? decimalStringToScaled(row.close, DEFAULT_SCALE) : decimalStringToScaled(row.vwap, DEFAULT_SCALE),
  };
}

async function loadPreviousCandle(client, { beforeBucketStart, lane, poolId }) {
  const result = await client.query(
    `SELECT bucket_start,
            close,
            price_is_decimals_normalized
            , pending_enrichment
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
    pendingEnrichment: result.rows[0].pending_enrichment,
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
            pending_enrichment,
            tick_after,
            sqrt_ratio_after,
            fee_tier,
            tick_spacing,
            hops_from_stable,
            is_aggregator_derived,
            amount0_delta,
            amount1_delta,
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

  const rows = result.rows.filter((row) => {
    if (row.is_aggregator_derived) {
      return false;
    }

    const maxHops = parseNonNegativeBigInt(process.env.PHASE3_MAX_OHLCV_HOPS_FROM_STABLE, 2n);
    if (row.hops_from_stable !== null && toBigIntStrict(row.hops_from_stable, 'rebuild hops from stable') > maxHops) {
      return false;
    }

    return true;
  });

  if (rows.length === 0) {
    return null;
  }

  const prices = rows.map((row) => decimalStringToScaled(row.price_token1_per_token0, DEFAULT_SCALE));
  let highScaled = prices[0];
  let lowScaled = prices[0];
  let volume0 = 0n;
  let volume1 = 0n;
  let volume0UsdScaled = 0n;
  let volume1UsdScaled = 0n;
  let volumeUsdScaled = 0n;
  let weightedPriceNumerator = 0n;
  let weightedPriceDenominator = 0n;
  let pendingEnrichment = false;

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const priceScaled = prices[index];
    const canonicalVolumes = deriveCanonicalTradeVolumes({
      amount0Delta: row.amount0_delta,
      amount1Delta: row.amount1_delta,
      volumeToken0: row.volume_token0,
      volumeToken1: row.volume_token1,
    });

    if (compareBigInt(priceScaled, highScaled) > 0) {
      highScaled = priceScaled;
    }

    if (compareBigInt(priceScaled, lowScaled) < 0) {
      lowScaled = priceScaled;
    }

    volume0 += canonicalVolumes.volume0;
    volume1 += canonicalVolumes.volume1;
    weightedPriceNumerator += scaledMultiply(priceScaled, canonicalVolumes.volume0, DEFAULT_SCALE);
    weightedPriceDenominator += canonicalVolumes.volume0;
    pendingEnrichment = pendingEnrichment || Boolean(row.pending_enrichment);

    if (row.notional_usd !== null) {
      const notionalUsdScaled = decimalStringToScaled(row.notional_usd, DEFAULT_SCALE);
      volume0UsdScaled += notionalUsdScaled;
      volume1UsdScaled += notionalUsdScaled;
      volumeUsdScaled += notionalUsdScaled;
    }
  }

  const first = rows[0];
  const last = rows[rows.length - 1];

  return {
    blockHash: last.block_hash,
    blockNumber: toBigIntStrict(last.block_number, 'candle block number'),
    bucketStart,
    closeScaled: prices[prices.length - 1],
    feeTierBps: last.fee_tier === null ? null : toBigIntStrict(last.fee_tier, 'rebuild fee tier'),
    highScaled,
    lane,
    lowScaled,
    metadata: {
      vwap_price_source: 'amount_usd_over_total_volume',
      volume_source: 'canonical_amount_deltas',
      pending_enrichment: pendingEnrichment,
      source: 'trades',
    },
    openScaled: prices[0],
    pendingEnrichment,
    poolId,
    priceIsDecimalsNormalized: last.price_is_decimals_normalized,
    protocol: first.protocol,
    seededFromPreviousClose: false,
    sourceEventIndex: toBigIntStrict(last.source_event_index, 'candle source event index'),
    sqrtRatioClose: last.sqrt_ratio_after === null ? null : toBigIntStrict(last.sqrt_ratio_after, 'rebuild sqrt ratio close'),
    sqrtRatioOpen: first.sqrt_ratio_after === null ? null : toBigIntStrict(first.sqrt_ratio_after, 'rebuild sqrt ratio open'),
    tickClose: last.tick_after === null ? null : toBigIntStrict(last.tick_after, 'rebuild tick close'),
    tickOpen: first.tick_after === null ? null : toBigIntStrict(first.tick_after, 'rebuild tick open'),
    tickSpacing: last.tick_spacing === null ? null : toBigIntStrict(last.tick_spacing, 'rebuild tick spacing'),
    token0Address: first.token0_address,
    token1Address: first.token1_address,
    tradeCount: BigInt(rows.length),
    transactionHash: last.transaction_hash,
    transactionIndex: toBigIntStrict(last.transaction_index, 'candle transaction index'),
    volume0,
    volume0UsdScaled,
    volume1,
    volume1UsdScaled,
    volumeUsdScaled,
    vwapScaled: computeExactRebuildVwapScaled({
      fallbackVwapScaled: weightedPriceDenominator === 0n ? prices[prices.length - 1] : scaledDivide(weightedPriceNumerator, weightedPriceDenominator, DEFAULT_SCALE),
      volume0,
      volumeUsdScaled,
    }),
  };
}

async function rebuildPendingEnrichmentCandles(client, { tokenAddresses }) {
  const normalizedTokenAddresses = Array.from(new Set((tokenAddresses ?? []).filter(Boolean)));
  if (normalizedTokenAddresses.length === 0) {
    return {
      rebuiltCandles: 0,
      touchedPools: 0,
    };
  }

  const ranges = await loadPendingEnrichmentRanges(client, normalizedTokenAddresses);
  let rebuiltCandles = 0;

  for (const range of ranges) {
    rebuiltCandles += await rebuildPendingRange(client, range);
  }

  return {
    rebuiltCandles,
    touchedPools: ranges.length,
  };
}

async function loadPendingEnrichmentRanges(client, tokenAddresses) {
  const result = await client.query(
    `SELECT lane,
            pool_id,
            MIN(bucket_start) AS from_bucket_start,
            MAX(bucket_start) AS to_bucket_start
       FROM stark_ohlcv_1m
      WHERE pending_enrichment = TRUE
        AND (
             token0_address = ANY($1::text[])
          OR token1_address = ANY($1::text[])
        )
      GROUP BY lane, pool_id
      ORDER BY lane ASC, pool_id ASC`,
    [tokenAddresses],
  );

  return result.rows.map((row) => ({
    fromBucketStart: row.from_bucket_start,
    lane: row.lane,
    poolId: row.pool_id,
    toBucketStart: row.to_bucket_start,
  }));
}

async function rebuildPendingRange(client, { fromBucketStart, lane, poolId, toBucketStart }) {
  const [existingCandles, tradeRows] = await Promise.all([
    loadCandlesInRange(client, { fromBucketStart, lane, poolId, toBucketStart }),
    loadTradesInRange(client, { fromBucketStart, lane, poolId, toBucketStart }),
  ]);

  if (existingCandles.length === 0) {
    return 0;
  }

  const existingByBucket = new Map(existingCandles.map((candle) => [candle.bucketStart.toISOString(), candle]));
  const tradesByBucket = new Map();

  for (const trade of tradeRows) {
    const key = trade.bucketStart.toISOString();
    if (!tradesByBucket.has(key)) {
      tradesByBucket.set(key, []);
    }
    tradesByBucket.get(key).push(trade);
  }

  const sortedBucketKeys = Array.from(existingByBucket.keys()).sort();
  let previousCandle = await loadPreviousCandle(client, { beforeBucketStart: fromBucketStart, lane, poolId });
  let previousCloseScaled = previousCandle ? decimalStringToScaled(previousCandle.close, DEFAULT_SCALE) : null;
  let previousPendingEnrichment = previousCandle ? Boolean(previousCandle.pendingEnrichment) : false;
  let rebuilt = 0;

  for (const bucketKey of sortedBucketKeys) {
    const bucketStart = new Date(bucketKey);
    const existing = existingByBucket.get(bucketKey);
    const bucketTrades = tradesByBucket.get(bucketKey) ?? [];
    let nextCandle;

    const eligibleBucketTrades = filterTradesForOhlcv(bucketTrades);

    if (eligibleBucketTrades.length > 0) {
      const tradeAggregate = aggregateBucketTrades(eligibleBucketTrades);
      nextCandle = {
        blockHash: tradeAggregate.blockHash ?? eligibleBucketTrades[eligibleBucketTrades.length - 1].blockHash,
        blockNumber: eligibleBucketTrades[eligibleBucketTrades.length - 1].blockNumber,
        bucketStart,
        closeScaled: tradeAggregate.closeScaled,
        feeTierBps: tradeAggregate.feeTierBps,
        highScaled: tradeAggregate.highScaled,
        lane,
        lowScaled: tradeAggregate.lowScaled,
        metadata: {
          cache_mode: 'pending_enrichment_rebuild',
          pending_enrichment: tradeAggregate.pendingEnrichment,
          source: 'trades',
          vwap_price_source: 'amount_usd_over_total_volume',
        },
        openScaled: tradeAggregate.openScaled,
        pendingEnrichment: tradeAggregate.pendingEnrichment,
        poolId,
        priceIsDecimalsNormalized: tradeAggregate.priceIsDecimalsNormalized,
        protocol: tradeAggregate.protocol,
        seededFromPreviousClose: false,
        sourceEventIndex: tradeAggregate.sourceEventIndex,
        sqrtRatioClose: tradeAggregate.sqrtRatioClose,
        sqrtRatioOpen: tradeAggregate.sqrtRatioOpen,
        tickClose: tradeAggregate.tickClose,
        tickOpen: tradeAggregate.tickOpen,
        tickSpacing: tradeAggregate.tickSpacing,
        token0Address: tradeAggregate.token0Address,
        token1Address: tradeAggregate.token1Address,
        tradeCount: tradeAggregate.tradeCount,
        transactionHash: tradeAggregate.transactionHash,
        transactionIndex: tradeAggregate.transactionIndex,
        volume0: tradeAggregate.volume0,
        volume0UsdScaled: tradeAggregate.volume0UsdScaled,
        volume1: tradeAggregate.volume1,
        volume1UsdScaled: tradeAggregate.volume1UsdScaled,
        volumeUsdScaled: tradeAggregate.volumeUsdScaled,
        vwapScaled: computeExactRebuildVwapScaled({
          fallbackVwapScaled: tradeAggregate.vwapScaled,
          volume0: tradeAggregate.volume0,
          volumeUsdScaled: tradeAggregate.volumeUsdScaled,
        }),
      };
    } else if (previousCloseScaled !== null) {
      nextCandle = {
        blockHash: existing.blockHash,
        blockNumber: existing.blockNumber,
        bucketStart,
        closeScaled: previousCloseScaled,
        highScaled: previousCloseScaled,
        lane,
        lowScaled: previousCloseScaled,
        metadata: {
          cache_mode: 'pending_enrichment_gap_rebuild',
          pending_enrichment: previousPendingEnrichment,
          source: 'seeded_from_previous_close',
        },
        openScaled: previousCloseScaled,
        pendingEnrichment: previousPendingEnrichment,
        poolId,
        priceIsDecimalsNormalized: existing.priceIsDecimalsNormalized,
        protocol: existing.protocol,
        feeTierBps: existing.feeTierBps ?? null,
        seededFromPreviousClose: true,
        sourceEventIndex: existing.sourceEventIndex,
        sqrtRatioClose: existing.sqrtRatioClose ?? null,
        sqrtRatioOpen: existing.sqrtRatioOpen ?? null,
        tickClose: existing.tickClose ?? null,
        tickOpen: existing.tickOpen ?? null,
        tickSpacing: existing.tickSpacing ?? null,
        token0Address: existing.token0Address,
        token1Address: existing.token1Address,
        tradeCount: 0n,
        transactionHash: existing.transactionHash,
        transactionIndex: existing.transactionIndex,
        volume0: 0n,
        volume0UsdScaled: 0n,
        volume1: 0n,
        volume1UsdScaled: 0n,
        volumeUsdScaled: 0n,
        vwapScaled: previousCloseScaled,
      };
    } else {
      continue;
    }

    await upsertCandle(client, nextCandle);
    previousCloseScaled = nextCandle.closeScaled;
    previousPendingEnrichment = nextCandle.pendingEnrichment;
    rebuilt += 1;
  }

  return rebuilt;
}

async function loadCandlesInRange(client, { fromBucketStart, lane, poolId, toBucketStart }) {
  const result = await client.query(
    `SELECT protocol,
            token0_address,
            token1_address,
            bucket_start,
            block_number,
            block_hash,
            transaction_hash,
            transaction_index,
            source_event_index,
            price_is_decimals_normalized,
            pending_enrichment,
            tick_open,
            tick_close,
            sqrt_ratio_open,
            sqrt_ratio_close,
            fee_tier_bps,
            tick_spacing
       FROM stark_ohlcv_1m
      WHERE lane = $1
        AND pool_id = $2
        AND bucket_start >= $3
        AND bucket_start <= $4
      ORDER BY bucket_start ASC`,
    [lane, poolId, fromBucketStart, toBucketStart],
  );

  return result.rows.map((row) => ({
    blockHash: row.block_hash,
    blockNumber: toBigIntStrict(row.block_number, 'pending candle block number'),
    bucketStart: row.bucket_start,
    feeTierBps: row.fee_tier_bps === null ? null : toBigIntStrict(row.fee_tier_bps, 'pending candle fee tier'),
    pendingEnrichment: row.pending_enrichment,
    priceIsDecimalsNormalized: row.price_is_decimals_normalized,
    protocol: row.protocol,
    sqrtRatioClose: row.sqrt_ratio_close === null ? null : toBigIntStrict(row.sqrt_ratio_close, 'pending candle sqrt close'),
    sqrtRatioOpen: row.sqrt_ratio_open === null ? null : toBigIntStrict(row.sqrt_ratio_open, 'pending candle sqrt open'),
    sourceEventIndex: row.source_event_index === null ? null : toBigIntStrict(row.source_event_index, 'pending candle source event index'),
    tickClose: row.tick_close === null ? null : toBigIntStrict(row.tick_close, 'pending candle tick close'),
    tickOpen: row.tick_open === null ? null : toBigIntStrict(row.tick_open, 'pending candle tick open'),
    tickSpacing: row.tick_spacing === null ? null : toBigIntStrict(row.tick_spacing, 'pending candle tick spacing'),
    token0Address: row.token0_address,
    token1Address: row.token1_address,
    transactionHash: row.transaction_hash,
    transactionIndex: row.transaction_index === null ? null : toBigIntStrict(row.transaction_index, 'pending candle transaction index'),
  }));
}

async function loadTradesInRange(client, { fromBucketStart, lane, poolId, toBucketStart }) {
  const result = await client.query(
    `SELECT block_number,
            block_hash,
            transaction_hash,
            transaction_index,
            source_event_index,
            protocol,
            token0_address,
            token1_address,
            bucket_1m,
            price_token1_per_token0,
            price_is_decimals_normalized,
            pending_enrichment,
            tick_after,
            sqrt_ratio_after,
            fee_tier,
            tick_spacing,
            hops_from_stable,
            is_aggregator_derived,
            amount0_delta,
            amount1_delta,
            volume_token0,
            volume_token1,
            notional_usd
       FROM stark_trades
      WHERE lane = $1
        AND pool_id = $2
        AND bucket_1m >= $3
        AND bucket_1m <= $4
      ORDER BY bucket_1m ASC, transaction_index ASC, source_event_index ASC, trade_key ASC`,
    [lane, poolId, fromBucketStart, toBucketStart],
  );

  return result.rows.map((row) => ({
    amount0Delta: row.amount0_delta === null ? null : toBigIntStrict(row.amount0_delta, 'pending trade amount0 delta'),
    amount1Delta: row.amount1_delta === null ? null : toBigIntStrict(row.amount1_delta, 'pending trade amount1 delta'),
    blockHash: row.block_hash,
    blockNumber: toBigIntStrict(row.block_number, 'pending trade block number'),
    bucketStart: row.bucket_1m,
    feeTier: row.fee_tier === null ? null : toBigIntStrict(row.fee_tier, 'pending trade fee tier'),
    hopsFromStable: row.hops_from_stable === null ? null : toBigIntStrict(row.hops_from_stable, 'pending trade hops from stable'),
    isAggregatorDerived: row.is_aggregator_derived,
    lane,
    notionalUsdScaled: row.notional_usd === null ? null : decimalStringToScaled(row.notional_usd, DEFAULT_SCALE),
    pendingEnrichment: row.pending_enrichment,
    poolId,
    priceIsDecimalsNormalized: row.price_is_decimals_normalized,
    priceToken1PerToken0Scaled: decimalStringToScaled(row.price_token1_per_token0, DEFAULT_SCALE),
    protocol: row.protocol,
    sqrtRatioAfter: row.sqrt_ratio_after === null ? null : toBigIntStrict(row.sqrt_ratio_after, 'pending trade sqrt ratio after'),
    sourceEventIndex: toBigIntStrict(row.source_event_index, 'pending trade source event index'),
    tickAfter: row.tick_after === null ? null : toBigIntStrict(row.tick_after, 'pending trade tick after'),
    tickSpacing: row.tick_spacing === null ? null : toBigIntStrict(row.tick_spacing, 'pending trade tick spacing'),
    token0Address: row.token0_address,
    token1Address: row.token1_address,
    tradeKey: `${row.transaction_hash}:${row.source_event_index}`,
    transactionHash: row.transaction_hash,
    transactionIndex: toBigIntStrict(row.transaction_index, 'pending trade transaction index'),
    volumeToken0: toBigIntStrict(row.volume_token0, 'pending trade volume0'),
    volumeToken1: toBigIntStrict(row.volume_token1, 'pending trade volume1'),
  }));
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
         tick_open,
         tick_close,
         sqrt_ratio_open,
         sqrt_ratio_close,
         fee_tier_bps,
         tick_spacing,
         price_is_decimals_normalized,
         pending_enrichment,
         volume0,
         volume1,
         volume0_usd,
         volume1_usd,
         volume_usd,
         vwap,
         trade_count,
         seeded_from_previous_close,
         metadata,
         created_at,
         updated_at
     ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
         $21, $22, $23, $24, $25, $26, $27, $28, $29, $30,
         $31, $32, $33::jsonb, NOW(), NOW()
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
         tick_open = EXCLUDED.tick_open,
         tick_close = EXCLUDED.tick_close,
         sqrt_ratio_open = EXCLUDED.sqrt_ratio_open,
         sqrt_ratio_close = EXCLUDED.sqrt_ratio_close,
         fee_tier_bps = EXCLUDED.fee_tier_bps,
         tick_spacing = EXCLUDED.tick_spacing,
         price_is_decimals_normalized = EXCLUDED.price_is_decimals_normalized,
         pending_enrichment = EXCLUDED.pending_enrichment,
         volume0 = EXCLUDED.volume0,
         volume1 = EXCLUDED.volume1,
         volume0_usd = EXCLUDED.volume0_usd,
         volume1_usd = EXCLUDED.volume1_usd,
         volume_usd = EXCLUDED.volume_usd,
         vwap = EXCLUDED.vwap,
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
      candle.tickOpen === null || candle.tickOpen === undefined ? null : toNumericString(candle.tickOpen, 'candle tick open'),
      candle.tickClose === null || candle.tickClose === undefined ? null : toNumericString(candle.tickClose, 'candle tick close'),
      candle.sqrtRatioOpen === null || candle.sqrtRatioOpen === undefined ? null : toNumericString(candle.sqrtRatioOpen, 'candle sqrt ratio open'),
      candle.sqrtRatioClose === null || candle.sqrtRatioClose === undefined ? null : toNumericString(candle.sqrtRatioClose, 'candle sqrt ratio close'),
      candle.feeTierBps === null || candle.feeTierBps === undefined ? null : toNumericString(candle.feeTierBps, 'candle fee tier bps'),
      candle.tickSpacing === null || candle.tickSpacing === undefined ? null : toNumericString(candle.tickSpacing, 'candle tick spacing'),
      candle.priceIsDecimalsNormalized,
      candle.pendingEnrichment,
      toNumericString(candle.volume0, 'candle volume0'),
      toNumericString(candle.volume1, 'candle volume1'),
      candle.volume0UsdScaled === null || candle.volume0UsdScaled === undefined ? null : scaledToNumericString(candle.volume0UsdScaled, DEFAULT_SCALE),
      candle.volume1UsdScaled === null || candle.volume1UsdScaled === undefined ? null : scaledToNumericString(candle.volume1UsdScaled, DEFAULT_SCALE),
      scaledToNumericString(candle.volumeUsdScaled, DEFAULT_SCALE),
      candle.vwapScaled === null || candle.vwapScaled === undefined ? null : scaledToNumericString(candle.vwapScaled, DEFAULT_SCALE),
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
    pendingEnrichment: candle.pendingEnrichment,
    poolId: candle.poolId,
    priceIsDecimalsNormalized: candle.priceIsDecimalsNormalized,
    protocol: candle.protocol,
    seededFromPreviousClose: candle.seededFromPreviousClose,
    tradeCount: candle.tradeCount.toString(10),
    volume0: candle.volume0.toString(10),
    volume1: candle.volume1.toString(10),
    volumeUsd: scaledToNumericString(candle.volumeUsdScaled, DEFAULT_SCALE),
    vwap: candle.vwapScaled === null || candle.vwapScaled === undefined ? null : scaledToNumericString(candle.vwapScaled, DEFAULT_SCALE),
  };
}

function combineVwap(existingCandle, tradeAggregate) {
  const leftWeight = existingCandle.volume0;
  const rightWeight = tradeAggregate.volume0;
  const totalWeight = leftWeight + rightWeight;

  if (totalWeight === 0n) {
    return tradeAggregate.vwapScaled;
  }

  const leftWeighted = scaledMultiply(existingCandle.vwapScaled ?? existingCandle.closeScaled, leftWeight, DEFAULT_SCALE);
  const rightWeighted = scaledMultiply(tradeAggregate.vwapScaled, rightWeight, DEFAULT_SCALE);
  return scaledDivide(leftWeighted + rightWeighted, totalWeight, DEFAULT_SCALE);
}

function computeExactRebuildVwapScaled({ fallbackVwapScaled, volume0, volumeUsdScaled }) {
  if (volume0 !== null && volume0 !== undefined && volume0 > 0n && volumeUsdScaled !== null && volumeUsdScaled !== undefined) {
    return scaledDivide(volumeUsdScaled, volume0, DEFAULT_SCALE);
  }

  return fallbackVwapScaled;
}

function parseNonNegativeBigInt(value, fallbackValue) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallbackValue;
  }

  try {
    const parsed = BigInt(String(value).trim());
    return parsed >= 0n ? parsed : fallbackValue;
  } catch (error) {
    return fallbackValue;
  }
}

module.exports = {
  persistOhlcvForBlock,
  rebuildPendingEnrichmentCandles,
};
