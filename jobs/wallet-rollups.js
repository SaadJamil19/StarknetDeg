#!/usr/bin/env node
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { setTimeout: sleep } = require('node:timers/promises');
const {
  assertAbsoluteFinalityColumns,
  assertFinancialResilienceColumns,
  assertFoundationTables,
  assertFullNodePlan2Tables,
  assertIntegrityMaintenanceTables,
  assertPhase2Tables,
  assertPhase3Tables,
  assertPhase4Tables,
  assertPhase6Tables,
  assertL1Tables,
} = require('../core/checkpoint');
const { listStaticCoreTokens } = require('../core/constants/tokens');
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
const FIFO_DUST_THRESHOLD_SCALED = decimalStringToScaled(process.env.PHASE6_FIFO_DUST_THRESHOLD ?? '0.0000000001', DEFAULT_SCALE);
const GAS_PRICE_FALLBACK_WINDOW_SECONDS = parsePositiveInteger(process.env.PHASE6_GAS_PRICE_FALLBACK_WINDOW_SECONDS, 3600);
const FIXED_GAS_ANCHOR_ETH_USD_SCALED = parseOptionalUsdScaled(process.env.PHASE6_FIXED_GAS_ANCHOR_ETH_USD);
const FIXED_GAS_ANCHOR_STRK_USD_SCALED = parseOptionalUsdScaled(process.env.PHASE6_FIXED_GAS_ANCHOR_STRK_USD);
const TOKEN_LINEAGE_MAP = buildTokenLineageMap();

function buildTokenLineageMap() {
  const byKey = new Map(listStaticCoreTokens().map((token) => [token.key, token]));
  const legacyDai = byKey.get('DAI_V0');
  const canonicalDai = byKey.get('DAI');
  const edges = [];
  const directEdgeBySource = new Map();
  const parentEdgesByDestination = new Map();

  if (legacyDai?.address && canonicalDai?.address) {
    edges.push({
      canonicalAddress: canonicalDai.address,
      destinationAddress: canonicalDai.address,
      lineageKey: 'DAI',
      migrationType: 'starkgate_token_upgrade',
      sourceAddress: legacyDai.address,
      windowEnd: null,
      windowStart: null,
    });
  }

  for (const edge of edges) {
    if (directEdgeBySource.has(edge.sourceAddress)) {
      throw new Error(`Duplicate token lineage source edge detected for ${edge.sourceAddress}.`);
    }
    directEdgeBySource.set(edge.sourceAddress, edge);
    if (!parentEdgesByDestination.has(edge.destinationAddress)) {
      parentEdgesByDestination.set(edge.destinationAddress, []);
    }
    parentEdgesByDestination.get(edge.destinationAddress).push(edge);
  }

  const resolved = new Map();
  const resolveAncestry = (tokenAddress, chain = []) => {
    if (resolved.has(tokenAddress)) {
      return resolved.get(tokenAddress);
    }
    if (chain.includes(tokenAddress)) {
      throw new Error(`Token lineage cycle detected: ${[...chain, tokenAddress].join(' -> ')}`);
    }

    const directEdge = directEdgeBySource.get(tokenAddress);
    if (!directEdge) {
      return null;
    }

    const parentEdges = parentEdgesByDestination.get(tokenAddress) ?? [];
    const parentEdge = parentEdges.length === 1 ? parentEdges[0] : null;
    const parentResolution = parentEdge === null
      ? null
      : resolveAncestry(parentEdge.sourceAddress, [...chain, tokenAddress]);
    const ancestorAddresses = parentResolution === null
      ? [tokenAddress]
      : [...parentResolution.ancestorAddresses, tokenAddress];
    const fullPath = [...ancestorAddresses, directEdge.destinationAddress];
    const resolution = {
      ...directEdge,
      ambiguousAncestry: parentEdges.length > 1,
      ancestorAddresses,
      depth: fullPath.length - 1,
      fullPath,
      rootAddress: ancestorAddresses[0],
    };

    resolved.set(tokenAddress, resolution);
    return resolution;
  };

  for (const edge of edges) {
    resolveAncestry(edge.sourceAddress);
  }

  return resolved;
}

