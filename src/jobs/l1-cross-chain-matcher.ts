'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const { setTimeout: sleep } = require('node:timers/promises');
const { assertFoundationTables, assertPhase2Tables, assertPhase3Tables, assertPhase4Tables, assertPhase6Tables, assertL1Tables } = require('../../core/checkpoint');
const { FINALITY_LANES } = require('../../core/finality');
const { toJsonbString } = require('../../core/protocols/shared');
const { closePool, withClient, withTransaction } = require('../../lib/db');
const { toBigIntStrict, toNumericString } = require('../../lib/cairo/bigint');
const { DEFAULT_SCALE, decimalStringToScaled, scaledToNumericString } = require('../../lib/cairo/fixed-point');
const { formatError, computeUsdValueFromRawAmount, loadTokenMarketContext, parseBoolean, parsePositiveInteger, resolveAnalyticsWindow, scaledOrNullToNumeric } = require('../../jobs/analytics-utils');

let shuttingDown = false;

async function main() {
  const runOnce = parseBoolean(process.env.L1_MATCHER_RUN_ONCE, false);
  const intervalMs = parsePositiveInteger(process.env.L1_MATCHER_INTERVAL_MS, 120_000);

  installSignalHandlers();

  await withClient(async (client) => {
    await assertFoundationTables(client);
    await assertPhase2Tables(client);
    await assertPhase3Tables(client);
    await assertPhase4Tables(client);
    await assertPhase6Tables(client);
    await assertL1Tables(client);
  });

  console.log(`[phase5] l1-cross-chain-matcher starting run_once=${runOnce}`);

  do {
    try {
      const summary = await runMatcherPass();
      console.log(
        `[phase5] l1-cross-chain-matcher deposits_matched=${summary.depositsMatched} withdrawals_matched=${summary.withdrawalsMatched} stale_unmatched=${summary.staleUnmatched} whale_alerts=${summary.whaleAlerts}`,
      );
    } catch (error) {
      console.error(`[phase5] l1-cross-chain-matcher error: ${formatError(error)}`);
    }

    if (runOnce || shuttingDown) {
      break;
    }

    await sleep(intervalMs);
  } while (!shuttingDown);

  await closePool();
}

async function runMatcherPass({
  indexerKey = process.env.INDEXER_KEY || 'starknetdeg-mainnet',
  lane = process.env.L1_MATCHER_LANE || FINALITY_LANES.ACCEPTED_ON_L2,
  requireL1 = parseBoolean(process.env.PHASE6_REQUIRE_L1, false),
} = {}) {
  await withClient(async (client) => {
    await assertFoundationTables(client);
    await assertPhase2Tables(client);
    await assertPhase3Tables(client);
    await assertPhase4Tables(client);
    await assertPhase6Tables(client);
    await assertL1Tables(client);
  });

  const window = await withClient((client) => resolveAnalyticsWindow(client, { indexerKey, lane, requireL1 }));
  const tokenAddresses = await withClient((client) => loadPendingEventTokenAddresses(client));
  const tokenContext = await withClient((client) => loadTokenMarketContext(client, {
    lane: window.lane,
    tokenAddresses,
  }));

  const pendingDeposits = await withClient((client) => loadPendingL1Events(client, 'deposit_initiated'));
  const pendingWithdrawals = await withClient((client) => loadPendingL1Events(client, 'withdrawal_completed'));
  let depositsMatched = 0;
  let withdrawalsMatched = 0;
  let whaleAlerts = 0;

  for (const event of pendingDeposits) {
    const result = await withTransaction((client) => matchSingleDeposit(client, event, { lane: window.lane, tokenContext }));
    if (result.matched) {
      depositsMatched += 1;
      whaleAlerts += result.whaleAlerts;
    }
  }

  for (const event of pendingWithdrawals) {
    const matched = await withTransaction((client) => matchSingleWithdrawal(client, event, { lane: window.lane }));
    if (matched) {
      withdrawalsMatched += 1;
    }
  }

  const staleUnmatched = await withTransaction((client) => markStaleUnmatched(client, { lane: window.lane }));

  return {
    depositsMatched,
    staleUnmatched,
    whaleAlerts,
    withdrawalsMatched,
  };
}

