'use strict';

const { setTimeout: sleep } = require('node:timers/promises');

const { createTtlCache } = require('../lib/cache');
const { inspectStarknetStringResult } = require('../lib/cairo/strings');
const { reassembleU256, toBigIntStrict, toNumericString } = require('../lib/cairo/bigint');
const { getStaticCoreToken } = require('./constants/tokens');
const { knownErc20Cache } = require('./known-erc20-cache');
const { normalizeAddress } = require('./normalize');
const { toJsonbString } = require('./protocols/shared');

const NAME_ENTRYPOINTS = ['name', 'get_name'];
const SYMBOL_ENTRYPOINTS = ['symbol', 'get_symbol'];
const DECIMALS_ENTRYPOINTS = ['decimals', 'get_decimals'];
const TOTAL_SUPPLY_ENTRYPOINTS = ['totalSupply', 'total_supply', 'get_total_supply'];

const authorityCache = createTtlCache({
  defaultTtlMs: 300_000,
  maxEntries: 10_000,
});

const voyagerAuthorityState = {
  consecutiveRateLimits: 0,
  nextAllowedAtMs: 0,
};

class VoyagerRateLimitError extends Error {
  constructor(message, { backoffMs }) {
    super(message);
    this.backoffMs = backoffMs;
    this.name = 'VoyagerRateLimitError';
  }
}

function sanitizeString(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const normalized = String(value).replace(/\x00/g, '').trim();
  return normalized || null;
}

function buildMetadataRecord({
  decimals = null,
  isStable = false,
  isVerified = false,
  metadata = {},
  name = null,
  source,
  symbol = null,
  tokenAddress,
  totalSupply = null,
}) {
  return {
    decimals: decimals === null || decimals === undefined ? null : toBigIntStrict(decimals, `${source} token decimals`),
    isStable: Boolean(isStable),
    isVerified: Boolean(isVerified),
    metadata: {
      ...(metadata ?? {}),
      source,
    },
    name: sanitizeString(name),
    source,
    symbol: sanitizeString(symbol),
    tokenAddress: normalizeAddress(tokenAddress, `${source} token address`),
    totalSupply: totalSupply === null || totalSupply === undefined ? null : toBigIntStrict(totalSupply, `${source} total supply`),
  };
}

function buildStaticCoreMetadata(tokenAddress) {
  const token = getStaticCoreToken(tokenAddress);
  if (!token) {
    return null;
  }

  return buildMetadataRecord({
    decimals: token.decimals,
    isStable: token.isStable,
    isVerified: true,
    metadata: {
      is_legacy: Boolean(token.isLegacy),
      resolution_tier: 'tier1_static_core_registry',
      verification_source: token.verificationSource ?? 'static_core_registry',
    },
    name: token.name,
    source: 'static_core_registry',
    symbol: token.symbol,
    tokenAddress: token.address,
  });
}

function buildKnownRegistryMetadata(tokenAddress) {
  const token = knownErc20Cache.getToken(tokenAddress);
  if (!token) {
    return null;
  }

  return buildMetadataRecord({
    decimals: token.decimals ?? null,
    isStable: false,
    isVerified: true,
    metadata: {
      comment: token.comment ?? null,
      l1_bridge_address: token.l1BridgeAddress ?? null,
      l1_token_address: token.l1TokenAddress ?? null,
      resolution_tier: 'tier1_local_registry',
      verification_source: token.verificationSource ?? 'known_erc20_cache',
    },
    name: token.name ?? null,
    source: 'known_erc20_cache',
    symbol: token.symbol ?? null,
    tokenAddress: token.l2TokenAddress,
  });
}

function hasCompleteTokenMetadata(metadata) {
  return Boolean(
    metadata
    && metadata.decimals !== null
    && metadata.decimals !== undefined
    && (metadata.symbol !== null || metadata.name !== null),
  );
}

function hasResolvedDecimals(metadata) {
  return Boolean(metadata && metadata.decimals !== null && metadata.decimals !== undefined);
}

