#!/usr/bin/env node
'use strict';

const os = require('node:os');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { syncRegistryToDatabase } = require('../core/abi-registry');
const {
  prefetchAcceptedBlockPayloads,
  processAcceptedBlock,
  reconcileTurboBackfillIndexes,
} = require('../core/block-processor');
const {
  assertFoundationTables,
  assertMetadataSyncTables,
  assertPhase2Tables,
  assertPhase3Tables,
  assertPhase4Tables,
  assertPoolTaxonomyTables,
  assertSchemaEnhancementTables,
  assertSchemaEnhancementViews,
  assertTradeChainingTables,
  ensureIndexStateRow,
  getCheckpoint,
} = require('../core/checkpoint');
const { FINALITY_LANES, normalizeFinalityStatus } = require('../core/finality');
const { seedKnownTokens } = require('../core/token-registry');
const { toBigIntStrict } = require('../lib/cairo/bigint');
const { closePool, isFatalDatabaseError, withClient, withTransaction } = require('../lib/db');
const { closeRedis } = require('../lib/redis');
const { StarknetRpcClient } = require('../lib/starknet-rpc');

let shuttingDown = false;

async function main() {
  installSignalHandlers();

  const cli = parseCliArgs(process.argv.slice(2));
  const lane = normalizeFinalityStatus(process.env.INDEXER_LANE || FINALITY_LANES.ACCEPTED_ON_L2);
  const rpcClient = new StarknetRpcClient();

  if (lane !== FINALITY_LANES.ACCEPTED_ON_L2) {
    throw new Error(`Turbo backfill only supports lane ${FINALITY_LANES.ACCEPTED_ON_L2}.`);
  }

  const startBlock = parseRequiredBigInt(cli.start ?? process.env.BACKFILL_START_BLOCK, '--start/BACKFILL_START_BLOCK');
  const endBlock = parseRequiredBigInt(cli.end ?? process.env.BACKFILL_END_BLOCK, '--end/BACKFILL_END_BLOCK');
  if (endBlock < startBlock) {
    throw new Error(`Invalid backfill range: start=${startBlock.toString()} end=${endBlock.toString()}`);
  }

  const totalWorkers = parsePositiveInteger(
    cli.workers ?? process.env.BACKFILL_TOTAL_WORKERS,
    1,
    '--workers/BACKFILL_TOTAL_WORKERS',
  );
  const indexerKeyPrefix = String(process.env.BACKFILL_INDEXER_KEY_PREFIX || `${process.env.INDEXER_KEY || 'starknetdeg-mainnet'}-backfill`).trim();
  const configuredWorkerIndex = resolveConfiguredWorkerIndex(
    cli.workerIndex ?? process.env.BACKFILL_WORKER_INDEX,
    totalWorkers,
  );
  const claimTtlMs = parsePositiveInteger(
    process.env.BACKFILL_WORKER_CLAIM_TTL_MS,
    120_000,
    'BACKFILL_WORKER_CLAIM_TTL_MS',
  );
  const claimRetryMs = parsePositiveInteger(
    process.env.BACKFILL_WORKER_CLAIM_RETRY_MS,
    1_000,
    'BACKFILL_WORKER_CLAIM_RETRY_MS',
  );
  const workerOwnerId = `${os.hostname()}-${process.pid}-${Date.now()}`;
  const workerIndex = configuredWorkerIndex ?? await claimWorkerIndexFromDb({
    claimRetryMs,
    claimTtlMs,
    indexerKeyPrefix,
    lane,
    ownerId: workerOwnerId,
    totalWorkers,
  });
  const chunkSize = parsePositiveBigInt(
    cli.chunkSize ?? process.env.BACKFILL_CHUNK_SIZE,
    2_000_000n,
    '--chunk-size/BACKFILL_CHUNK_SIZE',
  );
  const pollIntervalMs = parsePositiveInteger(
    cli.pollIntervalMs ?? process.env.BACKFILL_POLL_INTERVAL_MS,
    1_000,
    '--poll-interval-ms/BACKFILL_POLL_INTERVAL_MS',
  );
  const baseWindow = parsePositiveInteger(
    cli.window ?? process.env.BACKFILL_WINDOW_SIZE,
    50,
    '--window/BACKFILL_WINDOW_SIZE',
  );
  const maxWindow = parsePositiveInteger(
    cli.windowMax ?? process.env.BACKFILL_WINDOW_MAX,
    Math.max(baseWindow, 400),
    '--window-max/BACKFILL_WINDOW_MAX',
  );
  const smallBlockTxThreshold = parsePositiveInteger(
    cli.smallBlockThreshold ?? process.env.BACKFILL_SMALL_BLOCK_TX_THRESHOLD,
    5,
    '--small-block-tx-threshold/BACKFILL_SMALL_BLOCK_TX_THRESHOLD',
  );
  const smallBlockGrowthFactor = parsePositiveInteger(
    cli.smallBlockGrowthFactor ?? process.env.BACKFILL_SMALL_BLOCK_GROWTH_FACTOR,
    2,
    '--small-block-growth-factor/BACKFILL_SMALL_BLOCK_GROWTH_FACTOR',
  );
  const turboParallelism = parsePositiveInteger(
    cli.parallelism ?? process.env.BACKFILL_PARALLELISM,
    Math.max(4, Math.min(16, os.cpus().length)),
    '--parallelism/BACKFILL_PARALLELISM',
  );
  const prefetchConcurrencyCap = parsePositiveInteger(
    process.env.INDEXER_PREFETCH_CONCURRENCY_CAP,
    64,
    'INDEXER_PREFETCH_CONCURRENCY_CAP',
  );
  const prefetchConcurrency = Math.min(
    parsePositiveInteger(process.env.INDEXER_PREFETCH_CONCURRENCY, 10, 'INDEXER_PREFETCH_CONCURRENCY'),
    turboParallelism,
    prefetchConcurrencyCap,
  );

  const chunkRange = resolveChunkRange({
    chunkSize,
    endBlock,
    startBlock,
    workerIndex,
  });
  if (!chunkRange) {
    if (configuredWorkerIndex === null) {
      await releaseWorkerClaim({
        indexerKeyPrefix,
        lane,
        ownerId: workerOwnerId,
        workerIndex,
      });
    }
    console.log(
      `[turbo-backfill] worker ${workerIndex}/${totalWorkers} has no assigned range. start=${startBlock.toString()} end=${endBlock.toString()} chunk_size=${chunkSize.toString()}`,
    );
    return;
  }

  const indexerKey = `${indexerKeyPrefix}-w${workerIndex}`;
  const indexLeader = resolveIndexLeader(process.env.BACKFILL_INDEX_LEADER, workerIndex);
  const fastHeaderOnly = parseBoolean(process.env.BACKFILL_FAST_HEADER_ONLY, true);
  const useUnloggedTables = parseBoolean(process.env.BACKFILL_USE_UNLOGGED_TABLES, true);
  const restoreLoggedOnComplete = parseBoolean(process.env.BACKFILL_RESTORE_LOGGED_ON_COMPLETE, false);
  const unloggedTables = parseCsv(process.env.BACKFILL_UNLOGGED_TABLES, ['stark_block_journal', 'stark_transfers']);
  const staleWorkerTimeoutMs = parsePositiveInteger(
    process.env.BACKFILL_STALE_WORKER_TIMEOUT_MS,
    30_000,
    'BACKFILL_STALE_WORKER_TIMEOUT_MS',
  );
  const heartbeatIntervalMs = parsePositiveInteger(
    process.env.BACKFILL_HEARTBEAT_INTERVAL_MS,
    5_000,
    'BACKFILL_HEARTBEAT_INTERVAL_MS',
  );
  const staleWorkerExitCode = parsePositiveInteger(
    process.env.BACKFILL_STALE_WORKER_EXIT_CODE,
    86,
    'BACKFILL_STALE_WORKER_EXIT_CODE',
  );
  let lastProgressAt = Date.now();
  let lastProcessedBlock = null;
  let adaptiveWindow = Math.min(baseWindow, maxWindow);
  const heartbeatMonitor = setInterval(() => {
    if (shuttingDown) {
      return;
    }

    const stalledForMs = Date.now() - lastProgressAt;
    if (stalledForMs < staleWorkerTimeoutMs) {
      return;
    }

    console.error(
      `[turbo-backfill] worker=${workerIndex} stale-worker-detected stalled_ms=${stalledForMs} timeout_ms=${staleWorkerTimeoutMs} last_processed_block=${lastProcessedBlock === null ? 'none' : lastProcessedBlock.toString()} exiting_code=${staleWorkerExitCode}`,
    );
    process.exit(staleWorkerExitCode);
  }, heartbeatIntervalMs);
  heartbeatMonitor.unref?.();
  const claimHeartbeatIntervalMs = Math.max(5_000, Math.floor(claimTtlMs / 3));
  const claimHeartbeatMonitor = configuredWorkerIndex === null
    ? setInterval(async () => {
      if (shuttingDown) {
        return;
      }

      try {
        await refreshWorkerClaim({
          indexerKeyPrefix,
          lane,
          ownerId: workerOwnerId,
          workerIndex,
        });
      } catch (error) {
        console.error(`[turbo-backfill] worker=${workerIndex} claim heartbeat failed: ${formatError(error)}`);
        process.exit(staleWorkerExitCode);
      }
    }, claimHeartbeatIntervalMs)
    : null;
  claimHeartbeatMonitor?.unref?.();

  try {
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
      await ensureIndexStateRow(client, indexerKey, lane);
    });

    const checkpoint = await withClient((client) => getCheckpoint(client, { indexerKey, lane }));
    let cursor = chunkRange.start;
    if (checkpoint?.lastProcessedBlockNumber !== null && checkpoint?.lastProcessedBlockNumber !== undefined) {
      const checkpointCursor = checkpoint.lastProcessedBlockNumber + 1n;
      if (checkpointCursor <= chunkRange.start) {
        cursor = chunkRange.start;
      } else if (checkpointCursor > chunkRange.end) {
        cursor = chunkRange.end + 1n;
      } else {
        cursor = checkpointCursor;
      }
    }

    if (indexLeader && useUnloggedTables) {
      await setBackfillTablePersistenceMode({
        tableNames: unloggedTables,
        useUnlogged: true,
        workerIndex,
      });
    }

    console.log(
      `[turbo-backfill] worker=${workerIndex}/${totalWorkers} lane=${lane} indexer_key=${indexerKey} assigned_range=${chunkRange.start.toString()}-${chunkRange.end.toString()} resume_from=${cursor.toString()} window=${adaptiveWindow}/${maxWindow} parallelism=${turboParallelism} prefetch_concurrency=${prefetchConcurrency} index_leader=${indexLeader} fast_header_only=${fastHeaderOnly} unlogged_tables=${useUnloggedTables ? unloggedTables.join('|') : 'disabled'} stale_timeout_ms=${staleWorkerTimeoutMs}`,
    );

    let bufferedBatch = null;
    while (!shuttingDown && cursor <= chunkRange.end) {
      try {
        const batch = bufferedBatch?.cursor === cursor
          ? bufferedBatch
          : await loadPrefetchBatch({
            chunkRangeEnd: chunkRange.end,
            cursor,
            prefetchConcurrency,
            preferHeaderProbe: fastHeaderOnly,
            rpcClient,
            windowSize: adaptiveWindow,
          });
        bufferedBatch = null;

        if (!batch) {
          await sleep(pollIntervalMs);
          continue;
        }
        const { blockNumbers, latestHead, rangeEnd, prefetchedPayloads } = batch;

        if (indexLeader) {
          await reconcileTurboBackfillIndexes({
            blockNumber: cursor,
            latestHead,
            turboMode: true,
          });
        }

        const nextCursor = rangeEnd + 1n;
        let nextBatchPromise = null;
        if (!shuttingDown && nextCursor <= chunkRange.end) {
          nextBatchPromise = loadPrefetchBatch({
            chunkRangeEnd: chunkRange.end,
            cursor: nextCursor,
            prefetchConcurrency,
            preferHeaderProbe: fastHeaderOnly,
            rpcClient,
            windowSize: adaptiveWindow,
          });
        }
        const batchStartedAt = Date.now();

        let smallBlocks = 0;
        let totalTx = 0;
        let headerOnlyBlocks = 0;
        let lastCommittedInBatch = null;
        for (let index = 0; index < blockNumbers.length; index += 1) {
          const result = await processAcceptedBlock({
            blockNumber: blockNumbers[index],
            headerOnlyOnEmpty: fastHeaderOnly,
            indexerKey,
            lane,
            prefetchedPayload: prefetchedPayloads[index] ?? null,
            rpcClient,
            skipRealtime: true,
            turboMode: true,
            mirrorAcceptedOnL1Checkpoint: false,
          });

          const txCount = Number(result.summary.total ?? 0);
          totalTx += txCount;
          if (txCount < smallBlockTxThreshold) {
            smallBlocks += 1;
          }
          if (fastHeaderOnly && txCount === 0) {
            headerOnlyBlocks += 1;
          }
          lastProgressAt = Date.now();
          lastProcessedBlock = result.blockNumber;
          lastCommittedInBatch = result.blockNumber;
        }

        if (smallBlocks === blockNumbers.length && adaptiveWindow < maxWindow) {
          adaptiveWindow = Math.min(maxWindow, adaptiveWindow * smallBlockGrowthFactor);
        } else if (smallBlocks < Math.ceil(blockNumbers.length / 2) && adaptiveWindow > baseWindow) {
          adaptiveWindow = Math.max(baseWindow, Math.floor(adaptiveWindow / smallBlockGrowthFactor));
        }

        const currentBlock = blockNumbers[blockNumbers.length - 1];
        const remainingLag = latestHead > currentBlock ? latestHead - currentBlock : 0n;
        const elapsedSeconds = Math.max((Date.now() - batchStartedAt) / 1000, 0.001);
        const batchBps = blockNumbers.length / elapsedSeconds;
        console.log(
          `[turbo-backfill] worker=${workerIndex} committed range=${blockNumbers[0].toString()}-${currentBlock.toString()} blocks=${blockNumbers.length} tx=${totalTx} small_blocks=${smallBlocks} header_only_blocks=${headerOnlyBlocks} remaining_lag=${remainingLag.toString()} bps=${batchBps.toFixed(3)} next_window=${adaptiveWindow}`,
        );

        if (nextBatchPromise) {
          bufferedBatch = await nextBatchPromise;
        }
        cursor = rangeEnd + 1n;
      } catch (error) {
        console.error(`[turbo-backfill] worker=${workerIndex} error: ${formatError(error)}`);
        if (isFatalDatabaseError(error)) {
          console.error(`[turbo-backfill] worker=${workerIndex} fatal database connectivity issue detected; exiting for supervisor restart.`);
          throw error;
        }

        bufferedBatch = null;
        try {
          const checkpoint = await withClient((client) => getCheckpoint(client, { indexerKey, lane }));
          if (checkpoint?.lastProcessedBlockNumber !== null && checkpoint?.lastProcessedBlockNumber !== undefined) {
            const checkpointCursor = checkpoint.lastProcessedBlockNumber + 1n;
            if (checkpointCursor > cursor) {
              const normalizedCursor = checkpointCursor > chunkRange.end ? (chunkRange.end + 1n) : checkpointCursor;
              console.log(
                `[turbo-backfill] worker=${workerIndex} resync cursor from ${cursor.toString()} to ${normalizedCursor.toString()} using checkpoint=${checkpoint.lastProcessedBlockNumber.toString()}`,
              );
              cursor = normalizedCursor;
              lastProcessedBlock = checkpoint.lastProcessedBlockNumber;
              lastProgressAt = Date.now();
            }
          }
        } catch (syncError) {
          console.error(`[turbo-backfill] worker=${workerIndex} cursor resync failed: ${formatError(syncError)}`);
        }

        const errorMessage = String(error?.message || '').toLowerCase();
        if ((errorMessage.includes('statement timeout') || errorMessage.includes('deadlock')) && adaptiveWindow > baseWindow) {
          adaptiveWindow = Math.max(baseWindow, Math.floor(adaptiveWindow / 2));
          console.log(`[turbo-backfill] worker=${workerIndex} reduced window to ${adaptiveWindow} after transient db contention`);
        }

        await sleep(pollIntervalMs);
      }
    }

    console.log(
      `[turbo-backfill] worker=${workerIndex}/${totalWorkers} completed range ${chunkRange.start.toString()}-${chunkRange.end.toString()}`,
    );

    if (indexLeader && useUnloggedTables && restoreLoggedOnComplete) {
      await setBackfillTablePersistenceMode({
        tableNames: unloggedTables,
        useUnlogged: false,
        workerIndex,
      });
    }
  } finally {
    clearInterval(heartbeatMonitor);
    if (claimHeartbeatMonitor) {
      clearInterval(claimHeartbeatMonitor);
    }
    if (configuredWorkerIndex === null) {
      try {
        await releaseWorkerClaim({
          indexerKeyPrefix,
          lane,
          ownerId: workerOwnerId,
          workerIndex,
        });
      } catch (error) {
        console.error(`[turbo-backfill] worker=${workerIndex} release claim error: ${formatError(error)}`);
      }
    }
  }
}

