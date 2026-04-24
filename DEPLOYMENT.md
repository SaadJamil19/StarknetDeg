# StarknetDeg Deployment (Turbo Sync + Production)

This setup supports:

- `db`: PostgreSQL
- `app`: main runtime container (main indexer + phase4 + phase6 + L1 jobs via PM2)
- `backfill-worker` (optional profile): parallel historical backfill workers

## 1) First-time server setup

```bash
cp .env.example .env
```

Set required values in `.env`:

- `STARKNET_RPC_URL`
- `ETH_RPC_URL`
- `PGPASSWORD`
- `CMC_API_KEY`

Recommended production worker values:

- `DB_POOL_MAX_MAIN=10`
- `DB_POOL_MAX_BACKFILL=5`
- `NODE_OPTIONS=--max-old-space-size=4096 --max-semi-space-size=128`
- `ULIMIT_NOFILE=65535`
- `PGSTATEMENT_TIMEOUT_MS=60000`
- `PGQUERY_TIMEOUT_MS=65000`
- `PGIDLE_TIMEOUT_MS=10000`
- `INDEXER_PREFETCH_CONCURRENCY=24`
- `INDEXER_PREFETCH_CONCURRENCY_CAP=64`
- `STARKNET_RPC_FALLBACK_CONCURRENCY=10`
- `STARKNET_RPC_REQUEST_TIMEOUT_MS=30000`
- `STARKNET_RPC_KEEPALIVE=true`
- `STARKNET_RPC_KEEPALIVE_MSECS=15000`
- `STARKNET_RPC_MAX_SOCKETS=512`
- `STARKNET_RPC_MAX_FREE_SOCKETS=128`
- `STARKNET_RPC_DYNAMIC_BATCHING=true`
- `STARKNET_RPC_DYNAMIC_BATCH_MAX_REQUESTS=1000`
- `STARKNET_RPC_DYNAMIC_BATCH_LOOKBACK=5`
- `STARKNET_RPC_DYNAMIC_BATCH_LOW_TX_THRESHOLD=10`
- `INDEXER_FAST_HEADER_PROBE=true`
- `EXIT_ON_DB_DISCONNECT=true`

Then build and start core services:

```bash
docker compose up -d --build
```

What this does:

- starts Postgres
- app waits for DB
- runs migrations
- starts PM2 processes

Important:

- `./sql` is mounted at `/docker-entrypoint-initdb.d/sql` for reference/debug only.
- Postgres auto-init execution from `/docker-entrypoint-initdb.d` is intentionally avoided.
- Schema ownership is migration-driven (`npm run migrate`) to prevent first-boot failures from SQL filename ordering.

## 2) Check host sizing (for turbo tuning)

```bash
docker compose exec app npm run audit:resources
```

This prints recommended values for:

- `INDEXER_TURBO_PARALLELISM`
- `INDEXER_PREFETCH_WINDOW_MAX`
- `BACKFILL_PARALLELISM`
- `BACKFILL_TOTAL_WORKERS`

## 3) Runtime health checks

Check container-level health:

```bash
docker compose ps
```

Check PM2 process health endpoint from inside app container:

```bash
docker compose exec app curl -fsS http://127.0.0.1:${HEALTHCHECK_PORT:-3100}/healthz
```

Check process table directly:

```bash
docker compose exec app pm2 list
```

## 4) Verify RPC batch support

```bash
docker compose exec app npm run probe:rpc-batch
```

If `batch_supported=true`, batch JSON-RPC is active and the indexer uses it for block/state prefetch.

## 5) High-speed historical backfill

Use this when you want fast genesis sync (multi-worker).

### 5.1 Configure `.env` backfill range

Set:

- `BACKFILL_START_BLOCK=0`
- `BACKFILL_END_BLOCK=<target_head_block>`
- `BACKFILL_CHUNK_SIZE=1200000`
- `BACKFILL_TOTAL_WORKERS=24`
- `BACKFILL_WINDOW_SIZE=2000`
- `BACKFILL_WINDOW_MAX=2000`
- `BACKFILL_PARALLELISM=24`
- `BACKFILL_FAST_HEADER_ONLY=true`
- `BACKFILL_USE_UNLOGGED_TABLES=true`
- `BACKFILL_UNLOGGED_TABLES=stark_block_journal,stark_transfers`
- `BACKFILL_STALE_WORKER_TIMEOUT_MS=30000`
- `BACKFILL_HEARTBEAT_INTERVAL_MS=5000`
- `BACKFILL_STALE_WORKER_EXIT_CODE=86`
- `INDEXER_TRANSFER_UPSERT_BATCH_SIZE=5000`
- `INDEXER_TRADE_UPSERT_BATCH_SIZE=5000`
- `INDEXER_TURBO_SKIP_SHARED_MARKET_STATE=true` (recommended for high-concurrency backfill to avoid deadlocks on shared latest-state tables)
- `INDEXER_MINIMAL_TRANSFER_UPSERT_BATCH_SIZE=1000` (used only in minimal backfill path)

Worker formula:

`BACKFILL_TOTAL_WORKERS >= ceil((BACKFILL_END_BLOCK - BACKFILL_START_BLOCK + 1) / BACKFILL_CHUNK_SIZE)`

For a ~9M block replay on high-core servers, `24` workers with `1.2M` chunks gives good fan-out coverage.

### 5.2 Start workers

```bash
docker compose --profile backfill up -d --scale backfill-worker=${BACKFILL_TOTAL_WORKERS} backfill-worker
```

