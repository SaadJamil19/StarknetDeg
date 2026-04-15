#!/usr/bin/env node
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { setTimeout: sleep } = require('node:timers/promises');
const { assertFoundationTables, assertPhase2Tables, assertPhase3Tables, assertPhase4Tables, assertPhase6Tables } = require('../core/checkpoint');
const { FINALITY_LANES } = require('../core/finality');
const { toJsonbString } = require('../core/protocols/shared');
const { toBigIntStrict, toNumericString } = require('../lib/cairo/bigint');
const {
  DEFAULT_SCALE,
  absBigInt,
  compareBigInt,
  decimalStringToScaled,
  scaledRatio,
  scaledToNumericString,
} = require('../lib/cairo/fixed-point');
const { closePool, withClient, withTransaction } = require('../lib/db');
const {
  ZERO_ADDRESS,
  computeUsdValueFromRawAmount,
  formatError,
  loadTokenMarketContext,
  parseBoolean,
  parsePositiveInteger,
  replaceLeaderboards,
  resolveAnalyticsWindow,
  scaledOrNullToNumeric,
} = require('./analytics-utils');

let shuttingDown = false;

async function main() {
  const runOnce = parseBoolean(process.env.PHASE6_CONCENTRATION_RUN_ONCE, true);
  const pollIntervalMs = parsePositiveInteger(process.env.PHASE6_CONCENTRATION_INTERVAL_MS, 180_000);

  installSignalHandlers();

  await withClient(async (client) => {
    await assertFoundationTables(client);
    await assertPhase2Tables(client);
    await assertPhase3Tables(client);
    await assertPhase4Tables(client);
    await assertPhase6Tables(client);
  });

  console.log(`[phase6] concentration-rollups starting run_once=${runOnce}`);

  do {
    try {
      const summary = await refreshConcentrationRollups();
      console.log(
        `[phase6] concentration-rollups lane=${summary.lane} max_block=${summary.maxBlockNumber} balances=${summary.balances} deltas=${summary.deltas} concentrations=${summary.concentrations} alerts=${summary.alerts}`,
      );
    } catch (error) {
      console.error(`[phase6] concentration-rollups error: ${formatError(error)}`);
    }

    if (runOnce || shuttingDown) {
      break;
    }

    await sleep(pollIntervalMs);
  } while (!shuttingDown);

  await closePool();
}

async function refreshConcentrationRollups({
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

    await client.query(`DELETE FROM stark_holder_balance_deltas WHERE lane = $1`, [window.lane]);
    await client.query(`DELETE FROM stark_holder_balances WHERE lane = $1`, [window.lane]);
    await client.query(`DELETE FROM stark_token_concentration WHERE lane = $1`, [window.lane]);
    await client.query(
      `DELETE FROM stark_whale_alert_candidates
        WHERE lane = $1
          AND alert_type IN ('concentration_whale', 'bridge_flow_whale', 'bridge_then_trade_whale')`,
      [window.lane],
    );

    if (window.maxBlockNumber === null) {
      return {
        alerts: 0,
        balances: 0,
        concentrations: 0,
        deltas: 0,
        lane: window.lane,
        maxBlockNumber: 'none',
      };
    }

    const transfers = await loadTransfers(client, {
      lane: window.lane,
      maxBlockNumber: window.maxBlockNumber,
    });
    const activeTraderSet = await loadActiveTraderSet(client, { lane: window.lane });
    const tokenContext = await loadTokenMarketContext(client, {
      lane: window.lane,
      tokenAddresses: Array.from(new Set(transfers.map((row) => row.tokenAddress))),
    });
    const balanceState = new Map();
    const deltaRows = [];

    for (const transfer of transfers) {
      if (transfer.fromAddress !== ZERO_ADDRESS) {
        deltaRows.push(applyTransferDelta(balanceState, transfer, {
          activeTraderSet,
          deltaAmount: -transfer.amount,
          direction: 'debit',
          holderAddress: transfer.fromAddress,
        }));
      }

      if (transfer.toAddress !== ZERO_ADDRESS) {
        deltaRows.push(applyTransferDelta(balanceState, transfer, {
          activeTraderSet,
          deltaAmount: transfer.amount,
          direction: 'credit',
          holderAddress: transfer.toAddress,
        }));
      }
    }

    for (const delta of deltaRows) {
      await insertHolderDelta(client, delta, { lane: window.lane });
    }

    const concentrationRows = buildConcentrationRows({
      balanceState,
      lane: window.lane,
      maxBlockNumber: window.maxBlockNumber,
      tokenContext,
    });

    for (const balance of Array.from(balanceState.values()).filter((row) => row.balance > 0n)) {
      await upsertHolderBalance(client, balance, { lane: window.lane });
    }

    for (const row of concentrationRows) {
      await upsertTokenConcentration(client, row);
    }

    await refreshConcentrationLeaderboards(client, {
      asOfBlockNumber: window.maxBlockNumber,
      concentrationRows,
      lane: window.lane,
    });

    const alerts = await refreshWhaleAlerts(client, {
      concentrationRows,
      lane: window.lane,
      maxBlockNumber: window.maxBlockNumber,
    });

    return {
      alerts,
      balances: Array.from(balanceState.values()).filter((row) => row.balance > 0n).length,
      concentrations: concentrationRows.length,
      deltas: deltaRows.length,
      lane: window.lane,
      maxBlockNumber: window.maxBlockNumber.toString(10),
    };
  });
}

