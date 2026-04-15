# Phase 5: L1 Ethereum Integration

This phase makes StarknetDeg aware of Ethereum-side StarkGate activity.

Before this phase, the indexer could see the L2 result of a bridge, but it could not answer these questions reliably:

- Which Ethereum transaction funded this L2 wallet?
- How long did the bridge take from L1 event to L2 availability?
- Did a wallet trade immediately after bridging?

This phase closes that blind spot.

## What the L2 side was already doing

The L2 bridge pipeline already existed before the new Ethereum work:

- `core/bridge.js` extracts `bridge_in` and `bridge_out` style facts from Starknet transactions and receipt messages.
- Those facts are written into `stark_bridge_activities`.
- Later analytics jobs like `jobs/bridge-accounting.js` and `jobs/wallet-rollups.js` read `stark_bridge_activities` to build wallet bridge flow and wallet PnL views.

The problem was that these L2 rows did not know anything about the original Ethereum deposit transaction.

So we could see:

- a wallet received tokens on L2
- the wallet traded later

But we could not prove:

- which L1 tx funded it
- whether the bridge was confirmed or still unresolved
- how many seconds the bridge took

## What was added in Phase 5

### 1. New L1 raw tables

We added new PostgreSQL tables for Ethereum-side ingestion:

- `eth_block_journal`
- `eth_tx_raw`
- `eth_event_raw`
- `eth_starkgate_events`
- `eth_index_state`

These tables do the same job on L1 that `stark_block_journal`, `stark_tx_raw`, and `stark_event_raw` already do on L2:

- keep raw truth first
- preserve lineage
- make replay and audit possible

### 2. L1 indexer service

File:

- `src/indexers/l1-starkgate-indexer.ts`

This service reads Ethereum blocks and StarkGate logs in batches.

Its job is:

- read the current Ethereum head from `ETH_RPC_URL`
- resume from `eth_index_state`
- store raw block rows in `eth_block_journal`
- store raw tx and receipt rows in `eth_tx_raw`
- store raw log rows in `eth_event_raw`
- decode recognized StarkGate events into `eth_starkgate_events`

It does not try to match L1 and L2 inside the raw indexer.

That is deliberate.

Raw ingestion and cross-chain matching are kept separate so that:

- raw truth can be replayed
- matcher bugs do not corrupt the raw layer
- we can re-run matching logic later without re-downloading Ethereum history

### 3. StarkGate event decoding

Files:

- `lib/ethereum-rpc.js`
- `lib/l1-starkgate.js`

The L1 decoder handles:

- `DepositWithMessage(...)`
- `Deposit(...)`
- `WithdrawalInitiated(...)`

Important decoding rule:

- the token address and amount are read from the non-indexed `data` payload, not only from topics

That matters because bridge matching becomes wrong if we only trust indexed topics and ignore payload words.

### 4. Address normalization

One of the main failure cases in cross-chain systems is address padding mismatch.

On L1, the L2 recipient is carried as a `uint256`.
On L2, the same wallet address is stored as a felt-style hex string.

We now normalize both into one format:

- lowercase
- `0x` prefix
- 64 hex characters

This is why the L1 recipient can now match the L2 wallet string exactly.

Without this, the same wallet can look different on both sides and the matcher would leave rows stuck in `PENDING`.

### 5. Cross-chain matcher

File:

- `src/jobs/l1-cross-chain-matcher.ts`

This is the logic layer that links L1 and L2.

It reads pending rows from `eth_starkgate_events` and tries to match them against L2 rows.

For deposits, it uses two strategies:

1. Nonce-first
2. Amount-and-time fallback

Why this order:

- nonce is strongest when available
- amount and time is weaker, so it is only used when nonce is missing

On a successful deposit match, the matcher updates all of these in one database transaction:

- `eth_starkgate_events`
- `stark_bridge_activities`
- `stark_wallet_bridge_flows`
- `stark_wallet_stats`
- `stark_trades`

That atomic transaction is important.

Without it, the system could end up in a half-matched state, for example:

- L1 event says `MATCHED`
- bridge activity still says `PENDING`
- trade row never gets `l1_deposit_tx_hash`

That kind of split state is exactly what we want to avoid in production.

### 6. Unknown token warnings

The L1 decoder has a warning path similar to the unknown-locker logic.

If StarkGate emits a token that is not in the L1-to-L2 token map:

- we do not silently drop it
- we log a `LOG_LEVEL_WARN`
- we keep the raw and decoded row for audit

This makes new bridge tokens visible to the team instead of invisible.

## New fields added to existing L2 tables

### `stark_bridge_activities`

This table now stores the L1 side of the match:

- `eth_tx_hash`
- `eth_block_number`
- `eth_block_timestamp`
- `eth_log_index`
- `eth_event_key`
- `l1_match_status`
- `settlement_seconds`
- `settlement_blocks_l1`
- `settlement_blocks_l2`

This means the bridge row is no longer only “an L2 bridge-like activity”.
It can now become a fully linked cross-chain bridge record.

### `stark_trades`

Trade rows now store whether they happened after a matched deposit:

- `l1_deposit_tx_hash`
- `l1_deposit_block`
- `l1_deposit_timestamp`
- `l1_wallet_address`
- `seconds_since_deposit`
- `is_post_bridge_trade`

This is what lets us answer:

- which trades happened right after funding
- how fast the wallet started trading after bridging

### `stark_wallet_bridge_flows`

Wallet bridge rollups now track L1 settlement quality:

- `avg_settlement_seconds`
- `min_settlement_seconds`
- `max_settlement_seconds`
- `pending_l1_match_count`
- `l1_verified_inflow_usd`
- `l1_verified_outflow_usd`

### `stark_wallet_stats`

Wallet summary rows now carry L1 identity and L1-aware bridge stats:

- `l1_wallet_address`
- `l1_bridge_inflow_usd`
- `l1_bridge_outflow_usd`
- `avg_bridge_settlement_s`
- `first_l1_activity_block`
- `last_l1_activity_block`

### `stark_message_l2_to_l1`

L2-to-L1 messages can now be marked as completed on Ethereum:

- `l1_consumed_tx_hash`
- `l1_consumed_block`
- `l1_consumed_timestamp`
- `message_status`
- `settlement_seconds`

## Important bug fixes during implementation

While hardening the new L1 path, a few real issues were found and fixed:

- The matcher originally updated wallet summary tables only if the row already existed. That meant successful L1 matches could disappear from analytics. It now ensures those rows exist first.
- `stark_block_journal.block_timestamp` is stored as Starknet epoch seconds, not as a ready-made SQL timestamp. The matcher and wallet rollups now convert that properly before doing time math.
- Some new matcher SQL used untyped parameters inside `jsonb_build_object(...)` and `COALESCE(...)`. PostgreSQL could not infer those types at runtime. Explicit casts were added.

These fixes were necessary for production use. Without them, you would get:

- false `PENDING` rows
- broken `settlement_seconds`
- or runtime SQL failures during matching

## How to run the new L1 services

Once `ETH_RPC_URL` is configured in `.env`, start:

```powershell
npm run start:l1-indexer
```

```powershell
npm run start:l1-matcher
```

## What was verified

The current `.env` does not yet define `ETH_RPC_URL`, so live Ethereum ingestion was not run from this machine.

Instead, a controlled database fixture was used to verify the matching logic end to end.

That proof showed:

- one deposit matched successfully
- `eth_starkgate_events.match_status` became `MATCHED`
- `eth_starkgate_events.match_strategy` became `nonce`
- `settlement_seconds` became `300`
- `stark_bridge_activities.l1_match_status` became `MATCHED`
- `stark_trades.l1_deposit_tx_hash` was populated
- `stark_trades.is_post_bridge_trade` became `true`

So the data path is working:

L1 event -> `eth_starkgate_events` -> matcher -> `stark_bridge_activities` -> `stark_trades` / wallet rollups
