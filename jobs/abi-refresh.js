#!/usr/bin/env node
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { setTimeout: sleep } = require('node:timers/promises');
const { getStaticMatchesByAddress, getSyncableEntries } = require('../lib/registry/dex-registry');
const { normalizeAbiPayload } = require('../lib/starknet-contract');
const { assertFoundationTables, assertPhase2Tables, assertPhase3Tables, assertPhase4Tables } = require('../core/checkpoint');
const { normalizeAddress, normalizeHex } = require('../core/normalize');
const { closePool, withClient } = require('../lib/db');
const { StarknetRpcClient } = require('../lib/starknet-rpc');
const { toNumericString } = require('../lib/cairo/bigint');

const knownRegistryAddresses = new Set(getSyncableEntries().map((entry) => entry.contractAddress));
let shuttingDown = false;

async function main() {
  const rpcClient = new StarknetRpcClient();
  const lookbackBlocks = parsePositiveInteger(process.env.PHASE4_ABI_REFRESH_LOOKBACK_BLOCKS, 2_000);
  const pollIntervalMs = parsePositiveInteger(process.env.PHASE4_ABI_REFRESH_INTERVAL_MS, 120_000);
  const runOnce = parseBoolean(process.env.PHASE4_ABI_REFRESH_RUN_ONCE, false);

  installSignalHandlers();

  await withClient(async (client) => {
    await assertFoundationTables(client);
    await assertPhase2Tables(client);
    await assertPhase3Tables(client);
    await assertPhase4Tables(client);
  });

  console.log(`[phase4] abi-refresh starting lookback_blocks=${lookbackBlocks} run_once=${runOnce}`);

  do {
    try {
      const summary = await refreshRegistryAbis({ lookbackBlocks, rpcClient });
      console.log(
        `[phase4] abi-refresh scanned_blocks=${summary.scannedBlocks} detected_changes=${summary.detectedChanges} refreshed=${summary.refreshed}`,
      );
    } catch (error) {
      console.error(`[phase4] abi-refresh error: ${formatError(error)}`);
    }

    if (runOnce || shuttingDown) {
      break;
    }

    await sleep(pollIntervalMs);
  } while (!shuttingDown);

  await closePool();
}

async function refreshRegistryAbis({ lookbackBlocks, rpcClient }) {
  return withClient(async (client) => {
    const rows = await loadRecentStateUpdates(client, lookbackBlocks);
    let detectedChanges = 0;
    let refreshed = 0;

    for (const row of rows) {
      if (shuttingDown) {
        break;
      }

      const changes = extractRegistryChanges(row);
      detectedChanges += changes.length;

      for (const change of changes) {
        const updated = await applyRegistryChange(client, rpcClient, change);
        if (updated) {
          refreshed += 1;
        }
      }
    }

    return {
      detectedChanges,
      refreshed,
      scannedBlocks: rows.length,
    };
  });
}

async function loadRecentStateUpdates(client, lookbackBlocks) {
  const result = await client.query(
    `SELECT lane,
            block_number,
            block_hash,
            deployed_contracts,
            replaced_classes
       FROM stark_block_state_updates
      WHERE lane = 'ACCEPTED_ON_L2'
      ORDER BY block_number DESC
      LIMIT $1`,
    [lookbackBlocks],
  );

  return result.rows.reverse();
}

function extractRegistryChanges(row) {
  const changes = [];

  for (const item of normalizeStateUpdateArray(row.replaced_classes)) {
    const contractAddress = normalizeOptionalAddress(item.contract_address ?? item.address ?? item.contractAddress);
    const classHash = normalizeOptionalHex(item.class_hash ?? item.classHash);

    if (!contractAddress || !classHash || !knownRegistryAddresses.has(contractAddress)) {
      continue;
    }

    changes.push({
      blockHash: row.block_hash,
      blockNumber: BigInt(row.block_number),
      changeKind: 'replaced_class',
      classHash,
      contractAddress,
    });
  }

  for (const item of normalizeStateUpdateArray(row.deployed_contracts)) {
    const contractAddress = normalizeOptionalAddress(item.address ?? item.contract_address ?? item.contractAddress);
    const classHash = normalizeOptionalHex(item.class_hash ?? item.classHash);

    if (!contractAddress || !classHash || !knownRegistryAddresses.has(contractAddress)) {
      continue;
    }

    changes.push({
      blockHash: row.block_hash,
      blockNumber: BigInt(row.block_number),
      changeKind: 'deployed_contract',
      classHash,
      contractAddress,
    });
  }

  return changes;
}

