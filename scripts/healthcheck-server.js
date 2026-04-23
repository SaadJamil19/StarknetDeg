#!/usr/bin/env node
'use strict';

const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const DEFAULT_REQUIRED = ['main-indexer', 'phase4-workers', 'phase6-workers', 'l1-indexer', 'l1-matcher'];

const port = parsePositiveInteger(process.env.HEALTHCHECK_PORT, 3100, 'HEALTHCHECK_PORT');
const pm2TimeoutMs = parsePositiveInteger(process.env.HEALTHCHECK_PM2_TIMEOUT_MS, 3000, 'HEALTHCHECK_PM2_TIMEOUT_MS');
const requiredProcesses = parseRequiredProcesses(process.env.PM2_REQUIRED_PROCESSES);

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/livez') {
      return writeJson(res, 200, { status: 'ok' });
    }

    if (req.url === '/healthz') {
      const health = await evaluatePm2Health();
      const statusCode = health.ok ? 200 : 503;
      return writeJson(res, statusCode, health);
    }

    return writeJson(res, 404, { error: 'not_found' });
  } catch (error) {
    return writeJson(res, 503, {
      error: 'healthcheck_failed',
      message: error?.message || String(error),
      ok: false,
    });
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`[healthcheck] listening on 0.0.0.0:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    server.close(() => {
      process.exit(0);
    });
  });
}

async function evaluatePm2Health() {
  const { stdout } = await execFileAsync('pm2', ['jlist'], {
    maxBuffer: 4 * 1024 * 1024,
    timeout: pm2TimeoutMs,
  });
  const list = parsePm2List(stdout);

  const byName = new Map();
  for (const item of list) {
    const name = String(item?.name ?? '').trim();
    if (!name) {
      continue;
    }
    byName.set(name, item);
  }

  const offline = [];
  const missing = [];
  for (const name of requiredProcesses) {
    const item = byName.get(name);
    if (!item) {
      missing.push(name);
      continue;
    }

    const status = String(item?.pm2_env?.status ?? '').toLowerCase();
    if (status !== 'online') {
      offline.push({ name, status: status || 'unknown' });
    }
  }

  return {
    missing,
    offline,
    ok: missing.length === 0 && offline.length === 0,
    required: requiredProcesses,
    timestamp: new Date().toISOString(),
  };
}

function parsePm2List(stdout) {
  const raw = String(stdout ?? '').trim();
  if (!raw) {
    return [];
  }

  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

function parseRequiredProcesses(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return DEFAULT_REQUIRED;
  }

  const parsed = String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return parsed.length === 0 ? DEFAULT_REQUIRED : parsed;
}

function parsePositiveInteger(value, fallbackValue, label) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallbackValue;
  }

  const parsed = Number.parseInt(String(value).trim(), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer, received: ${value}`);
  }

  return parsed;
}

function writeJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}
