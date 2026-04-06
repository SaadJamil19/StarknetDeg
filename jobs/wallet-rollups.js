#!/usr/bin/env node
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { setTimeout: sleep } = require('node:timers/promises');
const { assertFoundationTables, assertPhase2Tables, assertPhase3Tables, assertPhase4Tables, assertPhase6Tables } = require('../core/checkpoint');
const { FINALITY_LANES } = require('../core/finality');
const { knownErc20Cache } = require('../core/known-erc20-cache');
const { toJsonbString } = require('../core/protocols/shared');
const { toBigIntStrict, toNumericString } = require('../lib/cairo/bigint');
const {
  DEFAULT_SCALE,
  absBigInt,
  compareBigInt,
  decimalStringToScaled,
  integerAmountToScaled,
  scaledDivide,
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
  sortByLineage,
} = require('./analytics-utils');

let shuttingDown = false;

async function main() {
  const runOnce = parseBoolean(process.env.PHASE6_WALLET_ROLLUPS_RUN_ONCE, true);
  const pollIntervalMs = parsePositiveInteger(process.env.PHASE6_WALLET_ROLLUPS_INTERVAL_MS, 120_000);
  const alwaysFullRebuild = parseBoolean(process.env.PHASE6_WALLET_ROLLUPS_ALWAYS_FULL, false);
  let initialFullRefreshDone = false;

  installSignalHandlers();

  await withClient(async (client) => {
    await assertFoundationTables(client);
    await assertPhase2Tables(client);
    await assertPhase3Tables(client);
    await assertPhase4Tables(client);
    await assertPhase6Tables(client);
  });

  console.log(`[phase6] wallet-rollups starting run_once=${runOnce}`);

  do {
    try {
      if (!initialFullRefreshDone || runOnce || alwaysFullRebuild) {
        const summary = await refreshWalletRollups();
        initialFullRefreshDone = true;
        console.log(
          `[phase6] wallet-rollups mode=full lane=${summary.lane} max_block=${summary.maxBlockNumber} wallets=${summary.wallets} positions=${summary.positions} pnl_events=${summary.pnlEvents} priced_trades=${summary.pricedTrades} skipped_trades=${summary.skippedTrades}`,
        );
      } else {
        const summary = await repairPendingWalletPricing();
        console.log(
          `[phase6] wallet-rollups mode=repair lane=${summary.lane} eligible_wallets=${summary.eligibleWallets} repaired=${summary.repaired} max_block=${summary.maxBlockNumber}`,
        );
      }
    } catch (error) {
      console.error(`[phase6] wallet-rollups error: ${formatError(error)}`);
    }

    if (runOnce || shuttingDown) {
      break;
    }

    await sleep(pollIntervalMs);
  } while (!shuttingDown);

  await closePool();
}

async function refreshWalletRollups({
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

    await client.query(`DELETE FROM stark_wallet_pnl_events WHERE lane = $1`, [window.lane]);
    await client.query(`DELETE FROM stark_wallet_positions WHERE lane = $1`, [window.lane]);
    await client.query(`DELETE FROM stark_wallet_stats WHERE lane = $1`, [window.lane]);

    if (window.maxBlockNumber === null) {
      return {
        lane: window.lane,
        maxBlockNumber: 'none',
        pnlEvents: 0,
        positions: 0,
        pricedTrades: 0,
        skippedTrades: 0,
        wallets: 0,
      };
    }

    const trades = await loadTrades(client, { lane: window.lane, maxBlockNumber: window.maxBlockNumber });
    const bridges = await loadBridgeActivities(client, { lane: window.lane, maxBlockNumber: window.maxBlockNumber });
    const tokenContext = await loadTokenMarketContext(client, {
      lane: window.lane,
      tokenAddresses: collectTokenAddresses(trades, bridges),
    });
    const tradesWithGasFees = allocateGasFeesToTrades(trades, tokenContext);
    const stream = [
      ...bridges.map((item) => ({ ...item, kind: 'bridge', sequence: 0n })),
      ...tradesWithGasFees.map((item) => ({ ...item, kind: 'trade', sequence: 1n })),
    ].sort(sortByLineage);

    const positions = new Map();
    const walletStats = new Map();
    const pnlEvents = [];
    let pricedTrades = 0;
    let skippedTrades = 0;

    for (const item of stream) {
      if (item.kind === 'bridge') {
        processBridgeActivity({
          activity: item,
          positions,
          tokenContext,
          walletStats,
        });
        continue;
      }

      const accepted = processTrade({
        lane: window.lane,
        pnlEvents,
        positions,
        trade: item,
        walletStats,
      });

      if (accepted) {
        pricedTrades += 1;
      } else {
        skippedTrades += 1;
      }
    }

    const positionRows = buildWalletPositionRows({
      lane: window.lane,
      positions,
      tokenContext,
      walletStats,
    });

    for (const row of positionRows) {
      await upsertWalletPosition(client, row);
    }

    for (const pnlEvent of pnlEvents) {
      await insertWalletPnlEvent(client, pnlEvent);
    }

    const walletRows = Array.from(walletStats.values()).map((stats) => ({
      lane: window.lane,
      ...finalizeWalletStats(stats),
    }));
    for (const row of walletRows) {
      await upsertWalletStats(client, row);
    }

    await refreshWalletLeaderboards(client, {
      asOfBlockNumber: window.maxBlockNumber,
      lane: window.lane,
      walletRows,
    });

    return {
      lane: window.lane,
      maxBlockNumber: window.maxBlockNumber.toString(10),
      pnlEvents: pnlEvents.length,
      positions: positionRows.length,
      pricedTrades,
      skippedTrades,
      wallets: walletRows.length,
    };
  });
}

