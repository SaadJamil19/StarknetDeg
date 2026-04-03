'use strict';

const { extractBridgeActivities } = require('./bridge');
const { loadSequencedTransactions } = require('./event-sequencer');
const { resolveRoute } = require('./abi-registry');
const erc20 = require('./protocols/erc20');
const jediswap = require('./protocols/jediswap');
const ekubo = require('./protocols/ekubo');
const { normalizeActionMetadata } = require('./protocols/shared');
const { toNumericString } = require('../lib/cairo/bigint');

const DECODERS = Object.freeze({
  erc20,
  ekubo,
  jediswap,
});

async function decodeBlockFromRaw(client, { lane, blockNumber, blockHash, rpcClient }) {
  const transactions = await loadSequencedTransactions(client, { blockHash, blockNumber, lane });
  const summary = {
    actions: 0,
    bridgeActivities: 0,
    failedTransactions: 0,
    revertedTransactions: 0,
    transfers: 0,
    transactions: transactions.length,
    unknownEvents: 0,
  };

  for (const tx of transactions) {
    const receiptContext = { protocols: {} };

    if (tx.executionStatus !== 'SUCCEEDED') {
      await markTransactionStatus(client, tx, 'SKIPPED_REVERTED', tx.revertReason ?? 'Transaction execution_status != SUCCEEDED');
      await markAllEventsStatus(client, tx, 'SKIPPED_REVERTED', tx.revertReason ?? null);
      summary.revertedTransactions += 1;
      continue;
    }

    let failedEventCount = 0;

    const bridgeResults = extractBridgeActivities({ messages: tx.messages, tx });
    await persistResultBundle(client, tx, bridgeResults);
    summary.actions += bridgeResults.actions.length;
    summary.bridgeActivities += bridgeResults.bridges.length;

    for (const event of tx.events) {
      const route = await resolveRoute({ event, rpcClient, tx });

      if (!route) {
        await insertAudit(client, {
          blockHash: tx.blockHash,
          blockNumber: tx.blockNumber,
          emitterAddress: event.fromAddress,
          lane: tx.lane,
          metadata: normalizeActionMetadata({
            keys_length: event.keys.length,
            resolved_class_hash: event.resolvedClassHash,
          }),
          reason: 'NO_DECODER_ROUTE',
          selector: event.selector,
          sourceEventIndex: event.receiptEventIndex,
          transactionHash: tx.transactionHash,
          transactionIndex: tx.transactionIndex,
        });
        await markEventStatus(client, tx, event, 'UNKNOWN', null);
        summary.unknownEvents += 1;
        continue;
      }

      const decoder = DECODERS[route.decoder];
      if (!decoder || typeof decoder.decodeEvent !== 'function') {
        throw new Error(`Decoder ${route.decoder} is not available.`);
      }

      const result = decoder.decodeEvent({
        contractMetadata: route.contractMetadata,
        event,
        receiptContext,
        route,
        tx,
      });

      await persistResultBundle(client, tx, result);

      if (result.audits.length > 0) {
        const decodeError = result.audits.map((item) => item.reason).join('; ');
        if (isFatalDecodeAudit(route)) {
          await markEventStatus(client, tx, event, 'FAILED', decodeError);
          failedEventCount += 1;
        } else {
          await markEventStatus(client, tx, event, 'UNKNOWN', decodeError);
          summary.unknownEvents += 1;
        }
      } else {
        await markEventStatus(client, tx, event, 'PROCESSED', null);
      }

      summary.actions += result.actions.length;
      summary.transfers += result.transfers.length;
    }

    const ekuboFlush = ekubo.flushReceiptContext({ receiptContext, tx });
    await persistResultBundle(client, tx, ekuboFlush);
    summary.actions += ekuboFlush.actions.length;

    if (failedEventCount > 0) {
      await markTransactionStatus(client, tx, 'FAILED', `${failedEventCount} event(s) failed decoding.`);
      summary.failedTransactions += 1;
    } else {
      await markTransactionStatus(client, tx, 'PROCESSED', null);
    }
  }

  return summary;
}

