'use strict';

const { getCatalog, getFactoryMetadataByAddress, getStaticMatchesByAddress, getStaticMatchesByClassHash } = require('../lib/registry/dex-registry');
const { toBigIntStrict, toNumericString } = require('../lib/cairo/bigint');
const { normalizeAddress, normalizeHex, parsePoolKeyId } = require('./normalize');
const { toJsonbString } = require('./protocols/shared');

const CONFIDENCE_ORDER = Object.freeze([
  'candidate',
  'history_hint',
  'low_rpc_probe',
  'verified_class_hash',
  'verified_static_registry',
]);

const STATIC_POOL_ROLES = new Set([
  'amm',
  'core',
  'market_manager',
  'pair',
  'pool',
]);

const AGGREGATOR_PROTOCOLS = new Set([
  'avnu',
  'fibrous',
]);

const PROTOCOL_MODEL_HINTS = Object.freeze({
  '10kswap': Object.freeze({ poolFamily: 'xyk', poolModel: 'xyk' }),
  ekubo: Object.freeze({ poolFamily: 'clmm', poolModel: 'singleton_clmm' }),
  haiko: Object.freeze({ poolFamily: 'market_manager', poolModel: 'haiko' }),
  jediswap_v1: Object.freeze({ poolFamily: 'xyk', poolModel: 'xyk' }),
  jediswap_v2: Object.freeze({ poolFamily: 'clmm', poolModel: 'clmm' }),
  myswap_v1: Object.freeze({ poolFamily: 'fixed_pool', poolModel: 'fixed_pool' }),
});

const POOL_MODEL_FAMILY_MAP = Object.freeze({
  clmm: 'clmm',
  fixed_pool: 'fixed_pool',
  haiko: 'market_manager',
  haiko_multiswap: 'market_manager',
  singleton_clmm: 'clmm',
  solidly_stable: 'solidly',
  solidly_volatile: 'solidly',
  xyk: 'xyk',
});

const NO_ARG_BOOLEAN_ENTRYPOINTS = Object.freeze([
  'is_stable',
  'stable',
]);

const NO_ARG_FACTORY_ENTRYPOINTS = Object.freeze([
  'factory',
]);

const NO_ARG_RESERVE_ENTRYPOINTS = Object.freeze([
  'get_reserves',
  'getReserves',
]);

function isAggregatorProtocol(protocol) {
  const normalized = normalizeProtocolKey(protocol);
  if (!normalized) {
    return false;
  }

  if (AGGREGATOR_PROTOCOLS.has(normalized)) {
    return true;
  }

  const catalogMatch = getCatalog().find((entry) => normalizeProtocolKey(entry.key) === normalized || normalizeProtocolKey(entry.protocol) === normalized);
  return catalogMatch?.family === 'aggregator';
}

function normalizeProtocolKey(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return null;
  }

  return String(value).trim().toLowerCase();
}

function normalizePoolModel(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return null;
  }

  return String(value).trim().toLowerCase();
}

function normalizePoolRegistryCandidate(candidate = {}) {
  const metadata = candidate.metadata && typeof candidate.metadata === 'object'
    ? { ...candidate.metadata }
    : {};
  const poolId = candidate.poolId ?? candidate.poolKey ?? null;
  if (poolId === undefined || poolId === null || String(poolId).trim() === '') {
    throw new TypeError('poolId or poolKey is required for pool discovery.');
  }

  return {
    classHash: normalizeOptionalHex(candidate.classHash ?? metadata.class_hash ?? null),
    confidenceLevel: normalizeConfidenceLevel(candidate.confidenceLevel ?? null),
    contractAddress: normalizeOptionalAddress(candidate.contractAddress ?? metadata.contract_address ?? null),
    factoryAddress: normalizeOptionalAddress(candidate.factoryAddress ?? metadata.factory_address ?? null),
    firstSeenBlock: candidate.firstSeenBlock === undefined || candidate.firstSeenBlock === null
      ? null
      : toBigIntStrict(candidate.firstSeenBlock, 'pool first seen block'),
    metadata,
    poolFamily: normalizeOptionalText(candidate.poolFamily ?? metadata.pool_family ?? null),
    poolId: String(poolId).trim(),
    poolKey: String(candidate.poolKey ?? poolId).trim(),
    poolModel: normalizePoolModel(candidate.poolModel ?? candidate.poolModelHint ?? metadata.pool_model ?? null),
    protocol: normalizeOptionalText(candidate.protocol ?? metadata.protocol ?? null),
    stableFlag: normalizeOptionalBoolean(candidate.stableFlag ?? metadata.stable ?? metadata.stable_flag ?? null),
    token0Address: normalizeOptionalAddress(candidate.token0Address ?? metadata.token0_address ?? null),
    token1Address: normalizeOptionalAddress(candidate.token1Address ?? metadata.token1_address ?? null),
  };
}