async function repairPendingWalletPricing({
  indexerKey = process.env.INDEXER_KEY || 'starknetdeg-mainnet',
  lane = process.env.PHASE6_ANALYTICS_LANE || FINALITY_LANES.ACCEPTED_ON_L2,
  requireL1 = parseBoolean(process.env.PHASE6_REQUIRE_L1, false),
} = {}) {
  return withClient(async (client) => {
    await assertFoundationTables(client);
    await assertPhase2Tables(client);
    await assertPhase3Tables(client);
    await assertPhase4Tables(client);
    await assertPhase6Tables(client);

    const window = await resolveAnalyticsWindow(client, { indexerKey, lane, requireL1 });
    if (window.maxBlockNumber === null) {
      return {
        eligibleWallets: 0,
        lane: window.lane,
        maxBlockNumber: 'none',
        repaired: 0,
      };
    }

    const result = await client.query(
      `SELECT DISTINCT position.wallet_address
         FROM stark_wallet_positions AS position
        WHERE position.lane = $1
          AND position.pending_pricing = TRUE
          AND (
               EXISTS (
                 SELECT 1
                   FROM stark_token_metadata AS metadata
                   JOIN stark_prices AS prices
                     ON prices.lane = position.lane
                    AND prices.token_address = metadata.token_address
                  WHERE metadata.token_address = position.token_address
                    AND metadata.decimals IS NOT NULL
                    AND prices.price_usd IS NOT NULL
               )
            OR EXISTS (
                 SELECT 1
                   FROM stark_wallet_pnl_events AS pnl
                   JOIN stark_token_metadata AS metadata
                     ON metadata.token_address = pnl.gas_fee_token_address
                   JOIN stark_prices AS prices
                     ON prices.lane = pnl.lane
                    AND prices.token_address = pnl.gas_fee_token_address
                  WHERE pnl.lane = position.lane
                    AND pnl.wallet_address = position.wallet_address
                    AND pnl.gas_fee_token_address IS NOT NULL
                    AND metadata.decimals IS NOT NULL
                    AND prices.price_usd IS NOT NULL
               )
          )`,
      [window.lane],
    );

    const eligibleWallets = result.rows.map((row) => row.wallet_address).filter(Boolean);
    if (eligibleWallets.length === 0) {
      return {
        eligibleWallets: 0,
        lane: window.lane,
        maxBlockNumber: window.maxBlockNumber.toString(10),
        repaired: 0,
      };
    }

    // Current repair strategy intentionally does a clean lane-wide rebuild.
    // Wallet stats and leaderboards are coupled, so a full replay is safer than
    // trying to surgically patch only one token path.
    await refreshWalletRollups({ indexerKey, lane, requireL1 });

    return {
      eligibleWallets: eligibleWallets.length,
      lane: window.lane,
      maxBlockNumber: window.maxBlockNumber.toString(10),
      repaired: eligibleWallets.length,
    };
  });
}

async function loadTrades(client, { lane, maxBlockNumber }) {
  const result = await client.query(
    `SELECT trade.trade_key,
            trade.block_number,
            trade.block_hash,
            trade.block_timestamp,
            trade.transaction_hash,
            trade.transaction_index,
            trade.source_event_index,
            trade.trader_address,
            trade.token_in_address,
            trade.token_out_address,
            trade.amount_in,
            trade.amount_out,
            trade.notional_usd,
            trade.pending_enrichment,
            tx.actual_fee_amount,
            tx.actual_fee_unit
       FROM stark_trades AS trade
       LEFT JOIN stark_tx_raw AS tx
              ON tx.lane = trade.lane
             AND tx.block_number = trade.block_number
             AND tx.transaction_hash = trade.transaction_hash
      WHERE trade.lane = $1
        AND trade.block_number <= $2
        AND trade.trader_address IS NOT NULL
      ORDER BY trade.block_number ASC, trade.transaction_index ASC, trade.source_event_index ASC, trade.trade_key ASC`,
    [lane, toNumericString(maxBlockNumber, 'wallet rollup max block')],
  );

  return result.rows.map((row) => ({
    actualFeeAmount: row.actual_fee_amount === null ? null : toBigIntStrict(row.actual_fee_amount, 'wallet trade actual fee amount'),
    actualFeeUnit: row.actual_fee_unit === null ? null : String(row.actual_fee_unit).toUpperCase(),
    amountIn: toBigIntStrict(row.amount_in, 'wallet trade amount in'),
    amountOut: toBigIntStrict(row.amount_out, 'wallet trade amount out'),
    blockHash: row.block_hash,
    blockNumber: toBigIntStrict(row.block_number, 'wallet trade block number'),
    blockTimestamp: row.block_timestamp,
    notionalUsdScaled: row.notional_usd === null ? null : decimalStringToScaled(row.notional_usd, DEFAULT_SCALE),
    pendingEnrichment: Boolean(row.pending_enrichment),
    sourceEventIndex: toBigIntStrict(row.source_event_index, 'wallet trade source event index'),
    tokenInAddress: row.token_in_address,
    tokenOutAddress: row.token_out_address,
    tradeKey: row.trade_key,
    traderAddress: row.trader_address,
    transactionHash: row.transaction_hash,
    transactionIndex: toBigIntStrict(row.transaction_index, 'wallet trade transaction index'),
    gasFeeTokenAddress: resolveGasFeeTokenAddress(row.actual_fee_unit),
  }));
}

