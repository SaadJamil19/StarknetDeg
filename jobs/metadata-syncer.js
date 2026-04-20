#!/usr/bin/env node
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { setTimeout: sleep } = require('node:timers/promises');
const { absBigInt } = require('../lib/cairo/fixed-point');
const {
  assertFoundationTables,
  assertMetadataSyncTables,
  assertPhase2Tables,
  assertPhase3Tables,
  assertPhase4Tables,
  assertSchemaEnhancementTables,
} = require('../core/checkpoint');
const { rebuildPendingEnrichmentCandles } = require('../core/ohlcv');
const {
  claimTokenMetadataRefreshQueueItems,
  didResolveDecimals,
  hasResolvedDecimals,
  loadExistingTokenMetadata,
  markTokenMetadataRefreshFailed,
  markTokenMetadataRefreshProcessed,
  resolveTokenMetadata,
  seedTokenMetadataRefreshQueueFromLiveTables,
  upsertTokenMetadata,
} = require('../core/token-metadata');
const { repricePendingEnrichmentTrades } = require('../core/trades');
const { seedKnownTokens, syncTokenRegistryFromMetadata } = require('../core/token-registry');
const { createTtlCache } = require('../lib/cache');
const { toBigIntStrict } = require('../lib/cairo/bigint');
const { closePool, withClient, withTransaction } = require('../lib/db');
const { StarknetRpcClient } = require('../lib/starknet-rpc');

const contractPresenceCache = createTtlCache({
  defaultTtlMs: 300_000,
  maxEntries: 20_000,
});

const DEFAULT_TRANSFER_ROUTE_MATCH_JITTER_BPS = 1n;

let shuttingDown = false;

async function main() {
  const rpcClient = new StarknetRpcClient();
  const batchSize = parsePositiveInteger(process.env.PHASE4_METADATA_SYNC_BATCH_SIZE, 50);
  const pollIntervalMs = parsePositiveInteger(process.env.PHASE4_METADATA_SYNC_INTERVAL_MS, 15_000);
  const queueSeedLimit = parsePositiveInteger(process.env.PHASE4_METADATA_SYNC_SEED_LIMIT, 100);
  const runOnce = parseBoolean(process.env.PHASE4_METADATA_SYNC_RUN_ONCE, false);
  const stuckAfterMs = parsePositiveInteger(process.env.PHASE4_METADATA_SYNC_STUCK_AFTER_MS, 60_000);
  const transferEnrichmentBatchSize = parsePositiveInteger(process.env.PHASE4_TRANSFER_ENRICHMENT_BATCH_SIZE, 50);
  const transferMatchJitterBps = parseJitterBps(
    process.env.PHASE4_TRANSFER_ROUTE_MATCH_JITTER_BPS,
    DEFAULT_TRANSFER_ROUTE_MATCH_JITTER_BPS,
  );

  installSignalHandlers();

  await withClient(async (client) => {
    await assertFoundationTables(client);
    await assertPhase2Tables(client);
    await assertPhase3Tables(client);
    await assertPhase4Tables(client);
    await assertSchemaEnhancementTables(client);
    await assertMetadataSyncTables(client);
    await seedKnownTokens(client);
  });

  console.log(
    `[phase4] metadata-syncer starting batch_size=${batchSize} seed_limit=${queueSeedLimit} transfer_batch_size=${transferEnrichmentBatchSize} transfer_match_jitter_bps=${transferMatchJitterBps} run_once=${runOnce}`,
  );

  do {
    try {
      const summary = await processMetadataSyncBatch({
        batchSize,
        queueSeedLimit,
        rpcClient,
        stuckAfterMs,
        transferEnrichmentBatchSize,
        transferMatchJitterBps,
      });

      console.log(
        `[phase4] metadata-syncer seeded=${summary.seeded} claimed=${summary.claimed} resolved=${summary.resolved} deferred=${summary.deferred} failed=${summary.failed} repriced_trades=${summary.repricedTrades} rebuilt_candles=${summary.rebuiltCandles} recalculated_transfers=${summary.recalculatedTransfers} enriched_transfers=${summary.enrichedTransfers}`,
      );
    } catch (error) {
      console.error(`[phase4] metadata-syncer error: ${formatError(error)}`);
    }

    if (runOnce || shuttingDown) {
      break;
    }

    await sleep(pollIntervalMs);
  } while (!shuttingDown);

  await closePool();
}