What this does:

- starts N parallel workers
- each worker processes a dedicated chunk
- workers use isolated `stark_index_state` keys (`<prefix>-w1`, `<prefix>-w2`, ...)
- avoids row-lock contention on the same checkpoint row
- worker slot leasing uses `FOR UPDATE SKIP LOCKED` so containers do not race for the same slot
- checkpoint writes are namespaced with advisory locks per `(indexer_key, lane)`
- enables double-buffer prefetch (fetch next range while current range is committing)
- enables fast-header-only path for zero-tx blocks
- when `INDEXER_TURBO_SKIP_SHARED_MARKET_STATE=true`, block processing is reduced to checkpoint + `stark_block_journal` + `stark_transfers` writes only
- leader worker can switch configured tables to `UNLOGGED` mode for faster write-heavy replay
- stale-worker heartbeat exits unhealthy workers so Docker restarts them automatically
- worker window auto-halves after slow commits (>10s) and after transient DB contention

### 5.3 Monitor progress

```bash
docker compose --profile backfill logs -f backfill-worker
```

Note: logs now include `remaining_lag` and `bps` so you can track distance-to-finish and real ingestion speed.

```bash
docker compose exec -T db psql -U "$PGUSER" -d "$PGDATABASE" -c "
SELECT indexer_key, lane, last_processed_block_number, last_committed_at
FROM stark_index_state
WHERE indexer_key LIKE '${BACKFILL_INDEXER_KEY_PREFIX:-starknetdeg-mainnet-backfill}%'
ORDER BY indexer_key;"
```

## 6) Promote backfill progress to main indexer

After all workers complete:

```bash
docker compose --profile backfill stop backfill-worker
docker compose --profile backfill rm -f backfill-worker
docker compose exec app npm run promote:backfill-checkpoint
```

What this does:

- validates each worker reached its expected chunk end
- updates canonical `INDEXER_KEY` checkpoint to `BACKFILL_END_BLOCK`
- allows main app indexer to continue from there instead of reprocessing from genesis

## 7) Restore indexes near live window

During deep backfill, non-unique heavy indexes are dropped for speed and restored near live window.

Manual restore (if needed):

```bash
docker compose exec app npm run rebuild:turbo-indexes
```

This rebuilds indexes when lag is below `INDEXER_TURBO_REBUILD_AT_LAG` (default `10000`), or force with:

```bash
docker compose exec app node scripts/rebuild-turbo-indexes.js --force
```

## 8) Throughput and lag checks

Blocks/sec from recent writes:

```bash
docker compose exec -T db psql -U "$PGUSER" -d "$PGDATABASE" -c "
SELECT COUNT(*) AS blocks_last_60s,
       ROUND(COUNT(*)/60.0, 3) AS bps
FROM stark_block_journal
WHERE created_at >= NOW() - INTERVAL '60 seconds'
  AND lane='ACCEPTED_ON_L2'
  AND is_orphaned=FALSE;"
```

Current main checkpoint:

```bash
docker compose exec -T db psql -U "$PGUSER" -d "$PGDATABASE" -c "
SELECT indexer_key, lane, last_processed_block_number, last_committed_at
FROM stark_index_state
WHERE indexer_key='${INDEXER_KEY:-starknetdeg-mainnet}'
  AND lane='${INDEXER_LANE:-ACCEPTED_ON_L2}';"
```

## 9) Postgres tuning (already wired in compose)

`db` service runs with:

- `max_connections=200`
- `shared_buffers=1GB`
- `work_mem=16MB`

This is set directly in `docker-compose.yml` and applies automatically on `docker compose up`.

## 10) Common operations

Restart everything:

```bash
docker compose up -d --build
```

Stop containers (keep data):

```bash
docker compose down
```

Stop and wipe DB volume:

```bash
docker compose down -v
```

## 11) Deadlock / Gap Troubleshooting (Latest)

If throughput drops or workers loop on errors, use this checklist:

1. Check recent worker failures:

```bash
docker compose --profile backfill logs --since 10m backfill-worker | egrep "deadlock|40P01|Checkpoint gap detected|statement timeout|stale-worker-detected"
```

2. Confirm unique worker namespaces are moving:

```bash
docker compose exec -T db psql -U "$PGUSER" -d "$PGDATABASE" -c "
SELECT indexer_key, last_processed_block_number, last_committed_at
FROM stark_index_state
WHERE lane='ACCEPTED_ON_L2'
  AND indexer_key LIKE '${BACKFILL_INDEXER_KEY_PREFIX:-starknetdeg-mainnet-backfill}%'
ORDER BY indexer_key;"
```

3. If old/partial claims are stuck, restart worker profile cleanly:

```bash
docker compose --profile backfill down
docker compose up -d db
docker compose --profile backfill up -d --scale backfill-worker=${BACKFILL_TOTAL_WORKERS} backfill-worker
```

4. If you changed worker topology/chunk plan, rotate prefix to isolate checkpoints:

```env
BACKFILL_INDEXER_KEY_PREFIX=starknetdeg-mainnet-backfill-v4
```

Then relaunch workers. This prevents mixing old checkpoint rows with a new shard plan.

5. If you see repeated timeout/deadlock on `stark_pool_registry`, `stark_pool_latest`, or `stark_prices`, run backfill with:

```env
INDEXER_TURBO_SKIP_SHARED_MARKET_STATE=true
```

Then recreate backfill workers so the new env is applied.