async function loadBridgeActivities(client, { lane, maxBlockNumber }) {
  const result = await client.query(
    `SELECT bridge_key,
            activity.block_number,
            activity.transaction_hash,
            activity.direction,
            activity.classification,
            activity.l2_wallet_address,
            activity.token_address,
            activity.amount,
            activity.source_event_index,
            activity.transaction_index,
            journal.block_timestamp
       FROM stark_bridge_activities AS activity
       LEFT JOIN stark_block_journal AS journal
              ON journal.lane = activity.lane
             AND journal.block_number = activity.block_number
             AND journal.block_hash = activity.block_hash
             AND journal.is_orphaned = FALSE
      WHERE activity.lane = $1
        AND activity.block_number <= $2
      ORDER BY activity.block_number ASC, activity.transaction_index ASC, COALESCE(activity.source_event_index, 0) ASC, activity.bridge_key ASC`,
    [lane, toNumericString(maxBlockNumber, 'wallet bridge max block')],
  );

  return result.rows.map((row) => ({
    amount: row.amount === null ? null : toBigIntStrict(row.amount, 'wallet bridge amount'),
    blockNumber: toBigIntStrict(row.block_number, 'wallet bridge block number'),
    blockTimestamp: row.block_timestamp,
    bridgeKey: row.bridge_key,
    classification: row.classification,
    direction: row.direction,
    sourceEventIndex: row.source_event_index === null ? 0n : toBigIntStrict(row.source_event_index, 'wallet bridge source event index'),
    tokenAddress: row.token_address,
    transactionHash: row.transaction_hash,
    transactionIndex: toBigIntStrict(row.transaction_index, 'wallet bridge transaction index'),
    walletAddress: row.l2_wallet_address,
  }));
}

function collectTokenAddresses(trades, bridges) {
  const values = new Set();

  for (const trade of trades) {
    values.add(trade.tokenInAddress);
    values.add(trade.tokenOutAddress);
    if (trade.gasFeeTokenAddress) {
      values.add(trade.gasFeeTokenAddress);
    }
  }

  for (const bridge of bridges) {
    if (bridge.tokenAddress) {
      values.add(bridge.tokenAddress);
    }
  }

  return Array.from(values);
}

function allocateGasFeesToTrades(trades, tokenContext) {
  const grouped = new Map();

  for (const trade of trades) {
    if (!grouped.has(trade.transactionHash)) {
      grouped.set(trade.transactionHash, []);
    }
    grouped.get(trade.transactionHash).push({
      ...trade,
      gasFeePending: false,
      gasFeeUsdScaled: 0n,
    });
  }

  for (const tradeGroup of grouped.values()) {
    const referenceTrade = tradeGroup.find((item) => item.actualFeeAmount !== null);
    if (!referenceTrade || referenceTrade.actualFeeAmount === null) {
      continue;
    }

    if (!referenceTrade.gasFeeTokenAddress) {
      for (const trade of tradeGroup) {
        trade.gasFeePending = true;
      }
      continue;
    }

    const gasTokenInfo = tokenContext.get(referenceTrade.gasFeeTokenAddress) ?? null;
    const totalGasFeeUsdScaled = computeUsdValueFromRawAmount(referenceTrade.actualFeeAmount, gasTokenInfo, { allowStale: true });

    if (totalGasFeeUsdScaled === null) {
      for (const trade of tradeGroup) {
        trade.gasFeePending = true;
      }
      continue;
    }

    const totalNotional = tradeGroup.reduce(
      (sum, trade) => sum + (trade.notionalUsdScaled === null ? 0n : absBigInt(trade.notionalUsdScaled)),
      0n,
    );
    let remainingGasFeeUsdScaled = totalGasFeeUsdScaled;
    let remainingWeight = totalNotional > 0n ? totalNotional : BigInt(tradeGroup.length);

    for (let index = 0; index < tradeGroup.length; index += 1) {
      const trade = tradeGroup[index];
      if (index === tradeGroup.length - 1) {
        trade.gasFeeUsdScaled = remainingGasFeeUsdScaled;
        break;
      }

      const weight = totalNotional > 0n
        ? (trade.notionalUsdScaled === null ? 0n : absBigInt(trade.notionalUsdScaled))
        : 1n;
      if (weight === 0n || remainingWeight === 0n) {
        trade.gasFeeUsdScaled = 0n;
        continue;
      }

      const allocation = (remainingGasFeeUsdScaled * weight) / remainingWeight;
      trade.gasFeeUsdScaled = allocation;
      remainingGasFeeUsdScaled -= allocation;
      remainingWeight -= weight;
    }
  }

  return Array.from(grouped.values()).flat();
}

function resolveGasFeeTokenAddress(actualFeeUnit) {
  const unit = actualFeeUnit === null || actualFeeUnit === undefined
    ? null
    : String(actualFeeUnit).trim().toUpperCase();

  if (unit === 'WEI') {
    return knownErc20Cache.findBySymbol('ETH')[0]?.l2TokenAddress ?? null;
  }

  if (unit === 'FRI' || unit === 'STRK') {
    return knownErc20Cache.findBySymbol('STRK')[0]?.l2TokenAddress ?? null;
  }

  return null;
}

