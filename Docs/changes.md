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

## Changes4

- Added full Ethereum L1 StarkGate ingestion support.
- Created `sql/0010_l1_new_tables.sql` for `eth_block_journal`, `eth_tx_raw`, `eth_event_raw`, `eth_starkgate_events`, and `eth_index_state`.
- Created `sql/0011_l1_alter_tables.sql` to add L1 settlement and match fields into `stark_bridge_activities`, `stark_wallet_bridge_flows`, `stark_wallet_stats`, `stark_message_l2_to_l1`, `stark_trades`, and `stark_whale_alert_candidates`.
- Added `lib/ethereum-rpc.js` so StarknetDeg can talk to Ethereum JSON-RPC directly without mixing L1 calls into the Starknet RPC client.
- Added `lib/l1-starkgate.js` to decode StarkGate L1 logs and normalize them into one internal shape before writing anything to the database.
- Added `src/indexers/l1-starkgate-indexer.ts` to batch-read Ethereum blocks and logs, preserve raw tx and log JSON, decode StarkGate events, and advance `eth_index_state`.
- Added `src/jobs/l1-cross-chain-matcher.ts` to match L1 deposits and L2 bridge-ins using two strategies:
  - nonce-first when the L2 bridge row already carries the StarkGate nonce
  - amount-and-time fallback when nonce is missing
- Matching is wrapped in database transactions, so we do not get partial updates where `eth_starkgate_events` says `MATCHED` but `stark_bridge_activities` or `stark_trades` were not updated.
- Implemented L2 address normalization for L1 deposits.
- L1 recipient felt values are now normalized into the same `0x` + 64 lowercase hex format used by `stark_trades.trader_address` and `stark_bridge_activities.l2_wallet_address`.
- This closes the address-padding mismatch class where the same wallet would look different on L1 and L2.
- Added unknown-token warnings for L1 StarkGate decoding.
- If an L1 bridge event contains a token that is not in our L1-to-L2 mapping, the decoder now emits a `LOG_LEVEL_WARN` message instead of failing silently.
- Fixed a matcher propagation gap.
- The matcher was originally only updating `stark_wallet_bridge_flows` and `stark_wallet_stats`.
- If those rows did not already exist, nothing would be written.
- The matcher now ensures those summary rows exist before applying L1 settlement updates.
- Fixed a Starknet timestamp normalization bug in cross-chain matching.
- `stark_block_journal.block_timestamp` is stored as epoch seconds, not as a ready-made SQL timestamp.
- The matcher and wallet rollups now convert those numeric seconds into real JavaScript `Date` objects before computing settlement or activity windows.
- This was required for correct `settlement_seconds` and post-bridge trade timing.
- Fixed Postgres type-inference bugs in the new matcher SQL.
- `jsonb_build_object(...)` parameters now use explicit casts, so match metadata updates do not fail at runtime.
- Decimal USD parameters now cast to `NUMERIC`, so L1-verified inflow and outflow updates do not fail when the value is fractional.
- Settlement averaging now casts the settlement parameter to `INTEGER`, so `avg_bridge_settlement_s` updates work reliably.
- Added npm runtime entrypoints for the new L1 services:
  - `npm run start:l1-indexer`
  - `npm run start:l1-matcher`
- Verification was completed with a controlled database fixture because the current `.env` does not yet define `ETH_RPC_URL`.
- The controlled matcher proof produced these actual results:
  - `depositsMatched = 1`
  - `eth_starkgate_events.match_status = MATCHED`
  - `eth_starkgate_events.match_strategy = nonce`
  - `eth_starkgate_events.settlement_seconds = 300`
  - `stark_bridge_activities.l1_match_status = MATCHED`
  - `stark_trades.l1_deposit_tx_hash` populated correctly
  - `stark_trades.is_post_bridge_trade = true`

## Changes5

- Fixed generic HTTP 400 errors during L1 StarGate Indexing.
- Updated `lib/ethereum-rpc.js` to explicitly parse and extract the `payload.error.message` on non-OK HTTP responses. This accurately surfaces restrictive RPC error messages (like Alchemy block limits) rather than masking them.
- Fixed Alchemy Free Tier `eth_getLogs` 400 error.
- Added `ETH_INDEXER_BATCH_SIZE=10` to `.env` enforcing Alchemy's 10-block strict limit.
- Fixed Postgres `invalid byte sequence for encoding "UTF8": 0x00` crashes in Phase 4.
- Updated `jobs/meta-refresher.js` to strip `\x00` characters using Regex from newly decoded Starknet contract token names and symbols before insertion.
- Fixed `INSERT has more expressions than target columns` in Phase 6.
- Edited `jobs/wallet-rollups.js` to delete a stray `$29::jsonb` mapping in the `stark_wallet_stats` logic that exceeded the declared column count by 1 parameter.
- Fixed `Negative holder balance detected` exceptions blocking Phase 6 rollups.
- Updated `jobs/concentration-rollups.js` to clamp missing-history or silent-fee-burn balance deductions at `0n` rather than throwing hard crash exceptions.

