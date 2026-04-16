'use strict';

const { SELECTORS } = require('../../lib/registry/dex-registry');
const { normalizeAddress, parseU256FromArray, sortTokenPair } = require('../normalize');
const { buildActionKey, normalizeActionMetadata } = require('./shared');

function decodeEvent({ contractMetadata, event, tx }) {
  if (contractMetadata.role === 'forwarder' && event.selector === SELECTORS.AVNU_SPONSORED_TRANSACTION) {
    return decodeSponsoredTransaction({ contractMetadata, event, tx });
  }

  switch (event.selector) {
    case SELECTORS.SWAP:
      return decodeSwap({ contractMetadata, event, tx });
    case SELECTORS.AVNU_OPTIMIZED_SWAP:
      return decodeOptimizedSwap({ contractMetadata, event, tx });
    default:
      return emptyResult();
  }
}

function decodeSwap({ contractMetadata, event, tx }) {
  const shape = resolveSwapShape(event);
  if (!shape) {
    return auditResult(tx, event, 'AVNU_SWAP_SHAPE_MISMATCH', {
      data_length: Array.isArray(event.data) ? event.data.length : null,
      keys_length: Array.isArray(event.keys) ? event.keys.length : null,
      role: contractMetadata.role,
    });
  }

  const takerAddress = shape.takerSource === 'keys'
    ? normalizeAddress(event.keys[shape.takerIndex], 'avnu.swap.taker')
    : normalizeAddress(event.data[shape.takerIndex], 'avnu.swap.taker');
  const sellAddress = normalizeAddress(event.data[shape.sellAddressIndex], 'avnu.swap.sell_address');
  const buyAddress = normalizeAddress(event.data[shape.buyAddressIndex], 'avnu.swap.buy_address');
  const sellAmount = parseU256FromArray(event.data, shape.sellAmountOffset, 'avnu.swap.sell_amount');
  const buyAmount = parseU256FromArray(event.data, shape.buyAmountOffset, 'avnu.swap.buy_amount');
  const beneficiary = normalizeAddress(event.data[shape.beneficiaryIndex], 'avnu.swap.beneficiary');
  const [token0Address, token1Address] = sortTokenPair(sellAddress, buyAddress, 'avnu.swap.tokens');
  const amount0 = sellAddress === token0Address ? sellAmount : -buyAmount;
  const amount1 = sellAddress === token1Address ? sellAmount : -buyAmount;

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
        accountAddress: takerAddress ?? tx.senderAddress,
        amount0,
        amount1,
        emitterAddress: event.fromAddress,
        executionProtocol: 'avnu',
        metadata: normalizeActionMetadata({
          beneficiary,
          is_aggregator_trade: true,
          pool_model: 'aggregator_route',
          sell_amount: sellAmount,
          sell_token_address: sellAddress,
          taker_address: takerAddress,
          buy_amount: buyAmount,
          buy_token_address: buyAddress,
        }),
        poolId: buildAggregatorPoolId(token0Address, token1Address),
        protocol: 'avnu',
        routerProtocol: 'avnu',
        sourceEventIndex: event.receiptEventIndex,
        token0Address,
        token1Address,
      },
    ],
    audits: [],
    transfers: [],
  };
}

function decodeOptimizedSwap({ event, tx }) {
  if (!Array.isArray(event.data) || event.data.length < 11) {
    return auditResult(tx, event, 'AVNU_OPTIMIZED_SWAP_SHAPE_MISMATCH', {
      data_length: Array.isArray(event.data) ? event.data.length : null,
    });
  }

  return {
    actions: [
      {
        actionKey: buildActionKey({
          actionType: 'route_optimization',
          lane: tx.lane,
          sourceEventIndex: event.receiptEventIndex,
          transactionHash: tx.transactionHash,
        }),
        actionType: 'route_optimization',
        emitterAddress: event.fromAddress,
        executionProtocol: 'avnu',
        metadata: normalizeActionMetadata({
          buy_token_address: normalizeAddress(event.data[1], 'avnu.optimized_swap.buy_token'),
          principal_amount_in: parseU256FromArray(event.data, 4, 'avnu.optimized_swap.principal_amount_in'),
          principal_price: parseU256FromArray(event.data, 2, 'avnu.optimized_swap.principal_price'),
          sell_token_address: normalizeAddress(event.data[0], 'avnu.optimized_swap.sell_token'),
          sell_token_amount_optimized: parseU256FromArray(event.data, 8, 'avnu.optimized_swap.sell_token_amount_optimized'),
          buy_token_amount_optimized: parseU256FromArray(event.data, 10, 'avnu.optimized_swap.buy_token_amount_optimized'),
        }),
        protocol: 'avnu',
        sourceEventIndex: event.receiptEventIndex,
      },
    ],
    audits: [],
    transfers: [],
  };
}

function decodeSponsoredTransaction({ event, tx }) {
  if (!Array.isArray(event.data) || event.data.length < 1) {
    return auditResult(tx, event, 'AVNU_SPONSORED_TRANSACTION_SHAPE_MISMATCH', {
      data_length: Array.isArray(event.data) ? event.data.length : null,
    });
  }

  const userAddress = normalizeAddress(event.data[0], 'avnu.sponsored_transaction.user_address');
  const sponsorMetadata = event.data.slice(1);

  return {
    actions: [
      {
        actionKey: buildActionKey({
          actionType: 'sponsored_transaction',
          lane: tx.lane,
          sourceEventIndex: event.receiptEventIndex,
          transactionHash: tx.transactionHash,
        }),
        actionType: 'sponsored_transaction',
        accountAddress: userAddress ?? tx.senderAddress,
        emitterAddress: event.fromAddress,
        executionProtocol: 'avnu',
        metadata: normalizeActionMetadata({
          sponsor_metadata: sponsorMetadata,
          user_address: userAddress,
        }),
        protocol: 'avnu',
        sourceEventIndex: event.receiptEventIndex,
      },
    ],
    audits: [],
    transfers: [],
  };
}

function resolveSwapShape(event) {
  if (Array.isArray(event.data) && event.data.length >= 8) {
    return {
      beneficiaryIndex: 7,
      buyAddressIndex: 4,
      buyAmountOffset: 5,
      sellAddressIndex: 1,
      sellAmountOffset: 2,
      takerIndex: 0,
      takerSource: 'data',
    };
  }

  if (Array.isArray(event.keys) && event.keys.length >= 2 && Array.isArray(event.data) && event.data.length >= 7) {
    return {
      beneficiaryIndex: 6,
      buyAddressIndex: 3,
      buyAmountOffset: 4,
      sellAddressIndex: 0,
      sellAmountOffset: 1,
      takerIndex: 1,
      takerSource: 'keys',
    };
  }

  return null;
}

function buildAggregatorPoolId(token0Address, token1Address) {
  return `avnu:${token0Address}:${token1Address}`;
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
