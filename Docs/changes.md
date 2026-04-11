# StarknetDeg Changes

Date: April 10, 2026

This file lists the report-driven schema enhancement and bug-fix changes in simple language.

## What I analyzed before coding

- I traced the full Starknet indexing flow from RPC fetch to raw tables, normalized actions, trades, prices, candles, and analytics.
- I checked how Ekubo swaps are decoded and how AVNU swaps are routed.
- I verified the AVNU contamination problem by tracing how multi-hop aggregator flows can create bad price rows if every hop is treated like an independent public trade.
- I traced the OHLCV mismatch problem and confirmed that candle mismatch was mainly an upstream trade-quality problem, not just a candle math problem.
- I mapped the data flow for the report's critical items before changing schema or code.

## New schema work

- Added a new migration: `sql/007_schema_enhancements.sql`.
- Added a new shared `tokens` table to act as the central token registry.
- Extended `stark_trades` with locker, route-group, and price-quality fields.
- Extended `stark_pool_state_history` and `stark_pool_latest` with richer Ekubo and swap-state fields.
- Extended `stark_price_ticks` and `stark_prices` with stability and deviation fields.
- Extended `stark_ohlcv_1m` with richer tick, sqrt-ratio, fee, and VWAP fields.
- Extended `stark_transfers` with human amount, USD amount, and token identity fields.

## Token-registry changes

- Added `core/token-registry.js`.
- Added startup seeding for important known tokens.
- Synced token metadata into the shared `tokens` table.
- Made stable-token checks use the shared token registry instead of scattered local checks.
- Made transfer trust and price logic use the same token truth.

## Phase 2 decoder changes

- Refined `core/event-router.js` so AVNU swap context is tracked more carefully.
- Improved router-context handling so only real AVNU route candidates are marked as multi-hop.
- Added better router attribution from Ekubo locker data when available.
- Refined `core/protocols/ekubo.js` to carry forward `locker_address`, `fee_tier`, `tick_spacing`, and `extension_address`.
- Refined `core/protocols/erc20.js` so transfer rows carry richer token facts.
- Updated token-trust logic to use the shared token registry.

## Phase 3 trade and price changes

- Refined `core/trades.js` to group AVNU route hops into route-aware materialization.
- Added `route_group_key`, `is_multi_hop`, `hop_index`, and `total_hops` logic.
- Added `price_raw_execution`, `price_deviation_pct`, and `hops_from_stable` logic.
- Made trade valuation use the shared token registry.
- Added a stability filter so bad or weak price candidates do not automatically enter public price tables.
- Kept aggregator-derived observations out of price tables unless explicitly allowed by config.

## Pool-state and OHLCV changes

- Refined `core/pool-state.js` to carry richer Ekubo and swap evidence into pool history and pool latest.
- Refined `core/ohlcv.js` so candle rows carry more market evidence like ticks, sqrt ratios, fee tier, and VWAP.
- Made OHLCV use only candle-eligible trades, so unstable route-derived trades do not contaminate candles.

## Metadata and enrichment changes

- Refined `jobs/meta-refresher.js` so enriched token data also updates the shared `tokens` table.
- Kept the earlier metadata race-condition handling and made it consistent with the token registry.

## Startup and schema validation changes

- Refined `bin/start-indexer.js` to seed the shared token registry on startup.
- Refined `core/checkpoint.js` to assert the new schema-enhancement tables and columns.

## Bug fixes

- Fixed the stable-token identity problem that let alternate stable addresses miss stable classification.
- Fixed the pricing path so route quality and stable distance are visible in the stored rows.
- Fixed the main cause of AVNU route contamination by adding route-aware trade grouping and price filtering.
- Fixed the schema/documentation drift by updating the docs to match the migrated database.

## Docs updated

- Updated `Docs/roadmap.md`.
- Updated `Docs/phase2.md`.
- Updated `Docs/phase3.md`.
- Updated `Docs/phase4_metadata.md`.
- Updated `Docs/db.md`.
- Added this file: `Docs/changes.md`.

## Changes2