## Changes6

- Reverted Starknet multi-hop handling back to the safer `materialization first` model.
- `core/trades.js` no longer collapses multiple route legs into one user-facing synthetic trade before insertion.
- Every real swap leg now stays as its own `stark_trades` row with its own `transaction_hash`, `source_event_index`, token pair, raw amounts, and execution venue.
- This directly matches the Lead requirement that a route like `ETH -> STRK -> USDC` must produce two rows, not one merged row.

- Removed the old count-based hop decision from the critical path.
- The earlier branch was still relying on `internalAmmSwapCount` style logic to infer that `count > 1` means multi-hop.
- That logic is not safe on Starknet because a single transaction can batch unrelated swaps.
- `core/event-router.js` now only stores route-scan hints such as `route_scan_signal` and `transaction_swap_count`.
- It no longer decides the final `is_multi_hop` truth during decode time.

- Refined materialization so internal venue swaps are preserved but redundant aggregator summary rows are not double-counted.
- `core/trades.js` now loads all swap actions, including rows previously marked as `is_route_leg`.
- Then it applies one narrow suppression rule:
  - if a transaction already contains real venue swap legs, the outer AVNU-style summary swap is not materialized into `stark_trades`
  - if no venue legs exist, the aggregator summary row is still allowed through as a fallback instead of losing the trade entirely
- This keeps storage faithful while avoiding a false extra row for the outer route summary.

- Added a late-binding forensic chaining engine in `core/post-processor.js`.
- This module groups rows by `transaction_hash`, sorts them by `transaction_index` and `source_event_index`, and then applies the value-flow rule.
- The rule is:
  - `token_out[i] == token_in[i+1]`
  - `amount_out[i] ~= amount_in[i+1]` within `0.01%` jitter
- The chaining engine does not merge rows.
- It only enriches them by assigning:
  - shared `route_group_key`
  - `sequence_id = 1, 2, 3...`
  - `hop_index = 0, 1, 2...`
  - `total_hops = X`
  - `is_multi_hop = true`

- Added a dedicated enrichment queue instead of re-scanning the whole table blindly.
- New migration file: `sql/009_trade_chaining.sql`
- It adds:
  - `stark_trades.sequence_id`
  - `stark_trades.amount_in_human`
  - `stark_trades.amount_out_human`
  - new queue table `stark_trade_enrichment_queue`
- The queue lets the indexer insert trades fast first, and then lets a worker process unthreaded transactions afterwards in a controlled way.

- Added the new worker `jobs/trade-chaining.js`.
- This worker:
  - claims pending queue rows with `FOR UPDATE SKIP LOCKED`
  - loads all `stark_trades` rows for one `transaction_hash`
  - runs the forensic chaining logic
  - updates all linked rows in one database transaction
  - marks the queue row as `processed` or `failed`
- This avoids partial metadata writes and directly addresses the `re-processing stuck` problem.

- Fixed the broken `amount_human` write path.
- Root cause was not BigInt integer division.
- The code was already computing scaled human values in `core/trades.js`, but this branch was dropping them before insertion.
- Specifically:
  - `deriveTrade(...)` computed `amountInHumanScaled` and `amountOutHumanScaled`
  - but those values were not being returned consistently into the final trade payload on this branch
  - and the SQL write path on this branch had drifted away from those columns
- Result: the database columns existed, but live trade rows ended up `NULL` or effectively unusable.

- The amount scaling fix is now explicit and precise.
- `core/trades.js` now persists `amount_in_human` and `amount_out_human` using `scaledToNumericString(...)`.
- The DB columns are stored as `NUMERIC(78,30)`, so tiny dust-sized amounts keep full decimal detail without scientific notation or float drift.
- `sql/009_trade_chaining.sql` also backfills historical rows using exact SQL numeric division with token decimals.
- This makes the fix visible immediately in the live database instead of only on future inserts.