async function processMetadataSyncBatch({
  batchSize,
  queueSeedLimit,
  rpcClient,
  stuckAfterMs,
  transferEnrichmentBatchSize,
  transferMatchJitterBps,
}) {
  const refreshedAtBlock = await safeGetLatestBlockNumber(rpcClient);

  const seeded = await withClient((client) => seedTokenMetadataRefreshQueueFromLiveTables(client, {
    limit: queueSeedLimit,
  }));

  const queueItems = await withTransaction((client) => claimTokenMetadataRefreshQueueItems(client, {
    limit: batchSize,
    stuckAfterMs,
  }));

  const summary = {
    claimed: queueItems.length,
    deferred: 0,
    failed: 0,
    recalculatedTransfers: 0,
    rebuiltCandles: 0,
    repricedTrades: 0,
    resolved: 0,
    seeded,
  };

  for (const item of queueItems) {
    if (shuttingDown) {
      break;
    }

    try {
      const outcome = await withTransaction(async (client) => processQueueItem(client, rpcClient, item, {
        refreshedAtBlock,
      }));

      summary.deferred += outcome.deferred;
      summary.failed += outcome.failed;
      summary.recalculatedTransfers += outcome.recalculatedTransfers;
      summary.rebuiltCandles += outcome.rebuiltCandles;
      summary.repricedTrades += outcome.repricedTrades;
      summary.resolved += outcome.resolved;
    } catch (error) {
      await withTransaction((client) => markTokenMetadataRefreshFailed(client, item.queueKey, error, {
        token_address: item.tokenAddress,
      }));
      summary.failed += 1;
    }
  }

  const transferSummary = await withClient((client) => enrichPendingTransfers(client, rpcClient, {
    limit: transferEnrichmentBatchSize,
    routeMatchJitterBps: transferMatchJitterBps,
  }));
  summary.enrichedTransfers = transferSummary.updatedTransfers;

  return summary;
}

async function processQueueItem(client, rpcClient, item, { refreshedAtBlock }) {
  const previous = await loadExistingTokenMetadata(client, item.tokenAddress);
  const metadata = await resolveTokenMetadata(client, rpcClient, item.tokenAddress, {
    forceRefresh: false,
  });

  if (!metadata) {
    await markTokenMetadataRefreshFailed(client, item.queueKey, new Error('No metadata source produced token fields.'), {
      token_address: item.tokenAddress,
    });

    return {
      deferred: 0,
      failed: 1,
      recalculatedTransfers: 0,
      rebuiltCandles: 0,
      repricedTrades: 0,
      resolved: 0,
    };
  }

  await upsertTokenMetadata(client, metadata, { refreshedAtBlock });
  await syncTokenRegistryFromMetadata(client, {
    ...metadata,
    refreshedAtBlock,
    registryMetadata: metadata.metadata ?? {},
    source: metadata.source ?? 'metadata_syncer',
  });

  const transferSummary = await recalculateTransfersForTokens(client, {
    tokenAddresses: [item.tokenAddress],
  });

  if (!hasResolvedDecimals(metadata)) {
    await markTokenMetadataRefreshFailed(client, item.queueKey, new Error('Token metadata still missing decimals after tiered resolution.'), {
      metadata_source: metadata.source,
      token_address: item.tokenAddress,
    });

    return {
      deferred: 1,
      failed: 0,
      recalculatedTransfers: transferSummary.updatedTransfers,
      rebuiltCandles: 0,
      repricedTrades: 0,
      resolved: 0,
    };
  }

  let repricedTrades = 0;
  let rebuiltCandles = 0;

  if (didResolveDecimals(previous, metadata)) {
    const tradeSummary = await repricePendingEnrichmentTrades(client, {
      tokenAddresses: [item.tokenAddress],
    });
    const candleSummary = await rebuildPendingEnrichmentCandles(client, {
      tokenAddresses: [item.tokenAddress],
    });

    repricedTrades = tradeSummary.repricedTrades;
    rebuiltCandles = candleSummary.rebuiltCandles;
  }

  await markTokenMetadataRefreshProcessed(client, item.queueKey, {
    decimals_source: metadata.metadata?.decimals_source ?? metadata.source,
    metadata_source: metadata.source,
    recalculated_transfers: transferSummary.updatedTransfers,
    repriced_trades: repricedTrades,
    resolved_decimals: true,
    token_address: item.tokenAddress,
  });

  return {
    deferred: 0,
    failed: 0,
    recalculatedTransfers: transferSummary.updatedTransfers,
    rebuiltCandles,
    repricedTrades,
    resolved: 1,
  };
}

