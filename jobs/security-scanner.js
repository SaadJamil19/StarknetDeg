#!/usr/bin/env node
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { setTimeout: sleep } = require('node:timers/promises');
const { hash } = require('starknet');
const { getSyncableEntries } = require('../lib/registry/dex-registry');
const { createTtlCache } = require('../lib/cache');
const { collectAbiNames, normalizeAbiPayload } = require('../lib/starknet-contract');
const { assertFoundationTables, assertPhase2Tables, assertPhase3Tables, assertPhase4Tables } = require('../core/checkpoint');
const { normalizeAddress, normalizeHex } = require('../core/normalize');
const { toJsonbString } = require('../core/protocols/shared');
const { closePool, withClient } = require('../lib/db');
const { StarknetRpcClient } = require('../lib/starknet-rpc');

const OWNER_ENTRYPOINTS = ['owner', 'get_owner', 'admin', 'get_admin'];
const STANDARD_PROXY_SLOT_SPECS = Object.freeze([
  {
    classification: 'Upgradeable Proxy',
    label: '_implementation',
    slotKey: normalizeHex(hash.getSelectorFromName('_implementation'), { label: '_implementation slot', padToBytes: 32 }),
  },
  {
    classification: 'Upgradeable Proxy',
    label: 'Starknet_Proxy_Implementation',
    slotKey: normalizeHex(hash.getSelectorFromName('Starknet_Proxy_Implementation'), { label: 'Starknet_Proxy_Implementation slot', padToBytes: 32 }),
  },
  {
    classification: 'Upgradeable Proxy',
    label: 'starknet_proxy_implementation',
    slotKey: normalizeHex(hash.getSelectorFromName('starknet_proxy_implementation'), { label: 'starknet_proxy_implementation slot', padToBytes: 32 }),
  },
]);
const classCache = createTtlCache({ defaultTtlMs: 300_000, maxEntries: 10_000 });

let shuttingDown = false;

async function main() {
  const rpcClient = new StarknetRpcClient();
  const batchSize = parsePositiveInteger(process.env.PHASE4_SECURITY_SCAN_BATCH_SIZE, 100);
  const pollIntervalMs = parsePositiveInteger(process.env.PHASE4_SECURITY_SCAN_INTERVAL_MS, 180_000);
  const runOnce = parseBoolean(process.env.PHASE4_SECURITY_SCAN_RUN_ONCE, false);

  installSignalHandlers();

  await withClient(async (client) => {
    await assertFoundationTables(client);
    await assertPhase2Tables(client);
    await assertPhase3Tables(client);
    await assertPhase4Tables(client);
  });

  console.log(`[phase4] security-scanner starting batch_size=${batchSize} run_once=${runOnce}`);

  do {
    try {
      const summary = await scanContracts({ batchSize, rpcClient });
      console.log(
        `[phase4] security-scanner scanned=${summary.scanned} updated=${summary.updated} higher_risk=${summary.higherRisk}`,
      );
    } catch (error) {
      console.error(`[phase4] security-scanner error: ${formatError(error)}`);
    }

    if (runOnce || shuttingDown) {
      break;
    }

    await sleep(pollIntervalMs);
  } while (!shuttingDown);

  await closePool();
}

async function scanContracts({ batchSize, rpcClient }) {
  return withClient(async (client) => {
    const targets = await loadScanTargets(client, batchSize);
    let higherRisk = 0;
    let updated = 0;

    for (const contractAddress of targets) {
      if (shuttingDown) {
        break;
      }

      const refreshed = await refreshContractSecuritySnapshot(client, rpcClient, contractAddress);
      if (!refreshed) {
        continue;
      }

      updated += 1;
      if (refreshed.riskLabel === 'Higher Risk') {
        higherRisk += 1;
      }
    }

    return {
      higherRisk,
      scanned: targets.length,
      updated,
    };
  });
}

async function refreshContractSecuritySnapshot(client, rpcClient, contractAddress) {
  const snapshot = await buildSecuritySnapshot(client, rpcClient, contractAddress);
  if (!snapshot) {
    return null;
  }

  await upsertSecuritySnapshot(client, snapshot);
  return snapshot;
}