async function loadTransfers(client, { lane, maxBlockNumber }) {
  const result = await client.query(
    `SELECT transfer_key,
            block_number,
            block_hash,
            transaction_hash,
            transaction_index,
            source_event_index,
            token_address,
            from_address,
            to_address,
            amount
       FROM stark_transfers
      WHERE lane = $1
        AND block_number <= $2
      ORDER BY block_number ASC, transaction_index ASC, source_event_index ASC, transfer_key ASC`,
    [lane, toNumericString(maxBlockNumber, 'concentration max block')],
  );

  return result.rows.map((row) => ({
    amount: toBigIntStrict(row.amount, 'holder transfer amount'),
    blockHash: row.block_hash,
    blockNumber: toBigIntStrict(row.block_number, 'holder transfer block number'),
    fromAddress: row.from_address,
    sourceEventIndex: toBigIntStrict(row.source_event_index, 'holder transfer source event index'),
    toAddress: row.to_address,
    tokenAddress: row.token_address,
    transactionHash: row.transaction_hash,
    transactionIndex: toBigIntStrict(row.transaction_index, 'holder transfer transaction index'),
    transferKey: row.transfer_key,
  }));
}

async function loadActiveTraderSet(client, { lane }) {
  const result = await client.query(
    `SELECT wallet_address
       FROM stark_wallet_stats
      WHERE lane = $1`,
    [lane],
  );

  return new Set(result.rows.map((row) => row.wallet_address).filter(Boolean));
}

function applyTransferDelta(balanceState, transfer, { activeTraderSet, deltaAmount, direction, holderAddress }) {
  const key = `${transfer.tokenAddress}:${holderAddress}`;
  const isInternalTransfer = Boolean(
    transfer.fromAddress
    && transfer.toAddress
    && transfer.fromAddress !== ZERO_ADDRESS
    && transfer.toAddress !== ZERO_ADDRESS
    && activeTraderSet?.has(transfer.fromAddress)
    && activeTraderSet?.has(transfer.toAddress)
  );
  const current = balanceState.get(key) ?? {
    balance: 0n,
    firstSeenBlockNumber: null,
    holderAddress,
    lastSourceEventIndex: null,
    lastTransactionHash: null,
    lastTransactionIndex: null,
    lastUpdatedBlockNumber: null,
    tokenAddress: transfer.tokenAddress,
  };

  const nextBalance = current.balance + deltaAmount;
  if (nextBalance < 0n) {
    throw new Error(`Negative holder balance detected for ${holderAddress} on ${transfer.tokenAddress}.`);
  }

  if (current.firstSeenBlockNumber === null) {
    current.firstSeenBlockNumber = transfer.blockNumber;
  }

  current.balance = nextBalance;
  current.lastUpdatedBlockNumber = transfer.blockNumber;
  current.lastTransactionHash = transfer.transactionHash;
  current.lastTransactionIndex = transfer.transactionIndex;
  current.lastSourceEventIndex = transfer.sourceEventIndex;
  balanceState.set(key, current);

  return {
    balanceDirection: direction,
    blockHash: transfer.blockHash,
    blockNumber: transfer.blockNumber,
    deltaAmount,
    deltaKey: `${transfer.transferKey}:${holderAddress}:${direction}`,
    holderAddress,
    sourceEventIndex: transfer.sourceEventIndex,
    tokenAddress: transfer.tokenAddress,
    transactionHash: transfer.transactionHash,
    transactionIndex: transfer.transactionIndex,
    transferKey: transfer.transferKey,
    metadata: {
      classification: isInternalTransfer ? 'INTERNAL_TRANSFER' : 'TOKEN_TRANSFER',
      peer_wallet_address: direction === 'credit' ? transfer.fromAddress : transfer.toAddress,
    },
  };
}

