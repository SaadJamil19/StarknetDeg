'use strict';

const { normalizeAddress, parseU256FromArray } = require('../normalize');
const { normalizeActionMetadata, buildActionKey } = require('./shared');

function decodeEvent({ tx, event, route }) {
  switch (route.selectorName) {
    case 'JEDISWAP_SWAP':
      return decodeSwap(tx, event);
    case 'JEDISWAP_MINT':
      return decodeMint(tx, event);
    case 'JEDISWAP_BURN':
      return decodeBurn(tx, event);
    case 'JEDISWAP_SYNC':
      return decodeSync(tx, event);
    default:
      return emptyResult();
  }
}

function decodeSwap(tx, event) {
  if (!Array.isArray(event.data) || event.data.length < 10) {
    return auditResult(tx, event, 'JEDISWAP_SWAP_SHAPE_MISMATCH', {
      data_length: Array.isArray(event.data) ? event.data.length : null,
    });
  }

  const sender = normalizeAddress(event.data[0], 'jediswap.swap.sender');
  const amount0In = parseU256FromArray(event.data, 1, 'jediswap.swap.amount0_in');
  const amount1In = parseU256FromArray(event.data, 3, 'jediswap.swap.amount1_in');
  const amount0Out = parseU256FromArray(event.data, 5, 'jediswap.swap.amount0_out');
  const amount1Out = parseU256FromArray(event.data, 7, 'jediswap.swap.amount1_out');
  const recipient = normalizeAddress(event.data[9], 'jediswap.swap.recipient');

  return {
    actions: [
      {
        actionKey: buildActionKey({
          lane: tx.lane,
          transactionHash: tx.transactionHash,
          sourceEventIndex: event.receiptEventIndex,
          actionType: 'swap',
        }),
        actionType: 'swap',
        accountAddress: sender,
        amount0: amount0In - amount0Out,
        amount1: amount1In - amount1Out,
        emitterAddress: event.fromAddress,
        executionProtocol: 'jediswap',
        metadata: normalizeActionMetadata({
          amount0_in: amount0In,
          amount0_out: amount0Out,
          amount1_in: amount1In,
          amount1_out: amount1Out,
          pool_model: 'xyk',
          recipient,
        }),
        poolId: event.fromAddress,
        protocol: 'jediswap',
        routerProtocol: null,
        sourceEventIndex: event.receiptEventIndex,
      },
    ],
    audits: [],
    transfers: [],
  };
}

function decodeMint(tx, event) {
  if (!Array.isArray(event.data) || event.data.length < 5) {
    return auditResult(tx, event, 'JEDISWAP_MINT_SHAPE_MISMATCH', {
      data_length: Array.isArray(event.data) ? event.data.length : null,
    });
  }

  const sender = normalizeAddress(event.data[0], 'jediswap.mint.sender');
  const amount0 = parseU256FromArray(event.data, 1, 'jediswap.mint.amount0');
  const amount1 = parseU256FromArray(event.data, 3, 'jediswap.mint.amount1');

  return {
    actions: [
      {
        actionKey: buildActionKey({
          lane: tx.lane,
          transactionHash: tx.transactionHash,
          sourceEventIndex: event.receiptEventIndex,
          actionType: 'mint',
        }),
        actionType: 'mint',
        accountAddress: sender,
        amount0,
        amount1,
        emitterAddress: event.fromAddress,
        executionProtocol: 'jediswap',
        metadata: normalizeActionMetadata({
          pool_model: 'xyk',
          raw_sender: sender,
        }),
        poolId: event.fromAddress,
        protocol: 'jediswap',
        sourceEventIndex: event.receiptEventIndex,
      },
    ],
    audits: [],
    transfers: [],
  };
}

function decodeBurn(tx, event) {
  if (!Array.isArray(event.data) || event.data.length < 6) {
    return auditResult(tx, event, 'JEDISWAP_BURN_SHAPE_MISMATCH', {
      data_length: Array.isArray(event.data) ? event.data.length : null,
    });
  }

  const sender = normalizeAddress(event.data[0], 'jediswap.burn.sender');
  const amount0 = parseU256FromArray(event.data, 1, 'jediswap.burn.amount0');
  const amount1 = parseU256FromArray(event.data, 3, 'jediswap.burn.amount1');
  const recipient = normalizeAddress(event.data[5], 'jediswap.burn.recipient');

  return {
    actions: [
      {
        actionKey: buildActionKey({
          lane: tx.lane,
          transactionHash: tx.transactionHash,
          sourceEventIndex: event.receiptEventIndex,
          actionType: 'burn',
        }),
        actionType: 'burn',
        accountAddress: sender,
        amount0: -amount0,
        amount1: -amount1,
        emitterAddress: event.fromAddress,
        executionProtocol: 'jediswap',
        metadata: normalizeActionMetadata({
          pool_model: 'xyk',
          recipient,
        }),
        poolId: event.fromAddress,
        protocol: 'jediswap',
        sourceEventIndex: event.receiptEventIndex,
      },
    ],
    audits: [],
    transfers: [],
  };
}

function decodeSync(tx, event) {
  if (!Array.isArray(event.data) || event.data.length < 4) {
    return auditResult(tx, event, 'JEDISWAP_SYNC_SHAPE_MISMATCH', {
      data_length: Array.isArray(event.data) ? event.data.length : null,
    });
  }

  const reserve0 = parseU256FromArray(event.data, 0, 'jediswap.sync.reserve0');
  const reserve1 = parseU256FromArray(event.data, 2, 'jediswap.sync.reserve1');

  return {
    actions: [
      {
        actionKey: buildActionKey({
          lane: tx.lane,
          transactionHash: tx.transactionHash,
          sourceEventIndex: event.receiptEventIndex,
          actionType: 'sync',
        }),
        actionType: 'sync',
        amount0: reserve0,
        amount1: reserve1,
        emitterAddress: event.fromAddress,
        executionProtocol: 'jediswap',
        metadata: normalizeActionMetadata({
          pool_model: 'xyk',
          reserve0,
          reserve1,
        }),
        poolId: event.fromAddress,
        protocol: 'jediswap',
        sourceEventIndex: event.receiptEventIndex,
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