async function loadScanTargets(client, limit) {
  const registryAddresses = Array.from(new Set(getSyncableEntries().map((entry) => entry.contractAddress)));
  const result = await client.query(
    `SELECT contract_address
       FROM (
             SELECT DISTINCT token_address AS contract_address FROM stark_token_metadata
             UNION
             SELECT DISTINCT token_address AS contract_address FROM stark_transfers
             UNION
             SELECT DISTINCT token0_address AS contract_address FROM stark_trades
             UNION
             SELECT DISTINCT token1_address AS contract_address FROM stark_trades
             UNION
             SELECT DISTINCT contract_address FROM stark_contract_registry WHERE is_active = TRUE
       ) AS targets
       LEFT JOIN stark_contract_security AS security
              USING (contract_address)
      WHERE contract_address IS NOT NULL
      ORDER BY security.last_scanned_at NULLS FIRST, contract_address
      LIMIT $1`,
    [Math.max(limit, registryAddresses.length)],
  );

  const seen = new Set();
  const ordered = [...registryAddresses, ...result.rows.map((row) => row.contract_address)];
  const targets = [];

  for (const address of ordered) {
    const normalized = normalizeAddress(address, 'security scan address');
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    targets.push(normalized);
  }

  return targets.slice(0, limit);
}

async function buildSecuritySnapshot(client, rpcClient, contractAddress) {
  const [classHash, classDefinition, fallbackAbi] = await Promise.all([
    safeGetClassHash(rpcClient, contractAddress),
    safeGetClassDefinition(rpcClient, contractAddress),
    loadAbiFallback(client, contractAddress),
  ]);

  const abi = normalizeAbiPayload(classDefinition).length > 0
    ? normalizeAbiPayload(classDefinition)
    : normalizeAbiPayload({ abi: fallbackAbi });
  const names = collectAbiNames(abi);
  const functionSet = new Set(names.functions.map((name) => String(name).toLowerCase()));
  const ownerResolution = await resolveOwnerAddress(rpcClient, contractAddress, functionSet);
  const proxySlotHits = await probeProxySlots(rpcClient, contractAddress);

  const hasMintFunction = hasAnyFunction(functionSet, ['mint', 'mint_to', 'permissioned_mint']);
  const hasOwnerFunction = hasAnyFunction(functionSet, ['owner', 'get_owner', 'transfer_ownership', 'accept_ownership']);
  const hasAdminFunction = hasAnyFunction(functionSet, ['admin', 'get_admin', 'set_admin']);
  const hasImplementationGetter = hasAnyFunction(functionSet, ['implementation', 'get_implementation', 'implementation_hash']);
  const hasUpgradeEntrypoint = hasAnyFunction(functionSet, ['upgrade', 'upgrade_to', 'upgradeandcall', 'set_class_hash', 'replace_class']);
  const isProxy = hasImplementationGetter || proxySlotHits.length > 0;
  const isUpgradeable = isProxy || hasUpgradeEntrypoint;
  const ownerAddress = ownerResolution.address;
  const higherRisk = isUpgradeable || hasMintFunction || ownerAddress !== null || hasAdminFunction;
  const proxyClassification = proxySlotHits.length > 0 ? 'Upgradeable Proxy' : null;

  return {
    classHash,
    contractAddress,
    isUpgradeable,
    ownerAddress,
    riskLabel: higherRisk ? 'Higher Risk' : 'Baseline',
    securityFlags: {
      abi_events: names.events,
      abi_functions: names.functions,
      has_admin_function: hasAdminFunction,
      has_implementation_getter: hasImplementationGetter,
      has_mint_function: hasMintFunction,
      has_owner_function: hasOwnerFunction,
      has_upgrade_entrypoint: hasUpgradeEntrypoint,
      higher_risk: higherRisk,
      is_proxy: isProxy,
      owner_resolution_method: ownerResolution.method,
      proxy_classification: proxyClassification,
      proxy_slot_hits: proxySlotHits,
    },
  };
}

