'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const { setTimeout: sleep } = require('node:timers/promises');
const { assertL1Tables } = require('../../core/checkpoint');
const { closePool, isFatalDatabaseError, withClient, withTransaction } = require('../../lib/db');
const { EthereumRpcClient } = require('../../lib/ethereum-rpc');
const { decodeStarkgateLog, STARKGATE_L1_CONTRACTS, normalizeEthAddress } = require('../../lib/l1-starkgate');

let shuttingDown = false;

async function main() {
  const rpcClient = new EthereumRpcClient();
  const indexerKey = process.env.ETH_INDEXER_KEY || 'starkgate_l1';
  const pollIntervalMs = parsePositiveInteger(process.env.ETH_INDEXER_POLL_INTERVAL_MS, 15_000);
  const batchSize = parsePositiveInteger(process.env.ETH_INDEXER_BATCH_SIZE, 100);
  const configuredStartBlock = parseOptionalBigInt(process.env.ETH_INDEXER_START_BLOCK, 16_875_000n);

  installSignalHandlers();

  await withClient(async (client) => {
    await assertL1Tables(client);
    await ensureEthIndexStateRow(client, indexerKey);
  });

  console.log(`[phase5] l1-starkgate-indexer starting indexerKey=${indexerKey} batch_size=${batchSize}`);

  while (!shuttingDown) {
    try {
      const latestBlock = await rpcClient.getBlockNumber();
      const state = await withClient((client) => loadEthIndexState(client, indexerKey));
      const nextBlock = state?.lastProcessedBlockNumber === null || state?.lastProcessedBlockNumber === undefined
        ? configuredStartBlock
        : state.lastProcessedBlockNumber + 1n;

      if (nextBlock > latestBlock) {
        await sleep(pollIntervalMs);
        continue;
      }

      const toBlock = nextBlock + BigInt(batchSize - 1) > latestBlock
        ? latestBlock
        : nextBlock + BigInt(batchSize - 1);
      const summary = await processBlockRange({
        fromBlock: nextBlock,
        indexerKey,
        rpcClient,
        toBlock,
      });

      console.log(
        `[phase5] l1-starkgate-indexer blocks=${summary.fromBlock}-${summary.toBlock} logs=${summary.logs} tx=${summary.transactions} normalized=${summary.normalized} unknown=${summary.unknown} failed=${summary.failed}`,
      );
    } catch (error) {
      console.error(`[phase5] l1-starkgate-indexer error: ${formatError(error)}`);
      if (isFatalDatabaseError(error)) {
        console.error('[phase5] l1-starkgate-indexer fatal database connectivity issue detected; exiting for supervisor restart.');
        throw error;
      }
      await sleep(pollIntervalMs);
    }
  }

  await closePool();
}

async function processBlockRange({ fromBlock, indexerKey, rpcClient, toBlock }) {
  const blockCache = new Map();

  for (let blockNumber = fromBlock; blockNumber <= toBlock; blockNumber += 1n) {
    const block = await rpcClient.getBlockByNumber(blockNumber);
    blockCache.set(blockNumber.toString(10), block);
    await withTransaction(async (client) => {
      await upsertEthBlockJournal(client, block);
    });
  }

  const logs = await rpcClient.getLogs({
    address: [
      STARKGATE_L1_CONTRACTS.ETH_BRIDGE,
      STARKGATE_L1_CONTRACTS.ERC20_BRIDGE,
      STARKGATE_L1_CONTRACTS.STRK_BRIDGE,
    ],
    fromBlock,
    toBlock,
  });

  const logsByTx = new Map();
  for (const log of logs) {
    const transactionHash = log.transactionHash;
    if (!logsByTx.has(transactionHash)) {
      logsByTx.set(transactionHash, []);
    }
    logsByTx.get(transactionHash).push(log);
  }

  let normalized = 0;
  let unknown = 0;
  let failed = 0;

  for (const [transactionHash, txLogs] of logsByTx.entries()) {
    await withTransaction(async (client) => {
      const [transaction, receipt] = await Promise.all([
        rpcClient.getTransactionByHash(transactionHash),
        rpcClient.getTransactionReceipt(transactionHash),
      ]);
      const txType = deriveTxType(txLogs);

      await upsertEthTxRaw(client, {
        receipt,
        transaction,
        txType,
      });

      let txFailed = false;
      for (const log of txLogs) {
        const block = blockCache.get(BigInt(log.blockNumber).toString(10));
        const blockTimestamp = block ? hexTimestampToDate(block.timestamp) : null;
        await upsertEthEventRaw(client, { blockTimestamp, log });

        try {
          const decoded = decodeStarkgateLog(log);
          if (!decoded) {
            await markEthEventRaw(client, log, {
              decodeError: null,
              eventType: null,
              normalizedStatus: 'UNKNOWN_EVENT',
            });
            unknown += 1;
            continue;
          }

          await upsertEthStarkgateEvent(client, {
            blockTimestamp,
            decoded,
          });
          await markEthEventRaw(client, log, {
            decodeError: null,
            eventType: decoded.eventType,
            normalizedStatus: 'PROCESSED',
          });
          normalized += 1;
        } catch (error) {
          txFailed = true;
          failed += 1;
          await markEthEventRaw(client, log, {
            decodeError: error.message,
            eventType: null,
            normalizedStatus: 'FAILED',
          });
        }
      }

      await markEthTxRaw(client, transactionHash, BigInt(txLogs[0].blockNumber), {
        decodeError: txFailed ? 'One or more StarkGate logs failed decoding.' : null,
        status: txFailed ? 'FAILED' : 'PROCESSED',
      });
    });
  }

  const finalBlock = blockCache.get(toBlock.toString(10));
  await withTransaction(async (client) => {
    await ensureEthIndexStateRow(client, indexerKey);
    await client.query(
      `UPDATE eth_index_state
          SET last_processed_block_number = $2,
              last_processed_block_hash = $3,
              last_processed_timestamp = $4,
              last_committed_at = NOW(),
              updated_at = NOW(),
              last_error = NULL
        WHERE indexer_key = $1`,
      [
        indexerKey,
        Number(toBlock),
        finalBlock?.hash ?? null,
        finalBlock ? hexTimestampToDate(finalBlock.timestamp) : null,
      ],
    );
  });

  return {
    failed,
    fromBlock: fromBlock.toString(10),
    logs: logs.length,
    normalized,
    toBlock: toBlock.toString(10),
    transactions: logsByTx.size,
    unknown,
  };
}

