'use strict';

const { setTimeout: sleep } = require('node:timers/promises');
const { RpcProvider } = require('starknet');
const { bigIntToSafeNumber, toBigIntStrict } = require('./cairo/bigint');

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 10_000;

class StarknetRpcClient {
  constructor(options = {}) {
    this.nodeUrl = options.nodeUrl || process.env.STARKNET_RPC_URL;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;

    if (!this.nodeUrl) {
      throw new Error('STARKNET_RPC_URL is required.');
    }

    this.provider = new RpcProvider({ nodeUrl: this.nodeUrl });
  }

  async getBlockNumber() {
    const result = await this._withRetry('starknet_blockNumber', async () => {
      if (typeof this.provider.getBlockNumber === 'function') {
        return this.provider.getBlockNumber();
      }

      return this._rawRpc('starknet_blockNumber', []);
    });

    return toBigIntStrict(result, 'block number');
  }

  async getBlockWithReceipts(blockId) {
    const normalizedBlockId = toRpcBlockId(blockId);

    return this._withRetry('starknet_getBlockWithReceipts', async () =>
      this._rawRpc('starknet_getBlockWithReceipts', [normalizedBlockId]));
  }

  async getStateUpdate(blockId) {
    const normalizedBlockId = toRpcBlockId(blockId);

    return this._withRetry('starknet_getStateUpdate', async () =>
      this._rawRpc('starknet_getStateUpdate', [normalizedBlockId]));
  }

  async getClassHashAt(blockId, contractAddress) {
    const normalizedBlockId = toRpcBlockId(blockId);
    const normalizedContractAddress = toRpcContractAddress(contractAddress);

    return this._withRetry('starknet_getClassHashAt', async () =>
      this._rawRpc('starknet_getClassHashAt', [normalizedBlockId, normalizedContractAddress]));
  }

  async _rawRpc(method, params) {
    const response = await fetch(this.nodeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method,
        params,
      }),
    });

    if (!response.ok) {
      const error = new Error(`HTTP ${response.status} while calling ${method}.`);
      error.httpStatus = response.status;
      error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      throw error;
    }

    const payload = await response.json();
    if (payload.error) {
      const error = new Error(`RPC ${method} failed: ${payload.error.message || 'unknown error'}`);
      error.rpcCode = payload.error.code;
      error.rpcData = payload.error.data;
      error.retryable = isRetryableRpcCode(payload.error.code) || isRetryableMessage(payload.error.message);
      throw error;
    }

    return payload.result;
  }

  async _withRetry(method, operation) {
    let lastError;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;

        if (attempt === this.maxRetries || !shouldRetry(error)) {
          throw error;
        }

        const backoff = Math.min(this.maxDelayMs, this.baseDelayMs * (2 ** attempt));
        const jitter = Math.floor(Math.random() * Math.max(100, Math.floor(backoff / 4)));
        await sleep(backoff + jitter);
      }
    }

    throw lastError;
  }
}

function shouldRetry(error) {
  if (!error) {
    return false;
  }

  if (error.retryable === true) {
    return true;
  }

  if (typeof error.httpStatus === 'number') {
    return error.httpStatus === 408 || error.httpStatus === 429 || error.httpStatus >= 500;
  }

  if (typeof error.rpcCode === 'number') {
    return isRetryableRpcCode(error.rpcCode);
  }

  return isRetryableMessage(error.message);
}

function isRetryableRpcCode(code) {
  return code === -32603 || code === -32000 || code === -32005;
}

function isRetryableMessage(message) {
  const value = String(message || '').toLowerCase();

  if (!value) {
    return false;
  }

  return [
    'rate limit',
    'too many requests',
    'timeout',
    'timed out',
    'temporarily unavailable',
    'connection reset',
    'socket hang up',
    'gateway',
    'internal error',
    'econnreset',
    'etimedout',
  ].some((fragment) => value.includes(fragment));
}

function toRpcBlockId(blockId) {
  if (blockId === undefined || blockId === null || blockId === 'latest' || blockId === 'pending') {
    return blockId ?? 'latest';
  }

  if (typeof blockId === 'string') {
    const trimmed = blockId.trim();

    if (trimmed === 'latest' || trimmed === 'pending') {
      return trimmed;
    }

    if (/^0x[0-9a-fA-F]+$/.test(trimmed)) {
      return { block_hash: trimmed.toLowerCase() };
    }

    if (/^\d+$/.test(trimmed)) {
      return { block_number: Number(trimmed) };
    }
  }

  if (typeof blockId === 'number') {
    if (!Number.isSafeInteger(blockId) || blockId < 0) {
      throw new RangeError(`Invalid block number: ${blockId}`);
    }

    return { block_number: blockId };
  }

  if (typeof blockId === 'bigint') {
    if (blockId < 0n) {
      throw new RangeError(`Invalid block number: ${blockId.toString()}`);
    }

    return { block_number: bigIntToSafeNumber(blockId, 'block number') };
  }

  if (typeof blockId === 'object') {
    if (Object.prototype.hasOwnProperty.call(blockId, 'block_hash')) {
      const blockHash = String(blockId.block_hash).trim().toLowerCase();
      if (!/^0x[0-9a-f]+$/.test(blockHash)) {
        throw new TypeError(`Invalid block hash: ${blockId.block_hash}`);
      }

      return { block_hash: blockHash };
    }

    if (Object.prototype.hasOwnProperty.call(blockId, 'block_number')) {
      const blockNumber = toBigIntStrict(blockId.block_number, 'block number');
      if (blockNumber < 0n) {
        throw new RangeError(`Invalid block number: ${blockNumber.toString()}`);
      }

      return { block_number: bigIntToSafeNumber(blockNumber, 'block number') };
    }
  }

  throw new TypeError(`Unsupported block identifier: ${String(blockId)}`);
}

function toRpcContractAddress(value) {
  const numericValue = toBigIntStrict(value, 'contract address');
  if (numericValue < 0n) {
    throw new RangeError('contract address cannot be negative.');
  }

  return `0x${numericValue.toString(16)}`;
}

module.exports = {
  StarknetRpcClient,
  toRpcBlockId,
};
