'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { selector } = require('starknet');
const { normalizeAddress, normalizeHex, normalizeSelector } = require('./normalize');
const { toBigIntStrict } = require('../lib/cairo/bigint');

const REGISTRY_PATH = path.resolve(__dirname, '..', 'data', 'registry', 'contracts.json');
const SELECTORS = Object.freeze({
  ERC20_TRANSFER: normalizeSelector(selector.getSelectorFromName('Transfer')),
  EKUBO_FEES_ACCUMULATED: normalizeSelector(selector.getSelectorFromName('FeesAccumulated')),
  EKUBO_LOADED_BALANCE: normalizeSelector(selector.getSelectorFromName('LoadedBalance')),
  EKUBO_POOL_INITIALIZED: normalizeSelector(selector.getSelectorFromName('PoolInitialized')),
  EKUBO_POSITION_FEES_COLLECTED: normalizeSelector(selector.getSelectorFromName('PositionFeesCollected')),
  EKUBO_POSITION_UPDATED: normalizeSelector(selector.getSelectorFromName('PositionUpdated')),
  EKUBO_SAVED_BALANCE: normalizeSelector(selector.getSelectorFromName('SavedBalance')),
  EKUBO_SWAPPED: normalizeSelector(selector.getSelectorFromName('Swapped')),
  JEDISWAP_BURN: normalizeSelector(selector.getSelectorFromName('Burn')),
  JEDISWAP_MINT: normalizeSelector(selector.getSelectorFromName('Mint')),
  JEDISWAP_SWAP: normalizeSelector(selector.getSelectorFromName('Swap')),
  JEDISWAP_SYNC: normalizeSelector(selector.getSelectorFromName('Sync')),
});

const SELECTOR_NAMES_BY_VALUE = new Map(Object.entries(SELECTORS).map(([name, value]) => [value, name]));
const EKUBO_SELECTOR_SET = new Set([
  SELECTORS.EKUBO_SWAPPED,
  SELECTORS.EKUBO_POSITION_UPDATED,
  SELECTORS.EKUBO_POOL_INITIALIZED,
  SELECTORS.EKUBO_FEES_ACCUMULATED,
  SELECTORS.EKUBO_POSITION_FEES_COLLECTED,
  SELECTORS.EKUBO_SAVED_BALANCE,
  SELECTORS.EKUBO_LOADED_BALANCE,
]);
const JEDISWAP_SELECTOR_SET = new Set([
  SELECTORS.JEDISWAP_SWAP,
  SELECTORS.JEDISWAP_MINT,
  SELECTORS.JEDISWAP_BURN,
  SELECTORS.JEDISWAP_SYNC,
]);
const CLASS_HASH_CACHE = new Map();

const registry = loadRegistry();

function loadRegistry() {
  const payload = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  const entries = [];
  const byAddress = new Map();
  const byClassHash = new Map();

  for (const contract of payload.contracts ?? []) {
    const contractAddress = normalizeAddress(contract.address, 'registry.address');
    const classHashes = Array.isArray(contract.class_hashes) && contract.class_hashes.length > 0
      ? contract.class_hashes
      : [{ class_hash: null, abi_version: contract.abi_version ?? null, valid_from_block: null, valid_to_block: null }];

    for (const item of classHashes) {
      const entry = {
        abiVersion: item.abi_version ?? contract.abi_version ?? null,
        classHash: item.class_hash ? normalizeHex(item.class_hash, { label: 'registry.class_hash', padToBytes: 32 }) : null,
        contractAddress,
        decoder: contract.decoder,
        metadata: contract.metadata ?? {},
        protocol: contract.protocol,
        role: contract.role,
        validFromBlock: item.valid_from_block === null || item.valid_from_block === undefined ? null : toBigIntStrict(item.valid_from_block, 'valid_from_block'),
        validToBlock: item.valid_to_block === null || item.valid_to_block === undefined ? null : toBigIntStrict(item.valid_to_block, 'valid_to_block'),
      };

      entries.push(entry);

      if (!byAddress.has(entry.contractAddress)) {
        byAddress.set(entry.contractAddress, []);
      }
      byAddress.get(entry.contractAddress).push(entry);

      if (entry.classHash) {
        if (!byClassHash.has(entry.classHash)) {
          byClassHash.set(entry.classHash, []);
        }
        byClassHash.get(entry.classHash).push(entry);
      }
    }
  }

  return { byAddress, byClassHash, entries };
}

async function resolveRoute({ event, tx, rpcClient }) {
  const contractMetadata = await resolveContractMetadata({
    blockNumber: tx.blockNumber,
    emitterAddress: event.fromAddress,
    resolvedClassHash: event.resolvedClassHash,
    rpcClient,
  });

  if (event.selector === SELECTORS.ERC20_TRANSFER) {
    if (!contractMetadata?.decoder && !looksLikeStandardErc20Transfer(event)) {
      return null;
    }

    return {
      contractMetadata,
      decoder: 'erc20',
      protocol: 'erc20',
      selectorName: 'ERC20_TRANSFER',
    };
  }

  if (contractMetadata?.decoder === 'ekubo' && EKUBO_SELECTOR_SET.has(event.selector)) {
    return {
      contractMetadata,
      decoder: 'ekubo',
      protocol: 'ekubo',
      selectorName: getSelectorName(event.selector),
    };
  }

  if (EKUBO_SELECTOR_SET.has(event.selector) && contractMetadata?.protocol === 'ekubo') {
    return {
      contractMetadata,
      decoder: 'ekubo',
      protocol: 'ekubo',
      selectorName: getSelectorName(event.selector),
    };
  }

  if (contractMetadata?.decoder === 'jediswap' && JEDISWAP_SELECTOR_SET.has(event.selector)) {
    return {
      contractMetadata,
      decoder: 'jediswap',
      protocol: 'jediswap',
      selectorName: getSelectorName(event.selector),
    };
  }

  if (JEDISWAP_SELECTOR_SET.has(event.selector)) {
    if (!contractMetadata?.decoder && !looksLikeJediswapEvent(event)) {
      return null;
    }

    return {
      contractMetadata,
      decoder: 'jediswap',
      protocol: 'jediswap',
      selectorName: getSelectorName(event.selector),
    };
  }

  return null;
}