async function loadPendingEventTokenAddresses(client) {
  const result = await client.query(
    `SELECT DISTINCT l2_token_address
       FROM eth_starkgate_events
      WHERE match_status = 'PENDING'
        AND l2_token_address IS NOT NULL`,
  );

  return result.rows.map((row) => row.l2_token_address);
}

async function loadPendingL1Events(client, eventType) {
  const result = await client.query(
    `SELECT event_key,
            eth_block_number,
            eth_block_timestamp,
            eth_transaction_hash,
            eth_log_index,
            event_type,
            l1_sender,
            l1_recipient,
            l2_recipient,
            l2_sender,
            l1_token_address,
            l2_token_address,
            amount,
            amount_human,
            amount_usd,
            nonce,
            metadata
       FROM eth_starkgate_events
      WHERE event_type = $1
        AND match_status = 'PENDING'
        AND created_at > NOW() - INTERVAL '48 hours'
      ORDER BY eth_block_timestamp ASC, eth_block_number ASC, eth_log_index ASC`,
    [eventType],
  );

  return result.rows.map((row) => ({
    amount: toBigIntStrict(row.amount, 'pending l1 event amount'),
    amountHuman: row.amount_human,
    amountUsd: row.amount_usd,
    ethBlockNumber: BigInt(row.eth_block_number),
    ethBlockTimestamp: new Date(row.eth_block_timestamp),
    ethLogIndex: BigInt(row.eth_log_index),
    ethTransactionHash: row.eth_transaction_hash,
    eventKey: row.event_key,
    eventType: row.event_type,
    l1Recipient: row.l1_recipient,
    l1Sender: row.l1_sender,
    l1TokenAddress: row.l1_token_address,
    l2Recipient: row.l2_recipient,
    l2Sender: row.l2_sender,
    l2TokenAddress: row.l2_token_address,
    metadata: row.metadata ?? {},
    nonce: row.nonce === null ? null : BigInt(row.nonce),
  }));
}

