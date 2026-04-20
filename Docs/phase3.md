# StarknetDeg Phase 3

Date: April 10, 2026  
Scope: Simple English explanation of the refined Phase 3 design, including the schema-enhancement pass that fixed AVNU route contamination, added a central token registry, and made price and OHLCV rows carry their own quality signals.

## 1. What Phase 3 Does

Phase 3 is the layer that turns normalized swap actions into market data.

In plain words:

- Phase 2 tells us a Starknet receipt contained a swap
- Phase 3 turns that into:
  - a trade row
  - pool state rows
  - price ticks
  - latest token prices
  - 1-minute candles

That is the main job of this phase.

One more thing changed after the registry-driven Phase 2 upgrade:

- Phase 3 no longer assumes swaps only come from Ekubo or one Jedi-style path
- it now consumes a normalized multi-DEX swap stream
- that stream can include Ekubo, AVNU, JediSwap V1, JediSwap V2, 10KSwap, mySwap V1, SithSwap, and Haiko when Phase 2 classifies them

## 2. What Was Wrong In The Older Phase 3

The earlier Phase 3 worked, but it still had some weak spots:

- latest price rows did not explicitly tell us whether the reference anchor was stale
- pool state was stored in one latest-only table, so intermediate updates inside multicalls were lost
- candle updates rebuilt touched buckets from `stark_trades` every time, which was safe but inefficient
- price bridging was still too simple for real market data
- CMC fallback did not exist yet

So this refinement was about one thing:

make Phase 3 more trustworthy without making it fragile.

## 3. The Main Refinements

The refined Phase 3 now does five important things:

1. price rows explicitly track freshness
2. pool state is split into history and latest
3. candles update incrementally by default
4. USD price resolution can bridge up to 2 hops, but only across sufficiently liquid pools
5. CoinMarketCap can provide a bounded fallback price for important anchor assets

The latest bug-fix pass added four more important rules:

1. a central `tokens` table is now the shared token source for decimals and stable-token identity
2. AVNU multi-hop actions are grouped into route-aware trade materialization instead of being treated as random independent swaps
3. price candidates carry `hops_from_stable`, `price_raw_execution`, and `price_deviation_pct`
4. OHLCV and price tables now filter out unstable or aggregator-derived price rows unless explicitly allowed

These are not cosmetic changes.  
They change how safe the data is.

## 4. High-Level Flow Now

The refined flow is:

1. Phase 2 writes normalized swap actions
2. `core/trades.js` converts those swaps into `stark_trades`
3. the same trade pass builds price candidates
4. some prices come from direct stable pools
5. some prices come from 1-hop or 2-hop path resolution
6. some anchor prices can come from CMC when allowed
7. `core/pool-state.js` writes every snapshot into history and also advances the fast latest table
8. `core/prices.js` writes price ticks and latest prices, including stale flags
9. `core/ohlcv.js` updates candles incrementally unless reconciliation is active
10. after commit, realtime trade and candle payloads are published

One important refinement in that flow:

- if a transaction contains an AVNU aggregator event and underlying venue swaps
- Phase 2 marks the underlying venue swaps as `is_route_leg = true`
- Phase 3 skips those route-leg swaps in `stark_trades`
- but pool state can still use the underlying venue evidence

That prevents volume double counting without throwing away execution truth.

The newer version is stricter than that.

It does not only skip route legs.

It also tries to group linked AVNU hops into one route summary using:

- `is_multi_hop`
- `hop_index`
- `total_hops`
- `route_group_key`

That matters because the contamination bug came from letting route internals leak into user-facing trade and price tables.

## 5. Very Important Rules In The New Phase 3

### 5.1 BigInt First, SQL Numeric Later

Nothing changed here.  
This is still a hard rule.

All chain-derived values are handled in JavaScript as `BigInt` first, then converted into SQL `NUMERIC` strings.

Why?

Because Starknet amounts and felt-based quantities are too large for JavaScript `Number`.