function processBridgeActivity({ activity, positions, tokenContext, walletStats }) {
  if (!activity.walletAddress || !activity.tokenAddress || activity.walletAddress === ZERO_ADDRESS) {
    return;
  }

  const position = ensurePosition(positions, activity.walletAddress, activity.tokenAddress);
  const stats = ensureWalletStats(walletStats, activity.walletAddress);
  const tokenInfo = tokenContext.get(activity.tokenAddress) ?? null;
  const usdValueScaled = activity.amount === null ? null : computeUsdValueFromRawAmount(activity.amount, tokenInfo, { allowStale: true });

  updateActivityMarkers(position, activity.blockNumber, activity.blockTimestamp);
  stats.bridgeActivityCount += 1n;

  if (activity.direction === 'bridge_in') {
    position.bridgeInCount += 1n;
    if (activity.amount !== null) {
      position.externalQuantity += activity.amount;
      if (usdValueScaled !== null) {
        position.externalCostBasisUsdScaled += usdValueScaled;
        stats.bridgeInflowUsdScaled += usdValueScaled;
      } else {
        position.pendingPricing = true;
        position.metadata.bridge_pricing_gaps += 1;
        stats.metadata.bridge_pricing_gaps += 1;
      }
    } else {
      position.metadata.bridge_without_amount += 1;
      stats.metadata.bridge_without_amount += 1;
    }
  } else {
    position.bridgeOutCount += 1n;
    if (activity.amount !== null) {
      consumeInventoryWithoutPnl(position, activity.amount, stats);
      if (usdValueScaled !== null) {
        stats.bridgeOutflowUsdScaled += usdValueScaled;
      } else {
        position.pendingPricing = true;
        position.metadata.bridge_pricing_gaps += 1;
        stats.metadata.bridge_pricing_gaps += 1;
      }
    } else {
      position.metadata.bridge_without_amount += 1;
      stats.metadata.bridge_without_amount += 1;
    }
  }
}

function processTrade({ lane, pnlEvents, positions, trade, walletStats }) {
  if (!trade.traderAddress || trade.tokenInAddress === trade.tokenOutAddress) {
    return false;
  }

  const stats = ensureWalletStats(walletStats, trade.traderAddress);
  const sellPosition = ensurePosition(positions, trade.traderAddress, trade.tokenInAddress);
  const buyPosition = ensurePosition(positions, trade.traderAddress, trade.tokenOutAddress);

  if (trade.notionalUsdScaled === null) {
    sellPosition.pendingPricing = true;
    buyPosition.pendingPricing = true;
    sellPosition.metadata.skipped_unpriced_trades += 1;
    buyPosition.metadata.skipped_unpriced_trades += 1;
    stats.metadata.skipped_unpriced_trades += 1;
    return false;
  }

  const gasFeeUsdScaled = trade.gasFeeUsdScaled ?? 0n;
  const hasGasFee = trade.actualFeeAmount !== null && trade.actualFeeAmount !== undefined;
  const buyCostBasisUsdScaled = trade.notionalUsdScaled + gasFeeUsdScaled;
  const sellProceedsUsdScaled = trade.notionalUsdScaled - gasFeeUsdScaled;

  stats.totalTrades += 1n;
  stats.totalVolumeUsdScaled += trade.notionalUsdScaled;
  stats.totalGasFeesUsdScaled += gasFeeUsdScaled;
  if (stats.firstTradeBlockNumber === null || trade.blockNumber < stats.firstTradeBlockNumber) {
    stats.firstTradeBlockNumber = trade.blockNumber;
  }
  stats.lastTradeBlockNumber = trade.blockNumber;

  updateActivityMarkers(sellPosition, trade.blockNumber, trade.blockTimestamp);
  updateActivityMarkers(buyPosition, trade.blockNumber, trade.blockTimestamp);
  sellPosition.tradeCount += 1n;
  if (buyPosition !== sellPosition) {
    buyPosition.tradeCount += 1n;
  }

  if (trade.gasFeePending) {
    sellPosition.pendingPricing = true;
    buyPosition.pendingPricing = true;
    sellPosition.metadata.pending_gas_fee_trades = (sellPosition.metadata.pending_gas_fee_trades ?? 0) + 1;
    buyPosition.metadata.pending_gas_fee_trades = (buyPosition.metadata.pending_gas_fee_trades ?? 0) + 1;
    stats.metadata.pending_gas_fee_trades += 1;
  }

  const sellResult = consumeTradeSellInventory(sellPosition, {
    amountSold: trade.amountIn,
    proceedsUsdScaled: sellProceedsUsdScaled,
  });

  if (sellResult.realizedPnlUsdScaled !== null) {
    sellPosition.realizedPnlUsdScaled += sellResult.realizedPnlUsdScaled;
    stats.realizedPnlUsdScaled += sellResult.realizedPnlUsdScaled;
    if (sellResult.realizedPnlUsdScaled > 0n) {
      stats.winningTradeCount += 1n;
    } else if (sellResult.realizedPnlUsdScaled < 0n) {
      stats.losingTradeCount += 1n;
    }
    if (stats.bestTradePnlUsdScaled === null || compareBigInt(sellResult.realizedPnlUsdScaled, stats.bestTradePnlUsdScaled) > 0) {
      stats.bestTradePnlUsdScaled = sellResult.realizedPnlUsdScaled;
      stats.bestTradeTxHash = trade.transactionHash;
      stats.bestTradeTokenAddress = trade.tokenInAddress;
      stats.bestTradeAtBlock = trade.blockNumber;
    }
  }

  if (sellResult.inventoryGap > 0n) {
    sellPosition.pendingPricing = true;
    sellPosition.metadata.inventory_gap_qty += Number(sellResult.inventoryGap);
    stats.metadata.inventory_gap_qty += Number(sellResult.inventoryGap);
  }

  buyPosition.tradedQuantity += trade.amountOut;
  buyPosition.tradedCostBasisUsdScaled += buyCostBasisUsdScaled;

  pnlEvents.push(buildPnlEvent({
    blockHash: trade.blockHash,
    blockNumber: trade.blockNumber,
    blockTimestamp: trade.blockTimestamp,
    costBasisUsdScaled: buyCostBasisUsdScaled,
    externalQuantity: 0n,
    gasFeeAmount: hasGasFee ? trade.actualFeeAmount : null,
    gasFeeTokenAddress: trade.gasFeeTokenAddress,
    gasFeeUsdScaled: hasGasFee ? gasFeeUsdScaled : null,
    lane,
    metadata: {
      gas_fee_pending: trade.gasFeePending,
      pending_enrichment: trade.pendingEnrichment,
      trade_side: 'buy',
    },
    pnlEventKey: `${trade.tradeKey}:${trade.tokenOutAddress}:buy`,
    positionAmountAfter: buyPosition.tradedQuantity + buyPosition.externalQuantity,
    proceedsUsdScaled: null,
    quantity: trade.amountOut,
    realizedPnlUsdScaled: null,
    remainingCostBasisUsdScaled: buyPosition.tradedCostBasisUsdScaled,
    side: 'buy',
    sourceEventIndex: trade.sourceEventIndex,
    tokenAddress: trade.tokenOutAddress,
    tradeKey: trade.tradeKey,
    tradedQuantity: trade.amountOut,
    transactionHash: trade.transactionHash,
    transactionIndex: trade.transactionIndex,
    walletAddress: trade.traderAddress,
  }));

  pnlEvents.push(buildPnlEvent({
    blockHash: trade.blockHash,
    blockNumber: trade.blockNumber,
    blockTimestamp: trade.blockTimestamp,
    costBasisUsdScaled: sellResult.tradedCostBasisRelieved,
    externalQuantity: sellResult.externalQuantitySold,
    gasFeeAmount: hasGasFee ? trade.actualFeeAmount : null,
    gasFeeTokenAddress: trade.gasFeeTokenAddress,
    gasFeeUsdScaled: hasGasFee ? gasFeeUsdScaled : null,
    lane,
    metadata: {
      gas_fee_pending: trade.gasFeePending,
      inventory_gap_qty: sellResult.inventoryGap.toString(10),
      pending_enrichment: trade.pendingEnrichment,
      trade_side: 'sell',
    },
    pnlEventKey: `${trade.tradeKey}:${trade.tokenInAddress}:sell`,
    positionAmountAfter: sellPosition.tradedQuantity + sellPosition.externalQuantity,
    proceedsUsdScaled: sellProceedsUsdScaled,
    quantity: trade.amountIn,
    realizedPnlUsdScaled: sellResult.realizedPnlUsdScaled,
    remainingCostBasisUsdScaled: sellPosition.tradedCostBasisUsdScaled,
    side: 'sell',
    sourceEventIndex: trade.sourceEventIndex,
    tokenAddress: trade.tokenInAddress,
    tradeKey: trade.tradeKey,
    tradedQuantity: sellResult.tradedQuantitySold,
    transactionHash: trade.transactionHash,
    transactionIndex: trade.transactionIndex,
    walletAddress: trade.traderAddress,
  }));

  return true;
}

