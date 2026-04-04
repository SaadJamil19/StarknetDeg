'use strict';

const { SELECTORS } = require('../../lib/registry/dex-registry');
const {
  normalizeAddress,
  normalizeBoolFromFelt,
  parseI129FromArray,
  parseSignedU256FromArray,
  parseU128,
  parseU256FromArray,
  sqrtRatioToPriceRatio,
  sortTokenPair,
} = require('../normalize');
const { buildActionKey, normalizeActionMetadata } = require('./shared');

const MARKET_CACHE = new Map();

async function decodeEvent({ contractMetadata, event, rpcClient, tx }) {
  switch (event.selector) {
    case SELECTORS.SWAP:
      return decodeSwap({ contractMetadata, event, rpcClient, tx });
    case SELECTORS.MULTI_SWAP:
      return decodeMultiSwap({ event, tx });
    case SELECTORS.MODIFY_POSITION:
      return decodeModifyPosition({ contractMetadata, event, rpcClient, tx });
    case SELECTORS.CREATE_ORDER:
      return decodeCreateOrder({ contractMetadata, event, rpcClient, tx });
    case SELECTORS.COLLECT_ORDER:
      return decodeCollectOrder({ contractMetadata, event, rpcClient, tx });
    case SELECTORS.CREATE_MARKET:
      return decodeCreateMarket({ event, tx });
    default:
      return emptyResult();
  }
}

async function decodeSwap({ contractMetadata, event, rpcClient, tx }) {
  if (!Array.isArray(event.keys) || event.keys.length < 6 || !Array.isArray(event.data) || event.data.length < 10) {
    return auditResult(tx, event, 'HAIKO_SWAP_SHAPE_MISMATCH', {
      data_length: Array.isArray(event.data) ? event.data.length : null,
      keys_length: Array.isArray(event.keys) ? event.keys.length : null,
    });
  }

  const caller = normalizeAddress(event.keys[1], 'haiko.swap.caller');
  const marketId = event.keys[2];
  const isBuy = normalizeBoolFromFelt(event.keys[3], 'haiko.swap.is_buy');
  const exactInput = normalizeBoolFromFelt(event.keys[4], 'haiko.swap.exact_input');
  const swapId = BigInt(event.keys[5]);
  const market = await resolveMarketTokens({
    contractAddress: event.fromAddress,
    marketId,
    rpcClient,
  });

  if (!market) {
    return auditResult(tx, event, 'HAIKO_MARKET_LOOKUP_FAILED', {
      market_id: marketId,
    });
  }

  const amountIn = parseU256FromArray(event.data, 0, 'haiko.swap.amount_in');
  const amountOut = parseU256FromArray(event.data, 2, 'haiko.swap.amount_out');
  const fees = parseU256FromArray(event.data, 4, 'haiko.swap.fees');
  const endLimit = BigInt(event.data[6]);
  const endSqrtPrice = parseU256FromArray(event.data, 7, 'haiko.swap.end_sqrt_price');
  const marketLiquidity = parseU128(event.data[9], 'haiko.swap.market_liquidity');

  const token0Address = market.baseTokenAddress;
  const token1Address = market.quoteTokenAddress;
  const amount0 = isBuy ? -amountOut : amountIn;
  const amount1 = isBuy ? amountIn : -amountOut;
  const priceRatio = isBuy
    ? { numerator: amountIn, denominator: amountOut }
    : { numerator: amountOut, denominator: amountIn };

  return {
    actions: [
      {
        actionKey: buildActionKey({
          actionType: 'swap',
          lane: tx.lane,
          sourceEventIndex: event.receiptEventIndex,
          transactionHash: tx.transactionHash,
        }),
        actionType: 'swap',
        accountAddress: tx.senderAddress ?? caller,
        amount0,
        amount1,
        emitterAddress: event.fromAddress,
        executionProtocol: contractMetadata.protocol,
        metadata: normalizeActionMetadata({
          amount_in: amountIn,
          amount_out: amountOut,
          end_limit: endLimit,
          end_sqrt_price: endSqrtPrice,
          exact_input: exactInput,
          fees,
          is_buy: isBuy,
          market_id: marketId,
          market_liquidity: marketLiquidity,
          pool_model: 'haiko',
          price_ratio_denominator: priceRatio.denominator,
          price_ratio_numerator: priceRatio.numerator,
          swap_id: swapId,
        }),
        poolId: buildMarketPoolId(marketId),
        protocol: contractMetadata.protocol,
        sourceEventIndex: event.receiptEventIndex,
        token0Address,
        token1Address,
      },
    ],
    audits: [],
    transfers: [],
  };
}

