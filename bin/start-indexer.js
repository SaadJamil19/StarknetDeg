#!/usr/bin/env node
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { setTimeout: sleep } = require('node:timers/promises');
const { syncRegistryToDatabase } = require('../core/abi-registry');
const { prefetchAcceptedBlockPayloads, processAcceptedBlock, reconcileTurboBackfillIndexes } = require('../core/block-processor');
const {
  assertFoundationTables,
  assertPhase2Tables,
  assertPhase3Tables,
  assertPhase4Tables,
  assertMetadataSyncTables,
  assertSchemaEnhancementTables,
  assertSchemaEnhancementViews,
  assertPoolTaxonomyTables,
  assertTradeChainingTables,
  ensureIndexStateRows,
  getBlockJournalRange,
  getCheckpoint,
  resolveInitialIndexerStartBlock,
} = require('../core/checkpoint');
const { seedKnownTokens } = require('../core/token-registry');
const { FINALITY_LANES, normalizeFinalityStatus } = require('../core/finality');
const { closePool, isFatalDatabaseError, withClient, withTransaction } = require('../lib/db');
const { closeRedis } = require('../lib/redis');
const { StarknetRpcClient } = require('../lib/starknet-rpc');
const { toBigIntStrict } = require('../lib/cairo/bigint');

let shuttingDown = false;