async function matchSingleDeposit(client, event, { lane, tokenContext }) {
  const lockedEvent = await lockPendingEvent(client, event.eventKey);
  if (!lockedEvent || lockedEvent.matchStatus !== 'PENDING') {
    return { matched: false, whaleAlerts: 0 };
  }

  let match = null;
  let strategy = null;

  if (lockedEvent.nonce !== null) {
    match = await findBridgeInMatchByNonce(client, lockedEvent, lane);
    strategy = match ? 'nonce' : null;
  }

  if (!match) {
    match = await findBridgeInMatchByAmountAndTime(client, lockedEvent, lane);
    strategy = match ? 'amount_time' : null;
  }

  if (!match) {
    return { matched: false, whaleAlerts: 0 };
  }

  const settlementSeconds = Math.max(0, Math.floor((match.blockTimestamp.getTime() - lockedEvent.ethBlockTimestamp.getTime()) / 1000));
  const latestL1Processed = await loadLatestEthProcessedBlock(client);
  const settlementBlocksL1 = latestL1Processed === null ? null : Number(latestL1Processed - lockedEvent.ethBlockNumber);
  const tokenInfo = lockedEvent.l2TokenAddress ? tokenContext.get(lockedEvent.l2TokenAddress) ?? null : null;
  const amountUsdScaled = tokenInfo ? computeUsdValueFromRawAmount(lockedEvent.amount, tokenInfo, { allowStale: true }) : null;

  await client.query(
    `UPDATE eth_starkgate_events
        SET stark_tx_hash = $2,
            stark_block_number = $3,
            stark_bridge_key = $4,
            matched_at = NOW(),
            match_status = 'MATCHED',
            match_strategy = $5,
            settlement_seconds = $6,
            settlement_blocks_l1 = $7,
            settlement_blocks_l2 = $8,
            amount_usd = COALESCE($9, amount_usd),
            updated_at = NOW()
      WHERE event_key = $1
        AND match_status = 'PENDING'`,
    [
      lockedEvent.eventKey,
      match.transactionHash,
      toNumericString(match.blockNumber, 'matched bridge block number'),
      match.bridgeKey,
      strategy,
      settlementSeconds,
      settlementBlocksL1,
      null,
      scaledOrNullToNumeric(amountUsdScaled),
    ],
  );

  await client.query(
    `UPDATE stark_bridge_activities
        SET eth_tx_hash = $2,
            eth_block_number = $3,
            eth_block_timestamp = $4,
            eth_log_index = $5,
            eth_event_key = $6,
            l1_match_status = 'MATCHED',
            settlement_seconds = $7,
            settlement_blocks_l1 = $8,
            settlement_blocks_l2 = $9,
            metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
              'l1_match_strategy', $10::text,
              'matched_eth_sender', $11::text,
              'matched_eth_token', $12::text
            ),
            updated_at = NOW()
      WHERE bridge_key = $1
        AND l1_match_status = 'PENDING'`,
    [
      match.bridgeKey,
      lockedEvent.ethTransactionHash,
      Number(lockedEvent.ethBlockNumber),
      lockedEvent.ethBlockTimestamp,
      Number(lockedEvent.ethLogIndex),
      lockedEvent.eventKey,
      settlementSeconds,
      settlementBlocksL1,
      null,
      strategy,
      lockedEvent.l1Sender,
      lockedEvent.l1TokenAddress,
    ],
  );

  await updateBridgeFlowSnapshot(client, {
    amountUsdScaled,
    bridgeDirection: 'bridge_in',
    lane,
    tokenAddress: match.tokenAddress,
    walletAddress: match.walletAddress,
  });

  await updateWalletStatsL1Snapshot(client, {
    amountUsdScaled,
    bridgeDirection: 'bridge_in',
    ethBlockNumber: lockedEvent.ethBlockNumber,
    l1WalletAddress: lockedEvent.l1Sender,
    lane,
    settlementSeconds,
    walletAddress: match.walletAddress,
  });

  const rapidTradeCount = await linkTradesToDeposit(client, {
    depositBlockNumber: lockedEvent.ethBlockNumber,
    depositTimestamp: lockedEvent.ethBlockTimestamp,
    ethTransactionHash: lockedEvent.ethTransactionHash,
    l1WalletAddress: lockedEvent.l1Sender,
    traderAddress: match.walletAddress,
  });

  const whaleAlerts = await maybeInsertBridgeWhaleAlert(client, {
    amount: lockedEvent.amount,
    amountUsdScaled,
    bridgeKey: match.bridgeKey,
    lane,
    rapidTradeCount,
    settlementSeconds,
    tokenAddress: match.tokenAddress,
    walletAddress: match.walletAddress,
    event: lockedEvent,
  });

  return {
    matched: true,
    whaleAlerts,
  };
}

async function lockPendingEvent(client, eventKey) {
  const result = await client.query(
    `SELECT event_key,
            eth_block_number,
            eth_block_timestamp,
            eth_transaction_hash,
            eth_log_index,
            event_type,
            l1_sender,
            l1_recipient,
            l2_recipient,
            l2_sender,
            l1_token_address,
            l2_token_address,
            amount,
            nonce,
            match_status,
            metadata
       FROM eth_starkgate_events
      WHERE event_key = $1
      FOR UPDATE`,
    [eventKey],
  );

  if (result.rowCount === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    amount: toBigIntStrict(row.amount, 'locked l1 event amount'),
    ethBlockNumber: BigInt(row.eth_block_number),
    ethBlockTimestamp: new Date(row.eth_block_timestamp),
    ethLogIndex: BigInt(row.eth_log_index),
    ethTransactionHash: row.eth_transaction_hash,
    eventKey: row.event_key,
    eventType: row.event_type,
    l1Recipient: row.l1_recipient,
    l1Sender: row.l1_sender,
    l1TokenAddress: row.l1_token_address,
    l2Recipient: row.l2_recipient,
    l2Sender: row.l2_sender,
    l2TokenAddress: row.l2_token_address,
    matchStatus: row.match_status,
    metadata: row.metadata ?? {},
    nonce: row.nonce === null ? null : BigInt(row.nonce),
  };
}

