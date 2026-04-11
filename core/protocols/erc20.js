'use strict';

const { DEFAULT_SCALE, integerAmountToScaled } = require('../../lib/cairo/fixed-point');
const { normalizeAddress, parseU256FromArray } = require('../normalize');
const { resolveTrustedToken } = require('../token-trust-cache');
const { isStableSymbol } = require('../token-registry');
const { buildActionKey, buildTransferKey, normalizeActionMetadata } = require('./shared');

async function decodeEvent({ client, tx, event }) {
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
  const trustedToken = await resolveTrustedToken({ client, tokenAddress });

  if (!trustedToken) {
    return {
      actions: [],
      audits: [buildAuditEntry(tx, event, 'TRANSFER_UNVERIFIED', {
        amount_encoding: 'u256',
        from_key_index: 1,
        to_key_index: 2,
        token_address: tokenAddress,
        verification_gate: 'trusted_token_lookup',
        verification_source: 'trusted_token_lookup_miss',
      }, 'UNKNOWN')],
      transfers: [],
    };
  }

  const actionMetadata = normalizeActionMetadata({
    standard: 'erc20',
    selector: event.selector,
    from_key_index: 1,
    to_key_index: 2,
    amount_encoding: 'u256',
    token_decimals: trustedToken.decimals,
    token_name: trustedToken.name,
    token_symbol: trustedToken.symbol,
    verification_gate: trustedToken.verificationGate,
    verification_level: trustedToken.verificationLevel,
    verification_source: trustedToken.verificationSource,
  });
  const amountHumanScaled = trustedToken.decimals === null || trustedToken.decimals === undefined
    ? null
    : integerAmountToScaled(amount, trustedToken.decimals, DEFAULT_SCALE);
  const amountUsdScaled = isStableSymbol(trustedToken.symbol) ? amountHumanScaled : null;

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
        amountHumanScaled,
        amountUsdScaled,
        counterpartyType: 'unknown',
        fromAddress,
        metadata: actionMetadata,
        protocol: 'erc20',
        sourceEventIndex: event.receiptEventIndex,
        tokenDecimals: trustedToken.decimals ?? null,
        tokenName: trustedToken.name ?? null,
        tokenSymbol: trustedToken.symbol ?? null,
        toAddress,
        tokenAddress,
        transferType: 'standard_transfer',
        transferKey: buildTransferKey({
          lane: tx.lane,
          transactionHash: tx.transactionHash,
          sourceEventIndex: event.receiptEventIndex,
        }),
      },
    ],
  };
}

function buildAuditEntry(tx, event, reason, metadata, normalizedStatus = null) {
  return {
    blockHash: tx.blockHash,
    blockNumber: tx.blockNumber,
    emitterAddress: event.fromAddress,
    lane: tx.lane,
    metadata: normalizeActionMetadata(metadata),
    normalizedStatus,
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