function normalizeConfidenceLevel(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return null;
  }

  const normalized = String(value).trim().toLowerCase();
  return CONFIDENCE_ORDER.includes(normalized) ? normalized : null;
}

function normalizeOptionalText(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return null;
  }

  return String(value).trim();
}

function normalizeOptionalBoolean(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }

  return null;
}

function normalizeOptionalAddress(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return null;
  }

  try {
    return normalizeAddress(value, 'optional pool discovery address');
  } catch (error) {
    return null;
  }
}

function normalizeOptionalHex(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return null;
  }

  try {
    return normalizeHex(value, { label: 'optional pool discovery hex', padToBytes: 32 });
  } catch (error) {
    return null;
  }
}

function derivePoolTaxonomyFromModel(poolModel) {
  const normalizedModel = normalizePoolModel(poolModel);
  if (!normalizedModel) {
    return null;
  }

  const poolFamily = POOL_MODEL_FAMILY_MAP[normalizedModel] ?? null;
  if (!poolFamily) {
    return null;
  }

  return {
    poolFamily,
    poolModel: normalizedModel,
  };
}

function derivePoolTaxonomyHint(candidate) {
  const normalized = normalizePoolRegistryCandidate(candidate);

  if (isAggregatorProtocol(normalized.protocol)) {
    return null;
  }

  const modelHint = derivePoolTaxonomyFromModel(normalized.poolModel);
  if (modelHint) {
    return buildResolvedPoolEntry(normalized, {
      confidenceLevel: 'history_hint',
      poolFamily: modelHint.poolFamily,
      poolModel: modelHint.poolModel,
      source: 'pool_model_hint',
      stableFlag: deriveStableFlag(normalized.stableFlag, modelHint.poolModel),
    });
  }

  const staticProtocolHint = deriveProtocolTaxonomy(normalized.protocol, {
    poolId: normalized.poolId,
    stableFlag: normalized.stableFlag,
  });
  if (!staticProtocolHint) {
    return null;
  }

  return buildResolvedPoolEntry(normalized, {
    confidenceLevel: 'history_hint',
    poolFamily: staticProtocolHint.poolFamily,
    poolModel: staticProtocolHint.poolModel,
    source: 'protocol_hint',
    stableFlag: deriveStableFlag(normalized.stableFlag, staticProtocolHint.poolModel),
  });
}

function deriveProtocolTaxonomy(protocol, { poolId = null, stableFlag = null } = {}) {
  const normalizedProtocol = normalizeProtocolKey(protocol);
  if (!normalizedProtocol) {
    return null;
  }

  if (normalizedProtocol === 'sithswap') {
    return {
      poolFamily: 'solidly',
      poolModel: stableFlag === true
        ? 'solidly_stable'
        : (stableFlag === false ? 'solidly_volatile' : null),
    };
  }

  if (normalizedProtocol === 'haiko' && typeof poolId === 'string' && poolId.startsWith('haiko:multiswap:')) {
    return {
      poolFamily: 'market_manager',
      poolModel: 'haiko_multiswap',
    };
  }

  return PROTOCOL_MODEL_HINTS[normalizedProtocol] ?? null;
}

function deriveStableFlag(explicitStableFlag, poolModel) {
  if (typeof explicitStableFlag === 'boolean') {
    return explicitStableFlag;
  }

  const normalizedModel = normalizePoolModel(poolModel);
  if (normalizedModel === 'solidly_stable') {
    return true;
  }
  if (normalizedModel === 'solidly_volatile') {
    return false;
  }

  return null;
}

