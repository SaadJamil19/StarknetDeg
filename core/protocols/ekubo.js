'use strict';

const { SELECTORS } = require('../../lib/registry/dex-registry');
const {
  buildPoolKeyId,
  normalizeAddress,
  normalizeBoolFromFelt,
  parseI129FromArray,
  parseU128,
  parseU256FromArray,
  sqrtRatioToPriceRatio,
} = require('../normalize');
const { buildActionKey, normalizeActionMetadata } = require('./shared');

const EXPECTED_LENGTHS = Object.freeze({
  FEES_ACCUMULATED: 7,
  LOADED_BALANCE: 4,
  POOL_INITIALIZED: 9,
  POSITION_FEES_COLLECTED: 15,
  POSITION_UPDATED: 17,
  SAVED_BALANCE: 4,
  SWAPPED: 21,
});

function decodeEvent({ tx, event, receiptContext }) {
  const state = getEkuboState(receiptContext);

  switch (event.selector) {
    case SELECTORS.EKUBO_SWAPPED:
      return decodeSwapped(tx, event, state);
    case SELECTORS.EKUBO_POSITION_UPDATED:
      return decodePositionUpdated(tx, event, state);
    case SELECTORS.EKUBO_POOL_INITIALIZED:
      return decodePoolInitialized(tx, event, state);
    case SELECTORS.EKUBO_FEES_ACCUMULATED:
      return decodeFeesAccumulated(tx, event, state);
    case SELECTORS.EKUBO_POSITION_FEES_COLLECTED:
      return decodePositionFeesCollected(tx, event, state);
    case SELECTORS.EKUBO_SAVED_BALANCE:
      return decodeSavedBalance(tx, event, state);
    case SELECTORS.EKUBO_LOADED_BALANCE:
      return decodeLoadedBalance(tx, event, state);
    default:
      return emptyResult();
  }
}

function flushReceiptContext({ tx, receiptContext }) {
  const state = receiptContext;
  if (!state || state.ordered.length === 0) {
    return emptyResult();
  }

  const actions = [];
  let sequence = 0;

  for (const item of state.ordered) {
    if (item.kind === 'swap') {
      actions.push(buildSwapAction(tx, item, state, sequence));
      sequence += 1;
      continue;
    }

    if (item.kind === 'position_update') {
      actions.push(buildPositionUpdateAction(tx, item, state, sequence));
      sequence += 1;
    }
  }

  return {
    actions,
    audits: [],
    transfers: [],
  };
}

function decodeSwapped(tx, event, state) {
  if (!Array.isArray(event.data) || event.data.length < EXPECTED_LENGTHS.SWAPPED) {
    return auditResult(tx, event, 'EKUBO_SWAPPED_SHAPE_MISMATCH', {
      data_length: Array.isArray(event.data) ? event.data.length : null,
    });
  }

  const payload = {
    emitterAddress: event.fromAddress,
    locker: normalizeAddress(event.data[0], 'ekubo.swapped.locker'),
    poolKey: decodePoolKey(event.data, 1, 'ekubo.swapped.pool_key'),
    params: decodeSwapParameters(event.data, 6, 'ekubo.swapped.params'),
    delta: decodeDelta(event.data, 12, 'ekubo.swapped.delta'),
    sqrtRatioAfter: parseU256FromArray(event.data, 16, 'ekubo.swapped.sqrt_ratio_after'),
    tickAfter: parseI129FromArray(event.data, 18, 'ekubo.swapped.tick_after'),
    liquidityAfter: parseU128(event.data[20], 'ekubo.swapped.liquidity_after'),
  };

  state.ordered.push({
    eventIndex: event.receiptEventIndex,
    kind: 'swap',
    payload,
  });

  return emptyResult();
}

function decodePositionUpdated(tx, event, state) {
  if (!Array.isArray(event.data) || event.data.length < EXPECTED_LENGTHS.POSITION_UPDATED) {
    return auditResult(tx, event, 'EKUBO_POSITION_UPDATED_SHAPE_MISMATCH', {
      data_length: Array.isArray(event.data) ? event.data.length : null,
    });
  }

  const payload = {
    emitterAddress: event.fromAddress,
    locker: normalizeAddress(event.data[0], 'ekubo.position_updated.locker'),
    poolKey: decodePoolKey(event.data, 1, 'ekubo.position_updated.pool_key'),
    params: decodeUpdatePositionParameters(event.data, 6, 'ekubo.position_updated.params'),
    delta: decodeDelta(event.data, 13, 'ekubo.position_updated.delta'),
  };

  state.ordered.push({
    eventIndex: event.receiptEventIndex,
    kind: 'position_update',
    payload,
  });

  return emptyResult();
}

function decodePoolInitialized(tx, event, state) {
  if (!Array.isArray(event.data) || event.data.length < EXPECTED_LENGTHS.POOL_INITIALIZED) {
    return auditResult(tx, event, 'EKUBO_POOL_INITIALIZED_SHAPE_MISMATCH', {
      data_length: Array.isArray(event.data) ? event.data.length : null,
    });
  }

  state.poolInitializations.push({
    eventIndex: event.receiptEventIndex,
    initialTick: parseI129FromArray(event.data, 5, 'ekubo.pool_initialized.initial_tick'),
    poolKey: decodePoolKey(event.data, 0, 'ekubo.pool_initialized.pool_key'),
    sqrtRatio: parseU256FromArray(event.data, 7, 'ekubo.pool_initialized.sqrt_ratio'),
  });

  return emptyResult();
}