function buildWalletPositionRows({ lane, positions, tokenContext, walletStats }) {
  const rows = [];

  for (const position of positions.values()) {
    const tokenInfo = tokenContext.get(position.tokenAddress) ?? null;
    const stats = ensureWalletStats(walletStats, position.walletAddress);
    const tradedQuantity = position.tradedQuantity;
    const externalQuantity = position.externalQuantity;
    const totalQuantity = tradedQuantity + externalQuantity;

    let averageTradedEntryPriceUsdScaled = null;
    let unrealizedPnlUsdScaled = null;
    const lastPriceUsdScaled = tokenInfo?.priceUsdScaled ?? null;
    let pendingPricing = position.pendingPricing;

    if (tradedQuantity > 0n) {
      if (tokenInfo?.decimals !== null && tokenInfo?.decimals !== undefined && lastPriceUsdScaled !== null) {
        const tradedHumanScaled = integerAmountToScaled(tradedQuantity, tokenInfo.decimals, DEFAULT_SCALE);
        if (tradedHumanScaled > 0n) {
          averageTradedEntryPriceUsdScaled = scaledDivide(position.tradedCostBasisUsdScaled, tradedHumanScaled, DEFAULT_SCALE);
          const marketValueUsdScaled = computeUsdValueFromRawAmount(tradedQuantity, tokenInfo, { allowStale: true });
          if (marketValueUsdScaled !== null) {
            unrealizedPnlUsdScaled = marketValueUsdScaled - position.tradedCostBasisUsdScaled;
          } else {
            pendingPricing = true;
          }
        } else {
          averageTradedEntryPriceUsdScaled = 0n;
          unrealizedPnlUsdScaled = 0n;
        }
      } else {
        pendingPricing = true;
      }
    }

    if (tokenInfo?.priceIsStale) {
      pendingPricing = true;
    }

    if (unrealizedPnlUsdScaled !== null) {
      stats.unrealizedPnlUsdScaled += unrealizedPnlUsdScaled;
    } else if (pendingPricing && tradedQuantity > 0n) {
      stats.metadata.pending_pricing_positions += 1;
    }

    if (totalQuantity === 0n && position.realizedPnlUsdScaled === 0n && position.tradeCount === 0n && position.bridgeInCount === 0n && position.bridgeOutCount === 0n) {
      continue;
    }

    rows.push({
      averageTradedEntryPriceUsdScaled,
      bridgeInCount: position.bridgeInCount,
      bridgeOutCount: position.bridgeOutCount,
      externalCostBasisUsdScaled: position.externalCostBasisUsdScaled,
      externalQuantity,
      firstActivityBlockNumber: position.firstActivityBlockNumber,
      lane,
      lastActivityBlockNumber: position.lastActivityBlockNumber,
      lastActivityTimestamp: position.lastActivityTimestamp,
      lastPriceUsdScaled,
      metadata: position.metadata,
      pendingPricing,
      realizedPnlUsdScaled: position.realizedPnlUsdScaled,
      tokenAddress: position.tokenAddress,
      totalQuantity,
      tradeCount: position.tradeCount,
      tradedCostBasisUsdScaled: position.tradedCostBasisUsdScaled,
      tradedQuantity,
      unrealizedPnlUsdScaled,
      walletAddress: position.walletAddress,
    });
  }

  return rows;
}

