'use strict';

const { toBigIntStrict, toNumericString } = require('../lib/cairo/bigint');
const { withTransaction } = require('../lib/db');
const { normalizeL1HandlerSender } = require('./bridge');
const { advanceCheckpoint, ensureIndexStateRows, getCheckpoint } = require('./checkpoint');
const { decodeBlockFromRaw } = require('./event-router');
const { FINALITY_LANES, assertValidFinalityLane, normalizeFinalityStatus, summarizeBlockReceipts } = require('./finality');
const { normalizeAddress, normalizeHexArray, normalizeOptionalAddress, normalizeSelector } = require('./normalize');

async function processAcceptedBlock({ rpcClient, indexerKey, lane = FINALITY_LANES.ACCEPTED_ON_L2, blockNumber }) {
  if (!rpcClient) {
    throw new Error('rpcClient is required.');
  }

  const canonicalLane = assertValidFinalityLane(lane);
  const requestedBlockNumber = toBigIntStrict(blockNumber, 'block number');

  if (canonicalLane !== FINALITY_LANES.ACCEPTED_ON_L2) {
    throw new Error(`Phase 2 canonical processor only supports ${FINALITY_LANES.ACCEPTED_ON_L2}. Received ${canonicalLane}.`);
  }

  const [block, stateUpdate] = await Promise.all([
    rpcClient.getBlockWithReceipts(requestedBlockNumber),
    rpcClient.getStateUpdate(requestedBlockNumber),
  ]);

  const normalized = normalizeFetchedBlock({ block, requestedBlockNumber, stateUpdate });
  const emitterClassHashes = await resolveEmitterClassHashes({
    block: normalized.block,
    blockNumber: normalized.blockNumber,
    rpcClient,
  });

  return withTransaction(async (client) => {
    await ensureIndexStateRows(client, indexerKey);

    const checkpoint = await getCheckpoint(client, {
      forUpdate: true,
      indexerKey,
      lane: canonicalLane,
    });

    assertSequentialProgress(checkpoint, normalized);

    await markConflictingBlockRows(client, {
      blockHash: normalized.block.block_hash,
      blockNumber: normalized.blockNumber,
      lane: canonicalLane,
    });

    await clearBlockDerivedRows(client, {
      blockNumber: normalized.blockNumber,
      lane: canonicalLane,
    });

    await upsertBlockJournal(client, {
      lane: canonicalLane,
      normalized,
    });

    await upsertRawArtifacts(client, {
      emitterClassHashes,
      lane: canonicalLane,
      normalized,
    });

    const decodeSummary = await decodeBlockFromRaw(client, {
      blockHash: normalized.block.block_hash,
      blockNumber: normalized.blockNumber,
      lane: canonicalLane,
      rpcClient,
    });

    await advanceCheckpoint(client, {
      blockHash: normalized.block.block_hash,
      blockNumber: normalized.blockNumber,
      finalityStatus: normalized.finalityStatus,
      indexerKey,
      lane: canonicalLane,
      newRoot: normalized.stateUpdate.new_root ?? null,
      oldRoot: normalized.stateUpdate.old_root ?? null,
      parentHash: normalized.block.parent_hash,
    });

    if (normalized.finalityStatus === FINALITY_LANES.ACCEPTED_ON_L1) {
      await advanceCheckpoint(client, {
        blockHash: normalized.block.block_hash,
        blockNumber: normalized.blockNumber,
        finalityStatus: normalized.finalityStatus,
        indexerKey,
        lane: FINALITY_LANES.ACCEPTED_ON_L1,
        newRoot: normalized.stateUpdate.new_root ?? null,
        oldRoot: normalized.stateUpdate.old_root ?? null,
        parentHash: normalized.block.parent_hash,
      });
    }

    return {
      blockHash: normalized.block.block_hash,
      blockNumber: normalized.blockNumber,
      decodeSummary,
      finalityStatus: normalized.finalityStatus,
      summary: normalized.summary,
    };
  });
}

