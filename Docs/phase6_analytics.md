# StarknetDeg Phase 6 Analytics

Date: April 21, 2026  
Scope: Plain-English explanation of the Phase 6 analytics layer. This phase does not change raw indexing. It reads the already-indexed Starknet data and turns it into wallet PnL, bridge flow accounting, holder concentration, whale alert candidates, and finality-aware replay protection.

## 1. What Phase 6 Actually Does

By the time Phase 6 starts, the indexer already has:

- raw blocks and receipts
- normalized actions
- verified transfers
- trades
- price ticks
- latest prices
- pool state
- 1-minute candles
- token metadata
- contract security hints

That means the system already knows what happened on-chain.

Phase 6 answers a different set of questions:

1. Did a wallet actually make trading profit, or did it just bridge assets in from Ethereum?
2. Which wallets are the largest and most active?
3. Which holders control too much supply?
4. What happens if an `ACCEPTED_ON_L2` block never becomes a valid L1 anchor?
5. Can we repair analytics automatically when token pricing or metadata arrives late?

So Phase 6 is not about decoding more events.  
It is about building trustworthy intelligence on top of the facts we already indexed.

The refined version of Phase 6 now adds three reliability upgrades:

1. realized PnL is net of gas fees
2. pending pricing rows can self-heal through a repair loop
3. whale alerts now have a `velocity_score`, so fast bridge-then-trade behavior ranks higher than passive holding

## 2. The Main Design Decision

The biggest design choice in this phase is this:

- trading inventory and bridge inventory are tracked separately

This matters because a pure bridge deposit is not trading profit.

Example:

1. A wallet bridges `1000 STRK` into Starknet.
2. Later it sells `200 STRK` on a DEX.

If we looked only at the sell trade, we might wrongly say:

- "the wallet sold 200 STRK and made money"

But that can be false.

Those tokens may have come from outside Starknet.  
That is external capital movement, not Starknet trading alpha.

So the Phase 6 model does this:

- `bridge_in` adds external inventory
- `bridge_out` removes external inventory
- DEX buys add traded inventory
- DEX sells consume external inventory first, then traded inventory

That conservative rule is intentional.

Why external-first on sells?

Because if we do not do that, a big bridge deposit can be mistaken for profit the first time the wallet sells.

This is the single most important reason Phase 6 exists.

## 3. Full-Node Event Lineage Model

Phase 6 now assumes the preferred production path is full-node historical indexing, not a snapshot/bootstrap seed.

The model is:

1. start the canonical indexer from block `0`, or from the earliest tracked deployment block
2. decode every relevant historical transfer, trade, bridge, and price event
3. rebuild wallet and holder analytics from event lineage
4. validate reconstructed balances against live `balanceOf`

Snapshot seeding can still be useful for a temporary bootstrap, but it is not the source of truth for production analytics.

The important difference:

- snapshot mode gives balances and PnL from a chosen block forward
- full-node mode gives replayable balances and trade PnL across the indexed lifetime

The canonical start block is controlled by:

- `INDEXER_START_MODE=genesis`
- `INDEXER_START_MODE=tracked_deployment`
- optional `INDEXER_START_TARGETS=jediswap,eth,...` when you want `tracked_deployment` to resolve against specific tracked symbols/protocols/addresses
- or explicit `INDEXER_START_BLOCK=<block_number>`

If `INDEXER_START_BLOCK` is present, it wins. Otherwise `genesis` starts at block `0`, while `tracked_deployment` uses the earliest known deployment evidence from the registry/state-diff tables and falls back to `0` if no evidence exists. When `INDEXER_START_TARGETS` is set, the deployment resolver narrows to those tracked targets instead of the whole tracked universe.

Decoder behavior is soft-failing. If an old block contains an unknown or pre-deployment-era event shape, the event is audited and marked failed/unknown without crashing the whole block.

## 3.1 FIFO Cost Basis

For wallet PnL, the implemented trade inventory now uses FIFO lots.