If we ignored this:

- prices would drift
- trade sizes would be wrong
- candle volume would become unreliable

### 5.1.1 One Token Registry, Not Three Token Truths

This is one of the most important schema changes in the refinement pass.

We now have a shared `tokens` table.

Why that matters:

- transfer validation needs token trust
- trade pricing needs decimals and stable-token identity
- metadata refresh needs one place to sync enriched token facts

Before this table existed, those answers were split across static caches and enrichment tables.

That is exactly how alternate stable-token addresses can slip through and create absurd prices.

Now the pricing path, transfer trust path, and metadata path all ask the same registry first.

### 5.2 Latest Tables Must Be Restorable

This is one of the biggest improvements.

Earlier, latest tables were just "whatever was written last."

Now the code treats them more carefully.

Examples:

- `stark_pool_latest` is restored from `stark_pool_state_history` if a current block is reset
- `stark_prices` is restored from `stark_price_ticks` if a current block is reset

Why this matters:

If a block at the current height is replayed or orphaned, we do not want to leave stale "latest" rows behind.

### 5.3 Pool History And Pool Latest Are Different Things

This is a key conceptual change.

We now have:

- `stark_pool_state_history`
- `stark_pool_latest`

`stark_pool_state_history` is append-only.

That means:

- every reserve change
- every liquidity change
- every price snapshot we choose to record

gets its own row.

`stark_pool_latest` is only the fast access table.

This matters even more now because pool-state truth may come from multiple venue families:

- XYK / pair-based protocols through `sync`
- Ekubo through swap-derived price state
- Haiko through market-manager swap state

That means:

- it is the current answer for APIs
- but it is not the full history

If we kept only the latest table:

- multicall intermediate states would disappear
- debugging price behavior would be harder
- replay recovery would be weaker

### 5.4 Price Freshness Must Be Visible

`stark_prices` and `stark_price_ticks` now carry:

- `price_is_stale`
- `price_updated_at_block`
- `hops_from_stable`
- `is_aggregator_derived`
- `sell_amount_raw`
- `buy_amount_raw`
- `price_raw_execution`
- `price_deviation_pct`

This means every stored price tells us:

- whether the anchor behind it was still fresh enough
- at which block that anchor was last updated

Why this matters:

Suppose token A is priced through STRK, but STRK has not been refreshed for many blocks.

Without freshness tracking:

- token A would still look like a healthy price

Now:

- the derived price can be marked stale
- downstream consumers can decide how much to trust it

This is now part of a broader stability filter.

The system does not only ask whether the anchor is fresh.

It also asks:

- how many hops away from a stable token this price is
- whether the observation came from an aggregator-derived route summary
- how far the raw execution price drifted from the final normalized price

That is why the price tables now carry both freshness fields and execution-quality fields.

One important detail changed in the latest refinement:

- direct stable pricing is now counted as `0` hops
- one intermediate bridge asset is `1` hop
- two intermediate bridge assets are `2` hops

Example:

- `TOKEN -> ETH -> WBTC -> USDC` is stored as `2` hops from stable

That matters because prices more than one intermediate bridge away from a stable anchor are now marked `low_confidence`.

### 5.5 Bridge Paths Must Respect Liquidity

This is another important integrity rule.

The new price path resolver can bridge up to 2 hops, for example:

- Token A -> STRK
- Token A -> ETH -> USDC

In the newer hop-distance language that becomes:

- Token A -> STRK -> USDC = `1` hop from stable
- Token A -> ETH -> WBTC -> USDC = `2` hops from stable

If the resolved distance is greater than `1`, the stored price is flagged low confidence.

The enhancement pass made the resolver return route quality too, not only the final valuation.

So the caller now knows:

- the resolved USD value
- how many hops away from a stable anchor that value came from

But it does **not** blindly trust every available bridge.

It only traverses edges whose pool liquidity depth passes the configured threshold.