function normalizeFetchedBlock({ block, stateUpdate, requestedBlockNumber }) {
  if (!block || typeof block !== 'object') {
    throw new Error('starknet_getBlockWithReceipts returned an empty payload.');
  }

  if (!stateUpdate || typeof stateUpdate !== 'object') {
    throw new Error('starknet_getStateUpdate returned an empty payload.');
  }

  const blockNumber = toBigIntStrict(block.block_number, 'block.block_number');
  if (blockNumber !== requestedBlockNumber) {
    throw new Error(`Block number mismatch. Requested ${requestedBlockNumber.toString()}, received ${blockNumber.toString()}.`);
  }

  if (!block.block_hash || !block.parent_hash) {
    throw new Error('Block payload is missing block_hash or parent_hash.');
  }

  if (stateUpdate.block_hash && String(stateUpdate.block_hash).toLowerCase() !== String(block.block_hash).toLowerCase()) {
    throw new Error(`State update hash mismatch for block ${blockNumber.toString()}.`);
  }

  if (stateUpdate.new_root && block.new_root && String(stateUpdate.new_root).toLowerCase() !== String(block.new_root).toLowerCase()) {
    throw new Error(`State update new_root mismatch for block ${blockNumber.toString()}.`);
  }

  return {
    block,
    blockNumber,
    finalityStatus: normalizeFinalityStatus(block.status),
    requestedBlockNumber,
    stateUpdate,
    summary: summarizeBlockReceipts(block),
  };
}

function assertSequentialProgress(checkpoint, normalized) {
  if (!checkpoint || checkpoint.lastProcessedBlockNumber === null) {
    return;
  }

  const expectedBlockNumber = checkpoint.lastProcessedBlockNumber + 1n;
  if (normalized.blockNumber !== expectedBlockNumber) {
    throw new Error(
      `Checkpoint gap detected for ${checkpoint.indexerKey}/${checkpoint.lane}. Expected block ${expectedBlockNumber.toString()}, received ${normalized.blockNumber.toString()}.`,
    );
  }

  if (
    checkpoint.lastProcessedBlockHash &&
    String(normalized.block.parent_hash).toLowerCase() !== String(checkpoint.lastProcessedBlockHash).toLowerCase()
  ) {
    throw new Error(
      `Parent hash mismatch at block ${normalized.blockNumber.toString()}. Expected parent ${checkpoint.lastProcessedBlockHash}, received ${normalized.block.parent_hash}.`,
    );
  }
}

async function markConflictingBlockRows(client, { lane, blockNumber, blockHash }) {
  await client.query(
    `UPDATE stark_block_journal
        SET is_orphaned = TRUE,
            orphaned_at = NOW(),
            updated_at = NOW()
      WHERE lane = $1
        AND block_number = $2
        AND block_hash <> $3
        AND is_orphaned = FALSE`,
    [lane, toNumericString(blockNumber, 'block number'), blockHash],
  );
}

async function clearBlockDerivedRows(client, { lane, blockNumber }) {
  const params = [lane, toNumericString(blockNumber, 'block number')];
  const statements = [
    'DELETE FROM stark_action_norm WHERE lane = $1 AND block_number = $2',
    'DELETE FROM stark_transfers WHERE lane = $1 AND block_number = $2',
    'DELETE FROM stark_bridge_activities WHERE lane = $1 AND block_number = $2',
    'DELETE FROM stark_unknown_event_audit WHERE lane = $1 AND block_number = $2',
    'DELETE FROM stark_event_raw WHERE lane = $1 AND block_number = $2',
    'DELETE FROM stark_message_l2_to_l1 WHERE lane = $1 AND block_number = $2',
    'DELETE FROM stark_tx_raw WHERE lane = $1 AND block_number = $2',
  ];

  for (const statement of statements) {
    await client.query(statement, params);
  }
}

