# StarknetDeg Phase 2

Date: April 3, 2026  
Scope: Simple English explanation of what Phase 2 does, why it exists, which files were added, and which tables were created.

## 1. What Phase 2 Is

Phase 1 was about one thing:

- fetch blocks safely
- store block-level truth
- move the checkpoint only after commit

Phase 2 is the next step.

Phase 2 takes raw Starknet transaction receipts and turns them into usable business facts.

In simple words:

- Phase 1 tells us "this block exists"
- Phase 2 tells us "this receipt contains a transfer, a swap, a bridge action, or something we do not understand yet"

That is why Phase 2 is called the decoder engine.

## 2. The Main Problem Phase 2 Solves

Starknet data is not immediately ready for analytics.

A block gives us raw transactions and raw events, but not clean business meaning.

For example:

- one receipt can contain many events
- the order of those events matters
- some selectors like `Transfer` or `Swap` are common and can appear in many contracts
- Ekubo is not a simple pair model, so one event alone is often not enough

So if we directly inserted "trade" or "transfer" rows from raw RPC responses without control, we would create wrong business data.

Phase 2 fixes that by doing this:

1. store raw transaction truth
2. store raw event truth
3. store raw message truth
4. route events carefully
5. decode only what we are confident about
6. audit unsupported events instead of guessing

## 3. High-Level Flow

This is the Phase 2 flow in simple terms:

1. a block is fetched
2. raw transactions are written to `stark_tx_raw`
3. raw events are written to `stark_event_raw`
4. raw L2 to L1 messages are written to `stark_message_l2_to_l1`
5. the router loads those raw rows back in receipt order
6. each event is sent to the correct decoder
7. decoders return:
   - normalized actions
   - canonical transfers
   - bridge activities
   - audits
8. those outputs are stored in normalized tables
9. raw rows are marked `PROCESSED`, `UNKNOWN`, `FAILED`, or `SKIPPED_REVERTED`

This is important because raw truth and business truth are not the same thing.

Phase 2 keeps both.

## 4. Very Important Rules In Phase 2

### 4.1 Reverted Transactions Are Stored But Not Promoted

If a Starknet transaction has `execution_status = REVERTED`:

- we still store its raw transaction row
- we still store its raw events
- but we do not create transfers, swaps, or other business facts from it

Why?

Because reverted transactions are real chain history, but they are not successful business execution.

If we ignored this rule:

- fake swaps would appear
- fake transfers would appear
- holder balances would become wrong

### 4.2 Unknown Is Better Than Wrong

If the router cannot justify a decoder route, it does not guess.

Instead:

- the event is written to `stark_unknown_event_audit`
- the raw event is marked `UNKNOWN`

This is the correct behavior.

If we guessed too early:

- unsupported contracts could look like real DEX activity
- balances and analytics would become untrustworthy

### 4.3 Event Order Matters

On Starknet, receipt order matters.

This is especially true for Ekubo.

Ekubo can emit several related events inside the same transaction, and those events only make sense in sequence.

That is why Phase 2 keeps `receipt_event_index` as a first-class field.

Without this:

- Ekubo actions would be fragmented
- multicall decoding would become ambiguous

### 4.4 Verified ERC-20 Only

Phase 2 does not treat every standard-looking `Transfer` event as a confirmed token transfer.

It now checks the emitting token contract against a verified cache.

If the token is verified:

- the transfer is promoted into `stark_transfers`
- a normalized `transfer` action is written into `stark_action_norm`

If the token is not verified:

- no transfer row is inserted
- no normalized transfer action is inserted
- the event is audited as `TRANSFER_UNVERIFIED`

Why?

Because later holder balance logic will depend on `stark_transfers`.

That table must stay clean.

### 4.5 Protocol Context Must Not Leak

Some protocols need receipt context.
Some do not.

Ekubo is the main example that needs context.

So the router now keeps context isolated per protocol.

That means:

