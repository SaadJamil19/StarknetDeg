#!/usr/bin/env node
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { setTimeout: sleep } = require('node:timers/promises');
const { assertFoundationTables, assertPhase2Tables, assertPhase3Tables, assertPhase4Tables } = require('../core/checkpoint');
const { knownErc20Cache } = require('../core/known-erc20-cache');
const { normalizeAddress } = require('../core/normalize');
const { rebuildPendingEnrichmentCandles } = require('../core/ohlcv');
const { repricePendingEnrichmentTrades } = require('../core/trades');
const { createTtlCache } = require('../lib/cache');
const { inspectStarknetStringResult } = require('../lib/cairo/strings');
const { reassembleU256, toBigIntStrict, toNumericString } = require('../lib/cairo/bigint');
const { closePool, withClient } = require('../lib/db');
const { StarknetRpcClient } = require('../lib/starknet-rpc');
const { refreshContractSecuritySnapshot } = require('./security-scanner');

const NAME_ENTRYPOINTS = ['name', 'get_name'];
const SYMBOL_ENTRYPOINTS = ['symbol', 'get_symbol'];
const DECIMALS_ENTRYPOINTS = ['decimals', 'get_decimals'];
const TOTAL_SUPPLY_ENTRYPOINTS = ['totalSupply', 'total_supply', 'get_total_supply'];

const metadataCache = createTtlCache({
  defaultTtlMs: parsePositiveInteger(process.env.PHASE4_META_CACHE_TTL_MS, 3_600_000),
  maxEntries: 20_000,
});

let shuttingDown = false;

async function main() {
  const rpcClient = new StarknetRpcClient();
  const batchSize = parsePositiveInteger(process.env.PHASE4_META_REFRESH_BATCH_SIZE, 100);
  const pollIntervalMs = parsePositiveInteger(process.env.PHASE4_META_REFRESH_INTERVAL_MS, 60_000);
  const runOnce = parseBoolean(process.env.PHASE4_META_REFRESH_RUN_ONCE, false);

  installSignalHandlers();

  await withClient(async (client) => {
    await assertFoundationTables(client);
    await assertPhase2Tables(client);
    await assertPhase3Tables(client);
    await assertPhase4Tables(client);
  });

  console.log(`[phase4] meta-refresher starting batch_size=${batchSize} run_once=${runOnce}`);

  do {
    try {
      const summary = await refreshTokenMetadata({ batchSize, rpcClient });
      console.log(
        `[phase4] meta-refresher scanned=${summary.scanned} refreshed=${summary.refreshed} skipped=${summary.skipped} repriced_trades=${summary.repricedTrades} rebuilt_candles=${summary.rebuiltCandles}`,
      );
    } catch (error) {
      console.error(`[phase4] meta-refresher error: ${formatError(error)}`);
    }

    if (runOnce || shuttingDown) {
      break;
    }

    await sleep(pollIntervalMs);
  } while (!shuttingDown);

  await closePool();
}

async function refreshTokenMetadata({ batchSize, rpcClient }) {
  return withClient(async (client) => {
    const refreshedAtBlock = await safeGetLatestBlockNumber(rpcClient);
    const metadataTtlBlocks = parseOptionalBigInt(process.env.PHASE4_METADATA_TTL_BLOCKS, 10_000n);
    const candidates = await loadRefreshCandidates(client, {
      currentBlock: refreshedAtBlock,
      limit: batchSize,
      metadataTtlBlocks,
    });

    let refreshed = 0;
    let skipped = 0;
    const decimalRefreshTokens = new Set();

    for (const candidate of candidates) {
      if (shuttingDown) {
        break;
      }

      const metadata = await fetchTokenMetadata(rpcClient, candidate.tokenAddress, {
        forceRefresh: candidate.refreshReason === 'stale',
      });
      if (!metadata) {
        skipped += 1;
        continue;
      }

      const previous = await loadExistingTokenMetadata(client, candidate.tokenAddress);
      await upsertTokenMetadata(client, {
        ...metadata,
        refreshedAtBlock,
      });

      if (didResolveDecimals(previous, metadata)) {
        decimalRefreshTokens.add(candidate.tokenAddress);
      }

      await refreshContractSecuritySnapshot(client, rpcClient, candidate.tokenAddress);
      refreshed += 1;
    }

    const decimalRefreshList = Array.from(decimalRefreshTokens);
    const tradeSummary = await repricePendingEnrichmentTrades(client, { tokenAddresses: decimalRefreshList });
    const candleSummary = await rebuildPendingEnrichmentCandles(client, { tokenAddresses: decimalRefreshList });

    return {
      rebuiltCandles: candleSummary.rebuiltCandles,
      refreshed,
      repricedTrades: tradeSummary.repricedTrades,
      scanned: candidates.length,
      skipped,
    };
  });
}

async function loadRefreshCandidates(client, { currentBlock, limit, metadataTtlBlocks }) {
  const result = await client.query(
    `SELECT DISTINCT tokens.token_address,
            metadata.name,
            metadata.symbol,
            metadata.decimals,
            metadata.last_refreshed_block
       FROM (
             SELECT token_address FROM stark_transfers
             UNION
             SELECT token_address FROM stark_bridge_activities WHERE token_address IS NOT NULL
             UNION
             SELECT token_address FROM stark_prices
             UNION
             SELECT token0_address AS token_address FROM stark_trades
             UNION
             SELECT token1_address AS token_address FROM stark_trades
       ) AS tokens
       LEFT JOIN stark_token_metadata AS metadata
              ON metadata.token_address = tokens.token_address
      WHERE tokens.token_address IS NOT NULL
      ORDER BY tokens.token_address`,
  );

  const candidates = [];

  for (const row of result.rows) {
    const refreshReason = classifyRefreshReason(row, { currentBlock, metadataTtlBlocks });
    if (!refreshReason) {
      continue;
    }

    candidates.push({
      refreshReason,
      tokenAddress: row.token_address,
    });
  }

  return candidates.slice(0, limit);
}