function buildResolvedPoolEntry(candidate, {
  classHash = candidate.classHash,
  confidenceLevel = candidate.confidenceLevel ?? 'candidate',
  poolFamily = candidate.poolFamily ?? null,
  poolModel = candidate.poolModel ?? null,
  source = null,
  stableFlag = candidate.stableFlag ?? null,
} = {}) {
  return {
    ...candidate,
    classHash: normalizeOptionalHex(classHash),
    confidenceLevel: normalizeConfidenceLevel(confidenceLevel) ?? 'candidate',
    metadata: {
      ...(candidate.metadata ?? {}),
      confidence_level: normalizeConfidenceLevel(confidenceLevel) ?? 'candidate',
      pool_taxonomy_source: source,
    },
    poolFamily: poolFamily ?? null,
    poolModel: normalizePoolModel(poolModel),
    stableFlag: stableFlag === null ? null : Boolean(stableFlag),
  };
}

function pickStaticPoolMatchByAddress(contractAddress) {
  if (!contractAddress) {
    return null;
  }

  const matches = getStaticMatchesByAddress(contractAddress)
    .filter((entry) => STATIC_POOL_ROLES.has(entry.role));

  return matches[0] ?? null;
}

function pickStaticPoolMatchByClassHash(classHash) {
  if (!classHash) {
    return null;
  }

  const matches = getStaticMatchesByClassHash(classHash)
    .filter((entry) => STATIC_POOL_ROLES.has(entry.role));

  return matches[0] ?? null;
}

function buildStaticMatchResolution(candidate, entry, confidenceLevel, source) {
  const protocolTaxonomy = deriveProtocolTaxonomy(entry.protocolKey ?? entry.protocol, {
    poolId: candidate.poolId,
    stableFlag: candidate.stableFlag ?? normalizeOptionalBoolean(entry.metadata?.stable ?? null),
  });
  const directModelHint = derivePoolTaxonomyFromModel(entry.metadata?.poolModel ?? null);
  const resolved = directModelHint ?? protocolTaxonomy;
  if (!resolved) {
    return null;
  }

  return buildResolvedPoolEntry(candidate, {
    classHash: candidate.classHash ?? entry.classHash ?? null,
    confidenceLevel,
    poolFamily: resolved.poolFamily,
    poolModel: resolved.poolModel,
    source,
    stableFlag: deriveStableFlag(candidate.stableFlag ?? normalizeOptionalBoolean(entry.metadata?.stable ?? null), resolved.poolModel),
  });
}

async function resolvePoolTaxonomy(candidate, { rpcClient } = {}) {
  const normalized = normalizePoolRegistryCandidate(candidate);
  if (isAggregatorProtocol(normalized.protocol)) {
    return null;
  }

  const staticAddressMatch = pickStaticPoolMatchByAddress(normalized.contractAddress);
  if (staticAddressMatch) {
    return buildStaticMatchResolution(normalized, staticAddressMatch, 'verified_static_registry', 'static_registry_address');
  }

  let resolvedClassHash = normalized.classHash ?? null;
  if (!resolvedClassHash && normalized.contractAddress && rpcClient && typeof rpcClient.getClassHashAt === 'function') {
    try {
      resolvedClassHash = normalizeOptionalHex(await rpcClient.getClassHashAt('latest', normalized.contractAddress));
    } catch (error) {
      resolvedClassHash = null;
    }
  }

  const staticClassMatch = pickStaticPoolMatchByClassHash(resolvedClassHash);
  if (staticClassMatch) {
    return buildStaticMatchResolution({
      ...normalized,
      classHash: resolvedClassHash,
    }, staticClassMatch, 'verified_class_hash', 'static_registry_class_hash');
  }

  const rpcResolution = await probePoolInterface({
    ...normalized,
    classHash: resolvedClassHash,
  }, rpcClient);
  if (rpcResolution) {
    return rpcResolution;
  }

  const hintResolution = derivePoolTaxonomyHint({
    ...normalized,
    classHash: resolvedClassHash,
  });
  if (hintResolution) {
    return hintResolution;
  }

  return buildResolvedPoolEntry({
    ...normalized,
    classHash: resolvedClassHash,
  }, {
    confidenceLevel: 'candidate',
    source: 'unclassified_candidate',
  });
}