function buildConcentrationRows({ balanceState, lane, maxBlockNumber, tokenContext }) {
  const rows = [];
  const balancesByToken = new Map();
  const whaleBpsThreshold = decimalStringToScaled(process.env.PHASE6_WHALE_CONCENTRATION_BPS ?? '100', DEFAULT_SCALE);
  const whaleUsdThreshold = decimalStringToScaled(process.env.PHASE6_WHALE_BALANCE_USD_THRESHOLD ?? '500000', DEFAULT_SCALE);

  for (const balance of balanceState.values()) {
    if (balance.balance <= 0n) {
      continue;
    }

    if (!balancesByToken.has(balance.tokenAddress)) {
      balancesByToken.set(balance.tokenAddress, []);
    }
    balancesByToken.get(balance.tokenAddress).push(balance);
  }

  for (const [tokenAddress, balances] of balancesByToken.entries()) {
    balances.sort((left, right) => compareBigInt(right.balance, left.balance));
    const tokenInfo = tokenContext.get(tokenAddress) ?? null;
    const totalSupply = tokenInfo?.totalSupply ?? null;

    for (let index = 0; index < balances.length; index += 1) {
      const balance = balances[index];
      const concentrationRatioScaled = totalSupply && totalSupply > 0n
        ? scaledRatio(balance.balance, totalSupply, 0, DEFAULT_SCALE)
        : null;
      const concentrationBpsScaled = concentrationRatioScaled === null
        ? null
        : concentrationRatioScaled * 10000n;
      const balanceUsdScaled = computeUsdValueFromRawAmount(balance.balance, tokenInfo, { allowStale: true });
      const isWhale = Boolean(
        (concentrationBpsScaled !== null && compareBigInt(concentrationBpsScaled, whaleBpsThreshold) >= 0)
        || (balanceUsdScaled !== null && compareBigInt(balanceUsdScaled, whaleUsdThreshold) >= 0)
      );

      rows.push({
        balance: balance.balance,
        balanceUsdScaled,
        blockNumber: maxBlockNumber,
        concentrationBpsScaled,
        concentrationRatioScaled,
        holderAddress: balance.holderAddress,
        holderRank: BigInt(index + 1),
        isWhale,
        lane,
        metadata: {
          last_transaction_hash: balance.lastTransactionHash,
          token_symbol: tokenInfo?.symbol ?? null,
        },
        tokenAddress,
        totalSupply,
      });
    }
  }

  return rows;
}

async function insertHolderDelta(client, delta, { lane }) {
  await client.query(
    `INSERT INTO stark_holder_balance_deltas (
         delta_key,
         lane,
         block_number,
         block_hash,
         transaction_hash,
         transaction_index,
         source_event_index,
         transfer_key,
         token_address,
         holder_address,
         delta_amount,
         balance_direction,
         metadata,
         created_at,
         updated_at
     ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, $12, $13::jsonb, NOW(), NOW()
     )`,
    [
      delta.deltaKey,
      lane,
      toNumericString(delta.blockNumber, 'holder delta block number'),
      delta.blockHash,
      delta.transactionHash,
      toNumericString(delta.transactionIndex, 'holder delta transaction index'),
      toNumericString(delta.sourceEventIndex, 'holder delta source event index'),
      delta.transferKey,
      delta.tokenAddress,
      delta.holderAddress,
      toNumericString(delta.deltaAmount, 'holder delta amount'),
      delta.balanceDirection,
      toJsonbString(delta.metadata ?? {}),
    ],
  );
}

