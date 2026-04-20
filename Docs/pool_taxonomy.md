# Pool Taxonomy

Date: April 18, 2026

This document defines how StarknetDeg discovers, classifies, stores, and serves pool taxonomy on Starknet.

## Goal

Starknet liquidity venues are not uniform:

- some use pair contracts
- some use concentrated-liquidity pool contracts
- some use singleton cores where pool identity is not the contract address
- some are routers and must not be treated as pools

The pool taxonomy system exists to answer three questions cleanly:

1. What is the venue? `protocol`
2. What is the broad pool class? `pool_family`
3. What is the exact pool mechanism? `pool_model`

## Canonical Storage

The canonical registry table is `stark_pool_registry`.

Columns:

- `pool_key` primary key
- `protocol`
- `contract_address` nullable
- `pool_id`
- `class_hash`
- `factory_address`
- `token0_address`
- `token1_address`
- `pool_family`
- `pool_model`
- `stable_flag`
- `confidence_level`
- `first_seen_block`
- `metadata`

`pool_key` is the true identity key.

Rules:

- for pair or pool-contract venues, `pool_key = pool_id = contract address`
- for mySwap-style fixed pools, `pool_key = pool_id = amm_address:raw_pool_id`
- for Haiko markets, `pool_key = pool_id = haiko:market_id`
- for Haiko multiswap summaries, `pool_key = pool_id = haiko:multiswap:token0:token1`
- for Ekubo, `pool_key = pool_id = token0:token1:fee:tickSpacing:extension`

Ekubo is the reason `pool_key` exists. The core contract address alone is not enough.

## Materialized Tables

`stark_pool_state_history` and `stark_pool_latest` both carry:

- `protocol`
- `pool_family`
- `pool_model`

These columns are materialized copies from `stark_pool_registry`. The registry is the source of truth. The pool state tables are serving tables.

Nullable taxonomy fields:

- `factory_address` applies to factory-created pair or pool contracts. It is normally `NULL` for singleton pool systems like Ekubo.
- `stable_flag` applies to stable/volatile AMM families. It is normally `NULL` for Ekubo CLMM pools because the model is not a stable-vs-volatile pair contract.
- Ekubo state rows should use `liquidity`, `sqrt_ratio`, `tick_after`, `tick_spacing`, and `fee_tier`; `reserve0` and `reserve1` are for reserve-based pool snapshots.

## Resolver Precedence

`core/pool-discovery.js` resolves taxonomy in this order:

1. Static registry match by address
2. Static registry match by class hash
3. RPC interface probing
4. History-derived hints
5. Candidate-only unresolved row

### Static Registry

Source: `lib/registry/dex-registry.js`

Used for:

- verified protocol address matches
- verified class hash matches
- known factory metadata

### Class Hash Probe

If address matching misses, the resolver asks Starknet RPC for `getClassHashAt(...)` and re-checks the static registry by class hash.

This is the strongest dynamic identification path short of a direct address match.

### Interface Fingerprinting

If the class hash is still unknown, the resolver probes lightweight read entrypoints:

- `factory`
- `stable` / `is_stable`
- `get_reserves` / `getReserves`
- `get_pool` for Ekubo-style singleton pools

Interpretation:

- `get_reserves` success strongly suggests `xyk`
- `stable` / `is_stable` on SithSwap-style factories points to `solidly_stable` or `solidly_volatile`
- `get_pool` success on an Ekubo pool key identifies `clmm` + `singleton_clmm`

### History Hints

If RPC probing still does not fully classify the pool, the system can still seed a usable hint from normalized action metadata:

- `pool_model`
- `protocol`
- `stable`

This is stored with lower confidence until a stronger path confirms it.

## Confidence Levels

`confidence_level` is mandatory in the registry.

Ordered from weakest to strongest:

- `candidate`
- `history_hint`
- `low_rpc_probe`
- `verified_class_hash`
- `verified_static_registry`

Upserts preserve the strongest known answer.

## Golden Mapping

Current hardcoded mappings:

- JediSwap V1 -> `pool_family=xyk`, `pool_model=xyk`
- 10KSwap -> `pool_family=xyk`, `pool_model=xyk`
- JediSwap V2 -> `pool_family=clmm`, `pool_model=clmm`
- Ekubo -> `pool_family=clmm`, `pool_model=singleton_clmm`
- SithSwap stable -> `pool_family=solidly`, `pool_model=solidly_stable`
- SithSwap volatile -> `pool_family=solidly`, `pool_model=solidly_volatile`
- mySwap V1 -> `pool_family=fixed_pool`, `pool_model=fixed_pool`
- Haiko market -> `pool_family=market_manager`, `pool_model=haiko`
- Haiko multiswap summary -> `pool_family=market_manager`, `pool_model=haiko_multiswap`

Routers and aggregators are not pools:

- AVNU must stay router / aggregator only
- Fibrous must stay router / aggregator only

## Backfill

`jobs/backfill-pool-taxonomy.js` runs the backfill and the live discovery pass.

Flow:

1. seed unresolved candidates from `stark_pool_latest` and `stark_action_norm`
2. resolve unresolved registry rows through the resolver
3. sync resolved taxonomy back into `stark_pool_state_history`
4. sync resolved taxonomy back into `stark_pool_latest`
5. run validation counts

The registry is filled first. The materialized tables are updated second.

## Runtime Discovery

`core/pool-state.js` does not block indexing on discovery.

When a pool snapshot is created:

- the pool snapshot gets the best available taxonomy hint immediately
- if the registry is missing or weak, a candidate row is upserted into `stark_pool_registry`
- the discovery worker resolves it later

This means indexing stays hot while taxonomy catches up asynchronously.

## Trade Metadata

`jobs/trade-chaining.js` now stamps pool taxonomy onto trade metadata during late-binding enrichment:

- `pool_protocol`
- `pool_family`
- `pool_model`
- `pool_confidence_level`

This does not replace the canonical join path through `stark_pool_latest`. It adds forensic context onto the trade rows that were chained together.

## Validation

The validation pass checks:

- null `pool_family` rows in `stark_pool_latest`
- null `pool_family` rows in `stark_pool_state_history`
- aggregator leaks inside `stark_pool_registry`
- whether `stark_trades` can join to `stark_pool_latest` for `pool_family = 'clmm'`

Useful query:

```sql
SELECT COUNT(*)
FROM stark_trades AS trade
JOIN stark_pool_latest AS pool
  ON pool.lane = trade.lane
 AND pool.pool_id = trade.pool_id
WHERE pool.pool_family = 'clmm';
```

## Operational Notes

- Apply `sql/0013_pool_taxonomy_registry.sql` before starting the worker.
- Start the worker with `npm run start:pool-taxonomy`.
- The Phase 4 grouped launcher also starts it.
- Finality replay must preserve `pool_family` and `pool_model` when rebuilding `stark_pool_latest`.
