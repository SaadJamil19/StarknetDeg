# StarknetDeg Phase 2 Explanation

Date: April 2, 2026  
Scope: Deep conceptual explanation of everything implemented in Phase 2 of StarknetDeg.

## 1. What Phase 2 Is Trying To Solve

Phase 1 solved "safe block ingestion".  
Phase 2 solves "turn raw Starknet events into reliable business actions".

That sounds simple, but on Starknet it is not simple for four reasons:

1. Receipts contain many events inside one transaction.
2. Event order inside a receipt matters.
3. Different protocols emit the same selector names with different shapes.
4. Upgradeable contracts mean address alone is not enough to choose a decoder safely.

So Phase 2 is the point where StarknetDeg stops being only a block journal and becomes a decoder engine.

The core Phase 2 promise is:

1. store raw transaction truth
2. store raw event truth
3. store raw L2 to L1 messaging truth
4. decode only what we can justify
5. leave unknown activity auditable instead of guessing

If Phase 2 guessed aggressively, later phases would be built on fabricated facts.

Examples:

1. If we decoded any `Transfer` selector as ERC-20 without checking shape, fake holder deltas would be created.
2. If we decoded any `Swap` selector as JediSwap, unrelated contracts would produce false trades.
3. If we processed Ekubo events one-by-one without receipt context, a multicall lock flow could be misinterpreted.
4. If we normalized actions from reverted transactions, wallet analytics and balances would become wrong.

So Phase 2 is about controlled decoding, not maximum decoding.

## 2. Starknet-Specific Reality We Designed Around

Phase 2 was designed around Starknet event semantics, not around EVM log assumptions and not around Solana instruction assumptions.

Important protocol facts:

1. Starknet events are emitted as:
   - `from_address`
   - `keys[]`
   - `data[]`
2. `keys[0]` is the event selector.
3. Additional keys may contain indexed fields, but not all contracts use keys the same way.
4. Cairo 0 and Cairo 1 event layouts differ.
5. A transaction may succeed while containing many protocol-level sub-actions.
6. Ekubo especially uses a singleton core and can emit multiple interdependent events inside one receipt.
7. Upgradeable contracts can change `class_hash` over time, so decoder choice must be block-aware.

This creates three decoding layers:

1. raw storage layer
2. routing layer
3. protocol semantic layer

Without separating these layers, debugging becomes impossible.

## 3. The High-Level Phase 2 Pipeline

The implemented Phase 2 flow is:

1. fetch block with receipts and state update
2. validate lineage exactly like Phase 1
3. delete previously derived rows for that `(lane, block_number)` so replay is clean
4. write raw transaction rows into `stark_tx_raw`
5. write raw event rows into `stark_event_raw`
6. write raw L2 to L1 messages into `stark_message_l2_to_l1`
7. sequence events by:
   - block
   - transaction index
   - receipt event index
8. for each transaction:
   - if reverted, mark raw rows as skipped
   - if succeeded, attempt bridge extraction
   - route each event to a decoder if justified
   - decode into normalized actions or transfers
   - write unknowns into audit instead of forcing a decode
9. only after all of that succeeds, advance the checkpoint

This preserves the Phase 1 hard rule:

Checkpoint still moves after all writes succeed, never before.

## 4. The Core Design Principles Of Phase 2

### 4.1 Raw First, Business Later

We do not directly decode from live RPC payload into business tables.

We first persist:

1. raw tx
2. raw events
3. raw messages

Then we decode from our own raw tables.

Why this is correct:

1. replay becomes deterministic
2. decoder bugs can be fixed and blocks re-run
3. audits have a source of truth
4. protocol development no longer depends on re-fetching old RPC data

If we skipped the raw layer:

1. a decoder bug would force live refetch to recover
2. some old data might not be available the same way later
3. debugging would require going back to provider payloads every time

### 4.2 Decode Conservatively

Phase 2 does not try to decode everything.

It decodes only when:

1. selector is recognized
2. protocol route is justified
3. event shape matches expectations

Otherwise, the event becomes audit data.

Why this is correct:

1. unknown is safer than wrong
2. you can expand coverage later
3. false positives are much more dangerous than false negatives

### 4.3 Reverted Transactions Are Stored But Not Promoted

This is one of the most important Phase 2 rules.

If `execution_status != SUCCEEDED`:

1. transaction raw row is kept
2. event raw rows are kept
3. normalized actions are not created
4. transfers are not created
5. bridge activities are not created

Why:

1. reverted transactions are real chain history
2. but they are not successful business execution

If we ignored this:

1. fake transfer rows would appear
2. holder balances would drift
3. fake swaps would pollute trading analytics

### 4.4 Receipt Order Matters

Starknet event order inside a transaction receipt is part of the meaning.

This is especially important for Ekubo because:

1. one receipt can contain several singleton-core actions
2. swaps and liquidity actions can happen inside one lock flow
3. later events may only make sense in the context of earlier events

