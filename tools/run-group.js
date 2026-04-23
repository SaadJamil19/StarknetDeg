#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawn } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const phase = String(process.argv[2] || '').trim().toLowerCase();

const GROUPS = Object.freeze({
  phase4: [
    { name: 'trade-chaining', script: 'jobs/trade-chaining.js' },
    { name: 'meta-refresher', script: 'jobs/meta-refresher.js' },
    { name: 'metadata-syncer', script: 'jobs/metadata-syncer.js' },
    { name: 'pool-taxonomy', script: 'jobs/backfill-pool-taxonomy.js' },
    { name: 'abi-refresh', script: 'jobs/abi-refresh.js' },
    { name: 'security-scanner', script: 'jobs/security-scanner.js' },
  ],
  phase6: [
    {
      name: 'bridge-accounting',
      script: 'jobs/bridge-accounting.js',
      env: { PHASE6_BRIDGE_ACCOUNTING_RUN_ONCE: 'false' },
    },
    {
      name: 'wallet-rollups',
      script: 'scripts/defer-until-live.js',
      args: ['jobs/wallet-rollups.js'],
      env: {
        PHASE6_WALLET_ROLLUPS_RUN_ONCE: 'false',
      },
    },
    {
      name: 'concentration-rollups',
      script: 'scripts/defer-until-live.js',
      args: ['jobs/concentration-rollups.js'],
      env: {
        PHASE6_CONCENTRATION_RUN_ONCE: 'false',
      },
    },
    {
      name: 'finality-promoter',
      script: 'jobs/finality-promoter.js',
      env: { PHASE6_FINALITY_PROMOTER_RUN_ONCE: 'false' },
    },
  ],
});

if (!GROUPS[phase]) {
  console.error(`Usage: node tools/run-group.js <phase4|phase6>`);
  process.exit(1);
}

const children = new Map();
let shuttingDown = false;

main().catch((error) => {
  console.error(`[launcher:${phase}] fatal error: ${formatError(error)}`);
  process.exitCode = 1;
});

async function main() {
  installSignalHandlers();

  const jobs = GROUPS[phase];
  console.log(`[launcher:${phase}] starting ${jobs.length} job(s) in one terminal`);

  for (const job of jobs) {
    const child = spawn(process.execPath, [job.script, ...(Array.isArray(job.args) ? job.args : [])], {
      cwd: projectRoot,
      env: {
        ...process.env,
        ...job.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: false,
    });

    children.set(job.name, child);
    pipePrefixed(child.stdout, `[${phase}:${job.name}]`, process.stdout);
    pipePrefixed(child.stderr, `[${phase}:${job.name}]`, process.stderr);

    child.on('exit', (code, signal) => {
      children.delete(job.name);
      const detail = signal ? `signal=${signal}` : `code=${code ?? 0}`;
      console.log(`[launcher:${phase}] ${job.name} exited ${detail}`);

      if (!shuttingDown && code && code !== 0) {
        process.exitCode = code;
      }

      if (children.size === 0) {
        process.exit(process.exitCode ?? 0);
      }
    });
  }
}

function pipePrefixed(stream, prefix, destination) {
  let buffer = '';

  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() ?? '';

    for (const line of parts) {
      if (!line) {
        continue;
      }
      destination.write(`${prefix} ${line}\n`);
    }
  });

  stream.on('end', () => {
    if (buffer) {
      destination.write(`${prefix} ${buffer}\n`);
      buffer = '';
    }
  });
}

function installSignalHandlers() {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      if (shuttingDown) {
        return;
      }

      shuttingDown = true;
      console.log(`[launcher:${phase}] received ${signal}, forwarding to child jobs`);
      for (const child of children.values()) {
        try {
          child.kill(signal);
        } catch (error) {
          // Ignore child shutdown errors.
        }
      }
    });
  }
}

function formatError(error) {
  if (!error) {
    return 'Unknown error';
  }

  if (error instanceof Error) {
    return error.stack || error.message;
  }

  return String(error);
}