- Added locker-to-protocol mapping so known Ekubo lockers are now resolved to human-readable router names like `AVNU`, `Haiko`, and `Fibrous`.
- Updated trade materialization so `stark_trades.router_protocol` now stores that resolved human-readable router name instead of only a raw protocol key or hex-only locker context.
- Verified `sqrt_ratio_after` precision in `sql/007_schema_enhancements.sql`. It is stored as high-precision `NUMERIC`, not `FLOAT` or `DOUBLE`, so we do not lose precision needed for price reconstruction.
- Refined `hops_from_stable` so it now counts intermediate bridge assets, not raw path edges.
- Direct stable pricing is now `0` hops.
- A path like `TOKEN -> ETH -> USDC` is now `1` hop.
- A path like `TOKEN -> ETH -> WBTC -> USDC` is now `2` hops.
- Added `low_confidence` flags to `stark_price_ticks` and `stark_prices`.
- If a price is more than one intermediate bridge away from a stable anchor, it is now marked low confidence.
- Latest-price materialization is stricter now. Weak multi-hop prices can still be kept in historical ticks for forensics, but they are prevented from becoming the public latest price row.
- Fixed the OHLCV volume mismatch root cause.
- The specific DAI/USDC mismatch was not caused by `incremental_append`.
- The report case was a single-trade `incremental_new` candle, so the problem was upstream volume trust, not a missing earlier candle state.
- Root cause: candle volume logic was trusting cached trade volume fields instead of reconstructing candle volume from canonical signed `amount0_delta` and `amount1_delta`.
- Fix: `core/ohlcv.js` now rebuilds candle volume from canonical signed deltas in both the incremental path and the rebuild path.
- This means candle volume is now derived from the same trade truth that created the swap row, which closes the 13,778 USDC discrepancy class instead of hiding it with a filter.

## Changes3

- Hardened graph pricing so hop counting is now cycle-aware.
- The path finder now keeps a per-path visited-token set, so circular routes and back-and-forth hops cannot loop or inflate the hop count.
- The stored `hops_from_stable` value now reflects the shortest cycle-free path to a stable anchor, even if price selection later prefers a better-quality candidate on the same search.
- Added an unknown-locker warning path for Ekubo.
- If Ekubo sees a locker address that is not in our registry, it now emits a `LOG_LEVEL_WARN` message once per locker and stores `router_protocol` as `unknown_locker_[HEX]`.
- This means protocol upgrades or new lockers no longer fail silently.
- Hardened token-registry reorg safety.
- Added `verified_at_block` and `verification_source` to the shared `tokens` table.
- This means token rows learned from an orphaned block are no longer protected only by `UNIQUE(address)`.
- During reconciliation, metadata refreshed in the orphaned block window is deleted from `stark_token_metadata`, and affected `tokens` rows are either removed or reset back to safe seed truth.
- This makes the token registry reorg-aware instead of assuming that once metadata is inserted it is always valid.
- Confirmed and hardened VWAP behavior in `core/ohlcv.js`.
- Candle VWAP uses the normalized execution price, not the raw ratio, so mixed-decimal pools do not distort the weighted average.
- Fixed another subtle VWAP bug in the incremental path: existing candles were loading `close` into `vwapScaled` instead of loading the stored `vwap`.
- After the fix, incremental appends continue weighting from the real existing VWAP instead of drifting toward the last close.
- Added a final metadata hard-lock for reorg safety.
- The metadata refresher now only enriches tokens whose source blocks are deep enough to be considered finalized, so orphaned blocks cannot reintroduce token rows too early.
- Tightened transfer precision for dust-sized values.
- `amount_human` and `amount_usd` are now treated as high-precision numeric values so tiny 18-decimal transfers keep their fractional detail instead of turning into scientific notation.
- Added protocol-locker telemetry for unknown lockers.
- `view_unidentified_protocols` now counts `unknown_locker_[HEX]` rows so the team can see which lockers need registry coverage next.
- Finalized the rebuild VWAP rule.
- Full candle rebuilds now compute VWAP from `sum(amount_usd) / total_volume`, which gives the exact nightly truth instead of inheriting any incremental drift.