Each DEX buy creates a lot:

- quantity = `amount_out`
- cost basis = `notional_usd + buy-side gas fee`
- lineage = source trade key and block

When the wallet sells, the traded part of the sell consumes those lots in order. Realized PnL is:

- proceeds from the traded sold quantity
- minus original buy cost basis relieved from the consumed lots

External bridge inventory remains separate and is consumed before traded inventory. That prevents bridge deposits from being treated as Starknet trading profit.

## 3.2 Why Gas Fees Had To Be Added To PnL

Gross trade PnL is not enough for active wallets.

If a wallet flips quickly and pays meaningful gas each time, gross profit can look healthy even when the wallet is barely net positive or actually losing money.

So the refined Phase 6 logic now attributes gas fees from `stark_tx_raw.actual_fee_amount` and `actual_fee_unit`.

How it works:

1. gas fee is mapped to its fee token:
   - `WEI` -> ETH
   - `FRI` -> STRK
   - modern Starknet protocol docs say that as of **September 1, 2025** and Starknet `v0.14.0`, transaction fees are charged only in `STRK`, but historical receipts can still carry `WEI` and `FRI`, so the indexer must support both eras
2. gas fee is converted to USD using the same metadata and price system used elsewhere
3. the conversion uses the historical `stark_price_ticks` row at or before the transaction lineage, not the current/latest gas token price
4. if a transaction contains multiple trades, the transaction gas fee is allocated across those trades
5. buy-side gas is added into trade cost basis
6. sell-side gas is subtracted from sell proceeds

That means realized PnL is now net of fees, not just raw swap output minus cost basis.

If fee pricing is not ready yet:

- the row is still written
- but it is marked pending
- and the repair loop will fix it later

## 4. New Tables Added In Phase 6

## 4.1 `stark_wallet_bridge_flows`

This table stores net bridge flow per wallet per token.

Columns:

- `lane`
- `wallet_address`
- `token_address`
- `bridge_in_amount`
- `bridge_out_amount`
- `net_bridge_flow`
- `bridge_inflow_usd`
- `bridge_outflow_usd`
- `net_bridge_flow_usd`
- `bridge_in_count`
- `bridge_out_count`
- `unresolved_activity_count`
- `price_source`
- `price_is_stale`
- `price_updated_at_block`
- `last_bridge_block_number`
- `last_bridge_transaction_hash`
- `metadata`
- `created_at`
- `updated_at`

What this table means:

- raw token amounts stay in chain units
- USD fields are derived only when token metadata and price data exist
- unresolved rows are still counted, so missing price or amount does not disappear silently

If we did not build this table, wallet stats would have to recalculate bridge flow from raw bridge rows every time.

## 4.2 `stark_wallet_pnl_events`

This is the audit trail for wallet-side trading actions.

Columns:

- `pnl_event_key`
- `lane`
- `wallet_address`
- `token_address`
- `trade_key`
- `block_number`
- `block_hash`
- `block_timestamp`
- `transaction_hash`
- `transaction_index`
- `source_event_index`
- `side`
- `quantity`
- `external_quantity`
- `traded_quantity`
- `gas_fee_amount`
- `gas_fee_token_address`
- `gas_fee_usd`
- `proceeds_usd`
- `cost_basis_usd`
- `realized_pnl_usd`
- `position_amount_after`
- `remaining_cost_basis_usd`
- `metadata`
- `created_at`
- `updated_at`

Important detail:

- `external_quantity` means the part of the sell that came from bridge inventory
- `traded_quantity` means the part that came from DEX-acquired inventory
- `gas_fee_usd` is the fee allocated to that wallet-side trade event

That is how we stop external inflows from polluting realized trade PnL.

## 4.3 `stark_wallet_positions`

This is the current wallet position snapshot per token.

Columns:

