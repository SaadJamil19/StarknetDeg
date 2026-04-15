'use strict';

const { setTimeout: sleep } = require('node:timers/promises');

function parsePositiveInteger(value, fallbackValue) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallbackValue;
  }

  const parsed = Number.parseInt(String(value).trim(), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer but received: ${value}`);
  }

  return parsed;
}

function toHexQuantity(value, label = 'quantity') {
  const numericValue = BigInt(value);
  if (numericValue < 0n) {
    throw new RangeError(`${label} cannot be negative.`);
  }

  return `0x${numericValue.toString(16)}`;
}

class EthereumRpcClient {
  constructor({
    url = process.env.ETH_RPC_URL,
    retryDelayMs = parsePositiveInteger(process.env.ETH_RPC_RETRY_DELAY_MS, 1_500),
    retries = parsePositiveInteger(process.env.ETH_RPC_RETRIES, 5),
  } = {}) {
    if (!url) {
      throw new Error('ETH_RPC_URL is required for the L1 StarkGate indexer.');
    }

    this.url = url;
    this.retryDelayMs = retryDelayMs;
    this.retries = retries;
    this.requestId = 0;
  }

  async getBlockNumber() {
    const result = await this._rawRpc('eth_blockNumber', []);
    return BigInt(result);
  }

  async getBlockByNumber(blockNumber, { includeTransactions = false } = {}) {
    return this._rawRpc('eth_getBlockByNumber', [toHexQuantity(blockNumber, 'block number'), includeTransactions]);
  }

  async getLogs({ address, fromBlock, toBlock, topics } = {}) {
    return this._rawRpc('eth_getLogs', [{
      ...(address ? { address } : {}),
      ...(fromBlock === undefined || fromBlock === null ? {} : { fromBlock: toHexQuantity(fromBlock, 'fromBlock') }),
      ...(toBlock === undefined || toBlock === null ? {} : { toBlock: toHexQuantity(toBlock, 'toBlock') }),
      ...(topics ? { topics } : {}),
    }]);
  }

  async getTransactionByHash(transactionHash) {
    return this._rawRpc('eth_getTransactionByHash', [transactionHash]);
  }

  async getTransactionReceipt(transactionHash) {
    return this._rawRpc('eth_getTransactionReceipt', [transactionHash]);
  }

  async _rawRpc(method, params) {
    return this._withRetry(async () => {
      const response = await fetch(this.url, {
        body: JSON.stringify({
          id: ++this.requestId,
          jsonrpc: '2.0',
          method,
          params,
        }),
        headers: {
          'Content-Type': 'application/json',
        },
        method: 'POST',
      });

      if (!response.ok) {
        throw new Error(`Ethereum RPC ${method} failed with HTTP ${response.status}.`);
      }

      const payload = await response.json();
      if (payload.error) {
        throw new Error(`Ethereum RPC ${method} error ${payload.error.code}: ${payload.error.message}`);
      }

      return payload.result;
    });
  }

  async _withRetry(work) {
    let attempt = 0;
    let lastError = null;

    while (attempt <= this.retries) {
      try {
        return await work();
      } catch (error) {
        lastError = error;
        if (attempt >= this.retries) {
          throw lastError;
        }

        await sleep(this.retryDelayMs * Math.max(1, attempt + 1));
      }

      attempt += 1;
    }

    throw lastError ?? new Error('Ethereum RPC request failed unexpectedly.');
  }
}

module.exports = {
  EthereumRpcClient,
  toHexQuantity,
};