async function probePoolInterface(candidate, rpcClient) {
  if (!rpcClient || typeof rpcClient.callContract !== 'function' || !candidate.contractAddress) {
    return null;
  }

  const factoryProbe = await callFirstSuccessful(rpcClient, candidate.contractAddress, NO_ARG_FACTORY_ENTRYPOINTS);
  const factoryAddress = Array.isArray(factoryProbe?.result) && factoryProbe.result.length > 0
    ? normalizeOptionalAddress(factoryProbe.result[0])
    : candidate.factoryAddress;
  const factoryMetadata = factoryAddress ? getFactoryMetadataByAddress(factoryAddress) : null;

  const stableProbe = await callFirstSuccessful(rpcClient, candidate.contractAddress, NO_ARG_BOOLEAN_ENTRYPOINTS);
  const stableFlag = stableProbe ? parseBoolFromResult(stableProbe.result) : candidate.stableFlag;

  if (factoryMetadata?.protocolKey === 'sithswap' || normalizeProtocolKey(candidate.protocol) === 'sithswap') {
    const sithswapModel = stableFlag === true
      ? 'solidly_stable'
      : (stableFlag === false ? 'solidly_volatile' : null);
    return buildResolvedPoolEntry({
      ...candidate,
      factoryAddress: factoryAddress ?? candidate.factoryAddress ?? null,
    }, {
      confidenceLevel: 'low_rpc_probe',
      poolFamily: 'solidly',
      poolModel: sithswapModel,
      source: stableProbe ? `rpc_probe:${stableProbe.entrypoint}` : 'rpc_probe:sithswap_protocol_hint',
      stableFlag,
    });
  }

  if (factoryMetadata) {
    const factoryTaxonomy = deriveProtocolTaxonomy(factoryMetadata.protocolKey, {
      poolId: candidate.poolId,
      stableFlag,
    });
    if (factoryTaxonomy) {
      return buildResolvedPoolEntry({
        ...candidate,
        factoryAddress,
      }, {
        confidenceLevel: 'low_rpc_probe',
        poolFamily: factoryTaxonomy.poolFamily,
        poolModel: factoryTaxonomy.poolModel,
        source: 'rpc_probe:factory',
        stableFlag: deriveStableFlag(stableFlag, factoryTaxonomy.poolModel),
      });
    }
  }

  const reserveProbe = await callFirstSuccessful(rpcClient, candidate.contractAddress, NO_ARG_RESERVE_ENTRYPOINTS);
  if (reserveProbe) {
    return buildResolvedPoolEntry({
      ...candidate,
      factoryAddress,
    }, {
      confidenceLevel: 'low_rpc_probe',
      poolFamily: stableFlag === null ? 'xyk' : (stableFlag ? 'solidly' : 'xyk'),
      poolModel: stableFlag === true ? 'solidly_stable' : (stableFlag === false && normalizeProtocolKey(candidate.protocol) === 'sithswap' ? 'solidly_volatile' : 'xyk'),
      source: `rpc_probe:${reserveProbe.entrypoint}`,
      stableFlag: deriveStableFlag(stableFlag, stableFlag === true ? 'solidly_stable' : 'xyk'),
    });
  }

  const ekuboProbe = await probeEkuboPool(candidate, rpcClient);
  if (ekuboProbe) {
    return buildResolvedPoolEntry(candidate, {
      confidenceLevel: 'low_rpc_probe',
      poolFamily: 'clmm',
      poolModel: 'singleton_clmm',
      source: `rpc_probe:${ekuboProbe}`,
    });
  }

  return null;
}

async function probeEkuboPool(candidate, rpcClient) {
  if (!candidate.contractAddress || !candidate.poolId) {
    return null;
  }

  let parsedPoolKey;
  try {
    parsedPoolKey = parsePoolKeyId(candidate.poolId, 'ekubo pool discovery pool id');
  } catch (error) {
    return null;
  }

  try {
    const result = await rpcClient.callContract({
      blockId: 'latest',
      calldata: [
        parsedPoolKey.token0,
        parsedPoolKey.token1,
        parsedPoolKey.fee.toString(10),
        parsedPoolKey.tickSpacing.toString(10),
        parsedPoolKey.extension,
      ],
      contractAddress: candidate.contractAddress,
      entrypoint: 'get_pool',
    });

    return Array.isArray(result) ? 'get_pool' : null;
  } catch (error) {
    return null;
  }
}

async function callFirstSuccessful(rpcClient, contractAddress, entrypoints) {
  for (const entrypoint of entrypoints ?? []) {
    try {
      const result = await rpcClient.callContract({
        blockId: 'latest',
        calldata: [],
        contractAddress,
        entrypoint,
      });

      if (Array.isArray(result)) {
        return {
          entrypoint,
          result,
        };
      }
    } catch (error) {
      continue;
    }
  }

  return null;
}

