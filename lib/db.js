'use strict';

const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { Pool } = require('pg');

let pool;
let fatalExitScheduled = false;

const DEFAULT_STATEMENT_TIMEOUT_MS = 60_000;
const DEFAULT_IDLE_TIMEOUT_MS = 10_000;
const DEFAULT_MAIN_POOL_MAX = 10;
const DEFAULT_BACKFILL_POOL_MAX = 5;
const TRANSACTION_RETRY_BACKOFF_MS = Object.freeze([1_000, 2_000, 4_000]);
const FATAL_PG_CODES = new Set([
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '57P01',
  '57P02',
  '57P03',
]);
const FATAL_NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'EPIPE',
]);
const FATAL_MESSAGE_FRAGMENTS = [
  'connection terminated unexpectedly',
  'terminating connection due to administrator command',
  'server closed the connection unexpectedly',
  'the database system is shutting down',
  'the database system is starting up',
  'connection not open',
  'client has encountered a connection error and is not queryable',
  'could not connect to server',
  'remaining connection slots are reserved',
];

function parsePort(value, fallback) {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid database port: ${value}`);
  }

  return parsed;
}

function parseNonNegativeInteger(value, fallback, label) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallback;
  }

  const parsed = Number.parseInt(String(value).trim(), 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer, received: ${value}`);
  }

  return parsed;
}

