#!/usr/bin/env node
'use strict';

const { getCheckpoint } = require('../core/checkpoint');
const { knownErc20Cache } = require('../core/known-erc20-cache');
const { FINALITY_LANES, normalizeFinalityStatus } = require('../core/finality');
const { DEFAULT_SCALE, decimalStringToScaled, integerAmountToScaled, scaledMultiply, scaledToNumericString } = require('../lib/cairo/fixed-point');
const { toBigIntStrict, toNumericString } = require('../lib/cairo/bigint');

const ZERO_ADDRESS = `0x${'0'.repeat(64)}`;

function parseBoolean(value, fallbackValue = false) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallbackValue;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
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

function parseOptionalBigInt(value, fallbackValue = null) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallbackValue;
  }

  try {
    return BigInt(String(value).trim());
  } catch (error) {
    return fallbackValue;
  }
}

function formatError(error) {
  if (!error) {
    return 'unknown error';
  }

  return error.stack || error.message || String(error);
}

async function resolveAnalyticsWindow(client, {
  indexerKey,
  lane = FINALITY_LANES.ACCEPTED_ON_L2,
  requireL1 = false,
}) {
  const normalizedLane = normalizeFinalityStatus(lane);
  const l2Checkpoint = await getCheckpoint(client, { indexerKey, lane: FINALITY_LANES.ACCEPTED_ON_L2 });
  const l1Checkpoint = await getCheckpoint(client, { indexerKey, lane: FINALITY_LANES.ACCEPTED_ON_L1 });

  const laneCheckpoint = normalizedLane === FINALITY_LANES.ACCEPTED_ON_L1 ? l1Checkpoint : l2Checkpoint;
  const maxBlockNumber = requireL1
    ? (l1Checkpoint?.lastProcessedBlockNumber ?? null)
    : (laneCheckpoint?.lastProcessedBlockNumber ?? null);

  return {
    indexerKey,
    l1AnchorBlockNumber: l1Checkpoint?.lastProcessedBlockNumber ?? null,
    l2TipBlockNumber: l2Checkpoint?.lastProcessedBlockNumber ?? null,
    lane: normalizedLane,
    maxBlockNumber,
  };
}

async function loadTokenMarketContext(client, { lane, tokenAddresses }) {
  const normalizedAddresses = Array.from(new Set((tokenAddresses ?? []).filter(Boolean).map((value) => String(value).toLowerCase())));
  const context = new Map();

  for (const tokenAddress of normalizedAddresses) {
    const knownToken = knownErc20Cache.getToken(tokenAddress);
    if (!knownToken) {
      continue;
    }

    context.set(tokenAddress, {
      decimals: knownToken.decimals ?? null,
      isVerified: true,
      name: knownToken.name ?? null,
      priceIsStale: false,
      priceSource: null,
      priceUpdatedAtBlock: null,
      priceUsdScaled: null,
      symbol: knownToken.symbol ?? null,
      totalSupply: null,
    });
  }

  if (normalizedAddresses.length === 0) {
    return context;
  }

  const metadataResult = await client.query(
    `SELECT token_address,
            name,
            symbol,
            decimals,
            total_supply,
            is_verified
       FROM stark_token_metadata
      WHERE token_address = ANY($1::text[])`,
    [normalizedAddresses],
  );
  const priceResult = await client.query(
    `SELECT token_address,
            price_usd,
            price_source,
            price_is_stale,
            price_updated_at_block
       FROM stark_prices
      WHERE lane = $1
        AND token_address = ANY($2::text[])`,
    [lane, normalizedAddresses],
  );

  for (const row of metadataResult.rows) {
    const existing = context.get(row.token_address) ?? {};
    context.set(row.token_address, {
      ...existing,
      decimals: row.decimals === null ? existing.decimals ?? null : Number.parseInt(String(row.decimals), 10),
      isVerified: row.is_verified ?? existing.isVerified ?? false,
      name: row.name ?? existing.name ?? null,
      symbol: row.symbol ?? existing.symbol ?? null,
      totalSupply: row.total_supply === null ? existing.totalSupply ?? null : toBigIntStrict(row.total_supply, 'token total supply'),
    });
  }

  for (const row of priceResult.rows) {
    const existing = context.get(row.token_address) ?? {};
    context.set(row.token_address, {
      ...existing,
      priceIsStale: Boolean(row.price_is_stale),
      priceSource: row.price_source ?? null,
      priceUpdatedAtBlock: row.price_updated_at_block === null
        ? null
        : toBigIntStrict(row.price_updated_at_block, 'price updated at block'),
      priceUsdScaled: row.price_usd === null ? null : decimalStringToScaled(row.price_usd, DEFAULT_SCALE),
    });
  }

  return context;
}