function decodeFeesAccumulated(tx, event, state) {
  if (!Array.isArray(event.data) || event.data.length < EXPECTED_LENGTHS.FEES_ACCUMULATED) {
    return auditResult(tx, event, 'EKUBO_FEES_ACCUMULATED_SHAPE_MISMATCH', {
      data_length: Array.isArray(event.data) ? event.data.length : null,
    });
  }

  state.feesAccumulated.push({
    amount0: parseU128(event.data[5], 'ekubo.fees_accumulated.amount0'),
    amount1: parseU128(event.data[6], 'ekubo.fees_accumulated.amount1'),
    eventIndex: event.receiptEventIndex,
    poolKey: decodePoolKey(event.data, 0, 'ekubo.fees_accumulated.pool_key'),
  });

  return emptyResult();
}

function decodePositionFeesCollected(tx, event, state) {
  if (!Array.isArray(event.data) || event.data.length < EXPECTED_LENGTHS.POSITION_FEES_COLLECTED) {
    return auditResult(tx, event, 'EKUBO_POSITION_FEES_COLLECTED_SHAPE_MISMATCH', {
      data_length: Array.isArray(event.data) ? event.data.length : null,
    });
  }

  state.positionFeesCollected.push({
    delta: decodeDelta(event.data, 11, 'ekubo.position_fees_collected.delta'),
    eventIndex: event.receiptEventIndex,
    poolKey: decodePoolKey(event.data, 0, 'ekubo.position_fees_collected.pool_key'),
    positionKey: decodePositionKey(event.data, 5, 'ekubo.position_fees_collected.position_key'),
  });

  return emptyResult();
}

function decodeSavedBalance(tx, event, state) {
  if (!Array.isArray(event.data) || event.data.length < EXPECTED_LENGTHS.SAVED_BALANCE) {
    return auditResult(tx, event, 'EKUBO_SAVED_BALANCE_SHAPE_MISMATCH', {
      data_length: Array.isArray(event.data) ? event.data.length : null,
    });
  }

  state.savedBalances.push({
    amount: parseU128(event.data[3], 'ekubo.saved_balance.amount'),
    eventIndex: event.receiptEventIndex,
    key: decodeSavedBalanceKey(event.data, 0, 'ekubo.saved_balance.key'),
  });

  return emptyResult();
}

function decodeLoadedBalance(tx, event, state) {
  if (!Array.isArray(event.data) || event.data.length < EXPECTED_LENGTHS.LOADED_BALANCE) {
    return auditResult(tx, event, 'EKUBO_LOADED_BALANCE_SHAPE_MISMATCH', {
      data_length: Array.isArray(event.data) ? event.data.length : null,
    });
  }

  state.loadedBalances.push({
    amount: parseU128(event.data[3], 'ekubo.loaded_balance.amount'),
    eventIndex: event.receiptEventIndex,
    key: decodeSavedBalanceKey(event.data, 0, 'ekubo.loaded_balance.key'),
  });

  return emptyResult();
}

function buildSwapAction(tx, item, state, sequence) {
  const { payload } = item;
  const priceRatio = sqrtRatioToPriceRatio(payload.sqrtRatioAfter, 'ekubo.swap.sqrt_ratio_after');

  return {
    actionKey: buildActionKey({
      lane: tx.lane,
      transactionHash: tx.transactionHash,
      sourceEventIndex: item.eventIndex,
      actionType: 'swap',
      sequence,
    }),
    actionType: 'swap',
    accountAddress: tx.senderAddress ?? payload.locker,
    amount0: payload.delta.amount0,
    amount1: payload.delta.amount1,
    emitterAddress: payload.emitterAddress,
    executionProtocol: 'ekubo',
    metadata: normalizeActionMetadata({
      delta: payload.delta,
      is_token1: payload.params.isToken1,
      liquidity_after: payload.liquidityAfter,
      lock_events_loaded_balance_count: state.loadedBalances.length,
      lock_events_saved_balance_count: state.savedBalances.length,
      price_ratio_denominator: priceRatio.denominator,
      price_ratio_numerator: priceRatio.numerator,
      raw_locker: payload.locker,
      receipt_context_id: tx.transactionHash,
      receipt_sequence: sequence,
      skip_ahead: payload.params.skipAhead,
      sqrt_ratio_after: payload.sqrtRatioAfter,
      sqrt_ratio_limit: payload.params.sqrtRatioLimit,
      supplied_amount: payload.params.amount,
      tick_after: payload.tickAfter,
    }),
    poolId: buildPoolKeyId(payload.poolKey),
    protocol: 'ekubo',
    sourceEventIndex: item.eventIndex,
    token0Address: payload.poolKey.token0,
    token1Address: payload.poolKey.token1,
  };
}

