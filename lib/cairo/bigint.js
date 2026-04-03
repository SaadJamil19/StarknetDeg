'use strict';

const U256_HIGH_MULTIPLIER = 1n << 128n;

function toBigIntStrict(value, label = 'value') {
  if (typeof value === 'bigint') {
    return value;
  }

  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(`${label} must be a safe integer when passed as a number.`);
    }

    return BigInt(value);
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();

    if (!trimmed) {
      throw new TypeError(`${label} cannot be an empty string.`);
    }

    if (/^-?\d+$/.test(trimmed) || /^-?0x[0-9a-fA-F]+$/.test(trimmed)) {
      return BigInt(trimmed);
    }

    throw new TypeError(`${label} must be a decimal or hex integer string.`);
  }

  throw new TypeError(`${label} must be a bigint, safe integer number, or integer string.`);
}

function hexToBigInt(value, label = 'value') {
  if (typeof value !== 'string') {
    throw new TypeError(`${label} must be a hex string.`);
  }

  const trimmed = value.trim().toLowerCase();
  if (!/^0x[0-9a-f]+$/.test(trimmed)) {
    throw new TypeError(`${label} must be a 0x-prefixed hex string.`);
  }

  return BigInt(trimmed);
}

function bigIntToHex(value, label = 'value') {
  const numericValue = toBigIntStrict(value, label);

  if (numericValue < 0n) {
    throw new RangeError(`${label} cannot be negative when encoded as a felt hex string.`);
  }

  return `0x${numericValue.toString(16)}`;
}

function reassembleU256(low, high) {
  const lowValue = toBigIntStrict(low, 'low');
  const highValue = toBigIntStrict(high, 'high');

  if (lowValue < 0n || highValue < 0n) {
    throw new RangeError('u256 limbs must be non-negative.');
  }

  return lowValue + (highValue * U256_HIGH_MULTIPLIER);
}

function toNumericString(value, label = 'value') {
  return toBigIntStrict(value, label).toString(10);
}

function bigIntToSafeNumber(value, label = 'value') {
  const numericValue = toBigIntStrict(value, label);
  const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);

  if (numericValue > maxSafe || numericValue < -maxSafe) {
    throw new RangeError(`${label} exceeds JavaScript safe integer range.`);
  }

  return Number(numericValue);
}

module.exports = {
  U256_HIGH_MULTIPLIER,
  bigIntToHex,
  bigIntToSafeNumber,
  hexToBigInt,
  reassembleU256,
  toBigIntStrict,
  toNumericString,
};
