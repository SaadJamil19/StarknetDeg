#!/usr/bin/env node
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { setTimeout: sleep } = require('node:timers/promises');
const { assertFoundationTables, assertPhase2Tables, assertPhase3Tables, assertPhase4Tables, assertPhase6Tables } = require('../core/checkpoint');
const { FINALITY_LANES } = require('../core/finality');
const { toJsonbString } = require('../core/protocols/shared');
const { toBigIntStrict, toNumericString } = require('../lib/cairo/bigint');
const { closePool, withClient, withTransaction } = require('../lib/db');
const {
  computeUsdValueFromRawAmount,
  formatError,
  loadTokenMarketContext,
  parseBoolean,
  parsePositiveInteger,
  resolveAnalyticsWindow,
  scaledOrNullToNumeric,
} = require('./analytics-utils');

let shuttingDown = false;

async function main() {
  const runOnce = parseBoolean(process.env.PHASE6_BRIDGE_ACCOUNTING_RUN_ONCE, true);
  const pollIntervalMs = parsePositiveInteger(process.env.PHASE6_BRIDGE_ACCOUNTING_INTERVAL_MS, 60_000);

  installSignalHandlers();

  await withClient(async (client) => {
    await assertFoundationTables(client);
    await assertPhase2Tables(client);
    await assertPhase3Tables(client);
    await assertPhase4Tables(client);
    await assertPhase6Tables(client);
  });

  console.log(`[phase6] bridge-accounting starting run_once=${runOnce}`);

  do {
    try {
      const summary = await refreshBridgeAccounting();
      console.log(
        `[phase6] bridge-accounting lane=${summary.lane} max_block=${summary.maxBlockNumber} activities=${summary.activities} flow_rows=${summary.flowRows} skipped=${summary.skipped} wallets=${summary.wallets}`,
      );
    } catch (error) {
      console.error(`[phase6] bridge-accounting error: ${formatError(error)}`);
    }

    if (runOnce || shuttingDown) {
      break;
    }

    await sleep(pollIntervalMs);
  } while (!shuttingDown);

  await closePool();
}

async function refreshBridgeAccounting({
  indexerKey = process.env.INDEXER_KEY || 'starknetdeg-mainnet',
  lane = process.env.PHASE6_ANALYTICS_LANE || FINALITY_LANES.ACCEPTED_ON_L2,
  requireL1 = parseBoolean(process.env.PHASE6_REQUIRE_L1, false),
} = {}) {
  return withTransaction(async (client) => {
    await assertFoundationTables(client);
    await assertPhase2Tables(client);
    await assertPhase3Tables(client);
    await assertPhase4Tables(client);
    await assertPhase6Tables(client);

    const window = await resolveAnalyticsWindow(client, { indexerKey, lane, requireL1 });

    await client.query(
      `DELETE FROM stark_wallet_bridge_flows
        WHERE lane = $1`,
      [window.lane],
    );

    if (window.maxBlockNumber === null) {
      return {
        activities: 0,
        flowRows: 0,
        lane: window.lane,
        maxBlockNumber: 'none',
        skipped: 0,
        wallets: 0,
      };
    }

    const activities = await loadBridgeActivities(client, {
      lane: window.lane,
      maxBlockNumber: window.maxBlockNumber,
    });
    const tokenContext = await loadTokenMarketContext(client, {
      lane: window.lane,
      tokenAddresses: activities.map((item) => item.tokenAddress).filter(Boolean),
    });
    const flowRows = new Map();
    let skipped = 0;

    for (const activity of activities) {
      if (!activity.walletAddress || !activity.tokenAddress) {
        skipped += 1;
        continue;
      }

      const key = `${activity.walletAddress}:${activity.tokenAddress}`;
      const tokenInfo = tokenContext.get(activity.tokenAddress) ?? null;
      const usdValueScaled = activity.amount === null ? null : computeUsdValueFromRawAmount(activity.amount, tokenInfo, { allowStale: true });
      const row = ensureBridgeFlowRow(flowRows, activity, window.lane);

      if (activity.direction === 'bridge_in') {
        row.bridgeInCount += 1n;
        if (activity.amount !== null) {
          row.bridgeInAmount += activity.amount;
        }
        if (usdValueScaled !== null) {
          row.bridgeInflowUsdScaled += usdValueScaled;
        }
      } else {
        row.bridgeOutCount += 1n;
        if (activity.amount !== null) {
          row.bridgeOutAmount += activity.amount;
        }
        if (usdValueScaled !== null) {
          row.bridgeOutflowUsdScaled += usdValueScaled;
        }
      }

      if (activity.amount === null || usdValueScaled === null) {
        row.unresolvedActivityCount += 1n;
      }

      row.netBridgeFlow = row.bridgeInAmount - row.bridgeOutAmount;
      row.netBridgeFlowUsdScaled = row.bridgeInflowUsdScaled - row.bridgeOutflowUsdScaled;
      row.lastBridgeBlockNumber = activity.blockNumber;
      row.lastBridgeTransactionHash = activity.transactionHash;
      row.priceIsStale = row.priceIsStale || Boolean(tokenInfo?.priceIsStale);
      row.priceSource = tokenInfo?.priceSource ?? row.priceSource;
      row.priceUpdatedAtBlock = tokenInfo?.priceUpdatedAtBlock ?? row.priceUpdatedAtBlock;
      row.metadata.classifications[activity.classification] = (row.metadata.classifications[activity.classification] ?? 0) + 1;
      row.metadata.directions[activity.direction] = (row.metadata.directions[activity.direction] ?? 0) + 1;
      flowRows.set(key, row);
    }

    for (const row of flowRows.values()) {
      await upsertWalletBridgeFlow(client, row, { requireL1 });
    }

    return {
      activities: activities.length,
      flowRows: flowRows.size,
      lane: window.lane,
      maxBlockNumber: window.maxBlockNumber.toString(10),
      skipped,
      wallets: new Set(Array.from(flowRows.values()).map((row) => row.walletAddress)).size,
    };
  });
}

