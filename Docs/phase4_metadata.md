# StarknetDeg Phase 4 Metadata

Date: April 10, 2026  
Scope: Plain-English explanation of the Phase 4 enrichment layer after the schema-enhancement pass. This phase still does not create new trades, but it now feeds a shared token registry and keeps the rest of the pipeline aligned on token identity and contract risk.

## 1. What Phase 4 Actually Does

By the end of Phase 3, the indexer already knows:

- raw Starknet blocks
- raw transactions and events
- normalized actions
- trades
- pool state
- prices
- 1-minute candles

That means the core market pipeline already works.

But the data is still incomplete in three important ways:

1. A token address is just an address until we fetch `name`, `symbol`, and `decimals`.
2. A verified DEX contract can change class hash after an upgrade, and if we do not track that, decoding can suddenly break.
3. A contract can be technically valid for indexing but still be risky because it is upgradeable, owner-controlled, or can mint new supply.
4. Trades can arrive before metadata does. If decimals are missing at trade time, we still need the row, but we must clearly mark it as incomplete and reprocess it later.

Phase 4 solves those three gaps.

The enhancement pass added one more important responsibility:

- Phase 4 now syncs enriched token facts into a shared `tokens` table so transfer trust, pricing, and analytics do not each keep their own separate token truth.

## 2. Why We Did Not Put This Inside The Canonical Block Commit

This is one of the most important design decisions in the whole system.

Metadata fetching and security scanning happen in background jobs, not inside the main indexer transaction.

Why?

- The canonical block pipeline must stay short and deterministic.
- `name()` and `symbol()` calls are helpful, but they are not required to preserve trade truth.
- If an RPC call for metadata fails, we should not block the block commit.
- Security scoring is advisory. It should never mutate or delay canonical facts like trades or transfers.

So the rule is:

- block ingestion writes the market truth
- background jobs enrich that truth later

If we ignored this rule, one flaky metadata RPC call could slow down or stall indexing.

## 3. New Tables Added In Phase 4

Phase 4 added three main data tables and extended one existing registry table.

It also refined two Phase 3 tables:

- `stark_trades`
- `stark_ohlcv_1m`

Both now carry `pending_enrichment`.

After the enhancement pass, there is also a shared `tokens` table in the database.

That table is not a replacement for `stark_token_metadata`.

The right way to think about them is:

- `stark_token_metadata` = raw enrichment record for a token
- `tokens` = shared token identity record that the rest of the pipeline uses

### 3.1 `stark_block_state_updates`

This table exists so class-hash changes and deployments are queryable without re-parsing raw block JSON every time.

Columns:

- `lane`: finality lane
- `block_number`: lineage block number
- `block_hash`: lineage block hash
- `old_root`: state root before the block
- `new_root`: state root after the block
- `state_diff_length`: size summary for the state diff
- `declared_classes`: raw declared class list
- `deployed_contracts`: raw deployed contract list
- `deprecated_declared_classes`: raw legacy declared classes
- `nonce_updates`: raw nonce changes
- `replaced_classes`: raw class replacements
- `storage_diffs`: raw storage changes
- `raw_state_update`: full original Starknet state update payload
- `created_at`
- `updated_at`

Why this table matters:

- `stark_block_journal` already had the raw state update, but that was bundled into a broader block record.
- the ABI refresh job needs one focused place to ask: "which contracts changed class hash recently?"
- this table makes that query direct and cheap

If we did not build this table, the ABI watcher would have to keep re-reading large JSON blobs from `stark_block_journal` and re-deriving the same answer every run.

### 3.2 `stark_token_metadata`

This table stores token identity information.

Columns:

- `token_address`: primary key
- `name`
- `symbol`
- `decimals`
- `total_supply`
- `is_verified`
- `last_refreshed_block`
- `last_refreshed_at`
- `metadata`
- `created_at`
- `updated_at`

Why these columns exist:

- `name`, `symbol`, `decimals` make raw token addresses readable and usable
- `total_supply` is useful for later token analytics and risk review
- `is_verified` tells us whether the token is in our verified ERC-20 knowledge base
- `last_refreshed_at` tells us how fresh the metadata is
- `metadata` keeps enrichment notes without changing the main schema every time