async function findBridgeInMatchByNonce(client, event, lane) {
  const result = await client.query(
    `SELECT activity.bridge_key,
            activity.transaction_hash,
            activity.block_number,
            activity.token_address,
            activity.l2_wallet_address,
            journal.block_timestamp
       FROM stark_bridge_activities AS activity
       JOIN stark_block_journal AS journal
         ON journal.lane = activity.lane
        AND journal.block_number = activity.block_number
        AND journal.block_hash = activity.block_hash
        AND journal.is_orphaned = FALSE
      WHERE activity.lane = $1
        AND activity.direction = 'bridge_in'
        AND activity.l1_match_status = 'PENDING'
        AND COALESCE(activity.metadata->>'nonce', activity.metadata->>'bridge_nonce') = $2
        AND ($3::text IS NULL OR activity.token_address = $3)
      ORDER BY activity.block_number ASC, activity.transaction_index ASC
      LIMIT 1
      FOR UPDATE OF activity`,
    [lane, event.nonce?.toString(10) ?? null, event.l2TokenAddress],
  );

  return mapBridgeMatch(result.rows[0]);
}

async function findBridgeInMatchByAmountAndTime(client, event, lane) {
  const result = await client.query(
    `SELECT activity.bridge_key,
            activity.transaction_hash,
            activity.block_number,
            activity.token_address,
            activity.l2_wallet_address,
            journal.block_timestamp
       FROM stark_bridge_activities AS activity
       JOIN stark_block_journal AS journal
         ON journal.lane = activity.lane
        AND journal.block_number = activity.block_number
        AND journal.block_hash = activity.block_hash
        AND journal.is_orphaned = FALSE
      WHERE activity.lane = $1
        AND activity.direction = 'bridge_in'
        AND activity.l1_match_status = 'PENDING'
        AND activity.token_address = $2
        AND activity.amount = $3
        AND activity.l2_wallet_address = $4
        AND to_timestamp(journal.block_timestamp::double precision)
            BETWEEN $5::timestamptz AND ($5::timestamptz + INTERVAL '30 minutes')
      ORDER BY journal.block_timestamp ASC, activity.block_number ASC
      LIMIT 1
      FOR UPDATE OF activity`,
    [
      lane,
      event.l2TokenAddress,
      toNumericString(event.amount, 'deposit match amount'),
      event.l2Recipient,
      event.ethBlockTimestamp,
    ],
  );

  return mapBridgeMatch(result.rows[0]);
}

function mapBridgeMatch(row) {
  if (!row) {
    return null;
  }

  return {
    blockNumber: toBigIntStrict(row.block_number, 'matched bridge block number'),
    blockTimestamp: starkTimestampToDate(row.block_timestamp),
    bridgeKey: row.bridge_key,
    tokenAddress: row.token_address,
    transactionHash: row.transaction_hash,
    walletAddress: row.l2_wallet_address,
  };
}

async function loadLatestEthProcessedBlock(client) {
  const result = await client.query(
    `SELECT last_processed_block_number
       FROM eth_index_state
      WHERE indexer_key = $1`,
    [process.env.ETH_INDEXER_KEY || 'starkgate_l1'],
  );

  if (result.rowCount === 0 || result.rows[0].last_processed_block_number === null) {
    return null;
  }

  return BigInt(result.rows[0].last_processed_block_number);
}