async function loadBridgeActivities(client, { lane, maxBlockNumber }) {
  const result = await client.query(
    `SELECT block_number,
            transaction_hash,
            direction,
            classification,
            l2_wallet_address,
            token_address,
            amount
       FROM stark_bridge_activities
      WHERE lane = $1
        AND block_number <= $2
      ORDER BY block_number ASC, transaction_index ASC, COALESCE(source_event_index, 0) ASC, bridge_key ASC`,
    [lane, toNumericString(maxBlockNumber, 'bridge max block number')],
  );

  return result.rows.map((row) => ({
    amount: row.amount === null ? null : toBigIntStrict(row.amount, 'bridge amount'),
    blockNumber: toBigIntStrict(row.block_number, 'bridge block number'),
    classification: row.classification,
    direction: row.direction,
    tokenAddress: row.token_address,
    transactionHash: row.transaction_hash,
    walletAddress: row.l2_wallet_address,
  }));
}

function ensureBridgeFlowRow(store, activity, lane) {
  const key = `${activity.walletAddress}:${activity.tokenAddress}`;
  if (store.has(key)) {
    return store.get(key);
  }

  const row = {
    bridgeInAmount: 0n,
    bridgeInCount: 0n,
    bridgeInflowUsdScaled: 0n,
    bridgeOutAmount: 0n,
    bridgeOutCount: 0n,
    bridgeOutflowUsdScaled: 0n,
    lane,
    lastBridgeBlockNumber: activity.blockNumber,
    lastBridgeTransactionHash: activity.transactionHash,
    metadata: {
      classifications: {},
      directions: {},
    },
    netBridgeFlow: 0n,
    netBridgeFlowUsdScaled: 0n,
    priceIsStale: false,
    priceSource: null,
    priceUpdatedAtBlock: null,
    tokenAddress: activity.tokenAddress,
    unresolvedActivityCount: 0n,
    walletAddress: activity.walletAddress,
  };
  store.set(key, row);
  return row;
}

async function upsertWalletBridgeFlow(client, row, { requireL1 }) {
  await client.query(
    `INSERT INTO stark_wallet_bridge_flows (
         lane,
         wallet_address,
         token_address,
         bridge_in_amount,
         bridge_out_amount,
         net_bridge_flow,
         bridge_inflow_usd,
         bridge_outflow_usd,
         net_bridge_flow_usd,
         bridge_in_count,
         bridge_out_count,
         unresolved_activity_count,
         price_source,
         price_is_stale,
         price_updated_at_block,
         last_bridge_block_number,
         last_bridge_transaction_hash,
         metadata,
         created_at,
         updated_at
     ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, $12, $13, $14, $15, $16, $17, $18::jsonb, NOW(), NOW()
     )`,
    [
      row.lane,
      row.walletAddress,
      row.tokenAddress,
      toNumericString(row.bridgeInAmount, 'bridge in amount'),
      toNumericString(row.bridgeOutAmount, 'bridge out amount'),
      toNumericString(row.netBridgeFlow, 'net bridge flow'),
      scaledOrNullToNumeric(row.bridgeInflowUsdScaled),
      scaledOrNullToNumeric(row.bridgeOutflowUsdScaled),
      scaledOrNullToNumeric(row.netBridgeFlowUsdScaled),
      toNumericString(row.bridgeInCount, 'bridge in count'),
      toNumericString(row.bridgeOutCount, 'bridge out count'),
      toNumericString(row.unresolvedActivityCount, 'bridge unresolved activity count'),
      row.priceSource,
      row.priceIsStale,
      row.priceUpdatedAtBlock === null ? null : toNumericString(row.priceUpdatedAtBlock, 'bridge price updated at block'),
      toNumericString(row.lastBridgeBlockNumber, 'bridge last block number'),
      row.lastBridgeTransactionHash,
      toJsonbString({
        ...row.metadata,
        require_l1: requireL1,
      }),
    ],
  );
}

function installSignalHandlers() {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      shuttingDown = true;
      console.log(`[phase6] bridge-accounting received ${signal}, stopping after current pass.`);
    });
  }
}

if (require.main === module) {
  main().catch(async (error) => {
    console.error(`[phase6] bridge-accounting fatal error: ${formatError(error)}`);
    try {
      await closePool();
    } finally {
      process.exitCode = 1;
    }
  });
}

module.exports = {
  refreshBridgeAccounting,
};