async function ensureEthIndexStateRow(client, indexerKey) {
  await client.query(
    `INSERT INTO eth_index_state (indexer_key)
     VALUES ($1)
     ON CONFLICT (indexer_key) DO NOTHING`,
    [indexerKey],
  );
}

async function loadEthIndexState(client, indexerKey) {
  const result = await client.query(
    `SELECT indexer_key,
            last_processed_block_number,
            last_processed_block_hash,
            last_processed_timestamp,
            last_finalized_block_number,
            last_error,
            last_committed_at
       FROM eth_index_state
      WHERE indexer_key = $1`,
    [indexerKey],
  );

  if (result.rowCount === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    indexerKey: row.indexer_key,
    lastCommittedAt: row.last_committed_at,
    lastError: row.last_error,
    lastFinalizedBlockNumber: row.last_finalized_block_number === null ? null : BigInt(row.last_finalized_block_number),
    lastProcessedBlockHash: row.last_processed_block_hash,
    lastProcessedBlockNumber: row.last_processed_block_number === null ? null : BigInt(row.last_processed_block_number),
    lastProcessedTimestamp: row.last_processed_timestamp,
  };
}

async function upsertEthBlockJournal(client, block) {
  const blockNumber = BigInt(block.number);
  const blockHash = block.hash;
  const parentHash = block.parentHash;

  await client.query(
    `UPDATE eth_block_journal
        SET is_orphaned = TRUE,
            updated_at = NOW()
      WHERE block_number = $1
        AND block_hash <> $2
        AND is_orphaned = FALSE`,
    [Number(blockNumber), blockHash],
  );

  await client.query(
    `INSERT INTO eth_block_journal (
         block_number,
         block_hash,
         parent_hash,
         block_timestamp,
         transaction_count,
         gas_used,
         base_fee_per_gas,
         is_orphaned,
         raw_block,
         created_at,
         updated_at
     ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, FALSE, $8::jsonb, NOW(), NOW()
     )
     ON CONFLICT (block_number, block_hash)
     DO UPDATE SET
         parent_hash = EXCLUDED.parent_hash,
         block_timestamp = EXCLUDED.block_timestamp,
         transaction_count = EXCLUDED.transaction_count,
         gas_used = EXCLUDED.gas_used,
         base_fee_per_gas = EXCLUDED.base_fee_per_gas,
         raw_block = EXCLUDED.raw_block,
         is_orphaned = FALSE,
         updated_at = NOW()`,
    [
      Number(blockNumber),
      blockHash,
      parentHash,
      hexTimestampToDate(block.timestamp),
      Array.isArray(block.transactions) ? block.transactions.length : 0,
      block.gasUsed === null || block.gasUsed === undefined ? null : BigInt(block.gasUsed).toString(10),
      block.baseFeePerGas === null || block.baseFeePerGas === undefined ? null : BigInt(block.baseFeePerGas).toString(10),
      JSON.stringify(block),
    ],
  );
}