async function loadExistingTokenMetadata(client, tokenAddress) {
  if (!client || typeof client.query !== 'function') {
    return null;
  }

  const normalizedTokenAddress = normalizeAddress(tokenAddress, 'existing metadata token address');
  const result = await client.query(
    `SELECT token_address,
            name,
            symbol,
            decimals,
            total_supply,
            is_verified,
            last_refreshed_block,
            last_refreshed_at,
            metadata
       FROM stark_token_metadata
      WHERE token_address = $1
      LIMIT 1`,
    [normalizedTokenAddress],
  );

  if (result.rowCount === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    ...buildMetadataRecord({
      decimals: row.decimals,
      isVerified: row.is_verified,
      metadata: {
        ...(row.metadata ?? {}),
        last_refreshed_at: row.last_refreshed_at ?? null,
        last_refreshed_block: row.last_refreshed_block ?? null,
        resolution_tier: 'tier2_stark_token_metadata',
      },
      name: row.name,
      source: 'stark_token_metadata',
      symbol: row.symbol,
      tokenAddress: row.token_address,
      totalSupply: row.total_supply,
    }),
    lastRefreshedAt: row.last_refreshed_at ?? null,
    lastRefreshedBlock: row.last_refreshed_block === null ? null : toBigIntStrict(row.last_refreshed_block, 'metadata last refreshed block'),
  };
}

async function resolveTokenMetadata(client, rpcClient, tokenAddress, options = {}) {
  const normalizedTokenAddress = normalizeAddress(tokenAddress, 'resolve token metadata address');
  const staticCoreMetadata = buildStaticCoreMetadata(normalizedTokenAddress);
  if (hasCompleteTokenMetadata(staticCoreMetadata)) {
    return staticCoreMetadata;
  }

  const existingMetadata = await loadExistingTokenMetadata(client, normalizedTokenAddress);
  if (hasCompleteTokenMetadata(existingMetadata) && !options.forceRefresh) {
    return existingMetadata;
  }

  const knownRegistryMetadata = buildKnownRegistryMetadata(normalizedTokenAddress);
  if (hasCompleteTokenMetadata(knownRegistryMetadata)) {
    return knownRegistryMetadata;
  }

  const onchainMetadata = rpcClient
    ? await fetchTokenMetadataOnchain(rpcClient, normalizedTokenAddress, { knownRegistryMetadata })
    : null;
  const authorityMetadata = shouldUseAuthorityFallback(onchainMetadata)
    ? await fetchTokenMetadataViaAuthority(normalizedTokenAddress, { knownRegistryMetadata })
    : null;

  const mergedMetadata = mergeMetadataRecords(
    normalizeAddress(tokenAddress, 'merged token metadata address'),
    staticCoreMetadata,
    existingMetadata,
    onchainMetadata,
    authorityMetadata,
    knownRegistryMetadata,
  );

  return mergedMetadata && (mergedMetadata.name || mergedMetadata.symbol || mergedMetadata.decimals !== null)
    ? mergedMetadata
    : null;
}

function shouldUseAuthorityFallback(onchainMetadata) {
  if (!onchainMetadata) {
    return true;
  }

  return !hasCompleteTokenMetadata(onchainMetadata);
}

function mergeMetadataRecords(tokenAddress, ...records) {
  const usableRecords = records.filter(Boolean);
  if (usableRecords.length === 0) {
    return null;
  }

  const merged = {
    decimals: null,
    isStable: false,
    isVerified: false,
    metadata: {
      resolution_sources: usableRecords.map((record) => record.source),
    },
    name: null,
    source: usableRecords[0].source,
    symbol: null,
    tokenAddress: normalizeAddress(tokenAddress, 'merge token address'),
    totalSupply: null,
  };

  for (const record of usableRecords) {
    if (merged.name === null && record.name) {
      merged.name = record.name;
      merged.metadata.name_source = record.source;
    }

    if (merged.symbol === null && record.symbol) {
      merged.symbol = record.symbol;
      merged.metadata.symbol_source = record.source;
    }

    if (merged.decimals === null && record.decimals !== null && record.decimals !== undefined) {
      merged.decimals = toBigIntStrict(record.decimals, `${record.source} merged decimals`);
      merged.metadata.decimals_source = record.source;
    }

    if (merged.totalSupply === null && record.totalSupply !== null && record.totalSupply !== undefined) {
      merged.totalSupply = toBigIntStrict(record.totalSupply, `${record.source} merged total supply`);
      merged.metadata.total_supply_source = record.source;
    }

    merged.isStable = Boolean(merged.isStable || record.isStable);
    merged.isVerified = Boolean(merged.isVerified || record.isVerified);
    merged.metadata = {
      ...(record.metadata ?? {}),
      ...(merged.metadata ?? {}),
    };
  }

  return merged;
}