async function loadPrefetchBatch({
  cursor,
  chunkRangeEnd,
  windowSize,
  prefetchConcurrency,
  preferHeaderProbe,
  rpcClient,
}) {
  const latestHead = await rpcClient.getBlockNumber();
  if (cursor > latestHead) {
    return null;
  }

  const rangeEnd = minBigInt(
    chunkRangeEnd,
    latestHead,
    cursor + BigInt(Math.max(1, windowSize) - 1),
  );
  const blockNumbers = [];
  for (let blockNumber = cursor; blockNumber <= rangeEnd; blockNumber += 1n) {
    blockNumbers.push(blockNumber);
  }

  const prefetchedPayloads = await prefetchAcceptedBlockPayloads({
    blockNumbers,
    concurrency: prefetchConcurrency,
    preferHeaderProbe,
    rpcClient,
  });

  return {
    cursor,
    latestHead,
    rangeEnd,
    blockNumbers,
    prefetchedPayloads,
  };
}

async function setBackfillTablePersistenceMode({ tableNames, useUnlogged, workerIndex }) {
  const mode = useUnlogged ? 'UNLOGGED' : 'LOGGED';
  const normalized = Array.from(new Set((tableNames ?? [])
    .map((name) => String(name ?? '').trim().toLowerCase())
    .filter((name) => name.length > 0)));

  if (normalized.length === 0) {
    return;
  }

  await withClient(async (client) => {
    for (const tableName of normalized) {
      if (!/^[a-z_][a-z0-9_]*$/.test(tableName)) {
        throw new Error(`Invalid table name for backfill persistence mode: ${tableName}`);
      }

      const regclassResult = await client.query(
        "SELECT to_regclass($1) AS regclass",
        [`public.${tableName}`],
      );
      if (!regclassResult.rows[0]?.regclass) {
        console.log(`[turbo-backfill] worker=${workerIndex} skip ${tableName}: table not found`);
        continue;
      }

      await client.query(`ALTER TABLE public.${tableName} SET ${mode}`);
      console.log(`[turbo-backfill] worker=${workerIndex} set ${tableName} ${mode}`);
    }
  });
}