function parseBoolFromResult(result) {
  if (!Array.isArray(result) || result.length === 0) {
    return null;
  }

  try {
    return toBigIntStrict(result[0], 'pool discovery bool result') !== 0n;
  } catch (error) {
    return null;
  }
}

async function loadPoolRegistryByPoolKeys(client, poolKeys) {
  if (!client || typeof client.query !== 'function') {
    return new Map();
  }

  const normalizedKeys = Array.from(new Set((poolKeys ?? [])
    .filter(Boolean)
    .map((value) => String(value).trim())));

  if (normalizedKeys.length === 0) {
    return new Map();
  }

  const result = await client.query(
    `SELECT pool_key,
            protocol,
            contract_address,
            pool_id,
            class_hash,
            factory_address,
            token0_address,
            token1_address,
            pool_family,
            pool_model,
            stable_flag,
            confidence_level,
            first_seen_block,
            metadata
       FROM stark_pool_registry
      WHERE pool_key = ANY($1::text[])`,
    [normalizedKeys],
  );

  const map = new Map();
  for (const row of result.rows) {
    map.set(row.pool_key, mapPoolRegistryRow(row));
  }

  return map;
}

function mapPoolRegistryRow(row) {
  return {
    classHash: row.class_hash ?? null,
    confidenceLevel: row.confidence_level,
    contractAddress: row.contract_address ?? null,
    factoryAddress: row.factory_address ?? null,
    firstSeenBlock: row.first_seen_block === null ? null : toBigIntStrict(row.first_seen_block, 'pool registry first seen block'),
    metadata: row.metadata ?? {},
    poolFamily: row.pool_family ?? null,
    poolId: row.pool_id,
    poolKey: row.pool_key,
    poolModel: row.pool_model ?? null,
    protocol: row.protocol ?? null,
    stableFlag: row.stable_flag === null ? null : Boolean(row.stable_flag),
    token0Address: row.token0_address ?? null,
    token1Address: row.token1_address ?? null,
  };
}

async function upsertPoolRegistryEntry(client, entry) {
  const normalized = normalizePoolRegistryCandidate(entry);
  await client.query(
    `INSERT INTO stark_pool_registry (
         pool_key,
         protocol,
         contract_address,
         pool_id,
         class_hash,
         factory_address,
         token0_address,
         token1_address,
         pool_family,
         pool_model,
         stable_flag,
         confidence_level,
         first_seen_block,
         metadata,
         created_at,
         updated_at
     ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, NOW(), NOW()
     )
     ON CONFLICT (pool_key)
     DO UPDATE SET
         protocol = COALESCE(EXCLUDED.protocol, stark_pool_registry.protocol),
         contract_address = COALESCE(EXCLUDED.contract_address, stark_pool_registry.contract_address),
         pool_id = COALESCE(EXCLUDED.pool_id, stark_pool_registry.pool_id),
         class_hash = COALESCE(EXCLUDED.class_hash, stark_pool_registry.class_hash),
         factory_address = COALESCE(EXCLUDED.factory_address, stark_pool_registry.factory_address),
         token0_address = COALESCE(EXCLUDED.token0_address, stark_pool_registry.token0_address),
         token1_address = COALESCE(EXCLUDED.token1_address, stark_pool_registry.token1_address),
         pool_family = CASE
             WHEN EXCLUDED.pool_family IS NULL THEN stark_pool_registry.pool_family
             WHEN stark_pool_registry.pool_family IS NULL THEN EXCLUDED.pool_family
             WHEN array_position($15::text[], COALESCE(EXCLUDED.confidence_level, 'candidate')) >= array_position($15::text[], COALESCE(stark_pool_registry.confidence_level, 'candidate'))
               THEN EXCLUDED.pool_family
             ELSE stark_pool_registry.pool_family
         END,
         pool_model = CASE
             WHEN EXCLUDED.pool_model IS NULL THEN stark_pool_registry.pool_model
             WHEN stark_pool_registry.pool_model IS NULL THEN EXCLUDED.pool_model
             WHEN array_position($15::text[], COALESCE(EXCLUDED.confidence_level, 'candidate')) >= array_position($15::text[], COALESCE(stark_pool_registry.confidence_level, 'candidate'))
               THEN EXCLUDED.pool_model
             ELSE stark_pool_registry.pool_model
         END,
         stable_flag = CASE
             WHEN EXCLUDED.stable_flag IS NULL THEN stark_pool_registry.stable_flag
             WHEN stark_pool_registry.stable_flag IS NULL THEN EXCLUDED.stable_flag
             ELSE EXCLUDED.stable_flag
         END,
         confidence_level = CASE
             WHEN array_position($15::text[], COALESCE(EXCLUDED.confidence_level, 'candidate')) >= array_position($15::text[], COALESCE(stark_pool_registry.confidence_level, 'candidate'))
               THEN COALESCE(EXCLUDED.confidence_level, stark_pool_registry.confidence_level)
             ELSE stark_pool_registry.confidence_level
         END,
         first_seen_block = CASE
             WHEN stark_pool_registry.first_seen_block IS NULL THEN EXCLUDED.first_seen_block
             WHEN EXCLUDED.first_seen_block IS NULL THEN stark_pool_registry.first_seen_block
             ELSE LEAST(stark_pool_registry.first_seen_block, EXCLUDED.first_seen_block)
         END,
         metadata = COALESCE(stark_pool_registry.metadata, '{}'::jsonb) || EXCLUDED.metadata,
         updated_at = NOW()`,
    [
      normalized.poolKey,
      normalized.protocol,
      normalized.contractAddress,
      normalized.poolId,
      normalized.classHash,
      normalized.factoryAddress,
      normalized.token0Address,
      normalized.token1Address,
      normalized.poolFamily,
      normalized.poolModel,
      normalized.stableFlag,
      normalized.confidenceLevel ?? 'candidate',
      normalized.firstSeenBlock === null ? null : toNumericString(normalized.firstSeenBlock, 'pool registry first seen block'),
      toJsonbString(normalized.metadata ?? {}),
      CONFIDENCE_ORDER,
    ],
  );
}

