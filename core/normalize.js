'use strict';

const { reassembleU256, toBigIntStrict } = require('../lib/cairo/bigint');

const HEX_32_BYTES = 64;
const Q128 = 1n << 128n;
const Q256 = 1n << 256n;
const ZERO_ADDRESS = `0x${'0'.repeat(HEX_32_BYTES)}`;

function normalizeHex(value, options = {}) {
  const { label = 'value', padToBytes = 32 } = options;
  const numericValue = toBigIntStrict(value, label);

  if (numericValue < 0n) {
    throw new RangeError(`${label} cannot be negative.`);
  }

  const rawHex = numericValue.toString(16).toLowerCase();
  const width = padToBytes ? padToBytes * 2 : rawHex.length;

  if (width && rawHex.length > width) {
    throw new RangeError(`${label} exceeds ${padToBytes} bytes.`);
  }

  return `0x${rawHex.padStart(width, '0')}`;
}

function normalizeAddress(value, label = 'address') {
  return normalizeHex(value, { label, padToBytes: 32 });
}

function normalizeOptionalAddress(value, label = 'address') {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  return normalizeAddress(value, label);
}

function normalizeSelector(value, label = 'selector') {
  return normalizeHex(value, { label, padToBytes: 32 });
}

function normalizeHexArray(values, label = 'hex array') {
  if (!Array.isArray(values)) {
    throw new TypeError(`${label} must be an array.`);
  }

  return values.map((value, index) => normalizeHex(value, { label: `${label}[${index}]`, padToBytes: 32 }));
}

function normalizeBoolFromFelt(value, label = 'bool felt') {
  return toBigIntStrict(value, label) !== 0n;
}

function parseU128(value, label = 'u128') {
  const numericValue = toBigIntStrict(value, label);
  if (numericValue < 0n || numericValue >= Q128) {
    throw new RangeError(`${label} must fit inside u128.`);
  }

  return numericValue;
}

function parseU256(low, high, label = 'u256') {
  const lowValue = parseU128(low, `${label}.low`);
  const highValue = parseU128(high, `${label}.high`);
  return reassembleU256(lowValue, highValue);
}

function parseU256FromArray(values, offset = 0, label = 'u256') {
  if (!Array.isArray(values) || values.length < offset + 2) {
    throw new RangeError(`${label} requires two felts starting at offset ${offset}.`);
  }

  return parseU256(values[offset], values[offset + 1], label);
}

function parseI129(magnitude, sign, label = 'i129') {
  const mag = parseU128(magnitude, `${label}.mag`);
  const negative = normalizeBoolFromFelt(sign, `${label}.sign`);

  if (negative && mag !== 0n) {
    return -mag;
  }

  return mag;
}

function parseI129FromArray(values, offset = 0, label = 'i129') {
  if (!Array.isArray(values) || values.length < offset + 2) {
    throw new RangeError(`${label} requires two felts starting at offset ${offset}.`);
  }

  return parseI129(values[offset], values[offset + 1], label);
}

function parseSignedMagnitude(magnitude, sign, label = 'signed magnitude') {
  const mag = toBigIntStrict(magnitude, `${label}.mag`);
  if (mag < 0n) {
    throw new RangeError(`${label}.mag cannot be negative.`);
  }

  const negative = normalizeBoolFromFelt(sign, `${label}.sign`);
  if (negative && mag !== 0n) {
    return -mag;
  }

  return mag;
}

function parseSignedU256(low, high, sign, label = 'signed u256') {
  const value = parseU256(low, high, `${label}.value`);
  return parseSignedMagnitude(value, sign, label);
}

function parseSignedU256FromArray(values, offset = 0, label = 'signed u256') {
  if (!Array.isArray(values) || values.length < offset + 3) {
    throw new RangeError(`${label} requires three felts starting at offset ${offset}.`);
  }

  return parseSignedU256(values[offset], values[offset + 1], values[offset + 2], label);
}

function parseSignedU32(magnitude, sign, label = 'signed u32') {
  const mag = toBigIntStrict(magnitude, `${label}.mag`);
  if (mag < 0n || mag >= (1n << 32n)) {
    throw new RangeError(`${label}.mag must fit inside u32.`);
  }

  return parseSignedMagnitude(mag, sign, label);
}

function parseSignedU32FromArray(values, offset = 0, label = 'signed u32') {
  if (!Array.isArray(values) || values.length < offset + 2) {
    throw new RangeError(`${label} requires two felts starting at offset ${offset}.`);
  }

  return parseSignedU32(values[offset], values[offset + 1], label);
}

function buildPoolKeyId(poolKey) {
  if (!poolKey || typeof poolKey !== 'object') {
    throw new TypeError('poolKey is required.');
  }

  return [
    normalizeAddress(poolKey.token0, 'poolKey.token0'),
    normalizeAddress(poolKey.token1, 'poolKey.token1'),
    parseU128(poolKey.fee, 'poolKey.fee').toString(10),
    parseU128(poolKey.tickSpacing, 'poolKey.tickSpacing').toString(10),
    normalizeAddress(poolKey.extension ?? ZERO_ADDRESS, 'poolKey.extension'),
  ].join(':');
}

function sqrtRatioToPriceRatio(value, label = 'sqrt ratio') {
  const sqrtRatio = toBigIntStrict(value, label);
  if (sqrtRatio < 0n) {
    throw new RangeError(`${label} cannot be negative.`);
  }

  return {
    numerator: sqrtRatio * sqrtRatio,
    denominator: Q256,
  };
}

function sqrtPriceX96ToPriceRatio(value, label = 'sqrt price x96') {
  const sqrtPrice = toBigIntStrict(value, label);
  if (sqrtPrice < 0n) {
    throw new RangeError(`${label} cannot be negative.`);
  }

  return {
    numerator: sqrtPrice * sqrtPrice,
    denominator: 1n << 192n,
  };
}

function sortTokenPair(left, right, label = 'token pair') {
  const tokenLeft = normalizeAddress(left, `${label}.left`);
  const tokenRight = normalizeAddress(right, `${label}.right`);

  if (tokenLeft <= tokenRight) {
    return [tokenLeft, tokenRight];
  }

  return [tokenRight, tokenLeft];
}

function isZeroAddress(value) {
  return normalizeAddress(value) === ZERO_ADDRESS;
}

module.exports = {
  HEX_32_BYTES,
  Q128,
  Q256,
  ZERO_ADDRESS,
  buildPoolKeyId,
  isZeroAddress,
  normalizeAddress,
  normalizeBoolFromFelt,
  normalizeHex,
  normalizeHexArray,
  normalizeOptionalAddress,
  normalizeSelector,
  parseI129,
  parseI129FromArray,
  parseSignedMagnitude,
  parseSignedU32,
  parseSignedU32FromArray,
  parseSignedU256,
  parseSignedU256FromArray,
  parseU128,
  parseU256,
  parseU256FromArray,
  sortTokenPair,
  sqrtPriceX96ToPriceRatio,
  sqrtRatioToPriceRatio,
};