Right now this threshold is read from:

- `PHASE3_MIN_PATH_LIQUIDITY_USD`

Why this matters:

If we allow tiny illiquid pools to define bridge prices:

- manipulated pools can poison derived USD values

So the resolver is intentionally conservative.

### 5.6 CMC Is A Fallback, Not The Canonical Source

CMC support now exists, but it is not the primary truth source.

The order of trust is:

1. direct stable pricing from actual on-chain swaps
2. on-chain bridge pricing through liquid paths
3. CMC fallback for allowed anchor symbols

This is important.

CMC is useful for:

- STRK
- ETH
- WBTC
- other approved anchors

But it is still external.

So we use it to improve coverage, not to replace on-chain market structure.

## 6. Files Added Or Updated In This Refinement

These are the important files in the refined Phase 3:

1. `sql/003_trading.sql`
2. `sql/007_schema_enhancements.sql`
3. `core/trades.js`
4. `core/pool-state.js`
5. `core/prices.js`
6. `core/ohlcv.js`
7. `core/token-registry.js`
8. `core/token-trust-cache.js`
9. `core/normalize.js`
10. `core/block-processor.js`
11. `core/checkpoint.js`
12. `lib/cairo/fixed-point.js`
13. `lib/cmc.js`
14. `bin/start-indexer.js`
15. `.env`

## 7. File-By-File Explanation

### 7.1 `sql/003_trading.sql`

This file now does more than the earlier version.

It now:

- keeps `stark_trades`
- creates `stark_pool_state_history`
- creates `stark_pool_latest`
- keeps `stark_prices`
- keeps `stark_price_ticks`
- keeps `stark_ohlcv_1m`
- adds stale-price columns to the price tables
- backfills newer structures from older pool data if needed

Why this matters:

This migration now supports both:

- fresh setup
- existing database upgrade

without requiring destructive reset.

### 7.1.1 `sql/007_schema_enhancements.sql`

This is the report-driven schema patch.

It adds the columns that the older trading schema did not have:

- Ekubo execution detail fields like `sqrt_ratio_after`, `tick_after`, `liquidity_after`, `fee_tier`, and `locker_address`
- route-group fields like `is_multi_hop`, `hop_index`, `total_hops`, and `route_group_key`
- price-quality fields like `price_raw_execution`, `price_deviation_pct`, and `hops_from_stable`
- richer pool-state columns
- richer transfer columns
- the new shared `tokens` table

This migration matters because the report did not only ask for code fixes.

It asked for the schema to carry the evidence needed to explain and debug those fixes later.

### 7.2 `core/trades.js`

This file is now much smarter than before.

It still turns normalized swaps into trades, but now it also builds a stronger price context.

It now does these things:

1. loads swap actions
2. groups AVNU route hops when they clearly belong to one route
3. loads latest known price references
4. seeds stable tokens as `$1`
5. loads token truth from the shared `tokens` table
6. optionally fetches CMC prices for allowed anchor symbols
7. loads bridgeable pool edges from `stark_pool_latest`
8. resolves token USD value using:
   - direct stable price
   - liquid path resolution
   - CMC anchor fallback
9. computes price-quality fields like raw execution price and price deviation
10. writes the trade row
11. emits price candidates for the next pricing stage

Why this matters:

Earlier the pricing logic was mostly:

- direct stable
- or one simple latest-price bridge

Now it is explicit, path-aware, freshness-aware, and route-aware.

This is also where the AVNU contamination fix really becomes visible.

If we let every hop flow straight into `stark_trades`, one routed user intent can look like multiple unrelated trades.

That can inflate:

- trade count
- volume
- price candidate count
- candle notional

This file also now resolves human-readable router attribution from Ekubo locker addresses.

That means if an Ekubo execution came through a known locker owned by:

- AVNU
- Haiko
- Fibrous

the final `stark_trades.router_protocol` row stores that readable router name instead of leaving only the raw locker address behind.