- `lane`
- `wallet_address`
- `token_address`
- `traded_quantity`
- `external_quantity`
- `total_quantity`
- `traded_cost_basis_usd`
- `external_cost_basis_usd`
- `average_traded_entry_price_usd`
- `last_price_usd`
- `realized_pnl_usd`
- `unrealized_pnl_usd`
- `trade_count`
- `bridge_in_count`
- `bridge_out_count`
- `first_activity_block_number`
- `last_activity_block_number`
- `last_activity_timestamp`
- `pending_pricing`
- `metadata`
- `created_at`
- `updated_at`

Important meaning:

- `traded_quantity` is only the amount acquired through DEX trades
- `external_quantity` is only the amount that came from bridge inflows and still remains
- `unrealized_pnl_usd` is based on traded inventory, not external inventory

If we combined those two quantities into one blind position number, unrealized PnL would become misleading.

## 4.4 `stark_wallet_stats`

This is the wallet summary table used for ranking and product-level analytics.

Columns:

- `lane`
- `wallet_address`
- `first_trade_block_number`
- `last_trade_block_number`
- `total_trades`
- `total_volume_usd`
- `total_gas_fees_usd`
- `realized_pnl_usd`
- `unrealized_pnl_usd`
- `net_pnl_usd`
- `bridge_inflow_usd`
- `bridge_outflow_usd`
- `net_bridge_flow_usd`
- `bridge_activity_count`
- `winning_trade_count`
- `losing_trade_count`
- `win_rate`
- `best_trade_pnl_usd`
- `best_trade_tx_hash`
- `best_trade_token_address`
- `best_trade_at_block`
- `metadata`
- `created_at`
- `updated_at`

This is the table the API layer will eventually read most often for wallet intelligence.

## 4.5 `stark_holder_balance_deltas`

This is the holder mutation ledger.

Columns:

- `delta_key`
- `lane`
- `block_number`
- `block_hash`
- `transaction_hash`
- `transaction_index`
- `source_event_index`
- `transfer_key`
- `token_address`
- `holder_address`
- `delta_amount`
- `balance_direction`
- `metadata`
- `created_at`
- `updated_at`

This table matters because it gives us one canonical place where holder changes are recorded.

If we ever need to rebuild balances, this is the mutation stream.

## 4.6 `stark_holder_balances`

This is the current holder state.

Columns:

- `lane`
- `token_address`
- `holder_address`
- `balance`
- `first_seen_block_number`
- `last_updated_block_number`
- `last_transaction_hash`
- `last_transaction_index`
- `last_source_event_index`
- `metadata`
- `created_at`
- `updated_at`

This table is derived from transfers.

Important rule:

- Phase 6 holder balances are rebuilt from `stark_transfers`
- not from a separate ad hoc wallet job

That keeps the holder system replayable.

## 4.7 `stark_token_concentration`

This table stores concentration metrics per token holder.

Columns:

- `lane`
- `token_address`
- `holder_address`
- `block_number`
- `balance`
- `total_supply`
- `balance_usd`
- `concentration_ratio`
- `concentration_bps`
- `holder_rank`
- `is_whale`
- `metadata`
- `created_at`
- `updated_at`

This is how Phase 6 answers:

- who holds the most
- what percent of supply they control
- which holders should be flagged as whales

## 4.8 `stark_leaderboards`

This table stores current ranked outputs.

Columns:

- `lane`
- `leaderboard_name`
- `entity_type`
- `entity_key`
- `rank`
- `metric_value`
- `as_of_block_number`
- `metadata`
- `created_at`
- `updated_at`

Current leaderboards include:

- `wallet_realized_pnl_usd`
- `wallet_total_volume_usd`
- `wallet_net_bridge_flow_usd`
- `holder_concentration_bps`
- `holder_balance_usd`

## 4.9 `stark_whale_alert_candidates`

This table stores alert foundations, not final user notifications.

Columns:

- `alert_key`
- `lane`
- `block_number`
- `wallet_address`
- `token_address`
- `alert_type`
- `severity`
- `velocity_score`
- `metric_amount`
- `metric_usd`
- `related_trade_key`
- `related_bridge_key`
- `metadata`
- `created_at`
- `updated_at`

