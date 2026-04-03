'use strict';

const { Pool } = require('pg');

let pool;

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

function resolveSslConfig() {
  const rawValue = String(process.env.PGSSL ?? process.env.PGSSLMODE ?? '').trim().toLowerCase();

  if (!rawValue || rawValue === 'disable' || rawValue === 'false') {
    return undefined;
  }

  return { rejectUnauthorized: false };
}

function buildPoolConfig() {
  const ssl = resolveSslConfig();

  if (process.env.DATABASE_URL) {
    return {
      connectionString: process.env.DATABASE_URL,
      ssl,
    };
  }

  return {
    host: process.env.PGHOST || '127.0.0.1',
    port: parsePort(process.env.PGPORT, 5432),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
    database: process.env.PGDATABASE || 'StarknetDeg',
    ssl,
  };
}

function getPool() {
  if (!pool) {
    pool = new Pool(buildPoolConfig());
  }

  return pool;
}

async function query(text, params) {
  return getPool().query(text, params);
}

async function withClient(work) {
  const client = await getPool().connect();

  try {
    return await work(client);
  } finally {
    client.release();
  }
}

async function withTransaction(work) {
  return withClient(async (client) => {
    await client.query('BEGIN');

    try {
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        error.rollbackError = rollbackError;
      }

      throw error;
    }
  });
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
  query,
  withClient,
  withTransaction,
};