function classifyRefreshReason(row, { currentBlock, metadataTtlBlocks }) {
  if (row.name === null || row.symbol === null || row.decimals === null) {
    return 'missing';
  }

  if (currentBlock === null || metadataTtlBlocks === null) {
    return null;
  }

  if (row.last_refreshed_block === null) {
    return 'stale';
  }

  const lastRefreshedBlock = toBigIntStrict(row.last_refreshed_block, 'metadata last refreshed block');
  if ((currentBlock - lastRefreshedBlock) >= metadataTtlBlocks) {
    return 'stale';
  }

  return null;
}

async function loadExistingTokenMetadata(client, tokenAddress) {
  const result = await client.query(
    `SELECT decimals
       FROM stark_token_metadata
      WHERE token_address = $1
      LIMIT 1`,
    [tokenAddress],
  );

  if (result.rowCount === 0) {
    return null;
  }

  return {
    decimals: result.rows[0].decimals === null ? null : toBigIntStrict(result.rows[0].decimals, 'existing token decimals'),
  };
}

async function fetchTokenMetadata(rpcClient, tokenAddress, { forceRefresh = false } = {}) {
  const normalizedTokenAddress = normalizeAddress(tokenAddress, 'metadata token address');
  const loader = async () => {
    const knownToken = knownErc20Cache.getToken(normalizedTokenAddress);
    const [nameResult, symbolResult, decimalsResult, totalSupplyResult] = await Promise.all([
      callFirstSuccessful(rpcClient, normalizedTokenAddress, NAME_ENTRYPOINTS),
      callFirstSuccessful(rpcClient, normalizedTokenAddress, SYMBOL_ENTRYPOINTS),
      callFirstSuccessful(rpcClient, normalizedTokenAddress, DECIMALS_ENTRYPOINTS),
      callFirstSuccessful(rpcClient, normalizedTokenAddress, TOTAL_SUPPLY_ENTRYPOINTS),
    ]);

    const nameInspection = inspectStarknetStringResult(nameResult);
    const symbolInspection = inspectStarknetStringResult(symbolResult);
    const name = resolveStringField(nameInspection, knownToken?.name ?? null);
    const symbol = resolveStringField(symbolInspection, knownToken?.symbol ?? null);
    const decimals = decodeDecimals(decimalsResult, knownToken?.decimals);
    const totalSupply = decodeTotalSupply(totalSupplyResult);
    const decodeFailed = Boolean(nameInspection.decodeFailed || symbolInspection.decodeFailed);

    if (name === null && symbol === null && decimals === null && totalSupply === null && !knownToken) {
      return null;
    }

    return {
      decimals,
      isVerified: Boolean(knownToken),
      metadata: {
        decode_failed: decodeFailed,
        fetch_source: 'onchain',
        known_erc20_id: knownToken?.id ?? null,
        name_decode_failed: Boolean(nameInspection.decodeFailed),
        name_raw_hex: nameInspection.rawHexJoined,
        symbol_decode_failed: Boolean(symbolInspection.decodeFailed),
        symbol_raw_hex: symbolInspection.rawHexJoined,
      },
      name,
      symbol,
      tokenAddress: normalizedTokenAddress,
      totalSupply,
    };
  };

  if (forceRefresh) {
    metadataCache.delete(normalizedTokenAddress);
    return loader();
  }

  return metadataCache.getOrLoad(normalizedTokenAddress, loader);
}

function resolveStringField(inspection, knownFallback) {
  if (inspection.decoded) {
    return inspection.decoded;
  }

  if (knownFallback) {
    return knownFallback;
  }

  return inspection.rawHexJoined ?? null;
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

async function upsertTokenMetadata(client, metadata) {
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
         last_refreshed_block = EXCLUDED.last_refreshed_block,
         last_refreshed_at = NOW(),
         metadata = EXCLUDED.metadata,
         updated_at = NOW()`,
    [
      metadata.tokenAddress,
      metadata.name,
      metadata.symbol,
      metadata.decimals === null ? null : toNumericString(metadata.decimals, 'token decimals'),
      metadata.totalSupply === null ? null : toNumericString(metadata.totalSupply, 'token total supply'),
      metadata.isVerified,
      metadata.refreshedAtBlock === null ? null : toNumericString(metadata.refreshedAtBlock, 'metadata refreshed at block'),
      JSON.stringify(metadata.metadata ?? {}),
    ],
  );
}

function didResolveDecimals(previous, metadata) {
  if (metadata.decimals === null) {
    return false;
  }

  if (!previous || previous.decimals === null) {
    return true;
  }

  return previous.decimals !== metadata.decimals;
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

function parseOptionalBigInt(value, fallbackValue) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallbackValue;
  }

  try {
    return BigInt(String(value).trim());
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
      console.log(`[phase4] meta-refresher received ${signal}, stopping after current batch.`);
    });
  }
}

if (require.main === module) {
  main().catch(async (error) => {
    console.error(`[phase4] meta-refresher fatal error: ${formatError(error)}`);
    try {
      await closePool();
    } finally {
      process.exitCode = 1;
    }
  });
}

module.exports = {
  refreshTokenMetadata,
};
