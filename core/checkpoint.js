'use strict';

const { toNumericString } = require('../lib/cairo/bigint');
const { FINALITY_LANES, assertValidFinalityLane } = require('./finality');

const FOUNDATION_TABLES = Object.freeze([
  'stark_index_state',
  'stark_block_journal',
  'stark_reconciliation_log',
]);
const PHASE2_TABLES = Object.freeze([
  'stark_contract_registry',
  'stark_tx_raw',
  'stark_event_raw',
  'stark_message_l2_to_l1',
  'stark_unknown_event_audit',
  'stark_action_norm',
  'stark_transfers',
  'stark_bridge_activities',
]);
const PHASE3_TABLES = Object.freeze([
  'stark_trades',
  'stark_pool_state_history',
  'stark_pool_latest',
  'stark_prices',
  'stark_price_ticks',
  'stark_ohlcv_1m',
]);
const PHASE4_TABLES = Object.freeze([
  'stark_block_state_updates',
  'stark_token_metadata',
  'stark_contract_security',
]);
const PHASE6_TABLES = Object.freeze([
  'stark_wallet_bridge_flows',
  'stark_wallet_pnl_events',
  'stark_wallet_positions',
  'stark_wallet_stats',
  'stark_holder_balance_deltas',
  'stark_holder_balances',
  'stark_token_concentration',
  'stark_leaderboards',
  'stark_whale_alert_candidates',
]);

async function assertFoundationTables(client) {
  await assertTablesExist(client, FOUNDATION_TABLES, 'Foundation', 'sql/001_foundation.sql');
}

async function assertPhase2Tables(client) {
  await assertTablesExist(client, PHASE2_TABLES, 'Phase 2', 'sql/002_registry_and_raw.sql');
}

async function assertPhase3Tables(client) {
  await assertTablesExist(client, PHASE3_TABLES, 'Phase 3', 'sql/003_trading.sql');
}

async function assertPhase4Tables(client) {
  await assertTablesExist(client, PHASE4_TABLES, 'Phase 4', 'sql/004_metadata_and_security.sql');
}

async function assertPhase6Tables(client) {
  await assertTablesExist(client, PHASE6_TABLES, 'Phase 6', 'sql/006_analytics.sql');
}

async function assertTablesExist(client, tableNames, label, migrationFile) {
  const result = await client.query(
    `SELECT table_name, to_regclass('public.' || table_name) AS regclass
       FROM unnest($1::text[]) AS table_name`,
    [tableNames],
  );

  const missing = result.rows
    .filter((row) => row.regclass === null)
    .map((row) => row.table_name);

  if (missing.length > 0) {
    throw new Error(`${label} tables are missing. Run ${migrationFile} first. Missing: ${missing.join(', ')}`);
  }
}

async function ensureIndexStateRows(client, indexerKey) {
  for (const lane of Object.values(FINALITY_LANES)) {
    await client.query(
      `INSERT INTO stark_index_state (indexer_key, lane)
       VALUES ($1, $2)
       ON CONFLICT (indexer_key, lane) DO NOTHING`,
      [indexerKey, lane],
    );
  }
}

async function getCheckpoint(client, { indexerKey, lane, forUpdate = false }) {
  const validLane = assertValidFinalityLane(lane);
  const lockClause = forUpdate ? ' FOR UPDATE' : '';

  const result = await client.query(
    `SELECT indexer_key, lane, last_processed_block_number, last_processed_block_hash,
            last_processed_parent_hash, last_processed_old_root, last_processed_new_root,
            last_finality_status, last_committed_at, created_at, updated_at
       FROM stark_index_state
      WHERE indexer_key = $1
        AND lane = $2${lockClause}`,
    [indexerKey, validLane],
  );

  if (result.rowCount === 0) {
    return null;
  }

  return mapCheckpointRow(result.rows[0]);
}

async function advanceCheckpoint(client, payload) {
  const validLane = assertValidFinalityLane(payload.lane);

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
      payload.indexerKey,
      validLane,
      toNumericString(payload.blockNumber, 'block number'),
      payload.blockHash,
      payload.parentHash,
      payload.oldRoot ?? null,
      payload.newRoot ?? null,
      payload.finalityStatus ?? validLane,
    ],
  );
}

function mapCheckpointRow(row) {
  return {
    indexerKey: row.indexer_key,
    lane: row.lane,
    lastProcessedBlockNumber: row.last_processed_block_number === null ? null : BigInt(row.last_processed_block_number),
    lastProcessedBlockHash: row.last_processed_block_hash,
    lastProcessedParentHash: row.last_processed_parent_hash,
    lastProcessedOldRoot: row.last_processed_old_root,
    lastProcessedNewRoot: row.last_processed_new_root,
    lastFinalityStatus: row.last_finality_status,
    lastCommittedAt: row.last_committed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

module.exports = {
  assertFoundationTables,
  assertPhase2Tables,
  assertPhase3Tables,
  assertPhase4Tables,
  assertPhase6Tables,
  advanceCheckpoint,
  ensureIndexStateRows,
  getCheckpoint,
};