async function decodeModifyPosition({ contractMetadata, event, rpcClient, tx }) {
  if (!Array.isArray(event.keys) || event.keys.length < 6 || !Array.isArray(event.data) || event.data.length < 12) {
    return auditResult(tx, event, 'HAIKO_MODIFY_POSITION_SHAPE_MISMATCH', {
      data_length: Array.isArray(event.data) ? event.data.length : null,
      keys_length: Array.isArray(event.keys) ? event.keys.length : null,
    });
  }

  const caller = normalizeAddress(event.keys[1], 'haiko.modify_position.caller');
  const marketId = event.keys[2];
  const market = await resolveMarketTokens({
    contractAddress: event.fromAddress,
    marketId,
    rpcClient,
  });

  if (!market) {
    return auditResult(tx, event, 'HAIKO_MARKET_LOOKUP_FAILED', {
      market_id: marketId,
    });
  }

  const lowerLimit = BigInt(event.keys[3]);
  const upperLimit = BigInt(event.keys[4]);
  const isLimitOrder = normalizeBoolFromFelt(event.keys[5], 'haiko.modify_position.is_limit_order');
  const liquidityDelta = parseI129FromArray(event.data, 0, 'haiko.modify_position.liquidity_delta');
  const baseAmount = parseSignedU256FromArray(event.data, 2, 'haiko.modify_position.base_amount');
  const quoteAmount = parseSignedU256FromArray(event.data, 5, 'haiko.modify_position.quote_amount');
  const baseFees = parseU256FromArray(event.data, 8, 'haiko.modify_position.base_fees');
  const quoteFees = parseU256FromArray(event.data, 10, 'haiko.modify_position.quote_fees');

  return {
    actions: [
      {
        actionKey: buildActionKey({
          actionType: 'position_update',
          lane: tx.lane,
          sourceEventIndex: event.receiptEventIndex,
          transactionHash: tx.transactionHash,
        }),
        actionType: 'position_update',
        accountAddress: tx.senderAddress ?? caller,
        amount0: baseAmount,
        amount1: quoteAmount,
        emitterAddress: event.fromAddress,
        executionProtocol: contractMetadata.protocol,
        metadata: normalizeActionMetadata({
          base_fees: baseFees,
          is_limit_order: isLimitOrder,
          liquidity_delta: liquidityDelta,
          lower_limit: lowerLimit,
          market_id: marketId,
          pool_model: 'haiko',
          quote_fees: quoteFees,
          upper_limit: upperLimit,
        }),
        poolId: buildMarketPoolId(marketId),
        protocol: contractMetadata.protocol,
        sourceEventIndex: event.receiptEventIndex,
        token0Address: market.baseTokenAddress,
        token1Address: market.quoteTokenAddress,
      },
    ],
    audits: [],
    transfers: [],
  };
}

async function decodeCreateOrder({ contractMetadata, event, rpcClient, tx }) {
  if (!Array.isArray(event.keys) || event.keys.length < 7 || !Array.isArray(event.data) || event.data.length < 2) {
    return auditResult(tx, event, 'HAIKO_CREATE_ORDER_SHAPE_MISMATCH', {
      data_length: Array.isArray(event.data) ? event.data.length : null,
      keys_length: Array.isArray(event.keys) ? event.keys.length : null,
    });
  }

  const caller = normalizeAddress(event.keys[1], 'haiko.create_order.caller');
  const marketId = event.keys[2];
  const market = await resolveMarketTokens({
    contractAddress: event.fromAddress,
    marketId,
    rpcClient,
  });

  if (!market) {
    return auditResult(tx, event, 'HAIKO_MARKET_LOOKUP_FAILED', {
      market_id: marketId,
    });
  }

  const orderId = event.keys[3];
  const limit = BigInt(event.keys[4]);
  const batchId = event.keys[5];
  const isBid = normalizeBoolFromFelt(event.keys[6], 'haiko.create_order.is_bid');
  const amount = parseU256FromArray(event.data, 0, 'haiko.create_order.amount');

  return {
    actions: [
      {
        actionKey: buildActionKey({
          actionType: 'order_create',
          lane: tx.lane,
          sourceEventIndex: event.receiptEventIndex,
          transactionHash: tx.transactionHash,
        }),
        actionType: 'order_create',
        accountAddress: tx.senderAddress ?? caller,
        amount,
        emitterAddress: event.fromAddress,
        executionProtocol: contractMetadata.protocol,
        metadata: normalizeActionMetadata({
          amount,
          batch_id: batchId,
          is_bid: isBid,
          limit,
          market_id: marketId,
          order_id: orderId,
          pool_model: 'haiko',
        }),
        poolId: buildMarketPoolId(marketId),
        protocol: contractMetadata.protocol,
        sourceEventIndex: event.receiptEventIndex,
        token0Address: market.baseTokenAddress,
        token1Address: market.quoteTokenAddress,
      },
    ],
    audits: [],
    transfers: [],
  };
}

