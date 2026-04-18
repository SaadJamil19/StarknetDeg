#!/usr/bin/env node
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { setTimeout: sleep } = require('node:timers/promises');
const {
  assertFoundationTables,
  assertPhase2Tables,
  assertPhase3Tables,
  assertPoolTaxonomyTables,
} = require('../core/checkpoint');
const {
  collectMissingPoolTaxonomyRows,
  countAggregatorLeaks,
  countClmmTradeJoins,
  countPoolFamilyNulls,
  loadUnresolvedPoolRegistryEntries,
  resolvePoolTaxonomy,
  seedPoolRegistryCandidatesFromHistory,
  syncPoolTaxonomyToStateTables,
  upsertPoolRegistryEntry,
} = require('../core/pool-discovery');
const { closePool, withClient, withTransaction } = require('../lib/db');
const { StarknetRpcClient } = require('../lib/starknet-rpc');

let shuttingDown = false;

async function main() {
  const rpcClient = new StarknetRpcClient();
  const batchSize = parsePositiveInteger(process.env.POOL_TAXONOMY_BATCH_SIZE, 100);
  const pollIntervalMs = parsePositiveInteger(process.env.POOL_TAXONOMY_INTERVAL_MS, 15_000);
  const seedLimit = parsePositiveInteger(process.env.POOL_TAXONOMY_SEED_LIMIT, 250);
  const runOnce = parseBoolean(process.env.POOL_TAXONOMY_RUN_ONCE, false);

  installSignalHandlers();

  await withClient(async (client) => {
    await assertFoundationTables(client);
    await assertPhase2Tables(client);
    await assertPhase3Tables(client);
    await assertPoolTaxonomyTables(client);
  });

  console.log(
    `[phase4] pool-taxonomy starting batch_size=${batchSize} seed_limit=${seedLimit} run_once=${runOnce}`,
  );

  do {
    try {
      const summary = await processPoolTaxonomyBatch({
        batchSize,
        rpcClient,
        seedLimit,
      });

      console.log(
        `[phase4] pool-taxonomy seeded=${summary.seeded} scanned=${summary.scanned} resolved=${summary.resolved} candidate_only=${summary.candidateOnly} failed=${summary.failed} sync_history=${summary.updatedHistoryRows} sync_latest=${summary.updatedLatestRows} null_latest=${summary.nullCounts.latestNullRows} null_history=${summary.nullCounts.historyNullRows} aggregator_leaks=${summary.aggregatorLeaks} clmm_trade_rows=${summary.clmmTradeRows}`,
      );

      if (summary.missingRows.length > 0) {
        const sample = summary.missingRows
          .map((row) => `${row.scope}:${row.pool_id}:${row.protocol ?? 'unknown'}:${row.emitter_address ?? 'no_emitter'}`)
          .join(', ');
        console.warn(`[phase4] pool-taxonomy unresolved sample=${sample}`);
      }
    } catch (error) {
      console.error(`[phase4] pool-taxonomy error: ${formatError(error)}`);
    }

    if (runOnce || shuttingDown) {
      break;
    }

    await sleep(pollIntervalMs);
  } while (!shuttingDown);

  await closePool();
}

async function processPoolTaxonomyBatch({ batchSize, rpcClient, seedLimit }) {
  const seeded = await withTransaction((client) => seedPoolRegistryCandidatesFromHistory(client, {
    limit: seedLimit,
  }));
  const unresolved = await withClient((client) => loadUnresolvedPoolRegistryEntries(client, {
    limit: batchSize,
  }));

  const touchedPoolKeys = new Set();
  let candidateOnly = 0;
  let failed = 0;
  let resolved = 0;

  for (const entry of unresolved) {
    if (shuttingDown) {
      break;
    }

    try {
      const nextEntry = await resolvePoolTaxonomy(entry, { rpcClient });
      if (!nextEntry) {
        candidateOnly += 1;
        continue;
      }

      await withTransaction((client) => upsertPoolRegistryEntry(client, nextEntry));
      touchedPoolKeys.add(nextEntry.poolKey);

      if (nextEntry.poolFamily && nextEntry.poolModel) {
        resolved += 1;
      } else {
        candidateOnly += 1;
      }
    } catch (error) {
      failed += 1;
      console.error(`[phase4] pool-taxonomy resolve failed pool_key=${entry.poolKey}: ${formatError(error)}`);
    }
  }

  const syncSummary = await withTransaction((client) => syncPoolTaxonomyToStateTables(client, {
    poolKeys: Array.from(touchedPoolKeys),
  }));

  const validation = await withClient(async (client) => {
    const nullCounts = await countPoolFamilyNulls(client);
    return {
      aggregatorLeaks: await countAggregatorLeaks(client),
      clmmTradeRows: await countClmmTradeJoins(client),
      missingRows: (nullCounts.latestNullRows > 0 || nullCounts.historyNullRows > 0)
        ? await collectMissingPoolTaxonomyRows(client, { limit: 10 })
        : [],
      nullCounts,
    };
  });

  return {
    aggregatorLeaks: validation.aggregatorLeaks,
    candidateOnly,
    clmmTradeRows: validation.clmmTradeRows,
    failed,
    missingRows: validation.missingRows,
    nullCounts: validation.nullCounts,
    resolved,
    scanned: unresolved.length,
    seeded,
    updatedHistoryRows: syncSummary.updatedHistoryRows,
    updatedLatestRows: syncSummary.updatedLatestRows,
  };
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
      console.log(`[phase4] pool-taxonomy received ${signal}, stopping after current pass.`);
    });
  }
}

main().catch(async (error) => {
  console.error(`[phase4] pool-taxonomy fatal error: ${formatError(error)}`);

  try {
    await closePool();
  } finally {
    process.exitCode = 1;
  }
});
