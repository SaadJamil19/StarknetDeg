# StarknetDeg Phase 6 Analytics

Date: April 6, 2026  
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

## 3. Why We Used ACB Instead Of FIFO

For wallet PnL, this implementation uses:

- `ACB` = Adjusted Cost Basis

It does **not** use FIFO lots yet.

Why ACB was chosen:

1. It is simpler to recompute from chain history.
2. It is deterministic under replay.
3. It is cheaper to rebuild after a reconciliation event.
4. It is good enough for product analytics and leaderboard logic.

Why not FIFO right now:

1. FIFO needs explicit lot storage.
2. Replay and rollback become heavier.
3. External bridge inventory makes lot attribution more complex.

So the rule is:

- Phase 6 optimizes for correct operational analytics
- not tax-grade lot accounting

If we skipped this choice and tried to half-build FIFO now, we would create a lot system that looks precise but is much harder to replay safely.

## 3.1 Why Gas Fees Had To Be Added To PnL

Gross trade PnL is not enough for active wallets.

If a wallet flips quickly and pays meaningful gas each time, gross profit can look healthy even when the wallet is barely net positive or actually losing money.

So the refined Phase 6 logic now attributes gas fees from `stark_tx_raw.actual_fee_amount` and `actual_fee_unit`.

How it works:

1. gas fee is mapped to its fee token:
   - `WEI` -> ETH
   - `FRI` -> STRK
2. gas fee is converted to USD using the same metadata and price system used elsewhere
3. if a transaction contains multiple trades, the transaction gas fee is allocated across those trades
4. buy-side gas is added into trade cost basis
5. sell-side gas is subtracted from sell proceeds

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

1. loads trades and bridge activity in lineage order
2. builds wallet/token inventory state
3. keeps two inventories per token:
   - traded inventory
   - external bridge inventory
4. allocates gas fees from `stark_tx_raw`
5. calculates realized PnL only on the traded portion of sells, net of gas fees
6. calculates unrealized PnL from current price on traded inventory
7. includes a repair loop for pending pricing rows
6. writes:
   - `stark_wallet_pnl_events`
   - `stark_wallet_positions`
   - `stark_wallet_stats`
   - wallet leaderboards

This file is where the "do not treat bridge deposits as profit" rule is actually enforced.

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
8. creates whale alert candidates with `velocity_score`

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
- relieved cost basis = current traded cost basis times traded quantity share
- realized PnL = traded proceeds minus relieved cost basis

This is ACB because cost is relieved proportionally from the current traded inventory.

This means:

- buy fees enter through cost basis
- sell fees enter through proceeds reduction

So realized PnL is net of fees from both sides over time.

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

### 6.5 Unrealized PnL

Unrealized PnL is calculated on traded inventory only:

- market value of traded quantity at latest price
- minus traded cost basis

If price or decimals are missing:

- `pending_pricing = true`
- the row remains visible
- but it is marked incomplete

## 6.6 The Self-Healing Repair Loop

The refined Phase 6 job now has a repair path.

Why it exists:

- sometimes a trade is indexed before decimals are fetched
- sometimes a price row is not available yet
- sometimes gas fee pricing is not ready when the wallet rollup runs

The repair loop does this:

1. scans `stark_wallet_positions` for `pending_pricing = TRUE`
2. checks whether the missing token metadata or price inputs now exist
3. if yes, triggers a clean ACB rebuild

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
npm run start:bridge-accounting
npm run start:wallet-rollups
npm run start:concentration-rollups
npm run start:finality-promoter
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

- FIFO tax lots
- generalized off-chain wallet attribution
- final user-facing whale alert delivery
- Ethereum-side bridge event correlation sidecar
- full per-wallet transfer-based cost basis outside bridge flows
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
