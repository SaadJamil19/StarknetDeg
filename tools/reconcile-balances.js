#!/usr/bin/env node
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { assertFoundationTables, assertPhase6Tables } = require('../core/checkpoint');
const { FINALITY_LANES, normalizeFinalityStatus } = require('../core/finality');
const { normalizeAddress, parseU256FromArray } = require('../core/normalize');
const { closePool, withClient } = require('../lib/db');
const { StarknetRpcClient } = require('../lib/starknet-rpc');

async function main() {
  const lane = normalizeFinalityStatus(process.env.RECONCILE_BALANCES_LANE || process.env.PHASE6_ANALYTICS_LANE || FINALITY_LANES.ACCEPTED_ON_L2);
  const limit = parsePositiveInteger(process.env.RECONCILE_BALANCES_LIMIT, 100);
  const concurrency = parsePositiveInteger(process.env.RECONCILE_BALANCES_CONCURRENCY, 8);
  const strict = parseBoolean(process.env.RECONCILE_BALANCES_STRICT, false);
  const blockId = parseBlockId(process.env.RECONCILE_BALANCES_BLOCK_ID);
  const rpcClient = new StarknetRpcClient();

  const candidates = await withClient(async (client) => {
    await assertFoundationTables(client);
    await assertPhase6Tables(client);
    return loadTopHolderBalances(client, { lane, limit });
  });

  const results = await mapConcurrent(candidates, concurrency, async (row) => {
    const rpcBalance = await readBalanceOf(rpcClient, {
      blockId,
      holderAddress: row.holderAddress,
      tokenAddress: row.tokenAddress,
    });
    const matches = rpcBalance !== null && rpcBalance === row.dbBalance;

    return {
      ...row,
      matches,
      rpcBalance,
    };
  });

  const mismatches = results.filter((row) => !row.matches);
  const failedRpc = results.filter((row) => row.rpcBalance === null);

  console.log(JSON.stringify({
    checked: results.length,
    failedRpc: failedRpc.length,
    lane,
    limit,
    mismatches: mismatches.length,
  }, null, 2));

  for (const row of mismatches.slice(0, 25)) {
    console.log(JSON.stringify({
      dbBalance: row.dbBalance.toString(10),
      holderAddress: row.holderAddress,
      rpcBalance: row.rpcBalance === null ? null : row.rpcBalance.toString(10),
      tokenAddress: row.tokenAddress,
    }));
  }

  await closePool();

  if (strict && mismatches.length > 0) {
    process.exitCode = 1;
  }
}

async function loadTopHolderBalances(client, { lane, limit }) {
  const result = await client.query(
    `SELECT balance.token_address,
            balance.holder_address,
            balance.balance,
            concentration.balance_usd
       FROM stark_holder_balances AS balance
       LEFT JOIN stark_token_concentration AS concentration
              ON concentration.lane = balance.lane
             AND concentration.token_address = balance.token_address
             AND concentration.holder_address = balance.holder_address
      WHERE balance.lane = $1
        AND balance.balance > 0
      ORDER BY concentration.balance_usd DESC NULLS LAST,
               balance.balance DESC
      LIMIT $2`,
    [lane, limit],
  );

  return result.rows.map((row) => ({
    balanceUsd: row.balance_usd === null ? null : String(row.balance_usd),
    dbBalance: BigInt(row.balance),
    holderAddress: normalizeAddress(row.holder_address, 'holder address'),
    tokenAddress: normalizeAddress(row.token_address, 'token address'),
  }));
}

async function readBalanceOf(rpcClient, { blockId, holderAddress, tokenAddress }) {
  try {
    const result = await rpcClient.callContract({
      blockId,
      calldata: [holderAddress],
      contractAddress: tokenAddress,
      entrypoint: 'balanceOf',
    });
    return parseU256FromArray(result, 0, 'balanceOf');
  } catch (error) {
    return null;
  }
}

async function mapConcurrent(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function parseBlockId(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return 'latest';
  }

  const trimmed = String(value).trim();
  if (trimmed === 'latest' || trimmed === 'pending' || /^0x[0-9a-fA-F]+$/.test(trimmed)) {
    return trimmed;
  }

  return BigInt(trimmed);
}

function parsePositiveInteger(value, fallbackValue) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallbackValue;
  }

  const parsed = Number.parseInt(String(value).trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallbackValue;
}

function parseBoolean(value, fallbackValue = false) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallbackValue;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

main().catch(async (error) => {
  console.error(error.stack || error.message || String(error));
  await closePool();
  process.exitCode = 1;
});
