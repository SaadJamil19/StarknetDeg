# StarknetDeg Phase 2

Date: April 4, 2026  
Scope: Plain-English explanation of the current Phase 2 decoder engine after the registry-centric upgrade.

## 1. What Phase 2 Does

Phase 1 stored raw chain truth.

Phase 2 turns that raw truth into business meaning.

In simple words:

- Phase 1 says: "this Starknet block and receipt exist"
- Phase 2 says: "this receipt contains a swap, a transfer, a pool update, a bridge activity, or an event we still do not classify"

That is the job of the decoder engine.

## 2. What Changed In The New Phase 2

The old Phase 2 was still too narrow.

It mainly understood:

- Ekubo
- one Jedi-style path
- ERC-20 transfer

That was safe, but it produced too many `UNKNOWN` rows once we indexed real Starknet mainnet activity.

So the decoder engine was refined to use a registry-centric design.

Now the system does not rely on small hardcoded `if/else` checks for only one or two DEXes.

It now has:

- one central DEX registry
- one router that consults the registry
- one generic AMM decoder for repeated pair/pool patterns
- protocol-specific decoders only where the event model is truly different

## 3. The Big Design Decision

### 3.1 Why A Registry Was Necessary

On Starknet, many DEXes do not emit from one universal router address.

Examples:

- Ekubo emits from one singleton core contract
- AVNU emits from its exchange contract
- JediSwap V1 / 10KSwap / SithSwap emit from many pair contracts
- JediSwap V2 emits from many CLMM pool contracts
- Haiko emits from one market-manager contract, but each event also carries a `market_id`
- mySwap V1 emits from one central AMM contract, but each swap points to a `pool_id`

So without a registry:

- we cannot know which contract belongs to which protocol
- we cannot safely classify factory-created pools
- we cannot add new DEXes without touching router logic every time

That is why the registry is now the source of truth.

## 4. High-Level Flow Now

The current Phase 2 flow is:

1. raw transactions are stored in `stark_tx_raw`
2. raw events are stored in `stark_event_raw`
3. raw L2-to-L1 messages are stored in `stark_message_l2_to_l1`
4. the event router reloads one block in receipt order
5. the router asks the registry:
   - does this `from_address` belong to a known DEX?
   - if not, does this `class_hash` belong to a known pool class?
   - if not, can we probe `token0()`, `token1()`, `factory()`, `stable()` and classify it?
6. if a route is found, the correct decoder runs
7. if no route is found, the event is audited as `UNKNOWN`
8. normalized actions go to `stark_action_norm`
9. trusted token transfers go to `stark_transfers`
10. bridge activity goes to `stark_bridge_activities`
11. unknown or suspicious cases go to `stark_unknown_event_audit`

## 5. The New Core Files

### 5.1 `lib/registry/dex-registry.js`

This file is the main registry.

It stores:

- verified DEX addresses
- verified class hashes
- known selectors
- protocol families
- which decoder should handle which protocol

It currently contains verified mainnet coverage for:

- Ekubo
- AVNU
- JediSwap V1
- JediSwap V2
- 10KSwap
- mySwap V1
- SithSwap
- Haiko

It also contains catalog-only placeholders for:

- Ammos
- mySwap V2
- Nostra
- StarkDeFi

It also stores a selector-to-handler map for each protocol.

That means the registry does not only say:

- "this address belongs to AVNU"

It also says:

- "this selector on AVNU means swap"
- "this selector on Haiko means market creation"
- "this selector on JediSwap V2 means CLMM mint"

Why placeholders?

Because this pass was strict about verification.  
If we do not have a verified mainnet address or class hash, we do not pretend to decode it.

That is important.

Fake certainty is worse than an honest placeholder.

### 5.2 `core/abi-registry.js`

This file is no longer just an ABI helper.

Now it is the protocol matcher.

It does three levels of matching:

1. exact `from_address`
2. `class_hash`
3. dynamic probing of unknown pair contracts

