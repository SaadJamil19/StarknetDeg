'use strict';

const { SELECTORS } = require('../../lib/registry/dex-registry');
const { normalizeAddress, parseU256FromArray, sortTokenPair } = require('../normalize');
const { buildActionKey, normalizeActionMetadata } = require('./shared');

function decodeEvent({ contractMetadata, event, tx }) {
  if (event.selector !== SELECTORS.SWAP) {
    return emptyResult();
  }

  if (!Array.isArray(event.data) || event.data.length < 7) {
    return auditResult(tx, event, 'MYSWAP_SWAP_SHAPE_MISMATCH', {
      data_length: Array.isArray(event.data) ? event.data.length : null,
      keys_length: Array.isArray(event.keys) ? event.keys.length : null,
    });
  }

  const callerAddress = Array.isArray(event.keys) && event.keys.length >= 2
    ? normalizeAddress(event.keys[1], 'myswap.swap.caller')
    : tx.senderAddress;
  const rawPoolId = BigInt(event.data[0]);
  const tokenFromAddress = normalizeAddress(event.data[1], 'myswap.swap.token_from');
  const amountFrom = parseU256FromArray(event.data, 2, 'myswap.swap.amount_from');
  const tokenToAddress = normalizeAddress(event.data[4], 'myswap.swap.token_to');
  const amountTo = parseU256FromArray(event.data, 5, 'myswap.swap.amount_to');
  const [token0Address, token1Address] = sortTokenPair(tokenFromAddress, tokenToAddress, 'myswap.swap.tokens');
  const amount0 = tokenFromAddress === token0Address ? amountFrom : -amountTo;
  const amount1 = tokenFromAddress === token1Address ? amountFrom : -amountTo;

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
        accountAddress: tx.senderAddress ?? callerAddress,
        amount0,
        amount1,
        emitterAddress: event.fromAddress,
        executionProtocol: contractMetadata.protocol,
        metadata: normalizeActionMetadata({
          caller_address: callerAddress,
          pool_model: 'fixed_pool',
          raw_pool_id: rawPoolId,
          token_from_address: tokenFromAddress,
          token_to_address: tokenToAddress,
          amount_from: amountFrom,
          amount_to: amountTo,
        }),
        poolId: `${event.fromAddress}:${rawPoolId.toString(10)}`,
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
