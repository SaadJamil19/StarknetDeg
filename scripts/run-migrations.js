#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { Client } = require('pg');

const MIGRATION_LOCK_KEY = 912440721;

async function main() {
  const clientConfig = buildClientConfig();
  const retries = parsePositiveInteger(process.env.MIGRATION_RETRIES, 60);
  const retryDelayMs = parsePositiveInteger(process.env.MIGRATION_RETRY_DELAY_MS, 1000);
  const migrationsDir = path.resolve(__dirname, '..', process.env.MIGRATIONS_DIR || 'sql');
  const client = await connectWithRetry(clientConfig, { retries, retryDelayMs });

  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await ensureMigrationTable(client);

    const applied = await loadAppliedMigrations(client);
    const files = await listMigrationFiles(migrationsDir);

    for (const file of files) {
      const filePath = path.join(migrationsDir, file);
      const sql = await fs.readFile(filePath, 'utf8');
      const checksum = sha256(sql);
      const existing = applied.get(file);

      if (existing) {
        if (existing !== checksum) {
          throw new Error(`Migration checksum changed after apply: ${file}`);
        }
        continue;
      }

      console.log(`[migrate] applying ${file}`);
      await client.query(sql);
      await client.query(
        `INSERT INTO stark_schema_migrations (filename, checksum, applied_at)
         VALUES ($1, $2, NOW())`,
        [file, checksum],
      );
      console.log(`[migrate] applied ${file}`);
    }

    console.log(`[migrate] complete files=${files.length} applied=${applied.size}`);
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    } catch (error) {
      // The connection may already be broken; exiting will release the session lock.
    }
    await client.end();
  }
}

function buildClientConfig() {
  const ssl = resolveSslConfig();

  if (process.env.DATABASE_URL) {
    return {
      connectionString: process.env.DATABASE_URL,
      ssl,
    };
  }

  return {
    database: process.env.PGDATABASE || 'StarknetDeg',
    host: process.env.PGHOST || '127.0.0.1',
    password: process.env.PGPASSWORD || 'postgres',
    port: parsePositiveInteger(process.env.PGPORT, 5432),
    ssl,
    user: process.env.PGUSER || 'postgres',
  };
}

function resolveSslConfig() {
  const rawValue = String(process.env.PGSSL ?? process.env.PGSSLMODE ?? '').trim().toLowerCase();

  if (!rawValue || rawValue === 'disable' || rawValue === 'false') {
    return undefined;
  }

  return { rejectUnauthorized: false };
}

async function connectWithRetry(clientConfig, { retries, retryDelayMs }) {
  let lastError = null;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const client = new Client(clientConfig);

    try {
      await client.connect();
      await client.query('SELECT 1');
      return client;
    } catch (error) {
      lastError = error;
      try {
        await client.end();
      } catch (endError) {
        // Ignore cleanup errors from a failed connection attempt.
      }
      console.log(`[migrate] waiting for postgres attempt=${attempt}/${retries} error=${error.message}`);
      await sleep(retryDelayMs);
    }
  }

  throw lastError;
}

async function ensureMigrationTable(client) {
  await client.query(
    `CREATE TABLE IF NOT EXISTS stark_schema_migrations (
       filename TEXT PRIMARY KEY,
       checksum TEXT NOT NULL,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
  );
}

async function loadAppliedMigrations(client) {
  const result = await client.query(
    `SELECT filename, checksum
       FROM stark_schema_migrations`,
  );

  return new Map(result.rows.map((row) => [row.filename, row.checksum]));
}

async function listMigrationFiles(migrationsDir) {
  const entries = await fs.readdir(migrationsDir);
  return entries
    .filter((file) => /^\d+.*\.sql$/i.test(file))
    .sort(compareMigrationFiles);
}

function compareMigrationFiles(left, right) {
  const leftNumber = migrationNumber(left);
  const rightNumber = migrationNumber(right);

  if (leftNumber !== rightNumber) {
    return leftNumber - rightNumber;
  }

  return left.localeCompare(right);
}

function migrationNumber(file) {
  const match = String(file).match(/^(\d+)/);
  return match ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parsePositiveInteger(value, fallbackValue) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallbackValue;
  }

  const parsed = Number.parseInt(String(value).trim(), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer but received: ${value}`);
  }

  return parsed;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

main().catch((error) => {
  console.error(`[migrate] fatal: ${error.stack || error.message || String(error)}`);
  process.exitCode = 1;
});