So Phase 2 uses `receipt_event_index` as a first-class ordering field.

If we ignored order:

1. correlated actions would become ambiguous
2. Ekubo multicalls would be decoded as unrelated fragments
3. downstream pool and wallet analytics would be less trustworthy

### 4.5 Address Alone Is Not Enough

Upgradeable Starknet contracts can change `class_hash`.

So Phase 2 resolves decoder metadata using:

1. emitting address
2. resolved class hash at that block
3. class-hash validity window from the registry

Why:

1. one address can have different ABI/class behavior over time
2. block-time decoding must reflect what was active then, not what is active today

If we used only address:

1. older historical events could be decoded with the wrong ABI version
2. protocol upgrades would silently corrupt historical interpretation

## 5. Files Created Or Updated In Phase 2

Phase 2 introduced or updated these files:

1. `sql/002_registry_and_raw.sql`
2. `data/registry/contracts.json`
3. `core/normalize.js`
4. `core/abi-registry.js`
5. `core/event-sequencer.js`
6. `core/event-router.js`
7. `core/bridge.js`
8. `core/protocols/shared.js`
9. `core/protocols/erc20.js`
10. `core/protocols/jediswap.js`
11. `core/protocols/ekubo.js`
12. `core/block-processor.js` updated
13. `core/checkpoint.js` updated
14. `lib/starknet-rpc.js` updated
15. `bin/start-indexer.js` updated
16. `package.json` updated

Phase 2 also still depends on Phase 1 foundation files:

1. `lib/cairo/bigint.js`
2. `lib/db.js`
3. `core/finality.js`

## 6. File-by-File Explanation

### 6.1 `sql/002_registry_and_raw.sql`

Purpose:

This file creates the Phase 2 schema.

It adds:

1. contract registry storage
2. raw transaction storage
3. raw event storage
4. raw L2 to L1 messaging storage
5. unknown decode audit storage
6. normalized action storage
7. normalized transfer storage
8. bridge activity storage

Why it exists:

1. Phase 1 had only block-level truth
2. Phase 2 needs transaction-level and event-level truth
3. decoders need both raw and normalized layers

If this schema did not exist:

1. we could not replay decoders safely
2. we would have nowhere to store unknown decode evidence
3. holder balances and trades would later have no reliable source layer

### 6.2 `data/registry/contracts.json`

Purpose:

This is the on-disk seed registry for known contracts and class hashes.

In Phase 2 it contains the Ekubo core registry seed.

Why it exists:

1. decoder routing should not depend only on hardcoded addresses in JS files
2. ABI/class metadata should be data-driven where possible
3. this file can grow as StarknetDeg supports more protocols

Why it matters:

1. Ekubo is a singleton model, so its address/class metadata is strategic
2. registry-driven routing is much safer than scattering protocol ids across the codebase

If we skipped this:

1. every new protocol would require code edits only
2. class-hash versioning would be harder to manage
3. ABI evolution would be less visible

### 6.3 `core/normalize.js`

Purpose:

This file centralizes Starknet normalization and low-level numeric decoding.

Main responsibilities:

1. normalize addresses
2. normalize selectors
3. normalize felt arrays
4. parse `u128`
5. parse `u256`
6. parse signed `i129`
7. build Ekubo pool-key ids
8. derive price-ratio metadata from `sqrt_ratio`

Why it exists:

Every Starknet protocol decoder depends on the same rules for:

1. lowercase formatting
2. `0x` prefixes
3. 32-byte padding
4. BigInt-safe numeric parsing

If every decoder did its own formatting:

1. one decoder might store short addresses
2. another might store padded ones
3. joins and analytics would break later

Why `parseI129` matters:

Ekubo uses signed deltas.

If signed decoding is wrong:

1. input and output token direction becomes wrong
2. liquidity deltas become wrong
3. wallet analytics become misleading

Why `sqrtRatioToPriceRatio` exists:

Ekubo price is tied to `sqrt_ratio`.

Phase 2 does not fully finalize price analytics yet, but it preserves exact ratio metadata now so later phases do not need to reverse-engineer it from lossy values.

### 6.4 `core/abi-registry.js`

Purpose:

This file is the routing brain.

Main responsibilities:

1. load the contract registry JSON
2. define known event selectors
3. map selector value to selector name
4. resolve contract metadata by:
   - address
   - class hash
   - block validity window
5. choose which decoder should handle an event
6. sync registry rows into `stark_contract_registry`

Why it exists:

Decoding should not begin inside protocol files.
First we need a safe answer to:

1. what protocol is this event from
2. which ABI/class version was live at that block
3. is this event shape even plausible for that protocol

Why selector-only routing is dangerous:

1. `Transfer` is common across many contracts
2. `Swap` is not unique to JediSwap
3. event names can collide across protocols

That is why Phase 2 tightened routing rules:

1. ERC-20 transfer is decoded only when shape is standard or metadata justifies it
2. JediSwap is decoded only when event shape exactly matches expected Cairo 0 layout or registry metadata justifies it
3. Ekubo uses registry/class-hash based routing

If we routed too loosely:

1. false transfers would be created
2. false swaps would be created
3. unknown contracts would impersonate supported protocols accidentally

### 6.5 `core/event-sequencer.js`

Purpose:

This file loads raw transaction, event, and message rows for one block and reassembles them into transaction-local ordered structures.

Main responsibilities:

1. load raw tx rows
2. load raw event rows
3. load raw message rows
4. group by transaction hash
5. sort events by `receipt_event_index`
6. sort transactions by `transaction_index`

Why it exists:

Decoders should work on an ordered transaction view, not on unstructured SQL fragments.

This layer gives the router a clean unit:

1. one transaction
2. its ordered events
3. its ordered messages
4. its raw status fields

If this layer did not exist:

1. event order logic would be duplicated inside the router
2. each protocol decoder would need raw SQL knowledge
3. code would become harder to maintain

Why sequential query execution was chosen inside this file:

We originally ran parallel queries on one `pg` client, which produced a deprecation warning.
This was corrected.

Why that correction matters:

1. it removes noisy runtime warnings
2. it avoids future incompatibility with `pg@9`
3. it keeps one-client transaction behavior clean

### 6.6 `core/event-router.js`

Purpose:

This file is the normalization orchestrator.

It takes sequenced raw transactions and decides what to do with each event.

Main responsibilities:

1. load one block's sequenced transactions
2. skip normalized fact generation for reverted transactions
3. extract bridge activities
4. route each event to the proper decoder
5. persist normalized actions, transfers, bridges, and audits
6. mark raw tx and raw event rows as:
   - `PROCESSED`
   - `SKIPPED_REVERTED`
   - `FAILED`
   - `UNKNOWN`

Why it exists:

The router is the boundary between raw truth and business truth.

Why the status marking matters:

Raw rows should not remain permanently "unexplained".
We need to know whether an event was:

1. successfully understood
2. deliberately skipped because tx reverted
3. unknown because we do not support it yet
4. failed because a supported decoder found a real mismatch

This distinction is very valuable operationally.

Why `UNKNOWN` is separate from `FAILED`:

1. `UNKNOWN` means unsupported or intentionally not decoded
2. `FAILED` means we tried to decode a supposedly supported thing and it did not fit expectations

This difference is important.

If we merged them:

1. ops could not tell coverage gaps from decoder bugs
2. alerting and triage would be noisy

### 6.7 `core/bridge.js`

Purpose:

This file handles bridge-related extraction from transaction and receipt structure.

Main responsibilities:

1. normalize L2 to L1 messages
2. identify `L1_HANDLER` transactions
3. treat L1 handler transactions as `bridge_in`
4. treat `messages_sent` receipts as `bridge_out`

Why it exists:

Bridge activity is not just another DEX event.
It is partly transaction-type based and partly receipt-message based.

So it deserves a dedicated module.

Why Phase 2 keeps bridge classification generic:

At this phase, we are not fully solving token-level bridge attribution for every bridge protocol.
We are first capturing:

1. direction
2. L1 sender or recipient
3. L2 contract
4. message payload

This is the right order.

If we tried to infer all bridge token semantics too early:

1. unsupported bridges would be misclassified
2. message payload assumptions could be wrong
3. Phase 2 would become brittle

### 6.8 `core/protocols/shared.js`

Purpose:

This file provides decoder-shared helpers.

Main responsibilities:

1. stringify BigInt values for JSON metadata
2. build deterministic primary keys for:
   - actions
   - transfers
   - bridges
3. normalize metadata objects

Why it exists:

Every decoder emits structured results, and those results need:

1. deterministic ids
2. JSON-safe metadata
3. consistent conventions

If every decoder invented its own keys:

1. idempotency would break
2. upserts would be unreliable
3. replay might create duplicates

### 6.9 `core/protocols/erc20.js`

Purpose:

This is the universal ERC-20 transfer decoder.

Main responsibilities:

1. decode standard Starknet `Transfer` events
2. read:
   - `keys[1] = from`
   - `keys[2] = to`
   - `data[0..1] = u256 value`
3. emit one normalized action
4. emit one normalized transfer row

Why it matters:

ERC-20 transfer events are the main source of truth for holder balance deltas in later phases.

This is a major architectural decision:

1. balances should come from actual token transfer truth
2. not from inferred DEX side effects only

Why shape validation matters:

Phase 2 only accepts the standard Starknet ERC-20 event shape.

If we decoded any arbitrary `Transfer` selector:

1. non-token contracts could pollute holder logic
2. balances would become split-brain again

### 6.10 `core/protocols/jediswap.js`

Purpose:

This decoder handles JediSwap pair events.

Supported events:

1. `Swap`
2. `Mint`
3. `Burn`
4. `Sync`

Why JediSwap needs a dedicated module:

1. it is an XYK-style protocol
2. its event shapes are Cairo 0 style
3. it does not share Ekubo's singleton design

Why Phase 2 only emits normalized actions here:

At this stage we want robust semantic extraction first.
Trade tables and pool analytics come later.

This means:

1. swap, mint, burn, sync are captured as normalized actions
2. deeper pricing and OHLCV logic is deferred to later phases

Why shape checks are strict:

JediSwap routing is based on known selector names plus exact shape.

If we were loose:

1. unrelated contracts using a `Swap` selector could become fake JediSwap actions

### 6.11 `core/protocols/ekubo.js`

Purpose:

This is the most conceptually important Phase 2 decoder.

It handles Ekubo singleton-core receipt semantics.

Supported receipt-context tracking:

1. `Swapped`
2. `PositionUpdated`
3. `PoolInitialized`
4. `FeesAccumulated`
5. `PositionFeesCollected`
6. `SavedBalance`
7. `LoadedBalance`

Why Ekubo needed a special design:

Ekubo is not a simple pair contract model.

Its design introduces:

1. singleton core
2. signed deltas
3. lock/callback style flows
4. receipt-local sequences where multiple events belong to one logical operation

So decoding one event in isolation is often not enough.

That is why Phase 2 introduced a `receiptContext`.

What the receipt context does:

1. buffer Ekubo events in receipt order
2. preserve the order of swaps and position updates
3. keep surrounding singleton context such as saved/loaded balances and fee-collection observations
4. flush the buffered business actions only after the transaction's event stream is complete

Why this matters:

If we emitted an Ekubo business action immediately for every raw event:

1. multicall intent could be fragmented
2. related events would lose sequence context
3. future wallet and LP analytics would be harder to reason about

Why signed delta decoding matters:

Ekubo `Delta` values are from core perspective.

If this is misunderstood:

1. swap direction flips
2. liquidity accounting flips
3. price interpretation becomes misleading

Why `sqrt_ratio_after` is stored as metadata-derived price ratio:

1. exact ratio preservation is better than approximate decimal conversion
2. later pricing phases can consume exact values
3. Phase 2 avoids premature lossy math

### 6.12 `core/block-processor.js` Updated

Purpose:

Phase 1 used this file only for block journaling and checkpoint advancement.
Phase 2 upgraded it into a raw-persistence plus decode orchestration layer.

New responsibilities added:

1. resolve event emitter class hashes for the block
2. clear previously derived rows for that block before replay
3. write raw tx rows
4. write raw event rows
5. write raw message rows
6. invoke the Phase 2 router
7. still preserve transactional checkpoint safety

Why replay-safe deletion was added:

If we reprocess a block:

1. raw rows may need replacement
2. normalized rows may need regeneration

So the processor clears block-derived rows for that block before reinserting them.

Why this is correct:

1. it keeps replay deterministic
2. it avoids duplicate normalized facts
3. it allows decoder improvement without corrupting state

Why class hashes are resolved at block processing time:

This gives raw event rows protocol-routing context as early as possible.

If we deferred class hash resolution too late:

1. route decisions would depend more on live lookups
2. repeated decoding would be slower
3. historical ABI reasoning would be weaker

### 6.13 `core/checkpoint.js` Updated

Purpose:

Phase 2 extended checkpoint support with table assertions for the new schema.

New responsibilities:

1. `assertPhase2Tables`
2. reusable table existence assertion logic

Why this matters:

Starting the indexer without Phase 2 tables would lead to:

1. successful startup
2. runtime failure only when the first block is processed

That is bad operator UX.

It is better to fail immediately and explicitly.

### 6.14 `lib/starknet-rpc.js` Updated

Purpose:

Phase 2 added `getClassHashAt`.

Why this matters:

The router needs block-aware class hash resolution.

Without this method:

1. upgradeable contract safety would be weaker
2. protocol routing would depend too much on static address mapping
3. historical ABI correctness would degrade

### 6.15 `bin/start-indexer.js` Updated

Purpose:

The executable loop now starts the Phase 2 stack, not just Phase 1.

New responsibilities:

1. verify Phase 2 tables
2. sync registry seed into DB
3. log decode summary values in block commit output

Why the richer logs matter:

A block log now tells you not only:

1. tx count
2. reverted count
3. L1 handler count

but also:

1. normalized action count
2. transfer count
3. unknown event count

This is important because decoder coverage is now an operational concern.

### 6.16 `package.json` Updated

Purpose:

Phase 2 expanded syntax checks to include all new files.

Why this matters:

1. the codebase is growing
2. routing and decoder logic now spans many files
3. a quick syntax gate prevents avoidable runtime failures

## 7. Phase 2 Database Tables And Column Explanations

Phase 2 creates eight new tables.