async function updateBridgeFlowSnapshot(client, { amountUsdScaled, bridgeDirection, lane, tokenAddress, walletAddress }) {
  await ensureWalletBridgeFlowRow(client, { lane, tokenAddress, walletAddress });

  await client.query(
    `UPDATE stark_wallet_bridge_flows
        SET pending_l1_match_count = GREATEST(
              0,
              COALESCE(pending_l1_match_count, 0) - 1
            ),
            l1_verified_inflow_usd = CASE
              WHEN $4 = 'bridge_in' THEN COALESCE(l1_verified_inflow_usd, 0) + COALESCE($5::numeric, 0)
              ELSE l1_verified_inflow_usd
            END,
            l1_verified_outflow_usd = CASE
              WHEN $4 = 'bridge_out' THEN COALESCE(l1_verified_outflow_usd, 0) + COALESCE($5::numeric, 0)
              ELSE l1_verified_outflow_usd
            END,
            updated_at = NOW()
      WHERE lane = $1
        AND wallet_address = $2
        AND token_address = $3`,
    [
      lane,
      walletAddress,
      tokenAddress,
      bridgeDirection,
      scaledOrNullToNumeric(amountUsdScaled),
    ],
  );
}

async function updateWalletStatsL1Snapshot(client, { amountUsdScaled, bridgeDirection, ethBlockNumber, l1WalletAddress, lane, settlementSeconds, walletAddress }) {
  await ensureWalletStatsRow(client, { lane, walletAddress });

  await client.query(
    `UPDATE stark_wallet_stats
        SET l1_wallet_address = COALESCE(l1_wallet_address, $3),
            l1_bridge_inflow_usd = CASE
              WHEN $4 = 'bridge_in' THEN COALESCE(l1_bridge_inflow_usd, 0) + COALESCE($5::numeric, 0)
              ELSE l1_bridge_inflow_usd
            END,
            l1_bridge_outflow_usd = CASE
              WHEN $4 = 'bridge_out' THEN COALESCE(l1_bridge_outflow_usd, 0) + COALESCE($5::numeric, 0)
              ELSE l1_bridge_outflow_usd
            END,
            avg_bridge_settlement_s = CASE
              WHEN $6::integer IS NULL THEN avg_bridge_settlement_s
              WHEN avg_bridge_settlement_s IS NULL THEN $6::integer
              ELSE ROUND((avg_bridge_settlement_s + $6::integer) / 2.0)::INTEGER
            END,
            first_l1_activity_block = CASE
              WHEN first_l1_activity_block IS NULL THEN $7
              ELSE LEAST(first_l1_activity_block, $7)
            END,
            last_l1_activity_block = CASE
              WHEN last_l1_activity_block IS NULL THEN $7
              ELSE GREATEST(last_l1_activity_block, $7)
            END,
            updated_at = NOW()
      WHERE lane = $1
        AND wallet_address = $2`,
    [
      lane,
      walletAddress,
      l1WalletAddress,
      bridgeDirection,
      scaledOrNullToNumeric(amountUsdScaled),
      settlementSeconds,
      Number(ethBlockNumber),
    ],
  );
}

async function ensureWalletBridgeFlowRow(client, { lane, tokenAddress, walletAddress }) {
  await client.query(
    `INSERT INTO stark_wallet_bridge_flows (
         lane,
         wallet_address,
         token_address,
         bridge_in_amount,
         bridge_out_amount,
         net_bridge_flow,
         bridge_inflow_usd,
         bridge_outflow_usd,
         net_bridge_flow_usd,
         bridge_in_count,
         bridge_out_count,
         unresolved_activity_count,
         pending_l1_match_count,
         metadata,
         created_at,
         updated_at
     ) VALUES (
         $1, $2, $3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, '{}'::jsonb, NOW(), NOW()
     )
     ON CONFLICT (lane, wallet_address, token_address) DO NOTHING`,
    [lane, walletAddress, tokenAddress],
  );
}

async function ensureWalletStatsRow(client, { lane, walletAddress }) {
  await client.query(
    `INSERT INTO stark_wallet_stats (
         lane,
         wallet_address,
         total_trades,
         total_volume_usd,
         total_gas_fees_usd,
         realized_pnl_usd,
         unrealized_pnl_usd,
         net_pnl_usd,
         bridge_inflow_usd,
         bridge_outflow_usd,
         net_bridge_flow_usd,
         l1_bridge_inflow_usd,
         l1_bridge_outflow_usd,
         bridge_activity_count,
         winning_trade_count,
         losing_trade_count,
         metadata,
         created_at,
         updated_at
     ) VALUES (
         $1, $2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, '{}'::jsonb, NOW(), NOW()
     )
     ON CONFLICT (lane, wallet_address) DO NOTHING`,
    [lane, walletAddress],
  );
}

