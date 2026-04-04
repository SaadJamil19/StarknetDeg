# StarknetDeg Phase 4 Metadata

Date: April 4, 2026  
Scope: Plain-English explanation of the new registry-centric metadata layer and how to add DEX support without rewriting the core indexer.

## 1. What This Phase Is About

This document is not about candles or prices.

It is about protocol knowledge.

In simple words:

- Phase 2 decodes events
- but Phase 2 can only decode what it can identify
- that identification now comes from one central DEX registry

So this phase explains the metadata architecture behind that routing.

## 2. The Main Change

The old system effectively knew too much inside the router itself.

That meant:

- the router had protocol assumptions in code
- adding a new DEX usually meant editing the router
- coverage expanded in an ad hoc way

The new system moves protocol knowledge into:

- `lib/registry/dex-registry.js`

That file is now the main source of truth for:

- which Starknet DEXes are recognized
- which addresses belong to them
- which class hashes belong to them
- which selectors mean which business event
- which decoder should handle them

## 3. What The Registry Stores

Each protocol entry can store:

- `protocol`
- `displayName`
- `decoder`
- `family`
- `verificationStatus`
- `roles`
- `selectorHandlers`
- `metadata`
- `sourceUrls`

### 3.1 `roles`

This is where addresses and class hashes live.

Examples:

- one singleton core address for Ekubo
- one exchange address for AVNU
- factory addresses for JediSwap V1 / 10KSwap / SithSwap
- one pool class hash for JediSwap V2
- one market-manager address for Haiko

### 3.2 `selectorHandlers`

This is the most important refinement.

The registry no longer only says:

- "this protocol uses `Swap`"

It now says:

- "this selector maps to `swap`"
- "this selector maps to `mint`"
- "this selector maps to `burn`"
- "this selector maps to `market_create`"
- "this selector maps to `position_update`"

That is what makes the architecture registry-driven instead of hardcoded.

## 4. Verified vs Catalog-Only

Not every protocol name should be treated the same way.

The registry now separates:

- `verified`
- `catalog_only`

### 4.1 Verified

Verified means:

- we have a confirmed mainnet address or class hash
- we have enough event-shape confidence to route safely

In the current implementation, verified coverage includes:

- Ekubo
- AVNU
- JediSwap V1
- JediSwap V2
- 10KSwap
- mySwap V1
- SithSwap
- Haiko

### 4.2 Catalog-Only

Catalog-only means:

- the protocol name is tracked
- but we do not yet have verified mainnet program IDs or safe decoder coverage

Current catalog-only placeholders include:

- Ammos
- mySwap V2
- Nostra
- StarkDeFi

Why keep placeholders at all?

Because they are useful for:

- planning
- future research
- explaining why a protocol is not decoded yet

But they must not be treated as real runtime coverage until verified.

## 5. The Router Flow

The router now works like this:

1. check `from_address`
2. if no direct match, check `resolved_class_hash`
3. if still no match and the selector looks like a standard DEX selector, probe the contract

That probe can ask for:

- `token0()`
- `token1()`
- `factory()`
- `stable()`

This is how factory-deployed pairs can be recognized without hand-listing every pool address.

## 6. Why This Reduces `UNKNOWN`

Earlier, many DEX events became `UNKNOWN` because:

- only Ekubo and one Jedi-style path had strong routing
- factory-created pools were not recognized broadly enough
- aggregator events and market-manager events did not have dedicated routing

Now:

- the registry knows more protocols
- the router uses addresses and class hashes
- pair/pool probing fills the gap for dynamic AMMs

So supported DEX events have a better chance of being normalized instead of dumped into audit.

## 7. Why We Still Keep `UNKNOWN`

This is important.

The goal is not:

- `UNKNOWN = 0`

The real goal is:

- important verified DEX activity should not remain unknown
- unsupported or non-DEX activity should still be audited safely

That is the correct tradeoff.

Safe unknowns are better than fake trades.

## 8. `contracts.json` vs `dex-registry.js`

Both now exist, but they do different jobs.

### 8.1 `lib/registry/dex-registry.js`

This is the runtime source of truth.

The router and matcher use this file directly.

### 8.2 `data/registry/contracts.json`

This is the synchronized JSON mirror.

It exists for:

- manual inspection
- audits
- future tooling
- easier export into other systems

Important:

- code runs from the JS registry
- JSON mirrors that state

## 9. How To Add A New DEX

This is the most practical part of the new architecture.

If a new DEX needs support, the preferred workflow is:

1. verify the mainnet addresses or class hashes
2. confirm the event schema from primary sources
3. add the protocol entry to `lib/registry/dex-registry.js`
4. add or update the JSON mirror in `data/registry/contracts.json`
5. decide whether:
   - `base-amm.js` is enough
   - or a specialized decoder is needed
6. if the event shape is already covered by an existing decoder family, do not change the router
7. only add a new decoder file if the event model is genuinely different

That last point matters.

The whole purpose of registry-centric architecture is:

- adding a protocol should usually be a registry task
- not a router rewrite

## 10. When A Specialized Decoder Is Still Needed

Not every DEX should go through one generic path.

Examples:

- Ekubo needs receipt-local context
- AVNU needs aggregator semantics and route-leg handling
- Haiko needs market lookup by `market_id`
- mySwap V1 has its own direct fixed-pool swap layout

So the rule is:

- use `base-amm.js` for repeated AMM families
- use a dedicated decoder when the protocol model is materially different

## 11. Why This Helps Phase 3

Phase 3 depends on clean normalized swap actions.

If Phase 2 misses DEX coverage:

- `stark_trades` stays sparse
- `stark_price_ticks` stay sparse
- pool state becomes incomplete
- candles become biased

So Phase 4 metadata quality directly affects market data quality.

This is not a side concern.

It is part of trade coverage.

## 12. Final Summary

The main architectural idea is simple:

**protocol knowledge belongs in the registry, not scattered across the router**

That gives StarknetDeg:

- cleaner decoder growth
- easier DEX onboarding
- better auditability
- lower `UNKNOWN` for verified DEX activity
- less risk of turning the core router into a protocol graveyard

That is the correct long-term direction for StarknetDeg.
