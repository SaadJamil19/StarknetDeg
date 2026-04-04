'use strict';

const { knownErc20Cache } = require('./known-erc20-cache');
const { toJsonbString } = require('./protocols/shared');
const { toBigIntStrict, toNumericString } = require('../lib/cairo/bigint');
const {
  DEFAULT_SCALE,
  decimalStringToScaled,
  integerAmountToScaled,
  scaledMultiply,
  scaledRatio,
  scaledToNumericString,
} = require('../lib/cairo/fixed-point');

async function persistPoolStateForBlock(client, { blockNumber, blockTimestampDate, lane, latestUsdByToken }) {
  const actions = await loadPoolStateActions(client, { blockNumber, lane });

  if (actions.length === 0) {
    return {
      realtimePoolState: [],
      summary: {
        poolHistoryRows: 0,
        poolLatestRows: 0,
      },
    };
  }

  const snapshots = [];
  const latestByPool = new Map();

  for (const action of actions) {
    action.blockTimestampDate = blockTimestampDate;
    const snapshot = derivePoolSnapshot(action, latestUsdByToken);
    if (!snapshot) {
      continue;
    }

    snapshots.push(snapshot);
    latestByPool.set(`${snapshot.lane}:${snapshot.poolId}`, snapshot);
    await insertPoolStateHistory(client, snapshot);
  }

  const latestRows = Array.from(latestByPool.values()).sort(compareSnapshots);
  for (const row of latestRows) {
    await upsertPoolLatest(client, row);
  }

  return {
    realtimePoolState: latestRows.map(serializeRealtimePoolState),
    summary: {
      poolHistoryRows: snapshots.length,
      poolLatestRows: latestRows.length,
    },
  };
}

async function resetPoolStateForBlock(client, { blockNumber, lane }) {
  const numericBlockNumber = toNumericString(blockNumber, 'pool state reset block number');
  const affectedPoolIds = await collectAffectedPoolIds(client, { blockNumber: numericBlockNumber, lane });

  await client.query(
    `DELETE FROM stark_pool_state_history
      WHERE lane = $1
        AND block_number = $2`,
    [lane, numericBlockNumber],
  );

  await client.query(
    `DELETE FROM stark_pool_latest
      WHERE lane = $1
        AND block_number = $2`,
    [lane, numericBlockNumber],
  );

  for (const poolId of affectedPoolIds) {
    const restored = await loadLatestHistorySnapshot(client, { lane, poolId });
    if (!restored) {
      await client.query(
        `DELETE FROM stark_pool_latest
          WHERE lane = $1
            AND pool_id = $2`,
        [lane, poolId],
      );
      continue;
    }

    await upsertPoolLatest(client, restored);
  }
}

async function collectAffectedPoolIds(client, { blockNumber, lane }) {
  const result = await client.query(
    `SELECT DISTINCT pool_id
       FROM (
             SELECT pool_id
               FROM stark_pool_state_history
              WHERE lane = $1
                AND block_number = $2
             UNION
             SELECT pool_id
               FROM stark_pool_latest
              WHERE lane = $1
                AND block_number = $2
       ) AS affected`,
    [lane, blockNumber],
  );

  return result.rows.map((row) => row.pool_id);
}

async function loadLatestHistorySnapshot(client, { lane, poolId }) {
  const result = await client.query(
    `SELECT lane,
            pool_id,
            protocol,
            token0_address,
            token1_address,
            block_number,
            block_hash,
            block_timestamp,
            transaction_hash,
            transaction_index,
            source_event_index,
            reserve0,
            reserve1,
            liquidity,
            sqrt_ratio,
            price_token1_per_token0,
            price_token0_per_token1,
            price_is_decimals_normalized,
            tvl_usd,
            snapshot_kind,
            metadata
       FROM stark_pool_state_history
      WHERE lane = $1
        AND pool_id = $2
      ORDER BY block_number DESC, transaction_index DESC, source_event_index DESC
      LIMIT 1`,
    [lane, poolId],
  );

  if (result.rowCount === 0) {
    return null;
  }

  return mapHistoryRowToSnapshot(result.rows[0]);
}

function compareSnapshots(left, right) {
  if (left.blockNumber !== right.blockNumber) {
    return left.blockNumber < right.blockNumber ? -1 : 1;
  }

  if (left.transactionIndex !== right.transactionIndex) {
    return left.transactionIndex < right.transactionIndex ? -1 : 1;
  }

  if (left.sourceEventIndex !== right.sourceEventIndex) {
    return left.sourceEventIndex < right.sourceEventIndex ? -1 : 1;
  }

  if (left.poolId === right.poolId) {
    return 0;
  }

  return left.poolId < right.poolId ? -1 : 1;
}