Current alert types include:

- `concentration_whale`
- `bridge_flow_whale`
- `bridge_then_trade_whale`

`velocity_score` means:

- low score = passive behavior
- high score = wallet bridged in and traded very quickly afterward

## 5. Files Added In Phase 6

## 5.1 `sql/006_analytics.sql`

This migration adds the full Phase 6 schema.

Why it exists:

- without it the analytics jobs would have nowhere safe to write
- and the finality promoter would have nothing clear to delete and rebuild during reconciliation

## 5.2 `jobs/analytics-utils.js`

This is the shared helper file for analytics jobs.

It does four small but important jobs:

1. resolves the allowed analytics window from checkpoints
2. loads token decimals, supply, and latest price context
3. converts raw token amounts into USD values safely
4. replaces leaderboard rows in a controlled way
5. gives the gas-fee and repair logic one shared place to read price and metadata truth

If we duplicated this logic in every analytics job, the jobs would drift from each other over time.

## 5.3 `jobs/bridge-accounting.js`

This job reads `stark_bridge_activities` and builds `stark_wallet_bridge_flows`.

What it does:

1. finds all bridge rows up to the current analytics window
2. groups them by wallet and token
3. keeps bridge in and bridge out separate
4. computes net bridge flow
5. derives USD values when price and decimals are available
6. marks unresolved rows when amount or price is missing

What would go wrong without it:

- wallet analytics would mix bridge capital with trading capital
- large cross-chain deposits would look like mysterious wallet performance

## 5.4 `jobs/wallet-rollups.js`

This is the core PnL job.

What it does:

1. loads the full indexed history of verified wallet transfers, trades, and bridge activity in lineage order
2. builds wallet/token inventory state
3. keeps two inventories per token:
   - traded inventory
   - external non-trading inventory
4. stores traded inventory as FIFO lots
5. carries cost basis across wallet-to-wallet transfers when the sender inventory is known
6. prices gas from historical `stark_price_ticks` anchored to the transaction lineage
7. allocates gas fees from `stark_tx_raw`
8. calculates realized PnL only on the traded portion of sells, net of gas fees
9. calculates unrealized PnL from current price on traded inventory
10. closes FIFO dust lots below the configured threshold so replay state does not bloat forever
11. includes a repair loop for pending pricing rows
12. writes:
   - `stark_wallet_pnl_events`
   - `stark_wallet_positions`
   - `stark_wallet_stats`
   - wallet leaderboards

This file is where the "do not treat bridge deposits or plain token transfers as profit" rule is actually enforced.

It is also where the "do not call gross profit real profit" rule is enforced.

## 5.5 `jobs/concentration-rollups.js`

This job builds holder intelligence.

What it does:

1. replays `stark_transfers`
2. writes holder deltas
3. materializes current holder balances
4. joins balances with `total_supply`
5. calculates concentration ratio and basis points
6. builds concentration leaderboards
7. tags internal transfers when both sides are already known active traders
8. repairs negative replay gaps with historical `balanceOf` when RPC repair is enabled
9. creates whale alert candidates with `velocity_score`

Important note:

- balances come from verified transfers
- not from trade assumptions

That matters because a wallet can hold tokens without trading them.

## 5.6 `jobs/finality-promoter.js`

This is the integrity job.

It does two different things:

1. normal case:
   - it checks whether L2-indexed blocks have now become `ACCEPTED_ON_L1`
   - if yes, it advances the L1 checkpoint
2. bad case:
   - if the remote chain no longer matches the locally indexed L2 window
   - it opens a reconciliation record
   - marks the orphaned window
   - deletes replay-sensitive data from the last safe L1 anchor onward
   - restores latest materialized state
   - replays blocks through the existing block processor
   - reruns analytics jobs

This is the piece that protects the analytics layer from silent L2 divergence.

## 6. How PnL Is Calculated