async function upsertBlockJournal(client, { lane, normalized }) {
  const { block, stateUpdate, finalityStatus, summary } = normalized;

  await client.query(
    `INSERT INTO stark_block_journal (
         lane,
         block_number,
         block_hash,
         parent_hash,
         old_root,
         new_root,
         finality_status,
         block_timestamp,
         sequencer_address,
         starknet_version,
         l1_da_mode,
         transaction_count,
         event_count,
         state_diff_length,
         succeeded_transaction_count,
         reverted_transaction_count,
         l1_handler_transaction_count,
         is_orphaned,
         orphaned_at,
         raw_block,
         raw_state_update,
         created_at,
         updated_at
     ) VALUES (
         $1,
         $2,
         $3,
         $4,
         $5,
         $6,
         $7,
         $8,
         $9,
         $10,
         $11,
         $12,
         $13,
         $14,
         $15,
         $16,
         $17,
         FALSE,
         NULL,
         $18::jsonb,
         $19::jsonb,
         NOW(),
         NOW()
     )
     ON CONFLICT (lane, block_number, block_hash)
     DO UPDATE SET
         parent_hash = EXCLUDED.parent_hash,
         old_root = EXCLUDED.old_root,
         new_root = EXCLUDED.new_root,
         finality_status = EXCLUDED.finality_status,
         block_timestamp = EXCLUDED.block_timestamp,
         sequencer_address = EXCLUDED.sequencer_address,
         starknet_version = EXCLUDED.starknet_version,
         l1_da_mode = EXCLUDED.l1_da_mode,
         transaction_count = EXCLUDED.transaction_count,
         event_count = EXCLUDED.event_count,
         state_diff_length = EXCLUDED.state_diff_length,
         succeeded_transaction_count = EXCLUDED.succeeded_transaction_count,
         reverted_transaction_count = EXCLUDED.reverted_transaction_count,
         l1_handler_transaction_count = EXCLUDED.l1_handler_transaction_count,
         is_orphaned = FALSE,
         orphaned_at = NULL,
         raw_block = EXCLUDED.raw_block,
         raw_state_update = EXCLUDED.raw_state_update,
         updated_at = NOW()`,
    [
      lane,
      toNumericString(normalized.blockNumber, 'block number'),
      block.block_hash,
      block.parent_hash,
      stateUpdate.old_root ?? null,
      stateUpdate.new_root ?? null,
      finalityStatus,
      block.timestamp === undefined ? null : toNumericString(block.timestamp, 'block timestamp'),
      block.sequencer_address ?? null,
      block.starknet_version ?? null,
      block.l1_da_mode ?? null,
      toNumericString(block.transaction_count ?? summary.total, 'transaction count'),
      toNumericString(block.event_count ?? 0, 'event count'),
      block.state_diff_length === undefined ? null : toNumericString(block.state_diff_length, 'state diff length'),
      toNumericString(summary.succeeded, 'succeeded transaction count'),
      toNumericString(summary.reverted, 'reverted transaction count'),
      toNumericString(summary.l1Handlers, 'l1 handler transaction count'),
      JSON.stringify(block),
      JSON.stringify(stateUpdate),
    ],
  );
}