async function fetchTokenMetadataOnchain(rpcClient, tokenAddress, { knownRegistryMetadata = null } = {}) {
  const normalizedTokenAddress = normalizeAddress(tokenAddress, 'onchain metadata token address');
  const [nameResult, symbolResult, decimalsResult, totalSupplyResult] = await Promise.all([
    callFirstSuccessful(rpcClient, normalizedTokenAddress, NAME_ENTRYPOINTS),
    callFirstSuccessful(rpcClient, normalizedTokenAddress, SYMBOL_ENTRYPOINTS),
    callFirstSuccessful(rpcClient, normalizedTokenAddress, DECIMALS_ENTRYPOINTS),
    callFirstSuccessful(rpcClient, normalizedTokenAddress, TOTAL_SUPPLY_ENTRYPOINTS),
  ]);

  const nameInspection = inspectStarknetStringResult(nameResult);
  const symbolInspection = inspectStarknetStringResult(symbolResult);
  const fallbackName = knownRegistryMetadata?.name ?? null;
  const fallbackSymbol = knownRegistryMetadata?.symbol ?? null;
  const fallbackDecimals = knownRegistryMetadata?.decimals ?? null;

  const name = sanitizeString(nameInspection.decoded ?? fallbackName ?? nameInspection.rawHexJoined ?? null);
  const symbol = sanitizeString(symbolInspection.decoded ?? fallbackSymbol ?? symbolInspection.rawHexJoined ?? null);
  const decimals = decodeDecimals(decimalsResult, fallbackDecimals);
  const totalSupply = decodeTotalSupply(totalSupplyResult);

  if (name === null && symbol === null && decimals === null && totalSupply === null) {
    return null;
  }

  return buildMetadataRecord({
    decimals,
    isVerified: Boolean(knownRegistryMetadata),
    metadata: {
      authority_fallback_used: false,
      decode_failed: Boolean(nameInspection.decodeFailed || symbolInspection.decodeFailed),
      fetch_source: 'onchain_rpc',
      name_decode_failed: Boolean(nameInspection.decodeFailed),
      name_raw_hex: nameInspection.rawHexJoined ?? null,
      resolution_tier: 'tier3_onchain_rpc',
      symbol_decode_failed: Boolean(symbolInspection.decodeFailed),
      symbol_raw_hex: symbolInspection.rawHexJoined ?? null,
    },
    name,
    source: 'onchain_rpc',
    symbol,
    tokenAddress: normalizedTokenAddress,
    totalSupply,
  });
}

async function callFirstSuccessful(rpcClient, contractAddress, entrypoints) {
  for (const entrypoint of entrypoints) {
    try {
      const result = await rpcClient.callContract({
        blockId: 'latest',
        calldata: [],
        contractAddress,
        entrypoint,
      });

      if (Array.isArray(result) && result.length > 0) {
        return result;
      }
    } catch (error) {
      continue;
    }
  }

  return null;
}

function decodeDecimals(result, fallbackValue) {
  if (Array.isArray(result) && result.length > 0) {
    return toBigIntStrict(result[0], 'token decimals');
  }

  if (fallbackValue === undefined || fallbackValue === null) {
    return null;
  }

  return toBigIntStrict(fallbackValue, 'fallback token decimals');
}

function decodeTotalSupply(result) {
  if (!Array.isArray(result) || result.length === 0) {
    return null;
  }

  if (result.length >= 2) {
    return reassembleU256(result[0], result[1]);
  }

  return toBigIntStrict(result[0], 'token total supply');
}

async function fetchTokenMetadataViaAuthority(tokenAddress, { knownRegistryMetadata = null } = {}) {
  const normalizedTokenAddress = normalizeAddress(tokenAddress, 'authority metadata token address');
  return authorityCache.getOrLoad(normalizedTokenAddress, async () => {
    const voyagerMetadata = await fetchTokenMetadataViaVoyager(normalizedTokenAddress, { knownRegistryMetadata });
    return voyagerMetadata;
  });
}