async function upsertHolderBalance(client, row, { lane }) {
  await client.query(
    `INSERT INTO stark_holder_balances (
         lane,
         token_address,
         holder_address,
         balance,
         first_seen_block_number,
         last_updated_block_number,
         last_transaction_hash,
         last_transaction_index,
         last_source_event_index,
         metadata,
         created_at,
         updated_at
     ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, NOW(), NOW()
     )`,
    [
      lane,
      row.tokenAddress,
      row.holderAddress,
      toNumericString(row.balance, 'holder balance'),
      row.firstSeenBlockNumber === null ? null : toNumericString(row.firstSeenBlockNumber, 'holder first seen block'),
      row.lastUpdatedBlockNumber === null ? null : toNumericString(row.lastUpdatedBlockNumber, 'holder last updated block'),
      row.lastTransactionHash,
      row.lastTransactionIndex === null ? null : toNumericString(row.lastTransactionIndex, 'holder last transaction index'),
      row.lastSourceEventIndex === null ? null : toNumericString(row.lastSourceEventIndex, 'holder last source event index'),
      toJsonbString({}),
    ],
  );
}

async function upsertTokenConcentration(client, row) {
  await client.query(
    `INSERT INTO stark_token_concentration (
         lane,
         token_address,
         holder_address,
         block_number,
         balance,
         total_supply,
         balance_usd,
         concentration_ratio,
         concentration_bps,
         holder_rank,
         is_whale,
         metadata,
         created_at,
         updated_at
     ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, $12::jsonb, NOW(), NOW()
     )`,
    [
      row.lane,
      row.tokenAddress,
      row.holderAddress,
      toNumericString(row.blockNumber, 'concentration block number'),
      toNumericString(row.balance, 'concentration balance'),
      row.totalSupply === null ? null : toNumericString(row.totalSupply, 'concentration total supply'),
      scaledOrNullToNumeric(row.balanceUsdScaled),
      scaledOrNullToNumeric(row.concentrationRatioScaled),
      scaledOrNullToNumeric(row.concentrationBpsScaled),
      toNumericString(row.holderRank, 'concentration rank'),
      row.isWhale,
      toJsonbString(row.metadata ?? {}),
    ],
  );
}

async function refreshConcentrationLeaderboards(client, { asOfBlockNumber, concentrationRows, lane }) {
  const limit = parsePositiveInteger(process.env.PHASE6_LEADERBOARD_LIMIT, 25);
  const byConcentration = [...concentrationRows]
    .filter((row) => row.concentrationBpsScaled !== null)
    .sort((left, right) => compareBigInt(right.concentrationBpsScaled, left.concentrationBpsScaled))
    .slice(0, limit)
    .map((row, index) => ({
      entityKey: `${row.tokenAddress}:${row.holderAddress}`,
      entityType: 'holder',
      metadata: {
        holder_address: row.holderAddress,
        token_address: row.tokenAddress,
      },
      metricValue: scaledToNumericString(row.concentrationBpsScaled, DEFAULT_SCALE),
      rank: BigInt(index + 1),
    }));
  const byBalanceUsd = [...concentrationRows]
    .filter((row) => row.balanceUsdScaled !== null)
    .sort((left, right) => compareBigInt(right.balanceUsdScaled, left.balanceUsdScaled))
    .slice(0, limit)
    .map((row, index) => ({
      entityKey: `${row.tokenAddress}:${row.holderAddress}`,
      entityType: 'holder',
      metadata: {
        holder_address: row.holderAddress,
        token_address: row.tokenAddress,
      },
      metricValue: scaledToNumericString(row.balanceUsdScaled, DEFAULT_SCALE),
      rank: BigInt(index + 1),
    }));

  await replaceLeaderboards(client, {
    asOfBlockNumber,
    lane,
    leaderboardName: 'holder_concentration_bps',
    rows: byConcentration,
  });
  await replaceLeaderboards(client, {
    asOfBlockNumber,
    lane,
    leaderboardName: 'holder_balance_usd',
    rows: byBalanceUsd,
  });
}