function derivePoolSnapshot(action, latestUsdByToken) {
  if (action.protocol === 'jediswap' && action.actionType === 'sync') {
    return deriveJediswapSyncSnapshot(action, latestUsdByToken);
  }

  if (action.protocol === 'ekubo' && action.actionType === 'swap') {
    return deriveEkuboSwapSnapshot(action);
  }

  return null;
}

function deriveJediswapSyncSnapshot(action, latestUsdByToken) {
  const reserve0 = toBigIntStrict(action.amount0, 'jediswap reserve0');
  const reserve1 = toBigIntStrict(action.amount1, 'jediswap reserve1');
  const token0 = knownErc20Cache.getToken(action.token0Address);
  const token1 = knownErc20Cache.getToken(action.token1Address);
  const canNormalizePrice = token0?.decimals !== undefined && token0?.decimals !== null && token1?.decimals !== undefined && token1?.decimals !== null;
  const exponent = canNormalizePrice ? token0.decimals - token1.decimals : 0;
  const inverseExponent = canNormalizePrice ? token1.decimals - token0.decimals : 0;

  return {
    blockHash: action.blockHash,
    blockNumber: action.blockNumber,
    blockTimestampDate: action.blockTimestampDate,
    lane: action.lane,
    liquidity: null,
    metadata: {
      protocol: 'jediswap',
      snapshot_kind: 'sync',
    },
    poolId: action.poolId,
    poolStateKey: buildPoolStateKey(action),
    priceIsDecimalsNormalized: canNormalizePrice,
    priceToken0PerToken1Scaled: reserve1 === 0n ? null : scaledRatio(reserve0, reserve1, inverseExponent, DEFAULT_SCALE),
    priceToken1PerToken0Scaled: reserve0 === 0n ? null : scaledRatio(reserve1, reserve0, exponent, DEFAULT_SCALE),
    protocol: action.protocol,
    reserve0,
    reserve1,
    snapshotKind: 'sync',
    sourceEventIndex: action.sourceEventIndex,
    sqrtRatio: null,
    token0Address: action.token0Address,
    token1Address: action.token1Address,
    transactionHash: action.transactionHash,
    transactionIndex: action.transactionIndex,
    tvlUsdScaled: deriveTvlUsd({
      latestUsdByToken,
      reserve0,
      reserve1,
      token0,
      token0Address: action.token0Address,
      token1,
      token1Address: action.token1Address,
    }),
  };
}

function deriveEkuboSwapSnapshot(action) {
  const numerator = action.metadata?.price_ratio_numerator;
  const denominator = action.metadata?.price_ratio_denominator;

  if (numerator === undefined || denominator === undefined) {
    return null;
  }

  const token0 = knownErc20Cache.getToken(action.token0Address);
  const token1 = knownErc20Cache.getToken(action.token1Address);
  const canNormalizePrice = token0?.decimals !== undefined && token0?.decimals !== null && token1?.decimals !== undefined && token1?.decimals !== null;
  const exponent = canNormalizePrice ? token0.decimals - token1.decimals : 0;
  const inverseExponent = canNormalizePrice ? token1.decimals - token0.decimals : 0;
  const ratioNumerator = toBigIntStrict(numerator, 'ekubo price numerator');
  const ratioDenominator = toBigIntStrict(denominator, 'ekubo price denominator');

  return {
    blockHash: action.blockHash,
    blockNumber: action.blockNumber,
    blockTimestampDate: action.blockTimestampDate,
    lane: action.lane,
    liquidity: action.metadata?.liquidity_after === undefined ? null : toBigIntStrict(action.metadata.liquidity_after, 'ekubo liquidity after'),
    metadata: {
      protocol: 'ekubo',
      receipt_context_id: action.metadata?.receipt_context_id ?? null,
      snapshot_kind: 'swap',
    },
    poolId: action.poolId,
    poolStateKey: buildPoolStateKey(action),
    priceIsDecimalsNormalized: canNormalizePrice,
    priceToken0PerToken1Scaled: scaledRatio(ratioDenominator, ratioNumerator, inverseExponent, DEFAULT_SCALE),
    priceToken1PerToken0Scaled: scaledRatio(ratioNumerator, ratioDenominator, exponent, DEFAULT_SCALE),
    protocol: action.protocol,
    reserve0: null,
    reserve1: null,
    snapshotKind: 'swap',
    sourceEventIndex: action.sourceEventIndex,
    sqrtRatio: action.metadata?.sqrt_ratio_after === undefined ? null : toBigIntStrict(action.metadata.sqrt_ratio_after, 'ekubo sqrt ratio after'),
    token0Address: action.token0Address,
    token1Address: action.token1Address,
    transactionHash: action.transactionHash,
    transactionIndex: action.transactionIndex,
    tvlUsdScaled: null,
  };
}