- Repricing now preserves the late-bound chain metadata.
- `core/trades.js` was updated so pending-enrichment re-materialization continues to carry:
  - `route_group_key`
  - `sequence_id`
  - `hop_index`
  - `total_hops`
- This prevents the repricer from accidentally wiping the route-threading metadata after decimals or prices are refreshed.

- Startup validation was tightened.
- `core/checkpoint.js` and `bin/start-indexer.js` now assert that the trade-chaining migration is present before the indexer starts.
- This means startup will fail fast if:
  - `stark_trade_enrichment_queue` is missing
  - `stark_trades.sequence_id` is missing
  - `stark_trades.amount_in_human` or `amount_out_human` is missing

- Added the runtime entrypoint `npm run start:trade-chaining`.
- `package.json` and `check:syntax` were updated so the new worker and `core/post-processor.js` are part of normal repo validation.

- Verified the PDF chaining case in code, without collapsing rows.
- The `Verification 8` amount-chaining pattern was replayed through `buildTradeChainAnnotations(...)`.
- Using the PDF values:
  - Event 1 output `167733208005356219132` matched Event 2 input
  - Event 2 output `5848788` matched Event 3 input
  - Event 3 output `5849340` matched Event 5 input
- Result:
  - the rows stay separate
  - all four rows receive the same `route_group_key`
  - `sequence_id` becomes `1, 2, 3, 4`
  - `total_hops = 4`
  - `is_multi_hop = true`

- Verified the live database after the migration and worker run.
- `009_trade_chaining.sql` was applied successfully.
- The queue backfill seeded `231` transaction hashes.
- The new worker processed all `231` queue rows successfully.
- Live DB verification after processing showed:
  - `399` total trade rows
  - `399` rows with non-zero `amount_in_human`
  - `399` rows with non-zero `amount_out_human`
  - `399` rows with non-null `sequence_id`
  - `203` rows marked `is_multi_hop = true`
  - `80` distinct `route_group_key` chains
- This confirms the system is now storing every swap row independently first, then linking the true chains afterwards.

## CHANGES 7    2026-04-18 Metadata Sync And Transfer QA Hardening

- Added a static core-token registry in `core/constants/tokens.js`.
- The registry hardcodes the hot-path Starknet mainnet tokens needed for deterministic decimal resolution:
  - `ETH`
  - `USDC`
  - `USDT`
  - `STRK`
  - `DAI`
  - `WBTC`
  - plus the legacy `DAI_V0` address that the repo already carried in seeds
- `core/token-registry.js` and `core/token-trust-cache.js` now consult this static registry before slower lookup paths.
- Result:
  - the most important token decimals no longer depend on RPC
  - the token registry can seed these rows immediately and consistently

- Added `core/token-metadata.js` as the shared metadata-resolution module.
- This module centralizes:
  - queue enqueue/claim/mark helpers for token metadata retries
  - tiered metadata resolution
  - on-chain metadata calls
  - Voyager authority fallback
  - `stark_token_metadata` upsert logic
- The resolution order is now:
  - Tier 1: static core registry
  - Tier 2: `stark_token_metadata`
  - Tier 3: on-chain RPC
  - Tier 4: Voyager authority fallback

- Removed the unsafe "unknown token => 18 decimals" behavior from the live trade path.
- `core/trades.js` no longer injects fallback decimals for unresolved tokens.
- Instead:
  - the raw trade is still materialized
  - `pending_enrichment = true` stays explicit
  - `amount_in_human` / `amount_out_human` remain unresolved until metadata is real
  - the missing token addresses are queued into `stark_token_metadata_refresh_queue`
- `deriveTradePrice(...)` was also updated so decimal normalization only happens when both token decimals are actually known.
- This prevents mathematically wrong normalized prices from being written just because the decimals were missing.

- Added the new retry queue migration in `sql/0012_metadata_sync_and_transfer_enrichment.sql`.
- This migration adds:
  - `stark_token_metadata_refresh_queue`
  - transfer/action transaction lookup indexes used by the enrichment worker
- It also repairs old rows by:
  - recomputing `stark_trades.amount_in_human` and `amount_out_human` from actual known decimals only
  - clearing those human values back to `NULL` when decimals are still unresolved
  - backfilling the new metadata queue from unresolved `stark_trades` and `stark_transfers`