It also carries the registry handler name forward with the route, so the rest of the pipeline can tell which registry template matched the event.

That third part is important.

For factory-based DEXes, many pools are deployed dynamically.  
If we only matched one hardcoded address list, we would still miss real trades.

So this file now tries:

- `token0()`
- `token1()`
- `factory()`
- `stable()`

If those calls succeed and the factory belongs to a known protocol, the router can classify the pool even if the pool address was not manually listed before.

### 5.3 `core/event-router.js`

This file is the controller of Phase 2.

It:

- loads one block back from raw storage
- walks through each receipt in order
- finds the correct route
- calls the right decoder
- writes normalized outputs
- writes audits for unsupported cases

It also now applies transaction-level routing context.

That means it understands things like:

- AVNU top-level swap present in this transaction
- underlying pool swaps inside the same transaction are route legs

This is how we stop double counting AVNU.

### 5.4 `core/protocols/base-amm.js`

This is the generic AMM decoder.

It handles repeated patterns instead of duplicating the same logic for every XYK-like DEX.

It covers:

- `Swap`
- `Mint`
- `Burn`
- `Sync`
- `PairCreated`
- `PoolCreated`

It also understands two different families:

- V2/XYK style pools
- CLMM style pools

This matters because JediSwap V2 is not the same as 10KSwap or JediSwap V1.

### 5.5 `core/protocols/avnu.js`

This decoder handles:

- AVNU `Swap`
- AVNU `OptimizedSwap`
- AVNU forwarder `SponsoredTransaction`

Why this matters:

AVNU is an aggregator.

If we ignored its own event and only counted underlying pool swaps:

- user-facing aggregator flow would disappear
- route intent would be lost
- transaction-level analytics would be incomplete

If we counted both AVNU and every underlying pool as separate trades without route-leg logic:

- volume would be double counted

So this decoder plus router context solves both problems together.

### 5.6 `core/protocols/myswap.js`

mySwap V1 is simpler than pair-based AMMs.

Its swap event already tells us:

- `pool_id`
- token sold
- token bought
- amount sold
- amount bought

So this decoder directly builds one normalized swap action.

### 5.7 `core/protocols/haiko.js`

Haiko is different again.

It is not a normal pair-address model.

It emits from a market-manager contract and uses `market_id`.

This decoder handles:

- `Swap`
- `MultiSwap`
- `ModifyPosition`
- `CreateOrder`
- `CollectOrder`
- `CreateMarket`

It also does on-chain market lookup using:

- `base_token(market_id)`
- `quote_token(market_id)`

Why this lookup is necessary:

The event alone gives the market id, but we still need the actual token addresses to normalize the action correctly.

### 5.8 `core/protocols/ekubo.js`

Ekubo stayed specialized.

That was the correct choice.

Ekubo is receipt-order-sensitive because:

- one transaction can contain multiple related events
- lock/callback behavior matters
- event order inside one receipt matters

So Ekubo still keeps receipt-local context.

The important refinement here is:

- trader attribution now prefers `transaction.sender_address`
- the raw `locker` is still stored in metadata

That fixes one of the biggest Starknet mistakes people make:

using the router or executor address as the trader.

### 5.10 `data/registry/contracts.json`

This file is now a JSON mirror of the runtime registry.

Important detail:

- runtime routing uses `lib/registry/dex-registry.js`
- `contracts.json` is the human-readable synchronized mirror

Why keep both?

Because:

- JavaScript is the real runtime source of truth
- JSON is easier for manual review, audits, and future tooling

The JSON mirror now includes:

- verified contracts
- class hashes where available
- selector-to-handler mappings
- catalog-only unresolved protocols

### 5.9 `core/protocols/erc20.js`

This file still handles standard `Transfer` events.

But it does not blindly trust any contract that emits `Transfer`.

It promotes a transfer when the token passes the trust gate.

