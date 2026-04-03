#!/usr/bin/env node
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { setTimeout: sleep } = require('node:timers/promises');
const { syncRegistryToDatabase } = require('../core/abi-registry');
const { processAcceptedBlock } = require('../core/block-processor');
const { assertFoundationTables, assertPhase2Tables, ensureIndexStateRows, getCheckpoint } = require('../core/checkpoint');
const { FINALITY_LANES, normalizeFinalityStatus } = require('../core/finality');
const { closePool, withClient, withTransaction } = require('../lib/db');
const { StarknetRpcClient } = require('../lib/starknet-rpc');
const { toBigIntStrict } = require('../lib/cairo/bigint');

let shuttingDown = false;

async function main() {
  const indexerKey = process.env.INDEXER_KEY || 'starknetdeg-mainnet';
  const lane = normalizeFinalityStatus(process.env.INDEXER_LANE || FINALITY_LANES.ACCEPTED_ON_L2);
  const pollIntervalMs = parsePositiveInteger(process.env.INDEXER_POLL_INTERVAL_MS, 10_000);
  const catchupBatchSize = parsePositiveInteger(process.env.INDEXER_CATCHUP_BATCH_SIZE, 25);
  const configuredStartBlock = parseOptionalBigInt(process.env.INDEXER_START_BLOCK);
  const rpcClient = new StarknetRpcClient();

  if (lane !== FINALITY_LANES.ACCEPTED_ON_L2) {
    throw new Error(`Phase 2 start-indexer only supports ${FINALITY_LANES.ACCEPTED_ON_L2}.`);
  }

  installSignalHandlers();

  await withTransaction(async (client) => {
    await assertFoundationTables(client);
    await assertPhase2Tables(client);
    await syncRegistryToDatabase(client);
    await ensureIndexStateRows(client, indexerKey);
  });

  console.log(
    `[phase2] StarknetDeg indexer starting indexerKey=${indexerKey} lane=${lane} previewLane=${FINALITY_LANES.PRE_CONFIRMED} anchorLane=${FINALITY_LANES.ACCEPTED_ON_L1}`,
  );

  while (!shuttingDown) {
    try {
      const latestAcceptedBlock = await rpcClient.getBlockNumber();
      const checkpoint = await withClient((client) => getCheckpoint(client, { indexerKey, lane }));
      const nextBlock = determineNextBlock(checkpoint, configuredStartBlock);

      if (nextBlock > latestAcceptedBlock) {
        await sleep(pollIntervalMs);
        continue;
      }

      let processedInBatch = 0;
      let cursor = nextBlock;

      while (!shuttingDown && cursor <= latestAcceptedBlock && processedInBatch < catchupBatchSize) {
        const result = await processAcceptedBlock({
          blockNumber: cursor,
          indexerKey,
          lane,
          rpcClient,
        });

        console.log(
          `[phase2] committed block=${result.blockNumber.toString()} hash=${shortHash(result.blockHash)} status=${result.finalityStatus} tx=${result.summary.total} reverted=${result.summary.reverted} l1_handlers=${result.summary.l1Handlers} actions=${result.decodeSummary.actions} transfers=${result.decodeSummary.transfers} unknown_events=${result.decodeSummary.unknownEvents}`,
        );

        cursor += 1n;
        processedInBatch += 1;
      }

      if (processedInBatch === 0) {
        await sleep(pollIntervalMs);
      }
    } catch (error) {
      console.error(`[phase2] indexer loop error: ${formatError(error)}`);
      await sleep(pollIntervalMs);
    }
  }

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
      console.log(`[phase2] received ${signal}, shutting down after current step.`);
    });
  }
}

main().catch(async (error) => {
  console.error(`[phase2] fatal startup error: ${formatError(error)}`);

  try {
    await closePool();
  } finally {
    process.exitCode = 1;
  }
});