async function recalculateTransfersForTokens(client, { tokenAddresses }) {
  const normalizedTokenAddresses = Array.from(new Set((tokenAddresses ?? []).filter(Boolean)));
  if (normalizedTokenAddresses.length === 0) {
    return {
      updatedTransfers: 0,
    };
  }

  const result = await client.query(
    `UPDATE stark_transfers AS transfer
        SET token_symbol = COALESCE(registry.symbol, transfer.token_symbol),
            token_name = COALESCE(registry.name, transfer.token_name),
            token_decimals = CASE
                WHEN registry.decimals IS NULL THEN NULL
                ELSE registry.decimals::NUMERIC
            END,
            amount_human = CASE
                WHEN registry.decimals IS NULL THEN NULL
                ELSE transfer.amount::NUMERIC / power(
                    10::NUMERIC,
                    GREATEST(registry.decimals::INTEGER, 0)
                )
            END,
            metadata = COALESCE(transfer.metadata, '{}'::jsonb) || jsonb_build_object(
                'decimal_resolution_state',
                CASE
                    WHEN registry.decimals IS NULL THEN 'pending_metadata'
                    ELSE 'resolved'
                END,
                'metadata_sync_source',
                COALESCE(registry.verification_source, 'tokens')
            ),
            updated_at = NOW()
       FROM tokens AS registry
      WHERE transfer.token_address = registry.address
        AND transfer.token_address = ANY($1::text[])
        AND (
             transfer.token_decimals IS DISTINCT FROM registry.decimals::NUMERIC
          OR transfer.amount_human IS NULL
          OR transfer.token_symbol IS NULL
          OR transfer.token_name IS NULL
        )`,
    [normalizedTokenAddresses],
  );

  return {
    updatedTransfers: result.rowCount,
  };
}

async function enrichPendingTransfers(client, rpcClient, {
  limit,
  routeMatchJitterBps = DEFAULT_TRANSFER_ROUTE_MATCH_JITTER_BPS,
}) {
  const transactions = await loadTransferEnrichmentTransactions(client, { limit });
  let updatedTransfers = 0;

  for (const transaction of transactions) {
    if (shuttingDown) {
      break;
    }

    try {
      updatedTransfers += await enrichTransfersForTransaction(client, rpcClient, transaction, {
        routeMatchJitterBps,
      });
    } catch (error) {
      console.error(
        `[phase4] metadata-syncer transfer enrichment failed tx=${transaction.transactionHash}: ${formatError(error)}`,
      );
    }
  }

  return {
    updatedTransfers,
  };
}

async function loadTransferEnrichmentTransactions(client, { limit }) {
  const result = await client.query(
    `SELECT transfer.lane,
            transfer.transaction_hash,
            MIN(transfer.block_number) AS block_number
       FROM stark_transfers AS transfer
      WHERE (
               transfer.counterparty_type = 'unknown'
            OR COALESCE(transfer.transfer_type, 'standard_transfer') = 'standard_transfer'
            OR transfer.token_decimals IS NULL
            OR transfer.amount_human IS NULL
            )
        AND EXISTS (
             SELECT 1
               FROM stark_action_norm AS action
              WHERE action.lane = transfer.lane
                AND action.transaction_hash = transfer.transaction_hash
                AND action.action_type = 'swap'
        )
      GROUP BY transfer.lane, transfer.transaction_hash
      ORDER BY MIN(transfer.block_number) ASC, transfer.transaction_hash ASC
      LIMIT $1`,
    [limit],
  );

  return result.rows.map((row) => ({
    blockNumber: toBigIntStrict(row.block_number, 'transfer enrichment block number'),
    lane: row.lane,
    transactionHash: row.transaction_hash,
  }));
}

