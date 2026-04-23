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
- `PGSTATEMENT_TIMEOUT_MS=60000`
- `PGQUERY_TIMEOUT_MS=65000`
- `PGIDLE_TIMEOUT_MS=10000`
- `INDEXER_PREFETCH_CONCURRENCY=10`
- `STARKNET_RPC_FALLBACK_CONCURRENCY=10`
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
- `BACKFILL_CHUNK_SIZE=2000000`
- `BACKFILL_TOTAL_WORKERS=<number_of_workers>`

Worker formula:

`BACKFILL_TOTAL_WORKERS >= ceil((BACKFILL_END_BLOCK - BACKFILL_START_BLOCK + 1) / BACKFILL_CHUNK_SIZE)`

For ~9M blocks with chunk 2M, use at least `5` workers.

### 5.2 Start workers

```bash
docker compose --profile backfill up -d --scale backfill-worker=${BACKFILL_TOTAL_WORKERS} backfill-worker
```

What this does:

- starts N parallel workers
- each worker processes a dedicated chunk
- workers use isolated `stark_index_state` keys (`<prefix>-w1`, `<prefix>-w2`, ...)
- avoids row-lock contention on the same checkpoint row

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