function computeUsdValueFromRawAmount(rawAmount, tokenInfo, { allowStale = true } = {}) {
  if (!tokenInfo || tokenInfo.decimals === null || tokenInfo.decimals === undefined || tokenInfo.priceUsdScaled === null || tokenInfo.priceUsdScaled === undefined) {
    return null;
  }

  if (!allowStale && tokenInfo.priceIsStale) {
    return null;
  }

  const humanAmountScaled = integerAmountToScaled(rawAmount, tokenInfo.decimals, DEFAULT_SCALE);
  return scaledMultiply(humanAmountScaled, tokenInfo.priceUsdScaled, DEFAULT_SCALE);
}

function scaledOrNullToNumeric(value) {
  if (value === null || value === undefined) {
    return null;
  }

  return scaledToNumericString(value, DEFAULT_SCALE);
}

function sortByLineage(left, right) {
  if (left.blockNumber !== right.blockNumber) {
    return left.blockNumber < right.blockNumber ? -1 : 1;
  }

  if (left.transactionIndex !== right.transactionIndex) {
    return left.transactionIndex < right.transactionIndex ? -1 : 1;
  }

  const leftSourceEventIndex = left.sourceEventIndex ?? 0n;
  const rightSourceEventIndex = right.sourceEventIndex ?? 0n;
  if (leftSourceEventIndex !== rightSourceEventIndex) {
    return leftSourceEventIndex < rightSourceEventIndex ? -1 : 1;
  }

  const leftSequence = left.sequence ?? 0n;
  const rightSequence = right.sequence ?? 0n;
  if (leftSequence !== rightSequence) {
    return leftSequence < rightSequence ? -1 : 1;
  }

  return 0;
}

async function replaceLeaderboards(client, {
  asOfBlockNumber,
  lane,
  leaderboardName,
  rows,
}) {
  await client.query(
    `DELETE FROM stark_leaderboards
      WHERE lane = $1
        AND leaderboard_name = $2`,
    [lane, leaderboardName],
  );

  for (const row of rows) {
    await client.query(
      `INSERT INTO stark_leaderboards (
           lane,
           leaderboard_name,
           entity_type,
           entity_key,
           rank,
           metric_value,
           as_of_block_number,
           metadata,
           created_at,
           updated_at
       ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8::jsonb, NOW(), NOW()
       )`,
      [
        lane,
        leaderboardName,
        row.entityType,
        row.entityKey,
        toNumericString(row.rank, 'leaderboard rank'),
        row.metricValue,
        toNumericString(asOfBlockNumber, 'leaderboard block number'),
        JSON.stringify(row.metadata ?? {}),
      ],
    );
  }
}

module.exports = {
  ZERO_ADDRESS,
  computeUsdValueFromRawAmount,
  formatError,
  loadTokenMarketContext,
  parseBoolean,
  parseOptionalBigInt,
  parsePositiveInteger,
  replaceLeaderboards,
  resolveAnalyticsWindow,
  scaledOrNullToNumeric,
  sortByLineage,
};