This is the actual implemented model.

### 6.1 Buy

When a wallet buys on a DEX:

1. `amount_out` is added to traded inventory
2. `notional_usd + buy-side gas fee` is added to traded cost basis
3. a `buy` row is written to `stark_wallet_pnl_events`

### 6.2 Sell

When a wallet sells on a DEX:

1. external inventory is consumed first
2. if any sell quantity remains, traded inventory is consumed
3. sell-side gas fee is subtracted from proceeds
4. realized PnL is only calculated on the traded part

Formula used for traded sells:

- traded proceeds = net proceeds after sell gas times traded quantity share
- relieved cost basis = original buy cost basis from consumed FIFO lots
- realized PnL = traded proceeds minus relieved cost basis

This is FIFO lot accounting over the indexed trade history.

This means:

- buy fees enter through cost basis
- sell fees enter through proceeds reduction

So realized PnL is net of fees from both sides over time.

Gas is not marked to market with the latest ETH/STRK row.

Instead:

- fee quantity comes from the transaction receipt
- fee token comes from `actual_fee_unit`
- fee USD comes from the latest non-low-confidence `stark_price_ticks` row at or before that transaction lineage

That keeps historical PnL anchored to what the chain knew around that trade, not what the market knows now.

### 6.3 Bridge In

When a wallet bridges tokens in:

1. quantity is added to external inventory
2. if price is available, external cost basis is also stored
3. bridge flow stats are updated

No trade PnL is created.

### 6.4 Bridge Out

When a wallet bridges tokens out:

1. external inventory is reduced first
2. then traded inventory is reduced if needed
3. no trade PnL is created

That is important because bridge out is capital movement, not market realization.

### 6.5 Wallet Transfer In

When a wallet receives a verified non-internal token transfer:

1. quantity is added to external inventory
2. if the sender position is already known, the relieved sender cost basis is carried forward
3. otherwise the inbound side falls back to the priced transfer value when available

No trade PnL is created.

### 6.6 Wallet Transfer Out

When a wallet sends a verified non-internal token transfer:

1. external inventory is reduced first
2. then traded inventory is reduced if needed
3. any known cost basis relieved from the sender can be carried to the recipient position
4. no trade PnL is created

That keeps balances event-correct without pretending a simple wallet transfer is a realized sale.

### 6.7 Unrealized PnL

Unrealized PnL is calculated on traded inventory only:

- market value of traded quantity at latest price
- minus traded cost basis

If price or decimals are missing:

- `pending_pricing = true`
- the row remains visible
- but it is marked incomplete

### 6.8 FIFO Dust Disposal

Genesis replay can leave microscopic residual lots after many partial sells.

To stop those lots from accumulating forever:

1. each position keeps a dust threshold, currently `1e-10`
2. after inventory consumption, FIFO lots below that threshold are closed
3. the closed dust quantity and lot count are tracked in metadata
4. the closed lot cost basis is moved into `dust_loss_usd` and `total_dust_loss_usd`

This is not a tax feature.

It is a replay-state hygiene rule so tiny remainder lots do not distort storage cost and runtime.

It also preserves accounting identity:

- account value = inventory cost basis + realized PnL - dust loss

So dust is never silently deleted from the books.

### 6.9 Historical Gas Fee Anchoring

Gas is not priced from the latest token price.

The wallet rollup does this:

1. read `actual_fee_amount` and `actual_fee_unit` from `stark_tx_raw`
2. map fee unit historically:
   - `WEI -> ETH`
   - `FRI` / `STRK -> STRK`
3. if the fee unit is missing, inspect transaction version and v3-style fee fields:
   - legacy versions `< 3` default to ETH
   - version `>= 3` with `resource_bounds` or `fee_data_availability_mode` defaults to STRK