async function fetchTokenMetadataViaVoyager(tokenAddress, { knownRegistryMetadata = null } = {}) {
  const apiKey = String(process.env.VOYAGER_API_KEY ?? '').trim();
  if (!apiKey) {
    return null;
  }

  const baseUrl = String(process.env.VOYAGER_API_BASE_URL ?? 'https://api.voyager.online/beta').trim().replace(/\/+$/, '');
  const contractPayload = await fetchVoyagerJson(`${baseUrl}/contracts/${tokenAddress}`, apiKey, {
    allow404: true,
    description: `Voyager contract lookup for ${tokenAddress}`,
  });
  if (!contractPayload) {
    return null;
  }

  const tokenRegistryRecord = await loadVoyagerTokenRegistryRecord(baseUrl, apiKey, tokenAddress);
  const decimals = tokenRegistryRecord?.decimals ?? knownRegistryMetadata?.decimals ?? null;
  const symbol = tokenRegistryRecord?.symbol ?? contractPayload?.tokenSymbol ?? knownRegistryMetadata?.symbol ?? null;
  const name = tokenRegistryRecord?.name ?? contractPayload?.tokenName ?? knownRegistryMetadata?.name ?? null;

  if (name === null && symbol === null && decimals === null) {
    return null;
  }

  return buildMetadataRecord({
    decimals,
    isVerified: false,
    metadata: {
      authority_fallback_used: true,
      authority_provider: 'voyager',
      authority_registry_pages_scanned: tokenRegistryRecord?.pagesScanned ?? 0,
      authority_token_registry_hit: Boolean(tokenRegistryRecord),
      fetch_source: 'voyager_api',
      resolution_tier: 'tier4_offchain_authority',
      voyager_class_hash: contractPayload?.classHash ?? null,
      voyager_is_account: contractPayload?.isAccount ?? null,
      voyager_is_erc_token: contractPayload?.isErcToken ?? null,
      voyager_type: contractPayload?.type ?? null,
    },
    name,
    source: 'voyager_api',
    symbol,
    tokenAddress,
  });
}

async function loadVoyagerTokenRegistryRecord(baseUrl, apiKey, tokenAddress) {
  const pagesToScan = parsePositiveInteger(process.env.VOYAGER_TOKEN_SCAN_PAGES, 3);
  if (pagesToScan <= 0) {
    return null;
  }

  const normalizedTokenAddress = normalizeAddress(tokenAddress, 'voyager token registry address');

  for (let page = 1; page <= pagesToScan; page += 1) {
    let payload;
    try {
      payload = await fetchVoyagerJson(`${baseUrl}/tokens?type=erc20&ps=100&p=${page}`, apiKey, {
        description: `Voyager token registry page ${page}`,
      });
    } catch (error) {
      if (error instanceof VoyagerRateLimitError) {
        throw error;
      }

      break;
    }

    const match = Array.isArray(payload?.items)
      ? payload.items.find((item) => {
        try {
          return normalizeAddress(item.address, 'voyager token item address') === normalizedTokenAddress;
        } catch (error) {
          return false;
        }
      })
      : null;

    if (match) {
      return {
        decimals: match.decimals === undefined || match.decimals === null ? null : toBigIntStrict(match.decimals, 'voyager token decimals'),
        name: sanitizeString(match.name),
        pagesScanned: page,
        symbol: sanitizeString(match.symbol),
      };
    }
  }

  return null;
}

async function fetchVoyagerJson(url, apiKey, {
  allow404 = false,
  description = 'Voyager request',
} = {}) {
  await waitForVoyagerCooldown();

  const response = await fetch(url, {
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
    },
  });

  if (response.status === 429) {
    const backoffMs = registerVoyagerRateLimit(response);
    throw new VoyagerRateLimitError(`${description} hit Voyager rate limit (HTTP 429). Backing off for ${backoffMs}ms.`, {
      backoffMs,
    });
  }

  voyagerAuthorityState.consecutiveRateLimits = 0;
  voyagerAuthorityState.nextAllowedAtMs = Date.now() + getVoyagerCooldownMs();

  if (!response.ok) {
    if (allow404 && response.status === 404) {
      return null;
    }

    throw new Error(`${description} failed with HTTP ${response.status}.`);
  }

  return response.json();
}