function resolveChunkRange({ startBlock, endBlock, chunkSize, workerIndex }) {
  const offset = BigInt(workerIndex - 1) * chunkSize;
  const rangeStart = startBlock + offset;
  if (rangeStart > endBlock) {
    return null;
  }

  const rangeEnd = minBigInt(endBlock, rangeStart + chunkSize - 1n);
  return { start: rangeStart, end: rangeEnd };
}

function resolveConfiguredWorkerIndex(value, totalWorkers) {
  const explicit = value === undefined || value === null || String(value).trim() === ''
    ? null
    : parsePositiveInteger(value, null, '--worker-index/BACKFILL_WORKER_INDEX');

  if (explicit !== null) {
    if (explicit > totalWorkers) {
      throw new Error(`Worker index ${explicit} exceeds total workers ${totalWorkers}`);
    }
    return explicit;
  }

  const hostname = String(process.env.HOSTNAME || '').trim();
  const hostMatch = hostname.match(/-(\d+)$/);
  const fromHostname = hostMatch ? Number.parseInt(hostMatch[1], 10) : null;
  if (Number.isInteger(fromHostname) && fromHostname > 0 && fromHostname <= totalWorkers) {
    return fromHostname;
  }

  return null;
}

async function claimWorkerIndexFromDb({
  lane,
  indexerKeyPrefix,
  totalWorkers,
  ownerId,
  claimTtlMs,
  claimRetryMs,
}) {
  const ttlSeconds = Math.max(1, Math.ceil(claimTtlMs / 1000));
  const ttlInterval = `${ttlSeconds} seconds`;

  while (!shuttingDown) {
    const claimedWorkerIndex = await withTransaction(async (client) => {
      await ensureWorkerClaimTable(client);
      await ensureWorkerSlotTable(client);
      await ensureWorkerSlots(client, {
        indexerKeyPrefix,
        lane,
        totalWorkers,
      });
      await client.query(
        `DELETE FROM stark_backfill_worker_claims
          WHERE lane = $1
            AND indexer_key_prefix = $2
            AND updated_at < NOW() - ($3::text)::interval`,
        [lane, indexerKeyPrefix, ttlInterval],
      );

      const claimed = await client.query(
        `WITH next_slot AS (
             SELECT slots.worker_slot
               FROM stark_backfill_worker_slots AS slots
               LEFT JOIN stark_backfill_worker_claims AS claims
                 ON claims.lane = slots.lane
                AND claims.indexer_key_prefix = slots.indexer_key_prefix
                AND claims.worker_slot = slots.worker_slot
              WHERE slots.lane = $1
                AND slots.indexer_key_prefix = $2
                AND claims.worker_slot IS NULL
              ORDER BY slots.worker_slot ASC
              FOR UPDATE OF slots SKIP LOCKED
              LIMIT 1
         )
         INSERT INTO stark_backfill_worker_claims (
             lane,
             indexer_key_prefix,
             worker_slot,
             owner_id,
             claimed_at,
             updated_at
         )
         SELECT $1, $2, next_slot.worker_slot, $3, NOW(), NOW()
           FROM next_slot
         ON CONFLICT DO NOTHING
         RETURNING worker_slot`,
        [lane, indexerKeyPrefix, ownerId],
      );

      return claimed.rowCount > 0 ? Number(claimed.rows[0].worker_slot) : null;
    });

    if (claimedWorkerIndex !== null) {
      return claimedWorkerIndex;
    }

    await sleep(claimRetryMs);
  }

  throw new Error('Worker claim interrupted by shutdown.');
}

