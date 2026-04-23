#!/usr/bin/env node
'use strict';

const path = require('node:path');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { advanceCheckpoint, ensureIndexStateRows, getCheckpoint } = require('../core/checkpoint');
const { FINALITY_LANES, normalizeFinalityStatus } = require('../core/finality');
const { toNumericString } = require('../lib/cairo/bigint');
const { closePool, withTransaction } = require('../lib/db');

async function main() {
  const lane = normalizeFinalityStatus(process.env.INDEXER_LANE || FINALITY_LANES.ACCEPTED_ON_L2);
  const indexerKey = String(process.env.INDEXER_KEY || 'starknetdeg-mainnet').trim();
  const startBlock = parseNonNegativeBigInt(process.env.BACKFILL_START_BLOCK, 0n, 'BACKFILL_START_BLOCK');
  const endBlock = parseNonNegativeBigInt(process.env.BACKFILL_END_BLOCK, null, 'BACKFILL_END_BLOCK');
  const chunkSize = parsePositiveBigInt(process.env.BACKFILL_CHUNK_SIZE, 2_000_000n, 'BACKFILL_CHUNK_SIZE');
  const totalWorkers = parsePositiveInteger(process.env.BACKFILL_TOTAL_WORKERS, 1, 'BACKFILL_TOTAL_WORKERS');
  const indexerKeyPrefix = String(process.env.BACKFILL_INDEXER_KEY_PREFIX || `${indexerKey}-backfill`).trim();

  if (endBlock === null) {
    throw new Error('BACKFILL_END_BLOCK is required to promote checkpoint.');
  }

  if (endBlock < startBlock) {
    throw new Error(`Invalid backfill range. start=${startBlock.toString()} end=${endBlock.toString()}`);
  }

  const workerRanges = buildWorkerRanges({
    chunkSize,
    endBlock,
    indexerKeyPrefix,
    startBlock,
    totalWorkers,
  });
  validateWorkerRanges(workerRanges, {
    endBlock,
    startBlock,
  });

  await withTransaction(async (client) => {
    await ensureIndexStateRows(client, indexerKey);

    for (const range of workerRanges) {
      const checkpoint = await loadCheckpoint(client, {
        forUpdate: true,
        indexerKey: range.workerKey,
        lane,
      });
      const lastProcessed = checkpoint?.lastProcessedBlockNumber ?? null;
      if (lastProcessed === null) {
        throw new Error(
          `Worker checkpoint missing for ${range.workerKey}. expected_range=${range.rangeStart.toString()}-${range.rangeEnd.toString()}`,
        );
      }
      if (lastProcessed < range.rangeEnd) {
        throw new Error(
          `Worker checkpoint incomplete for ${range.workerKey}. expected_end=${range.rangeEnd.toString()} actual=${lastProcessed.toString()}`,
        );
      }
      if (lastProcessed > range.rangeEnd) {
        throw new Error(
          `Worker checkpoint overlap risk for ${range.workerKey}. expected_end=${range.rangeEnd.toString()} actual=${lastProcessed.toString()}`,
        );
      }
    }

    const coverage = await loadCanonicalCoverage(client, {
      endBlock,
      lane,
      startBlock,
    });
    const expectedBlockCount = (endBlock - startBlock) + 1n;
    if (
      coverage.canonicalCount !== expectedBlockCount
      || coverage.minBlockNumber !== startBlock
      || coverage.maxBlockNumber !== endBlock
    ) {
      throw new Error(
        `Canonical coverage mismatch for promotion range ${startBlock.toString()}-${endBlock.toString()}. expected_count=${expectedBlockCount.toString()} actual_count=${coverage.canonicalCount.toString()} min=${coverage.minBlockNumber?.toString() ?? 'null'} max=${coverage.maxBlockNumber?.toString() ?? 'null'}`,
      );
    }

    const canonicalBlock = await loadCanonicalBlock(client, { blockNumber: endBlock, lane });
    if (!canonicalBlock) {
      throw new Error(`No canonical block journal row found for lane=${lane} block=${endBlock.toString()}`);
    }

    await advanceCheckpoint(client, {
      blockHash: canonicalBlock.blockHash,
      blockNumber: endBlock,
      finalityStatus: canonicalBlock.finalityStatus,
      indexerKey,
      lane,
      newRoot: canonicalBlock.newRoot,
      oldRoot: canonicalBlock.oldRoot,
      parentHash: canonicalBlock.parentHash,
    });
  });

  console.log(
    `[promote-checkpoint] promoted indexer_key=${indexerKey} lane=${lane} to block=${endBlock.toString()} using prefix=${indexerKeyPrefix}`,
  );
}

