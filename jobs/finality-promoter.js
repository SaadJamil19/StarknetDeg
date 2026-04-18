#!/usr/bin/env node
'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { setTimeout: sleep } = require('node:timers/promises');
const { processAcceptedBlock } = require('../core/block-processor');
const {
  assertFoundationTables,
  assertPhase2Tables,
  assertPhase3Tables,
  assertPhase4Tables,
  assertPhase6Tables,
  assertPoolTaxonomyTables,
  ensureIndexStateRows,
  getCheckpoint,
} = require('../core/checkpoint');
const { FINALITY_LANES, normalizeFinalityStatus } = require('../core/finality');
const { markTokenRegistryForReverification } = require('../core/token-registry');
const { closePool, withClient, withTransaction } = require('../lib/db');
const { StarknetRpcClient } = require('../lib/starknet-rpc');
const { toNumericString } = require('../lib/cairo/bigint');
const { formatError, parseBoolean, parsePositiveInteger } = require('./analytics-utils');
const { refreshBridgeAccounting } = require('./bridge-accounting');
const { refreshWalletRollups } = require('./wallet-rollups');
const { refreshConcentrationRollups } = require('./concentration-rollups');

let shuttingDown = false;

async function main() {
  const rpcClient = new StarknetRpcClient();
  const runOnce = parseBoolean(process.env.PHASE6_FINALITY_PROMOTER_RUN_ONCE, true);
  const pollIntervalMs = parsePositiveInteger(process.env.PHASE6_FINALITY_PROMOTER_INTERVAL_MS, 60_000);
  const indexerKey = process.env.INDEXER_KEY || 'starknetdeg-mainnet';

  installSignalHandlers();

  await withTransaction(async (client) => {
    await assertFoundationTables(client);
    await assertPhase2Tables(client);
    await assertPhase3Tables(client);
    await assertPhase4Tables(client);
    await assertPhase6Tables(client);
    await assertPoolTaxonomyTables(client);
    await ensureIndexStateRows(client, indexerKey);
  });

  console.log(`[phase6] finality-promoter starting run_once=${runOnce}`);

  do {
    try {
      const summary = await promoteAndReconcile({ indexerKey, rpcClient });
      console.log(
        `[phase6] finality-promoter mode=${summary.mode} promoted=${summary.promoted} replayed=${summary.replayedBlocks} anchor=${summary.anchorBlockNumber} l2_tip=${summary.l2TipBlockNumber}`,
      );
    } catch (error) {
      console.error(`[phase6] finality-promoter error: ${formatError(error)}`);
    }

    if (runOnce || shuttingDown) {
      break;
    }

    await sleep(pollIntervalMs);
  } while (!shuttingDown);

  await closePool();
}

async function promoteAndReconcile({ indexerKey, rpcClient }) {
  const checkpoints = await withClient(async (client) => ({
    l1: await getCheckpoint(client, { indexerKey, lane: FINALITY_LANES.ACCEPTED_ON_L1 }),
    l2: await getCheckpoint(client, { indexerKey, lane: FINALITY_LANES.ACCEPTED_ON_L2 }),
  }));

  const l2TipBlockNumber = checkpoints.l2?.lastProcessedBlockNumber ?? null;
  const anchorBlockNumber = checkpoints.l1?.lastProcessedBlockNumber ?? null;
  if (l2TipBlockNumber === null) {
    return {
      anchorBlockNumber: anchorBlockNumber === null ? 'none' : anchorBlockNumber.toString(10),
      l2TipBlockNumber: 'none',
      mode: 'idle',
      promoted: 0,
      replayedBlocks: 0,
    };
  }

  const replayFromBlock = anchorBlockNumber === null ? 0n : anchorBlockNumber + 1n;
  const remoteTipBlockNumber = await rpcClient.getBlockNumber();
  const localRows = await withClient((client) => loadActiveJournalWindow(client, {
    fromBlockNumber: replayFromBlock,
    lane: FINALITY_LANES.ACCEPTED_ON_L2,
    toBlockNumber: l2TipBlockNumber,
  }));

  let promoted = 0;

  for (const row of localRows) {
    if (row.blockNumber > remoteTipBlockNumber) {
      break;
    }

    const [remoteBlock, remoteStateUpdate] = await Promise.all([
      rpcClient.getBlockWithReceipts(row.blockNumber),
      rpcClient.getStateUpdate(row.blockNumber),
    ]);
    const mismatch = detectDivergence({ localRow: row, remoteBlock, remoteStateUpdate });

    if (mismatch) {
      const replayedBlocks = await reconcileFromAnchor({
        anchorCheckpoint: checkpoints.l1,
        divergentLocalRow: row,
        indexerKey,
        l2TipBlockNumber,
        remoteBlock,
        remoteStateUpdate,
        rpcClient,
      });
      return {
        anchorBlockNumber: anchorBlockNumber === null ? 'none' : anchorBlockNumber.toString(10),
        l2TipBlockNumber: l2TipBlockNumber.toString(10),
        mode: 'reconciled',
        promoted,
        replayedBlocks,
      };
    }

    if (normalizeFinalityStatus(remoteBlock.status) !== FINALITY_LANES.ACCEPTED_ON_L1) {
      break;
    }

    await withTransaction((client) => promoteBlockToL1(client, {
      blockHash: row.blockHash,
      blockNumber: row.blockNumber,
      finalityStatus: FINALITY_LANES.ACCEPTED_ON_L1,
      indexerKey,
      newRoot: remoteStateUpdate.new_root ?? row.newRoot,
      oldRoot: remoteStateUpdate.old_root ?? row.oldRoot,
      parentHash: row.parentHash,
    }));
    promoted += 1;
  }

  return {
    anchorBlockNumber: anchorBlockNumber === null ? 'none' : anchorBlockNumber.toString(10),
    l2TipBlockNumber: l2TipBlockNumber.toString(10),
    mode: 'promoted',
    promoted,
    replayedBlocks: 0,
  };
}