Important reliability detail:

- if `name()` or `symbol()` cannot be decoded cleanly, we now store the raw hex in the row metadata and mark `decode_failed = true`
- this means unreadable strings are visible for audit instead of silently disappearing

Important precision rule:

- `decimals` and `total_supply` are stored as `NUMERIC`
- runtime decoding uses `BigInt`

We did this because Starknet values can exceed normal JavaScript number safety.

### 3.3 `stark_contract_security`

This table stores lightweight risk and control information about contracts.

Columns:

- `contract_address`: primary key
- `is_upgradeable`
- `owner_address`
- `class_hash`
- `risk_label`
- `security_flags`
- `last_scanned_at`
- `created_at`
- `updated_at`

Why these columns exist:

- `is_upgradeable` tells us whether the contract can change implementation or class behavior
- `owner_address` tells us whether there is a direct admin or owner control path
- `class_hash` ties the scan result to the current code identity
- `risk_label` gives the API layer a simple human-readable risk signal
- `security_flags` keeps the detailed reasoning in JSON

Important rule:

- this table is advisory only
- it does not change canonical trade data

### 3.4 `stark_contract_registry` Extensions

Phase 4 also extended the existing registry table with:

- `abi_json`
- `abi_refreshed_at`
- `abi_refreshed_at_block`

Why?

Because once a verified DEX contract changes class hash, we need to store the refreshed ABI evidence somewhere that the system can audit later.

### 3.5 `stark_trades` And `stark_ohlcv_1m` Refinement

Both tables now include:

- `pending_enrichment`

Why this exists:

- sometimes a trade arrives before token decimals are known
- we still materialize the trade and candle using a safe fallback of `18`
- but we explicitly mark the row as pending enrichment
- later, when decimals are fetched, the metadata refresher re-prices the trade and rebuilds the affected candles

If we did not track this state explicitly, rows would look final even when they were built with a temporary decimal assumption.

## 4. Files Added Or Updated In Phase 4

## 4.1 `sql/004_metadata_and_security.sql`

This is the Phase 4 migration file.

It now does six jobs:

1. creates `stark_block_state_updates`
2. creates `stark_token_metadata`
3. creates `stark_contract_security`
4. extends `stark_contract_registry` with ABI refresh columns
5. adds `pending_enrichment` to `stark_trades`
6. adds `pending_enrichment` to `stark_ohlcv_1m`

It also backfills `stark_block_state_updates` from `stark_block_journal` so earlier indexed blocks are not invisible to the ABI refresh job.

If we skipped that backfill, the new ABI watcher would only see future blocks, not already indexed history.

## 4.2 `core/block-processor.js`

This file now writes `stark_block_state_updates` during canonical block processing.

What changed:

- after `stark_block_journal` is written, the processor now also writes a structured state-update row
- when a block is replayed for the same height, the matching `stark_block_state_updates` row is deleted and rebuilt

Why this matters:

- class replacements and deployments are now first-class indexed data
- Phase 4 jobs do not need to scrape raw journal blobs every time

If we did not update this file, the new state-update table would exist but would go stale after the migration backfill.

## 4.2A `core/trades.js`

This file now handles the metadata race condition directly.

What changed:

- trade materialization now loads token truth through the shared `tokens` table, which is itself fed by `stark_token_metadata`
- if decimals are missing, it uses a default of `18`
- the trade is still written
- but `pending_enrichment = true` is set on the row
- the trade metadata also records which token addresses were missing decimals

Why this matters:

- we do not lose live trade coverage just because metadata arrived late
- but we also do not pretend the row is final

If we did not do this, we would have two bad options:

- drop the trade entirely
- or write a silent best-guess row with no way to know it needs correction later

## 4.3 `core/abi-registry.js`

This is one of the most important Phase 4 changes.

Before Phase 4:

- routing relied mainly on the JS registry and static matching

After Phase 4:

- routing can also consult `stark_contract_registry` in the database

Why this matters:

- suppose a verified DEX address changes class hash
- the static registry may still hold the old class hash
- the ABI refresh job writes the new class hash into `stark_contract_registry`
- now the live router can keep matching that contract through the DB-backed registry layer

This closes a real production gap.

If we did not connect the router to the DB registry, the ABI refresh job would just produce passive metadata that the decoder path never used.

## 4.2B `core/ohlcv.js`

This file now understands pending enrichment too.

What changed:

- candles inherit `pending_enrichment` from trades
- gap candles seeded from a previous close also inherit the pending flag if that previous close came from an incomplete trade
- the module now has a rebuild path that re-materializes pending candle ranges once decimals are later resolved

Why this matters:

- a bad trade price can poison more than one minute
- if a gap candle was seeded from an incomplete previous close, that gap candle is also incomplete

If we only rebuilt the trade minute and ignored the seeded gap candles after it, the downstream chart would still be wrong.

## 4.4 `lib/starknet-rpc.js`

This file now includes `getStorageAt(...)`.

Why?

Because the security scanner needs a basic proxy check.

That check looks for non-zero values in common implementation storage slots.

Without `getStorageAt`, the scanner could only rely on ABI names and would miss some proxy patterns.

## 4.5 `lib/cache.js`

This is a small TTL cache helper.

What it does:

- keeps short-lived results in memory
- avoids repeating the same expensive RPC call again and again
- also deduplicates in-flight loads

Where it helps:

- token metadata calls
- class definition fetches
- DB-backed registry lookups

If we did not add caching, the background jobs would waste RPC quota and become much noisier under load.

## 4.6 `lib/cairo/strings.js`

This file decodes Starknet string return values.

Why it exists:

- some tokens return short-string felts
- some tokens return Cairo byte-array style strings
- we need one safe decoder for both

This is used mainly for:

- `name()`
- `symbol()`

New reliability detail:

- if decoding fails, the helper now exposes the raw hex payload too

If we did not build this helper, token metadata refresh would be inconsistent and many valid tokens would look unreadable or empty.

## 4.7 `lib/starknet-contract.js`

This file normalizes ABI payloads and extracts ABI names.

It helps two jobs:

- ABI refresh
- security scanning

Why this matters:

- Starknet class definitions do not always come back in one clean shape
- sometimes the ABI is already an array
- sometimes it is a JSON string
- the scanner needs one normalized view of function and event names

## 4.8 `jobs/meta-refresher.js`

This job fills `stark_token_metadata` and also repairs rows that were written before metadata was ready.

What it does:

1. finds token addresses that appear in:
   - `stark_transfers`
   - `stark_trades`
   - `stark_prices`
   - `stark_bridge_activities`
2. filters tokens that still have missing metadata or stale metadata
3. calls:
   - `name()`
   - `symbol()`
   - `decimals()`
   - `totalSupply()`
4. decodes the results safely
5. upserts `stark_token_metadata`
6. syncs the resolved token facts into the shared `tokens` table
7. refreshes security state for the same token contract
8. if decimals were newly resolved, re-prices pending trades and rebuilds pending candles

Important detail:

- verified ERC-20 tokens from the known-token cache are marked `is_verified = true`
- metadata refresh now has a block-based TTL through `last_refreshed_block`
- this means `total_supply` and contract security are refreshed periodically, not only once forever
- token identity becomes reusable by the rest of the pipeline through the shared `tokens` table

Important race-condition detail:

- when a trade arrives before decimals do, Phase 3 writes the trade using fallback decimals `18`
- `jobs/meta-refresher.js` later sees the real decimals
- it reprocesses the affected pending rows from canonical lineage data

Important decode-failure detail:

- if `name()` or `symbol()` cannot be decoded, the refresher stores the raw hex and marks `decode_failed`
- this is much better than leaving the field empty, because the row is now auditable and retryable

If we did not build this job, every token would stay as a raw address forever.

## 4.9 `jobs/abi-refresh.js`

This job watches recent `stark_block_state_updates`.

What it looks for:

- `replaced_classes`
- `deployed_contracts`

For every verified registry contract that changed:

1. it fetches the current class definition
2. normalizes the ABI
3. closes the previous active registry row by setting `valid_to_block`
4. inserts or updates the new class-hash row
5. stores the ABI snapshot in `stark_contract_registry`

This is why the registry is now lineage-aware instead of being a flat list.

If we did not do this:

- a class-hash upgrade could silently break routing
- especially for contracts where the old static class hash was enforced

## 4.10 `jobs/security-scanner.js`

This job computes lightweight contract risk signals.

What it checks:

- current class hash
- ABI function names
- owner/admin entrypoints
- mint functions
- upgrade entrypoints
- standard Starknet implementation slots such as `_implementation` and `Starknet_Proxy_Implementation`

How risk is labeled right now:

- `Higher Risk` if the contract looks upgradeable, owner/admin-controlled, or mint-capable
- `Baseline` otherwise

Important precision detail:

- a non-zero value in one of the standard implementation slots now sets proxy classification to `Upgradeable Proxy`
- that classification is written into `security_flags`

This is intentionally simple.

It is not a formal audit.

It is an engineering warning layer.

If we skipped this job, the API and analytics layer would have no structured way to tell users that two tradable contracts can have very different control risk.

## 5. How Token Metadata Is Decoded

This is worth understanding because it is easy to get wrong on Starknet.

### 5.1 `name()` and `symbol()`

We try to decode returned values in this order:

1. Cairo byte-array format
2. concatenated short-string felts
3. single short-string felt

Why?

Because different token contracts do not all expose strings the same way.

If all decoders fail:

- we keep the raw hex
- we mark `decode_failed = true`
- we do not silently throw the metadata away

### 5.2 `decimals()`

This is read as an integer felt and kept as `BigInt` in runtime.

It is then stored as `NUMERIC`.

### 5.3 `totalSupply()`

This may come back as:

- one felt
- or a `u256` split into `low` and `high`

We reconstruct `u256` exactly before writing it to SQL.

If we used normal JavaScript numbers here, large supplies would become inaccurate.

## 6. How ABI Refresh Works

This is the full flow:

1. block processing writes `stark_block_state_updates`
2. `jobs/abi-refresh.js` scans recent rows
3. if a verified registry address appears in `replaced_classes` or `deployed_contracts`, the job treats it as a code-identity change
4. the old registry row is closed by `valid_to_block`
5. the new class hash becomes the active row
6. the refreshed ABI is stored alongside it
7. `core/abi-registry.js` can now match through the DB registry path

That last step is the key improvement.

Without it, the ABI refresh would exist only on paper.

## 7. How Security Scoring Works

The scanner is deliberately conservative.

It does not claim:

- safe
- unsafe
- audited
- unaudited

Instead it asks:

- can this contract be upgraded?
- does it have a direct owner/admin path?
- can it mint?
- does it look like a proxy?
- does one of the standard implementation slots contain a non-zero implementation address?

Those answers go into `security_flags`.

Then we compress them into a simple `risk_label`.

This means the system is useful for filtering and warning, without pretending it can replace a full smart contract audit.

## 8. Integrity Rules In Phase 4

These are the rules that matter:

1. Background jobs do not mutate canonical trade truth.
2. Chain-derived quantities still use `BigInt` in runtime and `NUMERIC` in SQL.
3. ABI refresh is tied to observed class-hash changes, not manual guesses.
4. The router can use the DB registry, so refreshed metadata actually affects live routing.
5. Caching is used to reduce redundant RPC pressure, not to invent missing facts.
6. Trades and candles created with fallback decimals are marked `pending_enrichment` until they are reprocessed.
7. Unreadable metadata is stored as raw hex with `decode_failed`, not silently dropped.

## 9. What Phase 4 Does Not Try To Solve Yet

Phase 4 is strong, but it is not the final metadata system.

It still does not do:

- full formal proxy classification for every Starknet pattern
- deep bytecode-level privilege analysis
- human-curated trust lists beyond the current verified-token cache
- historical point-in-time token metadata snapshots for every past block

Those can come later.

For now, the goal was:

- make tokens readable
- keep registry entries alive across upgrades
- attach practical security signals

That goal is now implemented.