async function refreshWhaleAlerts(client, { concentrationRows, lane, maxBlockNumber }) {
  const alerts = [];
  const bridgeThresholdUsdScaled = decimalStringToScaled(process.env.PHASE6_WHALE_BRIDGE_USD_THRESHOLD ?? '250000', DEFAULT_SCALE);
  const tradeThresholdUsdScaled = decimalStringToScaled(process.env.PHASE6_WHALE_TRADE_USD_THRESHOLD ?? '250000', DEFAULT_SCALE);
  const velocityByWallet = await loadVelocityByWallet(client, {
    lane,
    maxBlockGap: parsePositiveInteger(process.env.PHASE6_WHALE_VELOCITY_BLOCK_WINDOW, 100),
    maxBlockNumber,
  });

  for (const row of concentrationRows.filter((item) => item.isWhale)) {
    const velocityScoreScaled = velocityByWallet.get(row.holderAddress)?.velocityScoreScaled ?? 0n;
    alerts.push({
      alertKey: `concentration:${lane}:${row.tokenAddress}:${row.holderAddress}`,
      alertType: 'concentration_whale',
      blockNumber: row.blockNumber,
      metricAmount: row.balance,
      metricUsdScaled: row.balanceUsdScaled,
      metadata: {
        concentration_bps: row.concentrationBpsScaled === null ? null : scaledToNumericString(row.concentrationBpsScaled, DEFAULT_SCALE),
        holder_rank: row.holderRank.toString(10),
      },
      severity: compareBigInt(velocityScoreScaled, decimalStringToScaled('0.5', DEFAULT_SCALE)) >= 0 ? 'critical' : 'warning',
      tokenAddress: row.tokenAddress,
      velocityScoreScaled,
      walletAddress: row.holderAddress,
    });
  }

  const bridgeFlowResult = await client.query(
    `SELECT wallet_address,
            token_address,
            bridge_inflow_usd,
            bridge_outflow_usd,
            net_bridge_flow_usd
       FROM stark_wallet_bridge_flows
      WHERE lane = $1`,
    [lane],
  );
  const walletStatsResult = await client.query(
    `SELECT wallet_address,
            total_volume_usd,
            net_bridge_flow_usd
       FROM stark_wallet_stats
      WHERE lane = $1`,
    [lane],
  );

  for (const row of bridgeFlowResult.rows) {
    const magnitude = absBigInt(decimalStringToScaled(row.net_bridge_flow_usd ?? '0', DEFAULT_SCALE));
    if (compareBigInt(magnitude, bridgeThresholdUsdScaled) < 0) {
      continue;
    }

    const velocityScoreScaled = velocityByWallet.get(row.wallet_address)?.velocityScoreScaled ?? 0n;

    alerts.push({
      alertKey: `bridge:${lane}:${row.wallet_address}:${row.token_address}`,
      alertType: 'bridge_flow_whale',
      blockNumber: maxBlockNumber,
      metricAmount: null,
      metricUsdScaled: magnitude,
      metadata: {
        net_bridge_flow_usd: row.net_bridge_flow_usd,
      },
      severity: compareBigInt(velocityScoreScaled, decimalStringToScaled('0.75', DEFAULT_SCALE)) >= 0
        ? 'critical'
        : (compareBigInt(magnitude, bridgeThresholdUsdScaled * 4n) >= 0 ? 'critical' : 'warning'),
      tokenAddress: row.token_address,
      velocityScoreScaled,
      walletAddress: row.wallet_address,
    });
  }

  for (const row of walletStatsResult.rows) {
    const bridgeFlowScaled = absBigInt(decimalStringToScaled(row.net_bridge_flow_usd ?? '0', DEFAULT_SCALE));
    const volumeScaled = absBigInt(decimalStringToScaled(row.total_volume_usd ?? '0', DEFAULT_SCALE));
    if (compareBigInt(bridgeFlowScaled, bridgeThresholdUsdScaled) < 0 || compareBigInt(volumeScaled, tradeThresholdUsdScaled) < 0) {
      continue;
    }

    const velocityScoreScaled = velocityByWallet.get(row.wallet_address)?.velocityScoreScaled ?? 0n;

    alerts.push({
      alertKey: `bridge-trade:${lane}:${row.wallet_address}`,
      alertType: 'bridge_then_trade_whale',
      blockNumber: maxBlockNumber,
      metricAmount: null,
      metricUsdScaled: bridgeFlowScaled,
      metadata: {
        closest_bridge_gap_blocks: velocityByWallet.get(row.wallet_address)?.minGapBlocks?.toString(10) ?? null,
        net_bridge_flow_usd: scaledToNumericString(bridgeFlowScaled, DEFAULT_SCALE),
        total_volume_usd: scaledToNumericString(volumeScaled, DEFAULT_SCALE),
      },
      severity: compareBigInt(velocityScoreScaled, decimalStringToScaled('0.85', DEFAULT_SCALE)) >= 0 ? 'critical' : 'warning',
      tokenAddress: null,
      velocityScoreScaled,
      walletAddress: row.wallet_address,
    });
  }

  for (const alert of alerts) {
    await insertWhaleAlert(client, lane, alert);
  }

  return alerts.length;
}

