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
const FULL_NODE_PLAN2_TABLES = Object.freeze([
  'stark_audit_discrepancies',
]);
const FINANCIAL_RESILIENCE_COLUMNS = Object.freeze([
  { table: 'stark_wallet_positions', column: 'dust_loss_usd' },
  { table: 'stark_wallet_stats', column: 'total_dust_loss_usd' },
]);
const PROTOCOL_ACCURACY_COLUMNS = Object.freeze([
  { table: 'stark_audit_discrepancies', column: 'retry_count' },
]);
const INTEGRITY_MAINTENANCE_TABLES = Object.freeze([
  'stark_pnl_audit_trail',
]);
const ABSOLUTE_FINALITY_COLUMNS = Object.freeze([
  { table: 'stark_pnl_audit_trail', column: 'lot_id' },
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

async function assertFullNodePlan2Tables(client) {
  await assertTablesExist(client, FULL_NODE_PLAN2_TABLES, 'Full Node Plan 2', 'sql/0014_full_node_plan2.sql');
}

async function assertFinancialResilienceColumns(client) {
  await assertColumnsExist(client, FINANCIAL_RESILIENCE_COLUMNS, 'Financial resilience', 'sql/0015_financial_resilience.sql');
}

async function assertProtocolAccuracyColumns(client) {
  await assertColumnsExist(client, PROTOCOL_ACCURACY_COLUMNS, 'Protocol accuracy', 'sql/0016_protocol_accuracy.sql');
}

async function assertIntegrityMaintenanceTables(client) {
  await assertTablesExist(client, INTEGRITY_MAINTENANCE_TABLES, 'Integrity maintenance', 'sql/0017_integrity_and_maintenance.sql');
}

async function assertAbsoluteFinalityColumns(client) {
  await assertColumnsExist(client, ABSOLUTE_FINALITY_COLUMNS, 'Absolute finality', 'sql/0018_absolute_finality.sql');
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

async function getBlockJournalRange(client, { lane } = {}) {
  const params = [];
  const laneClause = lane ? 'WHERE lane = $1' : '';
  if (lane) {
    params.push(assertValidFinalityLane(lane));
  }

  const result = await client.query(
    `SELECT lane,
            COUNT(*) AS row_count,
            MIN(block_number) AS min_block_number,
            MAX(block_number) AS max_block_number,
            COUNT(*) FILTER (WHERE is_orphaned = TRUE) AS orphaned_count
       FROM stark_block_journal
       ${laneClause}
      GROUP BY lane
      ORDER BY lane`,
    params,
  );

  return result.rows.map((row) => ({
    lane: row.lane,
    maxBlockNumber: row.max_block_number === null ? null : BigInt(row.max_block_number),
    minBlockNumber: row.min_block_number === null ? null : BigInt(row.min_block_number),
    orphanedCount: BigInt(row.orphaned_count ?? 0),
    rowCount: BigInt(row.row_count ?? 0),
  }));
}

async function resolveInitialIndexerStartBlock(client, {
  configuredStartBlock = null,
  lane = FINALITY_LANES.ACCEPTED_ON_L2,
  startMode = 'genesis',
  startTargets = [],
} = {}) {
  if (configuredStartBlock !== null && configuredStartBlock !== undefined) {
    return toNonNegativeBigInt(configuredStartBlock, 'configured start block');
  }

  const normalizedMode = String(startMode || 'genesis').trim().toLowerCase();
  if (normalizedMode === 'genesis' || normalizedMode === 'block_0' || normalizedMode === 'block0') {
    return 0n;
  }

  if (normalizedMode === 'tracked_deployment' || normalizedMode === 'deployment' || normalizedMode === 'deployments') {
    const deploymentStartBlock = await getTrackedDeploymentStartBlock(client, {
      lane,
      targets: startTargets,
    });
    return deploymentStartBlock ?? 0n;
  }

  throw new Error(`Unsupported INDEXER_START_MODE: ${startMode}. Use genesis or tracked_deployment.`);
}

async function getTrackedDeploymentStartBlock(client, {
  lane = FINALITY_LANES.ACCEPTED_ON_L2,
  targets = [],
} = {}) {
  const validLane = assertValidFinalityLane(lane);
  const normalizedTargets = normalizeStartTargets(targets);

  if (normalizedTargets.length > 0) {
    const result = await client.query(
      `WITH matched_token_addresses AS (
         SELECT lower(address) AS contract_address
           FROM tokens
          WHERE lower(address) = ANY($2::text[])
             OR lower(symbol) = ANY($2::text[])
             OR lower(name) = ANY($2::text[])
       ),
       matched_registry_rows AS (
         SELECT lower(contract_address) AS contract_address,
                valid_from_block
           FROM stark_contract_registry
          WHERE is_active = TRUE
            AND contract_address IS NOT NULL
            AND (
                 lower(contract_address) = ANY($2::text[])
              OR lower(protocol) = ANY($2::text[])
              OR lower(COALESCE(role, '')) = ANY($2::text[])
            )
       ),
       target_addresses AS (
         SELECT contract_address FROM matched_token_addresses
         UNION
         SELECT contract_address FROM matched_registry_rows
       ),
       registry_start AS (
         SELECT MIN(valid_from_block) AS block_number
           FROM matched_registry_rows
          WHERE valid_from_block IS NOT NULL
            AND valid_from_block > 0
       ),
       observed_deployments AS (
         SELECT MIN(state.block_number) AS block_number
           FROM stark_block_state_updates AS state
          CROSS JOIN LATERAL jsonb_array_elements(state.deployed_contracts) AS deploy_item
          WHERE state.lane = $1
            AND lower(COALESCE(deploy_item ->> 'contract_address', deploy_item ->> 'address')) IN (
                SELECT contract_address
                  FROM target_addresses
            )
       )
       SELECT MIN(block_number) AS block_number
         FROM (
           SELECT block_number FROM registry_start
           UNION ALL
           SELECT block_number FROM observed_deployments
         ) AS starts
        WHERE block_number IS NOT NULL`,
      [validLane, normalizedTargets],
    );

    const value = result.rows[0]?.block_number ?? null;
    return value === null ? null : BigInt(value);
  }

  const result = await client.query(
    `WITH registry_start AS (
       SELECT MIN(valid_from_block) AS block_number
         FROM stark_contract_registry
        WHERE is_active = TRUE
          AND valid_from_block IS NOT NULL
          AND valid_from_block > 0
     ),
     observed_deployments AS (
       SELECT MIN(state.block_number) AS block_number
         FROM stark_block_state_updates AS state
        CROSS JOIN LATERAL jsonb_array_elements(state.deployed_contracts) AS deploy_item
        WHERE state.lane = $1
          AND lower(COALESCE(deploy_item ->> 'contract_address', deploy_item ->> 'address')) IN (
              SELECT lower(address) FROM tokens
              UNION
              SELECT lower(contract_address)
                FROM stark_contract_registry
               WHERE is_active = TRUE
                 AND contract_address IS NOT NULL
          )
     )
     SELECT MIN(block_number) AS block_number
       FROM (
         SELECT block_number FROM registry_start
         UNION ALL
         SELECT block_number FROM observed_deployments
       ) AS starts
      WHERE block_number IS NOT NULL`,
    [validLane],
  );

  const value = result.rows[0]?.block_number ?? null;
  return value === null ? null : BigInt(value);
}

function normalizeStartTargets(value) {
  const rawValues = Array.isArray(value) ? value : String(value ?? '').split(',');
  return rawValues
    .map((item) => String(item ?? '').trim().toLowerCase())
    .filter((item) => item.length > 0);
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

function toNonNegativeBigInt(value, label) {
  const parsed = BigInt(value);
  if (parsed < 0n) {
    throw new Error(`${label} cannot be negative.`);
  }

  return parsed;
}

module.exports = {
  assertFoundationTables,
  assertPhase2Tables,
  assertPhase3Tables,
  assertPhase4Tables,
  assertPhase6Tables,
  assertL1Tables,
  assertFullNodePlan2Tables,
  assertFinancialResilienceColumns,
  assertAbsoluteFinalityColumns,
  assertIntegrityMaintenanceTables,
  assertProtocolAccuracyColumns,
  assertSchemaEnhancementTables,
  assertSchemaEnhancementViews,
  assertMetadataSyncTables,
  assertPoolTaxonomyTables,
  assertTradeChainingTables,
  advanceCheckpoint,
  ensureIndexStateRows,
  getBlockJournalRange,
  getCheckpoint,
  getTrackedDeploymentStartBlock,
  resolveInitialIndexerStartBlock,
};