async function upsertEthTxRaw(client, { receipt, transaction, txType }) {
  const gasUsed = receipt.gasUsed === null || receipt.gasUsed === undefined ? null : BigInt(receipt.gasUsed);
  const effectiveGasPrice = receipt.effectiveGasPrice === null || receipt.effectiveGasPrice === undefined
    ? null
    : BigInt(receipt.effectiveGasPrice);
  const actualFeeEth = gasUsed === null || effectiveGasPrice === null ? null : gasUsed * effectiveGasPrice;
  const executionStatus = normalizeExecutionStatus(receipt.status);

  await client.query(
    `INSERT INTO eth_tx_raw (
         transaction_hash,
         block_number,
         block_hash,
         transaction_index,
         from_address,
         to_address,
         tx_type,
         status,
         execution_status,
         gas_used,
         effective_gas_price,
         actual_fee_eth,
         log_count,
         raw_transaction,
         raw_receipt,
         processed_at,
         decode_error,
         created_at,
         updated_at
     ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, 'PENDING', $8, $9, $10, $11, $12,
         $13::jsonb, $14::jsonb, NULL, NULL, NOW(), NOW()
     )
     ON CONFLICT (transaction_hash, block_number)
     DO UPDATE SET
         block_hash = EXCLUDED.block_hash,
         transaction_index = EXCLUDED.transaction_index,
         from_address = EXCLUDED.from_address,
         to_address = EXCLUDED.to_address,
         tx_type = EXCLUDED.tx_type,
         execution_status = EXCLUDED.execution_status,
         gas_used = EXCLUDED.gas_used,
         effective_gas_price = EXCLUDED.effective_gas_price,
         actual_fee_eth = EXCLUDED.actual_fee_eth,
         log_count = EXCLUDED.log_count,
         raw_transaction = EXCLUDED.raw_transaction,
         raw_receipt = EXCLUDED.raw_receipt,
         updated_at = NOW()`,
    [
      transaction.hash,
      Number(BigInt(transaction.blockNumber)),
      transaction.blockHash,
      Number(BigInt(transaction.transactionIndex)),
      transaction.from ? normalizeEthAddress(transaction.from, 'eth tx from') : null,
      transaction.to ? normalizeEthAddress(transaction.to, 'eth tx to') : null,
      txType,
      executionStatus,
      gasUsed === null ? null : gasUsed.toString(10),
      effectiveGasPrice === null ? null : effectiveGasPrice.toString(10),
      actualFeeEth === null ? null : actualFeeEth.toString(10),
      Array.isArray(receipt.logs) ? receipt.logs.length : 0,
      JSON.stringify(transaction),
      JSON.stringify(receipt),
    ],
  );
}

async function markEthTxRaw(client, transactionHash, blockNumber, { decodeError, status }) {
  await client.query(
    `UPDATE eth_tx_raw
        SET status = $3,
            processed_at = NOW(),
            decode_error = $4,
            updated_at = NOW()
      WHERE transaction_hash = $1
        AND block_number = $2`,
    [transactionHash, Number(blockNumber), status, decodeError],
  );
}

async function upsertEthEventRaw(client, { blockTimestamp, log }) {
  await client.query(
    `INSERT INTO eth_event_raw (
         block_number,
         transaction_hash,
         log_index,
         block_hash,
         block_timestamp,
         transaction_index,
         emitter_address,
         topic0,
         topic1,
         topic2,
         topic3,
         data,
         event_type,
         normalized_status,
         decode_error,
         raw_log,
         processed_at,
         created_at,
         updated_at
     ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, $12, NULL, 'PENDING', NULL, $13::jsonb, NULL, NOW(), NOW()
     )
     ON CONFLICT (block_number, transaction_hash, log_index)
     DO UPDATE SET
         block_hash = EXCLUDED.block_hash,
         block_timestamp = EXCLUDED.block_timestamp,
         transaction_index = EXCLUDED.transaction_index,
         emitter_address = EXCLUDED.emitter_address,
         topic0 = EXCLUDED.topic0,
         topic1 = EXCLUDED.topic1,
         topic2 = EXCLUDED.topic2,
         topic3 = EXCLUDED.topic3,
         data = EXCLUDED.data,
         raw_log = EXCLUDED.raw_log,
         updated_at = NOW()`,
    [
      Number(BigInt(log.blockNumber)),
      log.transactionHash,
      Number(BigInt(log.logIndex)),
      log.blockHash,
      blockTimestamp,
      Number(BigInt(log.transactionIndex)),
      normalizeEthAddress(log.address, 'eth log emitter'),
      log.topics?.[0] ?? null,
      log.topics?.[1] ?? null,
      log.topics?.[2] ?? null,
      log.topics?.[3] ?? null,
      log.data ?? '0x',
      JSON.stringify(log),
    ],
  );
}

