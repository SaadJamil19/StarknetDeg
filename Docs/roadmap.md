# StarknetDeg Master Roadmap

Date: April 2, 2026  
Scope: Updated end-to-end architecture and migration plan for building `StarknetDeg`, a Starknet-native DEX indexer that preserves Degenter's operating model while closing the remaining correctness gaps around receipt ordering, bridge flows, reorg-aware finality, and large-number precision.

## 0. Context and Inputs

This roadmap is based on four inputs:

1. Legacy Degenter architecture from `Degenter/docs/solana/docs.md`, `exp.md`, `sol2.md`, and `final.md`.
2. Starknet protocol constraints from `StarkNet_Complete_Technical_Reference.docx`.
3. Migration intent from `starknet-indexer-plan.docx`.
4. External primary-source research from:
   - Starknet official docs and `starknet-specs`
   - Apibara docs
   - DipDup docs
   - Ekubo, JediSwap, and AVNU public repos

This version specifically closes the following gaps:

1. Ekubo lock/callback receipts require ordered, receipt-local processing.
2. `ACCEPTED_ON_L2` is canonical for live analytics but is not irreversible until `ACCEPTED_ON_L1`.
3. L1-originated actions must be captured via `L1HandlerTransaction`, not only via normal `INVOKE` flows.
4. JavaScript `Number` is unsafe for Starknet felts, `u256` amounts, fees, and resource bounds.

## 1. Degenter Operating Model to Preserve

The old Degenter system is not just "an indexer". Its durable design pattern is:

1. Keep process groups explicit:
   - `bin/` for entrypoints
   - `core/` for canonical ingestion, decode, and writes
   - `lib/` for infrastructure adapters
   - `jobs/` for asynchronous enrichment and promotion
   - `api/` for delivery
   - `extras/` and `tools/` for sidecars and repair
2. Separate canonical ingestion from enrichment and delivery.
3. Normalize chain-specific data into relational, queryable, idempotent tables.
4. Publish realtime from canonical writes through Redis and WebSocket fanout.
5. Keep replay and repair tooling as first-class architecture, not operational folklore.

The old system's mistakes must not be inherited:

1. No checkpoint advancement on failed writes.
2. No split-brain holder accounting.
3. No silent batch drops.
4. No unsafe dynamic SQL.
5. No ambiguity between router protocol and execution venue.

## 2. Starknet Constraints That Force Design Changes

Starknet is not "Solana with different RPC names". The protocol shape forces several hard architectural changes.

### 2.1 Felt252, U256, and Precision Rules

1. Addresses, hashes, selectors, and many protocol fields are felts encoded as hex.
2. Token amounts, fees, and resource bounds routinely exceed IEEE-754 safety.
3. `u256` values arrive as `(low, high)` limbs and must be reconstructed exactly.
4. Some protocols emit signed deltas or implicit debit/credit flows that cannot be inferred from floats or snapshots alone.

Mandatory standard:

1. JavaScript `BigInt` is the only allowed numeric runtime type for chain-derived integers.
2. `Number` is forbidden for:
   - token amounts
   - fees
   - nonces
   - resource bounds
   - prices before decimal normalization
   - any felt interpreted as a quantity
3. `Number` is allowed only for bounded local counters such as:
   - array indexes
   - pagination limits
   - `transaction_index`
   - `event_index`
4. In PostgreSQL, all chain-derived quantity columns use `NUMERIC`.
5. Felt-like identifiers that are semantic IDs rather than quantities remain normalized lowercase hex `TEXT`.

### 2.2 Native Account Abstraction

1. Every user account is a contract.
2. Wallet attribution is easier than Solana signer/CPI ambiguity, but proxy and upgrade patterns still matter.
3. ABI selection cannot be address-only; class-hash history matters.

### 2.3 Finality Tiers and Reconciliation Risk

Official Starknet transaction statuses now distinguish:

1. `PRE_CONFIRMED`
2. `ACCEPTED_ON_L2`
3. `ACCEPTED_ON_L1`

Design implication:

1. `PRE_CONFIRMED` is a preview lane only.
2. `ACCEPTED_ON_L2` is the live canonical analytics lane.
3. `ACCEPTED_ON_L1` is the irreversible anchor.
4. An `ACCEPTED_ON_L2` block that never anchors on L1 must be treated as orphanable and therefore reconcilable.