async function waitForVoyagerCooldown() {
  const waitMs = voyagerAuthorityState.nextAllowedAtMs - Date.now();
  if (waitMs > 0) {
    await sleep(waitMs);
  }
}

function registerVoyagerRateLimit(response) {
  voyagerAuthorityState.consecutiveRateLimits += 1;

  const retryAfterMs = parseRetryAfterMs(response?.headers?.get?.('retry-after') ?? null);
  const baseBackoffMs = parsePositiveInteger(process.env.VOYAGER_API_RATE_LIMIT_BASE_BACKOFF_MS, 1_000);
  const maxBackoffMs = parsePositiveInteger(process.env.VOYAGER_API_RATE_LIMIT_MAX_BACKOFF_MS, 30_000);
  const exponentialBackoffMs = Math.min(
    baseBackoffMs * (2 ** Math.max(voyagerAuthorityState.consecutiveRateLimits - 1, 0)),
    maxBackoffMs,
  );
  const nextBackoffMs = retryAfterMs === null
    ? exponentialBackoffMs
    : Math.min(Math.max(retryAfterMs, exponentialBackoffMs), maxBackoffMs);

  voyagerAuthorityState.nextAllowedAtMs = Math.max(
    voyagerAuthorityState.nextAllowedAtMs,
    Date.now() + nextBackoffMs,
  );

  return nextBackoffMs;
}

function getVoyagerCooldownMs() {
  return parseNonNegativeInteger(process.env.VOYAGER_API_COOLDOWN_MS, 250);
}

function parseRetryAfterMs(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return null;
  }

  const normalized = String(value).trim();
  if (/^\d+$/.test(normalized)) {
    return Number.parseInt(normalized, 10) * 1_000;
  }

  const parsedDateMs = Date.parse(normalized);
  if (!Number.isFinite(parsedDateMs)) {
    return null;
  }

  return Math.max(parsedDateMs - Date.now(), 0);
}

async function upsertTokenMetadata(client, metadata, { refreshedAtBlock = null } = {}) {
  await client.query(
    `INSERT INTO stark_token_metadata (
         token_address,
         name,
         symbol,
         decimals,
         total_supply,
         is_verified,
         last_refreshed_block,
         last_refreshed_at,
         metadata,
         created_at,
         updated_at
     ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, NOW(), $8::jsonb, NOW(), NOW()
     )
     ON CONFLICT (token_address)
     DO UPDATE SET
         name = COALESCE(EXCLUDED.name, stark_token_metadata.name),
         symbol = COALESCE(EXCLUDED.symbol, stark_token_metadata.symbol),
         decimals = COALESCE(EXCLUDED.decimals, stark_token_metadata.decimals),
         total_supply = COALESCE(EXCLUDED.total_supply, stark_token_metadata.total_supply),
         is_verified = EXCLUDED.is_verified OR stark_token_metadata.is_verified,
         last_refreshed_block = COALESCE(EXCLUDED.last_refreshed_block, stark_token_metadata.last_refreshed_block),
         last_refreshed_at = NOW(),
         metadata = COALESCE(stark_token_metadata.metadata, '{}'::jsonb) || EXCLUDED.metadata,
         updated_at = NOW()`,
    [
      metadata.tokenAddress,
      metadata.name ?? null,
      metadata.symbol ?? null,
      metadata.decimals === null ? null : toNumericString(metadata.decimals, 'upsert token decimals'),
      metadata.totalSupply === null ? null : toNumericString(metadata.totalSupply, 'upsert token total supply'),
      Boolean(metadata.isVerified),
      refreshedAtBlock === null || refreshedAtBlock === undefined ? null : toNumericString(refreshedAtBlock, 'metadata refreshed at block'),
      toJsonbString(metadata.metadata ?? {}),
    ],
  );
}

function didResolveDecimals(previous, next) {
  if (!hasResolvedDecimals(next)) {
    return false;
  }

  if (!previous || !hasResolvedDecimals(previous)) {
    return true;
  }

  return toBigIntStrict(previous.decimals, 'previous token decimals') !== toBigIntStrict(next.decimals, 'next token decimals');
}

