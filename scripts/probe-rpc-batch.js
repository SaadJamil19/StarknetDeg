#!/usr/bin/env node
'use strict';

const path = require('node:path');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { StarknetRpcClient } = require('../lib/starknet-rpc');

async function main() {
  const client = new StarknetRpcClient();
  const head = await client.getBlockNumber();
  const batchSupported = await client.supportsBatchRpc();

  console.log(
    `[rpc-batch] node=${client.nodeUrl} head=${head.toString()} batch_supported=${batchSupported} mode=${client.batchSupportMode} max_requests=${client.batchMaxRequests}`,
  );
}

main().catch((error) => {
  console.error(`[rpc-batch] fatal: ${error.stack || error.message || String(error)}`);
  process.exitCode = 1;
});
