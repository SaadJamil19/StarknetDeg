'use strict';

const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');
const { setTimeout: sleep } = require('node:timers/promises');
const { RpcProvider, selector } = require('starknet');
const { bigIntToSafeNumber, toBigIntStrict } = require('./cairo/bigint');

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 10_000;
const DEFAULT_BATCH_MAX_REQUESTS = 100;
const DEFAULT_FALLBACK_CONCURRENCY = 10;
const MAX_FALLBACK_CONCURRENCY = 10;
const DEFAULT_DYNAMIC_BATCH_MAX_REQUESTS = 1000;
const DEFAULT_DYNAMIC_BATCH_MIN_REQUESTS = 20;
const DEFAULT_DYNAMIC_BATCH_LOOKBACK = 5;
const DEFAULT_DYNAMIC_BATCH_LOW_TX_THRESHOLD = 10;
const DEFAULT_RPC_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_RPC_KEEPALIVE_ENABLED = true;
const DEFAULT_RPC_KEEPALIVE_MS = 15_000;
const DEFAULT_RPC_MAX_SOCKETS = 512;
const DEFAULT_RPC_MAX_FREE_SOCKETS = 128;

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
    this.dynamicBatchingEnabled = parseBoolean(
      options.dynamicBatchingEnabled ?? process.env.STARKNET_RPC_DYNAMIC_BATCHING,
      true,
    );
    this.dynamicBatchMaxRequests = Math.max(
      this.batchMaxRequests,
      parsePositiveInteger(
        options.dynamicBatchMaxRequests ?? process.env.STARKNET_RPC_DYNAMIC_BATCH_MAX_REQUESTS,
        DEFAULT_DYNAMIC_BATCH_MAX_REQUESTS,
        'STARKNET_RPC_DYNAMIC_BATCH_MAX_REQUESTS',
      ),
    );
    this.dynamicBatchMinRequests = Math.max(
      2,
      Math.min(
        this.dynamicBatchMaxRequests,
        parsePositiveInteger(
          options.dynamicBatchMinRequests ?? process.env.STARKNET_RPC_DYNAMIC_BATCH_MIN_REQUESTS,
          DEFAULT_DYNAMIC_BATCH_MIN_REQUESTS,
          'STARKNET_RPC_DYNAMIC_BATCH_MIN_REQUESTS',
        ),
      ),
    );
    this.dynamicBatchLookback = parsePositiveInteger(
      options.dynamicBatchLookback ?? process.env.STARKNET_RPC_DYNAMIC_BATCH_LOOKBACK,
      DEFAULT_DYNAMIC_BATCH_LOOKBACK,
      'STARKNET_RPC_DYNAMIC_BATCH_LOOKBACK',
    );
    this.dynamicBatchLowTxThreshold = parseNonNegativeInteger(
      options.dynamicBatchLowTxThreshold ?? process.env.STARKNET_RPC_DYNAMIC_BATCH_LOW_TX_THRESHOLD,
      DEFAULT_DYNAMIC_BATCH_LOW_TX_THRESHOLD,
      'STARKNET_RPC_DYNAMIC_BATCH_LOW_TX_THRESHOLD',
    );
    this.dynamicBatchCurrentRequests = clampInteger(
      this.batchMaxRequests,
      this.dynamicBatchMinRequests,
      this.dynamicBatchMaxRequests,
    );
    this.dynamicBatchTxHistory = [];
    this.requestTimeoutMs = parsePositiveInteger(
      options.requestTimeoutMs ?? process.env.STARKNET_RPC_REQUEST_TIMEOUT_MS,
      DEFAULT_RPC_REQUEST_TIMEOUT_MS,
      'STARKNET_RPC_REQUEST_TIMEOUT_MS',
    );
    this.keepAliveEnabled = parseBoolean(
      options.keepAliveEnabled ?? process.env.STARKNET_RPC_KEEPALIVE,
      DEFAULT_RPC_KEEPALIVE_ENABLED,
    );
    this.keepAliveMsecs = parsePositiveInteger(
      options.keepAliveMsecs ?? process.env.STARKNET_RPC_KEEPALIVE_MSECS,
      DEFAULT_RPC_KEEPALIVE_MS,
      'STARKNET_RPC_KEEPALIVE_MSECS',
    );
    this.maxSockets = parsePositiveInteger(
      options.maxSockets ?? process.env.STARKNET_RPC_MAX_SOCKETS,
      DEFAULT_RPC_MAX_SOCKETS,
      'STARKNET_RPC_MAX_SOCKETS',
    );
    this.maxFreeSockets = parsePositiveInteger(
      options.maxFreeSockets ?? process.env.STARKNET_RPC_MAX_FREE_SOCKETS,
      DEFAULT_RPC_MAX_FREE_SOCKETS,
      'STARKNET_RPC_MAX_FREE_SOCKETS',
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

    this.rpcUrl = new URL(this.nodeUrl);
    this.rpcAgent = createRpcAgent({
      keepAlive: this.keepAliveEnabled,
      keepAliveMsecs: this.keepAliveMsecs,
      maxFreeSockets: this.maxFreeSockets,
      maxSockets: this.maxSockets,
      protocol: this.rpcUrl.protocol,
    });
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

  async getBlockWithTxHashes(blockId) {
    const normalizedBlockId = toRpcBlockId(blockId);

    return this._withRetry('starknet_getBlockWithTxHashes', async () =>
      this._rawRpc('starknet_getBlockWithTxHashes', [normalizedBlockId]));
  }

  async getStateUpdate(blockId) {
    const normalizedBlockId = toRpcBlockId(blockId);

    return this._withRetry('starknet_getStateUpdate', async () =>
      this._rawRpc('starknet_getStateUpdate', [normalizedBlockId]));
  }

  async getBlockAndStateUpdateBatch(blockNumbers) {
    return this._fetchBlockAndStateUpdateBatch(blockNumbers, {
      blockMethod: 'starknet_getBlockWithReceipts',
    });
  }

  async getBlockHeaderAndStateUpdateBatch(blockNumbers) {
    return this._fetchBlockAndStateUpdateBatch(blockNumbers, {
      blockMethod: 'starknet_getBlockWithTxHashes',
    });
  }

  async getBlocksWithReceiptsBatch(blockNumbers) {
    const normalizedBlockNumbers = Array.from(blockNumbers ?? [])
      .map((value) => toBigIntStrict(value, 'batch block number'));

    if (normalizedBlockNumbers.length === 0) {
      return [];
    }

    if (!await this.supportsBatchRpc()) {
      return mapWithConcurrency(
        normalizedBlockNumbers,
        this.fallbackConcurrency,
        async (blockNumber) => this.getBlockWithReceipts(blockNumber),
      );
    }

    const requests = [];
    const requestIds = [];
    let nextRequestId = 1;
    for (const blockNumber of normalizedBlockNumbers) {
      const requestId = nextRequestId;
      nextRequestId += 1;
      requestIds.push(requestId);
      requests.push({
        id: requestId,
        method: 'starknet_getBlockWithReceipts',
        params: [toRpcBlockId(blockNumber)],
      });
    }

    try {
      const resultsById = await this._executeBatchRequests(requests);
      return normalizedBlockNumbers.map((blockNumber, index) => {
        const block = resultsById.get(String(requestIds[index]));
        if (!block) {
          throw new Error(`Incomplete batch payload for block ${blockNumber.toString(10)}`);
        }
        return block;
      });
    } catch (error) {
      if (this.batchSupportMode === 'auto') {
        this.batchProbeResult = false;
        return mapWithConcurrency(
          normalizedBlockNumbers,
          this.fallbackConcurrency,
          async (blockNumber) => this.getBlockWithReceipts(blockNumber),
        );
      }

      throw error;
    }
  }

  async _fetchBlockAndStateUpdateBatch(blockNumbers, { blockMethod }) {
    const normalizedBlockNumbers = Array.from(blockNumbers ?? [])
      .map((value) => toBigIntStrict(value, 'batch block number'));

    if (normalizedBlockNumbers.length === 0) {
      return [];
    }

    if (!await this.supportsBatchRpc()) {
      return this._loadBlockAndStateUpdateFallback(normalizedBlockNumbers);
    }

    const requests = [];
    const blockRequestIds = [];
    const stateRequestIds = [];
    let nextRequestId = 1;

    for (const blockNumber of normalizedBlockNumbers) {
      const blockId = toRpcBlockId(blockNumber);
      const blockRequestId = nextRequestId;
      nextRequestId += 1;
      const stateRequestId = nextRequestId;
      nextRequestId += 1;

      blockRequestIds.push(blockRequestId);
      stateRequestIds.push(stateRequestId);

      requests.push({ id: blockRequestId, method: blockMethod, params: [blockId] });
      requests.push({ id: stateRequestId, method: 'starknet_getStateUpdate', params: [blockId] });
    }

    try {
      const resultsById = await this._executeBatchRequests(requests);
      const payloads = normalizedBlockNumbers.map((blockNumber, index) => {
        const block = resultsById.get(String(blockRequestIds[index]));
        const stateUpdate = resultsById.get(String(stateRequestIds[index]));
        if (!block || !stateUpdate) {
          throw new Error(`Incomplete batch payload for block ${blockNumber.toString(10)}`);
        }

        return { block, stateUpdate };
      });
      this._updateDynamicBatchSize(payloads);
      return payloads;
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
      { id: 1, method: 'starknet_blockNumber', params: [] },
      { id: 2, method: 'starknet_blockNumber', params: [] },
    ];

    try {
      const resultsById = await this._executeBatchRequests(probeRequests);
      this.batchProbeResult = resultsById.has('1') && resultsById.has('2');
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
    const payload = await this._postJson({
      id: Date.now(),
      jsonrpc: '2.0',
      method,
      params,
    }, method);
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
    const payload = await this._postJson(requests, 'starknet batch RPC');
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

  async _postJson(bodyPayload, methodLabel) {
    const body = JSON.stringify(bodyPayload);
    const requestOptions = {
      agent: this.rpcAgent,
      headers: {
        'connection': this.keepAliveEnabled ? 'keep-alive' : 'close',
        'content-length': Buffer.byteLength(body),
        'content-type': 'application/json',
      },
      hostname: this.rpcUrl.hostname,
      method: 'POST',
      path: `${this.rpcUrl.pathname}${this.rpcUrl.search}`,
      port: this.rpcUrl.port || (this.rpcUrl.protocol === 'https:' ? 443 : 80),
      timeout: this.requestTimeoutMs,
    };

    const transport = this.rpcUrl.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const request = transport.request(requestOptions, (response) => {
        let raw = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          raw += chunk;
        });
        response.on('end', () => {
          const statusCode = response.statusCode ?? 0;
          if (statusCode < 200 || statusCode >= 300) {
            const error = new Error(`HTTP ${statusCode} while calling ${methodLabel}.`);
            error.httpStatus = statusCode;
            error.retryable = statusCode === 408 || statusCode === 429 || statusCode >= 500;
            reject(error);
            return;
          }

          try {
            resolve(JSON.parse(raw));
          } catch (error) {
            const parseError = new Error(`Invalid JSON payload from ${methodLabel}: ${error.message}`);
            parseError.retryable = false;
            reject(parseError);
          }
        });
      });

      request.on('timeout', () => {
        const error = new Error(`RPC timeout while calling ${methodLabel}.`);
        error.code = 'ETIMEDOUT';
        error.retryable = true;
        request.destroy(error);
      });

      request.on('error', (error) => {
        error.retryable = error.retryable ?? isRetryableMessage(error.message);
        reject(error);
      });

      request.write(body);
      request.end();
    });
  }

  async _executeBatchRequests(requests, options = {}) {
    const chunkSize = parsePositiveInteger(
      options.chunkSize,
      this._resolveBatchChunkSize(),
      'batch chunk size',
    );
    const mergedResults = new Map();

    for (const chunk of chunkArray(requests, chunkSize)) {
      const chunkResults = await this._withRetry('starknet_batch', async () => this._rawRpcBatch(chunk));
      for (const [id, value] of chunkResults.entries()) {
        mergedResults.set(id, value);
      }
    }

    return mergedResults;
  }

  _resolveBatchChunkSize() {
    if (this.dynamicBatchingEnabled && this.batchSupportMode !== 'off') {
      return this.dynamicBatchCurrentRequests;
    }

    return this.batchMaxRequests;
  }

  _updateDynamicBatchSize(payloads) {
    if (!this.dynamicBatchingEnabled || !Array.isArray(payloads) || payloads.length === 0) {
      return;
    }

    const totalTransactions = payloads.reduce(
      (sum, payload) => sum + countTransactionsFromBlockPayload(payload),
      0,
    );
    this.dynamicBatchTxHistory.push(totalTransactions);
    while (this.dynamicBatchTxHistory.length > this.dynamicBatchLookback) {
      this.dynamicBatchTxHistory.shift();
    }

    let nextChunkSize = this.dynamicBatchCurrentRequests;
    const lowThreshold = this.dynamicBatchLowTxThreshold;

    if (
      this.dynamicBatchTxHistory.length >= this.dynamicBatchLookback
      && this.dynamicBatchTxHistory.every((value) => value < lowThreshold)
    ) {
      nextChunkSize = nextChunkSize * 2;
    } else {
      const latestTx = totalTransactions;
      const averageTx = this.dynamicBatchTxHistory.reduce((sum, value) => sum + value, 0) / this.dynamicBatchTxHistory.length;

      if (latestTx >= lowThreshold * 8 || averageTx >= lowThreshold * 4) {
        nextChunkSize = Math.floor(nextChunkSize / 2);
      } else if (latestTx >= lowThreshold * 4 || averageTx >= lowThreshold * 2) {
        nextChunkSize = Math.floor(nextChunkSize * 0.75);
      }
    }

    this.dynamicBatchCurrentRequests = clampInteger(
      nextChunkSize,
      this.dynamicBatchMinRequests,
      this.dynamicBatchMaxRequests,
    );
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

function parseNonNegativeInteger(value, fallbackValue, label) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallbackValue;
  }

  const parsed = Number.parseInt(String(value).trim(), 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer, received: ${value}`);
  }

  return parsed;
}

function parseBoolean(value, fallbackValue = false) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallbackValue;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function clampInteger(value, minimum, maximum) {
  return Math.min(Math.max(Math.floor(value), minimum), maximum);
}

function countTransactionsFromBlockPayload(payload) {
  const block = payload?.block;
  if (!block || typeof block !== 'object') {
    return 0;
  }

  if (Array.isArray(block.transactions)) {
    return block.transactions.length;
  }

  if (Array.isArray(block.transaction_receipts)) {
    return block.transaction_receipts.length;
  }

  if (Array.isArray(block.receipts)) {
    return block.receipts.length;
  }

  return 0;
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

function createRpcAgent({ protocol, keepAlive, keepAliveMsecs, maxSockets, maxFreeSockets }) {
  const options = {
    keepAlive,
    keepAliveMsecs,
    maxFreeSockets,
    maxSockets,
  };

  if (protocol === 'https:') {
    return new https.Agent(options);
  }

  return new http.Agent(options);
}

module.exports = {
  StarknetRpcClient,
  toRpcBlockId,
};