### 7.3 `core/pool-state.js`

This file now writes to two tables instead of one.

It does two jobs:

1. append every snapshot to `stark_pool_state_history`
2. advance `stark_pool_latest`

It also exports reset logic so the block processor can safely recover latest pool rows after replay.

This is one of the most important integrity changes in the refinement.

Why?

Because latest state is not enough for serious indexer work.

We need both:

- full event-time history
- fast current-state lookup

### 7.4 `core/prices.js`

This file now has three big improvements:

1. it writes stale flags
2. it writes `price_updated_at_block`
3. it writes route-quality fields like `hops_from_stable`, `price_raw_execution`, and `price_deviation_pct`
4. it can restore `stark_prices` from `stark_price_ticks` when a current block is reset

In simple words:

- `stark_price_ticks` is now the durable history
- `stark_prices` is the fast current-state layer
- `core/prices.js` keeps them consistent

Without this:

- a replayed block could leave the latest price table in a misleading state

It also now drops price candidates that fail the stability filter.

That means:

- aggregator-derived route summaries do not automatically become public price truth
- prices that are too far from stable anchors can be kept out of price tables
- prices more than one intermediate bridge away from stable are marked `low_confidence`
- weak prices can stay in historical ticks for forensics without becoming the latest public price

This is one of the direct fixes for the "billion-dollar price" problem from the report.

### 7.5 `core/ohlcv.js`

This file changed its strategy.

Earlier:

- touched candles were rebuilt from `stark_trades`

Now:

- candles are updated incrementally by default
- a full rebuild is only used when reconciliation is active
- only candle-eligible trades are included

That means:

- normal indexing becomes cheaper
- rollback-sensitive situations still get the safer rebuild path

This file also checks `stark_reconciliation_log` when the caller does not explicitly tell it whether reconciliation is active.

Why this matters:

It improves performance without giving up rollback safety.

It also now carries richer market detail on the candle rows:

- `tick_open`
- `tick_close`
- `sqrt_ratio_open`
- `sqrt_ratio_close`
- `fee_tier_bps`
- `tick_spacing`
- `volume0_usd`
- `volume1_usd`
- `vwap`

That means OHLCV is no longer only "price plus one volume number".

It now preserves more of the market state needed to debug mismatches.

This is important because the report's OHLCV discrepancy was not just a UI problem.

It was a data-lineage problem.

The fix is:

- carry better trade detail forward
- filter unstable trade rows out
- store more candle evidence so later debugging is possible
- rebuild candle volume from canonical signed `amount0_delta` and `amount1_delta`

That last point is the important bug fix.

The DAI/USDC mismatch in the report was a single-trade `incremental_new` candle, not an `incremental_append` problem.

So the bug was not "we forgot one trade".

The bug class was:

- candle volume trusted cached trade volume fields
- instead of recomputing candle volume from the canonical signed deltas that came from the decoded swap

The newer `core/ohlcv.js` now uses canonical deltas in both:

- the incremental path
- the rebuild path

### 7.6 `core/block-processor.js`

This file now understands the refined latest/history model.

When a block is replayed, it no longer just clears simple derived rows.

It now also:

- resets latest prices using their historical ticks
- resets latest pool rows using pool-state history

That makes the Phase 3 reset path much safer.

### 7.7 `core/token-registry.js`

This is the shared token-identity layer introduced by the enhancement pass.

It seeds and reads the `tokens` table.

That table now gives the rest of the pipeline one shared answer for:

- symbol
- decimals
- stable-token status
- verification status

Without this file, pricing and transfer trust would still be using different ideas of what a token is.

### 7.8 `core/checkpoint.js`

This file now validates the new Phase 3 table set:

- `stark_pool_state_history`
- `stark_pool_latest`

instead of only the older single pool-state table.

### 7.9 `core/token-trust-cache.js`

This file now uses the shared token registry when deciding whether a token should be trusted.