async function markEthEventRaw(client, log, { decodeError, eventType, normalizedStatus }) {
  await client.query(
    `UPDATE eth_event_raw
        SET event_type = $4,
            normalized_status = $5,
            decode_error = $6,
            processed_at = NOW(),
            updated_at = NOW()
      WHERE block_number = $1
        AND transaction_hash = $2
        AND log_index = $3`,
    [
      Number(BigInt(log.blockNumber)),
      log.transactionHash,
      Number(BigInt(log.logIndex)),
      eventType,
      normalizedStatus,
      decodeError,
    ],
  );
}

async function upsertEthStarkgateEvent(client, { blockTimestamp, decoded }) {
  await client.query(
    `INSERT INTO eth_starkgate_events (
         event_key,
         eth_block_number,
         eth_block_hash,
         eth_block_timestamp,
         eth_transaction_hash,
         eth_log_index,
         emitter_contract,
         event_type,
         l1_sender,
         l1_recipient,
         l2_recipient,
         l2_sender,
         l1_token_address,
         l2_token_address,
         is_native_eth,
         token_symbol,
         amount,
         amount_human,
         amount_usd,
         nonce,
         match_status,
         metadata,
         created_at,
         updated_at
     ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
         $21, $22::jsonb, NOW(), NOW()
     )
     ON CONFLICT (event_key)
     DO UPDATE SET
         eth_block_hash = EXCLUDED.eth_block_hash,
         eth_block_timestamp = EXCLUDED.eth_block_timestamp,
         emitter_contract = EXCLUDED.emitter_contract,
         event_type = EXCLUDED.event_type,
         l1_sender = EXCLUDED.l1_sender,
         l1_recipient = EXCLUDED.l1_recipient,
         l2_recipient = EXCLUDED.l2_recipient,
         l2_sender = EXCLUDED.l2_sender,
         l1_token_address = EXCLUDED.l1_token_address,
         l2_token_address = EXCLUDED.l2_token_address,
         is_native_eth = EXCLUDED.is_native_eth,
         token_symbol = EXCLUDED.token_symbol,
         amount = EXCLUDED.amount,
         amount_human = EXCLUDED.amount_human,
         amount_usd = EXCLUDED.amount_usd,
         nonce = EXCLUDED.nonce,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()`,
    [
      decoded.eventKey,
      Number(decoded.ethBlockNumber),
      decoded.ethBlockHash,
      blockTimestamp,
      decoded.ethTransactionHash,
      Number(decoded.ethLogIndex),
      decoded.emitterContract,
      decoded.eventType,
      decoded.l1Sender,
      decoded.l1Recipient,
      decoded.l2Recipient,
      decoded.l2Sender,
      decoded.l1TokenAddress,
      decoded.l2TokenAddress,
      decoded.isNativeEth,
      decoded.tokenSymbol,
      decoded.amount.toString(10),
      decoded.amountHuman,
      decoded.amountUsd,
      decoded.nonce === null ? null : decoded.nonce.toString(10),
      decoded.matchStatus,
      JSON.stringify(decoded.metadata ?? {}),
    ],
  );
}

function deriveTxType(logs) {
  const decodedTypes = logs.map((log) => decodeStarkgateLog(log)?.eventType).filter(Boolean);
  if (decodedTypes.includes('withdrawal_completed')) {
    return 'withdrawal';
  }

  if (decodedTypes.includes('deposit_initiated')) {
    return 'deposit';
  }

  return 'starkgate';
}

function normalizeExecutionStatus(status) {
  return status === '0x1' ? 'success' : 'reverted';
}

function hexTimestampToDate(value) {
  return new Date(Number(BigInt(value)) * 1000);
}

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

function parseOptionalBigInt(value, fallbackValue) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallbackValue;
  }

  return BigInt(String(value).trim());
}

function formatError(error) {
  if (!error) {
    return 'unknown error';
  }

  return error.stack || error.message || String(error);
}

function installSignalHandlers() {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      shuttingDown = true;
      console.log(`[phase5] l1-starkgate-indexer received ${signal}, stopping after current batch.`);
    });
  }
}

module.exports = {
  main,
  processBlockRange,
};

if (require.main === module) {
  main().catch(async (error) => {
    console.error(`[phase5] l1-starkgate-indexer fatal error: ${formatError(error)}`);
    try {
      await closePool();
    } finally {
      process.exitCode = 1;
    }
  });
}