async function refreshWorkerClaim({ lane, indexerKeyPrefix, workerIndex, ownerId }) {
  await withClient(async (client) => {
    const refreshed = await client.query(
      `UPDATE stark_backfill_worker_claims
          SET updated_at = NOW()
        WHERE lane = $1
          AND indexer_key_prefix = $2
          AND worker_slot = $3
          AND owner_id = $4`,
      [lane, indexerKeyPrefix, workerIndex, ownerId],
    );

    if (refreshed.rowCount === 0) {
      throw new Error(`worker claim lost lane=${lane} indexer_key_prefix=${indexerKeyPrefix} worker_slot=${workerIndex}`);
    }
  });
}

async function releaseWorkerClaim({ lane, indexerKeyPrefix, workerIndex, ownerId }) {
  await withClient((client) => client.query(
    `DELETE FROM stark_backfill_worker_claims
      WHERE lane = $1
        AND indexer_key_prefix = $2
        AND worker_slot = $3
        AND owner_id = $4`,
    [lane, indexerKeyPrefix, workerIndex, ownerId],
  ));
}

async function ensureWorkerClaimTable(client) {
  await client.query(
    `CREATE TABLE IF NOT EXISTS stark_backfill_worker_claims (
       lane TEXT NOT NULL,
       indexer_key_prefix TEXT NOT NULL,
       worker_slot INTEGER NOT NULL,
       owner_id TEXT NOT NULL,
       claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       PRIMARY KEY (lane, indexer_key_prefix, worker_slot)
     )`,
  );
}