function buildPositionUpdateAction(tx, item, state, sequence) {
  const { payload } = item;

  return {
    actionKey: buildActionKey({
      lane: tx.lane,
      transactionHash: tx.transactionHash,
      sourceEventIndex: item.eventIndex,
      actionType: 'position_update',
      sequence,
    }),
    actionType: 'position_update',
    accountAddress: tx.senderAddress ?? payload.locker,
    amount0: payload.delta.amount0,
    amount1: payload.delta.amount1,
    emitterAddress: payload.emitterAddress,
    executionProtocol: 'ekubo',
    metadata: normalizeActionMetadata({
      bounds: payload.params.bounds,
      delta: payload.delta,
      liquidity_delta: payload.params.liquidityDelta,
      position_fees_collected_seen: state.positionFeesCollected.length,
      raw_locker: payload.locker,
      receipt_context_id: tx.transactionHash,
      receipt_sequence: sequence,
      salt: payload.params.salt,
    }),
    poolId: buildPoolKeyId(payload.poolKey),
    protocol: 'ekubo',
    sourceEventIndex: item.eventIndex,
    token0Address: payload.poolKey.token0,
    token1Address: payload.poolKey.token1,
  };
}

function getEkuboState(receiptContext) {
  if (!receiptContext.feesAccumulated) {
    receiptContext.feesAccumulated = [];
  }

  if (!receiptContext.loadedBalances) {
    receiptContext.loadedBalances = [];
  }

  if (!receiptContext.ordered) {
    receiptContext.ordered = [];
  }

  if (!receiptContext.poolInitializations) {
    receiptContext.poolInitializations = [];
  }

  if (!receiptContext.positionFeesCollected) {
    receiptContext.positionFeesCollected = [];
  }

  if (!receiptContext.savedBalances) {
    receiptContext.savedBalances = [];
  }

  return receiptContext;
}

function clearReceiptContext({ receiptContext }) {
  if (!receiptContext || typeof receiptContext !== 'object') {
    return;
  }

  delete receiptContext.feesAccumulated;
  delete receiptContext.loadedBalances;
  delete receiptContext.ordered;
  delete receiptContext.poolInitializations;
  delete receiptContext.positionFeesCollected;
  delete receiptContext.savedBalances;
}

function decodePoolKey(values, offset, label) {
  return {
    extension: normalizeAddress(values[offset + 4], `${label}.extension`),
    fee: parseU128(values[offset + 2], `${label}.fee`),
    tickSpacing: parseU128(values[offset + 3], `${label}.tick_spacing`),
    token0: normalizeAddress(values[offset], `${label}.token0`),
    token1: normalizeAddress(values[offset + 1], `${label}.token1`),
  };
}

function decodeBounds(values, offset, label) {
  return {
    lower: parseI129FromArray(values, offset, `${label}.lower`),
    upper: parseI129FromArray(values, offset + 2, `${label}.upper`),
  };
}

function decodeUpdatePositionParameters(values, offset, label) {
  return {
    bounds: decodeBounds(values, offset + 1, `${label}.bounds`),
    liquidityDelta: parseI129FromArray(values, offset + 5, `${label}.liquidity_delta`),
    salt: values[offset],
  };
}

function decodeSwapParameters(values, offset, label) {
  return {
    amount: parseI129FromArray(values, offset, `${label}.amount`),
    isToken1: normalizeBoolFromFelt(values[offset + 2], `${label}.is_token1`),
    skipAhead: parseU128(values[offset + 5], `${label}.skip_ahead`),
    sqrtRatioLimit: parseU256FromArray(values, offset + 3, `${label}.sqrt_ratio_limit`),
  };
}

function decodeDelta(values, offset, label) {
  return {
    amount0: parseI129FromArray(values, offset, `${label}.amount0`),
    amount1: parseI129FromArray(values, offset + 2, `${label}.amount1`),
  };
}

function decodePositionKey(values, offset, label) {
  return {
    bounds: decodeBounds(values, offset + 2, `${label}.bounds`),
    owner: normalizeAddress(values[offset + 1], `${label}.owner`),
    salt: values[offset],
  };
}

function decodeSavedBalanceKey(values, offset, label) {
  return {
    owner: normalizeAddress(values[offset], `${label}.owner`),
    salt: values[offset + 2],
    token: normalizeAddress(values[offset + 1], `${label}.token`),
  };
}

function auditResult(tx, event, reason, metadata) {
  return {
    actions: [],
    audits: [
      {
        blockHash: tx.blockHash,
        blockNumber: tx.blockNumber,
        emitterAddress: event.fromAddress,
        lane: tx.lane,
        metadata: normalizeActionMetadata(metadata),
        reason,
        selector: event.selector,
        sourceEventIndex: event.receiptEventIndex,
        transactionHash: tx.transactionHash,
        transactionIndex: tx.transactionIndex,
      },
    ],
    transfers: [],
  };
}

function emptyResult() {
  return { actions: [], audits: [], transfers: [] };
}

module.exports = {
  clearReceiptContext,
  decodeEvent,
  flushReceiptContext,
};