async function enrichTransfersForTransaction(client, rpcClient, { lane, transactionHash }, {
  routeMatchJitterBps = DEFAULT_TRANSFER_ROUTE_MATCH_JITTER_BPS,
}) {
  const [transfers, trades] = await Promise.all([
    loadTransfersForTransaction(client, { lane, transactionHash }),
    loadTradesForTransaction(client, { lane, transactionHash }),
  ]);

  if (transfers.length === 0 || trades.length === 0) {
    return 0;
  }

  const addressRoles = await resolveAddressRoles(rpcClient, transfers, trades);
  let updatedTransfers = 0;

  for (const transfer of transfers) {
    const routeGroupKeys = matchTransferRouteGroups(transfer, trades, addressRoles, {
      maxJitterBps: routeMatchJitterBps,
    });
    const nextTransferType = routeGroupKeys.length > 0
      ? 'routing_transfer'
      : (transfer.transferType ?? 'standard_transfer');
    const nextCounterpartyType = resolveCounterpartyType(transfer, addressRoles);
    const nextIsInternal = isInternalTransfer({
      counterpartyType: nextCounterpartyType,
      transferType: nextTransferType,
    });

    if (
      nextTransferType === (transfer.transferType ?? 'standard_transfer') &&
      nextCounterpartyType === transfer.counterpartyType &&
      nextIsInternal === transfer.isInternal
    ) {
      continue;
    }

    await client.query(
      `UPDATE stark_transfers
          SET transfer_type = $2,
              counterparty_type = $3,
              is_internal = $4,
              metadata = COALESCE(metadata, '{}'::jsonb) || $5::jsonb,
              updated_at = NOW()
        WHERE transfer_key = $1`,
      [
        transfer.transferKey,
        nextTransferType,
        nextCounterpartyType,
        nextIsInternal,
        JSON.stringify({
          route_group_keys: routeGroupKeys,
          transfer_match_jitter_bps: routeMatchJitterBps.toString(10),
          transfer_enrichment_reason: routeGroupKeys.length > 0 ? 'route_group_match' : 'counterparty_classification',
          transfer_enrichment_version: 'metadata_syncer_v2',
        }),
      ],
    );

    updatedTransfers += 1;
  }

  return updatedTransfers;
}

async function loadTransfersForTransaction(client, { lane, transactionHash }) {
  const result = await client.query(
    `SELECT transfer_key,
            token_address,
            from_address,
            to_address,
            amount,
            transfer_type,
            is_internal,
            counterparty_type,
            metadata
       FROM stark_transfers
      WHERE lane = $1
        AND transaction_hash = $2
      ORDER BY source_event_index ASC`,
    [lane, transactionHash],
  );

  return result.rows.map((row) => ({
    amount: toBigIntStrict(row.amount, 'transfer enrichment amount'),
    counterpartyType: row.counterparty_type ?? 'unknown',
    fromAddress: row.from_address,
    metadata: row.metadata ?? {},
    toAddress: row.to_address,
    tokenAddress: row.token_address,
    transferKey: row.transfer_key,
    transferType: row.transfer_type ?? 'standard_transfer',
    isInternal: Boolean(row.is_internal),
  }));
}

async function loadTradesForTransaction(client, { lane, transactionHash }) {
  const result = await client.query(
    `SELECT token_in_address,
            token_out_address,
            amount_in,
            amount_out,
            route_group_key,
            is_multi_hop,
            trader_address,
            locker_address
       FROM stark_trades
      WHERE lane = $1
        AND transaction_hash = $2
      ORDER BY transaction_index ASC, source_event_index ASC`,
    [lane, transactionHash],
  );

  return result.rows.map((row) => ({
    amountIn: toBigIntStrict(row.amount_in, 'transfer enrichment trade amount in'),
    amountOut: toBigIntStrict(row.amount_out, 'transfer enrichment trade amount out'),
    isMultiHop: Boolean(row.is_multi_hop),
    lockerAddress: row.locker_address ?? null,
    routeGroupKey: row.route_group_key ?? null,
    tokenInAddress: row.token_in_address,
    tokenOutAddress: row.token_out_address,
    traderAddress: row.trader_address ?? null,
  }));
}

async function resolveAddressRoles(rpcClient, transfers, trades) {
  const inbound = new Set();
  const outbound = new Set();

  for (const transfer of transfers) {
    inbound.add(transfer.toAddress);
    outbound.add(transfer.fromAddress);
  }

  const chainedAddresses = Array.from(inbound).filter((address) => outbound.has(address));
  const routerEvidence = new Set(trades.map((trade) => trade.lockerAddress).filter(Boolean));
  const roles = new Map();

  for (const address of chainedAddresses) {
    const hasContractCode = await hasContractCodeAtAddress(rpcClient, address);
    if (!hasContractCode) {
      continue;
    }

    roles.set(address, routerEvidence.has(address) ? 'router' : 'contract');
  }

  return roles;
}

