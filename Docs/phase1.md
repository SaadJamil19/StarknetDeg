# StarknetDeg Phase 1 Explanation

Date: April 2, 2026  
Scope: Deep conceptual explanation of everything implemented in Phase 1 of StarknetDeg.

## 1. What Phase 1 Is Trying To Solve

Phase 1 is not the "DEX intelligence" phase. It is the "do not corrupt chain truth" phase.

Before we decode Ekubo, JediSwap, AVNU, holders, candles, or analytics, we need a base layer that guarantees five things:

1. We can talk to Starknet reliably.
2. We can store block lineage safely.
3. We never lose precision on Starknet numbers.
4. We never advance checkpoint after a failed write.
5. We can detect if the live L2 chain later needs reconciliation.

If Phase 1 is weak, every later phase becomes unreliable.

Example:

1. If checkpoint moves before DB commit, one failed insert can permanently skip a block.
2. If we use JavaScript `Number` for Starknet amounts, balances and fees can silently become wrong.
3. If we do not store `parent_hash`, `old_root`, and `new_root`, we cannot prove whether a later block belongs to the same canonical chain.
4. If we do not recognize `REVERTED` receipts, later phases may index fake trades or fake transfers from failed transactions.

So Phase 1 is about correctness before features.

## 2. Starknet-Specific Reality We Designed Around

Phase 1 was built from Starknet JSON-RPC behavior, not from generic EVM assumptions.

Important protocol facts:

1. `starknet_blockNumber` gives the latest accepted Starknet block number.
2. `starknet_getBlockWithReceipts` returns:
   - block header data
   - full transactions
   - full receipts
   - per-transaction `finality_status`
   - per-transaction `execution_status`
3. `starknet_getStateUpdate` returns:
   - `old_root`
   - `new_root`
   - state diff
   - class replacements and deployments
4. Starknet transaction finality is not just one flag. We must reason about:
   - `PRE_CONFIRMED`
   - `ACCEPTED_ON_L2`
   - `ACCEPTED_ON_L1`
5. A transaction can be accepted by the chain but still have `execution_status = REVERTED`.

That last point is critical.

A reverted transaction is still part of chain history, so we must journal it. But it must not produce business facts like:

1. trade rows
2. transfer rows
3. holder deltas
4. LP actions

If we ignored this distinction, later phases would index failed activity as real economic activity.

## 3. High-Level Architecture Implemented In Phase 1

The implemented Phase 1 flow is:

1. Load environment and connect to RPC and Postgres.
2. Verify foundation tables exist.
3. Ensure checkpoint rows exist for all three lanes.
4. Ask Starknet for latest accepted tip.
5. Read current checkpoint for canonical lane.
6. Determine the next block to ingest.
7. Fetch block with receipts and state update.
8. Validate:
   - block number
   - block hash
   - parent hash continuity
   - state update hash consistency
   - new root consistency
9. Write block journal inside one DB transaction.
10. Advance checkpoint only after that write succeeds.

This is the "hard rule" of Phase 1:

Checkpoint moves after commit, never before commit.

If we did the reverse, a crash between "checkpoint update" and "block write" would create a permanent hole.

## 4. Files Created In Phase 1

Phase 1 introduced these files:

1. `package.json`
2. `.env`
3. `.env.example`
4. `.gitignore`
5. `sql/001_foundation.sql`
6. `lib/cairo/bigint.js`
7. `lib/db.js`
8. `lib/starknet-rpc.js`
9. `core/finality.js`
10. `core/checkpoint.js`
11. `core/block-processor.js`
12. `bin/start-indexer.js`

Below is the explanation for every file.

## 5. File-by-File Explanation

### 5.1 `package.json`

Purpose:

1. Defines this Phase 1 module as a Node project.
2. Declares runtime dependencies.
3. Defines the `start:indexer` script.
4. Defines a lightweight syntax-check script.

Why it exists:

1. Without explicit dependency pinning, Phase 1 is not reproducible.
2. `starknet`, `pg`, and `dotenv` are foundation dependencies, not optional extras.
3. The syntax-check script gives a quick verification path before running the indexer.

Why `starknet` v6:

1. You explicitly requested `starknet.js` v6.
2. It is a reasonable base for Starknet RPC integration.
3. We still had to use raw JSON-RPC for some calls because the current Alchemy Starknet endpoint did not serialize cleanly through the provider adapter for our target methods.

