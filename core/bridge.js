'use strict';

const { knownErc20Cache } = require('./known-erc20-cache');
const { normalizeAddress, normalizeHexArray, parseU256FromArray } = require('./normalize');
const { buildActionKey, buildBridgeKey, normalizeActionMetadata } = require('./protocols/shared');

function extractBridgeActivities({ tx, messages }) {
  if (tx.executionStatus !== 'SUCCEEDED') {
    return emptyResult();
  }

  const actions = [];
  const bridges = [];
  const audits = [];

  if (tx.txType === 'L1_HANDLER') {
    const bridgeIn = buildBridgeIn(tx);
    bridges.push(bridgeIn.bridge);
    actions.push(bridgeIn.action);
    audits.push(...bridgeIn.audits);
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
      metadata: normalizeActionMetadata({
        bridge_direction: 'l2_to_l1',
        message_from: message.fromAddress,
        message_to: message.toAddress,
      }),
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

function buildBridgeIn(tx) {
  const l1Sender = tx.l1SenderAddress ?? null;
  const l2ContractAddress = tx.contractAddress ?? tx.senderAddress ?? null;
  const payload = Array.isArray(tx.calldata) ? normalizeHexArray(tx.calldata, 'tx.calldata') : [];
  const bridgeKey = buildBridgeKey({
    direction: 'bridge_in',
    lane: tx.lane,
    sourceEventIndex: null,
    transactionHash: tx.transactionHash,
  });
  const parsed = tryParseStarkgateBridgeIn({ l1Sender, l2ContractAddress, payload, tx });

  return {
    action: {
      actionKey: buildActionKey({
        actionType: 'bridge_in',
        lane: tx.lane,
        sourceEventIndex: null,
        transactionHash: tx.transactionHash,
      }),
      actionType: 'bridge_in',
      accountAddress: parsed.bridge.l2WalletAddress ?? tx.senderAddress ?? null,
      amount: parsed.bridge.amount ?? null,
      executionProtocol: 'bridge',
      metadata: normalizeActionMetadata({
        bridge_direction: 'l1_to_l2',
        calldata: payload,
        l1_sender: l1Sender,
        ...parsed.actionMetadata,
      }),
      protocol: 'bridge',
      sourceEventIndex: null,
      tokenAddress: parsed.bridge.tokenAddress ?? null,
    },
    audits: parsed.audits,
    bridge: {
      amount: parsed.bridge.amount ?? null,
      bridgeKey,
      classification: parsed.bridge.classification,
      direction: 'bridge_in',
      l1Sender,
      l2ContractAddress,
      l2WalletAddress: parsed.bridge.l2WalletAddress ?? tx.senderAddress ?? null,
      messageToAddress: l2ContractAddress,
      metadata: normalizeActionMetadata(parsed.bridge.metadata),
      payload,
      sourceEventIndex: null,
      tokenAddress: parsed.bridge.tokenAddress ?? null,
    },
  };
}

function tryParseStarkgateBridgeIn({ l1Sender, l2ContractAddress, payload, tx }) {
  const fallback = buildGenericBridgeIn({ l1Sender, l2ContractAddress, payload });
  const bridgeFamily = knownErc20Cache.getBridgeFamily({ l1BridgeAddress: l1Sender, l2BridgeAddress: l2ContractAddress });
  const bridgeTokens = knownErc20Cache.getTokensForBridgePair({ l1BridgeAddress: l1Sender, l2BridgeAddress: l2ContractAddress });

  if (!bridgeFamily && bridgeTokens.length === 0) {
    return fallback;
  }

  try {
    if (bridgeFamily?.family === 'starkgate_multibridge') {
      return parseStarkgateMultibridge({ bridgeFamily, l1Sender, l2ContractAddress, payload });
    }

    if (bridgeTokens.length === 1) {
      return parseLegacyStarkgateBridge({
        l1Sender,
        l2ContractAddress,
        payload,
        token: bridgeTokens[0],
      });
    }

    return fallback;
  } catch (error) {
    fallback.audits.push(buildBridgeAuditEntry({
      metadata: {
        bridge_family: bridgeFamily?.family ?? 'starkgate_legacy',
        error_message: error.message,
        l1_sender: l1Sender,
        l2_contract_address: l2ContractAddress,
        payload_length: payload.length,
      },
      reason: 'STARKGATE_L1_HANDLER_PARSE_FAILED',
      tx,
    }));
    return fallback;
  }
}

function buildGenericBridgeIn({ l1Sender, l2ContractAddress, payload }) {
  return {
    actionMetadata: {
      handler_type: 'generic_l1_handler',
    },
    audits: [],
    bridge: {
      amount: null,
      classification: 'l1_handler',
      l2WalletAddress: null,
      metadata: {
        bridge_direction: 'l1_to_l2',
        calldata: payload,
        handler_type: 'generic_l1_handler',
        l1_sender: l1Sender,
      },
      tokenAddress: null,
    },
  };
}

function parseLegacyStarkgateBridge({ l1Sender, l2ContractAddress, payload, token }) {
  if (payload.length < 4) {
    throw new RangeError('Legacy StarkGate deposit requires at least 4 calldata felts.');
  }

  const l2WalletAddress = normalizeAddress(payload[1], 'starkgate.legacy.l2_wallet');
  const amount = parseU256FromArray(payload, 2, 'starkgate.legacy.amount');

  return {
    actionMetadata: {
      amount_encoding: 'u256',
      bridge_family: 'starkgate_legacy',
      l1_token_address: token.l1TokenAddress,
      l2_bridge_address: l2ContractAddress,
      token_symbol: token.symbol,
      verification_source: token.verificationSource,
    },
    audits: [],
    bridge: {
      amount,
      classification: 'starkgate_l1_handler',
      l2WalletAddress,
      metadata: {
        amount_encoding: 'u256',
        bridge_family: 'starkgate_legacy',
        calldata_shape: 'from_address,l2_recipient,amount_low,amount_high',
        l1_sender: l1Sender,
        l1_token_address: token.l1TokenAddress,
        l2_bridge_address: l2ContractAddress,
        token_symbol: token.symbol,
        verification_source: token.verificationSource,
      },
      tokenAddress: token.l2TokenAddress,
    },
  };
}

function parseStarkgateMultibridge({ bridgeFamily, l1Sender, l2ContractAddress, payload }) {
  if (payload.length < 6) {
    throw new RangeError('StarkGate multibridge deposit requires at least 6 calldata felts.');
  }

  const l1TokenAddress = normalizeAddress(payload[1], 'starkgate.multibridge.l1_token');
  const l1Depositor = normalizeAddress(payload[2], 'starkgate.multibridge.l1_depositor');
  const l2WalletAddress = normalizeAddress(payload[3], 'starkgate.multibridge.l2_wallet');
  const amount = parseU256FromArray(payload, 4, 'starkgate.multibridge.amount');
  const token = knownErc20Cache.resolveStarkgateL2Token({
    l1BridgeAddress: l1Sender,
    l1TokenAddress,
    l2BridgeAddress: l2ContractAddress,
  });

  return {
    actionMetadata: {
      amount_encoding: 'u256',
      bridge_family: bridgeFamily.family,
      l1_depositor: l1Depositor,
      l1_token_address: l1TokenAddress,
      message_tail_length: Math.max(payload.length - 6, 0),
      verification_source: bridgeFamily.verificationSource,
    },
    audits: [],
    bridge: {
      amount,
      classification: 'starkgate_l1_handler',
      l2WalletAddress,
      metadata: {
        amount_encoding: 'u256',
        bridge_family: bridgeFamily.family,
        calldata_shape: 'from_address,l1_token_address,l1_depositor,l2_recipient,amount_low,amount_high,...',
        l1_depositor: l1Depositor,
        l1_sender: l1Sender,
        l1_token_address: l1TokenAddress,
        message_tail_length: Math.max(payload.length - 6, 0),
        verification_source: bridgeFamily.verificationSource,
      },
      tokenAddress: token?.l2TokenAddress ?? null,
    },
  };
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

function buildBridgeAuditEntry({ metadata, reason, tx }) {
  return {
    blockHash: tx.blockHash,
    blockNumber: tx.blockNumber,
    emitterAddress: null,
    lane: tx.lane,
    metadata: normalizeActionMetadata(metadata),
    normalizedStatus: 'UNKNOWN',
    reason,
    selector: null,
    sourceEventIndex: null,
    transactionHash: tx.transactionHash,
    transactionIndex: tx.transactionIndex,
  };
}

module.exports = {
  extractBridgeActivities,
  normalizeBridgeMessage,
  normalizeL1HandlerSender,
};
