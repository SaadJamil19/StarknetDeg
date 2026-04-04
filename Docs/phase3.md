# StarknetDeg Phase 3

Date: April 4, 2026  
Scope: Simple English explanation of the refined Phase 3 design, what changed in the code, why it was changed, and how price integrity works now.

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

### 5.5 Bridge Paths Must Respect Liquidity

This is another important integrity rule.

The new price path resolver can bridge up to 2 hops, for example:

- Token A -> STRK
- Token A -> ETH -> USDC

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
2. `core/trades.js`
3. `core/pool-state.js`
4. `core/prices.js`
5. `core/ohlcv.js`
6. `core/block-processor.js`
7. `core/checkpoint.js`
8. `core/known-erc20-cache.js`
9. `lib/cairo/fixed-point.js`
10. `lib/cmc.js`
11. `bin/start-indexer.js`
12. `.env`

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

### 7.2 `core/trades.js`

This file is now much smarter than before.

It still turns normalized swaps into trades, but now it also builds a stronger price context.

It now does these things:

1. loads swap actions
2. loads latest known price references
3. seeds stable tokens as `$1`
4. optionally fetches CMC prices for allowed anchor symbols
5. loads bridgeable pool edges from `stark_pool_latest`
6. resolves token USD value using:
   - direct stable price
   - liquid path resolution
   - CMC anchor fallback
7. writes the trade row
8. emits price candidates for the next pricing stage

Why this matters:

Earlier the pricing logic was mostly:

- direct stable
- or one simple latest-price bridge

Now it is explicit, path-aware, and freshness-aware.

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
3. it can restore `stark_prices` from `stark_price_ticks` when a current block is reset

In simple words:

- `stark_price_ticks` is now the durable history
- `stark_prices` is the fast current-state layer
- `core/prices.js` keeps them consistent

Without this:

- a replayed block could leave the latest price table in a misleading state

### 7.5 `core/ohlcv.js`

This file changed its strategy.

Earlier:

- touched candles were rebuilt from `stark_trades`

Now:

- candles are updated incrementally by default
- a full rebuild is only used when reconciliation is active

That means:

- normal indexing becomes cheaper
- rollback-sensitive situations still get the safer rebuild path

This file also checks `stark_reconciliation_log` when the caller does not explicitly tell it whether reconciliation is active.

Why this matters:

It improves performance without giving up rollback safety.

### 7.6 `core/block-processor.js`

This file now understands the refined latest/history model.

When a block is replayed, it no longer just clears simple derived rows.

It now also:

- resets latest prices using their historical ticks
- resets latest pool rows using pool-state history

That makes the Phase 3 reset path much safer.

### 7.7 `core/checkpoint.js`

This file now validates the new Phase 3 table set:

- `stark_pool_state_history`
- `stark_pool_latest`

instead of only the older single pool-state table.

### 7.8 `core/known-erc20-cache.js`

This file was expanded so price logic can do better token lookups.

It now supports:

- `getAllTokens()`
- `findBySymbol(symbol)`

That is useful for:

- bridge symbol sets
- CMC symbol selection

### 7.9 `lib/cairo/fixed-point.js`

This file is still the fixed-point math layer, but now it also contains the price path resolver.

That resolver:

- walks up to 2 hops
- multiplies path rates safely in fixed-point
- rejects paths whose liquidity depth is too low
- prefers fresher and simpler paths

This is the main reason the refined price logic stayed clean instead of becoming random custom code inside `core/trades.js`.

### 7.10 `lib/cmc.js`

This is the new CoinMarketCap client.

It:

- reads `CMC_API_KEY` from `.env`
- batches symbol requests
- caches quote results in memory for a short TTL
- returns fixed-point USD prices

Why this file exists:

CMC access should be isolated from the core pricing code.

That keeps the on-chain path logic and the external fallback logic separate.

### 7.11 `bin/start-indexer.js`

This file now logs the refined Phase 3 counters too.

The commit log now has more useful detail, including:

- stale price count
- pool history count
- pool latest count

### 7.12 `.env`

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
- `metadata`

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
- `metadata`

This table exists so we do not lose intermediate states.

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

These tell us whether the price should still be trusted.

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
- `metadata`

This is the durable history behind `stark_prices`.

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
- `metadata`

The table structure is similar, but the persistence strategy is better now.

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

## 14. Final Summary

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

That gives StarknetDeg a better foundation for Phase 4 enrichment and later analytics.
