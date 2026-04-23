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
  ensureIndexStateRows,
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
  const workerIndex = resolveWorkerIndex(
    cli.workerIndex ?? process.env.BACKFILL_WORKER_INDEX,
    totalWorkers,
  );
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
  const prefetchConcurrency = Math.min(
    parsePositiveInteger(process.env.INDEXER_PREFETCH_CONCURRENCY, 10, 'INDEXER_PREFETCH_CONCURRENCY'),
    turboParallelism,
    10,
  );

  const chunkRange = resolveChunkRange({
    chunkSize,
    endBlock,
    startBlock,
    workerIndex,
  });
  if (!chunkRange) {
    console.log(
      `[turbo-backfill] worker ${workerIndex}/${totalWorkers} has no assigned range. start=${startBlock.toString()} end=${endBlock.toString()} chunk_size=${chunkSize.toString()}`,
    );
    return;
  }

  const indexerKeyPrefix = String(process.env.BACKFILL_INDEXER_KEY_PREFIX || `${process.env.INDEXER_KEY || 'starknetdeg-mainnet'}-backfill`).trim();
  const indexerKey = `${indexerKeyPrefix}-w${workerIndex}`;
  const indexLeader = parseBoolean(
    process.env.BACKFILL_INDEX_LEADER,
    workerIndex === 1,
  );
  let adaptiveWindow = Math.min(baseWindow, maxWindow);

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
  });

  const checkpoint = await withClient((client) => getCheckpoint(client, { indexerKey, lane }));
  let cursor = chunkRange.start;
  if (checkpoint?.lastProcessedBlockNumber !== null && checkpoint?.lastProcessedBlockNumber !== undefined) {
    cursor = checkpoint.lastProcessedBlockNumber + 1n;
  }

  console.log(
    `[turbo-backfill] worker=${workerIndex}/${totalWorkers} lane=${lane} indexer_key=${indexerKey} assigned_range=${chunkRange.start.toString()}-${chunkRange.end.toString()} resume_from=${cursor.toString()} window=${adaptiveWindow}/${maxWindow} parallelism=${turboParallelism} prefetch_concurrency=${prefetchConcurrency} index_leader=${indexLeader}`,
  );

  while (!shuttingDown && cursor <= chunkRange.end) {
    try {
      const latestHead = await rpcClient.getBlockNumber();
      if (cursor > latestHead) {
        await sleep(pollIntervalMs);
        continue;
      }

      if (indexLeader) {
        await reconcileTurboBackfillIndexes({
          blockNumber: cursor,
          latestHead,
          turboMode: true,
        });
      }

      const rangeEnd = minBigInt(
        chunkRange.end,
        latestHead,
        cursor + BigInt(Math.max(1, adaptiveWindow) - 1),
      );
      const blockNumbers = [];
      for (let blockNumber = cursor; blockNumber <= rangeEnd; blockNumber += 1n) {
        blockNumbers.push(blockNumber);
      }
      const batchStartedAt = Date.now();

      const prefetchedPayloads = await prefetchAcceptedBlockPayloads({
        blockNumbers,
        concurrency: prefetchConcurrency,
        rpcClient,
      });

      let smallBlocks = 0;
      let totalTx = 0;
      for (let index = 0; index < blockNumbers.length; index += 1) {
        const result = await processAcceptedBlock({
          blockNumber: blockNumbers[index],
          indexerKey,
          lane,
          prefetchedPayload: prefetchedPayloads[index] ?? null,
          rpcClient,
          skipRealtime: true,
          turboMode: true,
        });

        const txCount = Number(result.summary.total ?? 0);
        totalTx += txCount;
        if (txCount < smallBlockTxThreshold) {
          smallBlocks += 1;
        }
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
        `[turbo-backfill] worker=${workerIndex} committed range=${blockNumbers[0].toString()}-${currentBlock.toString()} blocks=${blockNumbers.length} tx=${totalTx} small_blocks=${smallBlocks} remaining_lag=${remainingLag.toString()} bps=${batchBps.toFixed(3)} next_window=${adaptiveWindow}`,
      );

      cursor = rangeEnd + 1n;
    } catch (error) {
      console.error(`[turbo-backfill] worker=${workerIndex} error: ${formatError(error)}`);
      if (isFatalDatabaseError(error)) {
        console.error(`[turbo-backfill] worker=${workerIndex} fatal database connectivity issue detected; exiting for supervisor restart.`);
        throw error;
      }
      await sleep(pollIntervalMs);
    }
  }

  console.log(
    `[turbo-backfill] worker=${workerIndex}/${totalWorkers} completed range ${chunkRange.start.toString()}-${chunkRange.end.toString()}`,
  );
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

function resolveWorkerIndex(value, totalWorkers) {
  const explicit = value === undefined || value === null || String(value).trim() === ''
    ? null
    : parsePositiveInteger(value, null, '--worker-index/BACKFILL_WORKER_INDEX');

  const hostname = String(process.env.HOSTNAME || '').trim();
  const hostMatch = hostname.match(/-(\d+)$/);
  const fromHostname = hostMatch ? Number.parseInt(hostMatch[1], 10) : null;
  const workerIndex = explicit ?? fromHostname ?? 1;

  if (!Number.isInteger(workerIndex) || workerIndex <= 0) {
    throw new Error(`Invalid worker index: ${workerIndex}`);
  }

  if (workerIndex > totalWorkers) {
    throw new Error(`Worker index ${workerIndex} exceeds total workers ${totalWorkers}`);
  }

  return workerIndex;
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
