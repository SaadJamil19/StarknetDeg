#!/usr/bin/env node
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { setTimeout: sleep } = require('node:timers/promises');
const {
  applyTradeChainAnnotations,
  buildTradeChainAnnotations,
  claimTradeChainQueueItems,
  loadTradesForTransaction,
  markTradeChainQueueFailed,
  markTradeChainQueueProcessed,
} = require('../core/post-processor');
const {
  assertFoundationTables,
  assertPhase2Tables,
  assertPhase3Tables,
  assertPoolTaxonomyTables,
  assertTradeChainingTables,
} = require('../core/checkpoint');
const { loadPoolRegistryByPoolKeys } = require('../core/pool-discovery');
const { closePool, withClient, withTransaction } = require('../lib/db');

let shuttingDown = false;

async function main() {
  const batchSize = parsePositiveInteger(process.env.TRADE_CHAINING_BATCH_SIZE, 100);
  const pollIntervalMs = parsePositiveInteger(process.env.TRADE_CHAINING_POLL_INTERVAL_MS, 5_000);
  const runOnce = parseBoolean(process.env.TRADE_CHAINING_RUN_ONCE, false);
  const stuckAfterMs = parsePositiveInteger(process.env.TRADE_CHAINING_STUCK_AFTER_MS, 60_000);
  const maxJitterBps = parsePositiveInteger(process.env.TRADE_CHAINING_MAX_JITTER_BPS, 1);

  installSignalHandlers();

  await withClient(async (client) => {
    await assertFoundationTables(client);
    await assertPhase2Tables(client);
    await assertPhase3Tables(client);
    await assertPoolTaxonomyTables(client);
    await assertTradeChainingTables(client);
  });

  console.log(
    `[phase3] trade-chaining starting batch_size=${batchSize} run_once=${runOnce} max_jitter_bps=${maxJitterBps}`,
  );

  do {
    try {
      const queueItems = await withTransaction((client) => claimTradeChainQueueItems(client, {
        limit: batchSize,
        stuckAfterMs,
      }));

      if (queueItems.length === 0) {
        console.log('[phase3] trade-chaining claimed=0 processed=0 chains=0 linked_rows=0');
        if (runOnce) {
          break;
        }
        await sleep(pollIntervalMs);
        continue;
      }

      let processed = 0;
      let chainsDetected = 0;
      let linkedRows = 0;

      for (const item of queueItems) {
        try {
          await withTransaction(async (client) => {
            const trades = await loadTradesForTransaction(client, {
              lane: item.lane,
              transactionHash: item.transactionHash,
            });
            const poolRegistryByPoolKey = await loadRegistryForTradePools(client, item, trades);

            const { annotations, summary } = buildTradeChainAnnotations(trades, {
              maxJitterBps,
            });
            const enrichedAnnotations = attachPoolTaxonomyToAnnotations(annotations, trades, poolRegistryByPoolKey);
            const poolTaxonomy = buildPoolTaxonomySummary(item, trades, poolRegistryByPoolKey);

            await applyTradeChainAnnotations(client, {
              lane: item.lane,
              transactionHash: item.transactionHash,
              annotations: enrichedAnnotations,
            });
            await markTradeChainQueueProcessed(client, item.queueKey, {
              chains_detected: summary.chainsDetected,
              linked_rows: summary.linkedRows,
              max_chain_length: summary.maxChainLength,
              pool_taxonomy: poolTaxonomy,
              scan_mode: 'value_flow_late_binding',
              transactions_scanned: summary.transactionsScanned,
            });

            chainsDetected += summary.chainsDetected;
            linkedRows += summary.linkedRows;
          });

          processed += 1;
        } catch (error) {
          await withTransaction((client) => markTradeChainQueueFailed(client, item.queueKey, error));
          console.error(`[phase3] trade-chaining failed tx=${item.transactionHash}: ${formatError(error)}`);
        }
      }

      console.log(
        `[phase3] trade-chaining claimed=${queueItems.length} processed=${processed} chains=${chainsDetected} linked_rows=${linkedRows}`,
      );

      if (runOnce) {
        break;
      }
    } catch (error) {
      console.error(`[phase3] trade-chaining error: ${formatError(error)}`);
      if (runOnce) {
        throw error;
      }
      await sleep(pollIntervalMs);
    }
  } while (!shuttingDown);

  await closePool();
}

async function loadRegistryForTradePools(client, item, trades) {
  const poolKeys = collectPoolKeys(item, trades);
  if (poolKeys.length === 0) {
    return new Map();
  }

  return loadPoolRegistryByPoolKeys(client, poolKeys);
}

