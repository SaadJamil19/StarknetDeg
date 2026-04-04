'use strict';

const { toBigIntStrict, toNumericString } = require('../lib/cairo/bigint');
const { DEFAULT_SCALE, decimalStringToScaled, scaledToNumericString } = require('../lib/cairo/fixed-point');
const { toJsonbString } = require('./protocols/shared');

async function persistPriceDataForBlock(client, { priceCandidates }) {
  if (!priceCandidates || priceCandidates.length === 0) {
    return {
      realtimePriceTicks: [],
      summary: {
        latestPrices: 0,
        priceTicks: 0,
        stalePrices: 0,
      },
    };
  }

  const staleAfterBlocks = parsePositiveBigInt(process.env.PHASE3_PRICE_STALE_AFTER_BLOCKS, 600n);
  const normalizedCandidates = normalizeCandidates(priceCandidates, staleAfterBlocks);
  const sortedCandidates = [...normalizedCandidates].sort(compareCandidates);

  for (const candidate of sortedCandidates) {
    await insertPriceTick(client, candidate);
    await upsertLatestPrice(client, candidate);
  }

  return {
    realtimePriceTicks: sortedCandidates.map(serializeRealtimeTick),
    summary: {
      latestPrices: sortedCandidates.length,
      priceTicks: sortedCandidates.length,
      stalePrices: sortedCandidates.filter((candidate) => candidate.priceIsStale).length,
    },
  };
}

async function resetLatestPricesForBlock(client, { blockNumber, lane }) {
  const numericBlockNumber = toNumericString(blockNumber, 'price reset block number');
  const affectedTokenAddresses = await collectAffectedTokenAddresses(client, {
    blockNumber: numericBlockNumber,
    lane,
  });

  await client.query(
    `DELETE FROM stark_price_ticks
      WHERE lane = $1
        AND block_number = $2`,
    [lane, numericBlockNumber],
  );

  await client.query(
    `DELETE FROM stark_prices
      WHERE lane = $1
        AND block_number = $2`,
    [lane, numericBlockNumber],
  );

  for (const tokenAddress of affectedTokenAddresses) {
    const restored = await loadLatestPriceTick(client, { lane, tokenAddress });
    if (!restored) {
      await client.query(
        `DELETE FROM stark_prices
          WHERE lane = $1
            AND token_address = $2`,
        [lane, tokenAddress],
      );
      continue;
    }

    await upsertLatestPrice(client, restored);
  }
}

function normalizeCandidates(priceCandidates, staleAfterBlocks) {
  return priceCandidates.map((candidate) => {
    const blockNumber = toBigIntStrict(candidate.blockNumber, 'price candidate block number');
    const updatedAtBlock = candidate.priceUpdatedAtBlock === undefined || candidate.priceUpdatedAtBlock === null
      ? blockNumber
      : toBigIntStrict(candidate.priceUpdatedAtBlock, 'price updated at block');
    const blockGap = blockNumber - updatedAtBlock;
    const priceIsStale = Boolean(candidate.priceIsStale) || blockGap > staleAfterBlocks;

    return {
      ...candidate,
      blockNumber,
      priceIsStale,
      priceUpdatedAtBlock: updatedAtBlock,
      sourceEventIndex: toBigIntStrict(candidate.sourceEventIndex, 'price candidate source event index'),
      transactionIndex: toBigIntStrict(candidate.transactionIndex, 'price candidate transaction index'),
    };
  });
}

async function collectAffectedTokenAddresses(client, { blockNumber, lane }) {
  const result = await client.query(
    `SELECT DISTINCT token_address
       FROM (
             SELECT token_address
               FROM stark_price_ticks
              WHERE lane = $1
                AND block_number = $2
             UNION
             SELECT token_address
               FROM stark_prices
              WHERE lane = $1
                AND block_number = $2
       ) AS affected`,
    [lane, blockNumber],
  );

  return result.rows.map((row) => row.token_address);
}