async function safeGetClassHash(rpcClient, contractAddress) {
  try {
    const result = await rpcClient.getClassHashAt('latest', contractAddress);
    return result ? normalizeHex(result, { label: 'security class hash', padToBytes: 32 }) : null;
  } catch (error) {
    return null;
  }
}

async function safeGetClassDefinition(rpcClient, contractAddress) {
  const cacheKey = `class:${contractAddress}`;
  return classCache.getOrLoad(cacheKey, async () => {
    try {
      return await rpcClient.getClassAt('latest', contractAddress);
    } catch (error) {
      return null;
    }
  });
}

async function loadAbiFallback(client, contractAddress) {
  const result = await client.query(
    `SELECT abi_json
       FROM stark_contract_registry
      WHERE contract_address = $1
        AND abi_json IS NOT NULL
      ORDER BY updated_at DESC
      LIMIT 1`,
    [contractAddress],
  );

  return result.rowCount === 0 ? null : result.rows[0].abi_json;
}

async function resolveOwnerAddress(rpcClient, contractAddress, functionSet) {
  for (const entrypoint of OWNER_ENTRYPOINTS) {
    if (!functionSet.has(entrypoint.toLowerCase())) {
      continue;
    }

    try {
      const result = await rpcClient.callContract({
        blockId: 'latest',
        calldata: [],
        contractAddress,
        entrypoint,
      });

      if (!Array.isArray(result) || result.length === 0) {
        continue;
      }

      const rawAddress = normalizeAddress(result[0], `${entrypoint} owner address`);
      if (/^0x0+$/.test(rawAddress)) {
        continue;
      }

      return {
        address: rawAddress,
        method: entrypoint,
      };
    } catch (error) {
      continue;
    }
  }

  return {
    address: null,
    method: null,
  };
}

async function probeProxySlots(rpcClient, contractAddress) {
  const hits = [];

  for (const slotSpec of STANDARD_PROXY_SLOT_SPECS) {
    try {
      const value = await rpcClient.getStorageAt('latest', contractAddress, slotSpec.slotKey);
      const normalizedValue = normalizeHex(value, { label: `${slotSpec.label} storage value`, padToBytes: 32 });

      if (/^0x0+$/.test(normalizedValue)) {
        continue;
      }

      hits.push({
        classification: slotSpec.classification,
        slot_key: slotSpec.slotKey,
        slot_name: slotSpec.label,
        value: normalizedValue,
      });
    } catch (error) {
      continue;
    }
  }

  return hits;
}

function hasAnyFunction(functionSet, names) {
  return names.some((name) => functionSet.has(name.toLowerCase()));
}

async function upsertSecuritySnapshot(client, snapshot) {
  await client.query(
    `INSERT INTO stark_contract_security (
         contract_address,
         is_upgradeable,
         owner_address,
         class_hash,
         risk_label,
         security_flags,
         last_scanned_at,
         created_at,
         updated_at
     ) VALUES (
         $1, $2, $3, $4, $5, $6::jsonb, NOW(), NOW(), NOW()
     )
     ON CONFLICT (contract_address)
     DO UPDATE SET
         is_upgradeable = EXCLUDED.is_upgradeable,
         owner_address = EXCLUDED.owner_address,
         class_hash = EXCLUDED.class_hash,
         risk_label = EXCLUDED.risk_label,
         security_flags = EXCLUDED.security_flags,
         last_scanned_at = NOW(),
         updated_at = NOW()`,
    [
      snapshot.contractAddress,
      snapshot.isUpgradeable,
      snapshot.ownerAddress,
      snapshot.classHash,
      snapshot.riskLabel,
      toJsonbString(snapshot.securityFlags),
    ],
  );
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
      console.log(`[phase4] security-scanner received ${signal}, stopping after current batch.`);
    });
  }
}

if (require.main === module) {
  main().catch(async (error) => {
    console.error(`[phase4] security-scanner fatal error: ${formatError(error)}`);
    try {
      await closePool();
    } finally {
      process.exitCode = 1;
    }
  });
}

module.exports = {
  buildSecuritySnapshot,
  refreshContractSecuritySnapshot,
  scanContracts,
};