This is not theoretical. Official Starknet messaging and StarkGate docs make clear that L1-to-L2 correctness is ultimately enforced when the state update reaches Ethereum; if an invalid message or invalid state transition exists, the update fails to anchor on L1.

### 2.4 L1-L2 Messaging and L1 Handlers

Starknet bridge flows are not only ordinary `INVOKE` transactions.

1. L1-to-L2 messages materialize on L2 as `L1HandlerTransaction`.
2. The first calldata element of an L1 handler is the L1 sender address.
3. Bridge deposits such as StarkGate deposits are therefore visible on L2 even when the initiating action happened on Ethereum.
4. L2-to-L1 activity appears in receipts as `messages_sent`.

Design implication:

1. Wallet, whale, and bridge analytics must index both:
   - `L1HandlerTransaction`
   - `messages_sent`
2. DEX-only event parsing is insufficient for complete asset flow accounting.

### 2.5 Ekubo Receipt Complexity

Ekubo is not a simple "one event equals one trade" protocol.

1. Core is a singleton.
2. Pool identity is composite:
   - `token0`
   - `token1`
   - `fee`
   - `tick_spacing`
   - `extension`
3. Its lock/callback execution model can emit multiple interdependent events inside one receipt:
   - swaps
   - fee accruals
   - liquidity updates
   - withdrawals
4. These events must be interpreted in receipt-emission order to maintain correct pool and wallet deltas.

Design implication:

1. StarknetDeg needs an explicit receipt-local Event Sequencer.
2. Ekubo decoding must run as a receipt state machine, not as independent event handlers.

## 3. External Research Signals

### 3.1 Apibara

What matters:

1. Apibara's Starknet stream exposes:
   - blocks
   - transactions
   - receipts
   - events
   - messages
   - contract changes
2. It exposes `L1HandlerTransaction` and `MessageToL1` as first-class typed data.
3. It can stream with `pending`, `accepted`, or `finalized` style finality options.
4. Its indexers are reorg-aware by default and can surface explicit invalidation notifications through `message:invalidate`.
5. Its Starknet data model includes transaction and event indices, plus receipt access, which is exactly the pattern needed for receipt-local replay.

Lesson for StarknetDeg:

1. Keep our own storage and schema.
2. Borrow Apibara's invalidation mindset:
   - persist block hash with cursor
   - detect divergence quickly
   - invalidate and replay only the affected window
3. Borrow its message-first bridge model:
   - L1 handlers are bridge inputs
   - L2-to-L1 messages are bridge outputs

### 3.2 DipDup

What matters:

1. DipDup exposes an `on_index_rollback` hook for chain reorg handling.
2. It defaults to database rollback on index rollback.
3. It also has an explicit `rollback_depth` concept.
4. Its storage layer documents copy-on-write rollback support.

Lesson for StarknetDeg:

1. Do not full-reindex for every divergence.
2. Maintain a bounded rollback window from the last `ACCEPTED_ON_L1` anchor.
3. Rebuild only the orphaned live window.
4. Keep rollback logic in core architecture, not as an ops script.

### 3.3 DEX Code Research

#### Ekubo

Observed from the public repo:

1. Core is a singleton contract.
2. Pool identity is composite, not address-only.
3. Core emits:
   - `PoolInitialized`
   - `Swapped`
   - `PositionUpdated`
   - `PositionFeesCollected`
   - `FeesAccumulated`
4. The repo exposes upgrade support through class replacement interfaces.

Design impact:

1. ABI versioning by `class_hash` is mandatory.
2. Pool state must be keyed by composite pool key.
3. Decoder output must be receipt-aware and ordered.

#### JediSwap

Observed from the public repo:

1. Factory/pair architecture.
2. Pair emits:
   - `Mint`
   - `Burn`
   - `Swap`
   - `Sync`
   - LP token `Transfer`
3. It maps cleanly to XYK intuition and is the simplest early trading target.

Design impact:

1. JediSwap should be included from Phase 2.
2. It is the best early benchmark for trade correctness and pool-state validation.

#### AVNU

Observed from the public repo:

