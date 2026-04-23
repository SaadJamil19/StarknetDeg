#!/usr/bin/env node
'use strict';

const path = require('node:path');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { closePool, withClient } = require('../lib/db');
const { StarknetRpcClient } = require('../lib/starknet-rpc');
const { FINALITY_LANES, normalizeFinalityStatus } = require('../core/finality');
const { getCheckpoint } = require('../core/checkpoint');
const { reconcileTurboBackfillIndexes } = require('../core/block-processor');

async function main() {
  const force = process.argv.includes('--force');
  const indexerKey = process.env.INDEXER_KEY || 'starknetdeg-mainnet';
  const lane = normalizeFinalityStatus(process.env.INDEXER_LANE || FINALITY_LANES.ACCEPTED_ON_L2);
  const lagThreshold = parsePositiveBigInt(
    process.env.INDEXER_TURBO_REBUILD_AT_LAG,
    10_000n,
    'INDEXER_TURBO_REBUILD_AT_LAG',
  );
  const rpcClient = new StarknetRpcClient();
  const latestHead = await rpcClient.getBlockNumber();
  const checkpoint = await withClient((client) => getCheckpoint(client, { indexerKey, lane }));
  const currentBlock = checkpoint?.lastProcessedBlockNumber ?? 0n;
  const lag = latestHead > currentBlock ? latestHead - currentBlock : 0n;

  console.log(
    `[turbo-indexes] indexer_key=${indexerKey} lane=${lane} current=${currentBlock.toString()} head=${latestHead.toString()} lag=${lag.toString()} threshold=${lagThreshold.toString()} force=${force}`,
  );

  if (!force && lag > lagThreshold) {
    console.log('[turbo-indexes] skipping rebuild because lag is above threshold');
    return;
  }

  const summary = await reconcileTurboBackfillIndexes({
    blockNumber: currentBlock,
    forceRestore: true,
    latestHead,
    turboMode: false,
  });
  console.log(
    `[turbo-indexes] completed action=${summary.action} changed=${Boolean(summary.changed)} index_count=${summary.indexCount ?? 0} wal_throttle_count=${summary.walThrottleCount ?? 0}`,
  );
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

main().catch(async (error) => {
  console.error(`[turbo-indexes] fatal: ${error.stack || error.message || String(error)}`);
  process.exitCode = 1;
}).finally(async () => {
  await closePool();
});