async function upsertRawArtifacts(client, { emitterClassHashes, lane, normalized }) {
  const blockHash = normalized.block.block_hash;
  const transactions = Array.isArray(normalized.block.transactions) ? normalized.block.transactions : [];

  for (let transactionIndex = 0; transactionIndex < transactions.length; transactionIndex += 1) {
    const item = transactions[transactionIndex] ?? {};
    const transaction = item.transaction ?? {};
    const receipt = item.receipt ?? {};
    const transactionHash = normalizeSelector(receipt.transaction_hash ?? transaction.transaction_hash, 'transaction hash');
    const txType = String(receipt.type ?? transaction.type ?? 'UNKNOWN').toUpperCase();
    const executionStatus = String(receipt.execution_status ?? 'SUCCEEDED').toUpperCase();
    const finalityStatus = normalizeFinalityStatus(receipt.finality_status ?? normalized.finalityStatus);
    const senderAddress = normalizeOptionalAddress(transaction.sender_address, 'tx.sender_address');
    const contractAddress = normalizeOptionalAddress(transaction.contract_address ?? receipt.contract_address, 'tx.contract_address');
    const calldata = Array.isArray(transaction.calldata) ? normalizeHexArray(transaction.calldata, 'tx.calldata') : [];
    const l1SenderAddress = txType === 'L1_HANDLER' ? normalizeL1HandlerSender(calldata) : null;

    await client.query(
      `INSERT INTO stark_tx_raw (
           lane,
           block_number,
           block_hash,
           transaction_index,
           transaction_hash,
           tx_type,
           finality_status,
           execution_status,
           sender_address,
           contract_address,
           l1_sender_address,
           nonce,
           actual_fee_amount,
           actual_fee_unit,
           events_count,
           messages_sent_count,
           revert_reason,
           normalized_status,
           decode_error,
           calldata,
           raw_transaction,
           raw_receipt,
           created_at,
           updated_at,
           processed_at
       ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           $11, $12, $13, $14, $15, $16, $17, 'PENDING', NULL, $18::jsonb, $19::jsonb, $20::jsonb, NOW(), NOW(), NULL
       )
       ON CONFLICT (lane, block_number, transaction_hash)
       DO UPDATE SET
           block_hash = EXCLUDED.block_hash,
           transaction_index = EXCLUDED.transaction_index,
           tx_type = EXCLUDED.tx_type,
           finality_status = EXCLUDED.finality_status,
           execution_status = EXCLUDED.execution_status,
           sender_address = EXCLUDED.sender_address,
           contract_address = EXCLUDED.contract_address,
           l1_sender_address = EXCLUDED.l1_sender_address,
           nonce = EXCLUDED.nonce,
           actual_fee_amount = EXCLUDED.actual_fee_amount,
           actual_fee_unit = EXCLUDED.actual_fee_unit,
           events_count = EXCLUDED.events_count,
           messages_sent_count = EXCLUDED.messages_sent_count,
           revert_reason = EXCLUDED.revert_reason,
           normalized_status = 'PENDING',
           decode_error = NULL,
           calldata = EXCLUDED.calldata,
           raw_transaction = EXCLUDED.raw_transaction,
           raw_receipt = EXCLUDED.raw_receipt,
           processed_at = NULL,
           updated_at = NOW()`,
      [
        lane,
        toNumericString(normalized.blockNumber, 'block number'),
        blockHash,
        toNumericString(transactionIndex, 'transaction index'),
        transactionHash,
        txType,
        finalityStatus,
        executionStatus,
        senderAddress,
        contractAddress,
        l1SenderAddress,
        normalizeOptionalHexText(transaction.nonce),
        toNullableNumeric(receipt.actual_fee?.amount),
        receipt.actual_fee?.unit ?? null,
        toNumericString((receipt.events ?? []).length, 'events count'),
        toNumericString((receipt.messages_sent ?? []).length, 'messages sent count'),
        receipt.revert_reason ?? null,
        JSON.stringify(calldata),
        JSON.stringify(transaction),
        JSON.stringify(receipt),
      ],
    );

    const events = Array.isArray(receipt.events) ? receipt.events : [];
    for (let receiptEventIndex = 0; receiptEventIndex < events.length; receiptEventIndex += 1) {
      const rawEvent = events[receiptEventIndex];
      const fromAddress = normalizeAddress(rawEvent.from_address, 'event.from_address');
      const keys = normalizeHexArray(rawEvent.keys ?? [], 'event.keys');
      const data = normalizeHexArray(rawEvent.data ?? [], 'event.data');
      const selector = keys[0] ?? normalizeSelector(0, 'event.selector');
      const resolvedClassHash = emitterClassHashes.get(fromAddress) ?? null;

      await client.query(
        `INSERT INTO stark_event_raw (
             lane,
             block_number,
             block_hash,
             transaction_hash,
             transaction_index,
             receipt_event_index,
             finality_status,
             transaction_execution_status,
             from_address,
             selector,
             resolved_class_hash,
             normalized_status,
             decode_error,
             keys,
             data,
             raw_event,
             created_at,
             updated_at,
             processed_at
         ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
             $11, 'PENDING', NULL, $12::jsonb, $13::jsonb, $14::jsonb, NOW(), NOW(), NULL
         )
         ON CONFLICT (lane, block_number, transaction_hash, receipt_event_index)
         DO UPDATE SET
             block_hash = EXCLUDED.block_hash,
             transaction_index = EXCLUDED.transaction_index,
             finality_status = EXCLUDED.finality_status,
             transaction_execution_status = EXCLUDED.transaction_execution_status,
             from_address = EXCLUDED.from_address,
             selector = EXCLUDED.selector,
             resolved_class_hash = EXCLUDED.resolved_class_hash,
             normalized_status = 'PENDING',
             decode_error = NULL,
             keys = EXCLUDED.keys,
             data = EXCLUDED.data,
             raw_event = EXCLUDED.raw_event,
             processed_at = NULL,
             updated_at = NOW()`,
        [
          lane,
          toNumericString(normalized.blockNumber, 'block number'),
          blockHash,
          transactionHash,
          toNumericString(transactionIndex, 'transaction index'),
          toNumericString(receiptEventIndex, 'receipt event index'),
          finalityStatus,
          executionStatus,
          fromAddress,
          selector,
          resolvedClassHash,
          JSON.stringify(keys),
          JSON.stringify(data),
          JSON.stringify(rawEvent),
        ],
      );
    }

    const messages = Array.isArray(receipt.messages_sent) ? receipt.messages_sent : [];
    for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
      const rawMessage = messages[messageIndex];
      const payload = normalizeHexArray(rawMessage.payload ?? [], 'message.payload');

      await client.query(
        `INSERT INTO stark_message_l2_to_l1 (
             lane,
             block_number,
             block_hash,
             transaction_hash,
             transaction_index,
             message_index,
             from_address,
             to_address,
             payload,
             raw_message,
             created_at,
             updated_at
         ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, NOW(), NOW()
         )
         ON CONFLICT (lane, block_number, transaction_hash, message_index)
         DO UPDATE SET
             block_hash = EXCLUDED.block_hash,
             transaction_index = EXCLUDED.transaction_index,
             from_address = EXCLUDED.from_address,
             to_address = EXCLUDED.to_address,
             payload = EXCLUDED.payload,
             raw_message = EXCLUDED.raw_message,
             updated_at = NOW()`,
        [
          lane,
          toNumericString(normalized.blockNumber, 'block number'),
          blockHash,
          transactionHash,
          toNumericString(transactionIndex, 'transaction index'),
          toNumericString(messageIndex, 'message index'),
          normalizeAddress(rawMessage.from_address, 'message.from_address'),
          normalizeAddress(rawMessage.to_address, 'message.to_address'),
          JSON.stringify(payload),
          JSON.stringify(rawMessage),
        ],
      );
    }
  }
}