async function ensureWorkerSlotTable(client) {
  await client.query(
    `CREATE TABLE IF NOT EXISTS stark_backfill_worker_slots (
       lane TEXT NOT NULL,
       indexer_key_prefix TEXT NOT NULL,
       worker_slot INTEGER NOT NULL,
       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       PRIMARY KEY (lane, indexer_key_prefix, worker_slot)
     )`,
  );
}

async function ensureWorkerSlots(client, { lane, indexerKeyPrefix, totalWorkers }) {
  await client.query(
    `INSERT INTO stark_backfill_worker_slots (
         lane,
         indexer_key_prefix,
         worker_slot,
         created_at
     )
     SELECT $1, $2, slot, NOW()
       FROM generate_series(1, $3) AS slot
     ON CONFLICT DO NOTHING`,
    [lane, indexerKeyPrefix, totalWorkers],
  );

  await client.query(
    `DELETE FROM stark_backfill_worker_slots
      WHERE lane = $1
        AND indexer_key_prefix = $2
        AND worker_slot > $3`,
    [lane, indexerKeyPrefix, totalWorkers],
  );
}

function resolveIndexLeader(value, workerIndex) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return workerIndex === 1;
  }

  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'auto' || normalized === 'primary' || normalized === 'worker-1') {
    return workerIndex === 1;
  }

  return parseBoolean(value, false);
}

function parseCliArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      continue;
    }

    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      args[key] = 'true';
      continue;
    }

    args[key] = value;
    index += 1;
  }

  return {
    chunkSize: args['chunk-size'],
    end: args.end,
    parallelism: args.parallelism,
    pollIntervalMs: args['poll-interval-ms'],
    smallBlockGrowthFactor: args['small-block-growth-factor'],
    smallBlockThreshold: args['small-block-tx-threshold'],
    start: args.start,
    window: args.window,
    windowMax: args['window-max'],
    workerIndex: args['worker-index'],
    workers: args.workers,
  };
}

function parseBoolean(value, fallbackValue = false) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallbackValue;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parseCsv(value, fallback = []) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return [...fallback];
  }

  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parsePositiveInteger(value, fallbackValue, label) {
  if (value === undefined || value === null || String(value).trim() === '') {
    if (fallbackValue === null) {
      return null;
    }
    return fallbackValue;
  }

  const parsed = Number.parseInt(String(value).trim(), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer, received: ${value}`);
  }

  return parsed;
}

function parseRequiredBigInt(value, label) {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new Error(`${label} is required`);
  }

  const parsed = toBigIntStrict(String(value).trim(), label);
  if (parsed < 0n) {
    throw new Error(`${label} cannot be negative`);
  }

  return parsed;
}

function parsePositiveBigInt(value, fallbackValue, label) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallbackValue;
  }

  const parsed = BigInt(String(value).trim());
  if (parsed <= 0n) {
    throw new Error(`${label} must be greater than zero, received: ${value}`);
  }

  return parsed;
}

function minBigInt(...values) {
  return values.reduce((lowest, value) => (value < lowest ? value : lowest));
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
      console.log(`[turbo-backfill] received ${signal}, stopping after current batch`);
    });
  }
}

main().catch(async (error) => {
  console.error(`[turbo-backfill] fatal: ${formatError(error)}`);
  try {
    await closeRedis();
  } catch (redisError) {
    console.error(`[turbo-backfill] redis shutdown error: ${formatError(redisError)}`);
  }
  try {
    await closePool();
  } finally {
    process.exit(1);
  }
}).finally(async () => {
  try {
    await closeRedis();
  } catch (error) {
    // Ignore shutdown errors during normal exit.
  }
  await closePool();
});
