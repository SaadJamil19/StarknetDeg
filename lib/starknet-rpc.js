'use strict';

const { setTimeout: sleep } = require('node:timers/promises');
const { RpcProvider, selector } = require('starknet');
const { bigIntToSafeNumber, toBigIntStrict } = require('./cairo/bigint');

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 10_000;
const DEFAULT_BATCH_MAX_REQUESTS = 100;
const DEFAULT_FALLBACK_CONCURRENCY = 10;
const MAX_FALLBACK_CONCURRENCY = 10;

class StarknetRpcClient {
  constructor(options = {}) {
    this.nodeUrl = options.nodeUrl || process.env.STARKNET_RPC_URL;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.batchSupportMode = normalizeBatchSupportMode(options.batchSupportMode ?? process.env.STARKNET_RPC_BATCH_SUPPORT ?? 'auto');
    this.batchMaxRequests = parsePositiveInteger(
      options.batchMaxRequests ?? process.env.STARKNET_RPC_BATCH_MAX_REQUESTS,
      DEFAULT_BATCH_MAX_REQUESTS,
      'STARKNET_RPC_BATCH_MAX_REQUESTS',
    );
    this.fallbackConcurrency = Math.min(
      parsePositiveInteger(
        options.fallbackConcurrency ?? process.env.STARKNET_RPC_FALLBACK_CONCURRENCY,
        DEFAULT_FALLBACK_CONCURRENCY,
        'STARKNET_RPC_FALLBACK_CONCURRENCY',
      ),
      MAX_FALLBACK_CONCURRENCY,
    );
    this.batchProbeResult = null;

    if (!this.nodeUrl) {
      throw new Error('STARKNET_RPC_URL is required.');
    }

    this.provider = new RpcProvider({ nodeUrl: this.nodeUrl });
  }

