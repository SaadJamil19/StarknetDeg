'use strict';

const { normalizeHex } = require('../normalize');

function stringifyBigInts(value) {
  if (typeof value === 'bigint') {
    return value.toString(10);
  }

  if (Array.isArray(value)) {
    return value.map((item) => stringifyBigInts(item));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, stringifyBigInts(item)]));
  }

  return value;
}

function normalizeActionMetadata(value) {
  return stringifyBigInts(value ?? {});
}

function toJsonbString(value) {
  return JSON.stringify(stringifyBigInts(value));
}

function buildActionKey({ lane, transactionHash, sourceEventIndex, actionType, sequence = 0 }) {
  return [
    lane,
    normalizeHex(transactionHash, { label: 'transaction hash', padToBytes: 32 }),
    sourceEventIndex === null || sourceEventIndex === undefined ? 'receipt' : String(sourceEventIndex),
    actionType,
    String(sequence),
  ].join(':');
}

function buildTransferKey({ lane, transactionHash, sourceEventIndex }) {
  return [
    lane,
    normalizeHex(transactionHash, { label: 'transaction hash', padToBytes: 32 }),
    String(sourceEventIndex),
    'transfer',
  ].join(':');
}

function buildBridgeKey({ lane, transactionHash, sourceEventIndex, direction, sequence = 0 }) {
  return [
    lane,
    normalizeHex(transactionHash, { label: 'transaction hash', padToBytes: 32 }),
    sourceEventIndex === null || sourceEventIndex === undefined ? 'receipt' : String(sourceEventIndex),
    direction,
    String(sequence),
  ].join(':');
}

module.exports = {
  buildActionKey,
  buildBridgeKey,
  buildTransferKey,
  normalizeActionMetadata,
  stringifyBigInts,
  toJsonbString,
};