4. look for the closest `stark_price_ticks` row within `PHASE6_GAS_PRICE_FALLBACK_WINDOW_SECONDS`
5. prefer the closest tick by timestamp, while still preferring same-lineage-or-earlier ticks on ties
6. if a transaction contains multiple PnL-bearing swap events, the fee is split evenly across those events before being attached to lot cost basis
7. if no historical tick exists, optionally use configured fixed anchors:
   - `PHASE6_FIXED_GAS_ANCHOR_ETH_USD`
   - `PHASE6_FIXED_GAS_ANCHOR_STRK_USD`
8. if no safe anchor exists, keep the trade pending and write a `PRICE_MISSING_AUDIT` row into `stark_audit_discrepancies`

All USD math in this path stays on scaled integer arithmetic. No native JavaScript float is used for `notional_usd`, gas-fee USD, or lot cost basis.

### 6.10 Token Lineage Carry-Forward

Some Starknet tokens have migration history instead of simple one-token continuity.

Current built-in lineage map handles known protocol-level migrations such as legacy `DAI v0 -> DAI`.

Official Starknet docs clearly document the `DAI v0 -> DAI` migration and also note that many tokens still have legacy bridge infrastructure. They do not publish a broad, canonical list of multi-hop L2 token-address migrations, so the built-in map stays conservative and only hard-codes migrations we can defend from the docs and token registry.

When a trade matches a lineage hop:

1. the source token inventory is relieved without realizing PnL
2. the relieved cost basis is carried into the destination token
3. gas is added to the carried basis of the destination token
4. the wallet keeps lifetime continuity instead of booking a synthetic realized exit on the old token

The lineage resolver is now recursive.

That means if the map ever contains:

- `Token A -> Token B`
- `Token B -> Token C`

then a `B -> C` migration keeps carrying the inherited basis that originally came from `A`.

The resulting lot metadata stores:

- the lineage root address
- the full lineage path
- whether ancestry was ambiguous because multiple legacy sources converged into the same token

If multiple legacy roots converge into one destination token, the carry-forward lots are ordered by `root-age priority`:

1. oldest acquired root block first
2. then destination lot block
3. then stable lot id

That gives deterministic, auditable FIFO consumption even when two legacy assets eventually merge into one canonical token.

## 6.11 The Self-Healing Repair Loop

The refined Phase 6 job now has a repair path.

Why it exists:

- sometimes a trade is indexed before decimals are fetched
- sometimes a price row is not available yet
- sometimes gas fee pricing is not ready when the wallet rollup runs

The repair loop does this:

1. scans `stark_wallet_positions` for `pending_pricing = TRUE`
2. checks whether the missing token metadata or price inputs now exist
3. if yes, triggers a clean FIFO rebuild

Current implementation choice:

- the trigger is targeted
- but the rebuild is lane-wide, not row-by-row

Why?

Because wallet stats and leaderboards are cross-coupled.

A narrow patch can easily fix one wallet row while leaving global rankings inconsistent.

So the safe rule is:

- detect pending rows precisely
- rebuild conservatively

That makes the system self-healing without risking partial inconsistent aggregates.

## 7. How Holder Concentration Is Calculated

The holder job replays every verified transfer:

1. debit sender unless sender is zero address
2. credit receiver unless receiver is zero address
3. store both balance deltas and final balances
4. if a debit would make a balance negative, first write a row to `stark_audit_discrepancies`
5. inspect whether the token contract looks upgradeable or has historical class replacements
6. if `replaced_classes` evidence exists, clear the transfer-derived rows for that block and re-decode the raw block before restarting replay
7. only then consider historical `balanceOf` as a fallback repair path

Then for each holder:

- concentration ratio = balance divided by total supply
- concentration bps = ratio times 10,000

Additional refinement:

- if both `from_address` and `to_address` already exist in `stark_wallet_stats`
- the holder delta metadata is labeled `INTERNAL_TRANSFER`

That means we can distinguish:

- normal wallet movement
- active trader to active trader internal movement

without pretending that every big transfer is a sale or a bridge.

## 7.1 Audit Discrepancy Flow

`stark_audit_discrepancies` exists for the bad cases where replay truth and indexed truth diverge.