async function loadActiveJournalWindow(client, { fromBlockNumber, lane, toBlockNumber }) {
  const result = await client.query(
    `SELECT block_number,
            block_hash,
            parent_hash,
            old_root,
            new_root
       FROM stark_block_journal
      WHERE lane = $1
        AND block_number >= $2
        AND block_number <= $3
        AND is_orphaned = FALSE
      ORDER BY block_number ASC`,
    [lane, toNumericString(fromBlockNumber, 'replay from block'), toNumericString(toBlockNumber, 'replay to block')],
  );

  return result.rows.map((row) => ({
    blockHash: row.block_hash,
    blockNumber: BigInt(row.block_number),
    newRoot: row.new_root,
    oldRoot: row.old_root,
    parentHash: row.parent_hash,
  }));
}

function detectDivergence({ localRow, remoteBlock, remoteStateUpdate }) {
  const localHash = String(localRow.blockHash).toLowerCase();
  const remoteHash = String(remoteBlock.block_hash).toLowerCase();
  if (localHash !== remoteHash) {
    return { reason: 'BLOCK_HASH_MISMATCH' };
  }

  const localParent = String(localRow.parentHash).toLowerCase();
  const remoteParent = String(remoteBlock.parent_hash).toLowerCase();
  if (localParent !== remoteParent) {
    return { reason: 'PARENT_HASH_MISMATCH' };
  }

  const localOldRoot = localRow.oldRoot ? String(localRow.oldRoot).toLowerCase() : null;
  const remoteOldRoot = remoteStateUpdate.old_root ? String(remoteStateUpdate.old_root).toLowerCase() : null;
  if (localOldRoot && remoteOldRoot && localOldRoot !== remoteOldRoot) {
    return { reason: 'OLD_ROOT_MISMATCH' };
  }

  const localNewRoot = localRow.newRoot ? String(localRow.newRoot).toLowerCase() : null;
  const remoteNewRoot = remoteStateUpdate.new_root ? String(remoteStateUpdate.new_root).toLowerCase() : null;
  if (localNewRoot && remoteNewRoot && localNewRoot !== remoteNewRoot) {
    return { reason: 'NEW_ROOT_MISMATCH' };
  }

  return null;
}

