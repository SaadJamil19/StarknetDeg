'use strict';

const { setTimeout: sleep } = require('node:timers/promises');
const { toBigIntStrict, toNumericString } = require('../lib/cairo/bigint');
const { withClient, withTransaction } = require('../lib/db');
const { normalizeL1HandlerSender } = require('./bridge');
const {
  acquireCheckpointAdvisoryLock,
  advanceCheckpoint,
  ensureIndexStateRow,
  getCheckpoint,
} = require('./checkpoint');
const { decodeBlockFromRaw } = require('./event-router');
const { FINALITY_LANES, assertValidFinalityLane, normalizeFinalityStatus, summarizeBlockReceipts } = require('./finality');
const { normalizeAddress, normalizeHexArray, normalizeOptionalAddress, normalizeSelector } = require('./normalize');
const { persistTradesForBlock } = require('./trades');
const { persistPoolStateForBlock, resetPoolStateForBlock } = require('./pool-state');
const { persistPriceDataForBlock, resetLatestPricesForBlock } = require('./prices');
const { persistOhlcvForBlock } = require('./ohlcv');
const { publishBlockRealtimeUpdates } = require('./realtime');

const TURBO_BACKFILL_LIVE_BUFFER_BLOCKS = parseNonNegativeBigInt(
  process.env.INDEXER_TURBO_REBUILD_AT_LAG,
  10_000n,
  'INDEXER_TURBO_REBUILD_AT_LAG',
);
const TURBO_BACKFILL_INDEX_DEFS = Object.freeze([
  { tableName: 'stark_transfers', name: 'stark_transfers_block_idx', createSql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS stark_transfers_block_idx ON stark_transfers (lane, block_number, transaction_index, source_event_index)' },
  { tableName: 'stark_transfers', name: 'stark_transfers_token_idx', createSql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS stark_transfers_token_idx ON stark_transfers (token_address, block_number)' },
  { tableName: 'stark_transfers', name: 'stark_transfers_address_idx', createSql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS stark_transfers_address_idx ON stark_transfers (from_address, to_address)' },
  { tableName: 'stark_transfers', name: 'stark_transfers_tx_idx', createSql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS stark_transfers_tx_idx ON stark_transfers (lane, transaction_hash, source_event_index)' },
  { tableName: 'stark_trades', name: 'stark_trades_block_idx', createSql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS stark_trades_block_idx ON stark_trades (lane, block_number, transaction_index, source_event_index)' },
  { tableName: 'stark_trades', name: 'stark_trades_pool_idx', createSql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS stark_trades_pool_idx ON stark_trades (lane, pool_id, block_timestamp)' },
  { tableName: 'stark_trades', name: 'stark_trades_bucket_idx', createSql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS stark_trades_bucket_idx ON stark_trades (lane, bucket_1m, pool_id)' },
  { tableName: 'stark_trades', name: 'stark_trades_token_idx', createSql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS stark_trades_token_idx ON stark_trades (token_in_address, token_out_address, block_number)' },
  { tableName: 'stark_trades', name: 'stark_trades_pending_enrichment_idx', createSql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS stark_trades_pending_enrichment_idx ON stark_trades (pending_enrichment, lane, block_number) WHERE pending_enrichment = TRUE' },
  { tableName: 'stark_trades', name: 'stark_trades_route_group_idx', createSql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS stark_trades_route_group_idx ON stark_trades (lane, route_group_key, transaction_hash)' },
  { tableName: 'stark_trades', name: 'stark_trades_tx_sequence_idx', createSql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS stark_trades_tx_sequence_idx ON stark_trades (lane, transaction_hash, transaction_index, source_event_index)' },
  { tableName: 'stark_trades', name: 'stark_trades_route_sequence_idx', createSql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS stark_trades_route_sequence_idx ON stark_trades (lane, route_group_key, sequence_id)' },
  { tableName: 'stark_trades', name: 'st_l1_wallet_idx', createSql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS st_l1_wallet_idx ON stark_trades (l1_wallet_address) WHERE l1_wallet_address IS NOT NULL' },
  { tableName: 'stark_trades', name: 'st_post_bridge_idx', createSql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS st_post_bridge_idx ON stark_trades (is_post_bridge_trade, block_timestamp) WHERE is_post_bridge_trade = TRUE' },
  { tableName: 'stark_pnl_audit_trail', name: 'stark_pnl_audit_trail_sell_idx', createSql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS stark_pnl_audit_trail_sell_idx ON stark_pnl_audit_trail (lane, sell_tx_hash, token_address, wallet_address)' },
  { tableName: 'stark_pnl_audit_trail', name: 'stark_pnl_audit_trail_buy_idx', createSql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS stark_pnl_audit_trail_buy_idx ON stark_pnl_audit_trail (lane, buy_tx_hash, token_address, wallet_address) WHERE buy_tx_hash IS NOT NULL' },
]);
const turboBackfillIndexState = {
  historicalMode: null,
};
const turboBackfillMaintenanceState = {
  error: null,
  promise: null,
  running: false,
  startedAt: null,
};
const TURBO_MAINTENANCE_WAIT_MS = 10 * 60 * 1000;
const TURBO_MAINTENANCE_WAL_GROWTH_BYTES = parseNonNegativeBigInt(process.env.INDEXER_TURBO_WAL_GROWTH_BYTES, 268435456n, 'INDEXER_TURBO_WAL_GROWTH_BYTES');
const TURBO_MAINTENANCE_WAL_SLEEP_MS = 60_000;
const TURBO_LOCAL_PREFETCH_SIZE = String(process.env.INDEXER_TURBO_LOCAL_PREFETCH_SIZE ?? '32MB').trim();
const TURBO_SESSION_FSYNC_OFF = parseBoolean(process.env.INDEXER_TURBO_SESSION_FSYNC_OFF, true);
const FAST_HEADER_PROBE_ENABLED = parseBoolean(process.env.INDEXER_FAST_HEADER_PROBE, true);
let turboLocalPrefetchSupported = null;
let turboFsyncSessionSupported = null;

function parseNonNegativeBigInt(value, fallbackValue, label) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallbackValue;
  }

  const parsed = BigInt(String(value).trim());
  if (parsed < 0n) {
    throw new Error(`${label} cannot be negative.`);
  }

  return parsed;
}

function parseBoolean(value, fallbackValue = false) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallbackValue;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function escapeSqlStringLiteral(value) {
  return String(value).replace(/'/g, "''");
}

async function runOptionalLocalSetting(client, statement) {
  await client.query('SAVEPOINT turbo_optional_setting');
  try {
    await client.query(statement);
    await client.query('RELEASE SAVEPOINT turbo_optional_setting');
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT turbo_optional_setting');
    await client.query('RELEASE SAVEPOINT turbo_optional_setting');
    throw error;
  }
}

async function processAcceptedBlock({
  rpcClient,
  indexerKey,
  lane = FINALITY_LANES.ACCEPTED_ON_L2,
  blockNumber,
  prefetchedPayload = null,
  headerOnlyOnEmpty = false,
  skipRealtime = false,
  turboMode = false,
  mirrorAcceptedOnL1Checkpoint = true,
}) {
  if (!rpcClient) {
    throw new Error('rpcClient is required.');
  }

  const canonicalLane = assertValidFinalityLane(lane);
  const requestedBlockNumber = toBigIntStrict(blockNumber, 'block number');

  if (canonicalLane !== FINALITY_LANES.ACCEPTED_ON_L2) {
    throw new Error(`Phase 3 canonical processor only supports ${FINALITY_LANES.ACCEPTED_ON_L2}. Received ${canonicalLane}.`);
  }

  const payload = prefetchedPayload ?? await fetchAcceptedBlockPayload({
    blockNumber: requestedBlockNumber,
    preferHeaderProbe: headerOnlyOnEmpty,
    rpcClient,
  });
  const { emitterClassHashes, normalized } = payload;
  const headerOnlyMode = Boolean(headerOnlyOnEmpty && Number(normalized.summary?.total ?? 0) === 0);
  if (normalized.blockNumber !== requestedBlockNumber) {
    throw new Error(`Prefetched payload block mismatch. Requested ${requestedBlockNumber.toString()}, received ${normalized.blockNumber.toString()}.`);
  }

  const committed = await withTransaction(async (client) => {
    if (turboMode) {
      await applyTurboSessionSettings(client);
    }

    await acquireCheckpointAdvisoryLock(client, {
      indexerKey,
      lane: canonicalLane,
    });
    await ensureIndexStateRow(client, indexerKey, canonicalLane);

    const checkpoint = await getCheckpoint(client, {
      forUpdate: true,
      indexerKey,
      lane: canonicalLane,
    });

    assertSequentialProgress(checkpoint, normalized);

    await markConflictingBlockRows(client, {
      blockHash: normalized.block.block_hash,
      blockNumber: normalized.blockNumber,
      lane: canonicalLane,
    });

    await clearBlockDerivedRows(client, {
      blockNumber: normalized.blockNumber,
      lane: canonicalLane,
    });

    await upsertBlockJournal(client, {
      lane: canonicalLane,
      normalized,
    });
    await upsertBlockStateUpdate(client, {
      lane: canonicalLane,
      normalized,
    });

    await upsertRawArtifacts(client, {
      emitterClassHashes,
      lane: canonicalLane,
      normalized,
    });

    if (headerOnlyMode) {
      await advanceCheckpoint(client, {
        blockHash: normalized.block.block_hash,
        blockNumber: normalized.blockNumber,
        finalityStatus: normalized.finalityStatus,
        indexerKey,
        lane: canonicalLane,
        newRoot: normalized.stateUpdate.new_root ?? null,
        oldRoot: normalized.stateUpdate.old_root ?? null,
        parentHash: normalized.block.parent_hash,
      });

      if (mirrorAcceptedOnL1Checkpoint && normalized.finalityStatus === FINALITY_LANES.ACCEPTED_ON_L1) {
        await ensureIndexStateRow(client, indexerKey, FINALITY_LANES.ACCEPTED_ON_L1);
        await advanceCheckpoint(client, {
          blockHash: normalized.block.block_hash,
          blockNumber: normalized.blockNumber,
          finalityStatus: normalized.finalityStatus,
          indexerKey,
          lane: FINALITY_LANES.ACCEPTED_ON_L1,
          newRoot: normalized.stateUpdate.new_root ?? null,
          oldRoot: normalized.stateUpdate.old_root ?? null,
          parentHash: normalized.block.parent_hash,
        });
      }

      return {
        blockHash: normalized.block.block_hash,
        blockNumber: normalized.blockNumber,
        decodeSummary: {
          actions: 0,
          transfers: 0,
          unknownEvents: 0,
        },
        finalityStatus: normalized.finalityStatus,
        phase3Summary: {
          candles: 0,
          fullRebuildCandles: 0,
          latestPrices: 0,
          poolHistoryRows: 0,
          poolLatestRows: 0,
          priceTicks: 0,
          seededCandles: 0,
          stalePrices: 0,
          trades: 0,
        },
        realtimePayload: {
          candles: [],
          trades: [],
        },
        summary: normalized.summary,
      };
    }

    const decodeSummary = await decodeBlockFromRaw(client, {
      blockHash: normalized.block.block_hash,
      blockNumber: normalized.blockNumber,
      lane: canonicalLane,
      rpcClient,
    });

    const blockTimestampDate = normalized.block.timestamp === undefined || normalized.block.timestamp === null
      ? new Date(0)
      : new Date(Number(toBigIntStrict(normalized.block.timestamp, 'block timestamp')) * 1000);
    const tradesResult = await persistTradesForBlock(client, {
      blockHash: normalized.block.block_hash,
      blockNumber: normalized.blockNumber,
      blockTimestamp: normalized.block.timestamp,
      lane: canonicalLane,
    });
    const poolStateResult = await persistPoolStateForBlock(client, {
      blockNumber: normalized.blockNumber,
      blockTimestampDate,
      lane: canonicalLane,
      latestUsdByToken: tradesResult.latestUsdByToken,
    });
    const pricesResult = await persistPriceDataForBlock(client, {
      priceCandidates: tradesResult.priceCandidates,
    });
    const ohlcvResult = await persistOhlcvForBlock(client, {
      blockHash: normalized.block.block_hash,
      blockNumber: normalized.blockNumber,
      lane: canonicalLane,
      trades: tradesResult.trades,
    });

    await advanceCheckpoint(client, {
      blockHash: normalized.block.block_hash,
      blockNumber: normalized.blockNumber,
      finalityStatus: normalized.finalityStatus,
      indexerKey,
      lane: canonicalLane,
      newRoot: normalized.stateUpdate.new_root ?? null,
      oldRoot: normalized.stateUpdate.old_root ?? null,
      parentHash: normalized.block.parent_hash,
    });

    if (mirrorAcceptedOnL1Checkpoint && normalized.finalityStatus === FINALITY_LANES.ACCEPTED_ON_L1) {
      await ensureIndexStateRow(client, indexerKey, FINALITY_LANES.ACCEPTED_ON_L1);
      await advanceCheckpoint(client, {
        blockHash: normalized.block.block_hash,
        blockNumber: normalized.blockNumber,
        finalityStatus: normalized.finalityStatus,
        indexerKey,
        lane: FINALITY_LANES.ACCEPTED_ON_L1,
        newRoot: normalized.stateUpdate.new_root ?? null,
        oldRoot: normalized.stateUpdate.old_root ?? null,
        parentHash: normalized.block.parent_hash,
      });
    }

    return {
      blockHash: normalized.block.block_hash,
      blockNumber: normalized.blockNumber,
      decodeSummary,
      finalityStatus: normalized.finalityStatus,
      phase3Summary: {
        candles: ohlcvResult.summary.touchedCandles,
        fullRebuildCandles: ohlcvResult.summary.fullRebuildCandles,
        latestPrices: pricesResult.summary.latestPrices,
        poolHistoryRows: poolStateResult.summary.poolHistoryRows,
        poolLatestRows: poolStateResult.summary.poolLatestRows,
        priceTicks: pricesResult.summary.priceTicks,
        seededCandles: ohlcvResult.summary.seededCandles,
        stalePrices: pricesResult.summary.stalePrices,
        trades: tradesResult.summary.trades,
      },
      realtimePayload: {
        candles: ohlcvResult.realtimeCandles,
        trades: tradesResult.realtimeTrades,
      },
      summary: normalized.summary,
    };
  });

  let realtimeSummary = null;
  let realtimeError = null;

  if (!skipRealtime) {
    try {
      realtimeSummary = await publishBlockRealtimeUpdates(committed.realtimePayload);
    } catch (error) {
      realtimeError = error.stack || error.message || String(error);
    }
  }

  return {
    ...committed,
    realtimeError,
    realtimeSkipped: Boolean(skipRealtime),
    realtimeSummary,
  };
}

async function fetchAcceptedBlockPayload({ rpcClient, blockNumber, prefetched = null, preferHeaderProbe = false }) {
  const requestedBlockNumber = toBigIntStrict(blockNumber, 'block number');
  const shouldProbeHeader = Boolean(
    preferHeaderProbe
    && FAST_HEADER_PROBE_ENABLED
    && typeof rpcClient?.getBlockWithTxHashes === 'function',
  );

  let block;
  let stateUpdate;
  let summaryOverride = prefetched?.summaryOverride ?? null;
  if (prefetched) {
    block = prefetched.block;
    stateUpdate = prefetched.stateUpdate;
  } else if (shouldProbeHeader) {
    const [headerBlock, resolvedStateUpdate] = await Promise.all([
      rpcClient.getBlockWithTxHashes(requestedBlockNumber),
      rpcClient.getStateUpdate(requestedBlockNumber),
    ]);
    const transactionCount = resolveHeaderTransactionCount(headerBlock);

    stateUpdate = resolvedStateUpdate;
    if (transactionCount === 0) {
      block = toReceiptCompatibleEmptyBlock(headerBlock);
      summaryOverride = buildEmptyBlockSummary(transactionCount);
    } else {
      block = await rpcClient.getBlockWithReceipts(requestedBlockNumber);
    }
  } else {
    [block, stateUpdate] = await Promise.all([
      rpcClient.getBlockWithReceipts(requestedBlockNumber),
      rpcClient.getStateUpdate(requestedBlockNumber),
    ]);
  }

  const normalized = normalizeFetchedBlock({
    block,
    requestedBlockNumber,
    stateUpdate,
    summaryOverride,
  });
  const emitterClassHashes = await resolveEmitterClassHashes({
    block: normalized.block,
    blockNumber: normalized.blockNumber,
    rpcClient,
  });

  return { emitterClassHashes, normalized };
}

async function prefetchAcceptedBlockPayloads({
  blockNumbers,
  concurrency = 4,
  preferHeaderProbe = false,
  rpcClient,
}) {
  const numbers = Array.from(blockNumbers ?? []);
  const results = new Array(numbers.length);
  const shouldProbeHeader = Boolean(preferHeaderProbe && FAST_HEADER_PROBE_ENABLED);
  const prefetchedRawPayloads = shouldProbeHeader
    ? await loadHeaderProbePayloads({ blockNumbers: numbers, rpcClient })
    : typeof rpcClient?.getBlockAndStateUpdateBatch === 'function'
      ? await rpcClient.getBlockAndStateUpdateBatch(numbers)
      : null;
  let cursor = 0;

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, numbers.length || 1)) }, async () => {
    while (cursor < numbers.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fetchAcceptedBlockPayload({
        blockNumber: numbers[index],
        prefetched: prefetchedRawPayloads ? prefetchedRawPayloads[index] : null,
        preferHeaderProbe: shouldProbeHeader,
        rpcClient,
      });
    }
  });

  await Promise.all(workers);
  return results;
}

async function loadHeaderProbePayloads({ blockNumbers, rpcClient }) {
  if (!Array.isArray(blockNumbers) || blockNumbers.length === 0) {
    return [];
  }

  const headerStatePayloads = typeof rpcClient?.getBlockHeaderAndStateUpdateBatch === 'function'
    ? await rpcClient.getBlockHeaderAndStateUpdateBatch(blockNumbers)
    : null;
  if (!headerStatePayloads) {
    return null;
  }

  const nonEmptyIndexes = [];
  const nonEmptyBlocks = [];
  const resolvedPayloads = new Array(blockNumbers.length);

  for (let index = 0; index < blockNumbers.length; index += 1) {
    const payload = headerStatePayloads[index] ?? null;
    const headerBlock = payload?.block ?? null;
    const stateUpdate = payload?.stateUpdate ?? null;
    const transactionCount = resolveHeaderTransactionCount(headerBlock);

    if (transactionCount === 0) {
      resolvedPayloads[index] = {
        block: toReceiptCompatibleEmptyBlock(headerBlock),
        stateUpdate,
        summaryOverride: buildEmptyBlockSummary(transactionCount),
      };
      continue;
    }

    nonEmptyIndexes.push(index);
    nonEmptyBlocks.push(toBigIntStrict(blockNumbers[index], 'non-empty block number'));
  }

  if (nonEmptyBlocks.length > 0) {
    const fullBlocks = typeof rpcClient?.getBlocksWithReceiptsBatch === 'function'
      ? await rpcClient.getBlocksWithReceiptsBatch(nonEmptyBlocks)
      : await Promise.all(nonEmptyBlocks.map((blockNumber) => rpcClient.getBlockWithReceipts(blockNumber)));

    for (let offset = 0; offset < nonEmptyIndexes.length; offset += 1) {
      const index = nonEmptyIndexes[offset];
      const headerPayload = headerStatePayloads[index];
      resolvedPayloads[index] = {
        block: fullBlocks[offset],
        stateUpdate: headerPayload?.stateUpdate ?? null,
      };
    }
  }

  return resolvedPayloads;
}

function resolveHeaderTransactionCount(block) {
  if (!block || typeof block !== 'object') {
    return 0;
  }

  if (block.transaction_count !== undefined && block.transaction_count !== null) {
    const parsed = Number.parseInt(String(block.transaction_count), 10);
    if (Number.isInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  if (Array.isArray(block.transactions)) {
    return block.transactions.length;
  }

  return 0;
}

function toReceiptCompatibleEmptyBlock(headerBlock) {
  if (!headerBlock || typeof headerBlock !== 'object') {
    return {
      transactions: [],
    };
  }

  return {
    ...headerBlock,
    transaction_count: headerBlock.transaction_count ?? 0,
    transactions: [],
  };
}

function buildEmptyBlockSummary(transactionCount = 0) {
  return {
    total: transactionCount,
    events: 0,
    l1Handlers: 0,
    reverted: 0,
    succeeded: transactionCount,
  };
}

async function applyTurboSessionSettings(client) {
  await client.query('SET LOCAL synchronous_commit = OFF');

  if (!TURBO_LOCAL_PREFETCH_SIZE || turboLocalPrefetchSupported === false) {
    if (!TURBO_SESSION_FSYNC_OFF || turboFsyncSessionSupported === false) {
      return;
    }
  }

  if (TURBO_SESSION_FSYNC_OFF && turboFsyncSessionSupported !== false) {
    try {
      await runOptionalLocalSetting(client, 'SET LOCAL fsync = OFF');
      turboFsyncSessionSupported = true;
    } catch (error) {
      const message = String(error?.message || '').toLowerCase();
      if (
        message.includes('unrecognized configuration parameter')
        || message.includes('cannot be changed now')
        || message.includes('permission denied')
      ) {
        turboFsyncSessionSupported = false;
      } else {
        throw error;
      }
    }
  }

  if (!TURBO_LOCAL_PREFETCH_SIZE || turboLocalPrefetchSupported === false) {
    return;
  }

  try {
    await runOptionalLocalSetting(
      client,
      `SET LOCAL local_prefetch_size = '${escapeSqlStringLiteral(TURBO_LOCAL_PREFETCH_SIZE)}'`,
    );
    turboLocalPrefetchSupported = true;
  } catch (error) {
    const message = String(error?.message || '').toLowerCase();
    if (message.includes('unrecognized configuration parameter')) {
      turboLocalPrefetchSupported = false;
      return;
    }

    throw error;
  }
}

async function reconcileTurboBackfillIndexes({
  blockNumber = null,
  forceRestore = false,
  latestHead = null,
  turboMode = false,
} = {}) {
  const normalizedBlockNumber = blockNumber === null || blockNumber === undefined
    ? null
    : toBigIntStrict(blockNumber, 'turbo index block number');
  const normalizedLatestHead = latestHead === null || latestHead === undefined
    ? null
    : toBigIntStrict(latestHead, 'turbo index latest head');
  const historicalMode = Boolean(
    turboMode
    && !forceRestore
    && normalizedBlockNumber !== null
    && normalizedLatestHead !== null
    && normalizedBlockNumber < (normalizedLatestHead - TURBO_BACKFILL_LIVE_BUFFER_BLOCKS)
  );

  return withClient(async (client) => {
    const indexIssues = await findTurboBackfillIndexIssues(client);
    const activeIndexDefs = indexIssues.defs;

    if (historicalMode) {
      if (turboBackfillIndexState.historicalMode === true) {
        return {
          action: 'noop',
          changed: false,
          historicalMode,
          indexCount: activeIndexDefs.length,
          invalidIndexes: 0,
          missingIndexes: 0,
        };
      }

      await dropTurboBackfillIndexes(client, { defs: activeIndexDefs });
      turboBackfillIndexState.historicalMode = true;
      return {
        action: 'dropped',
        changed: true,
        historicalMode,
        indexCount: activeIndexDefs.length,
        invalidIndexes: indexIssues.invalid.length,
        missingIndexes: indexIssues.missing.length,
      };
    }

    if (
      turboBackfillIndexState.historicalMode === false
      && indexIssues.missing.length === 0
      && indexIssues.invalid.length === 0
      && !forceRestore
    ) {
      return {
        action: 'noop',
        changed: false,
        historicalMode,
        indexCount: activeIndexDefs.length,
        invalidIndexes: 0,
        missingIndexes: 0,
      };
    }

    if (
      turboBackfillIndexState.historicalMode === true
      || indexIssues.missing.length > 0
      || indexIssues.invalid.length > 0
      || forceRestore
    ) {
      if (indexIssues.invalid.length > 0) {
        await dropTurboBackfillIndexes(client, {
          defs: activeIndexDefs,
          names: indexIssues.invalid,
        });
      }
      await createTurboBackfillIndexes(client, activeIndexDefs);
      const postCreateIssues = await findTurboBackfillIndexIssues(client);
      if (postCreateIssues.missing.length > 0 || postCreateIssues.invalid.length > 0) {
        throw new Error(
          `Turbo index health check failed. missing=${postCreateIssues.missing.join(',') || 'none'} invalid=${postCreateIssues.invalid.join(',') || 'none'}`,
        );
      }
      const maintenanceSummary = await ensureTurboBackfillMaintenance();
      turboBackfillIndexState.historicalMode = false;
      return {
        action: 'rebuilt',
        changed: true,
        historicalMode,
        indexCount: postCreateIssues.defs.length,
        invalidIndexes: 0,
        missingIndexes: 0,
        maintenanceDeferred: Boolean(maintenanceSummary.deferred),
        vacuumAnalyzed: Boolean(maintenanceSummary.completed),
        walThrottleCount: maintenanceSummary.walThrottleCount ?? 0,
      };
    }

    turboBackfillIndexState.historicalMode = false;
    return {
      action: 'noop',
      changed: false,
      historicalMode,
      indexCount: activeIndexDefs.length,
      invalidIndexes: 0,
      missingIndexes: 0,
      maintenanceDeferred: false,
      vacuumAnalyzed: false,
      walThrottleCount: 0,
    };
  });
}

async function findTurboBackfillIndexIssues(client) {
  const defs = await resolveActiveTurboBackfillIndexDefs(client);
  const expectedNames = defs.map((entry) => entry.name);
  if (expectedNames.length === 0) {
    return {
      defs,
      invalid: [],
      missing: [],
    };
  }
  const result = await client.query(
    `SELECT class.relname AS indexname,
            COALESCE(index_meta.indisvalid, FALSE) AS indisvalid
       FROM pg_class AS class
       LEFT JOIN pg_index AS index_meta
              ON index_meta.indexrelid = class.oid
      WHERE class.relkind = 'i'
        AND class.relname = ANY($1::text[])`,
    [expectedNames],
  );

  const existing = new Map(result.rows.map((row) => [row.indexname, Boolean(row.indisvalid)]));
  return {
    defs,
    invalid: expectedNames.filter((name) => existing.has(name) && existing.get(name) === false),
    missing: expectedNames.filter((name) => !existing.has(name)),
  };
}

async function resolveActiveTurboBackfillIndexDefs(client) {
  const uniqueTableNames = [...new Set(TURBO_BACKFILL_INDEX_DEFS.map((entry) => entry.tableName))];
  const result = await client.query(
    `SELECT table_name,
            to_regclass('public.' || table_name) IS NOT NULL AS table_exists
       FROM unnest($1::text[]) AS table_name`,
    [uniqueTableNames],
  );
  const existingTables = new Set(
    result.rows
      .filter((row) => Boolean(row.table_exists))
      .map((row) => row.table_name),
  );

  return TURBO_BACKFILL_INDEX_DEFS.filter((entry) => existingTables.has(entry.tableName));
}

async function dropTurboBackfillIndexes(client, { defs = null, names = null } = {}) {
  const activeDefs = defs ?? await resolveActiveTurboBackfillIndexDefs(client);
  const allowedNames = new Set(activeDefs.map((entry) => entry.name));
  const targetNames = (names ?? activeDefs.map((entry) => entry.name))
    .filter((name) => allowedNames.has(name));

  for (const name of targetNames) {
    await client.query(`DROP INDEX CONCURRENTLY IF EXISTS public.${name}`);
  }
}

async function createTurboBackfillIndexes(client, defs = null) {
  const activeDefs = defs ?? await resolveActiveTurboBackfillIndexDefs(client);
  for (const entry of activeDefs) {
    await client.query(entry.createSql);
  }
}

async function vacuumAnalyzeTurboBackfillTables(client) {
  const versionResult = await client.query(`SELECT current_setting('server_version_num') AS server_version_num`);
  const serverVersionNum = Number.parseInt(String(versionResult.rows[0]?.server_version_num ?? '0'), 10);
  const vacuumStatement = serverVersionNum >= 130000
    ? 'VACUUM (ANALYZE, PARALLEL 4)'
    : 'VACUUM ANALYZE';

  await client.query(`SET vacuum_cost_delay = '10ms'`);
  await client.query(`SET vacuum_cost_limit = 200`);

  const tablesToVacuum = await resolveTurboMaintenanceTables(client);
  let walThrottleCount = 0;
  for (const tableName of tablesToVacuum) {
    const walStartLsn = await readCurrentWalLsn(client);
    await client.query(`${vacuumStatement} ${tableName}`);
    const walGrowthBytes = walStartLsn === null
      ? null
      : await readWalGrowthBytes(client, walStartLsn);
    if (walGrowthBytes !== null && walGrowthBytes > TURBO_MAINTENANCE_WAL_GROWTH_BYTES) {
      walThrottleCount += 1;
      await sleep(TURBO_MAINTENANCE_WAL_SLEEP_MS);
    }
  }

  return {
    walThrottleCount,
  };
}

async function resolveTurboMaintenanceTables(client) {
  const result = await client.query(
    `SELECT table_name,
            to_regclass('public.' || table_name) IS NOT NULL AS table_exists
       FROM unnest($1::text[]) AS table_name`,
    [['stark_transfers', 'stark_trades', 'stark_pnl_audit_trail']],
  );

  return result.rows
    .filter((row) => Boolean(row.table_exists))
    .map((row) => row.table_name);
}

async function readCurrentWalLsn(client) {
  const result = await client.query(`SELECT pg_current_wal_lsn() AS wal_lsn`);
  return result.rows[0]?.wal_lsn ?? null;
}

async function readWalGrowthBytes(client, previousWalLsn) {
  if (!previousWalLsn) {
    return null;
  }

  const result = await client.query(
    `SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), $1::pg_lsn) AS wal_growth_bytes`,
    [previousWalLsn],
  );
  const value = result.rows[0]?.wal_growth_bytes ?? null;
  return value === null ? null : toBigIntStrict(value, 'turbo maintenance wal growth bytes');
}

async function ensureTurboBackfillMaintenance() {
  if (!turboBackfillMaintenanceState.promise) {
    turboBackfillMaintenanceState.running = true;
    turboBackfillMaintenanceState.startedAt = Date.now();
    turboBackfillMaintenanceState.error = null;
    turboBackfillMaintenanceState.promise = withClient(async (client) => {
      try {
        const maintenanceSummary = await vacuumAnalyzeTurboBackfillTables(client);
        return { ...maintenanceSummary, completed: true, deferred: false };
      } finally {
        turboBackfillMaintenanceState.running = false;
      }
    }).catch((error) => {
      turboBackfillMaintenanceState.error = error;
      return {
        completed: false,
        deferred: false,
        error: error.message || String(error),
        walThrottleCount: 0,
      };
    }).finally(() => {
      turboBackfillMaintenanceState.promise = null;
    });
  }

  return Promise.race([
    turboBackfillMaintenanceState.promise,
    new Promise((resolve) => setTimeout(() => resolve({ completed: false, deferred: true, walThrottleCount: 0 }), TURBO_MAINTENANCE_WAIT_MS)),
  ]);
}

function normalizeFetchedBlock({ block, stateUpdate, requestedBlockNumber, summaryOverride = null }) {
  if (!block || typeof block !== 'object') {
    throw new Error('starknet_getBlockWithReceipts returned an empty payload.');
  }

  if (!stateUpdate || typeof stateUpdate !== 'object') {
    throw new Error('starknet_getStateUpdate returned an empty payload.');
  }

  const blockNumber = toBigIntStrict(block.block_number, 'block.block_number');
  if (blockNumber !== requestedBlockNumber) {
    throw new Error(`Block number mismatch. Requested ${requestedBlockNumber.toString()}, received ${blockNumber.toString()}.`);
  }

  if (!block.block_hash || !block.parent_hash) {
    throw new Error('Block payload is missing block_hash or parent_hash.');
  }

  if (stateUpdate.block_hash && String(stateUpdate.block_hash).toLowerCase() !== String(block.block_hash).toLowerCase()) {
    throw new Error(`State update hash mismatch for block ${blockNumber.toString()}.`);
  }

  if (stateUpdate.new_root && block.new_root && String(stateUpdate.new_root).toLowerCase() !== String(block.new_root).toLowerCase()) {
    throw new Error(`State update new_root mismatch for block ${blockNumber.toString()}.`);
  }

  return {
    block,
    blockNumber,
    finalityStatus: normalizeFinalityStatus(block.status),
    requestedBlockNumber,
    stateUpdate,
    summary: summaryOverride ?? summarizeBlockReceipts(block),
  };
}

function assertSequentialProgress(checkpoint, normalized) {
  if (!checkpoint || checkpoint.lastProcessedBlockNumber === null) {
    return;
  }

  const expectedBlockNumber = checkpoint.lastProcessedBlockNumber + 1n;
  if (normalized.blockNumber !== expectedBlockNumber) {
    throw new Error(
      `Checkpoint gap detected for ${checkpoint.indexerKey}/${checkpoint.lane}. Expected block ${expectedBlockNumber.toString()}, received ${normalized.blockNumber.toString()}.`,
    );
  }

  if (
    checkpoint.lastProcessedBlockHash &&
    String(normalized.block.parent_hash).toLowerCase() !== String(checkpoint.lastProcessedBlockHash).toLowerCase()
  ) {
    throw new Error(
      `Parent hash mismatch at block ${normalized.blockNumber.toString()}. Expected parent ${checkpoint.lastProcessedBlockHash}, received ${normalized.block.parent_hash}.`,
    );
  }
}

async function markConflictingBlockRows(client, { lane, blockNumber, blockHash }) {
  await client.query(
    `UPDATE stark_block_journal
        SET is_orphaned = TRUE,
            orphaned_at = NOW(),
            updated_at = NOW()
      WHERE lane = $1
        AND block_number = $2
        AND block_hash <> $3
        AND is_orphaned = FALSE`,
    [lane, toNumericString(blockNumber, 'block number'), blockHash],
  );
  await clearPendingRedecodeDiscrepanciesForOrphanedBlock(client, { lane, blockNumber });
}

async function clearPendingRedecodeDiscrepanciesForOrphanedBlock(client, { lane, blockNumber }) {
  const tableCheck = await client.query(`SELECT to_regclass('public.stark_audit_discrepancies') AS regclass`);
  if (tableCheck.rows[0]?.regclass === null) {
    return;
  }

  await client.query(
    `DELETE FROM stark_audit_discrepancies AS audit
      WHERE audit.lane = $1
        AND audit.block_number = $2
        AND audit.resolution_status = 'PENDING_REDECODE'
        AND NOT EXISTS (
             SELECT 1
               FROM stark_block_journal AS journal
              WHERE journal.lane = audit.lane
                AND journal.block_number = audit.block_number
                AND journal.block_hash = audit.block_hash
                AND journal.is_orphaned = FALSE
        )`,
    [lane, toNumericString(blockNumber, 'pending redecode cleanup block number')],
  );
}

async function clearBlockDerivedRows(client, { lane, blockNumber }) {
  const params = [lane, toNumericString(blockNumber, 'block number')];
  const statements = [
    'DELETE FROM stark_block_state_updates WHERE lane = $1 AND block_number = $2',
    'DELETE FROM stark_ohlcv_1m WHERE lane = $1 AND block_number = $2',
    'DELETE FROM stark_trades WHERE lane = $1 AND block_number = $2',
    'DELETE FROM stark_action_norm WHERE lane = $1 AND block_number = $2',
    'DELETE FROM stark_transfers WHERE lane = $1 AND block_number = $2',
    'DELETE FROM stark_bridge_activities WHERE lane = $1 AND block_number = $2',
    'DELETE FROM stark_unknown_event_audit WHERE lane = $1 AND block_number = $2',
    'DELETE FROM stark_event_raw WHERE lane = $1 AND block_number = $2',
    'DELETE FROM stark_message_l2_to_l1 WHERE lane = $1 AND block_number = $2',
    'DELETE FROM stark_tx_raw WHERE lane = $1 AND block_number = $2',
  ];

  await resetLatestPricesForBlock(client, { blockNumber, lane });
  await resetPoolStateForBlock(client, { blockNumber, lane });

  for (const statement of statements) {
    await client.query(statement, params);
  }
}

async function upsertBlockJournal(client, { lane, normalized }) {
  const { block, stateUpdate, finalityStatus, summary } = normalized;

  await client.query(
    `INSERT INTO stark_block_journal (
         lane,
         block_number,
         block_hash,
         parent_hash,
         old_root,
         new_root,
         finality_status,
         block_timestamp,
         sequencer_address,
         starknet_version,
         l1_da_mode,
         transaction_count,
         event_count,
         state_diff_length,
         succeeded_transaction_count,
         reverted_transaction_count,
         l1_handler_transaction_count,
         is_orphaned,
         orphaned_at,
         raw_block,
         raw_state_update,
         created_at,
         updated_at
     ) VALUES (
         $1,
         $2,
         $3,
         $4,
         $5,
         $6,
         $7,
         $8,
         $9,
         $10,
         $11,
         $12,
         $13,
         $14,
         $15,
         $16,
         $17,
         FALSE,
         NULL,
         $18::jsonb,
         $19::jsonb,
         NOW(),
         NOW()
     )
     ON CONFLICT (lane, block_number, block_hash)
     DO UPDATE SET
         parent_hash = EXCLUDED.parent_hash,
         old_root = EXCLUDED.old_root,
         new_root = EXCLUDED.new_root,
         finality_status = EXCLUDED.finality_status,
         block_timestamp = EXCLUDED.block_timestamp,
         sequencer_address = EXCLUDED.sequencer_address,
         starknet_version = EXCLUDED.starknet_version,
         l1_da_mode = EXCLUDED.l1_da_mode,
         transaction_count = EXCLUDED.transaction_count,
         event_count = EXCLUDED.event_count,
         state_diff_length = EXCLUDED.state_diff_length,
         succeeded_transaction_count = EXCLUDED.succeeded_transaction_count,
         reverted_transaction_count = EXCLUDED.reverted_transaction_count,
         l1_handler_transaction_count = EXCLUDED.l1_handler_transaction_count,
         is_orphaned = FALSE,
         orphaned_at = NULL,
         raw_block = EXCLUDED.raw_block,
         raw_state_update = EXCLUDED.raw_state_update,
         updated_at = NOW()`,
    [
      lane,
      toNumericString(normalized.blockNumber, 'block number'),
      block.block_hash,
      block.parent_hash,
      stateUpdate.old_root ?? null,
      stateUpdate.new_root ?? null,
      finalityStatus,
      block.timestamp === undefined ? null : toNumericString(block.timestamp, 'block timestamp'),
      block.sequencer_address ?? null,
      block.starknet_version ?? null,
      block.l1_da_mode ?? null,
      toNumericString(block.transaction_count ?? summary.total, 'transaction count'),
      toNumericString(block.event_count ?? summary.events, 'event count'),
      toNumericString(resolveStateDiffLength(normalized), 'state diff length'),
      toNumericString(summary.succeeded, 'succeeded transaction count'),
      toNumericString(summary.reverted, 'reverted transaction count'),
      toNumericString(summary.l1Handlers, 'l1 handler transaction count'),
      JSON.stringify(block),
      JSON.stringify(stateUpdate),
    ],
  );
}

async function upsertBlockStateUpdate(client, { lane, normalized }) {
  const { stateUpdate } = normalized;
  const stateDiff = stateUpdate?.state_diff ?? {};

  await client.query(
    `INSERT INTO stark_block_state_updates (
         lane,
         block_number,
         block_hash,
         old_root,
         new_root,
         state_diff_length,
         declared_classes,
         deployed_contracts,
         deprecated_declared_classes,
         nonce_updates,
         replaced_classes,
         storage_diffs,
         raw_state_update,
         created_at,
         updated_at
     ) VALUES (
         $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb,
         $11::jsonb, $12::jsonb, $13::jsonb, NOW(), NOW()
     )
     ON CONFLICT (lane, block_number, block_hash)
     DO UPDATE SET
         old_root = EXCLUDED.old_root,
         new_root = EXCLUDED.new_root,
         state_diff_length = EXCLUDED.state_diff_length,
         declared_classes = EXCLUDED.declared_classes,
         deployed_contracts = EXCLUDED.deployed_contracts,
         deprecated_declared_classes = EXCLUDED.deprecated_declared_classes,
         nonce_updates = EXCLUDED.nonce_updates,
         replaced_classes = EXCLUDED.replaced_classes,
         storage_diffs = EXCLUDED.storage_diffs,
         raw_state_update = EXCLUDED.raw_state_update,
         updated_at = NOW()`,
    [
      lane,
      toNumericString(normalized.blockNumber, 'state update block number'),
      normalized.block.block_hash,
      stateUpdate.old_root ?? null,
      stateUpdate.new_root ?? null,
      toNumericString(resolveStateDiffLength(normalized), 'state diff length'),
      JSON.stringify(ensureJsonValue(stateDiff.declared_classes, [])),
      JSON.stringify(ensureJsonValue(stateDiff.deployed_contracts, [])),
      JSON.stringify(ensureJsonValue(stateDiff.deprecated_declared_classes, [])),
      JSON.stringify(ensureJsonValue(stateDiff.nonces, [])),
      JSON.stringify(ensureJsonValue(stateDiff.replaced_classes, [])),
      JSON.stringify(ensureJsonValue(stateDiff.storage_diffs, {})),
      JSON.stringify(stateUpdate),
    ],
  );
}

async function upsertRawArtifacts(client, { emitterClassHashes, lane, normalized }) {
  const blockHash = normalized.block.block_hash;
  const transactions = Array.isArray(normalized.block.transactions) ? normalized.block.transactions : [];
  const txRows = [];
  const eventRows = [];
  const messageRows = [];

  for (let transactionIndex = 0; transactionIndex < transactions.length; transactionIndex += 1) {
    const item = transactions[transactionIndex] ?? {};
    const transaction = item.transaction ?? {};
    const receipt = item.receipt ?? {};
    const transactionHash = normalizeSelector(receipt.transaction_hash ?? transaction.transaction_hash, 'transaction hash');
    const txType = String(receipt.type ?? transaction.type ?? 'UNKNOWN').toUpperCase();
    const executionStatus = String(receipt.execution_status ?? 'SUCCEEDED').toUpperCase();
    const finalityStatus = normalizeFinalityStatus(receipt.finality_status ?? normalized.finalityStatus);
    const senderAddress = normalizeOptionalAddress(transaction.sender_address, 'tx.sender_address');
    const contractAddress = normalizeOptionalAddress(transaction.contract_address ?? receipt.contract_address, 'tx.contract_address');
    const calldata = Array.isArray(transaction.calldata) ? normalizeHexArray(transaction.calldata, 'tx.calldata') : [];
    const l1SenderAddress = txType === 'L1_HANDLER' ? normalizeL1HandlerSender(calldata) : null;

    txRows.push([
      lane,
      toNumericString(normalized.blockNumber, 'block number'),
      blockHash,
      toNumericString(transactionIndex, 'transaction index'),
      transactionHash,
      txType,
      finalityStatus,
      executionStatus,
      senderAddress,
      contractAddress,
      l1SenderAddress,
      normalizeOptionalHexText(transaction.nonce),
      toNullableNumeric(receipt.actual_fee?.amount),
      receipt.actual_fee?.unit ?? null,
      toNumericString((receipt.events ?? []).length, 'events count'),
      toNumericString((receipt.messages_sent ?? []).length, 'messages sent count'),
      receipt.revert_reason ?? null,
      JSON.stringify(calldata),
      JSON.stringify(transaction),
      JSON.stringify(receipt),
    ]);

    const events = Array.isArray(receipt.events) ? receipt.events : [];
    for (let receiptEventIndex = 0; receiptEventIndex < events.length; receiptEventIndex += 1) {
      const rawEvent = events[receiptEventIndex];
      const fromAddress = normalizeAddress(rawEvent.from_address, 'event.from_address');
      const keys = normalizeHexArray(rawEvent.keys ?? [], 'event.keys');
      const data = normalizeHexArray(rawEvent.data ?? [], 'event.data');
      const selector = keys[0] ?? normalizeSelector(0, 'event.selector');
      const resolvedClassHash = emitterClassHashes.get(fromAddress) ?? null;

      eventRows.push([
        lane,
        toNumericString(normalized.blockNumber, 'block number'),
        blockHash,
        transactionHash,
        toNumericString(transactionIndex, 'transaction index'),
        toNumericString(receiptEventIndex, 'receipt event index'),
        finalityStatus,
        executionStatus,
        fromAddress,
        selector,
        resolvedClassHash,
        JSON.stringify(keys),
        JSON.stringify(data),
        JSON.stringify(rawEvent),
      ]);
    }

    const messages = Array.isArray(receipt.messages_sent) ? receipt.messages_sent : [];
    for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
      const rawMessage = messages[messageIndex];
      const payload = normalizeHexArray(rawMessage.payload ?? [], 'message.payload');

      messageRows.push([
        lane,
        toNumericString(normalized.blockNumber, 'block number'),
        blockHash,
        transactionHash,
        toNumericString(transactionIndex, 'transaction index'),
        toNumericString(messageIndex, 'message index'),
        normalizeAddress(rawMessage.from_address, 'message.from_address'),
        normalizeAddress(rawMessage.to_address, 'message.to_address'),
        JSON.stringify(payload),
        JSON.stringify(rawMessage),
      ]);
    }
  }

  await bulkUpsertTxRaw(client, txRows);
  await bulkUpsertEventRaw(client, eventRows);
  await bulkUpsertMessages(client, messageRows);
}

async function bulkUpsertTxRaw(client, rows) {
  if (rows.length === 0) {
    return;
  }

  const sortedRows = [...rows].sort(compareTxRawRows);
  for (const chunk of chunkRows(sortedRows, 250)) {
    const { params, valuesSql } = buildValuesSql(chunk, (offset) => {
      const placeholders = Array.from({ length: 17 }, (_, index) => `$${offset + index}`);
      return `(${placeholders.join(', ')}, 'PENDING', NULL, $${offset + 17}::jsonb, $${offset + 18}::jsonb, $${offset + 19}::jsonb, NOW(), NOW(), NULL)`;
    });

    await client.query(
      `INSERT INTO stark_tx_raw (
           lane,
           block_number,
           block_hash,
           transaction_index,
           transaction_hash,
           tx_type,
           finality_status,
           execution_status,
           sender_address,
           contract_address,
           l1_sender_address,
           nonce,
           actual_fee_amount,
           actual_fee_unit,
           events_count,
           messages_sent_count,
           revert_reason,
           normalized_status,
           decode_error,
           calldata,
           raw_transaction,
           raw_receipt,
           created_at,
           updated_at,
           processed_at
       ) VALUES ${valuesSql}
       ON CONFLICT (lane, block_number, transaction_hash)
       DO UPDATE SET
           block_hash = EXCLUDED.block_hash,
           transaction_index = EXCLUDED.transaction_index,
           tx_type = EXCLUDED.tx_type,
           finality_status = EXCLUDED.finality_status,
           execution_status = EXCLUDED.execution_status,
           sender_address = EXCLUDED.sender_address,
           contract_address = EXCLUDED.contract_address,
           l1_sender_address = EXCLUDED.l1_sender_address,
           nonce = EXCLUDED.nonce,
           actual_fee_amount = EXCLUDED.actual_fee_amount,
           actual_fee_unit = EXCLUDED.actual_fee_unit,
           events_count = EXCLUDED.events_count,
           messages_sent_count = EXCLUDED.messages_sent_count,
           revert_reason = EXCLUDED.revert_reason,
           normalized_status = 'PENDING',
           decode_error = NULL,
           calldata = EXCLUDED.calldata,
           raw_transaction = EXCLUDED.raw_transaction,
           raw_receipt = EXCLUDED.raw_receipt,
           processed_at = NULL,
           updated_at = NOW()`,
      params,
    );
  }
}

async function bulkUpsertEventRaw(client, rows) {
  if (rows.length === 0) {
    return;
  }

  const sortedRows = [...rows].sort(compareEventRawRows);
  for (const chunk of chunkRows(sortedRows, 500)) {
    const { params, valuesSql } = buildValuesSql(chunk, (offset) => {
      const placeholders = Array.from({ length: 11 }, (_, index) => `$${offset + index}`);
      return `(${placeholders.join(', ')}, 'PENDING', NULL, $${offset + 11}::jsonb, $${offset + 12}::jsonb, $${offset + 13}::jsonb, NOW(), NOW(), NULL)`;
    });

    await client.query(
      `INSERT INTO stark_event_raw (
           lane,
           block_number,
           block_hash,
           transaction_hash,
           transaction_index,
           receipt_event_index,
           finality_status,
           transaction_execution_status,
           from_address,
           selector,
           resolved_class_hash,
           normalized_status,
           decode_error,
           keys,
           data,
           raw_event,
           created_at,
           updated_at,
           processed_at
       ) VALUES ${valuesSql}
       ON CONFLICT (lane, block_number, transaction_hash, receipt_event_index)
       DO UPDATE SET
           block_hash = EXCLUDED.block_hash,
           transaction_index = EXCLUDED.transaction_index,
           finality_status = EXCLUDED.finality_status,
           transaction_execution_status = EXCLUDED.transaction_execution_status,
           from_address = EXCLUDED.from_address,
           selector = EXCLUDED.selector,
           resolved_class_hash = EXCLUDED.resolved_class_hash,
           normalized_status = 'PENDING',
           decode_error = NULL,
           keys = EXCLUDED.keys,
           data = EXCLUDED.data,
           raw_event = EXCLUDED.raw_event,
           processed_at = NULL,
           updated_at = NOW()`,
      params,
    );
  }
}

async function bulkUpsertMessages(client, rows) {
  if (rows.length === 0) {
    return;
  }

  const sortedRows = [...rows].sort(compareMessageRawRows);
  for (const chunk of chunkRows(sortedRows, 500)) {
    const { params, valuesSql } = buildValuesSql(chunk, (offset) => {
      const placeholders = Array.from({ length: 8 }, (_, index) => `$${offset + index}`);
      return `(${placeholders.join(', ')}, $${offset + 8}::jsonb, $${offset + 9}::jsonb, NOW(), NOW())`;
    });

    await client.query(
      `INSERT INTO stark_message_l2_to_l1 (
           lane,
           block_number,
           block_hash,
           transaction_hash,
           transaction_index,
           message_index,
           from_address,
           to_address,
           payload,
           raw_message,
           created_at,
           updated_at
       ) VALUES ${valuesSql}
       ON CONFLICT (lane, block_number, transaction_hash, message_index)
       DO UPDATE SET
           block_hash = EXCLUDED.block_hash,
           transaction_index = EXCLUDED.transaction_index,
           from_address = EXCLUDED.from_address,
           to_address = EXCLUDED.to_address,
           payload = EXCLUDED.payload,
           raw_message = EXCLUDED.raw_message,
           updated_at = NOW()`,
      params,
    );
  }
}

function buildValuesSql(rows, buildValueGroup) {
  const params = [];
  const groups = [];
  let offset = 1;

  for (const row of rows) {
    groups.push(buildValueGroup(offset));
    params.push(...row);
    offset += row.length;
  }

  return {
    params,
    valuesSql: groups.join(', '),
  };
}

function chunkRows(rows, chunkSize) {
  const chunks = [];
  for (let index = 0; index < rows.length; index += chunkSize) {
    chunks.push(rows.slice(index, index + chunkSize));
  }
  return chunks;
}

function compareTxRawRows(left, right) {
  return (
    compareTextKey(left[0], right[0])
    || compareNumericTextKey(left[1], right[1])
    || compareTextKey(left[4], right[4])
    || compareNumericTextKey(left[3], right[3])
  );
}

function compareEventRawRows(left, right) {
  return (
    compareTextKey(left[0], right[0])
    || compareNumericTextKey(left[1], right[1])
    || compareTextKey(left[3], right[3])
    || compareNumericTextKey(left[5], right[5])
    || compareNumericTextKey(left[4], right[4])
  );
}

function compareMessageRawRows(left, right) {
  return (
    compareTextKey(left[0], right[0])
    || compareNumericTextKey(left[1], right[1])
    || compareTextKey(left[3], right[3])
    || compareNumericTextKey(left[5], right[5])
    || compareNumericTextKey(left[4], right[4])
  );
}

function compareTextKey(left, right) {
  const normalizedLeft = String(left ?? '');
  const normalizedRight = String(right ?? '');
  if (normalizedLeft < normalizedRight) {
    return -1;
  }
  if (normalizedLeft > normalizedRight) {
    return 1;
  }
  return 0;
}

function compareNumericTextKey(left, right) {
  const normalizedLeft = left === undefined || left === null ? null : BigInt(String(left));
  const normalizedRight = right === undefined || right === null ? null : BigInt(String(right));
  if (normalizedLeft === normalizedRight) {
    return 0;
  }
  if (normalizedLeft === null) {
    return -1;
  }
  if (normalizedRight === null) {
    return 1;
  }
  return normalizedLeft < normalizedRight ? -1 : 1;
}

function resolveStateDiffLength(normalized) {
  const explicitLength = normalized.block.state_diff_length ?? normalized.stateUpdate.state_diff_length;
  if (explicitLength !== undefined && explicitLength !== null) {
    return toBigIntStrict(explicitLength, 'state diff length');
  }

  const stateDiff = normalized.stateUpdate?.state_diff ?? {};
  let total = 0n;

  total += countJsonEntries(stateDiff.declared_classes);
  total += countJsonEntries(stateDiff.deployed_contracts);
  total += countJsonEntries(stateDiff.deprecated_declared_classes);
  total += countJsonEntries(stateDiff.nonces);
  total += countJsonEntries(stateDiff.replaced_classes);
  total += countJsonEntries(stateDiff.storage_diffs);

  return total;
}

function countJsonEntries(value) {
  if (Array.isArray(value)) {
    return BigInt(value.length);
  }

  if (value && typeof value === 'object') {
    return BigInt(Object.keys(value).length);
  }

  return 0n;
}

function ensureJsonValue(value, fallbackValue) {
  if (value === undefined || value === null) {
    return fallbackValue;
  }

  return value;
}

async function resolveEmitterClassHashes({ block, blockNumber, rpcClient }) {
  const uniqueEmitters = new Set();

  for (const item of block.transactions ?? []) {
    for (const rawEvent of item?.receipt?.events ?? []) {
      uniqueEmitters.add(normalizeAddress(rawEvent.from_address, 'event emitter'));
    }
  }

  const results = await Promise.all(
    Array.from(uniqueEmitters).map(async (emitterAddress) => [
      emitterAddress,
      await safeGetClassHashAt({ blockNumber, emitterAddress, rpcClient }),
    ]),
  );

  return new Map(results);
}

async function safeGetClassHashAt({ blockNumber, emitterAddress, rpcClient }) {
  if (!rpcClient || typeof rpcClient.getClassHashAt !== 'function') {
    return null;
  }

  try {
    const result = await rpcClient.getClassHashAt(blockNumber, emitterAddress);
    return result ? normalizeSelector(result, 'class hash') : null;
  } catch (error) {
    return null;
  }
}

function toNullableNumeric(value) {
  if (value === undefined || value === null) {
    return null;
  }

  return toNumericString(toBigIntStrict(value, 'numeric value'), 'numeric value');
}

function normalizeOptionalHexText(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  return `0x${toBigIntStrict(value, 'hex text').toString(16)}`;
}

module.exports = {
  fetchAcceptedBlockPayload,
  prefetchAcceptedBlockPayloads,
  processAcceptedBlock,
  reconcileTurboBackfillIndexes,
};