async function loadLatestPriceTick(client, { lane, tokenAddress }) {
  const result = await client.query(
    `SELECT lane,
            block_number,
            block_hash,
            block_timestamp,
            transaction_hash,
            transaction_index,
            source_event_index,
            token_address,
            source_pool_id,
            quote_token_address,
            price_quote,
            price_usd,
            price_source,
            price_is_stale,
            price_updated_at_block,
            metadata
       FROM stark_price_ticks
      WHERE lane = $1
        AND token_address = $2
      ORDER BY block_number DESC, transaction_index DESC, source_event_index DESC
      LIMIT 1`,
    [lane, tokenAddress],
  );

  if (result.rowCount === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    blockHash: row.block_hash,
    blockNumber: toBigIntStrict(row.block_number, 'restored latest price block number'),
    blockTimestampDate: row.block_timestamp,
    lane: row.lane,
    metadata: row.metadata ?? {},
    poolId: row.source_pool_id,
    priceIsStale: row.price_is_stale,
    priceQuoteScaled: row.price_quote === null ? null : decimalStringToScaled(row.price_quote, DEFAULT_SCALE),
    priceSource: row.price_source,
    priceUpdatedAtBlock: toBigIntStrict(row.price_updated_at_block, 'restored price updated at block'),
    priceUsdScaled: decimalStringToScaled(row.price_usd, DEFAULT_SCALE),
    quoteTokenAddress: row.quote_token_address,
    sourceEventIndex: toBigIntStrict(row.source_event_index, 'restored latest price source event index'),
    tokenAddress: row.token_address,
    transactionHash: row.transaction_hash,
    transactionIndex: toBigIntStrict(row.transaction_index, 'restored latest price transaction index'),
  };
}

function compareCandidates(left, right) {
  if (left.blockNumber !== right.blockNumber) {
    return left.blockNumber < right.blockNumber ? -1 : 1;
  }

  if (left.transactionIndex !== right.transactionIndex) {
    return left.transactionIndex < right.transactionIndex ? -1 : 1;
  }

  if (left.sourceEventIndex !== right.sourceEventIndex) {
    return left.sourceEventIndex < right.sourceEventIndex ? -1 : 1;
  }

  if (left.tokenAddress === right.tokenAddress) {
    return 0;
  }

  return left.tokenAddress < right.tokenAddress ? -1 : 1;
}

async function insertPriceTick(client, candidate) {
  await client.query(
    `INSERT INTO stark_price_ticks (
         tick_key,
         lane,
         block_number,
         block_hash,
         block_timestamp,
         transaction_hash,
         transaction_index,
         source_event_index,
         token_address,
         source_pool_id,
         quote_token_address,
         price_quote,
         price_usd,
         price_source,
         price_is_stale,
         price_updated_at_block,
         bucket_1m,
         metadata,
         created_at,
         updated_at
     ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, $12, $13, $14, $15, $16, $17, $18::jsonb, NOW(), NOW()
     )
     ON CONFLICT (lane, token_address, transaction_hash, source_event_index, source_pool_id)
     DO UPDATE SET
         block_hash = EXCLUDED.block_hash,
         block_timestamp = EXCLUDED.block_timestamp,
         transaction_index = EXCLUDED.transaction_index,
         quote_token_address = EXCLUDED.quote_token_address,
         price_quote = EXCLUDED.price_quote,
         price_usd = EXCLUDED.price_usd,
         price_source = EXCLUDED.price_source,
         price_is_stale = EXCLUDED.price_is_stale,
         price_updated_at_block = EXCLUDED.price_updated_at_block,
         bucket_1m = EXCLUDED.bucket_1m,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()`,
    [
      buildTickKey(candidate),
      candidate.lane,
      toNumericString(candidate.blockNumber, 'price tick block number'),
      candidate.blockHash,
      candidate.blockTimestampDate,
      candidate.transactionHash,
      toNumericString(candidate.transactionIndex, 'price tick transaction index'),
      toNumericString(candidate.sourceEventIndex, 'price tick source event index'),
      candidate.tokenAddress,
      candidate.poolId ?? null,
      candidate.quoteTokenAddress ?? null,
      candidate.priceQuoteScaled === null ? null : scaledToNumericString(candidate.priceQuoteScaled, DEFAULT_SCALE),
      scaledToNumericString(candidate.priceUsdScaled, DEFAULT_SCALE),
      candidate.priceSource,
      candidate.priceIsStale,
      toNumericString(candidate.priceUpdatedAtBlock, 'price updated at block'),
      floorToMinute(candidate.blockTimestampDate),
      toJsonbString(candidate.metadata ?? {}),
    ],
  );
}