async function persistResultBundle(client, tx, bundle) {
  for (const action of bundle.actions ?? []) {
    await upsertAction(client, tx, action);
  }

  for (const transfer of bundle.transfers ?? []) {
    await upsertTransfer(client, tx, transfer);
  }

  for (const bridge of bundle.bridges ?? []) {
    await upsertBridge(client, tx, bridge);
  }

  for (const audit of bundle.audits ?? []) {
    await insertAudit(client, audit);
  }
}

async function upsertAction(client, tx, action) {
  await client.query(
    `INSERT INTO stark_action_norm (
         action_key,
         lane,
         block_number,
         block_hash,
         transaction_hash,
         transaction_index,
         source_event_index,
         protocol,
         action_type,
         emitter_address,
         account_address,
         pool_id,
         token0_address,
         token1_address,
         token_address,
         amount0,
         amount1,
         amount,
         router_protocol,
         execution_protocol,
         metadata,
         created_at,
         updated_at
     ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
         $21::jsonb, NOW(), NOW()
     )
     ON CONFLICT (action_key)
     DO UPDATE SET
         metadata = EXCLUDED.metadata,
         amount0 = EXCLUDED.amount0,
         amount1 = EXCLUDED.amount1,
         amount = EXCLUDED.amount,
         account_address = EXCLUDED.account_address,
         pool_id = EXCLUDED.pool_id,
         token0_address = EXCLUDED.token0_address,
         token1_address = EXCLUDED.token1_address,
         token_address = EXCLUDED.token_address,
         router_protocol = EXCLUDED.router_protocol,
         execution_protocol = EXCLUDED.execution_protocol,
         updated_at = NOW()`,
    [
      action.actionKey,
      tx.lane,
      toNumericString(tx.blockNumber, 'block number'),
      tx.blockHash,
      tx.transactionHash,
      toNumericString(tx.transactionIndex, 'transaction index'),
      toNullableNumeric(action.sourceEventIndex),
      action.protocol,
      action.actionType,
      action.emitterAddress ?? null,
      action.accountAddress ?? null,
      action.poolId ?? null,
      action.token0Address ?? null,
      action.token1Address ?? null,
      action.tokenAddress ?? null,
      toNullableNumeric(action.amount0),
      toNullableNumeric(action.amount1),
      toNullableNumeric(action.amount),
      action.routerProtocol ?? null,
      action.executionProtocol ?? null,
      JSON.stringify(action.metadata ?? {}),
    ],
  );
}

async function upsertTransfer(client, tx, transfer) {
  await client.query(
    `INSERT INTO stark_transfers (
         transfer_key,
         lane,
         block_number,
         block_hash,
         transaction_hash,
         transaction_index,
         source_event_index,
         token_address,
         from_address,
         to_address,
         amount,
         protocol,
         metadata,
         created_at,
         updated_at
     ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, NOW(), NOW()
     )
     ON CONFLICT (transfer_key)
     DO UPDATE SET
         amount = EXCLUDED.amount,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()`,
    [
      transfer.transferKey,
      tx.lane,
      toNumericString(tx.blockNumber, 'block number'),
      tx.blockHash,
      tx.transactionHash,
      toNumericString(tx.transactionIndex, 'transaction index'),
      toNumericString(transfer.sourceEventIndex, 'source event index'),
      transfer.tokenAddress,
      transfer.fromAddress,
      transfer.toAddress,
      toNumericString(transfer.amount, 'transfer amount'),
      transfer.protocol,
      JSON.stringify(transfer.metadata ?? {}),
    ],
  );
}

