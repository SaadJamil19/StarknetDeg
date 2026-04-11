# Production Ready Summary

This file lists the confirmed protections and bug fixes that are now in place for `StarknetDeg`.

## Confirmed protections

- Metadata enrichment only runs on blocks that are deep enough to be treated as final.
- Reorged token metadata can be removed and re-verified using `verified_at_block` and `verification_source`.
- Unknown Ekubo lockers no longer fail silently. They are logged and stored as `unknown_locker_[HEX]`.
- Unknown locker activity is exposed through `view_unidentified_protocols`.
- `sqrt_ratio_after` is stored with high precision so price reconstruction does not lose information.
- `amount_human` and `amount_usd` are stored with high precision so dust transfers do not round away fractional detail.
- `vwap` is recomputed exactly during full rebuilds from `sum(amount_usd) / total_volume`.

## Confirmed bug fixes

- Fixed the trade insert column mismatch that stopped `stark_trades` from filling on real swap blocks.
- Fixed the ERC-20 transfer verification path so trusted tokens can promote into `stark_transfers`.
- Fixed the OHLCV volume mismatch by rebuilding candle volume from canonical signed deltas.
- Fixed the incremental VWAP drift issue by loading the stored VWAP and not falling back to close price.
- Fixed cycle-aware hop counting so graph pricing does not loop or inflate hop distance.
- Fixed reorg safety in the token registry by making verification block-aware.

## Operational result

- The indexer can safely distinguish raw chain data, normalized actions, trades, transfers, prices, candles, metadata, and analytics.
- The docs now describe the live schema and the production hardening rules that the code enforces.
