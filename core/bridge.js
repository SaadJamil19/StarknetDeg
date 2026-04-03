'use strict';

const { normalizeAddress, normalizeHexArray } = require('./normalize');
const { buildActionKey, buildBridgeKey, normalizeActionMetadata } = require('./protocols/shared');

function extractBridgeActivities({ tx, messages }) {
  if (tx.executionStatus !== 'SUCCEEDED') {
    return emptyResult();
  }

  const actions = [];
  const bridges = [];
  const audits = [];

  if (tx.txType === 'L1_HANDLER') {
    const l1Sender = tx.l1SenderAddress ?? null;
    const l2ContractAddress = tx.contractAddress ?? tx.senderAddress ?? null;
    const payload = Array.isArray(tx.calldata) ? tx.calldata : [];
    const bridgeKey = buildBridgeKey({
      direction: 'bridge_in',
      lane: tx.lane,
      sourceEventIndex: null,
      transactionHash: tx.transactionHash,
    });

    bridges.push({
      amount: null,
      bridgeKey,
      classification: 'l1_handler',
      direction: 'bridge_in',
      l1Sender,
      l2ContractAddress,
      l2WalletAddress: tx.senderAddress ?? null,
      messageToAddress: l2ContractAddress,
      payload,
      sourceEventIndex: null,
      tokenAddress: null,
    });

    actions.push({
      actionKey: buildActionKey({
        actionType: 'bridge_in',
        lane: tx.lane,
        sourceEventIndex: null,
        transactionHash: tx.transactionHash,
      }),
      actionType: 'bridge_in',
      accountAddress: tx.senderAddress ?? null,
      executionProtocol: 'bridge',
      metadata: normalizeActionMetadata({
        bridge_direction: 'l1_to_l2',
        calldata: payload,
        l1_sender: l1Sender,
      }),
      protocol: 'bridge',
      sourceEventIndex: null,
    });
  }

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const bridgeKey = buildBridgeKey({
      direction: 'bridge_out',
      lane: tx.lane,
      sourceEventIndex: null,
      transactionHash: tx.transactionHash,
      sequence: index,
    });

    bridges.push({
      amount: null,
      bridgeKey,
      classification: 'message_to_l1',
      direction: 'bridge_out',
      l1Recipient: message.toAddress,
      l2ContractAddress: message.fromAddress,
      l2WalletAddress: tx.senderAddress ?? tx.contractAddress ?? null,
      messageToAddress: message.toAddress,
      payload: message.payload,
      sourceEventIndex: null,
      tokenAddress: null,
    });

    actions.push({
      actionKey: buildActionKey({
        actionType: 'bridge_out',
        lane: tx.lane,
        sourceEventIndex: null,
        transactionHash: tx.transactionHash,
        sequence: index,
      }),
      actionType: 'bridge_out',
      accountAddress: tx.senderAddress ?? tx.contractAddress ?? null,
      executionProtocol: 'bridge',
      metadata: normalizeActionMetadata({
        bridge_direction: 'l2_to_l1',
        message_from: message.fromAddress,
        message_payload: message.payload,
        message_to: message.toAddress,
      }),
      protocol: 'bridge',
      sourceEventIndex: null,
    });
  }

  return { actions, audits, bridges };
}

function normalizeBridgeMessage(rawMessage) {
  return {
    fromAddress: normalizeAddress(rawMessage.from_address, 'message.from_address'),
    payload: normalizeHexArray(rawMessage.payload ?? [], 'message.payload'),
    toAddress: normalizeAddress(rawMessage.to_address, 'message.to_address'),
  };
}

function normalizeL1HandlerSender(calldata) {
  if (!Array.isArray(calldata) || calldata.length === 0) {
    return null;
  }

  return normalizeAddress(calldata[0], 'l1_handler.sender');
}

function emptyResult() {
  return { actions: [], audits: [], bridges: [] };
}

module.exports = {
  extractBridgeActivities,
  normalizeBridgeMessage,
  normalizeL1HandlerSender,
};