1. AVNU is a router and adapter-based execution layer.
2. It emits router-level events such as:
   - `Swap`
   - `OptimizedSwap`
3. It can route into multiple downstream venues.

Design impact:

1. AVNU must be stored as `router_protocol`.
2. Underlying venue should be derived from route or downstream venue evidence and stored as `execution_protocol`.

## 4. Unified Architecture Specification

### 4.1 Target Folder Structure

```text
StarknetDeg/
|-- roadmap.md
|-- package.json
|-- .env.example
|-- sql/
|   |-- 001_foundation.sql
|   |-- 002_registry_and_raw.sql
|   |-- 003_trading.sql
|   |-- 004_metadata_and_security.sql
|   |-- 005_realtime.sql
|   |-- 006_analytics.sql
|   `-- 007_bridge_messaging.sql
|-- bin/
|   |-- start-indexer.js
|   |-- start-preconfirmed.js
|   |-- start-jobs.js
|   |-- start-alerts.js
|   `-- start-api.js
|-- core/
|   |-- checkpoint.js
|   |-- finality.js
|   |-- reconciliation.js
|   |-- block-processor.js
|   |-- event-sequencer.js
|   |-- event-router.js
|   |-- bridge.js
|   |-- abi-registry.js
|   |-- normalize.js
|   |-- trades.js
|   |-- pool-state.js
|   |-- prices.js
|   |-- ohlcv.js
|   |-- holders.js
|   |-- realtime.js
|   `-- protocols/
|       |-- base-amm.js
|       |-- ekubo.js
|       |-- avnu.js
|       |-- haiko.js
|       |-- myswap.js
|       |-- erc20.js
|       `-- shared.js
|-- lib/
|   |-- db.js
|   |-- redis.js
|   |-- log.js
|   |-- cache.js
|   |-- batch.js
|   |-- starknet-rpc.js
|   |-- registry/
|   |   `-- dex-registry.js
|   `-- cairo/
|       |-- bigint.js
|       |-- felt.js
|       |-- u256.js
|       |-- selector.js
|       |-- abi.js
|       |-- address.js
|       `-- signed.js
|-- jobs/
|   |-- abi-refresh.js
|   |-- meta-refresher.js
|   |-- security-scanner.js
|   |-- eth-price-feed.js
|   |-- finality-promoter.js
|   |-- bridge-accounting.js
|   |-- wallet-rollups.js
|   |-- matrix-rollups.js
|   |-- leaderboards.js
|   `-- concentration-rollups.js
|-- api/
|   |-- server.js
|   |-- ws.js
|   |-- controllers.js
|   |-- serializers/
|   |   `-- starknet.js
|   `-- routes/
|       |-- tokens.js
|       |-- pools.js
|       |-- trades.js
|       |-- holders.js
|       |-- candles.js
|       |-- wallet.js
|       |-- bridge.js
|       `-- alerts.js
|-- data/
|   |-- registry/
|   |   |-- contracts.json
|   |   `-- tokens.json
|   `-- abi/
|       |-- ekubo/
|       |-- jediswap/
|       |-- avnu/
|       `-- erc20/
|-- extras/
|   `-- ethereum/
|       `-- bridge-watcher.js
`-- tools/
    |-- replay-window.js
    |-- reconcile-window.js
    |-- backfill-bridge.js
    `-- verify-abis.js
```

Why these additions matter:

1. `core/event-sequencer.js` exists because Starknet receipts, especially Ekubo, are order-sensitive.
2. `core/reconciliation.js` exists because `ACCEPTED_ON_L2` data must be rewindable until anchored on L1.
3. `core/bridge.js`, `jobs/bridge-accounting.js`, and `sql/007_bridge_messaging.sql` exist because L1-L2 activity is part of wallet truth.
4. `lib/cairo/bigint.js` exists to ban accidental precision loss at the utility layer.
5. `lib/registry/dex-registry.js` exists so DEX coverage grows by registry updates instead of router rewrites.

### 4.2 ABI Versioning and Upgradeable Contracts

StarknetDeg keeps the Degenter heritage of explicit registries, but ABI resolution must be stronger than the Solana generation.

Rules:

1. ABI lookup is keyed by `class_hash`, not only by contract address.
2. Contract registry stores:
   - `contract_address`
   - `protocol`
   - `role`
   - `current_class_hash`
   - `first_seen_block`
   - `last_seen_block`
3. Replaced class events and state updates create a new ABI version boundary.
4. Raw decode stores both:
   - `emitter_address`
   - `resolved_class_hash`
5. Replays must decode historical events against the ABI valid at that block, not the latest ABI.

### 4.3 Numeric and Type Standard

Hard standard:

1. All `lib/cairo/*` helpers return either normalized hex `string` identifiers or `bigint` quantities.
2. No helper may return JS `number` for chain-derived quantities.
3. All SQL schema files use `NUMERIC` for:
   - token amounts
   - fees
   - resource bounds
   - prices
   - TVL
   - turnover
   - PnL
4. `BIGINT` is reserved only for local bounded counters and synthetic row ids.
5. The DB boundary converts `bigint` to string before parameterized insert, so the database receives exact decimal text for `NUMERIC`.

## 5. Canonical Data Normalization Path

The canonical pipeline is:

1. Fetch `starknet_getBlockWithReceipts` for transaction, receipt, event, fee, and message data.
2. Fetch `starknet_getStateUpdate` for:
   - `old_root`
   - `new_root`
   - class replacements
   - deployments
3. Write raw and control-plane rows in one DB transaction.
4. Materialize a receipt-local event sequence for each transaction.
5. Route ordered events to protocol decoders.
6. Emit normalized actions.
7. Derive transfers, trades, pool state, price ticks, and holder deltas.
8. Update current-state tables.
9. Publish realtime only after canonical DB commit.

### 5.1 Raw and Control Tables

Minimum control-plane tables:

1. `stark_index_state`
2. `stark_l1_finality_state`
3. `stark_reconciliation_log`
4. `stark_block_journal`
5. `stark_block_state_updates`

Minimum raw tables:

1. `stark_tx_raw`
2. `stark_event_raw`
3. `stark_message_l1_to_l2`
4. `stark_message_l2_to_l1`

Minimum normalized tables:

1. `stark_action_norm`
2. `stark_transfers`
3. `stark_trades`
4. `stark_pools`
5. `stark_pool_state`
6. `stark_prices`
7. `stark_price_ticks`
8. `stark_ohlcv_1m`
9. `stark_wallet_activities`
10. `stark_holder_balance_deltas`
11. `stark_holder_balances`
12. `stark_bridge_activities`

### 5.2 Ordered Event Processing

`core/block-processor.js` must not hand events to decoders in arbitrary order.

Required flow:

1. For every receipt, assign `receipt_event_index` from the event's position in the receipt event array.
2. Persist raw rows with:
   - `block_number`
   - `block_hash`
   - `transaction_index`
   - `transaction_hash`
   - `receipt_event_index`
   - `emitter_address`
   - `keys`
   - `data`
3. `core/event-sequencer.js` sorts by:
   - `transaction_index`
   - `receipt_event_index`
4. `core/event-router.js` routes the ordered stream to protocol decoders.
5. Ekubo decoder runs with a receipt-local context object so later callback events can update the interpretation of earlier swap/liquidity intent.

For Ekubo specifically:

1. Receipt context opens on first Ekubo-core event for that transaction.
2. Swaps, liquidity mutations, fees, and withdrawals are accumulated in order.
3. The decoder emits normalized actions only when receipt-local invariants are satisfied.
4. Pool state is updated after the full receipt-local sequence is evaluated, not after each isolated event.

### 5.3 Unified Holder Accounting

The old split-brain holder problem is fixed with one source of truth:

1. `stark_holder_balance_deltas` is the canonical mutation ledger.
2. `stark_holder_balances` is the current materialized state.
3. Every balance change, regardless of origin, enters through the same normalization path:
   - ERC-20 transfers
   - LP token mint/burn
   - bridge deposits via `L1HandlerTransaction`
   - bridge withdrawals via L2-to-L1 messages and burns
   - protocol-specific fee collection
4. No parallel holder job is allowed to mutate balances outside this ledger.

This gives a bounded rollback path:

1. Delete orphaned deltas.
2. Recompute current balances from the last safe anchor plus surviving deltas.