function finalizeWalletStats(stats) {
  const closedTrades = stats.winningTradeCount + stats.losingTradeCount;

  return {
    ...stats,
    netBridgeFlowUsdScaled: stats.bridgeInflowUsdScaled - stats.bridgeOutflowUsdScaled,
    netPnlUsdScaled: stats.realizedPnlUsdScaled + stats.unrealizedPnlUsdScaled,
    winRateScaled: closedTrades === 0n ? null : scaledRatio(stats.winningTradeCount, closedTrades, 0, DEFAULT_SCALE),
  };
}

function ensurePosition(positions, walletAddress, tokenAddress) {
  const key = `${walletAddress}:${tokenAddress}`;
  if (positions.has(key)) {
    return positions.get(key);
  }

  const position = {
    bridgeInCount: 0n,
    bridgeOutCount: 0n,
    externalCostBasisUsdScaled: 0n,
    externalQuantity: 0n,
    firstActivityBlockNumber: null,
    lastActivityBlockNumber: null,
    lastActivityTimestamp: null,
    metadata: {
      bridge_pricing_gaps: 0,
      bridge_without_amount: 0,
      inventory_gap_qty: 0,
      pending_gas_fee_trades: 0,
      skipped_unpriced_trades: 0,
    },
    pendingPricing: false,
    realizedPnlUsdScaled: 0n,
    tokenAddress,
    tradeCount: 0n,
    tradedCostBasisUsdScaled: 0n,
    tradedQuantity: 0n,
    walletAddress,
  };
  positions.set(key, position);
  return position;
}

function ensureWalletStats(walletStats, walletAddress) {
  if (walletStats.has(walletAddress)) {
    return walletStats.get(walletAddress);
  }

  const stats = {
    bestTradeAtBlock: null,
    bestTradePnlUsdScaled: null,
    bestTradeTokenAddress: null,
    bestTradeTxHash: null,
    bridgeActivityCount: 0n,
    bridgeInflowUsdScaled: 0n,
    bridgeOutflowUsdScaled: 0n,
    firstTradeBlockNumber: null,
    lastTradeBlockNumber: null,
    losingTradeCount: 0n,
    metadata: {
      bridge_pricing_gaps: 0,
      bridge_without_amount: 0,
      inventory_gap_qty: 0,
      pending_gas_fee_trades: 0,
      pending_pricing_positions: 0,
      skipped_unpriced_trades: 0,
    },
    realizedPnlUsdScaled: 0n,
    totalGasFeesUsdScaled: 0n,
    totalTrades: 0n,
    totalVolumeUsdScaled: 0n,
    unrealizedPnlUsdScaled: 0n,
    walletAddress,
    winningTradeCount: 0n,
  };
  walletStats.set(walletAddress, stats);
  return stats;
}

function updateActivityMarkers(position, blockNumber, blockTimestamp) {
  if (position.firstActivityBlockNumber === null || blockNumber < position.firstActivityBlockNumber) {
    position.firstActivityBlockNumber = blockNumber;
  }
  position.lastActivityBlockNumber = blockNumber;
  if (blockTimestamp) {
    position.lastActivityTimestamp = blockTimestamp;
  }
}

function consumeInventoryWithoutPnl(position, amount, stats) {
  let remaining = amount;

  if (position.externalQuantity > 0n) {
    const externalQtyBefore = position.externalQuantity;
    const externalConsumed = minBigInt(remaining, externalQtyBefore);
    const externalCostRelieved = proportionalShare(position.externalCostBasisUsdScaled, externalConsumed, externalQtyBefore);
    position.externalQuantity -= externalConsumed;
    position.externalCostBasisUsdScaled -= externalCostRelieved;
    remaining -= externalConsumed;
  }

  if (remaining > 0n && position.tradedQuantity > 0n) {
    const tradedQtyBefore = position.tradedQuantity;
    const tradedConsumed = minBigInt(remaining, tradedQtyBefore);
    const tradedCostRelieved = proportionalShare(position.tradedCostBasisUsdScaled, tradedConsumed, tradedQtyBefore);
    position.tradedQuantity -= tradedConsumed;
    position.tradedCostBasisUsdScaled -= tradedCostRelieved;
    remaining -= tradedConsumed;
  }

  if (remaining > 0n) {
    position.pendingPricing = true;
    position.metadata.inventory_gap_qty += Number(remaining);
    stats.metadata.inventory_gap_qty += Number(remaining);
  }
}