The trust gate is:
- first check the static `known_erc20_cache`
- if that misses, check `stark_token_metadata`

If the token still cannot be trusted, it goes to audit as `TRANSFER_UNVERIFIED`.

That protects holder data from polluted transfer events, but it also lets us accept tokens that were discovered later by the metadata refresher instead of hard-blocking everything outside the static bridge-token list.

## 6. How Matching Works Now

The matching order is:

1. address match
2. class-hash match
3. probe the contract

That is the right order.

Why?

- address match is cheapest and strongest
- class-hash match is useful for factory-created pools
- probing is slower, so it should be the fallback

If we skipped class hashes and probing:

- many real pool contracts would stay unknown forever

If we probed first for everything:

- routing would become slower and noisier than necessary

## 7. Standardized Buy/Sell Output

Different DEXes describe swaps differently.

Examples:

- Ekubo gives deltas
- XYK AMMs give `amount0In / amount1Out`
- AVNU gives `sell_address / buy_address`
- mySwap gives `token_from / token_to`
- Haiko gives `is_buy`, `amount_in`, `amount_out`

The decoder engine now normalizes all of them into the same business shape:

- `token0_address`
- `token1_address`
- `amount0`
- `amount1`
- `pool_id`
- `account_address`
- protocol-specific metadata

The rule is:

- positive amount means token entered the pool side / debit side of the canonical pair model
- negative amount means token left that side

This standardization is what lets Phase 3 build trades from many protocols with the same downstream logic.

## 8. AVNU Dedup Logic

This is one of the most important refinements.

If an AVNU transaction is present:

- the AVNU swap is treated as the user-facing aggregated trade
- the underlying DEX swaps are marked as route legs

That means:

- Phase 2 still records the real venue activity
- Phase 3 can skip route legs in `stark_trades`
- pool state can still update from the underlying venue events

This gives us the best of both worlds:

- no volume double count
- no loss of venue-level state changes

## 9. What Still Goes To `UNKNOWN`

The new DEX coverage reduces `UNKNOWN`, but it does not make `UNKNOWN` disappear completely.

That is expected.

There are still events on Starknet that are not DEX swaps, for example:

- game / Dojo world events
- perps-specific events
- NFT transfers
- miscellaneous admin events

That is okay.

The goal is not `UNKNOWN = 0`.

The real goal is:

- high-value DEX activity should not stay unknown
- low-value non-DEX noise can stay audited until we decide it matters

## 10. Database Tables Used By Phase 2

The registry-centric expansion did **not** add a new SQL migration.

Phase 2 still uses the same core Phase 2 tables:

1. `stark_contract_registry`
2. `stark_tx_raw`
3. `stark_event_raw`
4. `stark_message_l2_to_l1`
5. `stark_unknown_event_audit`
6. `stark_action_norm`
7. `stark_transfers`
8. `stark_bridge_activities`

What changed is the **quality** of what enters those tables.

Now:

- more verified DEX events land in `stark_action_norm`
- fewer supported DEX events should fall into `stark_unknown_event_audit`
- transfer promotion is still strict
- AVNU route legs are marked in metadata

## 11. What This Unlocks For Phase 3

This Phase 2 upgrade matters directly for Phase 3.

Without it:

- `stark_trades` would miss major Starknet DEX flow
- `stark_price_ticks` would remain sparse
- pool-state updates would be incomplete
- candles would be based on partial venue coverage

With it:

- more real Starknet DEX flow can materialize into `stark_trades`
- AVNU is counted once, not twice
- factory-deployed pools are easier to recognize
- new DEX support mostly becomes a registry task instead of a router rewrite

## 12. The Most Important Takeaway

The biggest architectural change in the current Phase 2 is this:

**the router is no longer the source of protocol knowledge**

The registry is.

That means:

- adding a new verified DEX should mostly mean updating one registry file
- the decoder engine becomes easier to extend
- the core indexer stops getting messier every time Starknet adds another venue

That is the correct long-term direction.
