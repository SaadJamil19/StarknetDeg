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
const SCHEMA_ENHANCEMENT_TABLES = Object.freeze([
  'tokens',
]);
const SCHEMA_ENHANCEMENT_VIEWS = Object.freeze([
  'view_unidentified_protocols',
]);
const TRADE_CHAINING_TABLES = Object.freeze([
  'stark_trade_enrichment_queue',
]);
const METADATA_SYNC_TABLES = Object.freeze([
  'stark_token_metadata_refresh_queue',
]);
const POOL_TAXONOMY_TABLES = Object.freeze([
  'stark_pool_registry',
]);
const L1_TABLES = Object.freeze([
  'eth_block_journal',
  'eth_tx_raw',
  'eth_event_raw',
  'eth_starkgate_events',
  'eth_index_state',
]);
const L1_COLUMNS = Object.freeze([
  { table: 'stark_bridge_activities', column: 'eth_tx_hash' },
  { table: 'stark_bridge_activities', column: 'l1_match_status' },
  { table: 'stark_wallet_bridge_flows', column: 'pending_l1_match_count' },
  { table: 'stark_wallet_bridge_flows', column: 'l1_verified_inflow_usd' },
  { table: 'stark_wallet_stats', column: 'l1_wallet_address' },
  { table: 'stark_message_l2_to_l1', column: 'message_status' },
  { table: 'stark_trades', column: 'l1_deposit_tx_hash' },
  { table: 'stark_trades', column: 'is_post_bridge_trade' },
  { table: 'stark_whale_alert_candidates', column: 'eth_tx_hash' },
]);
const SCHEMA_ENHANCEMENT_COLUMNS = Object.freeze([
  { table: 'stark_trades', column: 'route_group_key' },
  { table: 'stark_trades', column: 'locker_address' },
  { table: 'stark_prices', column: 'bucket_1m' },
  { table: 'stark_price_ticks', column: 'hops_from_stable' },
  { table: 'stark_price_ticks', column: 'low_confidence' },
  { table: 'stark_pool_latest', column: 'tick_after' },
  { table: 'stark_ohlcv_1m', column: 'vwap' },
  { table: 'stark_transfers', column: 'amount_human' },
]);
const TRADE_CHAINING_COLUMNS = Object.freeze([
  { table: 'stark_trades', column: 'sequence_id' },
  { table: 'stark_trades', column: 'amount_in_human' },
  { table: 'stark_trades', column: 'amount_out_human' },
]);
const POOL_TAXONOMY_COLUMNS = Object.freeze([
  { table: 'stark_pool_state_history', column: 'pool_family' },
  { table: 'stark_pool_state_history', column: 'pool_model' },
  { table: 'stark_pool_latest', column: 'pool_family' },
  { table: 'stark_pool_latest', column: 'pool_model' },
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

async function assertL1Tables(client) {
  await assertTablesExist(client, L1_TABLES, 'L1 integration', 'sql/0010_l1_new_tables.sql');
  await assertColumnsExist(client, L1_COLUMNS, 'L1 integration', 'sql/0011_l1_alter_tables.sql');
}

async function assertSchemaEnhancementTables(client) {
  await assertTablesExist(client, SCHEMA_ENHANCEMENT_TABLES, 'Schema enhancement', 'sql/007_schema_enhancements.sql');
  await assertColumnsExist(client, SCHEMA_ENHANCEMENT_COLUMNS, 'Schema enhancement', 'sql/007_schema_enhancements.sql');
}

async function assertSchemaEnhancementViews(client) {
  await assertViewsExist(client, SCHEMA_ENHANCEMENT_VIEWS, 'Schema enhancement', 'sql/008_preproduction_hardening.sql');
}

async function assertTradeChainingTables(client) {
  await assertTablesExist(client, TRADE_CHAINING_TABLES, 'Trade chaining', 'sql/009_trade_chaining.sql');
  await assertColumnsExist(client, TRADE_CHAINING_COLUMNS, 'Trade chaining', 'sql/009_trade_chaining.sql');
}

async function assertMetadataSyncTables(client) {
  await assertTablesExist(client, METADATA_SYNC_TABLES, 'Metadata sync', 'sql/0012_metadata_sync_and_transfer_enrichment.sql');
}

async function assertPoolTaxonomyTables(client) {
  await assertTablesExist(client, POOL_TAXONOMY_TABLES, 'Pool taxonomy', 'sql/0013_pool_taxonomy_registry.sql');
  await assertColumnsExist(client, POOL_TAXONOMY_COLUMNS, 'Pool taxonomy', 'sql/0013_pool_taxonomy_registry.sql');
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

async function assertColumnsExist(client, expectedColumns, label, migrationFile) {
  const result = await client.query(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (
             ${expectedColumns.map((_, index) => `(table_name = $${(index * 2) + 1} AND column_name = $${(index * 2) + 2})`).join(' OR ')}
        )`,
    expectedColumns.flatMap((item) => [item.table, item.column]),
  );

  const existing = new Set(result.rows.map((row) => `${row.table_name}:${row.column_name}`));
  const missing = expectedColumns
    .filter((item) => !existing.has(`${item.table}:${item.column}`))
    .map((item) => `${item.table}.${item.column}`);

  if (missing.length > 0) {
    throw new Error(`${label} columns are missing. Run ${migrationFile} first. Missing: ${missing.join(', ')}`);
  }
}

async function assertViewsExist(client, viewNames, label, migrationFile) {
  const result = await client.query(
    `SELECT view_name, to_regclass('public.' || view_name) AS regclass
       FROM unnest($1::text[]) AS view_name`,
    [viewNames],
  );

  const missing = result.rows
    .filter((row) => row.regclass === null)
    .map((row) => row.view_name);

  if (missing.length > 0) {
    throw new Error(`${label} views are missing. Run ${migrationFile} first. Missing: ${missing.join(', ')}`);
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
  assertL1Tables,
  assertSchemaEnhancementTables,
  assertSchemaEnhancementViews,
  assertMetadataSyncTables,
  assertPoolTaxonomyTables,
  assertTradeChainingTables,
  advanceCheckpoint,
  ensureIndexStateRows,
  getCheckpoint,
};