  async getBlockNumber() {
    const result = await this._withRetry('starknet_blockNumber', async () => {
      if (typeof this.provider.getBlockNumber === 'function') {
        try {
          return await this.provider.getBlockNumber();
        } catch (error) {
          // Fall back to raw JSON-RPC for providers that fail on their wrapper path.
        }
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

  async getBlockAndStateUpdateBatch(blockNumbers) {
    const normalizedBlockNumbers = Array.from(blockNumbers ?? [])
      .map((value) => toBigIntStrict(value, 'batch block number'));

    if (normalizedBlockNumbers.length === 0) {
      return [];
    }

    if (!await this.supportsBatchRpc()) {
      return this._loadBlockAndStateUpdateFallback(normalizedBlockNumbers);
    }

    const requests = [];
    for (const blockNumber of normalizedBlockNumbers) {
      const blockId = toRpcBlockId(blockNumber);
      const suffix = blockNumber.toString(10);
      requests.push({ id: `block:${suffix}`, method: 'starknet_getBlockWithReceipts', params: [blockId] });
      requests.push({ id: `state:${suffix}`, method: 'starknet_getStateUpdate', params: [blockId] });
    }

    try {
      const resultsById = await this._executeBatchRequests(requests);
      return normalizedBlockNumbers.map((blockNumber) => {
        const suffix = blockNumber.toString(10);
        const block = resultsById.get(`block:${suffix}`);
        const stateUpdate = resultsById.get(`state:${suffix}`);
        if (!block || !stateUpdate) {
          throw new Error(`Incomplete batch payload for block ${suffix}`);
        }

        return { block, stateUpdate };
      });
    } catch (error) {
      if (this.batchSupportMode === 'auto') {
        this.batchProbeResult = false;
        return this._loadBlockAndStateUpdateFallback(normalizedBlockNumbers);
      }

      throw error;
    }
  }

  async supportsBatchRpc() {
    if (this.batchSupportMode === 'off') {
      return false;
    }

    if (this.batchSupportMode === 'on') {
      return true;
    }

    if (this.batchProbeResult !== null) {
      return this.batchProbeResult;
    }

    const probeRequests = [
      { id: 'probe:1', method: 'starknet_blockNumber', params: [] },
      { id: 'probe:2', method: 'starknet_blockNumber', params: [] },
    ];

    try {
      const resultsById = await this._executeBatchRequests(probeRequests);
      this.batchProbeResult = resultsById.size >= 2;
    } catch (error) {
      this.batchProbeResult = false;
    }

    return this.batchProbeResult;
  }

  async getClassHashAt(blockId, contractAddress) {
    const normalizedBlockId = toRpcBlockId(blockId);
    const normalizedContractAddress = toRpcContractAddress(contractAddress);

    return this._withRetry('starknet_getClassHashAt', async () =>
      this._rawRpc('starknet_getClassHashAt', [normalizedBlockId, normalizedContractAddress]));
  }

  async getClassAt(blockId, contractAddress) {
    const normalizedBlockId = toRpcBlockId(blockId);
    const normalizedContractAddress = toRpcContractAddress(contractAddress);

    return this._withRetry('starknet_getClassAt', async () =>
      this._rawRpc('starknet_getClassAt', [normalizedBlockId, normalizedContractAddress]));
  }

  async getStorageAt(blockId, contractAddress, storageKey) {
    const normalizedBlockId = toRpcBlockId(blockId);
    const normalizedContractAddress = toRpcContractAddress(contractAddress);
    const normalizedStorageKey = toRpcStorageKey(storageKey);

    return this._withRetry('starknet_getStorageAt', async () =>
      this._rawRpc('starknet_getStorageAt', [normalizedContractAddress, normalizedStorageKey, normalizedBlockId]));
  }

  async callContract({ blockId = 'latest', calldata = [], contractAddress, entrypoint }) {
    const normalizedBlockId = toRpcBlockId(blockId);
    const normalizedContractAddress = toRpcContractAddress(contractAddress);
    const normalizedCalldata = Array.isArray(calldata)
      ? calldata.map((value) => toRpcCalldataValue(value))
      : [];
    const entryPointSelector = normalizeEntrypointSelector(entrypoint);

    return this._withRetry('starknet_call', async () =>
      this._rawRpc('starknet_call', [{
        calldata: normalizedCalldata,
        contract_address: normalizedContractAddress,
        entry_point_selector: entryPointSelector,
      }, normalizedBlockId]));
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

  async _rawRpcBatch(requests) {
    const response = await fetch(this.nodeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requests),
    });

    if (!response.ok) {
      const error = new Error(`HTTP ${response.status} while calling starknet batch RPC.`);
      error.httpStatus = response.status;
      error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      throw error;
    }

    const payload = await response.json();
    if (!Array.isArray(payload)) {
      const error = new Error('Batch RPC response was not an array.');
      error.retryable = false;
      throw error;
    }

    const resultsById = new Map();
    for (const entry of payload) {
      const responseId = String(entry?.id ?? '');
      if (!responseId) {
        continue;
      }

      if (entry?.error) {
        const error = new Error(`Batch RPC request ${responseId} failed: ${entry.error.message || 'unknown error'}`);
        error.rpcCode = entry.error.code;
        error.rpcData = entry.error.data;
        error.retryable = isRetryableRpcCode(entry.error.code) || isRetryableMessage(entry.error.message);
        throw error;
      }

      resultsById.set(responseId, entry.result);
    }

    for (const request of requests) {
      const requestId = String(request.id);
      if (!resultsById.has(requestId)) {
        const error = new Error(`Batch RPC response missing id=${requestId}`);
        error.retryable = false;
        throw error;
      }
    }

    return resultsById;
  }

  async _executeBatchRequests(requests) {
    const mergedResults = new Map();

    for (const chunk of chunkArray(requests, this.batchMaxRequests)) {
      const chunkResults = await this._withRetry('starknet_batch', async () => this._rawRpcBatch(chunk));
      for (const [id, value] of chunkResults.entries()) {
        mergedResults.set(id, value);
      }
    }

    return mergedResults;
  }

  async _loadBlockAndStateUpdateFallback(blockNumbers) {
    return mapWithConcurrency(
      blockNumbers,
      this.fallbackConcurrency,
      async (blockNumber) => {
        const block = await this.getBlockWithReceipts(blockNumber);
        const stateUpdate = await this.getStateUpdate(blockNumber);
        return { block, stateUpdate };
      },
    );
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

function chunkArray(values, chunkSize) {
  const chunks = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push(values.slice(index, index + chunkSize));
  }
  return chunks;
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const items = Array.from(values ?? []);
  if (items.length === 0) {
    return [];
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array(items.length);
  let cursor = 0;

  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}

function normalizeBatchSupportMode(value) {
  const normalized = String(value ?? 'auto').trim().toLowerCase();
  if (normalized === 'off' || normalized === 'false' || normalized === '0') {
    return 'off';
  }

  if (normalized === 'on' || normalized === 'true' || normalized === '1') {
    return 'on';
  }

  return 'auto';
}

function parsePositiveInteger(value, fallbackValue, label) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallbackValue;
  }

  const parsed = Number.parseInt(String(value).trim(), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer, received: ${value}`);
  }

  return parsed;
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

function toRpcCalldataValue(value) {
  const numericValue = toBigIntStrict(value, 'calldata value');
  if (numericValue < 0n) {
    throw new RangeError('calldata values cannot be negative.');
  }

  return `0x${numericValue.toString(16)}`;
}

function toRpcStorageKey(value) {
  const numericValue = toBigIntStrict(value, 'storage key');
  if (numericValue < 0n) {
    throw new RangeError('storage key cannot be negative.');
  }

  return `0x${numericValue.toString(16)}`;
}

function normalizeEntrypointSelector(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      throw new TypeError('entrypoint is required.');
    }

    if (/^0x[0-9a-fA-F]+$/.test(trimmed)) {
      return trimmed.toLowerCase();
    }

    return `0x${BigInt(selector.getSelectorFromName(trimmed)).toString(16)}`;
  }

  return `0x${toBigIntStrict(value, 'entrypoint selector').toString(16)}`;
}

module.exports = {
  StarknetRpcClient,
  toRpcBlockId,
};