## 6. Multi-Chain Delta Analysis

### 6.1 ZigChain -> Starknet

Old ZigChain logic was key-value and event-record oriented.

1. Decoding often meant reading structured event attributes or KV pairs.
2. Identity and amounts were relatively direct after attribute extraction.

Starknet is different:

1. Events arrive as `keys[]` and `data[]`.
2. Event meaning depends on:
   - selector in `keys[0]`
   - ABI layout
   - class hash
   - receipt order
3. Many values are felts or split `u256` values.

Translation:

1. ZigChain parsers were attribute mappers.
2. Starknet parsers are selector-and-ABI decoders with strict numeric reconstruction.

### 6.2 Solana -> Starknet

Old Solana logic was instruction-centric.

1. The parser cared about transaction instructions, CPI chains, program ownership, and account arrays.
2. Semantics were often inferred from instruction trees plus token balance changes.

Starknet is more receipt-and-event centric.

1. Primary truth comes from receipts and emitted events.
2. Transaction calldata still matters, but event streams are the main decode surface.
3. L1-originated actions arrive as `L1HandlerTransaction`, which has no direct Solana analog.

Translation:

1. Solana parser = instruction graph interpreter.
2. Starknet parser = ordered receipt event interpreter with message-awareness.

## 7. Phased Implementation Roadmap

## Phase 1: Foundation (Pipeline, RPC, and Reconciliation)

### Core objectives

1. Build reliable block ingestion around:
   - `starknet_getBlockWithReceipts`
   - `starknet_getStateUpdate`
2. Persist strict checkpoints only after a successful DB transaction.
3. Introduce three lanes:
   - `PRE_CONFIRMED` preview
   - `ACCEPTED_ON_L2` canonical-but-reconcilable
   - `ACCEPTED_ON_L1` irreversible anchor
4. Implement ordered receipt processing in `core/block-processor.js`.
5. Capture block roots and parent hashes for later reconciliation.
6. Establish the BigInt/NUMERIC precision standard from day one.

### Key files

1. `sql/001_foundation.sql`
2. `sql/002_registry_and_raw.sql`
3. `bin/start-indexer.js`
4. `bin/start-preconfirmed.js`
5. `core/checkpoint.js`
6. `core/finality.js`
7. `core/reconciliation.js`
8. `core/block-processor.js`
9. `core/event-sequencer.js`
10. `lib/starknet-rpc.js`
11. `lib/cairo/bigint.js`
12. `lib/cairo/felt.js`
13. `lib/cairo/u256.js`

### Security and integrity guardrails

1. No checkpoint advancement on:
   - RPC failure
   - decode failure
   - DB failure
   - publish failure inside the canonical transaction path
2. Every canonical block write stores:
   - `block_hash`
   - `parent_block_hash`
   - `old_root`
   - `new_root`
   - `finality_status`
3. `PRE_CONFIRMED` data never writes into canonical analytics tables.
4. `ACCEPTED_ON_L2` data is replayable until promoted or reconciled.
5. Every on-chain quantity is parsed with `BigInt` before any business logic runs.
6. All SQL writes are parameterized.
7. Reverted transactions are filtered from DEX and bridge business facts.

### Finality reconciliation model

`jobs/finality-promoter.js` now owns a Reconciliation Layer.

Responsibilities:

1. Monitor the gap between:
   - latest `ACCEPTED_ON_L2`
   - latest `ACCEPTED_ON_L1`
2. Detect divergence through:
   - parent-hash mismatch
   - state-root mismatch
   - missing L1 anchor beyond policy threshold
3. If an `ACCEPTED_ON_L2` block is orphaned before L1 anchoring:
   - mark the window as invalid in `stark_reconciliation_log`
   - delete orphaned normalized rows for the affected window
   - rebuild from the last `ACCEPTED_ON_L1` anchor using surviving raw rows
4. Recompute:
   - `stark_trades`
   - `stark_transfers`
   - `stark_pool_state`
   - `stark_prices`
   - `stark_ohlcv_1m`
   - `stark_holder_balance_deltas`
   - `stark_holder_balances`

This is the StarknetDeg equivalent of Apibara invalidation plus DipDup rollback depth, but kept under our own storage contract.