async function enqueueTokenMetadataRefresh(client, {
  blockNumber = null,
  metadata = {},
  reason = 'missing_metadata',
  sourceTable = 'unknown_source',
  tokenAddresses = [],
}) {
  if (!client || typeof client.query !== 'function') {
    return 0;
  }

  const normalizedAddresses = Array.from(new Set((tokenAddresses ?? [])
    .filter(Boolean)
    .map((value) => normalizeAddress(value, 'enqueue token metadata address'))));

  let enqueued = 0;

  for (const tokenAddress of normalizedAddresses) {
    if (hasCompleteTokenMetadata(buildStaticCoreMetadata(tokenAddress)) || hasCompleteTokenMetadata(buildKnownRegistryMetadata(tokenAddress))) {
      continue;
    }

    await client.query(
      `INSERT INTO stark_token_metadata_refresh_queue (
           queue_key,
           token_address,
           first_seen_block,
           latest_seen_block,
           status,
           metadata,
           enqueued_at,
           updated_at
       ) VALUES (
           $1, $2, $3, $3, 'pending', $4::jsonb, NOW(), NOW()
       )
       ON CONFLICT (queue_key)
       DO UPDATE SET
           first_seen_block = CASE
             WHEN stark_token_metadata_refresh_queue.first_seen_block IS NULL THEN EXCLUDED.first_seen_block
             WHEN EXCLUDED.first_seen_block IS NULL THEN stark_token_metadata_refresh_queue.first_seen_block
             ELSE LEAST(stark_token_metadata_refresh_queue.first_seen_block, EXCLUDED.first_seen_block)
           END,
           latest_seen_block = CASE
             WHEN stark_token_metadata_refresh_queue.latest_seen_block IS NULL THEN EXCLUDED.latest_seen_block
             WHEN EXCLUDED.latest_seen_block IS NULL THEN stark_token_metadata_refresh_queue.latest_seen_block
             ELSE GREATEST(stark_token_metadata_refresh_queue.latest_seen_block, EXCLUDED.latest_seen_block)
           END,
           status = 'pending',
           processing_started_at = NULL,
           processed_at = NULL,
           last_error = NULL,
           metadata = COALESCE(stark_token_metadata_refresh_queue.metadata, '{}'::jsonb) || EXCLUDED.metadata,
           updated_at = NOW()`,
      [
        tokenAddress,
        tokenAddress,
        blockNumber === null || blockNumber === undefined ? null : toNumericString(blockNumber, 'metadata queue block number'),
        toJsonbString({
          ...(metadata ?? {}),
          reason,
          source_table: sourceTable,
        }),
      ],
    );
    enqueued += 1;
  }

  return enqueued;
}

async function seedTokenMetadataRefreshQueueFromLiveTables(client, { limit = 100 } = {}) {
  if (!client || typeof client.query !== 'function') {
    return 0;
  }

  const result = await client.query(
    `WITH unresolved_tokens AS (
         SELECT token0_address AS token_address,
                MIN(block_number) AS first_seen_block,
                MAX(block_number) AS latest_seen_block,
                'stark_trades' AS source_table
           FROM stark_trades
          WHERE pending_enrichment = TRUE
          GROUP BY token0_address
         UNION ALL
         SELECT token1_address AS token_address,
                MIN(block_number) AS first_seen_block,
                MAX(block_number) AS latest_seen_block,
                'stark_trades' AS source_table
           FROM stark_trades
          WHERE pending_enrichment = TRUE
          GROUP BY token1_address
         UNION ALL
         SELECT token_address,
                MIN(block_number) AS first_seen_block,
                MAX(block_number) AS latest_seen_block,
                'stark_transfers' AS source_table
           FROM stark_transfers
          WHERE token_decimals IS NULL
             OR amount_human IS NULL
          GROUP BY token_address
     )
     SELECT token_address,
            MIN(first_seen_block) AS first_seen_block,
            MAX(latest_seen_block) AS latest_seen_block,
            jsonb_build_object(
              'seed_reason', 'live_table_backfill',
              'source_tables', to_jsonb(array_agg(DISTINCT source_table))
            ) AS metadata
       FROM unresolved_tokens
      WHERE token_address IS NOT NULL
      GROUP BY token_address
      ORDER BY MAX(latest_seen_block) ASC NULLS LAST, token_address ASC
      LIMIT $1`,
    [limit],
  );

  let enqueued = 0;
  for (const row of result.rows) {
    enqueued += await enqueueTokenMetadataRefresh(client, {
      blockNumber: row.latest_seen_block === null ? null : toBigIntStrict(row.latest_seen_block, 'seed metadata latest seen block'),
      metadata: row.metadata ?? {},
      reason: 'live_table_backfill',
      sourceTable: 'metadata_seed_scan',
      tokenAddresses: [row.token_address],
    });
  }

  return enqueued;
}