- Ekubo context is collected only for Ekubo events
- when the receipt moves from Ekubo to another protocol, the Ekubo context is flushed
- after flush, the old context is cleared

Why?

Because one Starknet transaction can contain mixed protocol activity.

If one shared context were used for the whole transaction:

- Ekubo state could leak into unrelated events
- normalized outputs could become wrong

## 5. Files Added Or Updated In Phase 2

These are the important Phase 2 files:

1. `sql/002_registry_and_raw.sql`
2. `data/registry/contracts.json`
3. `data/registry/known-erc20.json`
4. `core/normalize.js`
5. `core/known-erc20-cache.js`
6. `core/abi-registry.js`
7. `core/event-sequencer.js`
8. `core/event-router.js`
9. `core/bridge.js`
10. `core/protocols/shared.js`
11. `core/protocols/erc20.js`
12. `core/protocols/jediswap.js`
13. `core/protocols/ekubo.js`
14. `core/block-processor.js`

## 6. File-By-File Explanation

### 6.1 `sql/002_registry_and_raw.sql`

This file creates the Phase 2 database tables.

It gives us places to store:

- contract registry data
- raw transactions
- raw events
- raw L2 to L1 messages
- unknown audits
- normalized actions
- canonical transfers
- bridge activities

Without this file, Phase 2 would have no storage model.

### 6.2 `data/registry/contracts.json`

This file stores known protocol contract metadata.

Right now it is especially important for Ekubo.

The router uses it to understand:

- which protocol a contract belongs to
- which decoder should handle it
- which class hash / ABI version is expected

Why this matters:

On Starknet, address alone is not always enough because contracts can be upgradeable.

### 6.3 `data/registry/known-erc20.json`

This file is the verified token list.

It is used for two things:

1. ERC-20 verification before promoting transfers
2. StarkGate token resolution for bridge-ins

It contains:

- verified L2 token addresses
- token metadata like symbol and decimals
- official StarkGate bridge mappings

Without this file, the ERC-20 decoder would be too permissive.

### 6.4 `core/normalize.js`

This file is the low-level Starknet data parser.

It handles things like:

- address normalization
- felt normalization
- `u128`
- `u256`
- signed `i129`
- Ekubo pool key building
- price ratio derivation from `sqrt_ratio`

Every decoder depends on this file.

Why it exists:

We do not want each decoder to invent its own way of parsing Starknet values.

If every decoder parsed values differently:

- addresses could have inconsistent formats
- large numbers could be handled incorrectly
- later joins and analytics would break

### 6.5 `core/known-erc20-cache.js`

This file loads `known-erc20.json` into memory and gives the rest of the system a clean lookup API.

It answers questions like:

- is this token verified?
- what metadata belongs to this token?
- is this bridge pair an official StarkGate pair?
- if this is a StarkGate deposit, which L2 token does it map to?

This keeps ERC-20 logic and bridge logic clean.

### 6.6 `core/abi-registry.js`

This file is the routing brain.

Its job is to decide which decoder should handle an event.

It looks at:

- the event selector
- the emitting address
- the resolved class hash
- registry metadata

Why this matters:

Just because two events share a name does not mean they mean the same thing.

For example:

- many contracts can emit `Transfer`
- many contracts can emit `Swap`

So this file keeps routing conservative.

### 6.7 `core/event-sequencer.js`

This file rebuilds a clean per-transaction view from raw SQL rows.

It:

- loads raw tx rows
- loads raw event rows
- loads raw message rows
- groups them by transaction hash
- sorts events by `receipt_event_index`

The router then works on that clean, ordered structure.

Why this exists:

Decoders should not need to know SQL details.

### 6.8 `core/event-router.js`

This file is the Phase 2 controller.

It takes one block of raw rows and runs the decoding pipeline.

Its job is to:

- skip reverted transactions
- extract bridge facts
- send each event to the correct decoder
- persist decoder outputs
- update raw row statuses

This file does not itself understand every protocol.

Instead, it coordinates the protocol decoders.