- Added `jobs/metadata-syncer.js`.
- This worker is queue-driven and handles the professional retry flow that QA asked for.
- It:
  - seeds the queue from unresolved live rows
  - claims queue work with `FOR UPDATE SKIP LOCKED`
  - resolves metadata through the four-tier pipeline
  - syncs resolved token truth into `tokens`
  - reprices pending trades
  - rebuilds pending candles
  - recalculates transfer human amounts and token identity columns
  - enriches transfers for routing/counterparty QA improvements

- Updated `core/protocols/erc20.js`.
- When an ERC-20 transfer comes from a token that still fails the trust gate, the decoder now enqueues metadata discovery work instead of only auditing and walking away.
- This does not force unsafe trust promotion.
- It simply ensures the token goes into the retry pipeline immediately.

- Updated `core/event-router.js` transfer metadata handling.
- Transfers now inherit same-transaction routing context in metadata, including:
  - transaction sender
  - swap presence in the transaction
  - swap count
  - whether AVNU aggregator context was present
- That context is later used by the metadata sync worker to do smarter transfer enrichment.

- Implemented smart counterparty classification inside `jobs/metadata-syncer.js`.
- The worker now inspects transfers within the same `transaction_hash`.
- If an address is a transfer recipient in one row and a sender in another row in a transaction that also contains swap activity:
  - it becomes a routing intermediary candidate
  - `starknet_getClassHashAt` is used to confirm code exists at that address
  - if the address also matches locker/router evidence, `counterparty_type` is upgraded to `router`
  - otherwise it is upgraded to `contract`
- This upgrades the old blanket `unknown` labeling into something analytically useful without pretending every intermediary is a user wallet.

- Implemented transfer-type precision for multi-hop routes.
- The metadata sync worker now matches `stark_transfers` rows back to multi-hop `stark_trades.route_group_key` chains using:
  - token address
  - raw amount within `1 bps` (`0.01%`) tolerance
  - trader/intermediary endpoint evidence
- Matching rows are upgraded from:
  - `standard_transfer`
  - to `routing_transfer`
- This connects the transfer table to the already-late-bound trade route model instead of leaving the route visible only in `stark_trades`.

- Updated startup/runtime integration.
- `core/checkpoint.js` now asserts the new metadata-sync queue migration.
- `bin/start-indexer.js` fails fast if that migration is missing.
- `package.json` now includes `start:metadata-syncer`.
- `tools/run-group.js` now starts `metadata-syncer` inside the Phase 4 grouped launcher.
- `check:syntax` now validates:
  - `jobs/metadata-syncer.js`
  - `core/token-metadata.js`
  - `core/constants/tokens.js`
  - `core/token-trust-cache.js`

- Removed the old fallback-18 SQL backfill behavior from `sql/009_trade_chaining.sql`.
- A fresh schema bootstrap now leaves unresolved trade human amounts as `NULL` instead of silently normalizing with `18`.
- This keeps fresh environments aligned with the corrected live runtime behavior.

## CHANGES 8    2026-04-18 Metadata Sync Voyager Backoff And Dust Tolerance

- Hardened the Tier 4 Voyager authority fallback in `core/token-metadata.js`.
- Voyager calls now go through a shared request gate instead of firing as fast as the queue can loop.
- The new gate adds:
  - a small configurable cooldown between Voyager requests
  - `Retry-After` handling when Voyager returns it
  - exponential backoff when Voyager answers with `HTTP 429`
  - a capped wait window so retry delay does not grow forever
- This keeps `jobs/metadata-syncer.js` from turning a burst of unresolved tokens into a self-inflicted Voyager rate-limit storm.

- Preserved the existing queue semantics instead of inventing a new side channel.
- If Voyager still rate-limits after the backoff gate, the affected queue item is marked failed and remains retryable in the normal metadata-refresh queue.
- This means the worker stays operational under pressure without silently promoting incomplete metadata.

- Fixed a real Postgres bug in `sql/0012_metadata_sync_and_transfer_enrichment.sql`.
- The original trade backfill statement used `UPDATE ... FROM ... LEFT JOIN ... ON token_out.address = trade.token_out_address`, which Postgres rejects because the target table alias cannot be referenced from that join branch.
- The migration now uses a CTE keyed by `trade_key` to resolve `token_in_decimals` and `token_out_decimals` first, then performs the `UPDATE` against that resolved set.
- After this fix, `0012_metadata_sync_and_transfer_enrichment.sql` applied successfully on the current database.