function deriveTvlUsd({ latestUsdByToken, reserve0, reserve1, token0, token0Address, token1, token1Address }) {
  const price0 = latestUsdByToken.get(token0Address) ?? null;
  const price1 = latestUsdByToken.get(token1Address) ?? null;

  if (token0?.decimals === undefined || token0?.decimals === null || token1?.decimals === undefined || token1?.decimals === null) {
    return null;
  }

  if (price0 === null || price1 === null) {
    return null;
  }

  const reserve0Human = integerAmountToScaled(reserve0, token0.decimals, DEFAULT_SCALE);
  const reserve1Human = integerAmountToScaled(reserve1, token1.decimals, DEFAULT_SCALE);

  return scaledMultiply(reserve0Human, price0, DEFAULT_SCALE) + scaledMultiply(reserve1Human, price1, DEFAULT_SCALE);
}

async function loadPoolStateActions(client, { blockNumber, lane }) {
  const result = await client.query(
    `SELECT lane,
            block_hash,
            block_number,
            transaction_hash,
            transaction_index,
            source_event_index,
            protocol,
            action_type,
            pool_id,
            token0_address,
            token1_address,
            amount0,
            amount1,
            metadata
       FROM stark_action_norm
      WHERE lane = $1
        AND block_number = $2
        AND (
             (protocol = 'jediswap' AND action_type = 'sync')
          OR (protocol = 'ekubo' AND action_type = 'swap')
        )
      ORDER BY transaction_index ASC, source_event_index ASC, action_key ASC`,
    [lane, toNumericString(blockNumber, 'pool state block number')],
  );

  return result.rows.map((row) => ({
    actionType: row.action_type,
    amount0: row.amount0,
    amount1: row.amount1,
    blockHash: row.block_hash,
    blockNumber: toBigIntStrict(row.block_number, 'pool state row block number'),
    blockTimestampDate: null,
    lane: row.lane,
    metadata: row.metadata ?? {},
    poolId: row.pool_id,
    protocol: row.protocol,
    sourceEventIndex: toBigIntStrict(row.source_event_index, 'pool state source event index'),
    token0Address: row.token0_address,
    token1Address: row.token1_address,
    transactionHash: row.transaction_hash,
    transactionIndex: toBigIntStrict(row.transaction_index, 'pool state transaction index'),
  }));
}