async function upsertBridge(client, tx, bridge) {
  await client.query(
    `INSERT INTO stark_bridge_activities (
         bridge_key,
         lane,
         block_number,
         block_hash,
         transaction_hash,
         transaction_index,
         source_event_index,
         direction,
         l1_sender,
         l1_recipient,
         l2_contract_address,
         l2_wallet_address,
         token_address,
         amount,
         message_to_address,
         payload,
         classification,
         metadata,
         created_at,
         updated_at
     ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, $12, $13, $14, $15, $16::jsonb, $17, $18::jsonb, NOW(), NOW()
     )
     ON CONFLICT (bridge_key)
     DO UPDATE SET
         payload = EXCLUDED.payload,
         metadata = EXCLUDED.metadata,
         amount = EXCLUDED.amount,
         updated_at = NOW()`,
    [
      bridge.bridgeKey,
      tx.lane,
      toNumericString(tx.blockNumber, 'block number'),
      tx.blockHash,
      tx.transactionHash,
      toNumericString(tx.transactionIndex, 'transaction index'),
      toNullableNumeric(bridge.sourceEventIndex),
      bridge.direction,
      bridge.l1Sender ?? null,
      bridge.l1Recipient ?? null,
      bridge.l2ContractAddress ?? null,
      bridge.l2WalletAddress ?? null,
      bridge.tokenAddress ?? null,
      toNullableNumeric(bridge.amount),
      bridge.messageToAddress ?? null,
      JSON.stringify(bridge.payload ?? []),
      bridge.classification,
      JSON.stringify(bridge.metadata ?? {}),
    ],
  );
}

async function insertAudit(client, audit) {
  await client.query(
    `INSERT INTO stark_unknown_event_audit (
         lane,
         block_number,
         block_hash,
         transaction_hash,
         transaction_index,
         source_event_index,
         emitter_address,
         selector,
         reason,
         metadata,
         created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, NOW())`,
    [
      audit.lane,
      toNumericString(audit.blockNumber, 'block number'),
      audit.blockHash,
      audit.transactionHash,
      toNumericString(audit.transactionIndex, 'transaction index'),
      toNullableNumeric(audit.sourceEventIndex),
      audit.emitterAddress ?? null,
      audit.selector ?? null,
      audit.reason,
      JSON.stringify(audit.metadata ?? {}),
    ],
  );
}

async function markTransactionStatus(client, tx, status, decodeError) {
  await client.query(
    `UPDATE stark_tx_raw
        SET normalized_status = $4,
            decode_error = $5,
            processed_at = NOW(),
            updated_at = NOW()
      WHERE lane = $1
        AND block_number = $2
        AND transaction_hash = $3`,
    [
      tx.lane,
      toNumericString(tx.blockNumber, 'block number'),
      tx.transactionHash,
      status,
      decodeError ?? null,
    ],
  );
}

async function markAllEventsStatus(client, tx, status, decodeError) {
  await client.query(
    `UPDATE stark_event_raw
        SET normalized_status = $4,
            decode_error = $5,
            processed_at = NOW(),
            updated_at = NOW()
      WHERE lane = $1
        AND block_number = $2
        AND transaction_hash = $3`,
    [
      tx.lane,
      toNumericString(tx.blockNumber, 'block number'),
      tx.transactionHash,
      status,
      decodeError ?? null,
    ],
  );
}

async function markEventStatus(client, tx, event, status, decodeError) {
  await client.query(
    `UPDATE stark_event_raw
        SET normalized_status = $5,
            decode_error = $6,
            processed_at = NOW(),
            updated_at = NOW()
      WHERE lane = $1
        AND block_number = $2
        AND transaction_hash = $3
        AND receipt_event_index = $4`,
    [
      tx.lane,
      toNumericString(tx.blockNumber, 'block number'),
      tx.transactionHash,
      toNumericString(event.receiptEventIndex, 'receipt event index'),
      status,
      decodeError ?? null,
    ],
  );
}

function toNullableNumeric(value) {
  if (value === undefined || value === null) {
    return null;
  }

  return toNumericString(value, 'numeric value');
}

function isFatalDecodeAudit(route) {
  return Boolean(route?.contractMetadata?.decoder || route?.contractMetadata?.protocol);
}

module.exports = {
  decodeBlockFromRaw,
};