async function queuePoolDiscoveryCandidates(client, candidates) {
  if (!client || typeof client.query !== 'function') {
    return 0;
  }

  let upserted = 0;
  for (const item of candidates ?? []) {
    try {
      const normalized = normalizePoolRegistryCandidate(item);
      if (isAggregatorProtocol(normalized.protocol)) {
        continue;
      }

      const hint = derivePoolTaxonomyHint(normalized);
      await upsertPoolRegistryEntry(client, hint ?? buildResolvedPoolEntry(normalized, {
        confidenceLevel: 'candidate',
        source: 'live_candidate_queue',
      }));
      upserted += 1;
    } catch (error) {
      continue;
    }
  }

  return upserted;
}

async function seedPoolRegistryCandidatesFromHistory(client, { limit = 250 } = {}) {
  if (!client || typeof client.query !== 'function') {
    return 0;
  }

  const result = await client.query(
    `WITH latest_rows AS (
         SELECT pool_id,
                protocol,
                token0_address,
                token1_address,
                block_number,
                metadata
           FROM stark_pool_latest
          WHERE pool_id IS NOT NULL
     ),
     first_action_rows AS (
         SELECT DISTINCT ON (pool_id)
                pool_id,
                protocol,
                emitter_address,
                token0_address,
                token1_address,
                block_number,
                metadata
           FROM stark_action_norm
          WHERE pool_id IS NOT NULL
            AND token0_address IS NOT NULL
            AND token1_address IS NOT NULL
          ORDER BY pool_id ASC, block_number ASC, transaction_index ASC, source_event_index ASC
     )
     SELECT COALESCE(action.pool_id, latest.pool_id) AS pool_key,
            COALESCE(action.pool_id, latest.pool_id) AS pool_id,
            COALESCE(action.protocol, latest.protocol) AS protocol,
            action.emitter_address AS contract_address,
            COALESCE(action.token0_address, latest.token0_address) AS token0_address,
            COALESCE(action.token1_address, latest.token1_address) AS token1_address,
            COALESCE(
                LEAST(action.block_number, latest.block_number),
                action.block_number,
                latest.block_number
            ) AS first_seen_block,
            action.metadata AS action_metadata,
            latest.metadata AS latest_metadata
       FROM latest_rows AS latest
       FULL OUTER JOIN first_action_rows AS action
         ON action.pool_id = latest.pool_id
       LEFT JOIN stark_pool_registry AS registry
         ON registry.pool_key = COALESCE(action.pool_id, latest.pool_id)
      WHERE COALESCE(action.pool_id, latest.pool_id) IS NOT NULL
        AND (
             registry.pool_key IS NULL
          OR registry.pool_family IS NULL
          OR registry.pool_model IS NULL
          OR registry.confidence_level IN ('candidate', 'history_hint')
        )
      ORDER BY COALESCE(
          LEAST(action.block_number, latest.block_number),
          action.block_number,
          latest.block_number
      ) ASC NULLS LAST,
      COALESCE(action.pool_id, latest.pool_id) ASC
      LIMIT $1`,
    [limit],
  );

  let seeded = 0;

  for (const row of result.rows) {
    const metadata = {
      ...(row.latest_metadata ?? {}),
      ...(row.action_metadata ?? {}),
      seed_reason: 'history_backfill',
    };
    const candidate = {
      contractAddress: row.contract_address ?? inferContractAddressFromPoolId(row.pool_id),
      firstSeenBlock: row.first_seen_block === null ? null : toBigIntStrict(row.first_seen_block, 'seed pool first seen block'),
      metadata,
      poolId: row.pool_id,
      protocol: row.protocol,
      token0Address: row.token0_address,
      token1Address: row.token1_address,
    };

    if (isAggregatorProtocol(candidate.protocol)) {
      continue;
    }

    const resolved = derivePoolTaxonomyHint(candidate) ?? buildResolvedPoolEntry(normalizePoolRegistryCandidate(candidate), {
      confidenceLevel: 'candidate',
      source: 'history_seed_unclassified',
    });
    await upsertPoolRegistryEntry(client, resolved);
    seeded += 1;
  }

  return seeded;
}

