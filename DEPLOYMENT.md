# StarknetDeg Docker Deployment

This repo ships a Docker setup for the StarknetDeg indexer and PostgreSQL.

## 1. Prepare `.env`

On the server, copy the example file and fill the RPC keys:

```bash
cp .env.example .env
```

Required values:

- `STARKNET_RPC_URL`
- `ETH_RPC_URL` if L1 StarkGate indexing is enabled
- `PGDATABASE`, `PGUSER`, `PGPASSWORD`

When running through Docker Compose, `PGHOST` is automatically overridden to the internal `postgres` service.
Do not set `DATABASE_URL` unless you intentionally want the app container to use an external database; `DATABASE_URL` takes precedence over `PGHOST`.

## 2. Start the L2 indexer and database

```bash
docker compose up -d --build
```

This starts:

- `postgres`
- `indexer`

The `postgres_data` Docker volume persists database files across container restarts.

## 3. Migrations

The app container runs SQL migrations automatically before starting the Node process.

Manual migration command:

```bash
docker compose run --rm indexer npm run migrate
```

Migrations are read from `sql/` and applied in numeric order, so `0010_l1_new_tables.sql` runs after `009_trade_chaining.sql`.

## 4. Optional workers

Start Phase 4 and Phase 6 background workers:

```bash
docker compose --profile workers up -d --build
```

Start L1 StarkGate indexer and matcher:

```bash
docker compose --profile l1 up -d --build
```

You can combine profiles:

```bash
docker compose --profile workers --profile l1 up -d --build
```

## 5. Logs and operations

View logs:

```bash
docker compose logs -f indexer
```

Stop services without deleting data:

```bash
docker compose down
```

Stop services and delete PostgreSQL data:

```bash
docker compose down -v
```

Use `down -v` only when you intentionally want to wipe the database volume.