Current flow:

1. detect the negative-balance replay gap
2. log the affected holder, token, transfer, and attempted post-delta balance
3. inspect:
   - `stark_contract_security`
   - `stark_contract_registry`
   - `stark_block_state_updates.replaced_classes`
   - `stark_event_raw.resolved_class_hash`
4. if `stark_block_state_updates.replaced_classes` shows upgrade history, clear the block's transfer-derived rows and re-decode the raw block
5. if that re-decode changes transfer lineage, re-run trade derivation for the same transaction hash so `stark_trades` stays aligned with corrected transfer truth
6. while a block is actively waiting on re-decode, the audit row moves to `PENDING_REDECODE`
7. wallet rollups fence their replay window before the earliest `PENDING_REDECODE` block so PnL is never finalized across dirty transfer lineage
8. if the pending block is later orphaned by canonical reorg handling, the fence row is deleted automatically
9. each audited block gets a persistent `retry_count`
10. after `PHASE6_REDECODE_STRIKE_LIMIT` re-decode strikes, the row is marked `FATAL_MANUAL_REVIEW` and replay moves on instead of stalling forever
11. otherwise restart holder replay from the beginning of the lane transaction
12. if the same gap still exists after the allowed strikes, then use proxy policy:
   - proxy/upgrade evidence defaults to decoder-review-first
   - otherwise historical `balanceOf` can repair the row
13. store the final resolution on the audit row

This matters because an RPC repair is evidence of a replay gap, not a substitute for decoder correctness.

The system should tell us where lineage broke before it silently patches over the break.

If we did not do it this way and instead tried to infer holdings from trades, we would miss:

- bridged balances
- plain wallet transfers
- minted or burned supply

## 8. How Whale Alerts Work Right Now

This phase only builds candidates, not final push alerts.

Current candidates come from:

1. very high holder concentration
2. very large net bridge flow
3. large bridge flow combined with large DEX volume
4. fast bridge-in followed by trading activity

### 8.1 Velocity Score

`velocity_score` measures how quickly a wallet trades after bridging in.

The basic idea:

1. find a `bridge_in`
2. find the nearest later trade by the same wallet
3. measure the block gap
4. convert that gap into a score

Interpretation:

- smaller gap -> higher score
- larger gap -> lower score

So two wallets with the same bridge size are no longer treated equally:

- passive bridger gets a lower score
- bridge-then-trade wallet gets a higher score and usually higher severity

That gives us a clean base layer for later API and websocket alerting.

## 9. How Reconciliation Protects Data Integrity

This is the Phase 6 integrity story.

The canonical indexer still writes the L2 dataset in the `ACCEPTED_ON_L2` lane.

The L1 lane in practice is used as:

- a checkpoint watermark
- not a fully duplicated data copy

So the finality promoter does this:

1. find the last safe `ACCEPTED_ON_L1` anchor
2. compare later L2-indexed blocks against current RPC truth
3. if hashes or roots diverge:
   - mark the local window orphaned
   - delete replay-sensitive rows from the anchor-forward window
   - restore latest pool and latest price state from surviving history
   - replay blocks through `core/block-processor.js`
   - rerun bridge, wallet, and concentration rollups

Why replay from the last safe L1 anchor instead of from only the first bad block?

Because the L1 anchor is the last point we trust completely.

That is the safest rollback boundary.

If we replayed only from the first detected mismatch, we could still leave subtle derived state contamination alive before it.

## 9.1 Turbo To Live Index Rebuild

Turbo backfill deliberately trades query ergonomics for write speed.

Current behavior:

1. while replay is more than `1000` blocks behind head, non-unique indexes on `stark_transfers`, `stark_trades`, and `stark_pnl_audit_trail` are dropped when those tables exist
2. when replay moves back into the live buffer, index rebuild runs on a fresh connection outside the block-processing transaction
3. index rebuild uses:
   - `CREATE INDEX CONCURRENTLY`
   - `DROP INDEX CONCURRENTLY`