It also now does two important safety jobs:

1. keeps receipt context isolated per protocol
2. serializes BigInt safely before JSONB writes

Without this router:

- Phase 2 would have no orchestration layer
- decoders would be disconnected from storage

### 6.9 `core/bridge.js`

This file handles bridge-related activity.

It looks at:

- `L1_HANDLER` transactions for bridge-ins
- `messages_sent` for bridge-outs

It can now do deeper parsing for official StarkGate bridge-ins.

For official StarkGate deposits it can extract:

- token address
- amount
- L2 wallet address

If the bridge is not an official supported StarkGate mapping, it falls back to generic bridge classification.

### 6.10 `core/protocols/shared.js`

This file contains shared helper functions used by decoders.

It handles:

- deterministic keys for actions, transfers, and bridges
- metadata normalization
- BigInt-safe JSON serialization

Why this matters:

All decoders need consistent IDs and consistent metadata handling.

### 6.11 `core/protocols/erc20.js`

This file decodes standard Starknet ERC-20 `Transfer` events.

In simple terms, it does this:

1. read `from` from `keys[1]`
2. read `to` from `keys[2]`
3. read `amount` from `data[0..1]` as `u256`
4. read `token_address` from `event.fromAddress`
5. verify that token against the known ERC-20 cache

If the token is verified:

- it creates one normalized `transfer` action
- it creates one canonical row in `stark_transfers`

If the token is not verified:

- it creates no transfer row
- it creates no action row
- it writes an audit record with reason `TRANSFER_UNVERIFIED`

So this file is the main bridge between raw `Transfer` events and later holder balance logic.

### 6.12 `core/protocols/jediswap.js`

This file handles JediSwap pair events.

Right now it decodes:

- `Swap`
- `Mint`
- `Burn`
- `Sync`

It converts those into normalized actions in `stark_action_norm`.

This file is more direct than Ekubo because JediSwap is an XYK-style pair model.

### 6.13 `core/protocols/ekubo.js`

This file is the most complex decoder in Phase 2.

Ekubo is not a simple pair-per-pool design.

Because of that, this decoder cannot always turn one event into one final business action immediately.

So this file does two separate jobs:

1. it parses raw Ekubo events
2. it stores receipt-local state in a protocol context

It understands events like:

- `Swapped`
- `PositionUpdated`
- `PoolInitialized`
- `FeesAccumulated`
- `PositionFeesCollected`
- `SavedBalance`
- `LoadedBalance`

How it works:

- when a `Swapped` event arrives, it parses it and stores it in ordered context
- when a `PositionUpdated` event arrives, it also stores it in context
- other Ekubo events add supporting context
- when the router reaches the end of the Ekubo segment, `flushReceiptContext()` turns that buffered context into final normalized actions

So this file is not just a parser.
It is a receipt-aware semantic decoder.

Why this design was needed:

If we emitted Ekubo actions immediately from every single event:

- lock/callback flows would lose meaning
- related events would not stay connected
- later analytics would be weaker

## 7. Tables Created In Phase 2

Phase 2 creates these tables:

1. `stark_contract_registry`
2. `stark_tx_raw`
3. `stark_event_raw`
4. `stark_message_l2_to_l1`
5. `stark_unknown_event_audit`
6. `stark_action_norm`
7. `stark_transfers`
8. `stark_bridge_activities`

## 8. Table Explanation In Simple English

### 8.1 `stark_contract_registry`

This table stores known contract metadata.

It tells the router:

- which contract belongs to which protocol
- which decoder should be used
- which class hash / ABI version is expected

Important columns:

- `contract_address`
- `class_hash`
- `protocol`
- `role`
- `decoder`
- `abi_version`
- `valid_from_block`
- `valid_to_block`
- `metadata`

### 8.2 `stark_tx_raw`

This is the raw transaction table.

It stores:

- transaction hash
- tx type
- execution status
- finality status
- sender / contract / L1 sender info
- calldata
- full raw transaction JSON
- full raw receipt JSON