## Phase 2: The Decoder Engine

### Core objectives

1. Decode ordered Starknet events into protocol-normalized actions.
2. Support:
   - Ekubo singleton receipts
   - AVNU aggregator events
   - JediSwap V1 XYK pairs
   - JediSwap V2 CLMM pools
   - 10KSwap XYK pairs
   - mySwap V1 fixed-pool swaps
   - SithSwap volatile/stable pairs
   - Haiko market-manager events
   - ERC-20 `Transfer`
3. Recognize `L1HandlerTransaction` in `core/event-router.js` and classify eligible flows as `bridge_in`.
4. Resolve router-vs-execution attribution where AVNU routes into downstream venues.
5. Keep unresolved protocols such as Ammos, mySwap V2, Nostra, and StarkDeFi in a catalog-only registry state until verified mainnet program IDs exist.

### Key files

1. `core/event-router.js`
2. `core/bridge.js`
3. `lib/registry/dex-registry.js`
3. `core/protocols/ekubo.js`
4. `core/protocols/base-amm.js`
5. `core/protocols/avnu.js`
6. `core/protocols/haiko.js`
7. `core/protocols/myswap.js`
8. `core/protocols/erc20.js`
9. `core/protocols/shared.js`
10. `data/registry/contracts.json`
11. `data/abi/ekubo/*`
12. `data/abi/avnu/*`
13. `data/abi/erc20/*`

### Security and integrity guardrails

1. Event routing always consumes receipt-ordered streams, never unordered block scans.
2. Ekubo decoder uses receipt-local context and emits final normalized actions only after sequence completion.
3. `L1HandlerTransaction` rows are never ignored; they are classified as:
   - `bridge_in`
   - `protocol_internal`
   - `unknown_l1_handler`
4. Unknown selectors or ABI mismatches are stored for audit, not silently dropped.
5. AVNU is never treated as pool-state truth if downstream venue evidence exists.
6. The router first matches by `from_address`, then `class_hash`, then dynamic pair probing before classifying an event as unknown.

## Phase 3: Persistence Layer

### Core objectives

1. Create optimized PostgreSQL schemas for:
   - raw chain data
   - normalized transfers
   - normalized trades
   - 1m OHLCV
   - latest prices and price ticks
   - holder deltas and holder balances
2. Partition write-heavy tables by block window or time bucket.
3. Store enough lineage to enable bounded rollback and replay.

### Key files

1. `sql/003_trading.sql`
2. `core/trades.js`
3. `core/pool-state.js`
4. `core/prices.js`
5. `core/ohlcv.js`
6. `core/holders.js`

### Security and integrity guardrails

1. All on-chain quantities use `NUMERIC`, never float types.
2. Every derived row stores lineage fields:
   - `block_number`
   - `block_hash`
   - `transaction_hash`
   - `transaction_index`
   - `source_event_index`
3. Primary keys are idempotent and replay-safe.
4. Pool state updates are upserts scoped by pool identity and block lineage.
5. Holder balances are derived from deltas, not written ad hoc by side jobs.
6. Aggregator route legs are excluded from `stark_trades` while still being available for pool-state truth.

## Phase 4: Enrichment and Metadata

### Core objectives

1. Resolve token metadata from on-chain calls:
   - `name()`
   - `symbol()`
   - `decimals()`
   - `totalSupply()`
2. Refresh ABI mappings on class-hash changes.
3. Add off-chain protocol metadata and security scoring.

### Key files

1. `sql/004_metadata_and_security.sql`
2. `jobs/abi-refresh.js`
3. `jobs/meta-refresher.js`
4. `jobs/security-scanner.js`
5. `jobs/eth-price-feed.js`
6. `data/registry/contracts.json`
7. `tools/verify-abis.js`

### Security and integrity guardrails

1. Metadata calls are cached and retried outside canonical transactions.
2. Security scoring is advisory only and never mutates canonical trade truth.
3. ABI refresh is triggered by detected class replacement, not only manual registry edits.
4. Registry writes are auditable and append-only where possible.

## Phase 5: Realtime API and WebSocket Layer

### Core objectives

1. Expose token, pool, trade, candle, holder, wallet, and bridge data over REST.
2. Publish sub-second to low-second updates over Redis and WebSocket.
3. Separate preview streams from canonical streams.