If we did not define dependencies clearly:

1. a different machine could install a different version set
2. RPC behavior could change unexpectedly
3. startup would become environment-dependent

### 5.2 `.env`

Purpose:

1. Stores local runtime configuration.
2. Holds your Starknet RPC URL.
3. Defines Postgres connection values.
4. Defines indexer behavior such as lane, start block, poll interval, and batch size.

Why it exists:

1. Hardcoding infra endpoints inside application code is bad operational design.
2. We need separate config for local, staging, and production later.
3. RPC endpoint and DB settings are deployment concerns, not source-code concerns.

Important values:

1. `STARKNET_RPC_URL`
2. `PGDATABASE=StarknetDeg`
3. `INDEXER_LANE=ACCEPTED_ON_L2`

### 5.3 `.env.example`

Purpose:

1. Documents expected environment variables.
2. Makes onboarding easier.
3. Avoids hidden configuration assumptions.

If we skipped this:

1. future setup becomes tribal knowledge
2. local setup becomes fragile
3. deploy mistakes increase

### 5.4 `.gitignore`

Purpose:

1. Prevents accidental commit of `node_modules/`
2. Prevents accidental commit of `.env`

Why it matters:

1. `.env` contains secrets and environment-specific values.
2. `node_modules` is generated state, not source code.

### 5.5 `lib/cairo/bigint.js`

Purpose:

This file enforces the numeric discipline for Starknet.

Functions:

1. `toBigIntStrict`
2. `hexToBigInt`
3. `bigIntToHex`
4. `reassembleU256`
5. `toNumericString`
6. `bigIntToSafeNumber`

Why this file is necessary:

Starknet uses felts and `u256` values everywhere:

1. fees
2. resource bounds
3. token amounts
4. nonces
5. storage values
6. state-related numeric fields

JavaScript `Number` cannot safely represent large integers beyond `2^53 - 1`.

If we used `Number`:

1. token amounts could be rounded silently
2. fee values could drift
3. large block-derived values could become inaccurate
4. DB writes could store wrong quantities without throwing

Why `reassembleU256(low, high)` matters:

Starknet frequently encodes large values as two 128-bit limbs:

`value = low + (high * 2^128)`

If this reconstruction is wrong, later phases will produce:

1. wrong balances
2. wrong transfer sizes
3. wrong prices
4. wrong TVL
5. wrong PnL

Why `toNumericString` exists:

Postgres `NUMERIC` should receive an exact decimal string, not a float.

### 5.6 `lib/db.js`

Purpose:

1. Centralizes Postgres connection creation.
2. Provides helper methods for query execution.
3. Provides `withClient`.
4. Provides `withTransaction`.
5. Provides clean shutdown support.

Why this file exists:

Database handling must be centralized.

If every file created its own pool or transaction pattern:

1. transaction discipline would drift
2. error handling would become inconsistent
3. rollback behavior would become unreliable

Why `withTransaction` matters:

Phase 1 depends on atomicity.

The block write and the checkpoint update must either:

1. both succeed
2. or both fail

There is no safe middle state.

If we wrote block journal but not checkpoint:

1. replay is possible
2. duplicate-safe design still protects us

If we wrote checkpoint but not block journal:

1. we skip chain truth
2. later phases inherit corrupted history

So transaction wrapping is non-negotiable.

### 5.7 `lib/starknet-rpc.js`

Purpose:

This is the Starknet RPC client abstraction used by Phase 1.

Implemented methods:

1. `getBlockNumber`
2. `getBlockWithReceipts`
3. `getStateUpdate`

Also implemented:

1. exponential backoff
2. jitter
3. retry classification
4. block identifier normalization via `toRpcBlockId`

Why this file exists:

Raw RPC calls are a failure boundary.

Providers can fail because of:

1. rate limits
2. temporary gateway issues
3. timeouts
4. upstream provider hiccups

If we did not add retry logic:

1. one transient provider failure would stop ingestion progress
2. indexer uptime would be poor
3. catch-up throughput would degrade badly

Why `toRpcBlockId` matters:

Starknet methods accept several block-id forms:

1. `latest`
2. `pending`
3. `{ block_number: N }`
4. `{ block_hash: H }`

We normalize inputs so Phase 1 never sends malformed block IDs accidentally.

Important real-world nuance:

We instantiate `RpcProvider` from `starknet.js` v6 because that is the requested SDK.  
But for `starknet_getBlockWithReceipts` and `starknet_getStateUpdate`, we use raw JSON-RPC under the hood.

Why:

1. During live testing against your Alchemy endpoint, the provider adapter was not passing block identifiers correctly for those methods.
2. Raw RPC worked correctly and matched the official method shape.
3. This is the correct engineering choice: preserve correctness instead of forcing the abstraction where it misbehaves.

### 5.8 `core/finality.js`

Purpose:

This file defines and validates finality and execution status logic.

Main responsibilities:

1. define valid lanes
2. define valid execution statuses
3. normalize finality status
4. normalize execution status
5. classify whether a receipt is business-safe
6. summarize succeeded, reverted, and `L1_HANDLER` counts per block

Why it exists:

Finality logic must be centralized, not copied around ad hoc.

If every module invented its own status rules:

1. one module might treat `REVERTED` incorrectly
2. another might forget `PRE_CONFIRMED`
3. status bugs would spread into analytics

Why `isBusinessSafeReceipt` matters:

Phase 1 journals reverted transactions, but later business layers must not treat them as real economic actions.

This distinction begins here.

### 5.9 `core/checkpoint.js`

Purpose:

This file owns checkpoint-related state access.

Main responsibilities:

1. assert foundation tables exist
2. ensure checkpoint rows exist for all lanes
3. fetch checkpoint state
4. advance checkpoint after commit

Why it exists:

Checkpointing is one of the highest-risk parts of an indexer.

If checkpoint logic is duplicated across files:

1. one path may update too early
2. another path may forget to lock rows
3. replay behavior becomes inconsistent

Why `assertFoundationTables` exists:

The indexer should fail immediately if required schema is missing.

If we skipped this:

1. the process could start successfully
2. then fail only after entering the loop
3. that creates confusing partial startups

Why `ensureIndexStateRows` exists:

We want all three lanes represented from day one:

1. `PRE_CONFIRMED`
2. `ACCEPTED_ON_L2`
3. `ACCEPTED_ON_L1`

Even though Phase 1 canonical processing only runs `ACCEPTED_ON_L2`, lane rows are initialized so future promotion and preview work has a clean control-plane shape.

Why `FOR UPDATE` matters in `getCheckpoint`:

When we process a block inside a transaction, we want to lock the checkpoint row.

Without row locking:

1. two workers could read the same checkpoint
2. both could try to ingest the same next block
3. race conditions become possible

### 5.10 `core/block-processor.js`

Purpose:

This is the main Phase 1 canonical block ingestion unit.

Responsibilities:

1. fetch block with receipts
2. fetch state update
3. validate payload consistency
4. check sequential continuity
5. mark conflicting rows orphaned if needed
6. upsert block journal
7. advance checkpoint inside the same DB transaction

Why this file is central:

This is where Starknet RPC truth becomes stored canonical truth.

Why we fetch both block and state update:

`starknet_getBlockWithReceipts` alone is not enough.

We also need:

1. `old_root`
2. `new_root`
3. state update lineage

Without state update data:

1. reconciliation quality drops
2. proof-related lineage is weaker
3. later L1 anchoring logic has less evidence

Why `normalizeFetchedBlock` exists:

It validates that:

1. requested block number matches returned block number
2. state update hash matches block hash
3. state update `new_root` matches block `new_root`
4. required header fields are present

If we skipped these checks:

1. provider inconsistencies could enter storage silently
2. reconciliation would become harder
3. bugs would be detected later when damage is larger

Why `assertSequentialProgress` exists:

It enforces:

1. no block gaps
2. correct parent-child continuity

Without this:

1. the indexer could jump over blocks
2. ingest blocks out of order
3. accept a mismatched parent chain without noticing

Why `markConflictingBlockRows` exists:

If a block number already exists for the same lane but with a different hash, the previous row is marked orphaned.

This is a preparation step for future reconciliation.

Without this:

1. the system cannot distinguish surviving chain data from replaced chain data
2. rollback and replay become much harder

Why `upsertBlockJournal` stores raw JSON:

We store:

1. `raw_block`
2. `raw_state_update`

This is deliberate.

Why:

1. later phases may need fields not extracted in Phase 1
2. debugging live chain behavior becomes easier
3. replay and forensic analysis become possible