async function main() {
  const runOnce = parseBoolean(process.env.PHASE6_WALLET_ROLLUPS_RUN_ONCE, true);
  const pollIntervalMs = parsePositiveInteger(process.env.PHASE6_WALLET_ROLLUPS_INTERVAL_MS, 120_000);
  const alwaysFullRebuild = parseBoolean(process.env.PHASE6_WALLET_ROLLUPS_ALWAYS_FULL, false);
  let initialFullRefreshDone = false;

  installSignalHandlers();

  await withClient(async (client) => {
    await assertAbsoluteFinalityColumns(client);
    await assertFinancialResilienceColumns(client);
    await assertFoundationTables(client);
    await assertFullNodePlan2Tables(client);
    await assertIntegrityMaintenanceTables(client);
    await assertPhase2Tables(client);
    await assertPhase3Tables(client);
    await assertPhase4Tables(client);
    await assertPhase6Tables(client);
    await assertL1Tables(client);
  });

  console.log(`[phase6] wallet-rollups starting run_once=${runOnce}`);

  do {
    try {
      if (!initialFullRefreshDone || runOnce || alwaysFullRebuild) {
        const summary = await refreshWalletRollups();
        initialFullRefreshDone = true;
        console.log(
          `[phase6] wallet-rollups mode=full lane=${summary.lane} max_block=${summary.maxBlockNumber} pending_redecode_block=${summary.blockedByPendingRedecodeBlock ?? 'none'} wallets=${summary.wallets} positions=${summary.positions} pnl_events=${summary.pnlEvents} wallet_transfers=${summary.walletTransfers} priced_trades=${summary.pricedTrades} skipped_trades=${summary.skippedTrades}`,
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
    await assertAbsoluteFinalityColumns(client);
    await assertFinancialResilienceColumns(client);
    await assertFoundationTables(client);
    await assertFullNodePlan2Tables(client);
    await assertIntegrityMaintenanceTables(client);
    await assertPhase2Tables(client);
    await assertPhase3Tables(client);
    await assertPhase4Tables(client);
    await assertPhase6Tables(client);
    await assertL1Tables(client);

    const window = await resolveAnalyticsWindow(client, { indexerKey, lane, requireL1 });
    const pendingRedecodeBlock = window.maxBlockNumber === null
      ? null
      : await findEarliestPendingRedecodeBlock(client, {
        lane: window.lane,
        maxBlockNumber: window.maxBlockNumber,
      });
    const effectiveMaxBlockNumber = clampAnalyticsBlockBeforePendingRedecode(window.maxBlockNumber, pendingRedecodeBlock);

    await client.query(`DELETE FROM stark_wallet_pnl_events WHERE lane = $1`, [window.lane]);
    await client.query(`DELETE FROM stark_wallet_positions WHERE lane = $1`, [window.lane]);
    await client.query(`DELETE FROM stark_wallet_stats WHERE lane = $1`, [window.lane]);
    await client.query(`DELETE FROM stark_pnl_audit_trail WHERE lane = $1`, [window.lane]);

    if (effectiveMaxBlockNumber === null) {
      return {
        blockedByPendingRedecodeBlock: pendingRedecodeBlock === null ? null : pendingRedecodeBlock.toString(10),
        lane: window.lane,
        maxBlockNumber: 'none',
        pnlEvents: 0,
        positions: 0,
        pricedTrades: 0,
        skippedTrades: 0,
        walletTransfers: 0,
        wallets: 0,
      };
    }

    const trades = await loadTrades(client, { lane: window.lane, maxBlockNumber: effectiveMaxBlockNumber });
    const bridges = await loadBridgeActivities(client, { lane: window.lane, maxBlockNumber: effectiveMaxBlockNumber });
    const transfers = await loadWalletTransfers(client, { lane: window.lane, maxBlockNumber: effectiveMaxBlockNumber });
    const tokenContext = await loadTokenMarketContext(client, {
      lane: window.lane,
      tokenAddresses: collectTokenAddresses(trades, bridges, transfers),
    });
    const {
      gasPriceAudits,
      trades: tradesWithGasFees,
    } = allocateGasFeesToTrades(trades, tokenContext);
    const stream = [
      ...transfers.map((item) => ({ ...item, kind: 'transfer', sequence: 0n })),
      ...bridges.map((item) => ({ ...item, kind: 'bridge', sequence: 1n })),
      ...tradesWithGasFees.map((item) => ({ ...item, kind: 'trade', sequence: 2n })),
    ].sort(sortByLineage);

    const positions = new Map();
    const walletStats = new Map();
    const pnlEvents = [];
    const pnlAuditTrail = [];
    let pricedTrades = 0;
    let skippedTrades = 0;
    let walletTransfers = 0;

    for (const audit of gasPriceAudits) {
      await upsertPriceMissingAudit(client, {
        lane: window.lane,
        ...audit,
      });
    }

    for (const item of stream) {
      if (item.kind === 'transfer') {
        processTransferActivity({
          transfer: item,
          positions,
          tokenContext,
          walletStats,
        });
        walletTransfers += 1;
        continue;
      }

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
        pnlAuditTrail,
        positions,
        tokenContext,
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

    for (const auditTrailRow of pnlAuditTrail) {
      await insertPnlAuditTrailRow(client, auditTrailRow);
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
      blockedByPendingRedecodeBlock: pendingRedecodeBlock === null ? null : pendingRedecodeBlock.toString(10),
      maxBlockNumber: effectiveMaxBlockNumber.toString(10),
      pnlEvents: pnlEvents.length,
      positions: positionRows.length,
      pricedTrades,
      skippedTrades,
      walletTransfers,
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
    await assertAbsoluteFinalityColumns(client);
    await assertFinancialResilienceColumns(client);
    await assertFoundationTables(client);
    await assertFullNodePlan2Tables(client);
    await assertPhase2Tables(client);
    await assertPhase3Tables(client);
    await assertPhase4Tables(client);
    await assertPhase6Tables(client);
    await assertL1Tables(client);

    const window = await resolveAnalyticsWindow(client, { indexerKey, lane, requireL1 });
    if (window.maxBlockNumber === null) {
      return {
        eligibleWallets: 0,
        lane: window.lane,
        maxBlockNumber: 'none',
        repaired: 0,
      };
    }

    const ethTokenAddress = knownErc20Cache.findBySymbol('ETH')[0]?.l2TokenAddress ?? null;
    const strkTokenAddress = knownErc20Cache.findBySymbol('STRK')[0]?.l2TokenAddress ?? null;

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
                  WHERE pnl.lane = position.lane
                    AND pnl.wallet_address = position.wallet_address
                    AND pnl.gas_fee_token_address IS NOT NULL
                    AND metadata.decimals IS NOT NULL
                    AND (
                        EXISTS (
                         SELECT 1
                           FROM stark_price_ticks AS tick
                          WHERE tick.lane = pnl.lane
                            AND tick.token_address = pnl.gas_fee_token_address
                            AND tick.low_confidence = FALSE
                            AND tick.block_timestamp BETWEEN
                                (pnl.block_timestamp - make_interval(secs => $2::int))
                                AND
                                (pnl.block_timestamp + make_interval(secs => $2::int))
                    )
                     OR ($3::boolean = TRUE AND $4::text IS NOT NULL AND lower(pnl.gas_fee_token_address) = lower($4))
                     OR ($5::boolean = TRUE AND $6::text IS NOT NULL AND lower(pnl.gas_fee_token_address) = lower($6))
                    )
               )
          )`,
      [
        window.lane,
        GAS_PRICE_FALLBACK_WINDOW_SECONDS,
        FIXED_GAS_ANCHOR_ETH_USD_SCALED !== null,
        ethTokenAddress,
        FIXED_GAS_ANCHOR_STRK_USD_SCALED !== null,
        strkTokenAddress,
      ],
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
  const ethTokenAddress = knownErc20Cache.findBySymbol('ETH')[0]?.l2TokenAddress ?? null;
  const strkTokenAddress = knownErc20Cache.findBySymbol('STRK')[0]?.l2TokenAddress ?? null;
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
            tx.actual_fee_unit,
            tx.raw_transaction ->> 'version' AS tx_version,
            tx.raw_transaction ->> 'fee_data_availability_mode' AS fee_data_availability_mode,
            CASE
              WHEN jsonb_typeof(tx.raw_transaction -> 'resource_bounds') = 'object' THEN TRUE
              ELSE FALSE
            END AS tx_has_resource_bounds,
            gas_tick.price_usd AS gas_fee_price_usd,
            gas_tick.block_number AS gas_fee_price_block_number,
            gas_tick.price_is_stale AS gas_fee_price_is_stale,
            gas_tick.price_source AS gas_fee_price_source
       FROM stark_trades AS trade
       LEFT JOIN stark_tx_raw AS tx
              ON tx.lane = trade.lane
             AND tx.block_number = trade.block_number
             AND tx.transaction_hash = trade.transaction_hash
       LEFT JOIN LATERAL (
             SELECT tick.price_usd,
                    tick.block_number,
                    tick.price_is_stale,
                    tick.price_source
               FROM stark_price_ticks AS tick
              WHERE tick.lane = trade.lane
                AND tick.low_confidence = FALSE
                AND tick.token_address = CASE
                    WHEN UPPER(COALESCE(tx.actual_fee_unit, '')) = 'WEI' THEN $3
                    WHEN UPPER(COALESCE(tx.actual_fee_unit, '')) IN ('FRI', 'STRK') THEN $4
                    WHEN (
                         LOWER(COALESCE(tx.raw_transaction ->> 'version', '')) ~ '^(0x)?[0-9a-f]+$'
                     AND RIGHT(REGEXP_REPLACE(LOWER(COALESCE(tx.raw_transaction ->> 'version', '')), '^0x', ''), 1) IN ('3', '4', '5', '6', '7', '8', '9')
                     AND (
                          jsonb_typeof(tx.raw_transaction -> 'resource_bounds') = 'object'
                       OR tx.raw_transaction ? 'fee_data_availability_mode'
                       OR tx.raw_transaction ? 'paymaster_data'
                     )
                    ) THEN $4
                    WHEN (
                         LOWER(COALESCE(tx.raw_transaction ->> 'version', '')) ~ '^(0x)?[0-9a-f]+$'
                     AND RIGHT(REGEXP_REPLACE(LOWER(COALESCE(tx.raw_transaction ->> 'version', '')), '^0x', ''), 1) IN ('0', '1', '2')
                    ) THEN $3
                    ELSE NULL
                END
                AND tick.block_timestamp BETWEEN
                    (trade.block_timestamp - make_interval(secs => $5::int))
                    AND
                    (trade.block_timestamp + make_interval(secs => $5::int))
              ORDER BY
                   ABS(EXTRACT(EPOCH FROM (tick.block_timestamp - trade.block_timestamp))) ASC,
                   CASE
                     WHEN (
                          tick.block_number < trade.block_number
                       OR (
                            tick.block_number = trade.block_number
                        AND (
                             tick.transaction_index < trade.transaction_index
                          OR (
                               tick.transaction_index = trade.transaction_index
                           AND tick.source_event_index <= trade.source_event_index
                          )
                        )
                       )
                     ) THEN 0 ELSE 1
                   END ASC,
                   tick.block_number DESC,
                   tick.transaction_index DESC,
                   tick.source_event_index DESC
              LIMIT 1
       ) AS gas_tick
         ON TRUE
      WHERE trade.lane = $1
        AND trade.block_number <= $2
        AND trade.trader_address IS NOT NULL
      ORDER BY trade.block_number ASC, trade.transaction_index ASC, trade.source_event_index ASC, trade.trade_key ASC`,
    [lane, toNumericString(maxBlockNumber, 'wallet rollup max block'), ethTokenAddress, strkTokenAddress, GAS_PRICE_FALLBACK_WINDOW_SECONDS],
  );

  return result.rows.map((row) => {
    const gasFeeToken = resolveGasFeeTokenContext({
      actualFeeUnit: row.actual_fee_unit,
      feeDataAvailabilityMode: row.fee_data_availability_mode ?? null,
      hasResourceBounds: Boolean(row.tx_has_resource_bounds),
      txVersionRaw: row.tx_version ?? null,
    });

    return {
      actualFeeAmount: row.actual_fee_amount === null ? null : toBigIntStrict(row.actual_fee_amount, 'wallet trade actual fee amount'),
      actualFeeUnit: row.actual_fee_unit === null ? null : String(row.actual_fee_unit).toUpperCase(),
      amountIn: toBigIntStrict(row.amount_in, 'wallet trade amount in'),
      amountOut: toBigIntStrict(row.amount_out, 'wallet trade amount out'),
      blockHash: row.block_hash,
      blockNumber: toBigIntStrict(row.block_number, 'wallet trade block number'),
      blockTimestamp: starkTimestampToDate(row.block_timestamp),
      feeDataAvailabilityMode: row.fee_data_availability_mode ?? null,
      gasFeePriceBlockNumber: row.gas_fee_price_block_number === null ? null : toBigIntStrict(row.gas_fee_price_block_number, 'wallet trade gas fee price block'),
      gasFeePriceIsStale: row.gas_fee_price_is_stale === null ? null : Boolean(row.gas_fee_price_is_stale),
      gasFeePriceSource: row.gas_fee_price_source ?? null,
      gasFeePriceUsdScaled: row.gas_fee_price_usd === null ? null : decimalStringToScaled(row.gas_fee_price_usd, DEFAULT_SCALE),
      gasFeeTokenAddress: gasFeeToken.address,
      gasFeeTokenReason: gasFeeToken.reason,
      gasFeeTokenSymbol: gasFeeToken.symbol,
      hasV3ResourceBounds: Boolean(row.tx_has_resource_bounds),
      notionalUsdScaled: row.notional_usd === null ? null : decimalStringToScaled(row.notional_usd, DEFAULT_SCALE),
      pendingEnrichment: Boolean(row.pending_enrichment),
      sourceEventIndex: toBigIntStrict(row.source_event_index, 'wallet trade source event index'),
      tokenInAddress: row.token_in_address,
      tokenOutAddress: row.token_out_address,
      tradeKey: row.trade_key,
      traderAddress: row.trader_address,
      transactionHash: row.transaction_hash,
      transactionIndex: toBigIntStrict(row.transaction_index, 'wallet trade transaction index'),
      txVersion: gasFeeToken.txVersion,
    };
  });
}

async function loadBridgeActivities(client, { lane, maxBlockNumber }) {
  const result = await client.query(
    `SELECT bridge_key,
            activity.block_number,
            activity.transaction_hash,
            activity.direction,
            activity.classification,
            activity.l2_wallet_address,
            activity.l1_sender,
            activity.token_address,
            activity.amount,
            activity.l1_match_status,
            activity.settlement_seconds,
            activity.eth_block_number,
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
    ethBlockNumber: row.eth_block_number === null ? null : BigInt(row.eth_block_number),
    l1MatchStatus: row.l1_match_status,
    l1Sender: row.l1_sender,
    settlementSeconds: row.settlement_seconds === null ? null : Number.parseInt(String(row.settlement_seconds), 10),
    sourceEventIndex: row.source_event_index === null ? 0n : toBigIntStrict(row.source_event_index, 'wallet bridge source event index'),
    tokenAddress: row.token_address,
    transactionHash: row.transaction_hash,
    transactionIndex: toBigIntStrict(row.transaction_index, 'wallet bridge transaction index'),
    walletAddress: row.l2_wallet_address,
  }));
}

async function loadWalletTransfers(client, { lane, maxBlockNumber }) {
  const result = await client.query(
    `SELECT transfer.transfer_key,
            transfer.block_number,
            transfer.block_hash,
            transfer.transaction_hash,
            transfer.transaction_index,
            transfer.source_event_index,
            transfer.token_address,
            transfer.from_address,
            transfer.to_address,
            transfer.amount,
            transfer.amount_usd,
            transfer.transfer_type,
            transfer.counterparty_type,
            journal.block_timestamp
       FROM stark_transfers AS transfer
       LEFT JOIN stark_block_journal AS journal
              ON journal.lane = transfer.lane
             AND journal.block_number = transfer.block_number
             AND journal.block_hash = transfer.block_hash
             AND journal.is_orphaned = FALSE
      WHERE transfer.lane = $1
        AND transfer.block_number <= $2
        AND COALESCE(transfer.is_internal, FALSE) = FALSE
        AND COALESCE(transfer.transfer_type, 'standard_transfer') <> 'routing_transfer'
        AND (transfer.from_address IS NOT NULL OR transfer.to_address IS NOT NULL)
        AND NOT EXISTS (
             SELECT 1
               FROM stark_bridge_activities AS activity
              WHERE activity.lane = transfer.lane
                AND activity.block_number = transfer.block_number
                AND activity.transaction_hash = transfer.transaction_hash
                AND COALESCE(activity.source_event_index, 0) = transfer.source_event_index
                AND activity.token_address = transfer.token_address
                AND (
                     activity.l2_wallet_address = transfer.from_address
                  OR activity.l2_wallet_address = transfer.to_address
                )
        )
      ORDER BY transfer.block_number ASC, transfer.transaction_index ASC, transfer.source_event_index ASC, transfer.transfer_key ASC`,
    [lane, toNumericString(maxBlockNumber, 'wallet transfer max block')],
  );

  return result.rows.map((row) => ({
    amount: toBigIntStrict(row.amount, 'wallet transfer amount'),
    amountUsdScaled: row.amount_usd === null ? null : decimalStringToScaled(row.amount_usd, DEFAULT_SCALE),
    blockHash: row.block_hash,
    blockNumber: toBigIntStrict(row.block_number, 'wallet transfer block number'),
    blockTimestamp: starkTimestampToDate(row.block_timestamp),
    counterpartyType: row.counterparty_type ?? 'unknown',
    fromAddress: row.from_address,
    sourceEventIndex: toBigIntStrict(row.source_event_index, 'wallet transfer source event index'),
    toAddress: row.to_address,
    tokenAddress: row.token_address,
    transactionHash: row.transaction_hash,
    transactionIndex: toBigIntStrict(row.transaction_index, 'wallet transfer transaction index'),
    transferKey: row.transfer_key,
    transferType: row.transfer_type ?? 'standard_transfer',
  }));
}

function collectTokenAddresses(trades, bridges, transfers = []) {
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

  for (const transfer of transfers) {
    if (transfer.tokenAddress) {
      values.add(transfer.tokenAddress);
    }
  }

  return Array.from(values);
}

function allocateGasFeesToTrades(trades, tokenContext) {
  const grouped = new Map();
  const gasPriceAudits = [];

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
    const referenceTrade = tradeGroup.find((item) => item.actualFeeAmount !== null && item.gasFeePriceUsdScaled !== null)
      ?? tradeGroup.find((item) => item.actualFeeAmount !== null);
    if (!referenceTrade || referenceTrade.actualFeeAmount === null) {
      continue;
    }

    if (!referenceTrade.gasFeeTokenAddress) {
      for (const trade of tradeGroup) {
        trade.gasFeePending = true;
      }
      continue;
    }

    const gasTokenInfo = resolveHistoricalGasTokenInfo(referenceTrade, tokenContext);
    let totalGasFeeUsdScaled = computeUsdValueFromRawAmount(referenceTrade.actualFeeAmount, gasTokenInfo, { allowStale: false });

    if (totalGasFeeUsdScaled === null) {
      const fixedAnchorPriceUsdScaled = resolveFixedGasAnchorPriceUsdScaled(referenceTrade);
      if (fixedAnchorPriceUsdScaled !== null) {
        totalGasFeeUsdScaled = computeUsdValueFromRawAmount(referenceTrade.actualFeeAmount, {
          decimals: gasTokenInfo?.decimals ?? resolveFallbackGasTokenDecimals(referenceTrade.gasFeeTokenAddress),
          priceIsStale: false,
          priceSource: 'configured_fixed_gas_anchor',
          priceUpdatedAtBlock: referenceTrade.blockNumber,
          priceUsdScaled: fixedAnchorPriceUsdScaled,
        }, { allowStale: false });

        for (const trade of tradeGroup) {
          trade.gasFeeAnchorMode = 'fixed_anchor';
          trade.gasFeePriceBlockNumber = trade.blockNumber;
          trade.gasFeePriceIsStale = false;
          trade.gasFeePriceSource = 'configured_fixed_gas_anchor';
          trade.gasFeePriceUsdScaled = fixedAnchorPriceUsdScaled;
        }
      }
    }

    if (totalGasFeeUsdScaled === null) {
      for (const trade of tradeGroup) {
        trade.gasFeePending = true;
        trade.gasFeeAnchorMode = 'missing';
      }
      gasPriceAudits.push(buildGasPriceMissingAudit(referenceTrade));
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

  return {
    gasPriceAudits,
    trades: Array.from(grouped.values()).flat(),
  };
}

function resolveGasFeeTokenContext({
  actualFeeUnit,
  feeDataAvailabilityMode = null,
  hasResourceBounds = false,
  txVersionRaw = null,
}) {
  const unit = actualFeeUnit === null || actualFeeUnit === undefined
    ? null
    : String(actualFeeUnit).trim().toUpperCase();
  const txVersion = parseOptionalTransactionVersion(txVersionRaw);
  const normalizedTxVersion = normalizeTransactionVersion(txVersion);
  const hasV3StyleFeeFields = Boolean(hasResourceBounds || feeDataAvailabilityMode !== null);
  const ethAddress = knownErc20Cache.findBySymbol('ETH')[0]?.l2TokenAddress ?? null;
  const strkAddress = knownErc20Cache.findBySymbol('STRK')[0]?.l2TokenAddress ?? null;

  if (unit === 'WEI') {
    return {
      address: ethAddress,
      reason: 'actual_fee_unit_wei',
      symbol: 'ETH',
      txVersion,
    };
  }

  if (unit === 'FRI' || unit === 'STRK') {
    return {
      address: strkAddress,
      reason: 'actual_fee_unit_fri',
      symbol: 'STRK',
      txVersion,
    };
  }

  if (normalizedTxVersion !== null && normalizedTxVersion >= 3n && hasV3StyleFeeFields) {
    return {
      address: strkAddress,
      reason: 'tx_v3_fee_fields',
      symbol: 'STRK',
      txVersion,
    };
  }

  if (normalizedTxVersion !== null && normalizedTxVersion >= 3n) {
    return {
      address: strkAddress,
      reason: 'tx_v3_version',
      symbol: 'STRK',
      txVersion,
    };
  }

  if (normalizedTxVersion !== null && normalizedTxVersion < 3n) {
    return {
      address: ethAddress,
      reason: 'legacy_tx_version',
      symbol: 'ETH',
      txVersion,
    };
  }

  return {
    address: null,
    reason: 'unresolved',
    symbol: null,
    txVersion,
  };
}

function parseOptionalTransactionVersion(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return null;
  }

  return toBigIntStrict(String(value).trim(), 'wallet trade tx version');
}

function normalizeTransactionVersion(version) {
  if (version === null || version === undefined) {
    return null;
  }

  return version & 0xffn;
}

function resolveHistoricalGasTokenInfo(trade, tokenContext) {
  if (!trade.gasFeeTokenAddress || trade.gasFeePriceUsdScaled === null || trade.gasFeePriceUsdScaled === undefined) {
    return null;
  }

  const gasTokenInfo = tokenContext.get(trade.gasFeeTokenAddress) ?? null;
  if (!gasTokenInfo) {
    return null;
  }

  return {
    ...gasTokenInfo,
    priceIsStale: Boolean(trade.gasFeePriceIsStale),
    priceSource: trade.gasFeePriceSource ?? gasTokenInfo.priceSource ?? null,
    priceUpdatedAtBlock: trade.gasFeePriceBlockNumber ?? gasTokenInfo.priceUpdatedAtBlock ?? null,
    priceUsdScaled: trade.gasFeePriceUsdScaled,
  };
}

function resolveFixedGasAnchorPriceUsdScaled(trade) {
  if (!trade?.gasFeeTokenAddress) {
    return null;
  }

  const normalized = String(trade.gasFeeTokenAddress).toLowerCase();
  const ethAddress = knownErc20Cache.findBySymbol('ETH')[0]?.l2TokenAddress?.toLowerCase() ?? null;
  const strkAddress = knownErc20Cache.findBySymbol('STRK')[0]?.l2TokenAddress?.toLowerCase() ?? null;

  if (ethAddress && normalized === ethAddress) {
    return FIXED_GAS_ANCHOR_ETH_USD_SCALED;
  }

  if (strkAddress && normalized === strkAddress) {
    return FIXED_GAS_ANCHOR_STRK_USD_SCALED;
  }

  return null;
}

function resolveFallbackGasTokenDecimals(tokenAddress) {
  if (!tokenAddress) {
    return null;
  }

  const knownToken = knownErc20Cache.getToken(tokenAddress);
  return knownToken?.decimals ?? null;
}

function buildGasPriceMissingAudit(trade) {
  return {
    blockHash: trade.blockHash,
    blockNumber: trade.blockNumber,
    blockTimestamp: trade.blockTimestamp,
    gasFeeAmount: trade.actualFeeAmount,
    gasFeeTokenAddress: trade.gasFeeTokenAddress,
    holderAddress: trade.traderAddress,
    sourceEventIndex: trade.sourceEventIndex,
    tokenAddress: trade.gasFeeTokenAddress ?? trade.tokenInAddress,
    tradeKey: trade.tradeKey,
    transactionHash: trade.transactionHash,
    transactionIndex: trade.transactionIndex,
    metadata: {
      audit_reason: 'historical_gas_price_missing',
      fallback_window_seconds: GAS_PRICE_FALLBACK_WINDOW_SECONDS,
      fee_data_availability_mode: trade.feeDataAvailabilityMode ?? null,
      fee_unit: trade.actualFeeUnit ?? null,
      fixed_anchor_eth_configured: FIXED_GAS_ANCHOR_ETH_USD_SCALED !== null,
      fixed_anchor_strk_configured: FIXED_GAS_ANCHOR_STRK_USD_SCALED !== null,
      gas_fee_token_reason: trade.gasFeeTokenReason ?? null,
      gas_fee_token_symbol: trade.gasFeeTokenSymbol ?? null,
      tx_version: trade.txVersion === null ? null : trade.txVersion.toString(10),
    },
  };
}

function processBridgeActivity({ activity, positions, tokenContext, walletStats }) {
  if (!activity.walletAddress || !activity.tokenAddress || activity.walletAddress === ZERO_ADDRESS) {
    return;
  }

  const position = ensurePosition(positions, activity.walletAddress, activity.tokenAddress);
  const stats = ensureWalletStats(walletStats, activity.walletAddress);
  const tokenInfo = tokenContext.get(activity.tokenAddress) ?? null;
  applyTokenInfoToPosition(position, tokenInfo);
  const usdValueScaled = activity.amount === null ? null : computeUsdValueFromRawAmount(activity.amount, tokenInfo, { allowStale: true });

  updateActivityMarkers(position, activity.blockNumber, activity.blockTimestamp);
  stats.bridgeActivityCount += 1n;
  if (activity.l1Sender && stats.l1WalletAddress === null) {
    stats.l1WalletAddress = activity.l1Sender;
  }
  if (activity.l1MatchStatus === 'MATCHED' && activity.ethBlockNumber !== null) {
    stats.firstL1ActivityBlock = stats.firstL1ActivityBlock === null
      ? activity.ethBlockNumber
      : (activity.ethBlockNumber < stats.firstL1ActivityBlock ? activity.ethBlockNumber : stats.firstL1ActivityBlock);
    stats.lastL1ActivityBlock = stats.lastL1ActivityBlock === null
      ? activity.ethBlockNumber
      : (activity.ethBlockNumber > stats.lastL1ActivityBlock ? activity.ethBlockNumber : stats.lastL1ActivityBlock);
  }
  if (activity.l1MatchStatus === 'MATCHED' && activity.settlementSeconds !== null) {
    stats.bridgeSettlementCount = (stats.bridgeSettlementCount ?? 0n) + 1n;
    stats.avgBridgeSettlementSeconds = stats.avgBridgeSettlementSeconds === null
      ? activity.settlementSeconds
      : Math.round(((stats.avgBridgeSettlementSeconds * Number(stats.bridgeSettlementCount - 1n)) + activity.settlementSeconds) / Number(stats.bridgeSettlementCount));
  }

  if (activity.direction === 'bridge_in') {
    position.bridgeInCount += 1n;
    if (activity.amount !== null) {
      position.externalQuantity += activity.amount;
      if (usdValueScaled !== null) {
        position.externalCostBasisUsdScaled += usdValueScaled;
        stats.bridgeInflowUsdScaled += usdValueScaled;
        if (activity.l1MatchStatus === 'MATCHED') {
          stats.l1BridgeInflowUsdScaled += usdValueScaled;
        }
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
        if (activity.l1MatchStatus === 'MATCHED') {
          stats.l1BridgeOutflowUsdScaled += usdValueScaled;
        }
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

function processTransferActivity({ positions, tokenContext, transfer, walletStats }) {
  if (!transfer.tokenAddress) {
    return;
  }

  const tokenInfo = tokenContext.get(transfer.tokenAddress) ?? null;
  const usdValueScaled = transfer.amountUsdScaled ?? computeUsdValueFromRawAmount(transfer.amount, tokenInfo, { allowStale: true });
  let transferredCostBasisUsdScaled = null;

  if (transfer.fromAddress && transfer.fromAddress !== ZERO_ADDRESS) {
    const outboundPosition = ensurePosition(positions, transfer.fromAddress, transfer.tokenAddress);
    const outboundStats = ensureWalletStats(walletStats, transfer.fromAddress);
    applyTokenInfoToPosition(outboundPosition, tokenInfo);
    updateActivityMarkers(outboundPosition, transfer.blockNumber, transfer.blockTimestamp);
    outboundPosition.metadata.transfer_out_count += 1;
    outboundStats.metadata.transfer_out_count += 1;
    const consumed = consumeInventoryWithoutPnl(outboundPosition, transfer.amount, outboundStats);
    transferredCostBasisUsdScaled = consumed.costBasisUsdScaled;
  }

  if (transfer.toAddress && transfer.toAddress !== ZERO_ADDRESS) {
    const inboundPosition = ensurePosition(positions, transfer.toAddress, transfer.tokenAddress);
    const inboundStats = ensureWalletStats(walletStats, transfer.toAddress);
    applyTokenInfoToPosition(inboundPosition, tokenInfo);
    updateActivityMarkers(inboundPosition, transfer.blockNumber, transfer.blockTimestamp);
    inboundPosition.externalQuantity += transfer.amount;
    inboundPosition.metadata.transfer_in_count += 1;
    inboundStats.metadata.transfer_in_count += 1;

    if (transferredCostBasisUsdScaled !== null) {
      inboundPosition.externalCostBasisUsdScaled += transferredCostBasisUsdScaled;
    } else if (usdValueScaled !== null) {
      inboundPosition.externalCostBasisUsdScaled += usdValueScaled;
    } else {
      inboundPosition.metadata.transfer_pricing_gaps += 1;
      inboundStats.metadata.transfer_pricing_gaps += 1;
    }
  }
}

function processTrade({ lane, pnlAuditTrail, pnlEvents, positions, tokenContext, trade, walletStats }) {
  if (!trade.traderAddress || trade.tokenInAddress === trade.tokenOutAddress) {
    return false;
  }

  const stats = ensureWalletStats(walletStats, trade.traderAddress);
  const sellPosition = ensurePosition(positions, trade.traderAddress, trade.tokenInAddress);
  const buyPosition = ensurePosition(positions, trade.traderAddress, trade.tokenOutAddress);
  applyTokenInfoToPosition(sellPosition, tokenContext.get(trade.tokenInAddress) ?? null);
  applyTokenInfoToPosition(buyPosition, tokenContext.get(trade.tokenOutAddress) ?? null);

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

  const lineageMigration = resolveTokenLineageMigration(trade);
  if (lineageMigration) {
    sellPosition.metadata.lineage_migration_out_count = (sellPosition.metadata.lineage_migration_out_count ?? 0) + 1;
    buyPosition.metadata.lineage_migration_in_count = (buyPosition.metadata.lineage_migration_in_count ?? 0) + 1;
    stats.metadata.lineage_migration_count = (stats.metadata.lineage_migration_count ?? 0) + 1;

    const carriedInventory = consumeInventoryWithoutPnl(sellPosition, trade.amountIn, stats);
    const carriedCostBasisUsdScaled = carriedInventory.costBasisUsdScaled;
    const migratedCostBasisUsdScaled = carriedCostBasisUsdScaled + gasFeeUsdScaled;

    if (carriedInventory.inventoryGap > 0n) {
      sellPosition.pendingPricing = true;
      buyPosition.pendingPricing = true;
      sellPosition.metadata.inventory_gap_qty += Number(carriedInventory.inventoryGap);
      stats.metadata.inventory_gap_qty += Number(carriedInventory.inventoryGap);
    }

    addTradeLot(buyPosition, {
      blockNumber: trade.blockNumber,
      costBasisUsdScaled: migratedCostBasisUsdScaled,
      lineagePath: lineageMigration.fullPath,
      lineageRootAddress: lineageMigration.rootAddress,
      lotId: `${trade.tradeKey}:migration`,
      quantity: trade.amountOut,
      tradeKey: trade.tradeKey,
      transactionHash: trade.transactionHash,
    });

    pnlEvents.push(buildPnlEvent({
      blockHash: trade.blockHash,
      blockNumber: trade.blockNumber,
      blockTimestamp: trade.blockTimestamp,
      costBasisUsdScaled: migratedCostBasisUsdScaled,
      externalQuantity: 0n,
      gasFeeAmount: hasGasFee ? trade.actualFeeAmount : null,
      gasFeeTokenAddress: trade.gasFeeTokenAddress,
      gasFeeUsdScaled: hasGasFee ? gasFeeUsdScaled : null,
      lane,
      metadata: {
        fee_data_availability_mode: trade.feeDataAvailabilityMode ?? null,
        gas_fee_token_reason: trade.gasFeeTokenReason ?? null,
        gas_fee_token_symbol: trade.gasFeeTokenSymbol ?? null,
        gas_fee_unit: trade.actualFeeUnit ?? null,
        lineage_ambiguous_ancestry: Boolean(lineageMigration.ambiguousAncestry),
        lineage_carryover: true,
        lineage_depth: lineageMigration.depth,
        lineage_key: lineageMigration.lineageKey,
        lineage_migration_type: lineageMigration.migrationType,
        lineage_path: lineageMigration.fullPath,
        lineage_root_address: lineageMigration.rootAddress,
        migrated_from_token: trade.tokenInAddress,
        trade_side: 'migration_in',
        tx_version: trade.txVersion === null ? null : trade.txVersion.toString(10),
      },
      pnlEventKey: `${trade.tradeKey}:${trade.tokenOutAddress}:migration_in`,
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

    return true;
  }

  const sellResult = consumeTradeSellInventory(sellPosition, {
    amountSold: trade.amountIn,
    proceedsUsdScaled: sellProceedsUsdScaled,
  }, {
    auditTrail: pnlAuditTrail,
    sellContext: {
      lane,
      sellBlockNumber: trade.blockNumber,
      sellSourceEventIndex: trade.sourceEventIndex,
      sellTradeKey: trade.tradeKey,
      sellTransactionHash: trade.transactionHash,
      tokenAddress: trade.tokenInAddress,
      walletAddress: trade.traderAddress,
    },
    stats,
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

  addTradeLot(buyPosition, {
    blockNumber: trade.blockNumber,
    costBasisUsdScaled: buyCostBasisUsdScaled,
    lineagePath: [trade.tokenOutAddress],
    lineageRootAddress: trade.tokenOutAddress,
    lotId: trade.tradeKey,
    quantity: trade.amountOut,
    tradeKey: trade.tradeKey,
    transactionHash: trade.transactionHash,
  });

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
      fee_data_availability_mode: trade.feeDataAvailabilityMode ?? null,
      gas_fee_token_reason: trade.gasFeeTokenReason ?? null,
      gas_fee_token_symbol: trade.gasFeeTokenSymbol ?? null,
      gas_fee_unit: trade.actualFeeUnit ?? null,
      gas_price_anchor_mode: trade.gasFeeAnchorMode ?? 'historical_tick',
      gas_fee_pending: trade.gasFeePending,
      gas_price_anchor_block_number: trade.gasFeePriceBlockNumber === null ? null : trade.gasFeePriceBlockNumber.toString(10),
      gas_price_is_stale: Boolean(trade.gasFeePriceIsStale),
      gas_price_source: trade.gasFeePriceSource ?? null,
      pending_enrichment: trade.pendingEnrichment,
      tx_version: trade.txVersion === null ? null : trade.txVersion.toString(10),
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
      fee_data_availability_mode: trade.feeDataAvailabilityMode ?? null,
      gas_fee_token_reason: trade.gasFeeTokenReason ?? null,
      gas_fee_token_symbol: trade.gasFeeTokenSymbol ?? null,
      gas_fee_unit: trade.actualFeeUnit ?? null,
      gas_price_anchor_mode: trade.gasFeeAnchorMode ?? 'historical_tick',
      gas_fee_pending: trade.gasFeePending,
      gas_price_anchor_block_number: trade.gasFeePriceBlockNumber === null ? null : trade.gasFeePriceBlockNumber.toString(10),
      gas_price_is_stale: Boolean(trade.gasFeePriceIsStale),
      gas_price_source: trade.gasFeePriceSource ?? null,
      inventory_gap_qty: sellResult.inventoryGap.toString(10),
      pending_enrichment: trade.pendingEnrichment,
      tx_version: trade.txVersion === null ? null : trade.txVersion.toString(10),
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

    if (
      totalQuantity === 0n
      && position.realizedPnlUsdScaled === 0n
      && position.dustLossUsdScaled === 0n
      && position.tradeCount === 0n
      && position.bridgeInCount === 0n
      && position.bridgeOutCount === 0n
    ) {
      continue;
    }

    rows.push({
      averageTradedEntryPriceUsdScaled,
      bridgeInCount: position.bridgeInCount,
      bridgeOutCount: position.bridgeOutCount,
      dustLossUsdScaled: position.dustLossUsdScaled,
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
    netPnlUsdScaled: stats.realizedPnlUsdScaled + stats.unrealizedPnlUsdScaled - stats.totalDustLossUsdScaled,
    winRateScaled: closedTrades === 0n ? null : scaledRatio(stats.winningTradeCount, closedTrades, 0, DEFAULT_SCALE),
  };
}

function applyTokenInfoToPosition(position, tokenInfo) {
  if (!tokenInfo || tokenInfo.decimals === null || tokenInfo.decimals === undefined) {
    return;
  }

  position.tokenDecimals = tokenInfo.decimals;
}

function resolveTokenLineageMigration(trade) {
  const lineageEntry = TOKEN_LINEAGE_MAP.get(trade.tokenInAddress);
  if (!lineageEntry) {
    return null;
  }

  if (String(trade.tokenOutAddress).toLowerCase() !== String(lineageEntry.canonicalAddress).toLowerCase()) {
    return null;
  }

  if (lineageEntry.windowStart && trade.blockTimestamp && trade.blockTimestamp < lineageEntry.windowStart) {
    return null;
  }

  if (lineageEntry.windowEnd && trade.blockTimestamp && trade.blockTimestamp > lineageEntry.windowEnd) {
    return null;
  }

  return lineageEntry;
}

async function findEarliestPendingRedecodeBlock(client, { lane, maxBlockNumber }) {
  const result = await client.query(
    `SELECT MIN(block_number) AS block_number
       FROM stark_audit_discrepancies
      WHERE lane = $1
        AND resolution_status = 'PENDING_REDECODE'
        AND block_number IS NOT NULL
        AND block_number <= $2`,
    [lane, toNumericString(maxBlockNumber, 'wallet pending redecode max block')],
  );

  return result.rows[0]?.block_number === null
    ? null
    : toBigIntStrict(result.rows[0].block_number, 'wallet pending redecode block number');
}

function clampAnalyticsBlockBeforePendingRedecode(maxBlockNumber, pendingRedecodeBlock) {
  if (maxBlockNumber === null || maxBlockNumber === undefined) {
    return null;
  }

  if (pendingRedecodeBlock === null || pendingRedecodeBlock === undefined) {
    return maxBlockNumber;
  }

  return pendingRedecodeBlock <= 0n
    ? null
    : minBigInt(maxBlockNumber, pendingRedecodeBlock - 1n);
}

function ensurePosition(positions, walletAddress, tokenAddress) {
  const key = `${walletAddress}:${tokenAddress}`;
  if (positions.has(key)) {
    return positions.get(key);
  }

  const position = {
    bridgeInCount: 0n,
    bridgeOutCount: 0n,
    dustLossUsdScaled: 0n,
    externalCostBasisUsdScaled: 0n,
    externalQuantity: 0n,
    firstActivityBlockNumber: null,
    lastActivityBlockNumber: null,
    lastActivityTimestamp: null,
    metadata: {
      bridge_pricing_gaps: 0,
      transfer_in_count: 0,
      transfer_out_count: 0,
      transfer_pricing_gaps: 0,
      bridge_without_amount: 0,
      cost_basis_method: 'fifo_lifetime_event_lineage',
      fifo_dust_closed_lots: 0,
      fifo_dust_closed_qty: '0',
      inventory_gap_qty: 0,
      lineage_migration_in_count: 0,
      lineage_migration_out_count: 0,
      pending_gas_fee_trades: 0,
      skipped_unpriced_trades: 0,
    },
    pendingPricing: false,
    realizedPnlUsdScaled: 0n,
    tokenAddress,
    tokenDecimals: null,
    tradeCount: 0n,
    tradeLots: [],
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
    avgBridgeSettlementSeconds: null,
    bestTradeAtBlock: null,
    bestTradePnlUsdScaled: null,
    bestTradeTokenAddress: null,
    bestTradeTxHash: null,
    bridgeActivityCount: 0n,
    bridgeInflowUsdScaled: 0n,
    bridgeOutflowUsdScaled: 0n,
    bridgeSettlementCount: 0n,
    firstL1ActivityBlock: null,
    firstTradeBlockNumber: null,
    l1BridgeInflowUsdScaled: 0n,
    l1BridgeOutflowUsdScaled: 0n,
    l1WalletAddress: null,
    lastTradeBlockNumber: null,
    lastL1ActivityBlock: null,
    losingTradeCount: 0n,
    metadata: {
      bridge_pricing_gaps: 0,
      bridge_without_amount: 0,
      fifo_dust_closed_lots: 0,
      fifo_dust_closed_qty: '0',
      inventory_gap_qty: 0,
      lineage_migration_count: 0,
      pending_gas_fee_trades: 0,
      pending_pricing_positions: 0,
      skipped_unpriced_trades: 0,
      transfer_in_count: 0,
      transfer_out_count: 0,
      transfer_pricing_gaps: 0,
    },
    realizedPnlUsdScaled: 0n,
    totalDustLossUsdScaled: 0n,
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
  let externalCostBasisRelieved = 0n;
  let tradedCostBasisRelieved = 0n;
  let externalQuantityConsumed = 0n;
  let tradedQuantityConsumed = 0n;

  if (position.externalQuantity > 0n) {
    const externalQtyBefore = position.externalQuantity;
    const externalConsumed = minBigInt(remaining, externalQtyBefore);
    const externalCostRelieved = proportionalShare(position.externalCostBasisUsdScaled, externalConsumed, externalQtyBefore);
    position.externalQuantity -= externalConsumed;
    position.externalCostBasisUsdScaled -= externalCostRelieved;
    remaining -= externalConsumed;
    externalQuantityConsumed += externalConsumed;
    externalCostBasisRelieved += externalCostRelieved;
  }

  if (remaining > 0n && position.tradedQuantity > 0n) {
    const consumed = consumeTradeLots(position, remaining);
    remaining -= consumed.quantity;
    tradedQuantityConsumed += consumed.quantity;
    tradedCostBasisRelieved += consumed.costBasisUsdScaled;
  }

  if (remaining > 0n) {
    position.pendingPricing = true;
    position.metadata.inventory_gap_qty += Number(remaining);
    stats.metadata.inventory_gap_qty += Number(remaining);
  }

  trimDustLots(position, stats);

  return {
    costBasisUsdScaled: externalCostBasisRelieved + tradedCostBasisRelieved,
    externalCostBasisRelieved,
    externalQuantityConsumed,
    inventoryGap: remaining,
    tradedCostBasisRelieved,
    tradedQuantityConsumed,
  };
}

function consumeTradeSellInventory(position, { amountSold, proceedsUsdScaled }, { auditTrail = null, sellContext = null, stats = null } = {}) {
  let remaining = amountSold;
  let externalQuantitySold = 0n;
  let tradedQuantitySold = 0n;
  let tradedCostBasisRelieved = 0n;
  let realizedPnlUsdScaled = null;
  let lotMatches = [];

  if (position.externalQuantity > 0n) {
    const externalQtyBefore = position.externalQuantity;
    externalQuantitySold = minBigInt(remaining, externalQtyBefore);
    const externalCostRelieved = proportionalShare(position.externalCostBasisUsdScaled, externalQuantitySold, externalQtyBefore);
    position.externalQuantity -= externalQuantitySold;
    position.externalCostBasisUsdScaled -= externalCostRelieved;
    remaining -= externalQuantitySold;
  }

  if (remaining > 0n && position.tradedQuantity > 0n) {
    const consumed = consumeTradeLots(position, remaining);
    tradedQuantitySold = consumed.quantity;
    tradedCostBasisRelieved = consumed.costBasisUsdScaled;
    lotMatches = consumed.matches;
    remaining -= tradedQuantitySold;

    const proceedsForTraded = amountSold === 0n
      ? 0n
      : (proceedsUsdScaled * tradedQuantitySold) / amountSold;
    realizedPnlUsdScaled = proceedsForTraded - tradedCostBasisRelieved;

    if (auditTrail && sellContext && tradedQuantitySold > 0n) {
      appendPnlAuditTrailRows(auditTrail, {
        lane: sellContext.lane,
        lotMatches,
        proceedsUsdScaled: proceedsForTraded,
        sellBlockNumber: sellContext.sellBlockNumber,
        sellSourceEventIndex: sellContext.sellSourceEventIndex,
        sellTradeKey: sellContext.sellTradeKey,
        sellTransactionHash: sellContext.sellTransactionHash,
        tokenAddress: sellContext.tokenAddress,
        walletAddress: sellContext.walletAddress,
      });
    }
  }

  trimDustLots(position, stats);

  return {
    externalQuantitySold,
    inventoryGap: remaining,
    realizedPnlUsdScaled,
    tradedCostBasisRelieved,
    tradedQuantitySold,
  };
}

function addTradeLot(position, {
  blockNumber,
  costBasisUsdScaled,
  lineagePath = null,
  lineageRootAddress = null,
  lotId = null,
  quantity,
  tradeKey,
  transactionHash,
}) {
  if (quantity <= 0n) {
    return;
  }

  position.tradedQuantity += quantity;
  position.tradedCostBasisUsdScaled += costBasisUsdScaled;
  position.tradeLots.push({
    blockNumber,
    costBasisUsdScaled,
    lineagePath: Array.isArray(lineagePath) && lineagePath.length > 0 ? [...lineagePath] : [position.tokenAddress],
    lineageRootAddress: lineageRootAddress ?? position.tokenAddress,
    lotId: lotId ?? tradeKey ?? transactionHash ?? `${position.walletAddress}:${position.tokenAddress}:${position.tradeLots.length}`,
    quantity,
    tradeKey,
    transactionHash,
  });
}

function trimDustLots(position, stats) {
  const dustThresholdRaw = resolveDustThresholdRaw(position.tokenDecimals);
  if (dustThresholdRaw <= 0n || position.tradeLots.length === 0) {
    return;
  }

  const remainingLots = [];
  let trimmedCostBasisUsdScaled = 0n;
  let trimmedLotCount = 0;
  let trimmedQuantity = 0n;

  for (const lot of position.tradeLots) {
    if (lot.quantity > 0n && lot.quantity <= dustThresholdRaw) {
      trimmedLotCount += 1;
      trimmedQuantity += lot.quantity;
      trimmedCostBasisUsdScaled += lot.costBasisUsdScaled;
      continue;
    }

    remainingLots.push(lot);
  }

  if (trimmedLotCount === 0) {
    return;
  }

  position.tradeLots = remainingLots;
  position.tradedQuantity = maxBigInt(0n, position.tradedQuantity - trimmedQuantity);
  const boundedDustLossUsdScaled = minBigInt(trimmedCostBasisUsdScaled, position.tradedCostBasisUsdScaled);
  position.tradedCostBasisUsdScaled = maxBigInt(0n, position.tradedCostBasisUsdScaled - boundedDustLossUsdScaled);
  position.dustLossUsdScaled += boundedDustLossUsdScaled;
  position.metadata.fifo_dust_closed_lots += trimmedLotCount;
  appendMetadataBigInt(position.metadata, 'fifo_dust_closed_qty', trimmedQuantity);

  if (stats) {
    stats.totalDustLossUsdScaled += boundedDustLossUsdScaled;
    stats.metadata.fifo_dust_closed_lots += trimmedLotCount;
    appendMetadataBigInt(stats.metadata, 'fifo_dust_closed_qty', trimmedQuantity);
  }
}

function consumeTradeLots(position, amount) {
  let remaining = amount;
  let consumedQuantity = 0n;
  let consumedCostBasisUsdScaled = 0n;
  const matches = [];

  while (remaining > 0n && position.tradeLots.length > 0) {
    const lot = position.tradeLots[0];
    const lotQuantityBefore = lot.quantity;
    const lotConsumed = minBigInt(remaining, lotQuantityBefore);
    const lotCostRelieved = proportionalShare(lot.costBasisUsdScaled, lotConsumed, lotQuantityBefore);

    lot.quantity -= lotConsumed;
    lot.costBasisUsdScaled -= lotCostRelieved;
    remaining -= lotConsumed;
    consumedQuantity += lotConsumed;
    consumedCostBasisUsdScaled += lotCostRelieved;
    if (lotConsumed > 0n) {
      matches.push({
        buyBlockNumber: lot.blockNumber,
        buyLineagePath: Array.isArray(lot.lineagePath) ? [...lot.lineagePath] : null,
        buyLineageRootAddress: lot.lineageRootAddress ?? null,
        buyTradeKey: lot.tradeKey ?? null,
        buyTransactionHash: lot.transactionHash ?? null,
        costBasisUsdScaled: lotCostRelieved,
        lotId: lot.lotId ?? lot.tradeKey ?? lot.transactionHash ?? null,
        quantity: lotConsumed,
      });
    }

    if (lot.quantity === 0n) {
      position.tradeLots.shift();
    }
  }

  const fallbackAvailable = position.tradedQuantity - consumedQuantity;
  if (remaining > 0n && fallbackAvailable > 0n) {
    const fallbackConsumed = minBigInt(remaining, fallbackAvailable);
    const fallbackCostAvailable = position.tradedCostBasisUsdScaled - consumedCostBasisUsdScaled;
    const fallbackCostRelieved = proportionalShare(fallbackCostAvailable, fallbackConsumed, fallbackAvailable);

    remaining -= fallbackConsumed;
    consumedQuantity += fallbackConsumed;
    consumedCostBasisUsdScaled += fallbackCostRelieved;
  }

  const boundedCostBasis = minBigInt(consumedCostBasisUsdScaled, position.tradedCostBasisUsdScaled);
  position.tradedQuantity -= consumedQuantity;
  position.tradedCostBasisUsdScaled -= boundedCostBasis;

  return {
    costBasisUsdScaled: boundedCostBasis,
    matches,
    quantity: consumedQuantity,
  };
}

function appendPnlAuditTrailRows(auditTrail, {
  lane,
  lotMatches,
  proceedsUsdScaled,
  sellBlockNumber,
  sellSourceEventIndex,
  sellTradeKey,
  sellTransactionHash,
  tokenAddress,
  walletAddress,
}) {
  const totalMatchedQuantity = lotMatches.reduce((sum, item) => sum + item.quantity, 0n);
  let remainingProceedsUsdScaled = proceedsUsdScaled;
  let remainingQuantity = totalMatchedQuantity;

  for (let index = 0; index < lotMatches.length; index += 1) {
    const match = lotMatches[index];
    const relievedProceedsUsdScaled = index === (lotMatches.length - 1) || remainingQuantity === 0n
      ? remainingProceedsUsdScaled
      : (remainingProceedsUsdScaled * match.quantity) / remainingQuantity;
    const relievedRealizedPnlUsdScaled = relievedProceedsUsdScaled - match.costBasisUsdScaled;

    auditTrail.push({
      auditTrailKey: `${sellTradeKey}:${match.buyTradeKey ?? 'unknown'}:${index}`,
      buyTradeKey: match.buyTradeKey,
      buyTransactionHash: match.buyTransactionHash,
      lane,
      lotId: match.lotId ?? `${sellTradeKey}:${index}`,
      metadata: {
        buy_block_number: match.buyBlockNumber === null ? null : match.buyBlockNumber.toString(10),
        buy_lineage_path: match.buyLineagePath ?? null,
        buy_lineage_root_address: match.buyLineageRootAddress ?? null,
      },
      relievedCostBasisUsdScaled: match.costBasisUsdScaled,
      relievedProceedsUsdScaled,
      relievedQuantity: match.quantity,
      relievedRealizedPnlUsdScaled,
      sellBlockNumber,
      sellSourceEventIndex,
      sellTradeKey,
      sellTransactionHash,
      tokenAddress,
      walletAddress,
    });

    remainingProceedsUsdScaled -= relievedProceedsUsdScaled;
    remainingQuantity -= match.quantity;
  }
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

function maxBigInt(left, right) {
  return compareBigInt(left, right) >= 0 ? left : right;
}

function appendMetadataBigInt(metadata, key, delta) {
  const current = BigInt(metadata[key] ?? '0');
  metadata[key] = (current + delta).toString(10);
}

function resolveDustThresholdRaw(tokenDecimals) {
  if (tokenDecimals === null || tokenDecimals === undefined) {
    return 0n;
  }

  const decimals = BigInt(tokenDecimals);
  if (decimals >= BigInt(DEFAULT_SCALE)) {
    return FIFO_DUST_THRESHOLD_SCALED * (10n ** (decimals - BigInt(DEFAULT_SCALE)));
  }

  return FIFO_DUST_THRESHOLD_SCALED / (10n ** (BigInt(DEFAULT_SCALE) - decimals));
}

function parseOptionalUsdScaled(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return null;
  }

  return decimalStringToScaled(String(value).trim(), DEFAULT_SCALE);
}

async function upsertPriceMissingAudit(client, audit) {
  const existing = await client.query(
    `SELECT audit_id
       FROM stark_audit_discrepancies
      WHERE lane = $1
        AND discrepancy_type = 'PRICE_MISSING_AUDIT'
        AND transaction_hash = $2
        AND source_event_index = $3
        AND token_address = $4
        AND holder_address = $5
      ORDER BY audit_id DESC
      LIMIT 1`,
    [
      audit.lane,
      audit.transactionHash,
      toNumericString(audit.sourceEventIndex, 'price audit source event index'),
      audit.tokenAddress,
      audit.holderAddress,
    ],
  );

  if (existing.rowCount > 0) {
    await client.query(
      `UPDATE stark_audit_discrepancies
          SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
              updated_at = NOW()
        WHERE audit_id = $1`,
      [existing.rows[0].audit_id, toJsonbString(audit.metadata ?? {})],
    );
    return;
  }

  await client.query(
    `INSERT INTO stark_audit_discrepancies (
         lane,
         discrepancy_type,
         block_number,
         block_hash,
         transaction_hash,
         transaction_index,
         source_event_index,
         transfer_key,
         token_address,
         holder_address,
         balance_before,
         delta_amount,
         attempted_balance_after,
         resolved_balance,
         resolution_status,
         suspected_cause,
         metadata,
         created_at,
         updated_at
     ) VALUES (
         $1, 'PRICE_MISSING_AUDIT', $2, $3, $4, $5, $6, NULL, $7, $8,
         0, 0, 0, 0, 'logged', 'missing_historical_gas_price_anchor', $9::jsonb, NOW(), NOW()
     )`,
    [
      audit.lane,
      toNumericString(audit.blockNumber, 'price audit block number'),
      audit.blockHash,
      audit.transactionHash,
      toNumericString(audit.transactionIndex, 'price audit transaction index'),
      toNumericString(audit.sourceEventIndex, 'price audit source event index'),
      audit.tokenAddress,
      audit.holderAddress,
      toJsonbString({
        ...audit.metadata,
        gas_fee_amount: audit.gasFeeAmount === null || audit.gasFeeAmount === undefined ? null : audit.gasFeeAmount.toString(10),
        gas_fee_token_address: audit.gasFeeTokenAddress ?? null,
        trade_key: audit.tradeKey ?? null,
      }),
    ],
  );
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

async function insertPnlAuditTrailRow(client, row) {
  await client.query(
    `INSERT INTO stark_pnl_audit_trail (
         audit_trail_key,
         lane,
         wallet_address,
         token_address,
         lot_id,
         buy_trade_key,
         buy_tx_hash,
         sell_trade_key,
         sell_tx_hash,
         sell_block_number,
         sell_source_event_index,
         relieved_quantity,
         relieved_cost_basis_usd,
         relieved_proceeds_usd,
         relieved_realized_pnl_usd,
         metadata,
         created_at,
         updated_at
     ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, $12, $13, $14, $15, $16::jsonb, NOW(), NOW()
     )
     ON CONFLICT (audit_trail_key)
     DO UPDATE SET
         lot_id = EXCLUDED.lot_id,
         relieved_quantity = EXCLUDED.relieved_quantity,
         relieved_cost_basis_usd = EXCLUDED.relieved_cost_basis_usd,
         relieved_proceeds_usd = EXCLUDED.relieved_proceeds_usd,
         relieved_realized_pnl_usd = EXCLUDED.relieved_realized_pnl_usd,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()`,
    [
      row.auditTrailKey,
      row.lane,
      row.walletAddress,
      row.tokenAddress,
      row.lotId,
      row.buyTradeKey ?? null,
      row.buyTransactionHash ?? null,
      row.sellTradeKey,
      row.sellTransactionHash,
      toNumericString(row.sellBlockNumber, 'pnl audit sell block number'),
      toNumericString(row.sellSourceEventIndex, 'pnl audit sell source event index'),
      toNumericString(row.relievedQuantity, 'pnl audit relieved quantity'),
      scaledOrNullToNumeric(row.relievedCostBasisUsdScaled),
      scaledOrNullToNumeric(row.relievedProceedsUsdScaled),
      scaledOrNullToNumeric(row.relievedRealizedPnlUsdScaled),
      toJsonbString(row.metadata ?? {}),
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
         dust_loss_usd,
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
         $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21::jsonb, NOW(), NOW()
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
      scaledToNumericString(row.dustLossUsdScaled, DEFAULT_SCALE),
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
         total_dust_loss_usd,
         realized_pnl_usd,
         unrealized_pnl_usd,
         net_pnl_usd,
         bridge_inflow_usd,
         bridge_outflow_usd,
         net_bridge_flow_usd,
         l1_wallet_address,
         l1_bridge_inflow_usd,
         l1_bridge_outflow_usd,
         avg_bridge_settlement_s,
         first_l1_activity_block,
         last_l1_activity_block,
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
         $21, $22, $23, $24, $25, $26, $27, $28, $29::jsonb, NOW(), NOW()
     )`,
    [
      row.lane,
      row.walletAddress,
      row.firstTradeBlockNumber === null ? null : toNumericString(row.firstTradeBlockNumber, 'wallet stats first trade block'),
      row.lastTradeBlockNumber === null ? null : toNumericString(row.lastTradeBlockNumber, 'wallet stats last trade block'),
      toNumericString(row.totalTrades, 'wallet stats total trades'),
      scaledToNumericString(row.totalVolumeUsdScaled, DEFAULT_SCALE),
      scaledToNumericString(row.totalGasFeesUsdScaled, DEFAULT_SCALE),
      scaledToNumericString(row.totalDustLossUsdScaled, DEFAULT_SCALE),
      scaledToNumericString(row.realizedPnlUsdScaled, DEFAULT_SCALE),
      scaledToNumericString(row.unrealizedPnlUsdScaled, DEFAULT_SCALE),
      scaledToNumericString(row.netPnlUsdScaled, DEFAULT_SCALE),
      scaledToNumericString(row.bridgeInflowUsdScaled, DEFAULT_SCALE),
      scaledToNumericString(row.bridgeOutflowUsdScaled, DEFAULT_SCALE),
      scaledToNumericString(row.netBridgeFlowUsdScaled, DEFAULT_SCALE),
      row.l1WalletAddress,
      scaledToNumericString(row.l1BridgeInflowUsdScaled, DEFAULT_SCALE),
      scaledToNumericString(row.l1BridgeOutflowUsdScaled, DEFAULT_SCALE),
      row.avgBridgeSettlementSeconds,
      row.firstL1ActivityBlock === null ? null : Number(row.firstL1ActivityBlock),
      row.lastL1ActivityBlock === null ? null : Number(row.lastL1ActivityBlock),
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

function starkTimestampToDate(value) {
  if (value instanceof Date) {
    return value;
  }

  if (value === null || value === undefined) {
    return null;
  }

  return new Date(Number(toBigIntStrict(value, 'wallet bridge block timestamp')) * 1000);
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