## 7.1 `stark_contract_registry`

Purpose:

Stores contract-to-protocol metadata and class-hash versioning information.

Columns:

| Column | Type | Meaning | Why It Exists |
| --- | --- | --- | --- |
| `contract_address` | `TEXT` | normalized Starknet contract address | primary identity of a routed contract |
| `class_hash` | `TEXT` | class hash for that contract version | address alone is insufficient for upgradeable contracts |
| `protocol` | `TEXT` | protocol family such as `ekubo` | high-level routing identity |
| `role` | `TEXT` | contract role such as `core` | some protocols have multiple contract roles |
| `decoder` | `TEXT` | decoder module name | tells router which decoder should handle it |
| `abi_version` | `TEXT` | ABI/version label | supports future ABI evolution |
| `valid_from_block` | `NUMERIC(78,0)` | block at which this metadata becomes active | historical correctness |
| `valid_to_block` | `NUMERIC(78,0)` | block at which this metadata stops being active | historical correctness |
| `metadata` | `JSONB` | extra structured data | future-proof extension field |
| `is_active` | `BOOLEAN` | whether registry row is active | admin/ops visibility |
| `created_at` | `TIMESTAMPTZ` | creation timestamp | auditability |
| `updated_at` | `TIMESTAMPTZ` | update timestamp | auditability |

Primary key:

1. `(contract_address, class_hash)`

Why this key:

1. one address may map to multiple historical class hashes
2. class-hash lineage must remain visible

## 7.2 `stark_tx_raw`

Purpose:

Stores raw transaction and raw receipt truth at transaction granularity.

Columns:

| Column | Type | Meaning | Why It Exists |
| --- | --- | --- | --- |
| `lane` | `TEXT` | finality lane | lane-aware replay and promotion |
| `block_number` | `NUMERIC(78,0)` | containing block number | transaction ordering lineage |
| `block_hash` | `TEXT` | containing block hash | exact lineage |
| `transaction_index` | `NUMERIC(78,0)` | transaction order inside the block | sequencer order |
| `transaction_hash` | `TEXT` | Starknet transaction hash | transaction identity |
| `tx_type` | `TEXT` | `INVOKE`, `DECLARE`, `L1_HANDLER`, etc. | protocol semantics differ by type |
| `finality_status` | `TEXT` | receipt finality status | lane-aware truth |
| `execution_status` | `TEXT` | `SUCCEEDED` or `REVERTED` | business-safety gate |
| `sender_address` | `TEXT` | tx sender if present | wallet attribution |
| `contract_address` | `TEXT` | target contract for tx types that carry it | bridge and protocol context |
| `l1_sender_address` | `TEXT` | first calldata felt for `L1_HANDLER` | bridge-in attribution |
| `nonce` | `TEXT` | nonce value | raw tx observability |
| `actual_fee_amount` | `NUMERIC(78,0)` | exact actual fee amount | fee analytics later |
| `actual_fee_unit` | `TEXT` | fee unit such as `FRI` | exact fee semantics |
| `events_count` | `NUMERIC(78,0)` | number of emitted events | ops visibility |
| `messages_sent_count` | `NUMERIC(78,0)` | count of L2 to L1 messages | bridge visibility |
| `revert_reason` | `TEXT` | receipt revert reason | auditability |
| `normalized_status` | `TEXT` | raw tx decode lifecycle | `PENDING`, `PROCESSED`, `SKIPPED_REVERTED`, `FAILED` |
| `decode_error` | `TEXT` | tx-level decode error summary | operational debugging |
| `calldata` | `JSONB` | normalized calldata array | raw truth for later analysis |
| `raw_transaction` | `JSONB` | full raw transaction payload | replay and forensic storage |
| `raw_receipt` | `JSONB` | full raw receipt payload | replay and forensic storage |
| `created_at` | `TIMESTAMPTZ` | creation time | auditability |
| `updated_at` | `TIMESTAMPTZ` | update time | auditability |
| `processed_at` | `TIMESTAMPTZ` | decode completion time | ops visibility |

Primary key:

1. `(lane, block_number, transaction_hash)`

Why it matters:

1. makes raw tx rows idempotent per lane and block
2. supports replay without duplicate transaction rows

## 7.3 `stark_event_raw`

Purpose:

Stores raw Starknet event truth with ordering metadata.

Columns:

| Column | Type | Meaning | Why It Exists |
| --- | --- | --- | --- |
| `lane` | `TEXT` | finality lane | lane-aware decoding |
| `block_number` | `NUMERIC(78,0)` | containing block | lineage |
| `block_hash` | `TEXT` | containing block hash | lineage |
| `transaction_hash` | `TEXT` | parent transaction | transaction grouping |
| `transaction_index` | `NUMERIC(78,0)` | transaction order | sequencing |
| `receipt_event_index` | `NUMERIC(78,0)` | event order inside receipt | critical for Starknet semantics |
| `finality_status` | `TEXT` | receipt finality | lane-aware truth |
| `transaction_execution_status` | `TEXT` | execution status of parent tx | revert filtering |
| `from_address` | `TEXT` | emitting contract | routing input |
| `selector` | `TEXT` | `keys[0]` selector | routing input |
| `resolved_class_hash` | `TEXT` | class hash at block time when available | ABI/version safety |
| `normalized_status` | `TEXT` | decode lifecycle | `PENDING`, `PROCESSED`, `SKIPPED_REVERTED`, `FAILED`, `UNKNOWN` |
| `decode_error` | `TEXT` | event-level decode issue | auditability |
| `keys` | `JSONB` | normalized event keys | raw truth |
| `data` | `JSONB` | normalized event data | raw truth |
| `raw_event` | `JSONB` | original raw event object | replay and debugging |
| `created_at` | `TIMESTAMPTZ` | creation time | auditability |
| `updated_at` | `TIMESTAMPTZ` | update time | auditability |
| `processed_at` | `TIMESTAMPTZ` | decode completion time | ops visibility |

Primary key:

1. `(lane, block_number, transaction_hash, receipt_event_index)`

Why this key:

1. event order in a Starknet receipt is part of identity
2. duplicate-safe replay requires this exact grain

## 7.4 `stark_message_l2_to_l1`

Purpose:

Stores raw messages emitted from L2 to L1.

Columns:

| Column | Type | Meaning | Why It Exists |
| --- | --- | --- | --- |
| `lane` | `TEXT` | finality lane | lane-aware truth |
| `block_number` | `NUMERIC(78,0)` | containing block | lineage |
| `block_hash` | `TEXT` | containing block hash | lineage |
| `transaction_hash` | `TEXT` | parent transaction | transaction grouping |
| `transaction_index` | `NUMERIC(78,0)` | transaction order | ordering |
| `message_index` | `NUMERIC(78,0)` | message order inside receipt | receipt-local identity |
| `from_address` | `TEXT` | L2 sender address | bridge context |
| `to_address` | `TEXT` | L1 recipient address | bridge context |
| `payload` | `JSONB` | normalized message payload | raw message truth |
| `raw_message` | `JSONB` | original raw message payload | replay/debugging |
| `created_at` | `TIMESTAMPTZ` | creation time | auditability |
| `updated_at` | `TIMESTAMPTZ` | update time | auditability |

Primary key:

1. `(lane, block_number, transaction_hash, message_index)`

Why it matters:

1. bridge messages are distinct objects
2. they need replay-safe identity independent of action tables

## 7.5 `stark_unknown_event_audit`

Purpose:

Stores events or decode situations that were deliberately not promoted into business facts.

Columns:

| Column | Type | Meaning | Why It Exists |
| --- | --- | --- | --- |
| `audit_id` | `BIGSERIAL` | unique audit record id | simple incident identity |
| `lane` | `TEXT` | finality lane | lane-aware audit trail |
| `block_number` | `NUMERIC(78,0)` | block where event occurred | audit context |
| `block_hash` | `TEXT` | block hash | audit context |
| `transaction_hash` | `TEXT` | transaction hash | audit context |
| `transaction_index` | `NUMERIC(78,0)` | tx order | audit context |
| `source_event_index` | `NUMERIC(78,0)` | receipt event index if available | exact event reference |
| `emitter_address` | `TEXT` | event emitter | helps coverage expansion |
| `selector` | `TEXT` | event selector | helps coverage expansion |
| `reason` | `TEXT` | why event was not normalized | key operational signal |
| `metadata` | `JSONB` | structured debug context | decoder triage support |
| `created_at` | `TIMESTAMPTZ` | insert time | auditability |

Why this table matters:

Without it:

1. unknown coverage would disappear silently
2. there would be no structured backlog for decoder expansion
3. ops would not know whether the system is missing real protocol coverage

## 7.6 `stark_action_norm`

Purpose:

This is the general normalized action table.

It stores business facts that are broader than simple transfers.

Examples:

1. Ekubo swaps
2. Ekubo position updates
3. JediSwap swap/mint/burn/sync actions
4. bridge in and bridge out actions
5. ERC-20 transfer actions

Columns:

| Column | Type | Meaning | Why It Exists |
| --- | --- | --- | --- |
| `action_key` | `TEXT` | deterministic action id | idempotent replay |
| `lane` | `TEXT` | finality lane | lane-aware analytics |
| `block_number` | `NUMERIC(78,0)` | block number | ordering |
| `block_hash` | `TEXT` | block hash | lineage |
| `transaction_hash` | `TEXT` | tx hash | grouping |
| `transaction_index` | `NUMERIC(78,0)` | tx order | ordering |
| `source_event_index` | `NUMERIC(78,0)` | event order if tied to a specific event | precise provenance |
| `protocol` | `TEXT` | protocol family | queryability |
| `action_type` | `TEXT` | semantic action type | queryability |
| `emitter_address` | `TEXT` | emitting contract | provenance |
| `account_address` | `TEXT` | wallet/account involved | wallet analytics later |
| `pool_id` | `TEXT` | logical pool id if applicable | DEX analytics later |
| `token0_address` | `TEXT` | first token if applicable | pool context |
| `token1_address` | `TEXT` | second token if applicable | pool context |
| `token_address` | `TEXT` | single-token context if applicable | transfer-style actions |
| `amount0` | `NUMERIC(78,0)` | first amount | exact arithmetic |
| `amount1` | `NUMERIC(78,0)` | second amount | exact arithmetic |
| `amount` | `NUMERIC(78,0)` | single amount field | exact arithmetic |
| `router_protocol` | `TEXT` | router/aggregator if applicable | future aggregation analytics |
| `execution_protocol` | `TEXT` | execution venue/protocol | future venue analytics |
| `metadata` | `JSONB` | detailed structured context | future-proof semantic detail |
| `created_at` | `TIMESTAMPTZ` | creation time | auditability |
| `updated_at` | `TIMESTAMPTZ` | update time | auditability |

Why this table is generic:

1. Phase 2 is about semantic normalization, not yet protocol-specific analytics tables
2. a wide generic action table is a good intermediate layer

## 7.7 `stark_transfers`

Purpose:

Stores canonical token transfers.

This table is the main Phase 2 source for later holder balance logic.

Columns:

| Column | Type | Meaning | Why It Exists |
| --- | --- | --- | --- |
| `transfer_key` | `TEXT` | deterministic transfer id | idempotent replay |
| `lane` | `TEXT` | finality lane | lane-aware truth |
| `block_number` | `NUMERIC(78,0)` | block number | ordering |
| `block_hash` | `TEXT` | block hash | lineage |
| `transaction_hash` | `TEXT` | transaction hash | grouping |
| `transaction_index` | `NUMERIC(78,0)` | tx order | ordering |
| `source_event_index` | `NUMERIC(78,0)` | exact event index | provenance |
| `token_address` | `TEXT` | token contract | holder accounting |
| `from_address` | `TEXT` | sender | holder accounting |
| `to_address` | `TEXT` | recipient | holder accounting |
| `amount` | `NUMERIC(78,0)` | exact transfer amount | exact arithmetic |
| `protocol` | `TEXT` | source decoder family | provenance |
| `metadata` | `JSONB` | structured context | future-proofing |
| `created_at` | `TIMESTAMPTZ` | creation time | auditability |
| `updated_at` | `TIMESTAMPTZ` | update time | auditability |

Why this table is important:

If later holder logic were computed only from DEX actions:

1. balances would miss non-DEX transfers
2. bridge flows would be incomplete
3. wallet truth would become fragmented

So Phase 2 establishes transfer truth explicitly.

## 7.8 `stark_bridge_activities`

Purpose:

Stores normalized bridge-related activity facts.

Columns:

| Column | Type | Meaning | Why It Exists |
| --- | --- | --- | --- |
| `bridge_key` | `TEXT` | deterministic bridge activity id | idempotent replay |
| `lane` | `TEXT` | finality lane | lane-aware truth |
| `block_number` | `NUMERIC(78,0)` | block number | ordering |
| `block_hash` | `TEXT` | block hash | lineage |
| `transaction_hash` | `TEXT` | tx hash | grouping |
| `transaction_index` | `NUMERIC(78,0)` | tx order | ordering |
| `source_event_index` | `NUMERIC(78,0)` | event index if one exists | provenance |
| `direction` | `TEXT` | `bridge_in` or `bridge_out` | semantic classification |
| `l1_sender` | `TEXT` | L1 sender address | bridge-in attribution |
| `l1_recipient` | `TEXT` | L1 recipient address | bridge-out attribution |
| `l2_contract_address` | `TEXT` | relevant L2 contract | bridge attribution |
| `l2_wallet_address` | `TEXT` | wallet-level attribution when available | later wallet analytics |
| `token_address` | `TEXT` | token if known | later enrichment |
| `amount` | `NUMERIC(78,0)` | amount if known | later enrichment |
| `message_to_address` | `TEXT` | target address of message | message tracking |
| `payload` | `JSONB` | message payload | exact raw context |
| `classification` | `TEXT` | bridge classification label | e.g. `l1_handler`, `message_to_l1` |
| `metadata` | `JSONB` | structured extra context | future-proofing |
| `created_at` | `TIMESTAMPTZ` | creation time | auditability |
| `updated_at` | `TIMESTAMPTZ` | update time | auditability |

Why this table is useful even before full bridge enrichment:

1. message movement itself is important
2. wallet tracking benefits from bridge direction detection
3. later phases can enrich token and amount attribution on top

## 8. Why Phase 2 Still Uses `NUMERIC` Everywhere