async function applyRegistryChange(client, rpcClient, change) {
  const seed = await loadRegistrySeed(client, change.contractAddress);
  if (!seed) {
    return false;
  }

  const existing = await client.query(
    `SELECT class_hash, abi_refreshed_at_block
       FROM stark_contract_registry
      WHERE contract_address = $1
        AND is_active = TRUE
      ORDER BY updated_at DESC
      LIMIT 1`,
    [change.contractAddress],
  );

  const current = existing.rows[0] ?? null;
  const currentClassHash = normalizeOptionalHex(current?.class_hash);
  const currentRefreshedBlock = current?.abi_refreshed_at_block === null || current?.abi_refreshed_at_block === undefined
    ? null
    : BigInt(current.abi_refreshed_at_block);

  if (currentClassHash === change.classHash && currentRefreshedBlock !== null && currentRefreshedBlock >= change.blockNumber) {
    return false;
  }

  let abiJson = null;
  try {
    const classDefinition = await rpcClient.getClassAt(change.blockNumber, change.contractAddress);
    abiJson = normalizeAbiPayload(classDefinition);
  } catch (error) {
    abiJson = null;
  }

  await client.query(
    `UPDATE stark_contract_registry
        SET valid_to_block = $2 - 1,
            is_active = FALSE,
            updated_at = NOW()
      WHERE contract_address = $1
        AND is_active = TRUE
        AND (class_hash IS DISTINCT FROM $3)
        AND (valid_to_block IS NULL OR valid_to_block >= $2)`,
    [
      change.contractAddress,
      toNumericString(change.blockNumber, 'abi refresh block number'),
      change.classHash,
    ],
  );

  const metadata = {
    ...(seed.metadata ?? {}),
    abi_refresh: {
      block_hash: change.blockHash,
      change_kind: change.changeKind,
      refreshed_at: new Date().toISOString(),
    },
  };

  await client.query(
    `INSERT INTO stark_contract_registry (
         contract_address,
         class_hash,
         protocol,
         role,
         decoder,
         abi_version,
         valid_from_block,
         valid_to_block,
         metadata,
         is_active,
         abi_json,
         abi_refreshed_at,
         abi_refreshed_at_block,
         created_at,
         updated_at
     ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, NULL, $8::jsonb, TRUE, $9::jsonb, NOW(), $10, NOW(), NOW()
     )
     ON CONFLICT (contract_address, class_hash)
     DO UPDATE SET
         protocol = EXCLUDED.protocol,
         role = EXCLUDED.role,
         decoder = EXCLUDED.decoder,
         abi_version = EXCLUDED.abi_version,
         valid_from_block = COALESCE(stark_contract_registry.valid_from_block, EXCLUDED.valid_from_block),
         valid_to_block = NULL,
         metadata = EXCLUDED.metadata,
         is_active = TRUE,
         abi_json = COALESCE(EXCLUDED.abi_json, stark_contract_registry.abi_json),
         abi_refreshed_at = NOW(),
         abi_refreshed_at_block = EXCLUDED.abi_refreshed_at_block,
         updated_at = NOW()`,
    [
      change.contractAddress,
      change.classHash,
      seed.protocol,
      seed.role,
      seed.decoder,
      seed.abiVersion ?? `auto:${change.blockNumber.toString(10)}`,
      toNumericString(change.blockNumber, 'abi valid from block'),
      JSON.stringify(metadata),
      JSON.stringify(abiJson),
      toNumericString(change.blockNumber, 'abi refreshed at block'),
    ],
  );

  return true;
}

async function loadRegistrySeed(client, contractAddress) {
  const staticSeed = getStaticMatchesByAddress(contractAddress)[0];
  if (staticSeed) {
    return {
      abiVersion: staticSeed.abiVersion,
      decoder: staticSeed.decoder,
      metadata: {
        ...(staticSeed.metadata ?? {}),
        display_name: staticSeed.displayName ?? null,
        family: staticSeed.family ?? null,
      },
      protocol: staticSeed.protocol,
      role: staticSeed.role,
    };
  }

  const result = await client.query(
    `SELECT protocol, role, decoder, abi_version, metadata
       FROM stark_contract_registry
      WHERE contract_address = $1
      ORDER BY updated_at DESC
      LIMIT 1`,
    [contractAddress],
  );

  if (result.rowCount === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    abiVersion: row.abi_version ?? null,
    decoder: row.decoder,
    metadata: row.metadata ?? {},
    protocol: row.protocol,
    role: row.role,
  };
}

function normalizeStateUpdateArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeOptionalAddress(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  return normalizeAddress(value, 'registry change address');
}

function normalizeOptionalHex(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  return normalizeHex(value, { label: 'registry change class hash', padToBytes: 32 });
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
      console.log(`[phase4] abi-refresh received ${signal}, stopping after current batch.`);
    });
  }
}

main().catch(async (error) => {
  console.error(`[phase4] abi-refresh fatal error: ${formatError(error)}`);
  try {
    await closePool();
  } finally {
    process.exitCode = 1;
  }
});