async function insertPoolStateHistory(client, snapshot) {
  await client.query(
    `INSERT INTO stark_pool_state_history (
         pool_state_key,
         lane,
         pool_id,
         protocol,
         token0_address,
         token1_address,
         block_number,
         block_hash,
         block_timestamp,
         transaction_hash,
         transaction_index,
         source_event_index,
         reserve0,
         reserve1,
         liquidity,
         sqrt_ratio,
         price_token1_per_token0,
         price_token0_per_token1,
         price_is_decimals_normalized,
         tvl_usd,
         snapshot_kind,
         metadata,
         created_at,
         updated_at
     ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, NOW()), $10,
         $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
         $21, $22::jsonb, NOW(), NOW()
     )
     ON CONFLICT (pool_state_key)
     DO UPDATE SET
         reserve0 = EXCLUDED.reserve0,
         reserve1 = EXCLUDED.reserve1,
         liquidity = EXCLUDED.liquidity,
         sqrt_ratio = EXCLUDED.sqrt_ratio,
         price_token1_per_token0 = EXCLUDED.price_token1_per_token0,
         price_token0_per_token1 = EXCLUDED.price_token0_per_token1,
         price_is_decimals_normalized = EXCLUDED.price_is_decimals_normalized,
         tvl_usd = EXCLUDED.tvl_usd,
         snapshot_kind = EXCLUDED.snapshot_kind,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()`,
    [
      snapshot.poolStateKey,
      snapshot.lane,
      snapshot.poolId,
      snapshot.protocol,
      snapshot.token0Address,
      snapshot.token1Address,
      toNumericString(snapshot.blockNumber, 'pool history block number'),
      snapshot.blockHash,
      snapshot.blockTimestampDate,
      snapshot.transactionHash,
      toNumericString(snapshot.transactionIndex, 'pool history transaction index'),
      toNumericString(snapshot.sourceEventIndex, 'pool history source event index'),
      snapshot.reserve0 === null ? null : toNumericString(snapshot.reserve0, 'pool reserve0'),
      snapshot.reserve1 === null ? null : toNumericString(snapshot.reserve1, 'pool reserve1'),
      snapshot.liquidity === null ? null : toNumericString(snapshot.liquidity, 'pool liquidity'),
      snapshot.sqrtRatio === null ? null : toNumericString(snapshot.sqrtRatio, 'pool sqrt ratio'),
      snapshot.priceToken1PerToken0Scaled === null ? null : scaledToNumericString(snapshot.priceToken1PerToken0Scaled, DEFAULT_SCALE),
      snapshot.priceToken0PerToken1Scaled === null ? null : scaledToNumericString(snapshot.priceToken0PerToken1Scaled, DEFAULT_SCALE),
      snapshot.priceIsDecimalsNormalized,
      snapshot.tvlUsdScaled === null ? null : scaledToNumericString(snapshot.tvlUsdScaled, DEFAULT_SCALE),
      snapshot.snapshotKind,
      toJsonbString(snapshot.metadata ?? {}),
    ],
  );
}

async function upsertPoolLatest(client, snapshot) {
  await client.query(
    `INSERT INTO stark_pool_latest (
         lane,
         pool_id,
         protocol,
         token0_address,
         token1_address,
         block_number,
         block_hash,
         block_timestamp,
         transaction_hash,
         transaction_index,
         source_event_index,
         reserve0,
         reserve1,
         liquidity,
         sqrt_ratio,
         price_token1_per_token0,
         price_token0_per_token1,
         price_is_decimals_normalized,
         tvl_usd,
         snapshot_kind,
         metadata,
         created_at,
         updated_at
     ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, COALESCE($8, NOW()), $9, $10,
         $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
         $21::jsonb, NOW(), NOW()
     )
     ON CONFLICT (lane, pool_id)
     DO UPDATE SET
         protocol = EXCLUDED.protocol,
         token0_address = EXCLUDED.token0_address,
         token1_address = EXCLUDED.token1_address,
         block_number = EXCLUDED.block_number,
         block_hash = EXCLUDED.block_hash,
         block_timestamp = EXCLUDED.block_timestamp,
         transaction_hash = EXCLUDED.transaction_hash,
         transaction_index = EXCLUDED.transaction_index,
         source_event_index = EXCLUDED.source_event_index,
         reserve0 = EXCLUDED.reserve0,
         reserve1 = EXCLUDED.reserve1,
         liquidity = EXCLUDED.liquidity,
         sqrt_ratio = EXCLUDED.sqrt_ratio,
         price_token1_per_token0 = EXCLUDED.price_token1_per_token0,
         price_token0_per_token1 = EXCLUDED.price_token0_per_token1,
         price_is_decimals_normalized = EXCLUDED.price_is_decimals_normalized,
         tvl_usd = EXCLUDED.tvl_usd,
         snapshot_kind = EXCLUDED.snapshot_kind,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()
     WHERE stark_pool_latest.block_number < EXCLUDED.block_number
        OR (
             stark_pool_latest.block_number = EXCLUDED.block_number
         AND (
              stark_pool_latest.block_hash <> EXCLUDED.block_hash
              OR (EXCLUDED.transaction_index, EXCLUDED.source_event_index) >=
                 (stark_pool_latest.transaction_index, stark_pool_latest.source_event_index)
         )
        )`,
    [
      snapshot.lane,
      snapshot.poolId,
      snapshot.protocol,
      snapshot.token0Address,
      snapshot.token1Address,
      toNumericString(snapshot.blockNumber, 'pool latest block number'),
      snapshot.blockHash,
      snapshot.blockTimestampDate,
      snapshot.transactionHash,
      toNumericString(snapshot.transactionIndex, 'pool latest transaction index'),
      toNumericString(snapshot.sourceEventIndex, 'pool latest source event index'),
      snapshot.reserve0 === null ? null : toNumericString(snapshot.reserve0, 'pool reserve0'),
      snapshot.reserve1 === null ? null : toNumericString(snapshot.reserve1, 'pool reserve1'),
      snapshot.liquidity === null ? null : toNumericString(snapshot.liquidity, 'pool liquidity'),
      snapshot.sqrtRatio === null ? null : toNumericString(snapshot.sqrtRatio, 'pool sqrt ratio'),
      snapshot.priceToken1PerToken0Scaled === null ? null : scaledToNumericString(snapshot.priceToken1PerToken0Scaled, DEFAULT_SCALE),
      snapshot.priceToken0PerToken1Scaled === null ? null : scaledToNumericString(snapshot.priceToken0PerToken1Scaled, DEFAULT_SCALE),
      snapshot.priceIsDecimalsNormalized,
      snapshot.tvlUsdScaled === null ? null : scaledToNumericString(snapshot.tvlUsdScaled, DEFAULT_SCALE),
      snapshot.snapshotKind,
      toJsonbString(snapshot.metadata ?? {}),
    ],
  );
}