function consumeTradeSellInventory(position, { amountSold, proceedsUsdScaled }) {
  let remaining = amountSold;
  let externalQuantitySold = 0n;
  let tradedQuantitySold = 0n;
  let tradedCostBasisRelieved = 0n;
  let realizedPnlUsdScaled = null;

  if (position.externalQuantity > 0n) {
    const externalQtyBefore = position.externalQuantity;
    externalQuantitySold = minBigInt(remaining, externalQtyBefore);
    const externalCostRelieved = proportionalShare(position.externalCostBasisUsdScaled, externalQuantitySold, externalQtyBefore);
    position.externalQuantity -= externalQuantitySold;
    position.externalCostBasisUsdScaled -= externalCostRelieved;
    remaining -= externalQuantitySold;
  }

  if (remaining > 0n && position.tradedQuantity > 0n) {
    const tradedQtyBefore = position.tradedQuantity;
    tradedQuantitySold = minBigInt(remaining, tradedQtyBefore);
    tradedCostBasisRelieved = proportionalShare(position.tradedCostBasisUsdScaled, tradedQuantitySold, tradedQtyBefore);
    position.tradedQuantity -= tradedQuantitySold;
    position.tradedCostBasisUsdScaled -= tradedCostBasisRelieved;
    remaining -= tradedQuantitySold;

    const proceedsForTraded = amountSold === 0n
      ? 0n
      : (proceedsUsdScaled * tradedQuantitySold) / amountSold;
    realizedPnlUsdScaled = proceedsForTraded - tradedCostBasisRelieved;
  }

  return {
    externalQuantitySold,
    inventoryGap: remaining,
    realizedPnlUsdScaled,
    tradedCostBasisRelieved,
    tradedQuantitySold,
  };
}

function buildPnlEvent(payload) {
  return payload;
}

function proportionalShare(totalScaled, portionRaw, totalRaw) {
  if (totalScaled === 0n || portionRaw === 0n || totalRaw === 0n) {
    return 0n;
  }

  return (totalScaled * portionRaw) / totalRaw;
}

function minBigInt(left, right) {
  return compareBigInt(left, right) <= 0 ? left : right;
}

async function insertWalletPnlEvent(client, event) {
  await client.query(
    `INSERT INTO stark_wallet_pnl_events (
         pnl_event_key,
         lane,
         wallet_address,
         token_address,
         trade_key,
         block_number,
         block_hash,
         block_timestamp,
         transaction_hash,
         transaction_index,
         source_event_index,
         side,
         quantity,
         external_quantity,
         traded_quantity,
         gas_fee_amount,
         gas_fee_token_address,
         gas_fee_usd,
         proceeds_usd,
         cost_basis_usd,
         realized_pnl_usd,
         position_amount_after,
         remaining_cost_basis_usd,
         metadata,
         created_at,
         updated_at
     ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
         $21, $22, $23, $24::jsonb, NOW(), NOW()
     )`,
    [
      event.pnlEventKey,
      event.lane,
      event.walletAddress,
      event.tokenAddress,
      event.tradeKey,
      toNumericString(event.blockNumber, 'wallet pnl block number'),
      event.blockHash,
      event.blockTimestamp,
      event.transactionHash,
      toNumericString(event.transactionIndex, 'wallet pnl transaction index'),
      toNumericString(event.sourceEventIndex, 'wallet pnl source event index'),
      event.side,
      toNumericString(event.quantity, 'wallet pnl quantity'),
      toNumericString(event.externalQuantity, 'wallet pnl external quantity'),
      toNumericString(event.tradedQuantity, 'wallet pnl traded quantity'),
      event.gasFeeAmount === null || event.gasFeeAmount === undefined ? null : toNumericString(event.gasFeeAmount, 'wallet pnl gas fee amount'),
      event.gasFeeTokenAddress ?? null,
      scaledOrNullToNumeric(event.gasFeeUsdScaled),
      scaledOrNullToNumeric(event.proceedsUsdScaled),
      scaledOrNullToNumeric(event.costBasisUsdScaled),
      scaledOrNullToNumeric(event.realizedPnlUsdScaled),
      toNumericString(event.positionAmountAfter, 'wallet pnl position amount after'),
      scaledOrNullToNumeric(event.remainingCostBasisUsdScaled),
      toJsonbString(event.metadata ?? {}),
    ],
  );
}

async function upsertWalletPosition(client, row) {
  await client.query(
    `INSERT INTO stark_wallet_positions (
         lane,
         wallet_address,
         token_address,
         traded_quantity,
         external_quantity,
         total_quantity,
         traded_cost_basis_usd,
         external_cost_basis_usd,
         average_traded_entry_price_usd,
         last_price_usd,
         realized_pnl_usd,
         unrealized_pnl_usd,
         trade_count,
         bridge_in_count,
         bridge_out_count,
         first_activity_block_number,
         last_activity_block_number,
         last_activity_timestamp,
         pending_pricing,
         metadata,
         created_at,
         updated_at
     ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, $12, $13, $14, $15, $16, $17, $18, $19, $20::jsonb, NOW(), NOW()
     )`,
    [
      row.lane,
      row.walletAddress,
      row.tokenAddress,
      toNumericString(row.tradedQuantity, 'wallet position traded quantity'),
      toNumericString(row.externalQuantity, 'wallet position external quantity'),
      toNumericString(row.totalQuantity, 'wallet position total quantity'),
      scaledToNumericString(row.tradedCostBasisUsdScaled, DEFAULT_SCALE),
      scaledToNumericString(row.externalCostBasisUsdScaled, DEFAULT_SCALE),
      scaledOrNullToNumeric(row.averageTradedEntryPriceUsdScaled),
      scaledOrNullToNumeric(row.lastPriceUsdScaled),
      scaledToNumericString(row.realizedPnlUsdScaled, DEFAULT_SCALE),
      scaledOrNullToNumeric(row.unrealizedPnlUsdScaled),
      toNumericString(row.tradeCount, 'wallet position trade count'),
      toNumericString(row.bridgeInCount, 'wallet position bridge in count'),
      toNumericString(row.bridgeOutCount, 'wallet position bridge out count'),
      row.firstActivityBlockNumber === null ? null : toNumericString(row.firstActivityBlockNumber, 'wallet position first block'),
      row.lastActivityBlockNumber === null ? null : toNumericString(row.lastActivityBlockNumber, 'wallet position last block'),
      row.lastActivityTimestamp ?? null,
      row.pendingPricing,
      toJsonbString(row.metadata ?? {}),
    ],
  );
}