async function main() {
  const indexerKey = process.env.INDEXER_KEY || 'starknetdeg-mainnet';
  const lane = normalizeFinalityStatus(process.env.INDEXER_LANE || FINALITY_LANES.ACCEPTED_ON_L2);
  const pollIntervalMs = parsePositiveInteger(process.env.INDEXER_POLL_INTERVAL_MS, 10_000);
  const catchupBatchSize = parsePositiveInteger(process.env.INDEXER_CATCHUP_BATCH_SIZE, 50);
  const prefetchWindowSize = parsePositiveInteger(process.env.INDEXER_PREFETCH_WINDOW_SIZE, 50);
  const prefetchWindowMax = parsePositiveInteger(process.env.INDEXER_PREFETCH_WINDOW_MAX, 400);
  const smallBlockTxThreshold = parsePositiveInteger(process.env.INDEXER_SMALL_BLOCK_TX_THRESHOLD, 5);
  const smallBlockGrowthFactor = parsePositiveInteger(process.env.INDEXER_SMALL_BLOCK_GROWTH_FACTOR, 2);
  const configuredStartBlock = parseOptionalBigInt(process.env.INDEXER_START_BLOCK);
  const startMode = process.env.INDEXER_START_MODE || 'genesis';
  const startTargets = parseCsv(process.env.INDEXER_START_TARGETS);
  const turboMode = parseBoolean(process.env.INDEXER_TURBO_MODE, false);
  const turboParallelism = parsePositiveInteger(process.env.INDEXER_TURBO_PARALLELISM, 4);
  const prefetchConcurrency = Math.min(
    parsePositiveInteger(process.env.INDEXER_PREFETCH_CONCURRENCY, 10),
    turboParallelism,
    10,
  );
  const skipRealtime = parseBoolean(process.env.INDEXER_SKIP_REALTIME, turboMode);
  const rpcClient = new StarknetRpcClient();
  let adaptivePrefetchWindow = Math.min(prefetchWindowSize, prefetchWindowMax);
  let initialStartBlock = configuredStartBlock ?? 0n;

  if (lane !== FINALITY_LANES.ACCEPTED_ON_L2) {
    throw new Error(`Phase 4 start-indexer only supports ${FINALITY_LANES.ACCEPTED_ON_L2}.`);
  }

  installSignalHandlers();

  await withTransaction(async (client) => {
    await assertFoundationTables(client);
    await assertPhase2Tables(client);
    await assertPhase3Tables(client);
    await assertPhase4Tables(client);
    await assertMetadataSyncTables(client);
    await assertSchemaEnhancementTables(client);
    await assertSchemaEnhancementViews(client);
    await assertPoolTaxonomyTables(client);
    await assertTradeChainingTables(client);
    await syncRegistryToDatabase(client);
    await seedKnownTokens(client);
    await ensureIndexStateRows(client, indexerKey);
    initialStartBlock = await resolveInitialIndexerStartBlock(client, {
      configuredStartBlock,
      lane,
      startMode,
      startTargets,
    });
  });

  const journalRanges = await withClient((client) => getBlockJournalRange(client, { lane }));
  const rangeSummary = journalRanges.length === 0
    ? 'empty'
    : journalRanges.map((range) => `${range.lane}:${range.minBlockNumber?.toString() ?? 'none'}-${range.maxBlockNumber?.toString() ?? 'none'} rows=${range.rowCount.toString()}`).join(',');

  console.log(
    `[phase4] StarknetDeg indexer starting indexerKey=${indexerKey} lane=${lane} start_mode=${startMode} start_targets=${startTargets.length === 0 ? 'all' : startTargets.join('|')} initial_start_block=${initialStartBlock.toString()} turbo=${turboMode} turbo_parallelism=${turboParallelism} prefetch_concurrency=${prefetchConcurrency} skip_realtime=${skipRealtime} catchup_batch=${catchupBatchSize} prefetch_window=${adaptivePrefetchWindow}/${prefetchWindowMax} small_block_tx_threshold=${smallBlockTxThreshold} journal_range=${rangeSummary} previewLane=${FINALITY_LANES.PRE_CONFIRMED} anchorLane=${FINALITY_LANES.ACCEPTED_ON_L1}`,
  );

  while (!shuttingDown) {
    try {
      const latestAcceptedBlock = await rpcClient.getBlockNumber();
      const checkpoint = await withClient((client) => getCheckpoint(client, { indexerKey, lane }));
      const nextBlock = determineNextBlock(checkpoint, initialStartBlock);
      const turboIndexSummary = await reconcileTurboBackfillIndexes({
        blockNumber: nextBlock,
        latestHead: latestAcceptedBlock,
        turboMode,
      });

      if (turboIndexSummary.changed) {
        console.log(
          `[phase4] turbo index manager action=${turboIndexSummary.action} historical=${turboIndexSummary.historicalMode} indexes=${turboIndexSummary.indexCount} vacuum_analyzed=${Boolean(turboIndexSummary.vacuumAnalyzed)} maintenance_deferred=${Boolean(turboIndexSummary.maintenanceDeferred)} wal_throttle_count=${turboIndexSummary.walThrottleCount ?? 0}`,
        );
      }

      if (nextBlock > latestAcceptedBlock) {
        await sleep(pollIntervalMs);
        continue;
      }

      let processedInBatch = 0;
      let cursor = nextBlock;
      let smallBlocksInBatch = 0;
      let prefetchedPayloads = [];
      const batchStartedAt = Date.now();
      const effectiveBatchSize = turboMode
        ? Math.max(1, Math.min(catchupBatchSize, adaptivePrefetchWindow))
        : catchupBatchSize;

      if (turboMode) {
        const blockNumbers = [];
        let prefetchCursor = cursor;
        while (prefetchCursor <= latestAcceptedBlock && blockNumbers.length < effectiveBatchSize) {
          blockNumbers.push(prefetchCursor);
          prefetchCursor += 1n;
        }
        prefetchedPayloads = await prefetchAcceptedBlockPayloads({
          blockNumbers,
          concurrency: prefetchConcurrency,
          rpcClient,
        });
      }

      while (!shuttingDown && cursor <= latestAcceptedBlock && processedInBatch < effectiveBatchSize) {
        const result = await processAcceptedBlock({
          blockNumber: cursor,
          indexerKey,
          lane,
          prefetchedPayload: prefetchedPayloads[processedInBatch] ?? null,
          rpcClient,
          skipRealtime,
          turboMode,
        });

        console.log(
          `[phase4] committed block=${result.blockNumber.toString()} hash=${shortHash(result.blockHash)} status=${result.finalityStatus} tx=${result.summary.total} reverted=${result.summary.reverted} l1_handlers=${result.summary.l1Handlers} actions=${result.decodeSummary.actions} transfers=${result.decodeSummary.transfers} unknown_events=${result.decodeSummary.unknownEvents} trades=${result.phase3Summary.trades} price_ticks=${result.phase3Summary.priceTicks} stale_prices=${result.phase3Summary.stalePrices} pool_history=${result.phase3Summary.poolHistoryRows} pool_latest=${result.phase3Summary.poolLatestRows} candles=${result.phase3Summary.candles}`,
        );

        if (result.realtimeError) {
          console.error(`[phase4] realtime publish warning: ${result.realtimeError}`);
        }
        if (turboMode && Number(result.summary.total ?? 0) < smallBlockTxThreshold) {
          smallBlocksInBatch += 1;
        }

        cursor += 1n;
        processedInBatch += 1;
      }

      if (turboMode && processedInBatch > 0) {
        if (smallBlocksInBatch === processedInBatch && adaptivePrefetchWindow < prefetchWindowMax) {
          const grownWindow = Math.min(prefetchWindowMax, adaptivePrefetchWindow * smallBlockGrowthFactor);
          if (grownWindow !== adaptivePrefetchWindow) {
            adaptivePrefetchWindow = grownWindow;
            console.log(`[phase4] turbo window increased to ${adaptivePrefetchWindow} due to low-activity blocks`);
          }
        } else if (smallBlocksInBatch < Math.ceil(processedInBatch / 2) && adaptivePrefetchWindow > prefetchWindowSize) {
          const reducedWindow = Math.max(prefetchWindowSize, Math.floor(adaptivePrefetchWindow / smallBlockGrowthFactor));
          if (reducedWindow !== adaptivePrefetchWindow) {
            adaptivePrefetchWindow = reducedWindow;
            console.log(`[phase4] turbo window reduced to ${adaptivePrefetchWindow} due to higher-activity blocks`);
          }
        }
      }

      if (processedInBatch > 0) {
        const elapsedSeconds = Math.max((Date.now() - batchStartedAt) / 1000, 0.001);
        const currentBlock = cursor - 1n;
        const remainingLag = latestAcceptedBlock > currentBlock ? latestAcceptedBlock - currentBlock : 0n;
        const batchBps = processedInBatch / elapsedSeconds;
        console.log(
          `[phase4] progress current=${currentBlock.toString()} head=${latestAcceptedBlock.toString()} remaining_lag=${remainingLag.toString()} bps=${batchBps.toFixed(3)} processed=${processedInBatch}`,
        );
      }

      if (processedInBatch === 0) {
        await sleep(pollIntervalMs);
      }
    } catch (error) {
      console.error(`[phase4] indexer loop error: ${formatError(error)}`);
      if (isFatalDatabaseError(error)) {
        console.error('[phase4] fatal database connectivity issue detected; exiting for supervisor restart.');
        throw error;
      }
      await sleep(pollIntervalMs);
    }
  }

  const restoreSummary = await reconcileTurboBackfillIndexes({ forceRestore: true, turboMode: false });
  if (restoreSummary.changed) {
    console.log(
      `[phase4] turbo index manager action=${restoreSummary.action} historical=${restoreSummary.historicalMode} indexes=${restoreSummary.indexCount} vacuum_analyzed=${Boolean(restoreSummary.vacuumAnalyzed)} maintenance_deferred=${Boolean(restoreSummary.maintenanceDeferred)} wal_throttle_count=${restoreSummary.walThrottleCount ?? 0}`,
    );
  }

  await closeRedis();
  await closePool();
}