### Key files

1. `sql/005_realtime.sql`
2. `core/realtime.js`
3. `api/server.js`
4. `api/ws.js`
5. `api/controllers.js`
6. `api/serializers/starknet.js`
7. `api/routes/tokens.js`
8. `api/routes/pools.js`
9. `api/routes/trades.js`
10. `api/routes/holders.js`
11. `api/routes/candles.js`
12. `api/routes/wallet.js`
13. `api/routes/bridge.js`

### Security and integrity guardrails

1. WebSocket rooms are namespaced by:
   - chain
   - stream type
   - finality tier
2. `PRE_CONFIRMED` events are explicitly labeled preview data.
3. Canonical streams emit `ACCEPTED_ON_L2` rows only.
4. Bridge endpoints distinguish:
   - `bridge_in`
   - `bridge_out`
   - `l1_pending`
   - `l1_anchored`
5. All queries are parameterized.

## Phase 6: Advanced Analytics

### Core objectives

1. Build wallet-level PnL and behavioral analytics.
2. Build whale alerts and concentration metrics.
3. Add L1-L2 message accounting so wallet analytics distinguish:
   - bridge deposits
   - bridge withdrawals
   - DEX trades
   - LP adds/removes
4. Promote `ACCEPTED_ON_L2` windows toward `ACCEPTED_ON_L1` and reconcile if needed.

### Key files

1. `sql/006_analytics.sql`
2. `sql/007_bridge_messaging.sql`
3. `jobs/wallet-rollups.js`
4. `jobs/finality-promoter.js`
5. `jobs/bridge-accounting.js`
6. `jobs/matrix-rollups.js`
7. `jobs/leaderboards.js`
8. `jobs/concentration-rollups.js`
9. `extras/ethereum/bridge-watcher.js`

### Security and integrity guardrails

1. Wallet PnL excludes pure bridge inflows and outflows from trade PnL.
2. Whale alerts can trigger on:
   - large swaps
   - large bridge deposits
   - large bridge withdrawals
   - concentration changes
3. `finality-promoter.js` never promotes a window with root mismatch or broken parent continuity.
4. Bridge-sensitive analytics can require `ACCEPTED_ON_L1` when configured.
5. All alert generation references canonical lineage so orphaned rows can be revoked.

### L1-L2 accounting model

V1 accounting logic:

1. `L1HandlerTransaction` + recognized bridge selectors -> `bridge_in`
2. Receipt `messages_sent` + recognized bridge/message patterns -> `bridge_out`
3. `extras/ethereum/bridge-watcher.js` is an optional but recommended correlation sidecar for:
   - StarkGate L1 `Deposit` events
   - final L1 `withdraw` completion
4. `stark_bridge_activities` stores:
   - direction
   - token
   - amount
   - l1_sender or l1_recipient when known
   - l2_wallet
   - message hash when available
   - L2 block lineage
   - L1 correlation fields when sidecar is enabled

This is enough to keep whale and wallet analytics honest even when value enters from Ethereum instead of from a DEX trade.

## 8. Risk Mitigation and Integrity Standards

### 8.1 Finality Policy

1. `PRE_CONFIRMED`
   - Preview only
   - Never mutates canonical analytics tables
   - May be published on preview WebSocket channels
2. `ACCEPTED_ON_L2`
   - Canonical live market-data lane
   - May power trades, prices, holders, and wallet analytics
   - Must remain replayable until L1 anchoring
3. `ACCEPTED_ON_L1`
   - Irreversible anchor
   - Required for proof-backed exports, bridge settlement reporting, and strict audit views

### 8.2 P0 Standards

These are non-negotiable:

1. No checkpoint advancement on DB failure.
2. Mandatory SQL parameterization.
3. Reverted transaction filtering for business facts.
4. `BigInt`-only handling for Starknet quantities in application logic.
5. `NUMERIC` for persisted chain-derived quantities.
6. Ordered receipt processing before protocol decode.
7. ABI resolution by `class_hash`.
8. Single-source holder accounting through canonical deltas.
9. Reconciliation before irreversible promotion.

### 8.3 Reverted Transaction Rule