async function linkTradesToDeposit(client, { depositBlockNumber, depositTimestamp, ethTransactionHash, l1WalletAddress, traderAddress }) {
  const rapidWindowSeconds = parsePositiveInteger(process.env.L1_WHALE_RAPID_TRADE_SECONDS, 600);
  const result = await client.query(
    `WITH updated AS (
         UPDATE stark_trades
            SET l1_deposit_tx_hash = $1,
                l1_deposit_block = $2,
                l1_deposit_timestamp = $3,
                l1_wallet_address = $4,
                seconds_since_deposit = EXTRACT(EPOCH FROM (block_timestamp - $3))::INTEGER,
                is_post_bridge_trade = EXTRACT(EPOCH FROM (block_timestamp - $3))::INTEGER < $5
          WHERE trader_address = $6
            AND block_timestamp >= $3
            AND block_timestamp <= $3 + INTERVAL '24 hours'
            AND l1_deposit_tx_hash IS NULL
          RETURNING seconds_since_deposit
     )
     SELECT COUNT(*) FILTER (WHERE seconds_since_deposit IS NOT NULL AND seconds_since_deposit < $5) AS rapid_trade_count
       FROM updated`,
    [
      ethTransactionHash,
      Number(depositBlockNumber),
      depositTimestamp,
      l1WalletAddress,
      rapidWindowSeconds,
      traderAddress,
    ],
  );

  return Number(result.rows[0]?.rapid_trade_count ?? 0);
}

async function maybeInsertBridgeWhaleAlert(client, {
  amount,
  amountUsdScaled,
  bridgeKey,
  lane,
  rapidTradeCount,
  settlementSeconds,
  tokenAddress,
  walletAddress,
  event,
}) {
  const thresholdUsdScaled = decimalStringToScaled(process.env.L1_WHALE_USD_THRESHOLD ?? '50000', DEFAULT_SCALE);
  if (amountUsdScaled === null || amountUsdScaled < thresholdUsdScaled || rapidTradeCount <= 0) {
    return 0;
  }

  await client.query(
    `INSERT INTO stark_whale_alert_candidates (
         alert_key,
         lane,
         block_number,
         wallet_address,
         token_address,
         alert_type,
         severity,
         velocity_score,
         metric_amount,
         metric_usd,
         related_trade_key,
         related_bridge_key,
         metadata,
         eth_tx_hash,
         eth_block_number,
         l1_trigger_type,
         l1_trigger_amount,
         l1_trigger_usd,
         l1_to_l2_seconds,
         created_at,
         updated_at
     ) VALUES (
         $1, $2, $3, $4, $5, 'rapid_bridge_trade', 'warning', NULL, $6, $7,
         NULL, $8, $9::jsonb, $10, $11, 'large_deposit', $12, $13, $14, NOW(), NOW()
     )
     ON CONFLICT (alert_key) DO NOTHING`,
    [
      `l1:${event.ethTransactionHash}:${bridgeKey}`,
      lane,
      Number(event.ethBlockNumber),
      walletAddress,
      tokenAddress,
      toNumericString(amount, 'whale alert L1 amount'),
      scaledToNumericString(amountUsdScaled, DEFAULT_SCALE),
      bridgeKey,
      toJsonbString({
        rapid_trade_count: rapidTradeCount,
        settlement_seconds: settlementSeconds,
      }),
      event.ethTransactionHash,
      Number(event.ethBlockNumber),
      toNumericString(amount, 'whale trigger amount'),
      scaledToNumericString(amountUsdScaled, DEFAULT_SCALE),
      settlementSeconds,
    ],
  );

  return 1;
}