function determineNextBlock(checkpoint, configuredStartBlock) {
  if (checkpoint && checkpoint.lastProcessedBlockNumber !== null) {
    return checkpoint.lastProcessedBlockNumber + 1n;
  }

  return configuredStartBlock ?? 0n;
}

function parsePositiveInteger(value, fallbackValue) {
  if (!value) {
    return fallbackValue;
  }

  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer but received: ${value}`);
  }

  return parsed;
}

function parseBoolean(value, fallbackValue = false) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallbackValue;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parseCsv(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return [];
  }

  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseOptionalBigInt(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return null;
  }

  const parsed = toBigIntStrict(String(value).trim(), 'INDEXER_START_BLOCK');
  if (parsed < 0n) {
    throw new Error('INDEXER_START_BLOCK cannot be negative.');
  }

  return parsed;
}

function shortHash(hash) {
  if (!hash) {
    return 'unknown';
  }

  const normalized = String(hash);
  if (normalized.length <= 14) {
    return normalized;
  }

  return `${normalized.slice(0, 8)}...${normalized.slice(-6)}`;
}

function formatError(error) {
  if (!error) {
    return 'unknown error';
  }

  if (error.stack) {
    return error.stack;
  }

  return String(error.message || error);
}

function installSignalHandlers() {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      shuttingDown = true;
      console.log(`[phase4] received ${signal}, shutting down after current step.`);
    });
  }
}

main().catch(async (error) => {
  console.error(`[phase4] fatal startup error: ${formatError(error)}`);

  try {
    await reconcileTurboBackfillIndexes({ forceRestore: true, turboMode: false });
  } catch (restoreError) {
    console.error(`[phase4] turbo index restore error: ${formatError(restoreError)}`);
  }

  try {
    await closeRedis();
  } catch (redisError) {
    console.error(`[phase4] redis shutdown error: ${formatError(redisError)}`);
  }

  try {
    await closePool();
  } finally {
    process.exitCode = 1;
  }
});
