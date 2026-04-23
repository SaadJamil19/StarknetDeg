# StarknetDeg Docker Deployment

This repo uses a simple two-container production model:

- `db`: PostgreSQL with persistent Docker volume storage
- `app`: one Node.js container named `starknet-app`, supervised by PM2

The app container starts these five processes:

- main Starknet indexer
- Phase 4 workers
- Phase 6 workers
- L1 StarkGate indexer
- L1 matcher

## 1. Prepare `.env`

On the server, copy the example file and fill the RPC keys:

```bash
cp .env.example .env
```

Required values:

- `STARKNET_RPC_URL`
- `ETH_RPC_URL`
- `PGDATABASE`
- `PGUSER`
- `PGPASSWORD`

For Docker Compose, keep:

```env
PGHOST=db
PGPORT=5432
RUN_MIGRATIONS=true
```

Do not set `DATABASE_URL` for the two-container setup. The compose file clears `DATABASE_URL` inside the app container so the app always uses the internal `db` service.

## 2. Start Production Stack

```bash
docker compose up -d --build
```

This starts only:

- `db`
- `app`

Postgres is not published to the host. It is reachable only from the app container through the private Docker network.

## 3. Migrations

The app entrypoint waits for Postgres, runs:

```bash
npm run migrate
```

Then it starts PM2.

Migrations are read from `sql/` and applied in numeric order, so `0010_l1_new_tables.sql` runs after `009_trade_chaining.sql`.

Manual migration command:

```bash
docker compose run --rm app npm run migrate
```

## 4. Logs and Operations

View all logs:

```bash
docker compose logs -f
```

View app logs only:

```bash
docker compose logs -f app
```

Check containers:

```bash
docker compose ps
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