async function loadCheckpoint(client, { indexerKey, lane, forUpdate = false }) {
  const checkpoint = await getCheckpoint(client, { forUpdate, indexerKey, lane });
  return checkpoint;
}

async function loadCanonicalCoverage(client, { lane, startBlock, endBlock }) {
  const result = await client.query(
    `SELECT MIN(block_number) AS min_block_number,
            MAX(block_number) AS max_block_number,
            COUNT(*) AS canonical_count
       FROM stark_block_journal
      WHERE lane = $1
        AND is_orphaned = FALSE
        AND block_number BETWEEN $2 AND $3`,
    [
      lane,
      toNumericString(startBlock, 'canonical coverage start block'),
      toNumericString(endBlock, 'canonical coverage end block'),
    ],
  );

  return {
    canonicalCount: BigInt(result.rows[0]?.canonical_count ?? 0),
    maxBlockNumber: result.rows[0]?.max_block_number === null ? null : BigInt(result.rows[0].max_block_number),
    minBlockNumber: result.rows[0]?.min_block_number === null ? null : BigInt(result.rows[0].min_block_number),
  };
}

async function loadCanonicalBlock(client, { blockNumber, lane }) {
  const result = await client.query(
    `SELECT block_hash,
            parent_hash,
            old_root,
            new_root,
            finality_status
       FROM stark_block_journal
      WHERE lane = $1
        AND block_number = $2
        AND is_orphaned = FALSE
      LIMIT 1`,
    [lane, toNumericString(blockNumber, 'canonical block number')],
  );

  if (result.rowCount === 0) {
    return null;
  }

  return {
    blockHash: result.rows[0].block_hash,
    finalityStatus: result.rows[0].finality_status,
    newRoot: result.rows[0].new_root ?? null,
    oldRoot: result.rows[0].old_root ?? null,
    parentHash: result.rows[0].parent_hash,
  };
}

function buildWorkerRanges({ chunkSize, endBlock, indexerKeyPrefix, startBlock, totalWorkers }) {
  const ranges = [];
  for (let workerIndex = 1; workerIndex <= totalWorkers; workerIndex += 1) {
    const rangeStart = startBlock + (BigInt(workerIndex - 1) * chunkSize);
    if (rangeStart > endBlock) {
      break;
    }

    const rangeEnd = minBigInt(endBlock, rangeStart + chunkSize - 1n);
    ranges.push({
      rangeEnd,
      rangeStart,
      workerIndex,
      workerKey: `${indexerKeyPrefix}-w${workerIndex}`,
    });
  }

  return ranges;
}

function validateWorkerRanges(ranges, { startBlock, endBlock }) {
  if (ranges.length === 0) {
    throw new Error('No worker ranges resolved for backfill checkpoint promotion.');
  }

  if (ranges[0].rangeStart !== startBlock) {
    throw new Error(`Worker ranges do not start at expected block ${startBlock.toString()}. actual_start=${ranges[0].rangeStart.toString()}`);
  }

  const finalRange = ranges[ranges.length - 1];
  if (finalRange.rangeEnd !== endBlock) {
    throw new Error(
      `Backfill ranges do not fully cover promotion target. expected_end=${endBlock.toString()} actual_end=${finalRange.rangeEnd.toString()}. Increase BACKFILL_TOTAL_WORKERS or adjust chunk settings.`,
    );
  }

  for (let index = 1; index < ranges.length; index += 1) {
    const previous = ranges[index - 1];
    const current = ranges[index];
    if (current.rangeStart <= previous.rangeEnd) {
      throw new Error(
        `Detected overlapping worker ranges. prev_worker=${previous.workerIndex} prev_range=${previous.rangeStart.toString()}-${previous.rangeEnd.toString()} current_worker=${current.workerIndex} current_range=${current.rangeStart.toString()}-${current.rangeEnd.toString()}`,
      );
    }
    if (current.rangeStart !== (previous.rangeEnd + 1n)) {
      throw new Error(
        `Detected gap between worker ranges. prev_worker=${previous.workerIndex} prev_end=${previous.rangeEnd.toString()} current_worker=${current.workerIndex} current_start=${current.rangeStart.toString()}`,
      );
    }
  }
}

function parsePositiveInteger(value, fallbackValue, label) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallbackValue;
  }

  const parsed = Number.parseInt(String(value).trim(), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer, received: ${value}`);
  }

  return parsed;
}

function parseNonNegativeBigInt(value, fallbackValue, label) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallbackValue;
  }

  const parsed = BigInt(String(value).trim());
  if (parsed < 0n) {
    throw new Error(`${label} cannot be negative, received: ${value}`);
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

main()
  .catch((error) => {
    console.error(`[promote-checkpoint] fatal: ${error.stack || error.message || String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