async function decodeCollectOrder({ contractMetadata, event, rpcClient, tx }) {
  if (!Array.isArray(event.keys) || event.keys.length < 7 || !Array.isArray(event.data) || event.data.length < 4) {
    return auditResult(tx, event, 'HAIKO_COLLECT_ORDER_SHAPE_MISMATCH', {
      data_length: Array.isArray(event.data) ? event.data.length : null,
      keys_length: Array.isArray(event.keys) ? event.keys.length : null,
    });
  }

  const caller = normalizeAddress(event.keys[1], 'haiko.collect_order.caller');
  const marketId = event.keys[2];
  const market = await resolveMarketTokens({
    contractAddress: event.fromAddress,
    marketId,
    rpcClient,
  });

  if (!market) {
    return auditResult(tx, event, 'HAIKO_MARKET_LOOKUP_FAILED', {
      market_id: marketId,
    });
  }

  const orderId = event.keys[3];
  const limit = BigInt(event.keys[4]);
  const batchId = event.keys[5];
  const isBid = normalizeBoolFromFelt(event.keys[6], 'haiko.collect_order.is_bid');
  const baseAmount = parseU256FromArray(event.data, 0, 'haiko.collect_order.base_amount');
  const quoteAmount = parseU256FromArray(event.data, 2, 'haiko.collect_order.quote_amount');

  return {
    actions: [
      {
        actionKey: buildActionKey({
          actionType: 'order_collect',
          lane: tx.lane,
          sourceEventIndex: event.receiptEventIndex,
          transactionHash: tx.transactionHash,
        }),
        actionType: 'order_collect',
        accountAddress: tx.senderAddress ?? caller,
        amount0: baseAmount,
        amount1: quoteAmount,
        emitterAddress: event.fromAddress,
        executionProtocol: contractMetadata.protocol,
        metadata: normalizeActionMetadata({
          batch_id: batchId,
          is_bid: isBid,
          limit,
          market_id: marketId,
          order_id: orderId,
          pool_model: 'haiko',
        }),
        poolId: buildMarketPoolId(marketId),
        protocol: contractMetadata.protocol,
        sourceEventIndex: event.receiptEventIndex,
        token0Address: market.baseTokenAddress,
        token1Address: market.quoteTokenAddress,
      },
    ],
    audits: [],
    transfers: [],
  };
}

function decodeMultiSwap({ event, tx }) {
  if (!Array.isArray(event.keys) || event.keys.length < 5 || !Array.isArray(event.data) || event.data.length < 4) {
    return auditResult(tx, event, 'HAIKO_MULTI_SWAP_SHAPE_MISMATCH', {
      data_length: Array.isArray(event.data) ? event.data.length : null,
      keys_length: Array.isArray(event.keys) ? event.keys.length : null,
    });
  }

  const caller = normalizeAddress(event.keys[1], 'haiko.multi_swap.caller');
  const swapId = BigInt(event.keys[2]);
  const inTokenAddress = normalizeAddress(event.keys[3], 'haiko.multi_swap.in_token');
  const outTokenAddress = normalizeAddress(event.keys[4], 'haiko.multi_swap.out_token');
  const amountIn = parseU256FromArray(event.data, 0, 'haiko.multi_swap.amount_in');
  const amountOut = parseU256FromArray(event.data, 2, 'haiko.multi_swap.amount_out');
  const [token0Address, token1Address] = sortTokenPair(inTokenAddress, outTokenAddress, 'haiko.multi_swap.tokens');
  const amount0 = inTokenAddress === token0Address ? amountIn : -amountOut;
  const amount1 = inTokenAddress === token1Address ? amountIn : -amountOut;

  return {
    actions: [
      {
        actionKey: buildActionKey({
          actionType: 'swap',
          lane: tx.lane,
          sourceEventIndex: event.receiptEventIndex,
          transactionHash: tx.transactionHash,
        }),
        actionType: 'swap',
        accountAddress: tx.senderAddress ?? caller,
        amount0,
        amount1,
        emitterAddress: event.fromAddress,
        executionProtocol: 'haiko',
        metadata: normalizeActionMetadata({
          amount_in: amountIn,
          amount_out: amountOut,
          in_token_address: inTokenAddress,
          is_multihop: true,
          out_token_address: outTokenAddress,
          pool_model: 'haiko_multiswap',
          swap_id: swapId,
        }),
        poolId: `haiko:multiswap:${token0Address}:${token1Address}`,
        protocol: 'haiko',
        sourceEventIndex: event.receiptEventIndex,
        token0Address,
        token1Address,
      },
    ],
    audits: [],
    transfers: [],
  };
}