Without raw storage:

1. every schema omission becomes permanent data loss
2. audits become harder
3. later decoder development slows down

Important note on reverted transactions:

Phase 1 does not discard reverted transactions. It counts and journals them.

Why:

1. they are still part of chain history
2. their existence matters operationally
3. but they must be excluded from business facts later

That is why we store them in the block journal but do not produce trade or transfer facts yet.

### 5.11 `bin/start-indexer.js`

Purpose:

This is the executable loop for the canonical Phase 1 indexer.

Responsibilities:

1. load config from `.env`
2. create RPC client
3. verify schema exists
4. ensure lane checkpoint rows exist
5. read current checkpoint
6. fetch latest accepted tip
7. process blocks sequentially
8. sleep when caught up
9. shut down cleanly on `SIGINT` and `SIGTERM`

Why this file is intentionally conservative:

Phase 1 prioritizes correctness over throughput.

So it does:

1. sequential block processing
2. one canonical lane
3. bounded catch-up batches

It does not yet do:

1. parallel block workers
2. preview-lane ingestion
3. L1 promotion jobs
4. protocol decoding

Why:

1. Phase 1 should be easy to reason about
2. when the first bug appears, simpler control flow is easier to debug
3. correctness must be proven before concurrency is introduced

Why only `ACCEPTED_ON_L2` is actively processed:

Because this is the best live canonical lane for market indexing.

`PRE_CONFIRMED`:

1. useful later for preview UX
2. too soft for canonical Phase 1 writes

`ACCEPTED_ON_L1`:

1. crucial for irreversible anchoring
2. better handled by promotion and reconciliation flows in later phases

But we still initialize all three lanes now so the control plane is ready.

## 6. Database Tables And Column Explanations

Phase 1 creates three tables.

## 6.1 `stark_index_state`

Purpose:

This is the checkpoint table.

One row per:

1. `indexer_key`
2. `lane`

Columns:

| Column | Type | Meaning | Why It Exists |
| --- | --- | --- | --- |
| `indexer_key` | `TEXT` | logical identity of this indexer stream | allows multiple deployments or chains later |
| `lane` | `TEXT` | finality lane | separates preview, canonical, and anchored control state |
| `last_processed_block_number` | `NUMERIC(78,0)` | last committed block number | must use `NUMERIC` because it is chain-derived |
| `last_processed_block_hash` | `TEXT` | hash of last committed block | parent continuity checks depend on this |
| `last_processed_parent_hash` | `TEXT` | parent hash of last committed block | useful for lineage inspection |
| `last_processed_old_root` | `TEXT` | state root before block execution | helps reconciliation and auditing |
| `last_processed_new_root` | `TEXT` | state root after block execution | helps reconciliation and auditing |
| `last_finality_status` | `TEXT` | stored finality of last committed block | useful for status sanity |
| `last_committed_at` | `TIMESTAMPTZ` | time checkpoint was advanced | operational observability |
| `last_error` | `TEXT` | reserved slot for future error state | useful for operator visibility |
| `created_at` | `TIMESTAMPTZ` | row creation time | auditability |
| `updated_at` | `TIMESTAMPTZ` | row update time | auditability |

Primary key:

1. `(indexer_key, lane)`

Why this primary key:

1. one checkpoint per logical stream
2. avoids duplicate lane rows

If this table did not exist:

1. the indexer would not know where to resume
2. restarts would require full rescans or fragile local files
3. failover would be much harder

## 6.2 `stark_block_journal`

Purpose:

This is the canonical block-level ledger for Phase 1.

It stores:

1. lineage
2. finality
3. counts
4. raw payloads
5. orphan markers

Columns:

| Column | Type | Meaning | Why It Exists |
| --- | --- | --- | --- |
| `lane` | `TEXT` | finality lane this row belongs to | same block number can conceptually appear under different lanes |
| `block_number` | `NUMERIC(78,0)` | Starknet block number | canonical ordering key |
| `block_hash` | `TEXT` | Starknet block hash | true block identity |
| `parent_hash` | `TEXT` | previous block hash | continuity and fork detection |
| `old_root` | `TEXT` | state root before block | reconciliation evidence |
| `new_root` | `TEXT` | state root after block | reconciliation evidence |
| `finality_status` | `TEXT` | block-level finality | separates L2-accepted vs L1-anchored interpretation |
| `block_timestamp` | `NUMERIC(78,0)` | block timestamp | stored as chain-derived quantity |
| `sequencer_address` | `TEXT` | sequencer field from block payload | chain context |
| `starknet_version` | `TEXT` | protocol version reported by block | operational visibility |
| `l1_da_mode` | `TEXT` | data availability mode | may matter later for analytics and ops |
| `transaction_count` | `NUMERIC(78,0)` | number of transactions in block | block statistics |
| `event_count` | `NUMERIC(78,0)` | event count from block | block statistics |
| `state_diff_length` | `NUMERIC(78,0)` | state diff size | reconciliation and operational observability |
| `succeeded_transaction_count` | `NUMERIC(78,0)` | succeeded receipt count | block health summary |
| `reverted_transaction_count` | `NUMERIC(78,0)` | reverted receipt count | important because reverted txs still exist on-chain |
| `l1_handler_transaction_count` | `NUMERIC(78,0)` | number of `L1_HANDLER` txs | bridge and message visibility |
| `is_orphaned` | `BOOLEAN` | whether this row was superseded by a conflicting chain path | essential for reconciliation |
| `orphaned_at` | `TIMESTAMPTZ` | when row was marked orphaned | operational trace |
| `raw_block` | `JSONB` | full raw block-with-receipts payload | replay, audit, debugging |
| `raw_state_update` | `JSONB` | full raw state update payload | replay, audit, debugging |
| `created_at` | `TIMESTAMPTZ` | insert time | auditability |
| `updated_at` | `TIMESTAMPTZ` | update time | auditability |

Primary key:

1. `(lane, block_number, block_hash)`

Why this key:

1. same block number may theoretically appear with a different hash under reconciliation scenarios
2. storing both lets us preserve lineage history
3. we can mark one row orphaned instead of deleting evidence immediately

Important unique index:

1. one active non-orphaned row per `(lane, block_number)`

Why:

1. preserves one active canonical view
2. still allows storing orphaned competitors

If this table did not exist:

1. there would be no raw canonical record of fetched blocks
2. replay would be weaker
3. reconciliation would be much harder
4. observability would be poor

## 6.3 `stark_reconciliation_log`

Purpose:

This table records reconciliation incidents and windows.

Phase 1 does not yet implement the full rollback engine, but it prepares the audit/control table for it.

Columns:

| Column | Type | Meaning | Why It Exists |
| --- | --- | --- | --- |
| `reconciliation_id` | `BIGSERIAL` | unique incident id | operational identity |
| `lane` | `TEXT` | lane where divergence was found | reconciliation is lane-specific |
| `from_block_number` | `NUMERIC(78,0)` | first affected block | defines replay start |
| `to_block_number` | `NUMERIC(78,0)` | last affected block | defines replay end |
| `anchor_block_number` | `NUMERIC(78,0)` | last safe anchor before divergence | rollback boundary |
| `expected_parent_hash` | `TEXT` | what parent hash should have been | explains mismatch |
| `observed_parent_hash` | `TEXT` | what parent hash was actually seen | explains mismatch |
| `expected_old_root` | `TEXT` | expected prior root | root mismatch evidence |
| `observed_old_root` | `TEXT` | observed prior root | root mismatch evidence |
| `expected_new_root` | `TEXT` | expected post root | root mismatch evidence |
| `observed_new_root` | `TEXT` | observed post root | root mismatch evidence |
| `status` | `TEXT` | lifecycle of reconciliation incident | `DETECTED`, `REPLAYING`, `RESOLVED`, `FAILED` |
| `reason` | `TEXT` | textual explanation | auditability |
| `metadata` | `JSONB` | extra structured incident context | future-proofing |
| `detected_at` | `TIMESTAMPTZ` | detection timestamp | ops visibility |
| `resolved_at` | `TIMESTAMPTZ` | completion timestamp | ops visibility |
| `created_at` | `TIMESTAMPTZ` | creation timestamp | auditability |
| `updated_at` | `TIMESTAMPTZ` | update timestamp | auditability |

Why create it in Phase 1 already:

1. reconciliation is not an optional afterthought
2. the control plane should be present before later rollback jobs are built
3. operational history of divergence matters

## 7. Why `NUMERIC` Was Used In SQL

This was a strict requirement and the correct design choice.

Chain-derived quantities were stored as `NUMERIC` because:

1. Starknet values can exceed 64-bit integer limits
2. they can definitely exceed JS safe integer range
3. using floating types would be unacceptable

Even some fields that look "small enough today" were kept under the same standard because consistency is safer than selective guessing.

If we mixed types loosely:

1. one column might overflow later
2. one developer might cast incorrectly
3. indexer correctness would depend on luck

## 8. Why Reverted Transactions Were Kept But Not Promoted To Business Facts

This is a very important conceptual point.

On Starknet, a reverted transaction can still appear inside an accepted block.

So two things are simultaneously true:

1. it is real chain history
2. it is not successful economic execution

That means:

1. Phase 1 must store it in canonical raw history
2. later phases must exclude it from business facts

If we fully dropped reverted receipts:

1. block statistics become incomplete
2. audits become weaker
3. operational debugging becomes harder

If we treated reverted receipts as successful:

1. fake trades would appear
2. fake balances would appear
3. later holder and wallet analytics would be corrupted

Phase 1 therefore makes the correct split:

1. keep for journal
2. do not bless for business logic

## 9. Why Three Lanes Were Introduced Even Though Only One Is Actively Processed

Phase 1 initializes:

1. `PRE_CONFIRMED`
2. `ACCEPTED_ON_L2`
3. `ACCEPTED_ON_L1`

But the active ingestion loop only processes `ACCEPTED_ON_L2`.

This is intentional.

Why:

1. `PRE_CONFIRMED` is too soft for canonical storage decisions
2. `ACCEPTED_ON_L2` is the right live canonical lane for most indexer use
3. `ACCEPTED_ON_L1` is the irreversible anchor lane, but promotion/reconciliation logic belongs to later phases

So Phase 1 does not overreach, but it does leave the architecture ready.

If we had only created one lane:

1. later promotion logic would require a control-plane redesign
2. preview and anchored states would be bolted on awkwardly

## 10. End-to-End Lifecycle Of One Block In Phase 1

When one block is processed, the exact logic is:

1. read current checkpoint
2. compute next block number
3. fetch block with receipts
4. fetch state update
5. validate consistency
6. open DB transaction
7. lock checkpoint row
8. verify expected sequential continuity
9. mark conflicting same-height rows as orphaned
10. upsert block journal row
11. update checkpoint
12. commit transaction

If any step fails before commit:

1. transaction rolls back
2. checkpoint does not move
3. block can be retried safely

This is the core safety property of the phase.

## 11. What Would Go Wrong If These Choices Were Not Made

### Without `BigInt`

1. silent precision loss
2. wrong fee accounting
3. broken amount reconstruction
4. corrupted downstream analytics

### Without transactional checkpointing

1. skipped blocks
2. non-recoverable gaps
3. corrupted replay assumptions

### Without parent-hash validation

1. hidden fork acceptance
2. impossible-to-debug lineage corruption

### Without state-root storage

1. weaker reconciliation evidence
2. poor auditability
3. harder L1 anchoring analysis later

### Without raw JSON journaling

1. missing forensic context
2. slower later-phase development
3. harder debugging of protocol-specific decoders

### Without retry/backoff

1. poor uptime
2. unnecessary process failures
3. bad catch-up behavior under provider pressure

### Without explicit `REVERTED` handling

1. failed transactions could later appear as successful trades
2. wallet state would become unreliable

## 12. What Phase 1 Does Not Do Yet

To avoid confusion, these are intentionally not completed in Phase 1:

1. event sequencing
2. protocol decoders
3. transfer normalization
4. trade extraction
5. holder balances
6. bridge accounting
7. websocket delivery
8. `PRE_CONFIRMED` ingestion loop
9. `ACCEPTED_ON_L1` promotion job
10. full reconciliation engine

Phase 1 only establishes the safe foundation they will stand on.

## 13. Final Summary

Phase 1 created the minimum trustworthy Starknet ingestion base for StarknetDeg.

What was achieved:

1. strict large-number handling with `BigInt`
2. `NUMERIC`-safe database schema
3. canonical block and state-update journaling
4. transactional checkpoint safety
5. finality-aware control-plane design
6. reverted-transaction awareness
7. live Starknet RPC integration with retry logic

The main design principle was simple:

Do not optimize for features before you optimize for correctness.

That is why Phase 1 is intentionally conservative, explicit, and heavy on lineage and validation.
