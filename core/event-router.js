'use strict';

const { extractBridgeActivities } = require('./bridge');
const { loadSequencedTransactions } = require('./event-sequencer');
const { getCandidateProtocolsForSelector, isStandardDexSelector, resolveRoute } = require('./abi-registry');
const {
  SELECTORS,
  getKnownLockerMatchByAddress,
  getStaticMatchesByAddress,
  isAggregatorSwapEvent,
} = require('../lib/registry/dex-registry');
const avnu = require('./protocols/avnu');
const baseAmm = require('./protocols/base-amm');
const ekubo = require('./protocols/ekubo');
const erc20 = require('./protocols/erc20');
const haiko = require('./protocols/haiko');
const myswap = require('./protocols/myswap');
const { normalizeActionMetadata, toJsonbString } = require('./protocols/shared');
const { toNumericString } = require('../lib/cairo/bigint');
const { DEFAULT_SCALE, scaledToNumericString } = require('../lib/cairo/fixed-point');

const DECODERS = Object.freeze({
  avnu,
  'base-amm': baseAmm,
  ekubo,
  erc20,
  haiko,
  myswap,
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
    const receiptContexts = createReceiptContextController();
    const txContext = buildTransactionContext(tx);

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
      const route = await resolveRoute({ client, event, rpcClient, tx });
      const protocolTransitionResult = receiptContexts.transitionTo(route?.decoder ?? null, tx);
      await persistResultBundle(client, tx, protocolTransitionResult);
      summary.actions += protocolTransitionResult.actions.length;
      summary.bridgeActivities += protocolTransitionResult.bridges.length;
      summary.transfers += protocolTransitionResult.transfers.length;

      if (!route) {
        const audit = buildNoRouteAudit({ event, tx });
        await insertAudit(client, audit);
        await markEventStatus(client, tx, event, 'UNKNOWN', audit.reason);
        summary.unknownEvents += 1;
        continue;
      }

      const decoder = DECODERS[route.decoder];
      if (!decoder || typeof decoder.decodeEvent !== 'function') {
        throw new Error(`Decoder ${route.decoder} is not available.`);
      }

      const decoded = await Promise.resolve(decoder.decodeEvent({
        client,
        contractMetadata: route.contractMetadata,
        event,
        receiptContext: receiptContexts.get(route.decoder),
        route,
        rpcClient,
        tx,
      }));
      const result = applyTransactionRoutingContext(decoded, { route, tx, txContext });

      await persistResultBundle(client, tx, result);

      if (result.audits.length > 0) {
        const decodeError = result.audits.map((item) => item.reason).join('; ');
        const auditStatus = resolveAuditStatus(route, result.audits);
        if (auditStatus === 'FAILED') {
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

    const finalFlush = applyTransactionRoutingContext(receiptContexts.flushAll(tx), {
      route: null,
      tx,
      txContext,
    });
    await persistResultBundle(client, tx, finalFlush);
    summary.actions += finalFlush.actions.length;
    summary.bridgeActivities += finalFlush.bridges.length;
    summary.transfers += finalFlush.transfers.length;

    if (failedEventCount > 0) {
      await markTransactionStatus(client, tx, 'FAILED', `${failedEventCount} event(s) failed decoding.`);
      summary.failedTransactions += 1;
    } else {
      await markTransactionStatus(client, tx, 'PROCESSED', null);
    }
  }

  return summary;
}

function buildTransactionContext(tx) {
  const avnuSwapEvents = tx.events.filter((event) => isAggregatorSwapEvent(event));
  
  const internalAmmSwapCount = tx.events.filter((event) => 
    isSwapSignal(event.selector) && !isAggregatorSwapEvent(event)
  ).length;

  return {
    avnuSwapCount: avnuSwapEvents.length,
    hasAvnuSwap: avnuSwapEvents.length > 0,
    internalAmmSwapCount,
  };
}

function isSwapSignal(selectorValue) {
  return [
    SELECTORS.SWAP,
    SELECTORS.MULTI_SWAP,
    SELECTORS.EKUBO_SWAPPED,
  ].includes(selectorValue);
}

function applyTransactionRoutingContext(bundle, { route, tx, txContext }) {
  const normalized = normalizeResultBundle(bundle);
  const actions = normalized.actions.map((action) => {
    const metadata = normalizeActionMetadata({
      ...(action.metadata ?? {}),
      transaction_sender_address: tx.senderAddress ?? null,
    });
    const nextAction = {
      ...action,
      accountAddress: action.accountAddress ?? tx.senderAddress ?? null,
      metadata,
    };

    if (nextAction.actionType === 'swap' && nextAction.protocol === 'avnu' && txContext.internalAmmSwapCount > 1) {
      nextAction.metadata.is_multihop = true;
      nextAction.metadata.total_hops = txContext.internalAmmSwapCount;
    }

    if (nextAction.actionType === 'swap' && txContext.hasAvnuSwap) {
      if (nextAction.protocol === 'avnu') {
        nextAction.routerProtocol = nextAction.routerProtocol ?? 'avnu';
        nextAction.metadata.is_user_facing_aggregated_trade = true;
      } else {
        nextAction.routerProtocol = nextAction.routerProtocol ?? 'avnu';
        nextAction.metadata.is_route_leg = true;
        nextAction.metadata.via_aggregator = 'avnu';
      }
    }

    if (!nextAction.routerProtocol) {
      const lockerAddress = nextAction.metadata?.locker_address ?? nextAction.metadata?.raw_locker ?? null;
      const inferredRouterProtocol = inferRouterProtocolFromLocker(lockerAddress, nextAction.protocol);
      if (inferredRouterProtocol) {
        nextAction.routerProtocol = inferredRouterProtocol;
      }
    }

    if (route?.protocolKey) {
      nextAction.metadata.protocol_key = route.protocolKey;
    }

    if (route?.handler) {
      nextAction.metadata.registry_handler = route.handler;
    }

    return nextAction;
  });

  return {
    actions,
    audits: normalized.audits,
    bridges: normalized.bridges,
    transfers: normalized.transfers,
  };
}

function buildNoRouteAudit({ event, tx }) {
  const isStandard = isStandardDexSelector(event.selector);
  const candidateProtocols = isStandard ? getCandidateProtocolsForSelector(event.selector) : [];

  return {
    blockHash: tx.blockHash,
    blockNumber: tx.blockNumber,
    emitterAddress: event.fromAddress,
    lane: tx.lane,
    metadata: normalizeActionMetadata({
      candidate_protocols: candidateProtocols,
      keys_length: event.keys.length,
      resolved_class_hash: event.resolvedClassHash,
      selector_name: isStandard ? 'standard_dex_selector' : null,
    }),
    reason: isStandard ? 'STANDARD_DEX_SELECTOR_UNMATCHED' : 'NO_DECODER_ROUTE',
    selector: event.selector,
    sourceEventIndex: event.receiptEventIndex,
    transactionHash: tx.transactionHash,
    transactionIndex: tx.transactionIndex,
  };
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
      toJsonbString(action.metadata ?? {}),
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
         amount_human,
         amount_usd,
         token_symbol,
         token_name,
         token_decimals,
         transfer_type,
         is_internal,
         counterparty_type,
         protocol,
         metadata,
         created_at,
         updated_at
     ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21::jsonb, NOW(), NOW()
     )
     ON CONFLICT (transfer_key)
     DO UPDATE SET
         amount = EXCLUDED.amount,
         amount_human = EXCLUDED.amount_human,
         amount_usd = EXCLUDED.amount_usd,
         token_symbol = EXCLUDED.token_symbol,
         token_name = EXCLUDED.token_name,
         token_decimals = EXCLUDED.token_decimals,
         transfer_type = EXCLUDED.transfer_type,
         is_internal = EXCLUDED.is_internal,
         counterparty_type = EXCLUDED.counterparty_type,
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
      transfer.amountHumanScaled === undefined || transfer.amountHumanScaled === null ? null : scaledToNumericString(transfer.amountHumanScaled, DEFAULT_SCALE),
      transfer.amountUsdScaled === undefined || transfer.amountUsdScaled === null ? null : scaledToNumericString(transfer.amountUsdScaled, DEFAULT_SCALE),
      transfer.tokenSymbol ?? null,
      transfer.tokenName ?? null,
      transfer.tokenDecimals === undefined || transfer.tokenDecimals === null ? null : toNumericString(transfer.tokenDecimals, 'transfer token decimals'),
      transfer.transferType ?? 'standard_transfer',
      Boolean(transfer.isInternal),
      transfer.counterpartyType ?? 'unknown',
      transfer.protocol,
      toJsonbString(transfer.metadata ?? {}),
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
      toJsonbString(bridge.payload ?? []),
      bridge.classification,
      toJsonbString(bridge.metadata ?? {}),
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
      toJsonbString(audit.metadata ?? {}),
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

function inferRouterProtocolFromLocker(lockerAddress, defaultProtocol) {
  if (!lockerAddress) {
    return null;
  }

  const knownLockerMatch = getKnownLockerMatchByAddress(lockerAddress);
  if (knownLockerMatch?.protocolKey) {
    return knownLockerMatch.protocolKey;
  }

  const matches = getStaticMatchesByAddress(lockerAddress);
  const sameProtocolCore = matches.find((entry) => entry.protocolKey === defaultProtocol);
  return sameProtocolCore?.protocolKey ?? null;
}

function createReceiptContextController() {
  const contexts = new Map();
  let activeProtocol = null;

  return {
    flushAll(tx) {
      const bundles = [];

      if (activeProtocol) {
        bundles.push(flushProtocol(activeProtocol, tx));
      }

      for (const protocol of Array.from(contexts.keys())) {
        if (protocol === activeProtocol) {
          continue;
        }

        bundles.push(flushProtocol(protocol, tx));
      }

      activeProtocol = null;
      return mergeResultBundles(bundles);
    },
    get(protocol) {
      if (!protocol) {
        return null;
      }

      if (!contexts.has(protocol)) {
        contexts.set(protocol, {});
      }

      return contexts.get(protocol);
    },
    transitionTo(protocol, tx) {
      if (activeProtocol && activeProtocol !== protocol) {
        const flushed = flushProtocol(activeProtocol, tx);
        activeProtocol = protocol ?? null;
        return flushed;
      }

      activeProtocol = protocol ?? null;
      return emptyResultBundle();
    },
  };

  function flushProtocol(protocol, tx) {
    if (!protocol) {
      return emptyResultBundle();
    }

    const receiptContext = contexts.get(protocol);
    if (!receiptContext) {
      return emptyResultBundle();
    }

    const decoder = DECODERS[protocol];
    let result = emptyResultBundle();

    if (decoder && typeof decoder.flushReceiptContext === 'function') {
      result = normalizeResultBundle(decoder.flushReceiptContext({ receiptContext, tx }));
    }

    if (decoder && typeof decoder.clearReceiptContext === 'function') {
      decoder.clearReceiptContext({ receiptContext });
    }

    contexts.delete(protocol);

    if (activeProtocol === protocol) {
      activeProtocol = null;
    }

    return result;
  }
}

function mergeResultBundles(bundles) {
  const merged = emptyResultBundle();

  for (const bundle of bundles) {
    const normalized = normalizeResultBundle(bundle);
    merged.actions.push(...normalized.actions);
    merged.audits.push(...normalized.audits);
    merged.bridges.push(...normalized.bridges);
    merged.transfers.push(...normalized.transfers);
  }

  return merged;
}

function normalizeResultBundle(bundle) {
  return {
    actions: bundle?.actions ?? [],
    audits: bundle?.audits ?? [],
    bridges: bundle?.bridges ?? [],
    transfers: bundle?.transfers ?? [],
  };
}

function emptyResultBundle() {
  return {
    actions: [],
    audits: [],
    bridges: [],
    transfers: [],
  };
}

function resolveAuditStatus(route, audits) {
  const explicitStatuses = new Set();
  let hasImplicitStatus = false;

  for (const audit of audits) {
    if (audit?.normalizedStatus) {
      explicitStatuses.add(audit.normalizedStatus);
    } else {
      hasImplicitStatus = true;
    }
  }

  if (explicitStatuses.has('FAILED')) {
    return 'FAILED';
  }

  if (hasImplicitStatus) {
    return isFatalDecodeAudit(route) ? 'FAILED' : 'UNKNOWN';
  }

  if (explicitStatuses.has('UNKNOWN')) {
    return 'UNKNOWN';
  }

  return isFatalDecodeAudit(route) ? 'FAILED' : 'UNKNOWN';
}

module.exports = {
  decodeBlockFromRaw,
};