Phase 2 continues the Phase 1 rule:

All chain-derived quantities use `NUMERIC`.

That includes:

1. block numbers
2. transaction indexes
3. event indexes
4. transfer amounts
5. fee amounts
6. protocol delta fields

Why:

1. Starknet values are not safely representable as JS `Number`
2. `BigInt` is correct in memory
3. `NUMERIC` is correct in Postgres

If we relaxed this rule during decoding:

1. raw truth might remain exact
2. but normalized facts would become lossy
3. downstream analytics would be wrong even though raw storage was correct

## 9. Why Unknown Audit Was Added Instead Of Silent Ignore

Silent ignore is bad engineering for an indexer.

If an event is unsupported, operators and developers should know:

1. what selector was seen
2. which contract emitted it
3. in which block and transaction it happened
4. why it was not normalized

That is why Phase 2 writes unknowns into `stark_unknown_event_audit`.

This gives three benefits:

1. coverage backlog becomes measurable
2. false route attempts become visible
3. protocol expansion can be prioritized by observed real activity

## 10. Why Routing Was Tightened After Smoke Testing

During live smoke testing we found a real issue:

1. generic `Transfer` selectors were too common
2. generic `Swap` selectors were too common
3. loose routing produced false decoder attempts

That was corrected.

The new rule is:

1. standard ERC-20 transfer must match standard Starknet shape or registry metadata
2. JediSwap events must match expected exact shape or registry metadata
3. otherwise they stay `UNKNOWN`

This is a good example of why Phase 2 was built conservatively.

If we had kept the loose route logic:

1. fake action rows would have been created
2. txs would show `FAILED` for unsupported third-party contracts
3. protocol coverage metrics would be misleading

## 11. End-to-End Lifecycle Of One Block In Phase 2

When one block is processed now, the logical sequence is:

1. fetch block and state update
2. validate block/state consistency
3. lock checkpoint row
4. verify parent continuity
5. mark conflicting old same-height rows orphaned
6. delete prior derived rows for this block to ensure replay safety
7. upsert block journal
8. resolve class hashes for unique emitters in the block
9. insert raw tx rows
10. insert raw event rows
11. insert raw message rows
12. load the block back through the sequencer
13. for each tx:
   - skip normalized outputs if reverted
   - extract bridge facts
   - route events
   - decode supported protocol events
   - store unknowns in audit
   - flush Ekubo receipt context
   - mark raw rows with final processing status
14. advance checkpoint
15. commit transaction

This preserves idempotency and replayability.

If any step fails before commit:

1. raw writes roll back
2. normalized writes roll back
3. checkpoint does not move
4. the block can be retried safely

## 12. What Would Go Wrong If These Choices Were Not Made

### Without raw tx/event/message tables

1. decoder replay would be weak
2. auditability would be poor
3. debugging would depend on live RPC refetch

### Without `receipt_event_index`

1. event order would be lost
2. Ekubo multicall interpretation would degrade
3. some later analytics would be ambiguous

### Without reverted filtering

1. false transfers would enter holder state
2. false swaps would enter trade analytics
3. wallet PnL would become unreliable

### Without unknown audit

1. unsupported coverage would disappear silently
2. there would be no clean decoder expansion backlog
3. bugs and gaps would blend together

### Without class-hash-aware routing

1. historical ABI mismatches would occur
2. upgradeable contract decoding would be unsafe
3. protocol upgrades could silently rewrite history

### Without strict route heuristics

1. `Transfer` collisions would create fake token transfers
2. `Swap` collisions would create fake DEX actions
3. action tables would look fuller but be less trustworthy

## 13. What Phase 2 Does Not Fully Solve Yet

Phase 2 intentionally does not finalize:

1. canonical trade table design
2. OHLCV generation
3. price-tick generation
4. holder balance materialization
5. token metadata enrichment
6. full StarkGate-specific token/amount bridge parsing
7. AVNU routing attribution
8. wallet PnL
9. whale alerts
10. websocket fanout

What it does do is create the semantic foundation those phases will rely on.

## 14. Final Summary

Phase 2 transformed StarknetDeg from a safe block ingestor into a real Starknet decoder engine.

What was achieved:

1. raw transaction persistence
2. raw event persistence
3. raw L2 to L1 message persistence
4. receipt-aware ordered sequencing
5. conservative ABI/class-hash-aware routing
6. ERC-20 transfer normalization
7. JediSwap action normalization
8. Ekubo receipt-context decoding
9. bridge-in and bridge-out activity extraction
10. unknown-event audit trail
11. replay-safe block reprocessing
12. checkpoint safety preserved end to end

The main design principle of Phase 2 was:

Do not confuse unsupported activity with decoded activity, and do not confuse raw truth with business truth.

That is why the phase stores more than it normalizes, routes cautiously, and treats `UNKNOWN` as a first-class operational outcome instead of a failure.