async function claimTokenMetadataRefreshQueueItems(client, { limit, stuckAfterMs }) {
  const result = await client.query(
    `WITH candidate_rows AS (
         SELECT queue_key
           FROM stark_token_metadata_refresh_queue
          WHERE status IN ('pending', 'failed')
             OR (
                  status = 'processing'
              AND processing_started_at IS NOT NULL
              AND processing_started_at < NOW() - ($2::numeric * INTERVAL '1 millisecond')
             )
          ORDER BY COALESCE(latest_seen_block, first_seen_block) ASC NULLS LAST, enqueued_at ASC
          LIMIT $1
          FOR UPDATE SKIP LOCKED
     )
     UPDATE stark_token_metadata_refresh_queue AS queue
        SET status = 'processing',
            attempts = queue.attempts + 1,
            processing_started_at = NOW(),
            updated_at = NOW()
       FROM candidate_rows
      WHERE queue.queue_key = candidate_rows.queue_key
      RETURNING queue.queue_key,
                queue.token_address,
                queue.first_seen_block,
                queue.latest_seen_block,
                queue.metadata`,
    [limit, stuckAfterMs],
  );

  return result.rows.map((row) => ({
    firstSeenBlock: row.first_seen_block === null ? null : toBigIntStrict(row.first_seen_block, 'claimed metadata first seen block'),
    latestSeenBlock: row.latest_seen_block === null ? null : toBigIntStrict(row.latest_seen_block, 'claimed metadata latest seen block'),
    metadata: row.metadata ?? {},
    queueKey: row.queue_key,
    tokenAddress: normalizeAddress(row.token_address, 'claimed metadata token address'),
  }));
}

async function markTokenMetadataRefreshProcessed(client, queueKey, details = {}) {
  await client.query(
    `UPDATE stark_token_metadata_refresh_queue
        SET status = 'processed',
            processed_at = NOW(),
            processing_started_at = NULL,
            last_error = NULL,
            metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
            updated_at = NOW()
      WHERE queue_key = $1`,
    [queueKey, toJsonbString(details)],
  );
}

async function markTokenMetadataRefreshFailed(client, queueKey, error, details = {}) {
  await client.query(
    `UPDATE stark_token_metadata_refresh_queue
        SET status = 'failed',
            processing_started_at = NULL,
            last_error = $2,
            metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
            updated_at = NOW()
      WHERE queue_key = $1`,
    [queueKey, truncateError(error), toJsonbString(details)],
  );
}

function truncateError(error) {
  const message = error?.stack || error?.message || String(error);
  return message.length > 4_000 ? message.slice(0, 4_000) : message;
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

function parseNonNegativeInteger(value, fallbackValue) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallbackValue;
  }

  const parsed = Number.parseInt(String(value).trim(), 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return fallbackValue;
  }

  return parsed;
}

module.exports = {
  claimTokenMetadataRefreshQueueItems,
  didResolveDecimals,
  enqueueTokenMetadataRefresh,
  fetchTokenMetadataOnchain,
  fetchTokenMetadataViaAuthority,
  hasCompleteTokenMetadata,
  hasResolvedDecimals,
  loadExistingTokenMetadata,
  markTokenMetadataRefreshFailed,
  markTokenMetadataRefreshProcessed,
  resolveTokenMetadata,
  seedTokenMetadataRefreshQueueFromLiveTables,
  upsertTokenMetadata,
};