4. after rebuild, the worker performs an index health check and refuses to process live-head blocks while required indexes are missing or invalid
5. once the indexes are valid, the worker starts planner maintenance on a separate low-impact connection
6. when PostgreSQL supports it, maintenance uses `VACUUM (ANALYZE, PARALLEL 4)`
7. after each vacuum pass, the worker checks `pg_current_wal_lsn()` growth
8. if WAL growth exceeds `INDEXER_TURBO_WAL_GROWTH_BYTES`, maintenance sleeps for 60 seconds before continuing
9. if maintenance runs past 10 minutes, live-mode indexing resumes while vacuum continues in the background

This avoids blocking live writes while still guaranteeing that live-mode queries do not run on half-restored index state.

## 9.2 FIFO Proof Table

`stark_pnl_audit_trail` exists to make FIFO relief auditable.

Every time a traded lot is relieved on a sell:

1. the originating buy trade key and buy transaction hash are recorded
2. a stable `lot_id` is recorded for the relieved lot
3. the matching sell trade key and sell transaction hash are recorded
4. relieved quantity, relieved cost basis, relieved proceeds, and relieved realized PnL are stored side by side
5. `(sell_tx_hash, buy_tx_hash, lot_id)` is unique, so a restarted job cannot double-write the same relief proof row

That gives a direct buy-to-sell proof chain for each FIFO match instead of forcing a reviewer to reverse-engineer lot matching from aggregate position balances.

## 10. Precision Rules In Phase 6

The same precision rules from earlier phases still apply:

- runtime integer quantities use native `BigInt`
- database chain quantities use `NUMERIC`
- USD analytics use scaled integer math before SQL conversion

This matters especially for:

- cost basis
- realized PnL
- unrealized PnL
- bridge flow
- concentration ratios

If we used normal JavaScript floats here, wallet analytics would drift over time.

## 11. Commands

Run each Phase 6 job from `StarknetDeg`:

```powershell
set INDEXER_START_MODE=tracked_deployment
set INDEXER_START_TARGETS=jediswap,eth
set INDEXER_TURBO_MODE=true
set PHASE6_BALANCE_RPC_ON_PROXY_DISCREPANCY=false
set PHASE6_REDECODE_STRIKE_LIMIT=3
set PHASE6_FIFO_DUST_THRESHOLD=0.0000000001
set PHASE6_GAS_PRICE_FALLBACK_WINDOW_SECONDS=3600
set INDEXER_TURBO_WAL_GROWTH_BYTES=268435456
npm run start:bridge-accounting
npm run start:wallet-rollups
npm run start:concentration-rollups
npm run start:finality-promoter
npm run reconcile:balances
```

Default behavior right now:

- `bridge-accounting`, `concentration-rollups`, and `finality-promoter` run once and exit by default
- `wallet-rollups` also runs once by default, but when you keep it running it performs:
  - one full rebuild first
  - then repair scans on later loops

That was intentional so you can inspect the output safely before turning any of them into a looped process.

## 12. What Phase 6 Does Not Solve Yet

Phase 6 is strong, but it is not the end-state analytics system.

It still does not do:

- tax-grade external-transfer cost basis
- generalized off-chain wallet attribution
- final user-facing whale alert delivery
- Ethereum-side bridge event correlation sidecar
- exact cost basis for first-seen inbound transfers whose source inventory is outside the indexed lineage
- automatic legacy decoder generation for old proxy implementations; audited upgrade discrepancies still need explicit follow-up decoder work
- targeted per-wallet repair rebuilds instead of the current safe lane-wide repair trigger

But for the current StarknetDeg backend, this phase now provides:

- bridge-aware wallet PnL
- gas-aware net-profit PnL
- wallet rollups and leaderboards
- holder balance state
- concentration metrics
- whale alert candidates with velocity scoring
- replay-safe reconciliation logic

That is the correct foundation before building APIs or alert products on top.
