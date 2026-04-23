#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawn } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { closePool, withClient } = require('../lib/db');
const { StarknetRpcClient } = require('../lib/starknet-rpc');

const DEFAULT_LIVE_WINDOW_BLOCKS = 1000n;
const DEFAULT_CHECK_INTERVAL_MS = 30_000;

let childProcess = null;
let shuttingDown = false;

async function main() {
  const [targetScript, ...targetArgs] = process.argv.slice(2);
  if (!targetScript) {
    throw new Error('Usage: node scripts/defer-until-live.js <script-path> [...script-args]');
  }

  const targetScriptPath = path.resolve(__dirname, '..', targetScript);
  const liveWindowBlocks = parsePositiveBigInt(process.env.LIVE_WINDOW_BLOCK_LAG, DEFAULT_LIVE_WINDOW_BLOCKS, 'LIVE_WINDOW_BLOCK_LAG');
  const checkIntervalMs = parsePositiveInteger(
    process.env.PHASE6_DEFER_CHECK_INTERVAL_MS,
    DEFAULT_CHECK_INTERVAL_MS,
    'PHASE6_DEFER_CHECK_INTERVAL_MS',
  );
  const indexerKey = process.env.INDEXER_KEY || 'starknetdeg-mainnet';
  const lane = String(process.env.INDEXER_LANE || 'ACCEPTED_ON_L2').trim().toUpperCase();
  const rpcClient = new StarknetRpcClient();

  installSignalHandlers();

  while (!shuttingDown) {
    const latestHead = await rpcClient.getBlockNumber();
    const checkpoint = await loadCheckpoint({ indexerKey, lane });
    const currentBlock = checkpoint === null ? 0n : checkpoint;
    const lag = latestHead > currentBlock ? latestHead - currentBlock : 0n;

    if (lag <= liveWindowBlocks) {
      console.log(
        `[defer-live] live window reached for ${targetScript}. current=${currentBlock.toString()} head=${latestHead.toString()} lag=${lag.toString()} threshold=${liveWindowBlocks.toString()}`,
      );
      break;
    }

    console.log(
      `[defer-live] waiting for ${targetScript}. current=${currentBlock.toString()} head=${latestHead.toString()} lag=${lag.toString()} threshold=${liveWindowBlocks.toString()} next_check_ms=${checkIntervalMs}`,
    );
    await sleep(checkIntervalMs);
  }

  if (shuttingDown) {
    return;
  }

  await closePool();

  await runChild(targetScriptPath, targetArgs);
}

async function loadCheckpoint({ indexerKey, lane }) {
  return withClient(async (client) => {
    const result = await client.query(
      `SELECT last_processed_block_number
         FROM stark_index_state
        WHERE indexer_key = $1
          AND lane = $2`,
      [indexerKey, lane],
    );

    if (result.rowCount === 0) {
      return null;
    }

    const value = result.rows[0]?.last_processed_block_number;
    return value === null || value === undefined ? null : BigInt(value);
  });
}

async function runChild(targetScriptPath, targetArgs) {
  await new Promise((resolve, reject) => {
    childProcess = spawn(process.execPath, [targetScriptPath, ...targetArgs], {
      cwd: path.resolve(__dirname, '..'),
      env: process.env,
      stdio: 'inherit',
    });

    childProcess.on('error', (error) => {
      reject(error);
    });

    childProcess.on('exit', (code, signal) => {
      childProcess = null;
      if (signal) {
        reject(new Error(`Deferred process exited with signal ${signal}`));
        return;
      }

      if (code !== 0) {
        reject(new Error(`Deferred process exited with code ${code ?? 1}`));
        return;
      }

      resolve();
    });
  });
}

function installSignalHandlers() {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, async () => {
      shuttingDown = true;
      if (childProcess) {
        try {
          childProcess.kill(signal);
        } catch (error) {
          // Ignore child shutdown errors.
        }
      }

      try {
        await closePool();
      } finally {
        process.exit(0);
      }
    });
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
  console.error(`[defer-live] fatal: ${error.stack || error.message || String(error)}`);
  try {
    await closePool();
  } finally {
    process.exit(1);
  }
});