That matters because transfer promotion and later pricing must agree on whether a token is real and verified enough to use.

### 7.10 `lib/cairo/fixed-point.js`

This file is still the fixed-point math layer, but now it also contains the price path resolver.

That resolver:

- walks up to 2 hops
- multiplies path rates safely in fixed-point
- rejects paths whose liquidity depth is too low
- prefers fresher and simpler paths

This is the main reason the refined price logic stayed clean instead of becoming random custom code inside `core/trades.js`.

### 7.11 `lib/cmc.js`

This is the new CoinMarketCap client.

It:

- reads `CMC_API_KEY` from `.env`
- batches symbol requests
- caches quote results in memory for a short TTL
- returns fixed-point USD prices

Why this file exists:

CMC access should be isolated from the core pricing code.

That keeps the on-chain path logic and the external fallback logic separate.

### 7.12 `bin/start-indexer.js`

This file now logs the refined Phase 3 counters too.

The commit log now has more useful detail, including:

- stale price count
- pool history count
- pool latest count

### 7.13 `.env`

The StarknetDeg `.env` file now includes Phase 3 pricing controls, for example:

- `PHASE3_PRICE_STALE_AFTER_BLOCKS`
- `PHASE3_MIN_PATH_LIQUIDITY_USD`
- `PHASE3_BRIDGE_SYMBOLS`
- `CMC_API_KEY`
- `CMC_ALLOWED_SYMBOLS`
- `CMC_CACHE_TTL_MS`

Important note:

I added these to `StarknetDeg/.env`, not `Degenter/.env`, to respect the earlier rule that `Degenter` must not be modified.

## 8. Tables In The Refined Phase 3

The refined Phase 3 uses these main tables:

1. `stark_trades`
2. `stark_pool_state_history`
3. `stark_pool_latest`
4. `stark_prices`
5. `stark_price_ticks`
6. `stark_ohlcv_1m`

## 9. Table Explanation In Simple English

### 9.1 `stark_trades`

This is still the dedicated trade table.

It stores:

- one materialized trade per normalized swap event
- explicit direction
- explicit price fields
- optional USD notional

Important columns:

- `trade_key`
- `lane`
- `block_number`
- `block_hash`
- `block_timestamp`
- `transaction_hash`
- `transaction_index`
- `source_event_index`
- `protocol`
- `router_protocol`
- `execution_protocol`
- `pool_id`
- `trader_address`
- `token0_address`
- `token1_address`
- `token_in_address`
- `token_out_address`
- `amount0_delta`
- `amount1_delta`
- `volume_token0`
- `volume_token1`
- `amount_in`
- `amount_out`
- `price_*`
- `notional_usd`
- `bucket_1m`
- `locker_address`
- `liquidity_after`
- `sqrt_ratio_after`
- `tick_after`
- `tick_spacing`
- `fee_tier`
- `extension_address`
- `is_multi_hop`
- `hop_index`
- `total_hops`
- `route_group_key`
- `price_raw_execution`
- `price_deviation_pct`
- `hops_from_stable`
- `is_aggregator_derived`
- `metadata`

Important meaning changes:

- `router_protocol` is now the human-readable router name when we can resolve the Ekubo locker, for example `AVNU`, `Haiko`, or `Fibrous`
- `sqrt_ratio_after` is stored as high-precision numeric state, not float-like market data
- `hops_from_stable` counts intermediate bridge assets, so direct stable is `0`, one bridge is `1`, and two bridges are `2`
- `hops_from_stable` is a pricing-path metric, not the same thing as route `hop_index` or `total_hops`; a multi-hop route can still have `hops_from_stable = 0` when valuation is directly anchored to a stable token
- `is_aggregator_derived` is true for aggregator summary rows, while direct venue legs stay false

### 9.2 `stark_pool_state_history`

This is the new append-only pool state history table.

Every derived pool snapshot is stored here.

Important columns:

- `pool_state_key`
- `lane`
- `pool_id`
- `protocol`
- `token0_address`
- `token1_address`
- `block_number`
- `block_hash`
- `block_timestamp`
- `transaction_hash`
- `transaction_index`
- `source_event_index`
- `reserve0`
- `reserve1`
- `liquidity`
- `sqrt_ratio`
- `price_token1_per_token0`
- `price_token0_per_token1`
- `price_is_decimals_normalized`
- `tvl_usd`
- `snapshot_kind`
- `tick_after`
- `tick_spacing`
- `fee_tier`
- `extension_address`
- `locker_address`
- `amount0_delta`
- `amount1_delta`
- `metadata`

This table exists so we do not lose intermediate states.

Pool model note:

- `reserve0` and `reserve1` are populated by reserve-based snapshots, for example XYK `Sync` events.
- Ekubo rows are CLMM swap snapshots, so their state is carried by `liquidity`, `sqrt_ratio`, `tick_after`, `tick_spacing`, `fee_tier`, and signed deltas.
- `tvl_usd` needs reserve-style balances plus usable token USD prices. It can stay `NULL` for Ekubo CLMM swap snapshots.

### 9.3 `stark_pool_latest`

This is the fast latest-state table for pools.

It stores only the current visible snapshot per pool and lane.

Important columns are almost the same as the history table, but the primary key is:

- `(lane, pool_id)`

This is the table later APIs should use for fast current state.

### 9.4 `stark_prices`

This is the latest price table.

It now stores freshness explicitly.

Important columns:

- `lane`
- `token_address`
- `block_number`
- `block_hash`
- `block_timestamp`
- `transaction_hash`
- `transaction_index`
- `source_event_index`
- `source_pool_id`
- `quote_token_address`
- `price_quote`
- `price_usd`
- `price_source`
- `price_is_stale`
- `price_updated_at_block`
- `metadata`

Two important new columns are:

- `price_is_stale`
- `price_updated_at_block`

The enhancement pass also added:

- `bucket_1m`
- `hops_from_stable`
- `is_aggregator_derived`
- `sell_amount_raw`
- `buy_amount_raw`
- `price_raw_execution`
- `price_deviation_pct`
- `low_confidence`

These tell us whether the price should still be trusted.

Operational interpretation:

- stable-token rows are intentionally stored at `price_usd = 1`
- `hops_from_stable = 0` means direct stable-anchor valuation
- aggregator-derived price candidates are filtered from price tables by default, so `is_aggregator_derived` is normally `false` in `stark_prices`
- CMC/external anchor rows can have `hops_from_stable = NULL` because they did not use an on-chain stable path

### 9.5 `stark_price_ticks`

This is the historical price table.

It now also stores freshness information.

Important columns:

- `tick_key`
- `lane`
- `block_number`
- `block_hash`
- `block_timestamp`
- `transaction_hash`
- `transaction_index`
- `source_event_index`
- `token_address`
- `source_pool_id`
- `quote_token_address`
- `price_quote`
- `price_usd`
- `price_source`
- `price_is_stale`
- `price_updated_at_block`
- `bucket_1m`
- `hops_from_stable`
- `is_aggregator_derived`
- `sell_amount_raw`
- `buy_amount_raw`
- `price_raw_execution`
- `price_deviation_pct`
- `low_confidence`
- `metadata`

This is the durable history behind `stark_prices`.

The same price-quality interpretation applies here. Most on-chain direct-stable ticks have `hops_from_stable = 0`; only stale or externally anchored rows should differ.

### 9.6 `stark_ohlcv_1m`

This is still the 1-minute candle table.

But the way we update it is now different.

Important columns:

