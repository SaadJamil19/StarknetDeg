#!/usr/bin/env node
'use strict';

const os = require('node:os');

function main() {
  const cpuCores = os.cpus().length;
  const totalMemoryGb = bytesToGb(os.totalmem());
  const recommendedTurboParallelism = clamp(Math.floor(cpuCores * 0.75), 4, 32);
  const recommendedBackfillWorkers = clamp(Math.floor(cpuCores * 0.75), 1, 24);
  const recommendedWindowMax = totalMemoryGb >= 96 ? 2000 : totalMemoryGb >= 64 ? 1200 : totalMemoryGb >= 32 ? 800 : 400;

  console.log('[resource-audit] host capacity');
  console.log(`cpu_cores=${cpuCores}`);
  console.log(`memory_gb=${totalMemoryGb.toFixed(2)}`);
  console.log('[resource-audit] suggested turbo settings');
  console.log(`INDEXER_TURBO_PARALLELISM=${recommendedTurboParallelism}`);
  console.log(`INDEXER_PREFETCH_WINDOW_MAX=${recommendedWindowMax}`);
  console.log(`BACKFILL_PARALLELISM=${recommendedTurboParallelism}`);
  console.log(`BACKFILL_TOTAL_WORKERS=${recommendedBackfillWorkers}`);
}

function bytesToGb(value) {
  return Number(value) / (1024 ** 3);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

main();