Important columns:

- `lane`
- `block_number`
- `block_hash`
- `transaction_index`
- `transaction_hash`
- `tx_type`
- `execution_status`
- `finality_status`
- `sender_address`
- `contract_address`
- `l1_sender_address`
- `actual_fee_amount`
- `calldata`
- `raw_transaction`
- `raw_receipt`
- `normalized_status`

### 8.3 `stark_event_raw`

This is the raw event table.

It stores every receipt event exactly as seen, plus event order.

Important columns:

- `transaction_hash`
- `receipt_event_index`
- `from_address`
- `selector`
- `resolved_class_hash`
- `keys`
- `data`
- `raw_event`
- `normalized_status`

This table is very important because Phase 2 decoding is built on it.

### 8.4 `stark_message_l2_to_l1`

This stores raw L2 to L1 messages.

It is mainly used for bridge-out tracking.

Important columns:

- `transaction_hash`
- `message_index`
- `from_address`
- `to_address`
- `payload`
- `raw_message`

### 8.5 `stark_unknown_event_audit`

This table stores events we did not promote into business truth.

This includes cases like:

- `NO_DECODER_ROUTE`
- `TRANSFER_UNVERIFIED`
- shape mismatch audits

Important columns:

- `transaction_hash`
- `source_event_index`
- `emitter_address`
- `selector`
- `reason`
- `metadata`

This table is the backlog for future decoder expansion.

### 8.6 `stark_action_norm`

This is the general normalized business-action table.

It stores actions like:

- transfers
- swaps
- mints
- burns
- bridge_in
- bridge_out
- position updates

Important columns:

- `action_key`
- `protocol`
- `action_type`
- `account_address`
- `pool_id`
- `token0_address`
- `token1_address`
- `token_address`
- `amount0`
- `amount1`
- `amount`
- `router_protocol`
- `execution_protocol`
- `metadata`

This is a generic action layer.
It is not yet the final trade table.

### 8.7 `stark_transfers`

This is the canonical token transfer table.

It stores only verified token transfers.

Important columns:

- `transfer_key`
- `token_address`
- `from_address`
- `to_address`
- `amount`
- `protocol`
- `metadata`

Later holder balance logic will be built from this table.

### 8.8 `stark_bridge_activities`

This stores bridge-related actions.

Important columns:

- `bridge_key`
- `direction`
- `l1_sender`
- `l1_recipient`
- `l2_contract_address`
- `l2_wallet_address`
- `token_address`
- `amount`
- `message_to_address`
- `payload`
- `classification`
- `metadata`

This is where official StarkGate bridge-in enrichment now lands.

## 9. What Phase 2 Does Not Create Yet

This is the important answer to your question:

Phase 2 does **not** create a trades table yet.

There is currently:

- `stark_action_norm`
- `stark_transfers`
- `stark_bridge_activities`

There is **no** `stark_trades` table in `sql/002_registry_and_raw.sql`.

That means:

- swaps are currently stored as normalized actions
- trades are not yet materialized into a dedicated trade table
- OHLCV is also not built yet

That work belongs to the next phase.

## 10. What Phase 2 Gives Us Before Phase 3

Before Phase 3 starts, Phase 2 already gives us:

1. a safe raw data layer
2. event order preservation
3. conservative routing
4. ERC-20 verification gating
5. Ekubo receipt-aware decoding
6. JediSwap action decoding
7. bridge activity extraction
8. unknown-event auditing

So Phase 3 does not need to fight raw RPC complexity.

It can build on clean normalized inputs.

## 11. Final Summary

Phase 2 turns StarknetDeg from a raw block ingester into a real decoder engine.

The most important idea is this:

Do not guess business truth from raw chain data too early.

That is why Phase 2:

- stores raw truth first
- routes carefully
- decodes only what it can justify
- audits what it does not understand

And yes, at this stage there is still no dedicated trades table yet.