function collectPoolKeys(item, trades) {
  const poolKeys = new Set();

  for (const poolId of item.metadata?.pool_ids ?? []) {
    if (poolId) {
      poolKeys.add(String(poolId));
    }
  }

  for (const trade of trades ?? []) {
    if (trade.poolId) {
      poolKeys.add(String(trade.poolId));
    }
  }

  return Array.from(poolKeys).sort();
}

function buildPoolTaxonomySummary(item, trades, registryByPoolKey) {
  const poolKeys = collectPoolKeys(item, trades);
  if (poolKeys.length === 0) {
    return {
      confidenceLevels: [],
      families: [],
      models: [],
      poolKeys: [],
      protocols: [],
      unresolvedPoolKeys: [],
    };
  }

  const protocols = new Set();
  const families = new Set();
  const models = new Set();
  const confidenceLevels = new Set();
  const unresolvedPoolKeys = [];

  for (const poolKey of poolKeys) {
    const entry = registryByPoolKey.get(poolKey) ?? null;
    if (!entry) {
      unresolvedPoolKeys.push(poolKey);
      continue;
    }

    if (entry.protocol) {
      protocols.add(entry.protocol);
    }
    if (entry.poolFamily) {
      families.add(entry.poolFamily);
    }
    if (entry.poolModel) {
      models.add(entry.poolModel);
    }
    if (entry.confidenceLevel) {
      confidenceLevels.add(entry.confidenceLevel);
    }
    if (!entry.poolFamily || !entry.poolModel) {
      unresolvedPoolKeys.push(poolKey);
    }
  }

  return {
    confidenceLevels: Array.from(confidenceLevels).sort(),
    families: Array.from(families).sort(),
    models: Array.from(models).sort(),
    poolKeys,
    protocols: Array.from(protocols).sort(),
    unresolvedPoolKeys: Array.from(new Set(unresolvedPoolKeys)).sort(),
  };
}

function attachPoolTaxonomyToAnnotations(annotations, trades, registryByPoolKey) {
  const tradeBySourceEventIndex = new Map(
    (trades ?? []).map((trade) => [trade.sourceEventIndex.toString(10), trade]),
  );

  return (annotations ?? []).map((annotation) => {
    const trade = tradeBySourceEventIndex.get(annotation.sourceEventIndex.toString(10));
    if (!trade) {
      return annotation;
    }

    const registryEntry = trade.poolId ? registryByPoolKey.get(String(trade.poolId)) ?? null : null;
    const poolMetadata = buildPoolMetadataPatch(trade, registryEntry);
    if (!poolMetadata) {
      return annotation;
    }

    return {
      ...annotation,
      metadata: {
        ...(annotation.metadata ?? {}),
        ...poolMetadata,
      },
    };
  });
}

function buildPoolMetadataPatch(trade, registryEntry) {
  const metadata = {};
  const poolProtocol = registryEntry?.protocol ?? trade.protocol ?? null;
  const poolFamily = registryEntry?.poolFamily ?? null;
  const poolModel = registryEntry?.poolModel ?? trade.metadata?.pool_model ?? null;
  const poolConfidenceLevel = registryEntry?.confidenceLevel ?? null;

  if (poolProtocol) {
    metadata.pool_protocol = poolProtocol;
  }
  if (poolFamily) {
    metadata.pool_family = poolFamily;
  }
  if (poolModel) {
    metadata.pool_model = poolModel;
  }
  if (poolConfidenceLevel) {
    metadata.pool_confidence_level = poolConfidenceLevel;
  }

  return Object.keys(metadata).length > 0 ? metadata : null;
}

function parsePositiveInteger(value, fallbackValue) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallbackValue;
  }

  const parsed = Number.parseInt(String(value).trim(), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer but received: ${value}`);
  }

  return parsed;
}

function parseBoolean(value, fallbackValue) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallbackValue;
  }

  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }

  throw new Error(`Expected a boolean but received: ${value}`);
}

function formatError(error) {
  if (!error) {
    return 'unknown error';
  }

  if (error.stack) {
    return error.stack;
  }

  return String(error.message || error);
}

function installSignalHandlers() {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      shuttingDown = true;
      console.log(`[phase3] trade-chaining received ${signal}, stopping after current pass.`);
    });
  }
}

main().catch(async (error) => {
  console.error(`[phase3] trade-chaining fatal error: ${formatError(error)}`);

  try {
    await closePool();
  } catch (closeError) {
    console.error(`[phase3] trade-chaining shutdown error: ${formatError(closeError)}`);
  }

  process.exitCode = 1;
});