function parsePositiveInteger(value, fallback, label) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallback;
  }

  const parsed = Number.parseInt(String(value).trim(), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer, received: ${value}`);
  }

  return parsed;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallback;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function resolveSslConfig() {
  const rawValue = String(process.env.PGSSL ?? process.env.PGSSLMODE ?? '').trim().toLowerCase();

  if (!rawValue || rawValue === 'disable' || rawValue === 'false') {
    return undefined;
  }

  return { rejectUnauthorized: false };
}

function isBackfillProcess() {
  if (parseBoolean(process.env.BACKFILL_WORKER_MODE, false)) {
    return true;
  }

  const argvEntry = process.argv?.[1] ? String(process.argv[1]).trim() : '';
  if (!argvEntry) {
    return false;
  }

  const normalized = path.basename(argvEntry).toLowerCase();
  return normalized === 'turbo-backfill.js';
}

function resolvePoolMax() {
  if (process.env.DB_POOL_MAX !== undefined && process.env.DB_POOL_MAX !== null && String(process.env.DB_POOL_MAX).trim() !== '') {
    return parsePositiveInteger(process.env.DB_POOL_MAX, DEFAULT_MAIN_POOL_MAX, 'DB_POOL_MAX');
  }

  return isBackfillProcess() ? DEFAULT_BACKFILL_POOL_MAX : DEFAULT_MAIN_POOL_MAX;
}

function buildPoolConfig() {
  const ssl = resolveSslConfig();
  const idleTimeoutMillis = parseNonNegativeInteger(
    process.env.PGIDLE_TIMEOUT_MS,
    DEFAULT_IDLE_TIMEOUT_MS,
    'PGIDLE_TIMEOUT_MS',
  );
  const statementTimeoutMs = parseNonNegativeInteger(
    process.env.PGSTATEMENT_TIMEOUT_MS,
    DEFAULT_STATEMENT_TIMEOUT_MS,
    'PGSTATEMENT_TIMEOUT_MS',
  );
  const queryTimeoutMs = parseNonNegativeInteger(
    process.env.PGQUERY_TIMEOUT_MS,
    statementTimeoutMs + 5_000,
    'PGQUERY_TIMEOUT_MS',
  );
  const baseConfig = {
    idleTimeoutMillis,
    max: resolvePoolMax(),
    query_timeout: queryTimeoutMs,
    statement_timeout: statementTimeoutMs,
    ssl,
  };

  if (process.env.DATABASE_URL) {
    return {
      ...baseConfig,
      connectionString: process.env.DATABASE_URL,
    };
  }

  return {
    ...baseConfig,
    host: process.env.PGHOST || '127.0.0.1',
    port: parsePort(process.env.PGPORT, 5432),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
    database: process.env.PGDATABASE || 'StarknetDeg',
  };
}

function getPool() {
  if (!pool) {
    pool = new Pool(buildPoolConfig());
    pool.on('error', (error) => {
      handleFatalDatabaseError(error);
    });
  }

  return pool;
}

async function query(text, params) {
  try {
    return await getPool().query(text, params);
  } catch (error) {
    handleFatalDatabaseError(error);
    throw error;
  }
}

async function withClient(work) {
  let client;

  try {
    client = await getPool().connect();
  } catch (error) {
    handleFatalDatabaseError(error);
    throw error;
  }

  try {
    return await work(client);
  } catch (error) {
    handleFatalDatabaseError(error);
    throw error;
  } finally {
    if (client) {
      client.release();
    }
  }
}

async function withTransaction(work) {
  for (let attempt = 0; ; attempt += 1) {
    let client;
    let destroyClient = false;

    try {
      client = await getPool().connect();
      await client.query('BEGIN');

      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      const retryReason = classifyRetryableTransactionError(error);
      if (retryReason !== null) {
        destroyClient = true;
      }

      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          error.rollbackError = rollbackError;
          destroyClient = true;
        }
      }

      handleFatalDatabaseError(error);

      if (retryReason === null || attempt >= TRANSACTION_RETRY_BACKOFF_MS.length) {
        throw error;
      }

      const delayMs = TRANSACTION_RETRY_BACKOFF_MS[attempt];
      console.warn(
        `[db] ${retryReason} (code=${String(error?.code || '') || 'unknown'}), retrying transaction in ${delayMs}ms (attempt ${attempt + 1}/${TRANSACTION_RETRY_BACKOFF_MS.length})`,
      );
      await sleep(delayMs);
    } finally {
      if (client) {
        client.release(destroyClient);
      }
    }
  }
}

function classifyRetryableTransactionError(error) {
  if (!error) {
    return null;
  }

  const code = String(error.code ?? '').trim().toUpperCase();
  const message = String(error.message ?? '').toLowerCase();

  if (code === '40P01' || message.includes('deadlock detected')) {
    return 'deadlock detected';
  }

  if (
    code === '57014'
    || message.includes('statement timeout')
    || message.includes('canceling statement due to statement timeout')
  ) {
    return 'statement timeout';
  }

  if (code === '25P02' || message.includes('current transaction is aborted')) {
    return 'transaction is aborted';
  }

  return null;
}

function handleFatalDatabaseError(error) {
  if (!isFatalDatabaseError(error) || fatalExitScheduled || !parseBoolean(process.env.EXIT_ON_DB_DISCONNECT, true)) {
    return;
  }

  fatalExitScheduled = true;
  const detail = error?.message || String(error);
  console.error(`[db] fatal database connectivity error detected, exiting process for supervisor restart: ${detail}`);

  setTimeout(() => {
    process.exit(1);
  }, 25);
}

function isFatalDatabaseError(error) {
  if (!error) {
    return false;
  }

  const code = String(error.code ?? '').trim().toUpperCase();
  if (code === '57014') {
    return false;
  }
  if (FATAL_PG_CODES.has(code) || FATAL_NETWORK_CODES.has(code)) {
    return true;
  }

  const message = String(error.message ?? '').toLowerCase();
  if (message.includes('statement timeout')) {
    return false;
  }
  if (FATAL_MESSAGE_FRAGMENTS.some((fragment) => message.includes(fragment))) {
    return true;
  }

  if (error.cause && error.cause !== error) {
    return isFatalDatabaseError(error.cause);
  }

  return false;
}

async function closePool() {
  if (!pool) {
    return;
  }

  const activePool = pool;
  pool = undefined;
  await activePool.end();
}

module.exports = {
  closePool,
  getPool,
  isFatalDatabaseError,
  query,
  withClient,
  withTransaction,
};