- `candle_key`
- `lane`
- `pool_id`
- `protocol`
- `token0_address`
- `token1_address`
- `bucket_start`
- `block_number`
- `block_hash`
- `transaction_hash`
- `transaction_index`
- `source_event_index`
- `open`
- `high`
- `low`
- `close`
- `price_is_decimals_normalized`
- `volume0`
- `volume1`
- `volume_usd`
- `trade_count`
- `seeded_from_previous_close`
- `tick_open`
- `tick_close`
- `sqrt_ratio_open`
- `sqrt_ratio_close`
- `fee_tier_bps`
- `tick_spacing`
- `volume0_usd`
- `volume1_usd`
- `vwap`
- `metadata`

The table structure is similar, but the persistence strategy is better now.

The important integrity rule is:

- candle volume is now reconstructed from canonical signed swap deltas
- not blindly reused from cached trade-volume fields

## 10. How Price Resolution Works Now

The new price logic follows a clear order.

### 10.1 Direct Stable First

If a trade is directly against:

- USDC
- USDT
- DAI

then that is the best on-chain anchor.

That price is:

- immediate
- fresh
- not stale

### 10.2 Then Liquid Bridge Paths

If direct stable is not available, the resolver tries graph paths up to 2 hops.

Examples:

- token -> STRK
- token -> ETH -> USDC

But only if the bridge edges pass the configured liquidity threshold.

### 10.3 Then CMC Anchor Fallback

If a known anchor token such as STRK or ETH needs help, CMC can provide:

- a current USD anchor price

This improves coverage for:

- notional calculation
- price ticks
- latest anchor price rows

without making CMC the canonical market source.

## 11. How Price Staleness Works

The staleness logic is block-based.

The config is:

- `PHASE3_PRICE_STALE_AFTER_BLOCKS`

If a derived price depends on an anchor that has not been updated within that many blocks:

- `price_is_stale = true`

The related `price_updated_at_block` tells us when that anchor was last refreshed.

That gives downstream code a clear signal instead of forcing it to guess.

## 12. How Candles Work Now

The old Phase 3 candle logic rebuilt touched buckets from `stark_trades` every time.

That was safe, but expensive.

Now the default behavior is:

- load the existing candle if it already exists
- append current block trade data into it
- update close / high / low / volume incrementally

Only when reconciliation is active do we switch back to:

- full rebuild from `stark_trades`

That means:

- normal operation is faster
- replay-sensitive operation is still safe

## 13. What Was Verified

This refinement was not left untested.

The following checks were run:

1. `npm run check:syntax`
2. Phase 3 SQL migration reapplied successfully on the existing DB
3. live rollback-only dry run on block `8410799`
4. replay-style synthetic test for:
   - `resetLatestPricesForBlock`
   - `resetPoolStateForBlock`
5. live CMC API key validation against `quotes/latest`

The live block dry run confirmed:

- `9` trades
- `9` pool history rows
- `6` pool latest rows
- `14` price candidates
- `14` price ticks
- `0` stale prices on that test block
- `6` incrementally updated candles

The replay-style synthetic test confirmed:

- latest price rows correctly restore from older price ticks
- latest pool rows correctly restore from older pool-state history

## 14. Known Limitation

The new AVNU route grouping is intentionally conservative.

If a grouped AVNU route starts and ends in the same token, the grouped summary can become non-directional.

In that case, the route is currently suppressed from `stark_trades` instead of being materialized as a normal trade row.

This is safer than letting a route loop poison prices or volume, but it is still a limitation worth knowing.

## 15. Final Summary

The refined Phase 3 is stronger than the original version in three major ways:

1. it keeps more history
2. it makes price trust explicit
3. it reduces wasted work during normal indexing

The most important outcomes are:

- pool state no longer loses intermediate changes
- latest rows are restorable
- derived prices can be marked stale
- bridge pricing is liquidity-aware
- CMC is available as a bounded fallback
- candles are incremental by default and rebuild only when necessary
- route-leg swaps do not double count AVNU volume
- Phase 3 can consume a wider Starknet DEX universe without changing its trade schema

That gives StarknetDeg a better foundation for Phase 4 enrichment and later analytics.