- Hardened transfer route matching in `jobs/metadata-syncer.js`.
- The first implementation required exact raw-amount equality between:
  - `stark_transfers.amount`
  - and the matching `stark_trades.amount_in` / `amount_out`
- That was too strict for routers that retain a tiny dust amount as fee.
- The matcher now uses the same `1 bps` (`0.01%`) jitter rule already used by `core/post-processor.js` for trade chaining.
- Result:
  - legitimate multi-hop routing transfers are less likely to be missed
  - transfer enrichment stays aligned with the existing trade-chain tolerance model

- Updated the Phase 4 documentation to reflect both protections.
- `Docs/phase4_metadata.md` now explains:
  - Voyager cooldown and exponential backoff
  - `1 bps` transfer-match tolerance for dust
- `Docs/db.md` now clarifies that `routing_transfer` classification is tolerant to small raw-amount dust.
- `Docs/roadmap.md` now lists both behaviors as active Phase 4 guardrails.

## CHANGES 9    2026-04-18 Pool Anatomy And Dynamic Discovery

- Added `sql/0013_pool_taxonomy_registry.sql`.
- This migration creates the canonical `stark_pool_registry` table and adds nullable `pool_family` and `pool_model` columns to:
  - `stark_pool_state_history`
  - `stark_pool_latest`

- Added `core/pool-discovery.js`.
- This module is the pool taxonomy resolver and registry helper.
- It handles:
  - candidate normalization
  - static registry resolution from `lib/registry/dex-registry.js`
  - class-hash matching
  - RPC interface fingerprinting
  - registry upserts with confidence ordering
  - state-table synchronization
  - validation queries

- Implemented the requested resolver precedence.
- The live resolver now works in this order:
  - static registry by address
  - static registry by class hash
  - RPC probing
  - history hints
  - unresolved candidate

- Added the Golden Standard mappings into the resolver path.
- Current hardcoded taxonomy includes:
  - JediSwap V1 -> `xyk` / `xyk`
  - 10KSwap -> `xyk` / `xyk`
  - JediSwap V2 -> `clmm` / `clmm`
  - Ekubo -> `clmm` / `singleton_clmm`
  - SithSwap -> `solidly` / `solidly_stable` or `solidly_volatile`
  - Haiko -> `market_manager` / `haiko`

- Implemented interface fingerprinting for unknown pool candidates.
- The resolver now uses lightweight Starknet RPC calls such as:
  - `getClassHashAt`
  - `factory`
  - `stable` / `is_stable`
  - `get_reserves` / `getReserves`
  - `get_pool` for Ekubo-style singleton keys
- This lets the system classify new pools without blocking the indexer on a full ABI-sync pass.

- Preserved the candidate-first runtime model in `core/pool-state.js`.
- When a pool snapshot is written:
  - the pool row gets the best available taxonomy hint immediately
  - unresolved pools are inserted into `stark_pool_registry` as `candidate` or `history_hint`
  - indexing keeps moving
  - the taxonomy worker resolves them asynchronously later

- Added the requested backfill worker `jobs/backfill-pool-taxonomy.js`.
- This worker:
  - seeds registry candidates from `stark_pool_latest` and `stark_action_norm`
  - resolves unresolved rows through RPC and static hints
  - synchronizes resolved taxonomy into the pool state tables
  - validates null counts, aggregator leaks, and CLMM trade joins

- Preserved the correct singleton identity model.
- Ekubo pools do not use only the contract address as identity.
- The system stores the normalized `pool_key = pool_id = token0:token1:fee:tickSpacing:extension`.
- This prevents all Ekubo pools from collapsing onto the same core address.

- Hardened runtime persistence around reconciliation.
- `jobs/finality-promoter.js` now preserves `pool_family` and `pool_model` when rebuilding `stark_pool_latest` from `stark_pool_state_history`.
- Without this, a reorg replay could silently erase pool taxonomy from the latest serving table even though the registry was correct.

- Updated trade-chain enrichment to include pool metadata.
- `jobs/trade-chaining.js` now loads the pool registry for the transaction's pool keys and stamps these fields into each trade row's metadata during annotation:
  - `pool_protocol`
  - `pool_family`
  - `pool_model`
  - `pool_confidence_level`
- The queue summary now also carries the observed confidence levels for the processed route.

- Added the dedicated design doc `Docs/pool_taxonomy.md`.
- Updated `Docs/db.md` with the new canonical registry and materialized taxonomy columns.
- Updated `Docs/roadmap.md` so the architecture roadmap includes dynamic pool discovery as a delivered capability.
