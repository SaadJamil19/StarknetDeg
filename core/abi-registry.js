'use strict';

const { toBigIntStrict } = require('../lib/cairo/bigint');
const {
  SELECTORS,
  getCandidateProtocolsForSelector,
  getFactoryMetadataByAddress,
  getSelectorName,
  getStaticMatchesByAddress,
  getStaticMatchesByClassHash,
  getSyncableEntries,
  isStandardDexSelector,
} = require('../lib/registry/dex-registry');
const { normalizeAddress, normalizeHex, normalizeSelector } = require('./normalize');

const CLASS_HASH_CACHE = new Map();
const PROBE_CACHE = new Map();
const EMPTY_CLASS_HASH = normalizeHex(0, { label: 'empty class hash', padToBytes: 32 });

async function resolveRoute({ event, tx, rpcClient }) {
  const contractMetadata = await resolveContractMetadata({
    blockNumber: tx.blockNumber,
    emitterAddress: event.fromAddress,
    eventSelector: event.selector,
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
      handler: 'transfer',
      protocol: 'erc20',
      protocolKey: 'erc20',
      selectorName: 'ERC20_TRANSFER',
    };
  }

  if (!contractMetadata) {
    return null;
  }

  if (contractMetadata.selectorSet.size > 0 && !contractMetadata.selectorSet.has(event.selector)) {
    return null;
  }

  return {
    contractMetadata,
    decoder: contractMetadata.decoder,
    family: contractMetadata.family,
    handler: contractMetadata.metadata?.selector_handlers?.[event.selector] ?? null,
    protocol: contractMetadata.protocol,
    protocolKey: contractMetadata.protocolKey,
    selectorName: getSelectorName(event.selector),
  };
}

async function resolveContractMetadata({ blockNumber, emitterAddress, eventSelector, resolvedClassHash, rpcClient }) {
  const normalizedAddress = normalizeAddress(emitterAddress, 'event emitter');
  const normalizedBlockNumber = toBigIntStrict(blockNumber, 'block number');
  const classHash = resolvedClassHash
    ? normalizeHex(resolvedClassHash, { label: 'resolved class hash', padToBytes: 32 })
    : await resolveClassHashAt({
      blockNumber: normalizedBlockNumber,
      emitterAddress: normalizedAddress,
      rpcClient,
    });

  const staticMatch = pickStaticMatch({
    blockNumber: normalizedBlockNumber,
    classHash,
    emitterAddress: normalizedAddress,
    eventSelector,
  });
  if (staticMatch) {
    return staticMatch;
  }

  if (!isStandardDexSelector(eventSelector)) {
    return null;
  }

  return probeDynamicDexEmitter({
    blockNumber: normalizedBlockNumber,
    classHash,
    emitterAddress: normalizedAddress,
    eventSelector,
    rpcClient,
  });
}

function pickStaticMatch({ blockNumber, classHash, emitterAddress, eventSelector }) {
  const exactAddressMatches = getStaticMatchesByAddress(emitterAddress)
    .filter((entry) => isActiveAtBlock(entry, blockNumber))
    .filter((entry) => !entry.classHash || !classHash || entry.classHash === classHash)
    .filter((entry) => entry.selectorSet.size === 0 || entry.selectorSet.has(eventSelector));

  if (exactAddressMatches.length > 0) {
    return finalizeMatch(exactAddressMatches[0], { classHash, contractAddress: emitterAddress });
  }

  if (!classHash) {
    return null;
  }

  const classMatches = getStaticMatchesByClassHash(classHash)
    .filter((entry) => isActiveAtBlock(entry, blockNumber))
    .filter((entry) => !entry.contractAddress || entry.contractAddress === emitterAddress)
    .filter((entry) => entry.selectorSet.size === 0 || entry.selectorSet.has(eventSelector));

  if (classMatches.length > 0) {
    return finalizeMatch(classMatches[0], { classHash, contractAddress: emitterAddress });
  }

  return null;
}