function mapHistoryRowToSnapshot(row) {
  return {
    blockHash: row.block_hash,
    blockNumber: toBigIntStrict(row.block_number, 'latest history block number'),
    blockTimestampDate: row.block_timestamp,
    lane: row.lane,
    liquidity: row.liquidity === null ? null : toBigIntStrict(row.liquidity, 'latest history liquidity'),
    metadata: row.metadata ?? {},
    poolId: row.pool_id,
    poolStateKey: `${row.lane}:${row.pool_id}:${row.transaction_hash}:${row.source_event_index}`,
    priceIsDecimalsNormalized: row.price_is_decimals_normalized,
    priceToken0PerToken1Scaled: row.price_token0_per_token1 === null ? null : decimalStringToScaled(row.price_token0_per_token1, DEFAULT_SCALE),
    priceToken1PerToken0Scaled: row.price_token1_per_token0 === null ? null : decimalStringToScaled(row.price_token1_per_token0, DEFAULT_SCALE),
    protocol: row.protocol,
    reserve0: row.reserve0 === null ? null : toBigIntStrict(row.reserve0, 'latest history reserve0'),
    reserve1: row.reserve1 === null ? null : toBigIntStrict(row.reserve1, 'latest history reserve1'),
    snapshotKind: row.snapshot_kind,
    sourceEventIndex: toBigIntStrict(row.source_event_index, 'latest history source event index'),
    sqrtRatio: row.sqrt_ratio === null ? null : toBigIntStrict(row.sqrt_ratio, 'latest history sqrt ratio'),
    token0Address: row.token0_address,
    token1Address: row.token1_address,
    transactionHash: row.transaction_hash,
    transactionIndex: toBigIntStrict(row.transaction_index, 'latest history transaction index'),
    tvlUsdScaled: row.tvl_usd === null ? null : decimalStringToScaled(row.tvl_usd, DEFAULT_SCALE),
  };
}

function buildPoolStateKey(action) {
  return `${action.lane}:${action.poolId}:${action.transactionHash}:${action.sourceEventIndex.toString(10)}`;
}

function serializeRealtimePoolState(snapshot) {
  return {
    blockNumber: snapshot.blockNumber.toString(10),
    lane: snapshot.lane,
    poolId: snapshot.poolId,
    priceToken0PerToken1: snapshot.priceToken0PerToken1Scaled === null ? null : scaledToNumericString(snapshot.priceToken0PerToken1Scaled, DEFAULT_SCALE),
    priceToken1PerToken0: snapshot.priceToken1PerToken0Scaled === null ? null : scaledToNumericString(snapshot.priceToken1PerToken0Scaled, DEFAULT_SCALE),
    protocol: snapshot.protocol,
    reserve0: snapshot.reserve0 === null ? null : snapshot.reserve0.toString(10),
    reserve1: snapshot.reserve1 === null ? null : snapshot.reserve1.toString(10),
    snapshotKind: snapshot.snapshotKind,
    sourceEventIndex: snapshot.sourceEventIndex.toString(10),
    token0Address: snapshot.token0Address,
    token1Address: snapshot.token1Address,
    transactionHash: snapshot.transactionHash,
    transactionIndex: snapshot.transactionIndex.toString(10),
    tvlUsd: snapshot.tvlUsdScaled === null ? null : scaledToNumericString(snapshot.tvlUsdScaled, DEFAULT_SCALE),
  };
}

module.exports = {
  persistPoolStateForBlock,
  resetPoolStateForBlock,
};