async function reconcileFromAnchor({
  anchorCheckpoint,
  divergentLocalRow,
  indexerKey,
  l2TipBlockNumber,
  remoteBlock,
  remoteStateUpdate,
  rpcClient,
}) {
  const replayFromBlock = anchorCheckpoint?.lastProcessedBlockNumber === null || anchorCheckpoint?.lastProcessedBlockNumber === undefined
    ? 0n
    : anchorCheckpoint.lastProcessedBlockNumber + 1n;
  const reconciliationId = await withTransaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO stark_reconciliation_log (
           lane,
           from_block_number,
           to_block_number,
           anchor_block_number,
           expected_parent_hash,
           observed_parent_hash,
           expected_old_root,
           observed_old_root,
           expected_new_root,
           observed_new_root,
           status,
           reason,
           metadata,
           detected_at,
           created_at,
           updated_at
       ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           'REPLAYING', $11, $12::jsonb, NOW(), NOW(), NOW()
       )
       RETURNING reconciliation_id`,
      [
        FINALITY_LANES.ACCEPTED_ON_L2,
        toNumericString(replayFromBlock, 'reconciliation from block'),
        toNumericString(l2TipBlockNumber, 'reconciliation to block'),
        anchorCheckpoint?.lastProcessedBlockNumber === null || anchorCheckpoint?.lastProcessedBlockNumber === undefined
          ? null
          : toNumericString(anchorCheckpoint.lastProcessedBlockNumber, 'reconciliation anchor block'),
        divergentLocalRow.parentHash,
        remoteBlock.parent_hash,
        divergentLocalRow.oldRoot ?? null,
        remoteStateUpdate.old_root ?? null,
        divergentLocalRow.newRoot ?? null,
        remoteStateUpdate.new_root ?? null,
        'L2_L1_DIVERGENCE',
        JSON.stringify({
          local_block_hash: divergentLocalRow.blockHash,
          remote_block_hash: remoteBlock.block_hash,
        }),
      ],
    );

    await markReconciliationWindowOrphaned(client, {
      fromBlockNumber: replayFromBlock,
      lane: FINALITY_LANES.ACCEPTED_ON_L2,
      toBlockNumber: l2TipBlockNumber,
    });
    await deleteReconciliationWindow(client, {
      fromBlockNumber: replayFromBlock,
      lane: FINALITY_LANES.ACCEPTED_ON_L2,
    });
    await restoreLatestMaterializedState(client, { lane: FINALITY_LANES.ACCEPTED_ON_L2 });
    await resetCheckpointToAnchor(client, {
      anchorCheckpoint,
      indexerKey,
      lane: FINALITY_LANES.ACCEPTED_ON_L2,
    });

    return inserted.rows[0].reconciliation_id;
  });

  let replayedBlocks = 0;

  try {
    const remoteTipBlockNumber = await rpcClient.getBlockNumber();
    for (let blockNumber = replayFromBlock; blockNumber <= remoteTipBlockNumber; blockNumber += 1n) {
      if (shuttingDown) {
        break;
      }

      await processAcceptedBlock({
        blockNumber,
        indexerKey,
        lane: FINALITY_LANES.ACCEPTED_ON_L2,
        rpcClient,
      });
      replayedBlocks += 1;
    }

    await refreshBridgeAccounting({
      indexerKey,
      lane: FINALITY_LANES.ACCEPTED_ON_L2,
      requireL1: false,
    });
    await refreshWalletRollups({
      indexerKey,
      lane: FINALITY_LANES.ACCEPTED_ON_L2,
      requireL1: false,
    });
    await refreshConcentrationRollups({
      indexerKey,
      lane: FINALITY_LANES.ACCEPTED_ON_L2,
      requireL1: false,
    });

    await markReconciliationResolved(reconciliationId, {
      replayedBlocks,
      status: 'RESOLVED',
    });
    return replayedBlocks;
  } catch (error) {
    await markReconciliationResolved(reconciliationId, {
      errorMessage: error.message,
      replayedBlocks,
      status: 'FAILED',
    });
    throw error;
  }
}

async function markReconciliationWindowOrphaned(client, { fromBlockNumber, lane, toBlockNumber }) {
  await client.query(
    `UPDATE stark_block_journal
        SET is_orphaned = TRUE,
            orphaned_at = NOW(),
            updated_at = NOW()
      WHERE lane = $1
        AND block_number >= $2
        AND block_number <= $3
        AND is_orphaned = FALSE`,
    [lane, toNumericString(fromBlockNumber, 'orphan from block'), toNumericString(toBlockNumber, 'orphan to block')],
  );
}

async function deleteReconciliationWindow(client, { fromBlockNumber, lane }) {
  const params = [lane, toNumericString(fromBlockNumber, 'delete reconciliation block')];
  const statements = [
    'DELETE FROM stark_block_state_updates WHERE lane = $1 AND block_number >= $2',
    'DELETE FROM stark_ohlcv_1m WHERE lane = $1 AND block_number >= $2',
    'DELETE FROM stark_trades WHERE lane = $1 AND block_number >= $2',
    'DELETE FROM stark_pool_state_history WHERE lane = $1 AND block_number >= $2',
    'DELETE FROM stark_price_ticks WHERE lane = $1 AND block_number >= $2',
    'DELETE FROM stark_action_norm WHERE lane = $1 AND block_number >= $2',
    'DELETE FROM stark_transfers WHERE lane = $1 AND block_number >= $2',
    'DELETE FROM stark_bridge_activities WHERE lane = $1 AND block_number >= $2',
    'DELETE FROM stark_unknown_event_audit WHERE lane = $1 AND block_number >= $2',
    'DELETE FROM stark_event_raw WHERE lane = $1 AND block_number >= $2',
    'DELETE FROM stark_message_l2_to_l1 WHERE lane = $1 AND block_number >= $2',
    'DELETE FROM stark_tx_raw WHERE lane = $1 AND block_number >= $2',
    'DELETE FROM stark_wallet_pnl_events WHERE lane = $1 AND block_number >= $2',
    'DELETE FROM stark_holder_balance_deltas WHERE lane = $1 AND block_number >= $2',
  ];

  for (const statement of statements) {
    await client.query(statement, params);
  }

  await client.query(`DELETE FROM stark_pool_latest WHERE lane = $1`, [lane]);
  await client.query(`DELETE FROM stark_prices WHERE lane = $1`, [lane]);
  await client.query(`DELETE FROM stark_wallet_bridge_flows WHERE lane = $1`, [lane]);
  await client.query(`DELETE FROM stark_wallet_positions WHERE lane = $1`, [lane]);
  await client.query(`DELETE FROM stark_wallet_stats WHERE lane = $1`, [lane]);
  await client.query(`DELETE FROM stark_holder_balances WHERE lane = $1`, [lane]);
  await client.query(`DELETE FROM stark_token_concentration WHERE lane = $1`, [lane]);
  await client.query(`DELETE FROM stark_leaderboards WHERE lane = $1`, [lane]);
  await client.query(`DELETE FROM stark_whale_alert_candidates WHERE lane = $1`, [lane]);
  await markTokenRegistryForReverification(client, { fromBlockNumber });
}

async function restoreLatestMaterializedState(client, { lane }) {
  await client.query(
    `INSERT INTO stark_pool_latest (
         lane,
         pool_id,
         protocol,
         pool_family,
         pool_model,
         token0_address,
         token1_address,
         block_number,
         block_hash,
         block_timestamp,
         transaction_hash,
         transaction_index,
         source_event_index,
         reserve0,
         reserve1,
         liquidity,
         sqrt_ratio,
         price_token1_per_token0,
         price_token0_per_token1,
         price_is_decimals_normalized,
         tvl_usd,
         snapshot_kind,
         metadata,
         created_at,
         updated_at
     )
     SELECT DISTINCT ON (pool_id)
            lane,
            pool_id,
            protocol,
            pool_family,
            pool_model,
            token0_address,
            token1_address,
            block_number,
            block_hash,
            block_timestamp,
            transaction_hash,
            transaction_index,
            source_event_index,
            reserve0,
            reserve1,
            liquidity,
            sqrt_ratio,
            price_token1_per_token0,
            price_token0_per_token1,
            price_is_decimals_normalized,
            tvl_usd,
            snapshot_kind,
            metadata,
            created_at,
            updated_at
       FROM stark_pool_state_history
      WHERE lane = $1
      ORDER BY pool_id ASC, block_number DESC, transaction_index DESC, source_event_index DESC`,
    [lane],
  );

  await client.query(
    `INSERT INTO stark_prices (
         lane,
         token_address,
         block_number,
         block_hash,
         block_timestamp,
         transaction_hash,
         transaction_index,
         source_event_index,
         source_pool_id,
         quote_token_address,
         price_quote,
         price_usd,
         price_source,
         price_is_stale,
         price_updated_at_block,
         metadata,
         created_at,
         updated_at
     )
     SELECT DISTINCT ON (token_address)
            lane,
            token_address,
            block_number,
            block_hash,
            block_timestamp,
            transaction_hash,
            transaction_index,
            source_event_index,
            source_pool_id,
            quote_token_address,
            price_quote,
            price_usd,
            price_source,
            price_is_stale,
            price_updated_at_block,
            metadata,
            created_at,
            updated_at
       FROM stark_price_ticks
      WHERE lane = $1
      ORDER BY token_address ASC, block_number DESC, transaction_index DESC, source_event_index DESC`,
    [lane],
  );
}

async function resetCheckpointToAnchor(client, { anchorCheckpoint, indexerKey, lane }) {
  if (!anchorCheckpoint || anchorCheckpoint.lastProcessedBlockNumber === null) {
    await client.query(
      `UPDATE stark_index_state
          SET last_processed_block_number = NULL,
              last_processed_block_hash = NULL,
              last_processed_parent_hash = NULL,
              last_processed_old_root = NULL,
              last_processed_new_root = NULL,
              last_finality_status = NULL,
              last_committed_at = NULL,
              updated_at = NOW()
        WHERE indexer_key = $1
          AND lane = $2`,
      [indexerKey, lane],
    );
    return;
  }

  await client.query(
    `UPDATE stark_index_state
        SET last_processed_block_number = $3,
            last_processed_block_hash = $4,
            last_processed_parent_hash = $5,
            last_processed_old_root = $6,
            last_processed_new_root = $7,
            last_finality_status = $8,
            last_committed_at = NOW(),
            updated_at = NOW()
      WHERE indexer_key = $1
        AND lane = $2`,
    [
      indexerKey,
      lane,
      toNumericString(anchorCheckpoint.lastProcessedBlockNumber, 'reset checkpoint block number'),
      anchorCheckpoint.lastProcessedBlockHash,
      anchorCheckpoint.lastProcessedParentHash,
      anchorCheckpoint.lastProcessedOldRoot ?? null,
      anchorCheckpoint.lastProcessedNewRoot ?? null,
      anchorCheckpoint.lastFinalityStatus ?? FINALITY_LANES.ACCEPTED_ON_L1,
    ],
  );
}

async function promoteBlockToL1(client, {
  blockHash,
  blockNumber,
  finalityStatus,
  indexerKey,
  newRoot,
  oldRoot,
  parentHash,
}) {
  await client.query(
    `UPDATE stark_block_journal
        SET finality_status = $3,
            updated_at = NOW()
      WHERE lane = $1
        AND block_number = $2
        AND block_hash = $4`,
    [FINALITY_LANES.ACCEPTED_ON_L2, toNumericString(blockNumber, 'promote block number'), finalityStatus, blockHash],
  );
  await client.query(
    `UPDATE stark_tx_raw
        SET finality_status = $3,
            updated_at = NOW()
      WHERE lane = $1
        AND block_number = $2`,
    [FINALITY_LANES.ACCEPTED_ON_L2, toNumericString(blockNumber, 'promote tx block number'), finalityStatus],
  );
  await client.query(
    `UPDATE stark_event_raw
        SET finality_status = $3,
            updated_at = NOW()
      WHERE lane = $1
        AND block_number = $2`,
    [FINALITY_LANES.ACCEPTED_ON_L2, toNumericString(blockNumber, 'promote event block number'), finalityStatus],
  );
  await client.query(
    `UPDATE stark_index_state
        SET last_processed_block_number = $3,
            last_processed_block_hash = $4,
            last_processed_parent_hash = $5,
            last_processed_old_root = $6,
            last_processed_new_root = $7,
            last_finality_status = $8,
            last_committed_at = NOW(),
            updated_at = NOW()
      WHERE indexer_key = $1
        AND lane = $2`,
    [
      indexerKey,
      FINALITY_LANES.ACCEPTED_ON_L1,
      toNumericString(blockNumber, 'l1 promotion checkpoint block'),
      blockHash,
      parentHash,
      oldRoot ?? null,
      newRoot ?? null,
      finalityStatus,
    ],
  );
}

async function markReconciliationResolved(reconciliationId, { errorMessage = null, replayedBlocks, status }) {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE stark_reconciliation_log
          SET status = $2,
              metadata = metadata || $3::jsonb,
              resolved_at = NOW(),
              updated_at = NOW()
        WHERE reconciliation_id = $1`,
      [
        reconciliationId,
        status,
        JSON.stringify({
          error_message: errorMessage,
          replayed_blocks: replayedBlocks,
        }),
      ],
    );
  });
}

function installSignalHandlers() {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      shuttingDown = true;
      console.log(`[phase6] finality-promoter received ${signal}, stopping after current pass.`);
    });
  }
}

if (require.main === module) {
  main().catch(async (error) => {
    console.error(`[phase6] finality-promoter fatal error: ${formatError(error)}`);
    try {
      await closePool();
    } finally {
      process.exitCode = 1;
    }
  });
}

module.exports = {
  promoteAndReconcile,
};