Official Starknet docs note that reverted transactions may still emit validation-stage or fee-stage artifacts.

Business rule:

1. Reverted transactions do not create:
   - trades
   - bridge transfers
   - LP actions
   - holder balance deltas
2. Optional fee observability can be stored separately if later needed.

### 8.4 Reconciliation Rule

If an `ACCEPTED_ON_L2` block is later found to diverge before reaching `ACCEPTED_ON_L1`:

1. Stop promotion immediately.
2. Mark the affected block window invalid.
3. Delete orphaned normalized rows for that window.
4. Replay from the last anchored block.
5. Rebuild holders, pool state, prices, candles, wallet stats, and alerts for the surviving chain.

## 9. Why This Achieves Solana Parity Without Copying Solana Blindly

Feature parity achieved:

1. Canonical block pipeline with strict checkpointing.
2. Protocol-aware decode and normalized trade rows.
3. Pool state, latest prices, price ticks, and 1m OHLCV.
4. Realtime API and WebSocket fanout.
5. Holder balances, wallet analytics, whale alerts, and concentration metrics.
6. Replay, repair, reconciliation, and ABI refresh tooling.

Starknet-specific strengths captured:

1. Event-first receipts are cleaner than Solana CPI forests for many DEX patterns.
2. Native account abstraction improves wallet attribution.
3. `PRE_CONFIRMED` enables an explicit preview lane.
4. `L1HandlerTransaction` gives direct visibility into bridge inflows on L2.
5. `ACCEPTED_ON_L1` gives a clean irreversible tier for bridge-aware reporting.
6. Class-hash-aware ABI versioning makes upgradeability an explicit design concern instead of a blind spot.

## 10. Final Recommendation

Build StarknetDeg as a dedicated Starknet engine that preserves Degenter's operating model, not as a cosmetic fork of Solana code.

The architectural choices that must remain fixed are:

1. Event-first decode from receipts plus `starknet_getStateUpdate`.
2. Ordered receipt processing with an explicit Event Sequencer.
3. Canonical `ACCEPTED_ON_L2` storage with reconciliation until `ACCEPTED_ON_L1`.
4. ABI registry keyed by `class_hash`.
5. Single-source holder accounting via canonical deltas.
6. First-class bridge tracking through `L1HandlerTransaction` and L2-to-L1 messages.
7. `BigInt` in runtime and `NUMERIC` in storage for all chain-derived quantities.
8. Router-vs-execution attribution for AVNU and future aggregators.

If these eight choices hold, StarknetDeg reaches practical feature parity with the Solana generation of Degenter while being materially safer, more audit-friendly, and more native to Starknet's execution model.

## 11. Reference Links

Legacy Degenter context:

1. `Degenter/docs/solana/docs.md`
2. `Degenter/docs/solana/exp.md`
3. `Degenter/docs/solana/sol2.md`
4. `Degenter/docs/solana/final.md`

Local Starknet planning inputs:

1. `c:\Users\SAR\Downloads\starknet-indexer-plan.docx`
2. `c:\Users\SAR\Downloads\StarkNet_Complete_Technical_Reference.docx`

Official and primary external sources:

1. Starknet transactions: https://docs.starknet.io/learn/protocol/transactions
2. Starknet transaction reference: https://docs.starknet.io/resources/transactions-reference
3. Starknet messaging: https://docs.starknet.io/learn/protocol/messaging
4. Starknet StarkGate docs: https://docs.starknet.io/learn/protocol/starkgate
5. Starknet SNOS docs: https://docs.starknet.io/learn/protocol/snos
6. Apibara Starknet indexers: https://www.apibara.com/docs/getting-started/indexers
7. Apibara Starknet data model: https://www.apibara.com/docs/networks/starknet/data
8. DipDup hooks: https://dipdup.io/docs/getting-started/hooks/
9. DipDup quickstart Starknet: https://dipdup.io/docs/quickstart-starknet/
10. DipDup config file: https://dipdup.io/docs/getting-started/config-file/
11. Ekubo contracts: https://github.com/EkuboProtocol/starknet-contracts
12. JediSwap contracts: https://github.com/jediswaplabs/JediSwap
13. AVNU contracts v2: https://github.com/avnu-labs/avnu-contracts-v2
