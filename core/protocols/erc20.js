'use strict';

const { normalizeAddress, parseU256FromArray } = require('../normalize');
const { buildActionKey, buildTransferKey, normalizeActionMetadata } = require('./shared');

function decodeEvent({ tx, event }) {
  if (!Array.isArray(event.keys) || event.keys.length < 3 || !Array.isArray(event.data) || event.data.length < 2) {
    return {
      actions: [],
      audits: [buildAuditEntry(tx, event, 'ERC20_TRANSFER_SHAPE_MISMATCH', {
        keys_length: Array.isArray(event.keys) ? event.keys.length : null,
        data_length: Array.isArray(event.data) ? event.data.length : null,
      })],
      transfers: [],
    };
  }

  const fromAddress = normalizeAddress(event.keys[1], 'erc20.from');
  const toAddress = normalizeAddress(event.keys[2], 'erc20.to');
  const amount = parseU256FromArray(event.data, 0, 'erc20.value');
  const tokenAddress = normalizeAddress(event.fromAddress, 'erc20.token');
  const actionMetadata = normalizeActionMetadata({
    standard: 'erc20',
    selector: event.selector,
    from_key_index: 1,
    to_key_index: 2,
    amount_encoding: 'u256',
  });

  return {
    actions: [
      {
        actionKey: buildActionKey({
          lane: tx.lane,
          transactionHash: tx.transactionHash,
          sourceEventIndex: event.receiptEventIndex,
          actionType: 'transfer',
        }),
        actionType: 'transfer',
        accountAddress: fromAddress,
        amount,
        emitterAddress: tokenAddress,
        executionProtocol: 'erc20',
        metadata: actionMetadata,
        protocol: 'erc20',
        sourceEventIndex: event.receiptEventIndex,
        tokenAddress,
      },
    ],
    audits: [],
    transfers: [
      {
        amount,
        fromAddress,
        metadata: actionMetadata,
        protocol: 'erc20',
        sourceEventIndex: event.receiptEventIndex,
        toAddress,
        tokenAddress,
        transferKey: buildTransferKey({
          lane: tx.lane,
          transactionHash: tx.transactionHash,
          sourceEventIndex: event.receiptEventIndex,
        }),
      },
    ],
  };
}

function buildAuditEntry(tx, event, reason, metadata) {
  return {
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
  };
}

module.exports = {
  decodeEvent,
};