function inferContractAddressFromPoolId(poolId) {
  const normalized = normalizeOptionalText(poolId);
  if (!normalized) {
    return null;
  }

  if (/^0x[0-9a-fA-F]+$/.test(normalized)) {
    return normalizeOptionalAddress(normalized);
  }

  const myswapParts = normalized.split(':');
  if (myswapParts.length === 2 && /^0x[0-9a-fA-F]+$/.test(myswapParts[0])) {
    return normalizeOptionalAddress(myswapParts[0]);
  }

  return null;
}

async function loadUnresolvedPoolRegistryEntries(client, { limit = 100 } = {}) {
  const result = await client.query(
    `SELECT pool_key,
            protocol,
            contract_address,
            pool_id,
            class_hash,
            factory_address,
            token0_address,
            token1_address,
            pool_family,
            pool_model,
            stable_flag,
            confidence_level,
            first_seen_block,
            metadata
       FROM stark_pool_registry
      WHERE pool_family IS NULL
         OR pool_model IS NULL
         OR confidence_level IN ('candidate', 'history_hint')
      ORDER BY first_seen_block ASC NULLS LAST, pool_key ASC
      LIMIT $1`,
    [limit],
  );

  return result.rows.map(mapPoolRegistryRow);
}

async function syncPoolTaxonomyToStateTables(client, { poolKeys = null } = {}) {
  if (!client || typeof client.query !== 'function') {
    return {
      updatedHistoryRows: 0,
      updatedLatestRows: 0,
    };
  }

  const normalizedKeys = Array.from(new Set((poolKeys ?? [])
    .filter(Boolean)
    .map((value) => String(value).trim())));
  const useFilter = normalizedKeys.length > 0;

  const historyResult = await client.query(
    `UPDATE stark_pool_state_history AS history
        SET pool_family = registry.pool_family,
            pool_model = registry.pool_model,
            metadata = COALESCE(history.metadata, '{}'::jsonb) || jsonb_build_object(
                'pool_family',
                registry.pool_family,
                'pool_model',
                registry.pool_model,
                'pool_confidence_level',
                registry.confidence_level
            ),
            updated_at = NOW()
      FROM stark_pool_registry AS registry
      WHERE history.pool_id = registry.pool_key
        AND (registry.pool_family IS NOT NULL OR registry.pool_model IS NOT NULL)
        AND ($1::boolean = FALSE OR history.pool_id = ANY($2::text[]))
        AND (
             history.pool_family IS DISTINCT FROM registry.pool_family
          OR history.pool_model IS DISTINCT FROM registry.pool_model
        )`,
    [useFilter, normalizedKeys],
  );

  const latestResult = await client.query(
    `UPDATE stark_pool_latest AS latest
        SET pool_family = registry.pool_family,
            pool_model = registry.pool_model,
            metadata = COALESCE(latest.metadata, '{}'::jsonb) || jsonb_build_object(
                'pool_family',
                registry.pool_family,
                'pool_model',
                registry.pool_model,
                'pool_confidence_level',
                registry.confidence_level
            ),
            updated_at = NOW()
      FROM stark_pool_registry AS registry
      WHERE latest.pool_id = registry.pool_key
        AND (registry.pool_family IS NOT NULL OR registry.pool_model IS NOT NULL)
        AND ($1::boolean = FALSE OR latest.pool_id = ANY($2::text[]))
        AND (
             latest.pool_family IS DISTINCT FROM registry.pool_family
          OR latest.pool_model IS DISTINCT FROM registry.pool_model
        )`,
    [useFilter, normalizedKeys],
  );

  return {
    updatedHistoryRows: historyResult.rowCount,
    updatedLatestRows: latestResult.rowCount,
  };
}