async function resolveContractMetadata({ blockNumber, emitterAddress, resolvedClassHash, rpcClient }) {
  const normalizedAddress = normalizeAddress(emitterAddress, 'event emitter');
  const normalizedBlockNumber = toBigIntStrict(blockNumber, 'block number');
  const classHash = resolvedClassHash
    ? normalizeHex(resolvedClassHash, { label: 'resolved class hash', padToBytes: 32 })
    : await resolveClassHashAt({
      blockNumber: normalizedBlockNumber,
      emitterAddress: normalizedAddress,
      rpcClient,
    });

  const candidates = [];

  if (classHash && registry.byClassHash.has(classHash)) {
    candidates.push(...registry.byClassHash.get(classHash));
  }

  if (registry.byAddress.has(normalizedAddress)) {
    candidates.push(...registry.byAddress.get(normalizedAddress));
  }

  for (const candidate of candidates) {
    if (candidate.contractAddress !== normalizedAddress) {
      continue;
    }

    if (candidate.classHash && classHash && candidate.classHash !== classHash) {
      continue;
    }

    if (!isActiveAtBlock(candidate, normalizedBlockNumber)) {
      continue;
    }

    return {
      ...candidate,
      resolvedClassHash: classHash,
    };
  }

  if (!classHash) {
    return null;
  }

  return {
    abiVersion: null,
    classHash,
    contractAddress: normalizedAddress,
    decoder: null,
    metadata: {},
    protocol: null,
    resolvedClassHash: classHash,
    role: null,
  };
}

async function resolveClassHashAt({ blockNumber, emitterAddress, rpcClient }) {
  if (!rpcClient || typeof rpcClient.getClassHashAt !== 'function') {
    return null;
  }

  const cacheKey = `${blockNumber.toString(10)}:${emitterAddress}`;
  if (CLASS_HASH_CACHE.has(cacheKey)) {
    return CLASS_HASH_CACHE.get(cacheKey);
  }

  try {
    const result = await rpcClient.getClassHashAt(blockNumber, emitterAddress);
    const normalized = result ? normalizeHex(result, { label: 'class hash', padToBytes: 32 }) : null;
    CLASS_HASH_CACHE.set(cacheKey, normalized);
    return normalized;
  } catch (error) {
    CLASS_HASH_CACHE.set(cacheKey, null);
    return null;
  }
}

function getSelectorName(value) {
  return SELECTOR_NAMES_BY_VALUE.get(normalizeSelector(value)) ?? null;
}

function isActiveAtBlock(entry, blockNumber) {
  if (entry.validFromBlock !== null && blockNumber < entry.validFromBlock) {
    return false;
  }

  if (entry.validToBlock !== null && blockNumber > entry.validToBlock) {
    return false;
  }

  return true;
}

function looksLikeStandardErc20Transfer(event) {
  return Array.isArray(event.keys) && event.keys.length === 3 && Array.isArray(event.data) && event.data.length === 2;
}

function looksLikeJediswapEvent(event) {
  if (!Array.isArray(event.keys) || event.keys.length !== 1 || !Array.isArray(event.data)) {
    return false;
  }

  switch (event.selector) {
    case SELECTORS.JEDISWAP_MINT:
      return event.data.length === 5;
    case SELECTORS.JEDISWAP_BURN:
      return event.data.length === 6;
    case SELECTORS.JEDISWAP_SWAP:
      return event.data.length === 10;
    case SELECTORS.JEDISWAP_SYNC:
      return event.data.length === 4;
    default:
      return false;
  }
}

async function syncRegistryToDatabase(client) {
  for (const entry of registry.entries) {
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
           created_at,
           updated_at
       ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, TRUE, NOW(), NOW()
       )
       ON CONFLICT (contract_address, class_hash)
       DO UPDATE SET
           protocol = EXCLUDED.protocol,
           role = EXCLUDED.role,
           decoder = EXCLUDED.decoder,
           abi_version = EXCLUDED.abi_version,
           valid_from_block = EXCLUDED.valid_from_block,
           valid_to_block = EXCLUDED.valid_to_block,
           metadata = EXCLUDED.metadata,
           is_active = TRUE,
           updated_at = NOW()`,
      [
        entry.contractAddress,
        entry.classHash,
        entry.protocol,
        entry.role,
        entry.decoder,
        entry.abiVersion,
        entry.validFromBlock === null ? null : entry.validFromBlock.toString(10),
        entry.validToBlock === null ? null : entry.validToBlock.toString(10),
        JSON.stringify(entry.metadata ?? {}),
      ],
    );
  }
}

module.exports = {
  SELECTORS,
  getSelectorName,
  resolveContractMetadata,
  resolveRoute,
  syncRegistryToDatabase,
};
