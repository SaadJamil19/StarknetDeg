'use strict';

const { bigIntToSafeNumber, toBigIntStrict } = require('./bigint');

function decodeStarknetStringResult(values) {
  return inspectStarknetStringResult(values).decoded;
}

function inspectStarknetStringResult(values) {
  const normalizedValues = Array.isArray(values) ? values.map((value, index) => toBigIntStrict(value, `string felt ${index}`)) : [];
  if (normalizedValues.length === 0) {
    return {
      decoded: null,
      decodeFailed: false,
      rawHex: [],
      rawHexJoined: null,
    };
  }

  const byteArray = tryDecodeByteArray(normalizedValues);
  if (byteArray) {
    return finalizeDecoded(byteArray, normalizedValues);
  }

  const concatenated = normalizedValues
    .map((value) => decodeShortStringFelt(value))
    .filter(Boolean)
    .join('');
  if (concatenated) {
    return finalizeDecoded(concatenated, normalizedValues);
  }

  const single = decodeShortStringFelt(normalizedValues[0]);
  if (single) {
    return finalizeDecoded(single, normalizedValues);
  }

  return {
    decoded: null,
    decodeFailed: true,
    rawHex: normalizedValues.map((value) => `0x${value.toString(16)}`),
    rawHexJoined: normalizedValues.map((value) => `0x${value.toString(16)}`).join(','),
  };
}

function finalizeDecoded(decoded, normalizedValues) {
  const rawHex = normalizedValues.map((value) => `0x${value.toString(16)}`);

  return {
    decoded,
    decodeFailed: false,
    rawHex,
    rawHexJoined: rawHex.join(','),
  };
}

function decodeShortStringFelt(value) {
  const numericValue = toBigIntStrict(value, 'short string felt');
  if (numericValue === 0n) {
    return '';
  }

  const buffer = feltToBuffer(numericValue, { trimLeadingZeros: true });
  if (!isMostlyPrintable(buffer)) {
    return null;
  }

  return buffer.toString('utf8').replace(/\0+$/g, '');
}

function feltToBuffer(value, options = {}) {
  const { trimLeadingZeros = false, widthBytes = null } = options;
  const numericValue = toBigIntStrict(value, 'felt');
  if (numericValue < 0n) {
    throw new RangeError('felt cannot be negative.');
  }

  let hex = numericValue.toString(16);
  if (hex.length % 2 !== 0) {
    hex = `0${hex}`;
  }

  if (widthBytes !== null) {
    const expectedWidth = widthBytes * 2;
    if (hex.length > expectedWidth) {
      throw new RangeError(`felt exceeds ${widthBytes} bytes.`);
    }
    hex = hex.padStart(expectedWidth, '0');
  }

  let buffer = Buffer.from(hex || '00', 'hex');
  if (trimLeadingZeros) {
    let index = 0;
    while (index < buffer.length && buffer[index] === 0) {
      index += 1;
    }
    buffer = index === 0 ? buffer : buffer.slice(index);
  }

  return buffer;
}

function isMostlyPrintable(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return false;
  }

  for (const byte of buffer.values()) {
    if (byte === 0 || byte === 9 || byte === 10 || byte === 13) {
      continue;
    }
    if (byte < 32 || byte > 126) {
      return false;
    }
  }

  return true;
}

function tryDecodeByteArray(values) {
  if (values.length < 3) {
    return null;
  }

  let wordCount;
  let pendingLength;

  try {
    wordCount = bigIntToSafeNumber(values[0], 'byte array word count');
    pendingLength = bigIntToSafeNumber(values[values.length - 1], 'byte array pending word length');
  } catch (error) {
    return null;
  }

  if (wordCount < 0 || pendingLength < 0 || pendingLength > 31) {
    return null;
  }

  if (values.length !== wordCount + 3) {
    return null;
  }

  const chunks = [];
  for (let index = 0; index < wordCount; index += 1) {
    chunks.push(feltToBuffer(values[index + 1], { widthBytes: 31 }));
  }

  if (pendingLength > 0) {
    chunks.push(feltToBuffer(values[values.length - 2], { widthBytes: pendingLength }));
  }

  const decoded = Buffer.concat(chunks);
  if (!isMostlyPrintable(decoded)) {
    return null;
  }

  return decoded.toString('utf8').replace(/\0+$/g, '');
}

module.exports = {
  decodeShortStringFelt,
  decodeStarknetStringResult,
  inspectStarknetStringResult,
};