function decodeCreateMarket({ event, tx }) {
  if (!Array.isArray(event.keys) || event.keys.length < 9 || !Array.isArray(event.data) || event.data.length < 3) {
    return auditResult(tx, event, 'HAIKO_CREATE_MARKET_SHAPE_MISMATCH', {
      data_length: Array.isArray(event.data) ? event.data.length : null,
      keys_length: Array.isArray(event.keys) ? event.keys.length : null,
    });
  }

  const marketId = event.keys[1];
  const baseTokenAddress = normalizeAddress(event.keys[2], 'haiko.create_market.base_token');
  const quoteTokenAddress = normalizeAddress(event.keys[3], 'haiko.create_market.quote_token');
  const width = BigInt(event.keys[4]);
  const strategy = normalizeAddress(event.keys[5], 'haiko.create_market.strategy');
  const swapFeeRate = BigInt(event.keys[6]);
  const feeController = normalizeAddress(event.keys[7], 'haiko.create_market.fee_controller');
  const controller = normalizeAddress(event.keys[8], 'haiko.create_market.controller');
  const startLimit = BigInt(event.data[0]);
  const startSqrtPrice = parseU256FromArray(event.data, 1, 'haiko.create_market.start_sqrt_price');
  const priceRatio = sqrtRatioToPriceRatio(startSqrtPrice, 'haiko.create_market.start_sqrt_price');

  return {
    actions: [
      {
        actionKey: buildActionKey({
          actionType: 'pool_created',
          lane: tx.lane,
          sourceEventIndex: event.receiptEventIndex,
          transactionHash: tx.transactionHash,
        }),
        actionType: 'pool_created',
        emitterAddress: event.fromAddress,
        executionProtocol: 'haiko',
        metadata: normalizeActionMetadata({
          controller,
          fee_controller: feeController,
          market_id: marketId,
          pool_model: 'haiko',
          price_ratio_denominator: priceRatio.denominator,
          price_ratio_numerator: priceRatio.numerator,
          start_limit: startLimit,
          start_sqrt_price: startSqrtPrice,
          strategy,
          swap_fee_rate: swapFeeRate,
          width,
        }),
        poolId: buildMarketPoolId(marketId),
        protocol: 'haiko',
        sourceEventIndex: event.receiptEventIndex,
        token0Address: baseTokenAddress,
        token1Address: quoteTokenAddress,
      },
    ],
    audits: [],
    transfers: [],
  };
}

async function resolveMarketTokens({ contractAddress, marketId, rpcClient }) {
  if (!rpcClient || typeof rpcClient.callContract !== 'function') {
    return null;
  }

  const cacheKey = `${contractAddress}:${String(marketId).toLowerCase()}`;
  if (MARKET_CACHE.has(cacheKey)) {
    return MARKET_CACHE.get(cacheKey);
  }

  try {
    const [baseTokenResult, quoteTokenResult] = await Promise.all([
      rpcClient.callContract({
        blockId: 'latest',
        calldata: [marketId],
        contractAddress,
        entrypoint: 'base_token',
      }),
      rpcClient.callContract({
        blockId: 'latest',
        calldata: [marketId],
        contractAddress,
        entrypoint: 'quote_token',
      }),
    ]);

    if (!Array.isArray(baseTokenResult) || baseTokenResult.length === 0 || !Array.isArray(quoteTokenResult) || quoteTokenResult.length === 0) {
      MARKET_CACHE.set(cacheKey, null);
      return null;
    }

    const market = {
      baseTokenAddress: normalizeAddress(baseTokenResult[0], 'haiko.base_token'),
      quoteTokenAddress: normalizeAddress(quoteTokenResult[0], 'haiko.quote_token'),
    };
    MARKET_CACHE.set(cacheKey, market);
    return market;
  } catch (error) {
    MARKET_CACHE.set(cacheKey, null);
    return null;
  }
}

function buildMarketPoolId(marketId) {
  return `haiko:${BigInt(marketId).toString(10)}`;
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
  decodeEvent,
};