async function collectMissingPoolTaxonomyRows(client, { limit = 20 } = {}) {
  const result = await client.query(
    `SELECT missing.scope,
            missing.pool_id,
            missing.protocol,
            missing.first_seen_block,
            action.emitter_address
       FROM (
             SELECT 'stark_pool_latest' AS scope,
                    latest.pool_id,
                    latest.protocol,
                    latest.block_number AS first_seen_block
               FROM stark_pool_latest AS latest
              WHERE latest.pool_family IS NULL
             UNION ALL
             SELECT 'stark_pool_state_history' AS scope,
                    history.pool_id,
                    history.protocol,
                    MIN(history.block_number) AS first_seen_block
               FROM stark_pool_state_history AS history
              WHERE history.pool_family IS NULL
              GROUP BY history.pool_id, history.protocol
       ) AS missing
       LEFT JOIN LATERAL (
           SELECT emitter_address
             FROM stark_action_norm
            WHERE pool_id = missing.pool_id
            ORDER BY block_number ASC, transaction_index ASC, source_event_index ASC
            LIMIT 1
       ) AS action
         ON TRUE
      ORDER BY missing.first_seen_block ASC NULLS LAST, missing.pool_id ASC
      LIMIT $1`,
    [limit],
  );

  return result.rows;
}

async function countPoolFamilyNulls(client) {
  const result = await client.query(
    `SELECT
        (SELECT COUNT(*)::text FROM stark_pool_latest WHERE pool_family IS NULL) AS latest_null_rows,
        (SELECT COUNT(*)::text FROM stark_pool_state_history WHERE pool_family IS NULL) AS history_null_rows`,
  );

  return {
    historyNullRows: Number(result.rows[0].history_null_rows),
    latestNullRows: Number(result.rows[0].latest_null_rows),
  };
}

async function countAggregatorLeaks(client) {
  const result = await client.query(
    `SELECT COUNT(*)::text AS aggregator_rows
       FROM stark_pool_registry
      WHERE LOWER(COALESCE(protocol, '')) IN ('avnu', 'fibrous')`,
  );

  return Number(result.rows[0].aggregator_rows);
}

async function countClmmTradeJoins(client) {
  const result = await client.query(
    `SELECT COUNT(*)::text AS clmm_trade_rows
       FROM stark_trades AS trade
       JOIN stark_pool_latest AS latest
         ON latest.lane = trade.lane
        AND latest.pool_id = trade.pool_id
      WHERE latest.pool_family = 'clmm'`,
  );

  return Number(result.rows[0].clmm_trade_rows);
}

module.exports = {
  CONFIDENCE_ORDER,
  collectMissingPoolTaxonomyRows,
  countAggregatorLeaks,
  countClmmTradeJoins,
  countPoolFamilyNulls,
  derivePoolTaxonomyHint,
  isAggregatorProtocol,
  loadPoolRegistryByPoolKeys,
  loadUnresolvedPoolRegistryEntries,
  normalizePoolRegistryCandidate,
  queuePoolDiscoveryCandidates,
  resolvePoolTaxonomy,
  seedPoolRegistryCandidatesFromHistory,
  syncPoolTaxonomyToStateTables,
  upsertPoolRegistryEntry,
};