async function upsertLatestPrice(client, candidate) {
  await client.query(
    `INSERT INTO stark_prices (
         lane,
         token_address,
         block_number,
         block_hash,
         block_timestamp,
         transaction_hash,
         transaction_index,
         source_event_index,
         source_pool_id,
         quote_token_address,
         price_quote,
         price_usd,
         price_source,
         price_is_stale,
         price_updated_at_block,
         metadata,
         created_at,
         updated_at
     ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, $12, $13, $14, $15, $16::jsonb, NOW(), NOW()
     )
     ON CONFLICT (lane, token_address)
     DO UPDATE SET
         block_number = EXCLUDED.block_number,
         block_hash = EXCLUDED.block_hash,
         block_timestamp = EXCLUDED.block_timestamp,
         transaction_hash = EXCLUDED.transaction_hash,
         transaction_index = EXCLUDED.transaction_index,
         source_event_index = EXCLUDED.source_event_index,
         source_pool_id = EXCLUDED.source_pool_id,
         quote_token_address = EXCLUDED.quote_token_address,
         price_quote = EXCLUDED.price_quote,
         price_usd = EXCLUDED.price_usd,
         price_source = EXCLUDED.price_source,
         price_is_stale = EXCLUDED.price_is_stale,
         price_updated_at_block = EXCLUDED.price_updated_at_block,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()
     WHERE stark_prices.block_number < EXCLUDED.block_number
        OR (
             stark_prices.block_number = EXCLUDED.block_number
         AND (
              stark_prices.block_hash <> EXCLUDED.block_hash
              OR (EXCLUDED.transaction_index, EXCLUDED.source_event_index) >=
                 (stark_prices.transaction_index, stark_prices.source_event_index)
         )
        )`,
    [
      candidate.lane,
      candidate.tokenAddress,
      toNumericString(candidate.blockNumber, 'latest price block number'),
      candidate.blockHash,
      candidate.blockTimestampDate,
      candidate.transactionHash,
      toNumericString(candidate.transactionIndex, 'latest price transaction index'),
      toNumericString(candidate.sourceEventIndex, 'latest price source event index'),
      candidate.poolId ?? null,
      candidate.quoteTokenAddress ?? null,
      candidate.priceQuoteScaled === null ? null : scaledToNumericString(candidate.priceQuoteScaled, DEFAULT_SCALE),
      scaledToNumericString(candidate.priceUsdScaled, DEFAULT_SCALE),
      candidate.priceSource,
      candidate.priceIsStale,
      toNumericString(candidate.priceUpdatedAtBlock, 'price updated at block'),
      toJsonbString(candidate.metadata ?? {}),
    ],
  );
}

function buildTickKey(candidate) {
  return [
    candidate.lane,
    candidate.tokenAddress,
    candidate.poolId ?? 'global',
    candidate.transactionHash,
    candidate.sourceEventIndex.toString(10),
  ].join(':');
}

function serializeRealtimeTick(candidate) {
  return {
    blockNumber: candidate.blockNumber.toString(10),
    blockTimestamp: candidate.blockTimestampDate.toISOString(),
    lane: candidate.lane,
    poolId: candidate.poolId,
    priceIsStale: candidate.priceIsStale,
    priceQuote: candidate.priceQuoteScaled === null ? null : scaledToNumericString(candidate.priceQuoteScaled, DEFAULT_SCALE),
    priceSource: candidate.priceSource,
    priceUpdatedAtBlock: candidate.priceUpdatedAtBlock.toString(10),
    priceUsd: scaledToNumericString(candidate.priceUsdScaled, DEFAULT_SCALE),
    quoteTokenAddress: candidate.quoteTokenAddress,
    sourceEventIndex: candidate.sourceEventIndex.toString(10),
    tokenAddress: candidate.tokenAddress,
    transactionHash: candidate.transactionHash,
    transactionIndex: candidate.transactionIndex.toString(10),
  };
}

function floorToMinute(date) {
  return new Date(Math.floor(date.getTime() / 60_000) * 60_000);
}

function parsePositiveBigInt(value, fallbackValue) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallbackValue;
  }

  const parsed = BigInt(String(value).trim());
  return parsed > 0n ? parsed : fallbackValue;
}

module.exports = {
  persistPriceDataForBlock,
  resetLatestPricesForBlock,
};