async function hasContractCodeAtAddress(rpcClient, address) {
  return contractPresenceCache.getOrLoad(address, async () => {
    try {
      const classHash = await rpcClient.getClassHashAt('latest', address);
      return Boolean(classHash && !/^0x0+$/i.test(String(classHash)));
    } catch (error) {
      return false;
    }
  });
}

function matchTransferRouteGroups(transfer, trades, addressRoles, { maxJitterBps = DEFAULT_TRANSFER_ROUTE_MATCH_JITTER_BPS } = {}) {
  const routeGroupKeys = new Set();

  for (const trade of trades) {
    if (!trade.routeGroupKey || !trade.isMultiHop) {
      continue;
    }

    const tokenInMatch = trade.tokenInAddress === transfer.tokenAddress
      && amountsMatchWithinJitter(transfer.amount, trade.amountIn, maxJitterBps);
    const tokenOutMatch = trade.tokenOutAddress === transfer.tokenAddress
      && amountsMatchWithinJitter(transfer.amount, trade.amountOut, maxJitterBps);
    if (!tokenInMatch && !tokenOutMatch) {
      continue;
    }

    const touchesTrader = transfer.fromAddress === trade.traderAddress || transfer.toAddress === trade.traderAddress;
    const touchesIntermediary = addressRoles.has(transfer.fromAddress) || addressRoles.has(transfer.toAddress);
    const touchesLocker = trade.lockerAddress && (transfer.fromAddress === trade.lockerAddress || transfer.toAddress === trade.lockerAddress);

    if (touchesTrader || touchesIntermediary || touchesLocker) {
      routeGroupKeys.add(trade.routeGroupKey);
    }
  }

  return Array.from(routeGroupKeys);
}

function amountsMatchWithinJitter(leftAmount, rightAmount, maxJitterBps) {
  const left = toBigIntStrict(leftAmount, 'transfer route match left amount');
  const right = toBigIntStrict(rightAmount, 'transfer route match right amount');
  if (left <= 0n || right <= 0n) {
    return false;
  }

  const diff = absBigInt(left - right);
  const reference = left > right ? left : right;
  return diff * 10_000n <= reference * maxJitterBps;
}

function resolveCounterpartyType(transfer, addressRoles) {
  const endpointRoles = [
    addressRoles.get(transfer.fromAddress) ?? null,
    addressRoles.get(transfer.toAddress) ?? null,
  ].filter(Boolean);

  if (endpointRoles.includes('router')) {
    return 'router';
  }

  if (endpointRoles.includes('contract')) {
    return 'contract';
  }

  return transfer.counterpartyType ?? 'unknown';
}

function isInternalTransfer({ counterpartyType, transferType }) {
  if (transferType === 'routing_transfer') {
    return true;
  }

  return ['router', 'contract'].includes(counterpartyType);
}

async function safeGetLatestBlockNumber(rpcClient) {
  try {
    return await rpcClient.getBlockNumber();
  } catch (error) {
    return null;
  }
}

function parsePositiveInteger(value, fallbackValue) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallbackValue;
  }

  const parsed = Number.parseInt(String(value).trim(), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallbackValue;
  }

  return parsed;
}

function parseJitterBps(value, fallbackValue) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallbackValue;
  }

  try {
    const parsed = BigInt(String(value).trim());
    if (parsed <= 0n) {
      return fallbackValue;
    }

    return parsed;
  } catch (error) {
    return fallbackValue;
  }
}

function parseBoolean(value, fallbackValue) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallbackValue;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function formatError(error) {
  if (!error) {
    return 'unknown error';
  }

  return error.stack || error.message || String(error);
}

function installSignalHandlers() {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      shuttingDown = true;
      console.log(`[phase4] metadata-syncer received ${signal}, stopping after current batch.`);
    });
  }
}

if (require.main === module) {
  main().catch(async (error) => {
    console.error(`[phase4] metadata-syncer fatal error: ${formatError(error)}`);
    try {
      await closePool();
    } finally {
      process.exitCode = 1;
    }
  });
}

module.exports = {
  amountsMatchWithinJitter,
  enrichPendingTransfers,
  matchTransferRouteGroups,
  processMetadataSyncBatch,
};