async function probeDynamicDexEmitter({ blockNumber, classHash, emitterAddress, eventSelector, rpcClient }) {
  if (!rpcClient || typeof rpcClient.callContract !== 'function') {
    return null;
  }

  const cacheKey = `${blockNumber.toString(10)}:${emitterAddress}:${classHash ?? 'none'}`;
  if (PROBE_CACHE.has(cacheKey)) {
    return PROBE_CACHE.get(cacheKey);
  }

  let result = null;

  try {
    const token0Result = await safeCallFirstSuccessful(rpcClient, {
      blockNumber,
      contractAddress: emitterAddress,
      entrypoints: ['token0'],
    });
    const token1Result = await safeCallFirstSuccessful(rpcClient, {
      blockNumber,
      contractAddress: emitterAddress,
      entrypoints: ['token1'],
    });

    if (!token0Result || !token1Result || token0Result.length === 0 || token1Result.length === 0) {
      PROBE_CACHE.set(cacheKey, null);
      return null;
    }

    const token0Address = normalizeAddress(token0Result[0], 'probed token0');
    const token1Address = normalizeAddress(token1Result[0], 'probed token1');
    const factoryResult = await safeCallFirstSuccessful(rpcClient, {
      blockNumber,
      contractAddress: emitterAddress,
      entrypoints: ['factory'],
    });
    const factoryAddress = Array.isArray(factoryResult) && factoryResult.length > 0
      ? normalizeAddress(factoryResult[0], 'probed factory')
      : null;
    const stableResult = await safeCallFirstSuccessful(rpcClient, {
      blockNumber,
      contractAddress: emitterAddress,
      entrypoints: ['stable'],
    });
    const stable = Array.isArray(stableResult) && stableResult.length > 0
      ? toBigIntStrict(stableResult[0], 'stable result') !== 0n
      : false;

    const factoryMetadata = factoryAddress ? getFactoryMetadataByAddress(factoryAddress) : null;
    const classMatches = classHash ? getStaticMatchesByClassHash(classHash) : [];
    const classMatch = classMatches.find((entry) =>
      (entry.selectorSet.size === 0 || entry.selectorSet.has(eventSelector)) &&
      (entry.role === 'pair' || entry.role === 'pool'));
    const matchSource = factoryMetadata ?? classMatch;

    if (matchSource) {
      result = {
        abiVersion: null,
        classHash,
        contractAddress: emitterAddress,
        decoder: matchSource.decoder,
        displayName: matchSource.displayName ?? null,
        family: matchSource.family,
        metadata: {
          ...(matchSource.metadata ?? {}),
          factory_address: factoryAddress,
          pool_model: resolvePoolModel(matchSource, stable),
          stable,
          token0_address: token0Address,
          token1_address: token1Address,
        },
        protocol: matchSource.protocol,
        protocolKey: matchSource.protocolKey,
        role: classMatch?.role ?? 'pair',
        selectorSet: matchSource.selectorSet ?? new Set(),
        sourceUrls: matchSource.sourceUrls ?? [],
      };
    }
  } catch (error) {
    result = null;
  }

  PROBE_CACHE.set(cacheKey, result);
  return result;
}

function resolvePoolModel(matchSource, stable) {
  const variant = matchSource.metadata?.ammVariant ?? null;
  if (variant === 'solidly') {
    return stable ? 'solidly_stable' : 'solidly_volatile';
  }

  if (variant === 'clmm') {
    return 'clmm';
  }

  return 'xyk';
}

function finalizeMatch(entry, { classHash, contractAddress }) {
  return {
    abiVersion: entry.abiVersion,
    classHash: classHash ?? entry.classHash ?? null,
    contractAddress,
    decoder: entry.decoder,
    displayName: entry.displayName,
    family: entry.family,
    metadata: {
      ...(entry.metadata ?? {}),
    },
    protocol: entry.protocol,
    protocolKey: entry.protocolKey,
    role: entry.role,
    selectorSet: entry.selectorSet ?? new Set(),
    sourceUrls: entry.sourceUrls ?? [],
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

async function safeCallFirstSuccessful(rpcClient, { blockNumber, contractAddress, entrypoints }) {
  for (const entrypoint of entrypoints ?? []) {
    try {
      const result = await rpcClient.callContract({
        blockId: blockNumber,
        calldata: [],
        contractAddress,
        entrypoint,
      });
      if (Array.isArray(result) && result.length > 0) {
        return result.map((value) => normalizeSelector(value, `${entrypoint} result`));
      }
    } catch (error) {
      continue;
    }
  }

  return null;
}

function isActiveAtBlock(entry, blockNumber) {
  const validFromBlock = entry.validFromBlock ?? null;
  const validToBlock = entry.validToBlock ?? null;

  if (validFromBlock !== null && blockNumber < validFromBlock) {
    return false;
  }

  if (validToBlock !== null && blockNumber > validToBlock) {
    return false;
  }

  return true;
}

function looksLikeStandardErc20Transfer(event) {
  return Array.isArray(event.keys) && event.keys.length === 3 && Array.isArray(event.data) && event.data.length === 2;
}

async function syncRegistryToDatabase(client) {
  for (const entry of getSyncableEntries()) {
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
           $1, $2, $3, $4, $5, $6, NULL, NULL, $7::jsonb, TRUE, NOW(), NOW()
       )
       ON CONFLICT (contract_address, class_hash)
       DO UPDATE SET
           protocol = EXCLUDED.protocol,
           role = EXCLUDED.role,
           decoder = EXCLUDED.decoder,
           abi_version = EXCLUDED.abi_version,
           metadata = EXCLUDED.metadata,
           is_active = TRUE,
           updated_at = NOW()`,
      [
        entry.contractAddress,
        entry.classHash ?? EMPTY_CLASS_HASH,
        entry.protocol,
        entry.role,
        entry.decoder,
        entry.abiVersion,
        JSON.stringify(entry.metadata ?? {}),
      ],
    );
  }
}

module.exports = {
  SELECTORS,
  getCandidateProtocolsForSelector,
  getSelectorName,
  isStandardDexSelector,
  resolveContractMetadata,
  resolveRoute,
  syncRegistryToDatabase,
};