async function resolveEmitterClassHashes({ block, blockNumber, rpcClient }) {
  const uniqueEmitters = new Set();

  for (const item of block.transactions ?? []) {
    for (const rawEvent of item?.receipt?.events ?? []) {
      uniqueEmitters.add(normalizeAddress(rawEvent.from_address, 'event emitter'));
    }
  }

  const results = await Promise.all(
    Array.from(uniqueEmitters).map(async (emitterAddress) => [
      emitterAddress,
      await safeGetClassHashAt({ blockNumber, emitterAddress, rpcClient }),
    ]),
  );

  return new Map(results);
}

async function safeGetClassHashAt({ blockNumber, emitterAddress, rpcClient }) {
  if (!rpcClient || typeof rpcClient.getClassHashAt !== 'function') {
    return null;
  }

  try {
    const result = await rpcClient.getClassHashAt(blockNumber, emitterAddress);
    return result ? normalizeSelector(result, 'class hash') : null;
  } catch (error) {
    return null;
  }
}

function toNullableNumeric(value) {
  if (value === undefined || value === null) {
    return null;
  }

  return toNumericString(toBigIntStrict(value, 'numeric value'), 'numeric value');
}

function normalizeOptionalHexText(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  return `0x${toBigIntStrict(value, 'hex text').toString(16)}`;
}

module.exports = {
  processAcceptedBlock,
};