async function loadVelocityByWallet(client, { lane, maxBlockGap, maxBlockNumber }) {
  const result = await client.query(
    `SELECT activity.l2_wallet_address AS wallet_address,
            MIN(trade.block_number - activity.block_number) AS min_gap_blocks
       FROM stark_bridge_activities AS activity
       JOIN stark_trades AS trade
         ON trade.lane = activity.lane
        AND trade.trader_address = activity.l2_wallet_address
        AND trade.block_number >= activity.block_number
        AND trade.block_number <= activity.block_number + $2
      WHERE activity.lane = $1
        AND activity.direction = 'bridge_in'
        AND activity.block_number <= $3
      GROUP BY activity.l2_wallet_address`,
    [lane, maxBlockGap, toNumericString(maxBlockNumber, 'velocity max block')],
  );

  const velocityByWallet = new Map();
  const denominator = BigInt(maxBlockGap + 1);

  for (const row of result.rows) {
    const minGapBlocks = toBigIntStrict(row.min_gap_blocks, 'whale velocity min gap');
    const remaining = denominator - minGapBlocks;
    const velocityScoreScaled = remaining <= 0n
      ? 0n
      : scaledRatio(remaining, denominator, 0, DEFAULT_SCALE);
    velocityByWallet.set(row.wallet_address, {
      minGapBlocks,
      velocityScoreScaled,
    });
  }

  return velocityByWallet;
}

async function insertWhaleAlert(client, lane, alert) {
  await client.query(
    `INSERT INTO stark_whale_alert_candidates (
         alert_key,
         lane,
         block_number,
         wallet_address,
         token_address,
         alert_type,
         severity,
         velocity_score,
         metric_amount,
         metric_usd,
         related_trade_key,
         related_bridge_key,
         metadata,
         created_at,
         updated_at
     ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL, NULL, $11::jsonb, NOW(), NOW()
     )`,
    [
      alert.alertKey,
      lane,
      toNumericString(alert.blockNumber, 'whale alert block number'),
      alert.walletAddress,
      alert.tokenAddress,
      alert.alertType,
      alert.severity,
      scaledOrNullToNumeric(alert.velocityScoreScaled ?? 0n),
      alert.metricAmount === null ? null : toNumericString(alert.metricAmount, 'whale alert amount'),
      scaledOrNullToNumeric(alert.metricUsdScaled),
      toJsonbString(alert.metadata ?? {}),
    ],
  );
}

function installSignalHandlers() {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      shuttingDown = true;
      console.log(`[phase6] concentration-rollups received ${signal}, stopping after current pass.`);
    });
  }
}

if (require.main === module) {
  main().catch(async (error) => {
    console.error(`[phase6] concentration-rollups fatal error: ${formatError(error)}`);
    try {
      await closePool();
    } finally {
      process.exitCode = 1;
    }
  });
}

module.exports = {
  refreshConcentrationRollups,
};
