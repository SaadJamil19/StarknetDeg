'use strict';

const { normalizeBridgeMessage } = require('./bridge');
const { normalizeAddress, normalizeHexArray, normalizeOptionalAddress, normalizeSelector } = require('./normalize');

async function loadSequencedTransactions(client, { lane, blockNumber, blockHash }) {
  const txResult = await client.query(
    `SELECT lane, block_number, block_hash, transaction_index, transaction_hash, tx_type,
            finality_status, execution_status, sender_address, contract_address,
            l1_sender_address, nonce, actual_fee_amount, actual_fee_unit, events_count,
            messages_sent_count, revert_reason, calldata
       FROM stark_tx_raw
      WHERE lane = $1
        AND block_number = $2
        AND block_hash = $3
      ORDER BY transaction_index ASC`,
    [lane, blockNumber.toString(10), blockHash],
  );
  const eventResult = await client.query(
    `SELECT lane, block_number, block_hash, transaction_hash, transaction_index,
            receipt_event_index, finality_status, transaction_execution_status,
            from_address, selector, resolved_class_hash, keys, data
       FROM stark_event_raw
      WHERE lane = $1
        AND block_number = $2
        AND block_hash = $3
      ORDER BY transaction_index ASC, receipt_event_index ASC`,
    [lane, blockNumber.toString(10), blockHash],
  );
  const messageResult = await client.query(
    `SELECT lane, block_number, block_hash, transaction_hash, transaction_index,
            message_index, from_address, to_address, payload
       FROM stark_message_l2_to_l1
      WHERE lane = $1
        AND block_number = $2
        AND block_hash = $3
      ORDER BY transaction_index ASC, message_index ASC`,
    [lane, blockNumber.toString(10), blockHash],
  );

  const byTransactionHash = new Map();

  for (const row of txResult.rows) {
    const transactionHash = normalizeSelector(row.transaction_hash, 'transaction hash');
    byTransactionHash.set(transactionHash, {
      actualFeeAmount: row.actual_fee_amount === null ? null : BigInt(row.actual_fee_amount),
      actualFeeUnit: row.actual_fee_unit,
      blockHash: row.block_hash,
      blockNumber: BigInt(row.block_number),
      calldata: Array.isArray(row.calldata) ? normalizeHexArray(row.calldata, 'tx.calldata') : [],
      contractAddress: normalizeOptionalAddress(row.contract_address, 'tx.contract_address'),
      events: [],
      executionStatus: row.execution_status,
      finalityStatus: row.finality_status,
      l1SenderAddress: normalizeOptionalAddress(row.l1_sender_address, 'tx.l1_sender_address'),
      lane: row.lane,
      messages: [],
      messagesSentCount: BigInt(row.messages_sent_count),
      nonce: row.nonce,
      revertReason: row.revert_reason,
      senderAddress: normalizeOptionalAddress(row.sender_address, 'tx.sender_address'),
      transactionHash,
      transactionIndex: BigInt(row.transaction_index),
      txType: row.tx_type,
    });
  }

  for (const row of eventResult.rows) {
    const transactionHash = normalizeSelector(row.transaction_hash, 'event.transaction_hash');
    const tx = byTransactionHash.get(transactionHash);
    if (!tx) {
      continue;
    }

    tx.events.push({
      blockHash: row.block_hash,
      blockNumber: BigInt(row.block_number),
      finalityStatus: row.finality_status,
      fromAddress: normalizeAddress(row.from_address, 'event.from_address'),
      keys: normalizeHexArray(row.keys ?? [], 'event.keys'),
      data: normalizeHexArray(row.data ?? [], 'event.data'),
      lane: row.lane,
      receiptEventIndex: BigInt(row.receipt_event_index),
      resolvedClassHash: row.resolved_class_hash ? normalizeSelector(row.resolved_class_hash, 'event.resolved_class_hash') : null,
      selector: normalizeSelector(row.selector, 'event.selector'),
      transactionExecutionStatus: row.transaction_execution_status,
      transactionHash,
      transactionIndex: BigInt(row.transaction_index),
    });
  }

  for (const row of messageResult.rows) {
    const transactionHash = normalizeSelector(row.transaction_hash, 'message.transaction_hash');
    const tx = byTransactionHash.get(transactionHash);
    if (!tx) {
      continue;
    }

    tx.messages.push({
      ...normalizeBridgeMessage({
        from_address: row.from_address,
        payload: row.payload,
        to_address: row.to_address,
      }),
      blockHash: row.block_hash,
      blockNumber: BigInt(row.block_number),
      lane: row.lane,
      messageIndex: BigInt(row.message_index),
      transactionHash,
      transactionIndex: BigInt(row.transaction_index),
    });
  }

  return Array.from(byTransactionHash.values()).sort((left, right) =>
    left.transactionIndex < right.transactionIndex ? -1 : left.transactionIndex > right.transactionIndex ? 1 : 0);
}

module.exports = {
  loadSequencedTransactions,
};