async function upsertWalletStats(client, row) {
  await client.query(
    `INSERT INTO stark_wallet_stats (
         lane,
         wallet_address,
         first_trade_block_number,
         last_trade_block_number,
         total_trades,
         total_volume_usd,
         total_gas_fees_usd,
         realized_pnl_usd,
         unrealized_pnl_usd,
         net_pnl_usd,
         bridge_inflow_usd,
         bridge_outflow_usd,
         net_bridge_flow_usd,
         bridge_activity_count,
         winning_trade_count,
         losing_trade_count,
         win_rate,
         best_trade_pnl_usd,
         best_trade_tx_hash,
         best_trade_token_address,
         best_trade_at_block,
         metadata,
         created_at,
         updated_at
     ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
         $21, $22::jsonb, NOW(), NOW()
     )`,
    [
      row.lane,
      row.walletAddress,
      row.firstTradeBlockNumber === null ? null : toNumericString(row.firstTradeBlockNumber, 'wallet stats first trade block'),
      row.lastTradeBlockNumber === null ? null : toNumericString(row.lastTradeBlockNumber, 'wallet stats last trade block'),
      toNumericString(row.totalTrades, 'wallet stats total trades'),
      scaledToNumericString(row.totalVolumeUsdScaled, DEFAULT_SCALE),
      scaledToNumericString(row.totalGasFeesUsdScaled, DEFAULT_SCALE),
      scaledToNumericString(row.realizedPnlUsdScaled, DEFAULT_SCALE),
      scaledToNumericString(row.unrealizedPnlUsdScaled, DEFAULT_SCALE),
      scaledToNumericString(row.netPnlUsdScaled, DEFAULT_SCALE),
      scaledToNumericString(row.bridgeInflowUsdScaled, DEFAULT_SCALE),
      scaledToNumericString(row.bridgeOutflowUsdScaled, DEFAULT_SCALE),
      scaledToNumericString(row.netBridgeFlowUsdScaled, DEFAULT_SCALE),
      toNumericString(row.bridgeActivityCount, 'wallet stats bridge activity count'),
      toNumericString(row.winningTradeCount, 'wallet stats winning trades'),
      toNumericString(row.losingTradeCount, 'wallet stats losing trades'),
      scaledOrNullToNumeric(row.winRateScaled),
      scaledOrNullToNumeric(row.bestTradePnlUsdScaled),
      row.bestTradeTxHash,
      row.bestTradeTokenAddress,
      row.bestTradeAtBlock === null ? null : toNumericString(row.bestTradeAtBlock, 'wallet stats best trade block'),
      toJsonbString(row.metadata ?? {}),
    ],
  );
}

async function refreshWalletLeaderboards(client, { asOfBlockNumber, lane, walletRows }) {
  const limit = parsePositiveInteger(process.env.PHASE6_LEADERBOARD_LIMIT, 25);
  const byRealized = [...walletRows]
    .sort((left, right) => compareBigInt(right.realizedPnlUsdScaled, left.realizedPnlUsdScaled))
    .slice(0, limit)
    .map((row, index) => ({
      entityKey: row.walletAddress,
      entityType: 'wallet',
      metadata: {
        wallet_address: row.walletAddress,
      },
      metricValue: scaledToNumericString(row.realizedPnlUsdScaled, DEFAULT_SCALE),
      rank: BigInt(index + 1),
    }));
  const byVolume = [...walletRows]
    .sort((left, right) => compareBigInt(right.totalVolumeUsdScaled, left.totalVolumeUsdScaled))
    .slice(0, limit)
    .map((row, index) => ({
      entityKey: row.walletAddress,
      entityType: 'wallet',
      metadata: {
        wallet_address: row.walletAddress,
      },
      metricValue: scaledToNumericString(row.totalVolumeUsdScaled, DEFAULT_SCALE),
      rank: BigInt(index + 1),
    }));
  const byBridge = [...walletRows]
    .sort((left, right) => compareBigInt(absBigInt(right.netBridgeFlowUsdScaled), absBigInt(left.netBridgeFlowUsdScaled)))
    .slice(0, limit)
    .map((row, index) => ({
      entityKey: row.walletAddress,
      entityType: 'wallet',
      metadata: {
        signed_net_bridge_flow_usd: scaledToNumericString(row.netBridgeFlowUsdScaled, DEFAULT_SCALE),
        wallet_address: row.walletAddress,
      },
      metricValue: scaledToNumericString(absBigInt(row.netBridgeFlowUsdScaled), DEFAULT_SCALE),
      rank: BigInt(index + 1),
    }));

  await replaceLeaderboards(client, {
    asOfBlockNumber,
    lane,
    leaderboardName: 'wallet_realized_pnl_usd',
    rows: byRealized,
  });
  await replaceLeaderboards(client, {
    asOfBlockNumber,
    lane,
    leaderboardName: 'wallet_total_volume_usd',
    rows: byVolume,
  });
  await replaceLeaderboards(client, {
    asOfBlockNumber,
    lane,
    leaderboardName: 'wallet_net_bridge_flow_usd',
    rows: byBridge,
  });
}

function installSignalHandlers() {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      shuttingDown = true;
      console.log(`[phase6] wallet-rollups received ${signal}, stopping after current pass.`);
    });
  }
}

if (require.main === module) {
  main().catch(async (error) => {
    console.error(`[phase6] wallet-rollups fatal error: ${formatError(error)}`);
    try {
      await closePool();
    } finally {
      process.exitCode = 1;
    }
  });
}

module.exports = {
  repairPendingWalletPricing,
  refreshWalletRollups,
};