async function matchSingleWithdrawal(client, event, { lane }) {
  const lockedEvent = await lockPendingEvent(client, event.eventKey);
  if (!lockedEvent || lockedEvent.matchStatus !== 'PENDING') {
    return false;
  }

  const result = await client.query(
    `SELECT message.lane,
            message.block_number,
            message.transaction_hash,
            message.message_index,
            journal.block_timestamp
       FROM stark_message_l2_to_l1 AS message
       JOIN stark_block_journal AS journal
         ON journal.lane = message.lane
        AND journal.block_number = message.block_number
        AND journal.block_hash = message.block_hash
        AND journal.is_orphaned = FALSE
      WHERE message.lane = $1
        AND message.message_status = 'SENT'
        AND message.from_address = $2
        AND to_timestamp(journal.block_timestamp::double precision) < $3::timestamptz
      ORDER BY journal.block_timestamp DESC, message.message_index DESC
      LIMIT 1
      FOR UPDATE OF message`,
    [lane, lockedEvent.l2Sender, lockedEvent.ethBlockTimestamp],
  );

  if (result.rowCount === 0) {
    return false;
  }

  const message = result.rows[0];
  const settlementSeconds = Math.max(0, Math.floor((lockedEvent.ethBlockTimestamp.getTime() - starkTimestampToDate(message.block_timestamp).getTime()) / 1000));

  await client.query(
    `UPDATE stark_message_l2_to_l1
        SET l1_consumed_tx_hash = $1,
            l1_consumed_block = $2,
            l1_consumed_timestamp = $3,
            message_status = 'CONSUMED',
            settlement_seconds = $4,
            updated_at = NOW()
      WHERE lane = $5
        AND block_number = $6
        AND transaction_hash = $7
        AND message_index = $8
        AND message_status = 'SENT'`,
    [
      lockedEvent.ethTransactionHash,
      Number(lockedEvent.ethBlockNumber),
      lockedEvent.ethBlockTimestamp,
      settlementSeconds,
      message.lane,
      message.block_number,
      message.transaction_hash,
      message.message_index,
    ],
  );

  await client.query(
    `UPDATE eth_starkgate_events
        SET matched_at = NOW(),
            match_status = 'MATCHED',
            match_strategy = 'message_time',
            settlement_seconds = $2,
            metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
              'matched_message_tx_hash', $3::text,
              'matched_message_index', $4
            ),
            updated_at = NOW()
      WHERE event_key = $1
        AND match_status = 'PENDING'`,
    [
      lockedEvent.eventKey,
      settlementSeconds,
      message.transaction_hash,
      message.message_index,
    ],
  );

  return true;
}

async function markStaleUnmatched(client, { lane }) {
  const staleEvents = await client.query(
    `UPDATE eth_starkgate_events
        SET match_status = 'UNMATCHED',
            updated_at = NOW()
      WHERE match_status = 'PENDING'
        AND created_at < NOW() - INTERVAL '24 hours'`,
  );

  const staleBridges = await client.query(
    `UPDATE stark_bridge_activities
        SET l1_match_status = 'UNMATCHED',
            updated_at = NOW()
      WHERE lane = $1
        AND l1_match_status = 'PENDING'
        AND direction = 'bridge_in'
        AND created_at < NOW() - INTERVAL '24 hours'`,
    [lane],
  );

  return staleEvents.rowCount + staleBridges.rowCount;
}

function installSignalHandlers() {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      shuttingDown = true;
      console.log(`[phase5] l1-cross-chain-matcher received ${signal}, stopping after current pass.`);
    });
  }
}

function starkTimestampToDate(value) {
  if (value instanceof Date) {
    return value;
  }

  const numericValue = value === null || value === undefined
    ? 0n
    : toBigIntStrict(value, 'stark timestamp');
  return new Date(Number(numericValue) * 1000);
}

module.exports = {
  main,
  runMatcherPass,
};

if (require.main === module) {
  main().catch(async (error) => {
    console.error(`[phase5] l1-cross-chain-matcher fatal error: ${formatError(error)}`);
    try {
      await closePool();
    } finally {
      process.exitCode = 1;
    }
  });
}
