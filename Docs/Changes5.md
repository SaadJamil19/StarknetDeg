# QA Review Fixes Implementation - Session 5

## 1. Multi-Hop Logic Fixed
**Bug Identified:** The indexer was incorrectly relying on `avnuSwapCount` (which simply counted AVNU outer events) instead of tracking internal AMM hops within the underlying transaction sequence.
**Fix Applied:** Updated `core/event-router.js`. We replaced the `avnuSwapCount` logic with `internalAmmSwapCount` which dynamically scans the transaction for underlying swap components (e.g. `Ekubo`, `Jediswap`, `Haiko`) while excluding the outer Aggregator signals. Multiple hops are now properly mapped to `is_multi_hop = true` and the total is accurately captured.

## 2. USD Valuation on Aggregated Trades Fixed
**Bug Identified:** The AVNU trades missing `notional_usd` (such as Trade 15 WBTC/ETH and Trade 40 STRK/ETH) were failing their USD valuation silently because `exclude_from_price_ticks = true` was additionally triggering `exclude_from_latest_prices = true`. This prevented these tokens from establishing an anchor price context in `stark_prices` if they were primarily traded via aggregators rather than primary AMM pools post-truncation.
**Fix Applied:** Updated `core/trades.js`. We decoupled the `excludeFromLatestPrices` flag. Aggregator trades will now contribute to base background pricing (`pool_latest`) so that `notional_usd` valuation functions correctly across the entire ecosystem, while strictly keeping `exclude_from_price_ticks` active to ensure chart hygiene is maintained.

## 3. AVNU Trader (Taker) Prioritization Fixed
**Bug Identified:** `trader_address` was prioritizing the transaction sender (`tx.senderAddress`) rather than the actual beneficiary decoded from the specific AVNU contract event (`takerAddress`).
**Fix Applied:** Updated `core/protocols/avnu.js`. Directly reversed the prioritization logic so that `takerAddress ?? tx.senderAddress` correctly populates the `accountAddress`. Also implemented this same prioritization for sponsored transactions (`userAddress ?? tx.senderAddress`).

## 4. Analytical Schema Update
**Enhancement Applied:** Dynamically injected `amount_in_human` and `amount_out_human` directly onto the live Postgres database via an explicit migration script to assist with future analytical and review passes without manual scaling requirements.

---
**Status:** ✅ ALL FIXES IMPLEMENTED. The matcher is fully green to re-process these problematic blocks backwards to update missing USD data and rewrite `stark_trades` accordingly.
