# StarknetDeg Database Reference

This file is a plain-English reference for the live `StarknetDeg` database schema.

It is based on the current database, not just on old migration files.

Important note:
- `lane` means which finality lane the row belongs to: `PRE_CONFIRMED`, `ACCEPTED_ON_L2`, or `ACCEPTED_ON_L1`.
- Most chain-derived quantities are stored as `NUMERIC` so we do not lose precision.
- `metadata` columns are JSONB catch-all fields for protocol-specific or job-specific extra details.

## `stark_action_norm`

This is the main normalized action table. Raw events are converted into business actions here.

- `action_key`: Unique id for this normalized action row.
- `lane`: Finality lane for this action.
- `block_number`: Block where this action happened.
- `block_hash`: Hash of the block where this action happened.
- `transaction_hash`: Transaction that produced this action.
- `transaction_index`: Position of the transaction inside the block.
- `source_event_index`: Receipt event index that produced this action.
- `protocol`: High-level protocol name for the action, like `ekubo` or `avnu`.
- `action_type`: Type of action, like `swap`, `transfer`, `bridge_in`, `bridge_out`, or `sponsored_transaction`.
- `emitter_address`: Contract address that emitted or originated the underlying event.
- `account_address`: Wallet or account that we attribute this action to.
- `pool_id`: Canonical pool id if the action belongs to a specific pool.
- `token0_address`: First token address for pool-style actions.
- `token1_address`: Second token address for pool-style actions.
- `token_address`: Single token address for one-token actions like ERC-20 transfers.
- `amount0`: First normalized amount, usually for pool or swap actions.
- `amount1`: Second normalized amount, usually for pool or swap actions.
- `amount`: Single normalized amount for one-token actions.
- `router_protocol`: Router or aggregator used for the action, if any.
- `execution_protocol`: Actual execution venue where the action happened.
- `metadata`: Extra structured details that do not deserve dedicated columns.
- `created_at`: Time when this row was first inserted.
- `updated_at`: Time when this row was last updated.

## `stark_block_journal`

This is the block lineage table. It is the backbone for checkpointing, replay, and rollback.

- `lane`: Finality lane for this block row.
- `block_number`: Block number.
- `block_hash`: Hash of the indexed block.
- `parent_hash`: Parent block hash used for lineage checks.
- `old_root`: State root before the block was applied.
- `new_root`: State root after the block was applied.
- `finality_status`: Finality status returned by Starknet for this block.
- `block_timestamp`: Original block timestamp from chain.
- `sequencer_address`: Sequencer that produced the block.
- `starknet_version`: Starknet protocol version reported by the block.
- `l1_da_mode`: Data availability mode recorded on the block.
- `transaction_count`: Number of transactions in the block.
- `event_count`: Number of receipt events derived from the raw block-with-receipts payload. This can be `0` only when a block has no receipt events.
- `state_diff_length`: Size summary for the state diff, derived from the same state-update payload used by `stark_block_state_updates`.
- `succeeded_transaction_count`: Count of successful transactions in this block.
- `reverted_transaction_count`: Count of reverted transactions in this block.
- `l1_handler_transaction_count`: Count of L1 handler transactions in this block.
- `is_orphaned`: Flag showing whether this block was orphaned during reconciliation. Normal canonical rows should stay `false`.
- `orphaned_at`: Time when this block was marked orphaned. This stays `NULL` unless a conflicting block row is superseded.
- `raw_block`: Full raw block payload stored for forensics.
- `raw_state_update`: Full raw state update payload stored for forensics.
- `created_at`: Time when this journal row was inserted.
- `updated_at`: Time when this journal row was last updated.

## `stark_block_state_updates`

This table stores structured state-diff data per block.

- `lane`: Finality lane for this state update row.
- `block_number`: Block number for this state update.
- `block_hash`: Block hash for this state update.
- `old_root`: Old state root before the block.
- `new_root`: New state root after the block.
- `state_diff_length`: Reported size of the state diff.
- `declared_classes`: New class declarations in this block.
- `deployed_contracts`: Contracts deployed in this block.
- `deprecated_declared_classes`: Older declaration format entries if present.
- `nonce_updates`: Contract nonce changes in this block.
- `replaced_classes`: Class replacements for upgradeable contracts.
- `storage_diffs`: Raw storage diff entries from the block.
- `raw_state_update`: Full original RPC state update payload.
- `created_at`: Time when this row was inserted.
- `updated_at`: Time when this row was last updated.

## `stark_bridge_activities`

This table stores bridge-like activities such as L1 handlers and L2-to-L1 messages.

- `bridge_key`: Unique id for this bridge activity row.
- `lane`: Finality lane for this bridge activity.
- `block_number`: Block where the bridge activity happened.
- `block_hash`: Block hash for the bridge activity.
- `transaction_hash`: Transaction that produced the bridge activity.
- `transaction_index`: Position of the transaction in the block.
- `source_event_index`: Event index if the bridge activity came from a specific event.
- `direction`: Direction of the bridge flow, usually `bridge_in` or `bridge_out`.
- `l1_sender`: L1 sender address for inbound bridge activity.
- `l1_recipient`: L1 recipient address for outbound bridge activity.
- `l2_contract_address`: L2 bridge contract involved in the activity.
- `l2_wallet_address`: L2 wallet that received or sent the bridge-related value.
- `token_address`: Token address if the bridge activity can be tied to a token.
- `amount`: Token amount if the bridge payload can be parsed safely.
- `message_to_address`: Message destination address used in the bridge flow.
- `payload`: Raw message payload for this bridge activity.
- `classification`: Parsed classification such as `starkgate_l1_handler` or `message_to_l1`.
- `metadata`: Extra parsing details for this bridge row.
- `created_at`: Time when this row was inserted.
- `updated_at`: Time when this row was last updated.
- `eth_tx_hash`: Matched Ethereum transaction hash for this bridge row when we successfully link the L2 bridge to an L1 StarkGate event. Stays `NULL` while the row is `PENDING` or `UNMATCHED`.
- `eth_block_number`: Ethereum block number where the matched L1 event happened.
- `eth_block_timestamp`: Ethereum timestamp for the matched L1 event.
- `eth_log_index`: Log index of the matched L1 event inside the Ethereum transaction receipt.
- `eth_event_key`: Internal key of the matched `eth_starkgate_events` row.
- `l1_match_status`: Cross-chain match state for this bridge row, usually `PENDING`, `MATCHED`, or `UNMATCHED`. Only `MATCHED` rows are expected to have L1 settlement columns populated.
- `settlement_seconds`: Time gap in seconds between the L1 bridge event and the L2 bridge effect. `NULL` until an L1/L2 match is found.
- `settlement_blocks_l1`: Ethereum block distance observed when the match was recorded. `NULL` until an L1/L2 match is found.
- `settlement_blocks_l2`: Starknet block distance observed when the match was recorded. Reserved for Starknet-side settlement distance and can stay `NULL` when only the L1 distance is known.

## `stark_contract_registry`

This is the contract routing registry used by the decoder engine.

- `contract_address`: Address of the registered contract.
- `class_hash`: Class hash tied to this registry entry.
- `protocol`: Protocol name this contract belongs to.
- `role`: Role of the contract, like router, factory, pair, pool, or singleton.
- `decoder`: Decoder name the router should use for this contract.
- `abi_version`: ABI version tag for this registry entry. Static rows can leave this `NULL` when the decoder uses selector metadata rather than a cached ABI tag.
- `valid_from_block`: First block where this registry entry should be used. Static seed rows are stored as `0`, meaning valid for the full indexed history.
- `valid_to_block`: Last block where this registry entry should be used. `NULL` means the active row has no known end block.
- `metadata`: Extra registry metadata such as selector handlers or source URLs.
- `is_active`: Flag showing whether this registry row is currently active.
- `created_at`: Time when this registry row was inserted.
- `updated_at`: Time when this registry row was last updated.
- `abi_json`: Cached ABI JSON used for decoding and inspection when the ABI refresh worker has fetched it. It can stay `NULL` for static selector-based registry rows.
- `abi_refreshed_at`: Time when the ABI was last refreshed. `NULL` until the ABI refresh worker updates that row.
- `abi_refreshed_at_block`: Block number at which the ABI was last refreshed. `NULL` until a deployment or class-replacement refresh is recorded.

## `stark_contract_security`

This table stores security scan results for tokens and protocol contracts.

- `contract_address`: Contract address being scanned.
- `is_upgradeable`: Flag showing whether the contract looks upgradeable.
- `owner_address`: Owner or admin address if one was detected.
- `class_hash`: Latest known class hash for this contract.
- `risk_label`: High-level risk label like `Baseline` or `Higher Risk`.
- `security_flags`: Detailed security findings stored as JSON.
- `last_scanned_at`: Last time this contract was scanned.
- `created_at`: Time when the row was inserted.
- `updated_at`: Time when the row was last updated.

## `stark_event_raw`

This table stores raw Starknet receipt events before business decoding.

- `lane`: Finality lane for this raw event.
- `block_number`: Block where the raw event was seen.
- `block_hash`: Block hash for the raw event.
- `transaction_hash`: Transaction that emitted the event.
- `transaction_index`: Position of the transaction inside the block.
- `receipt_event_index`: Event index inside the receipt.
- `finality_status`: Finality status of the block when the event was stored.
- `transaction_execution_status`: Execution status of the parent transaction.
- `from_address`: Contract that emitted the event.
- `selector`: First key of the event, used as the event selector.
- `resolved_class_hash`: Class hash resolved for the emitter at that block.
- `normalized_status`: Processing status for this raw event.
- `decode_error`: Error message if decoding failed.
- `keys`: Full raw event keys array.
- `data`: Full raw event data array.
- `raw_event`: Full original raw event payload.
- `created_at`: Time when this raw event row was inserted.
- `updated_at`: Time when this raw event row was last updated.
- `processed_at`: Time when this raw event finished processing.

## `stark_holder_balance_deltas`

This table stores per-transfer balance deltas for wallet concentration analytics.

- `delta_key`: Unique id for this holder balance delta row.
- `lane`: Finality lane for this delta.
- `block_number`: Block where the delta happened.
- `block_hash`: Block hash for the delta.
- `transaction_hash`: Transaction that caused the balance change.
- `transaction_index`: Position of the transaction in the block.
- `source_event_index`: Event index that caused the delta.
- `transfer_key`: Transfer row that this delta came from.
- `token_address`: Token whose balance changed.
- `holder_address`: Holder whose balance changed.
- `delta_amount`: Signed balance change for this holder.
- `balance_direction`: Whether the holder was credited or debited.
- `metadata`: Extra details such as internal transfer classification.
- `created_at`: Time when this delta row was inserted.
- `updated_at`: Time when this delta row was last updated.

## `stark_holder_balances`

This table stores the latest reconstructed token balance for each holder.

- `lane`: Finality lane for this balance row.
- `token_address`: Token whose balance is being tracked.
- `holder_address`: Wallet or holder address.
- `balance`: Latest reconstructed token balance.
- `first_seen_block_number`: First block where this holder/token pair appeared.
- `last_updated_block_number`: Latest block that changed this balance.
- `last_transaction_hash`: Latest transaction that changed this balance.
- `last_transaction_index`: Latest transaction index that changed this balance.
- `last_source_event_index`: Latest source event index that changed this balance.
- `metadata`: Extra details for this holder balance row.
- `created_at`: Time when this balance row was inserted.
- `updated_at`: Time when this balance row was last updated.

## `stark_audit_discrepancies`

This table stores forensic audit rows for replay mismatches that should not be silently hidden by fallback logic.

- `audit_id`: Unique id for the discrepancy row.
- `lane`: Finality lane for this audit row.
- `discrepancy_type`: Audit type. Current values are `NEGATIVE_BALANCE_REPLAY` and `PRICE_MISSING_AUDIT`.
- `block_number`: Block where replay divergence was detected.
- `block_hash`: Block hash for the divergence point.
- `transaction_hash`: Transaction tied to the divergence.
- `transaction_index`: Transaction position inside the block.
- `source_event_index`: Event index tied to the divergence.
- `transfer_key`: Related `stark_transfers.transfer_key` when the discrepancy came from a transfer replay.
- `token_address`: Token contract whose lineage drifted.
- `holder_address`: Holder whose replayed balance went negative.
- `balance_before`: Reconstructed balance before the bad delta was applied.
- `delta_amount`: Signed delta that caused the mismatch.
- `attempted_balance_after`: Replayed post-delta balance before any repair or clamp.
- `resolved_balance`: Final balance chosen after audit handling.
- `resolution_status`: Resolution state such as `logged`, `decoder_review_required`, `rpc_repaired`, `rpc_unavailable`, `clamped_zero`, or `FATAL_MANUAL_REVIEW`.
- `retry_count`: Number of upgrade-aware re-decode strikes recorded for this discrepancy.
- `suspected_cause`: Short cause hint, for example proxy upgrade history, a generic replay gap, or missing gas price history.
- `metadata`: Extra forensic evidence such as proxy flags, replaced class history, observed event class hash, re-decode attempts, gas-anchor fallback details, and RPC fallback notes.
- `created_at`: Time when the row was inserted.
- `updated_at`: Time when the row was last updated.

## `stark_index_state`

This table stores checkpoint state for each indexing lane.

- `indexer_key`: Logical name for the running indexer.
- `lane`: Finality lane for this checkpoint.
- `last_processed_block_number`: Last committed block number for this lane.
- `last_processed_block_hash`: Block hash of the last committed block.
- `last_processed_parent_hash`: Parent hash of the last committed block.
- `last_processed_old_root`: Old state root for the last committed block.
- `last_processed_new_root`: New state root for the last committed block.
- `last_finality_status`: Finality status of the last committed block.
- `last_committed_at`: Time when the checkpoint last advanced.
- `last_error`: Last recorded error for this lane, if any.
- `created_at`: Time when the checkpoint row was inserted.
- `updated_at`: Time when the checkpoint row was last updated.

## `stark_leaderboards`

This table stores ranked analytics outputs for APIs and dashboards.

- `lane`: Finality lane for this leaderboard row.
- `leaderboard_name`: Name of the leaderboard, like top wallets or top concentrations.
- `entity_type`: Type of ranked entity, like wallet, token, or holder.
- `entity_key`: Unique key of the ranked entity.
- `rank`: Rank position inside the leaderboard.
- `metric_value`: Numeric metric used for ranking.
- `as_of_block_number`: Block number the leaderboard was computed against.
- `metadata`: Extra display or calculation details for the leaderboard row.
- `created_at`: Time when the row was inserted.
- `updated_at`: Time when the row was last updated.

## `stark_message_l2_to_l1`

This table stores raw L2-to-L1 messages from transaction receipts.

- `lane`: Finality lane for this message row.
- `block_number`: Block where the message was emitted.
- `block_hash`: Block hash for the message.
- `transaction_hash`: Transaction that emitted the message.
- `transaction_index`: Position of the transaction in the block.
- `message_index`: Position of the message inside the receipt.
- `from_address`: L2 sender address for the message.
- `to_address`: L1 destination address for the message.
- `payload`: Raw message payload array.
- `raw_message`: Full original raw message payload.
- `created_at`: Time when this row was inserted.
- `updated_at`: Time when this row was last updated.
- `l1_consumed_tx_hash`: Ethereum transaction hash that consumed or completed this L2-to-L1 message when we can match it. Stays `NULL` while `message_status = 'SENT'`.
- `l1_consumed_block`: Ethereum block number where the message was consumed.
- `l1_consumed_timestamp`: Ethereum timestamp when the message was consumed.
- `message_status`: Current lifecycle status for the message, such as `SENT` or `CONSUMED`.
- `settlement_seconds`: Time gap between L2 message emission and L1 consumption. `NULL` until a matching L1 consumption event is found.

## `stark_ohlcv_1m`

This table stores 1-minute candles per pool.

- `candle_key`: Unique id for this candle row.
- `lane`: Finality lane for the candle.
- `pool_id`: Pool this candle belongs to.
- `protocol`: Protocol this pool belongs to.
- `token0_address`: First token of the pool.
- `token1_address`: Second token of the pool.
- `bucket_start`: Start time of the 1-minute candle bucket.
- `block_number`: Block that last updated this candle.
- `block_hash`: Block hash that last updated this candle.
- `transaction_hash`: Last transaction that affected this candle.
- `transaction_index`: Last transaction index that affected this candle.
- `source_event_index`: Last event index that affected this candle.
- `open`: Opening price for the minute.
- `high`: Highest price seen in the minute.
- `low`: Lowest price seen in the minute.
- `close`: Closing price for the minute.
- `price_is_decimals_normalized`: Flag showing whether price math used confirmed decimals.
- `volume0`: Raw token0 volume for the candle.
- `volume1`: Raw token1 volume for the candle.
- `volume_usd`: USD volume for the candle.
- `trade_count`: Number of trades that contributed to the candle.
- `seeded_from_previous_close`: Flag showing whether the candle was gap-filled from the previous close.
- `metadata`: Extra candle details.
- `created_at`: Time when the candle row was inserted.
- `updated_at`: Time when the candle row was last updated.
- `pending_enrichment`: Flag showing that the candle needs recalculation after metadata or prices improve.
- `tick_open`: Opening tick value for the minute when the protocol exposes ticks.
- `tick_close`: Closing tick value for the minute when the protocol exposes ticks.
- `sqrt_ratio_open`: Opening sqrt-ratio value for the candle window.
- `sqrt_ratio_close`: Closing sqrt-ratio value for the candle window.
- `fee_tier_bps`: Fee tier carried into the candle if the source trade had it.
- `tick_spacing`: Tick spacing carried into the candle if the source trade had it.
- `volume0_usd`: USD value of token0-side volume for the candle.
- `volume1_usd`: USD value of token1-side volume for the candle.
- `vwap`: Volume-weighted average price for the candle, calculated from the normalized execution price rather than the raw ratio so token-decimal mismatches do not distort the candle. When a candle is fully rebuilt, VWAP is recomputed exactly from `sum(amount_usd) / total_volume` so the nightly rebuild stays mathematically correct.

## `stark_pool_latest`

This table stores the latest materialized state for each pool.

- `lane`: Finality lane for this pool snapshot.
- `pool_id`: Canonical id of the pool.
- `protocol`: Protocol that owns the pool.
- `token0_address`: First token in the pool.
- `token1_address`: Second token in the pool.
- `block_number`: Block where this latest snapshot came from.
- `block_hash`: Block hash of the latest snapshot.
- `block_timestamp`: Timestamp of the block that produced this snapshot.
- `transaction_hash`: Transaction that produced this snapshot.
- `transaction_index`: Transaction position inside the block.
- `source_event_index`: Source event index for this snapshot.
- `reserve0`: Latest known reserve of token0 for reserve-based XYK or solidly-style snapshots. CLMM swap snapshots such as Ekubo intentionally leave this `NULL`.
- `reserve1`: Latest known reserve of token1 for reserve-based XYK or solidly-style snapshots. CLMM swap snapshots such as Ekubo intentionally leave this `NULL`.
- `liquidity`: Latest known liquidity value for the pool. This is the primary state quantity for Ekubo-style CLMM snapshots.
- `sqrt_ratio`: Latest sqrt price ratio if the pool model uses it.
- `price_token1_per_token0`: Latest price of token1 quoted in token0 terms.
- `price_token0_per_token1`: Latest inverse price.
- `price_is_decimals_normalized`: Flag showing whether price used confirmed decimals.
- `tvl_usd`: Latest TVL estimate in USD. This is populated for reserve-based snapshots when token decimals and USD prices are available; Ekubo CLMM swap snapshots can leave it `NULL`.
- `snapshot_kind`: Kind of snapshot that produced this row.
- `metadata`: Extra pool snapshot details.
- `created_at`: Time when this latest row was inserted.
- `updated_at`: Time when this latest row was last updated.
- `tick_after`: Latest known tick after the event that produced this snapshot.
- `tick_spacing`: Tick spacing for the pool when known.
- `fee_tier`: Pool fee tier when known.
- `extension_address`: Extra extension or hook address if the pool model uses one.
- `locker_address`: Locker or router-like address that delivered the flow into the pool when known.
- `amount0_delta`: Signed token0 delta associated with this snapshot when it came from a swap-style event.
- `amount1_delta`: Signed token1 delta associated with this snapshot when it came from a swap-style event.

## `stark_pool_state`

This is the older compatibility pool-state table kept alongside the newer split tables.

- `lane`: Finality lane for this pool snapshot.
- `pool_id`: Canonical id of the pool.
- `protocol`: Protocol that owns the pool.
- `token0_address`: First token in the pool.
- `token1_address`: Second token in the pool.
- `block_number`: Block where this snapshot came from.
- `block_hash`: Block hash for this snapshot.
- `block_timestamp`: Timestamp of the snapshot block.
- `transaction_hash`: Transaction that produced the snapshot.
- `transaction_index`: Transaction position inside the block.
- `source_event_index`: Event index that produced the snapshot.
- `reserve0`: Reserve of token0 at that snapshot for reserve-based pool models. CLMM snapshots can leave this `NULL`.
- `reserve1`: Reserve of token1 at that snapshot for reserve-based pool models. CLMM snapshots can leave this `NULL`.
- `liquidity`: Liquidity value captured in the snapshot.
- `sqrt_ratio`: Sqrt price ratio captured in the snapshot.
- `price_token1_per_token0`: Price of token1 in token0 terms at that moment.
- `price_token0_per_token1`: Inverse price at that moment.
- `price_is_decimals_normalized`: Flag showing whether decimals were confirmed.
- `tvl_usd`: TVL estimate in USD for that snapshot. It can stay `NULL` for CLMM snapshots or when prices/decimals are not sufficient for reserve valuation.
- `snapshot_kind`: Type of pool snapshot stored in this row.
- `metadata`: Extra snapshot details.
- `created_at`: Time when this row was inserted.
- `updated_at`: Time when this row was last updated.

## `stark_pool_state_history`

This is the append-only history table for pool state changes.

- `pool_state_key`: Unique id for this historical pool snapshot.
- `lane`: Finality lane for this snapshot.
- `pool_id`: Canonical id of the pool.
- `protocol`: Protocol that owns the pool.
- `token0_address`: First token in the pool.
- `token1_address`: Second token in the pool.
- `block_number`: Block where the state change happened.
- `block_hash`: Block hash for the state change.
- `block_timestamp`: Timestamp of the block that produced the state change.
- `transaction_hash`: Transaction that produced the state change.
- `transaction_index`: Transaction position inside the block.
- `source_event_index`: Source event index for the state change.
- `reserve0`: Reserve0 recorded in this snapshot for reserve-based pool models. CLMM swap snapshots intentionally leave this `NULL`.
- `reserve1`: Reserve1 recorded in this snapshot for reserve-based pool models. CLMM swap snapshots intentionally leave this `NULL`.
- `liquidity`: Liquidity recorded in this snapshot. This is the main CLMM state value for Ekubo rows.
- `sqrt_ratio`: Sqrt ratio recorded in this snapshot.
- `price_token1_per_token0`: Price at this snapshot.
- `price_token0_per_token1`: Inverse price at this snapshot.
- `price_is_decimals_normalized`: Flag showing whether confirmed decimals were used.
- `tvl_usd`: TVL estimate in USD at this snapshot. It can stay `NULL` for CLMM swap snapshots or when prices/decimals are not sufficient for reserve valuation.
- `snapshot_kind`: Type of snapshot event that produced this row.
- `metadata`: Extra details for this state change.
- `created_at`: Time when this row was inserted.
- `updated_at`: Time when this row was last updated.
- `tick_after`: Tick value after the pool event when the protocol exposes one.
- `tick_spacing`: Tick spacing for the pool when known.
- `fee_tier`: Pool fee tier when known.
- `extension_address`: Extra extension or hook address for pool models that support it.
- `locker_address`: Locker or router-like address tied to the pool event when known.
- `amount0_delta`: Signed token0 delta tied to the state change if it came from a swap-style event.
- `amount1_delta`: Signed token1 delta tied to the state change if it came from a swap-style event.

## `stark_price_ticks`

This table stores high-frequency token price updates.

- `tick_key`: Unique id for this price tick.
- `lane`: Finality lane for the price tick.
- `block_number`: Block where the price tick was observed.
- `block_hash`: Block hash for the price tick.
- `block_timestamp`: Timestamp of the tick block.
- `transaction_hash`: Transaction that produced the tick.
- `transaction_index`: Transaction position inside the block.
- `source_event_index`: Event index that produced the tick.
- `token_address`: Token whose price is being stored.
- `source_pool_id`: Pool that was used to derive the price.
- `quote_token_address`: Token used as the quote side for this price.
- `price_quote`: Raw quoted price before USD resolution.
- `price_usd`: USD price stored for the token. Stable anchors such as USDC, USDT, DAI, and CASH are intentionally stored as `1`.
- `price_source`: Source label for the price, like on-chain ratio or CMC.
- `bucket_1m`: Minute bucket that this tick belongs to.
- `metadata`: Extra price derivation details.
- `created_at`: Time when this row was inserted.
- `updated_at`: Time when this row was last updated.
- `price_is_stale`: Flag showing whether the price source is stale. It is normally `false` for fresh direct observations and becomes `true` only when the latest usable source is outside the configured freshness window.
- `price_updated_at_block`: Block where the underlying price source was last refreshed.
- `hops_from_stable`: Number of intermediate bridge assets on the shortest cycle-free path between this token and the stable anchor used for pricing, so direct stable is `0`, one bridge is `1`, and two bridges are `2`. External market-data ticks such as CMC anchors can leave this `NULL` because they do not use an on-chain stable path.
- `is_aggregator_derived`: Flag showing whether this price came from an aggregator-derived trade rather than a direct venue observation. Aggregator-derived prices are excluded from price tables by default unless explicitly enabled, so normal rows are usually `false`.
- `sell_amount_raw`: Raw sold-side amount that backed this price observation.
- `buy_amount_raw`: Raw bought-side amount that backed this price observation.
- `price_raw_execution`: Raw execution price before later normalization or smoothing.
- `price_deviation_pct`: Deviation percentage between raw execution price and final stored price.
- `low_confidence`: Flag showing that this price observation is too many bridge hops away from a stable anchor to be treated as strong price truth.

## `stark_prices`

This table stores the latest price per token.

- `lane`: Finality lane for the latest price row.
- `token_address`: Token whose latest price is stored.
- `block_number`: Block where this latest price row was last updated.
- `block_hash`: Block hash for the latest price row.
- `block_timestamp`: Timestamp when this latest price row was last updated.
- `transaction_hash`: Transaction that last updated this price.
- `transaction_index`: Transaction index that last updated this price.
- `source_event_index`: Event index that last updated this price.
- `source_pool_id`: Pool used for the last price update.
- `quote_token_address`: Quote token used in the last price derivation.
- `price_quote`: Raw quote-side price before USD resolution.
- `price_usd`: Latest USD price for the token. Stable anchors are expected to show `1`.
- `price_source`: Source label for this latest price.
- `metadata`: Extra details about how the latest price was derived.
- `created_at`: Time when the row was inserted.
- `updated_at`: Time when the row was last updated.
- `price_is_stale`: Flag showing whether the latest price is stale. It is normally `false` for fresh direct observations.
- `price_updated_at_block`: Block where the price source was last refreshed.
- `bucket_1m`: Minute bucket where the latest contributing observation belongs.
- `hops_from_stable`: Number of intermediate bridge assets on the shortest cycle-free path between this token and the stable anchor used for pricing, so direct stable is `0`, one bridge is `1`, and two bridges are `2`.
- `is_aggregator_derived`: Flag showing whether the latest price came from an aggregator-derived observation. This is normally `false` because aggregator-derived price candidates are filtered out by default.
- `sell_amount_raw`: Raw sold-side amount that backed the latest price.
- `buy_amount_raw`: Raw bought-side amount that backed the latest price.
- `price_raw_execution`: Raw execution price before later normalization or smoothing.
- `price_deviation_pct`: Deviation percentage between raw execution price and final stored price.
- `low_confidence`: Flag showing that this latest price row is weak and should be treated carefully because the pricing path is too far from a stable anchor.

## `stark_reconciliation_log`

This table records rollback and replay events during finality reconciliation.

- `reconciliation_id`: Unique id for the reconciliation attempt.
- `lane`: Finality lane being reconciled.
- `from_block_number`: First block in the reconciliation window.
- `to_block_number`: Last block in the reconciliation window.
- `anchor_block_number`: Last safe anchor block used for replay.
- `expected_parent_hash`: Parent hash we expected locally.
- `observed_parent_hash`: Parent hash observed from remote chain data.
- `expected_old_root`: Old root we expected locally.
- `observed_old_root`: Old root observed from remote chain data.
- `expected_new_root`: New root we expected locally.
- `observed_new_root`: New root observed from remote chain data.
- `status`: Current status of the reconciliation attempt.
- `reason`: Reason why reconciliation was triggered.
- `metadata`: Extra debug data about the reconciliation event.
- `detected_at`: Time when divergence was detected.
- `resolved_at`: Time when the reconciliation was resolved.
- `created_at`: Time when this log row was inserted.
- `updated_at`: Time when this log row was last updated.

## `stark_token_concentration`

This table stores holder concentration metrics per token.

- `lane`: Finality lane for this concentration row.
- `token_address`: Token being analyzed.
- `holder_address`: Holder whose concentration is being measured.
- `block_number`: Block number used for this concentration snapshot.
- `balance`: Holder balance at the snapshot.
- `total_supply`: Total supply used for the concentration calculation.
- `balance_usd`: USD value of the holder balance if price exists.
- `concentration_ratio`: Fraction of total supply held by this wallet.
- `concentration_bps`: Same concentration expressed in basis points.
- `holder_rank`: Rank of this holder among all holders of the token.
- `is_whale`: Flag showing whether this holder crossed the whale threshold.
- `metadata`: Extra concentration details.
- `created_at`: Time when this row was inserted.
- `updated_at`: Time when this row was last updated.

## `stark_token_metadata`

This table stores token metadata and token-level enrichment.

- `token_address`: Token contract address.
- `name`: Token name fetched or resolved by the metadata jobs.
- `symbol`: Token symbol fetched or resolved by the metadata jobs.
- `decimals`: Token decimals used for human-readable conversion. This is now treated as authoritative only when actually resolved, not guessed.
- `total_supply`: Total supply fetched from chain when available.
- `is_verified`: Flag showing whether this token is treated as verified.
- `last_refreshed_block`: Last block number when metadata was refreshed.
- `last_refreshed_at`: Last time a metadata worker updated this row.
- `metadata`: Extra metadata fields, including which tier resolved each field and whether off-chain authority fallback was used.
- `created_at`: Time when this token metadata row was inserted.
- `updated_at`: Time when this row was last updated.

Important strategy:
- Tier 1 is now a static core-token registry inside `core/constants/tokens.js` for hot-path tokens such as `ETH`, `USDC`, `USDT`, `STRK`, `DAI`, and `WBTC`.
- Tier 2 is `stark_token_metadata`, which works as the persistent cache before any new RPC call is attempted.
- Tier 3 is live on-chain lookup through `name()`, `symbol()`, `decimals()`, and `totalSupply()`.
- Tier 4 is an explorer authority fallback, currently wired around Voyager's documented API surface.

## `stark_token_metadata_refresh_queue`

This table stores retryable metadata work items for unresolved token decimals and late token enrichment.

- `queue_key`: Queue primary key. We use the normalized token address itself.
- `token_address`: Token contract address to resolve.
- `first_seen_block`: Earliest block where the token was seen in unresolved data.
- `latest_seen_block`: Latest block where the token was seen in unresolved data.
- `status`: Queue status such as `pending`, `processing`, `processed`, or `failed`.
- `attempts`: Retry counter for the metadata worker.
- `enqueued_at`: When the token was first or last re-enqueued.
- `processing_started_at`: When the active processing attempt began. This is a transient worker-lock timestamp and is expected to return to `NULL` after a row is processed or failed.
- `processed_at`: When the latest successful attempt finished.
- `last_error`: Last worker error when resolution still failed.
- `metadata`: Queue context such as source tables, retry reason, and sync notes.
- `created_at`: Time when the queue row was created.
- `updated_at`: Time when the queue row was last updated.

## `tokens`

This is the shared token registry table used by transfer trust, pricing, and enrichment.

- `address`: Token contract address used as the primary key.
- `symbol`: Shared token symbol that the rest of the pipeline can reuse.
- `name`: Shared token name that the rest of the pipeline can reuse.
- `decimals`: Canonical decimals value used by pricing and transfer normalization.
- `token_type`: Internal token classification such as `erc20` or another registry label.
- `is_stable`: Flag showing whether this token should be treated as a stable anchor for price logic. Known stable symbols in the allowlist are forced to `true` even if an upstream metadata payload omitted or denied the flag.
- `is_verified`: Flag showing whether this token is trusted enough for shared pipeline use.
- `verified_at_block`: Block number when this token row was last verified from live indexed metadata instead of only seed truth.
- `verification_source`: Source that most recently verified this token row, such as the metadata refresher or the static seed registry.
- `coingecko_id`: Optional external market-data identifier for enrichment or UI mapping.
- `logo_url`: Optional logo URL for downstream display layers.
- `deploy_tx_hash`: Transaction hash that deployed the token contract when known. This stays `NULL` when the token deployment happened before the indexed block window or when no deploy transaction for that token was observed.
- `deployed_at`: Deployment timestamp when known. This stays `NULL` when the deployment was not present in indexed state updates.
- `metadata`: Extra token-registry details, including sync notes from enrichment jobs.
- `created_at`: Time when this token-registry row was inserted.
- `updated_at`: Time when this token-registry row was last updated.

Important strategy:
- `UNIQUE(address)` alone is not enough for reorg safety.
- `verified_at_block` is used so token rows learned during orphaned blocks can be reverted or re-verified later.
- During reconciliation, metadata rows refreshed in the orphaned window are deleted and affected token-registry rows are either removed or reset back to safe seed truth.

## `stark_trades`

This table stores normalized DEX trades.

- `trade_key`: Unique id for this trade row.
- `lane`: Finality lane for this trade.
- `block_number`: Block where the trade happened.
- `block_hash`: Block hash for the trade.
- `block_timestamp`: Timestamp of the block that contained the trade.
- `transaction_hash`: Transaction that produced the trade.
- `transaction_index`: Position of the transaction inside the block.
- `source_event_index`: Event index that produced the trade.
- `protocol`: Protocol that emitted the trade action.
- `router_protocol`: Human-readable router or aggregator name used for the trade when we can resolve the locker, such as `AVNU`, `Haiko`, or `Fibrous`. If the locker is not mapped yet, this becomes `unknown_locker_[HEX]` so attribution loss is visible instead of silent.
- `execution_protocol`: Actual venue that executed the trade.
- `pool_id`: Canonical pool id for the trade.
- `trader_address`: Wallet we attribute the trade to.
- `token0_address`: First token in the pool definition.
- `token1_address`: Second token in the pool definition.
- `token_in_address`: Token the trader sent into the swap.
- `token_out_address`: Token the trader received from the swap.
- `amount0_delta`: Signed raw delta for token0.
- `amount1_delta`: Signed raw delta for token1.
- `volume_token0`: Absolute raw volume for token0.
- `volume_token1`: Absolute raw volume for token1.
- `amount_in`: Raw input amount for the trade.
- `amount_out`: Raw output amount for the trade.
- `price_raw_token1_per_token0`: Raw price ratio before decimal normalization.
- `price_raw_token0_per_token1`: Raw inverse price ratio before decimal normalization.
- `price_token1_per_token0`: Decimal-normalized trade price.
- `price_token0_per_token1`: Decimal-normalized inverse trade price.
- `price_is_decimals_normalized`: Flag showing whether confirmed token decimals were used.
- `price_source`: Source label for the trade price calculation.
- `notional_usd`: USD notional value of the trade if price resolution succeeded.
- `bucket_1m`: Minute bucket used for candle aggregation.
- `metadata`: Extra trade details such as price path or enrichment flags.
- `created_at`: Time when this trade row was inserted.
- `updated_at`: Time when this trade row was last updated.
- `pending_enrichment`: Flag showing whether this trade needs recalculation after metadata improves. When token decimals are unresolved, raw amounts are still stored but `amount_in_human` and `amount_out_human` stay `NULL` until the metadata sync worker repairs them.
- `locker_address`: Locker or router-like address that delivered the flow into the execution venue when known.
- `liquidity_after`: Liquidity value after the trade when the protocol reports it.
- `sqrt_ratio_after`: Sqrt-ratio after the trade when the protocol reports it, stored in high-precision numeric form so it can be reconstructed without float loss.
- `tick_after`: Tick value after the trade when the protocol reports it.
- `tick_spacing`: Tick spacing for the pool when known.
- `fee_tier`: Fee tier for the pool when known.
- `extension_address`: Extra extension or hook address for protocols that expose one.
- `is_multi_hop`: Flag showing whether this trade belongs to a grouped multi-hop route.
- `hop_index`: Position of this trade inside a grouped route when route grouping applies.
- `total_hops`: Total number of hops inside the grouped route when known.
- `route_group_key`: Shared key used to tie multiple route hops back to one route group.
- `price_raw_execution`: Raw execution price captured before the stability filter and later normalization layers.
- `price_deviation_pct`: Deviation percentage between raw execution price and final stored price.
- `hops_from_stable`: Number of intermediate bridge assets on the shortest cycle-free path between this trade and the stable anchor used for valuation, so direct stable is `0`, one bridge is `1`, and two bridges are `2`. This is a pricing-path value, not the same thing as `hop_index` or `total_hops`; a multi-hop route can still have `hops_from_stable = 0` if valuation touched a stable directly.
- `is_aggregator_derived`: Flag showing whether the trade row came from an aggregator-derived route summary. Direct venue legs stay `false`; AVNU-style summary rows are `true`.
- `l1_deposit_tx_hash`: Ethereum deposit transaction linked to this trade when the wallet traded after bridging.
- `l1_deposit_block`: Ethereum block number of the linked deposit.
- `l1_deposit_timestamp`: Ethereum timestamp of the linked deposit.
- `l1_wallet_address`: Ethereum wallet that funded this trade path when known.
- `seconds_since_deposit`: Number of seconds between the deposit and this trade.
- `is_post_bridge_trade`: Flag showing whether this trade happened inside the configured rapid post-bridge window.

## `stark_transfers`

This table stores canonical token transfer facts.

- `transfer_key`: Unique id for this transfer row.
- `lane`: Finality lane for this transfer.
- `block_number`: Block where the transfer happened.
- `block_hash`: Block hash for the transfer.
- `transaction_hash`: Transaction that emitted the transfer.
- `transaction_index`: Position of the transaction inside the block.
- `source_event_index`: Event index that produced the transfer.
- `token_address`: Token contract that emitted the transfer.
- `from_address`: Sender address in the transfer.
- `to_address`: Receiver address in the transfer.
- `amount`: Raw token amount transferred.
- `protocol`: Protocol label for the transfer, usually `erc20`.
- `metadata`: Extra transfer details such as symbol, decimals, and verification gate.
- `created_at`: Time when this transfer row was inserted.
- `updated_at`: Time when this row was last updated.
- `amount_human`: Human-readable amount after applying token decimals. Stored as high-precision `NUMERIC(78,30)` so dust transfers do not collapse into scientific notation or lose fractional detail.
- `amount_usd`: USD value of the transfer when the token can be safely priced. Stored with the same high-precision `NUMERIC(78,30)` handling as `amount_human`.
- `token_symbol`: Token symbol copied into the transfer row for later analytics and APIs.
- `token_name`: Token name copied into the transfer row for later analytics and APIs.
- `token_decimals`: Decimals value used to derive `amount_human`.
- `transfer_type`: Internal classification such as `standard_transfer` or `routing_transfer` when the transfer can be tied back to a multi-hop `route_group_key`. Route matching now uses token identity plus raw-amount matching within `1 bps` (`0.01%`) tolerance so router dust does not cause false negatives.
- `is_internal`: Flag showing whether the transfer is considered internal movement rather than external flow. Routing transfers and rows whose counterparty is proven as `router` or `contract` are internal.
- `counterparty_type`: Lightweight counterparty label used by later analytics. Current enrichment upgrades unknown rows to `router` or `contract` when same-transaction transfer flow and swap evidence support that conclusion; otherwise it stays `unknown`.

## `stark_tx_raw`

This table stores raw transaction and receipt data before high-level decoding.

- `lane`: Finality lane for this raw transaction.
- `block_number`: Block where the transaction was included.
- `block_hash`: Block hash for the transaction.
- `transaction_index`: Position of the transaction in the block.
- `transaction_hash`: Hash of the transaction.
- `tx_type`: Starknet transaction type such as `INVOKE` or `L1_HANDLER`.
- `finality_status`: Finality status of the transaction’s block.
- `execution_status`: Execution result of the transaction.
- `sender_address`: Sender or account address for the transaction.
- `contract_address`: Contract address for transaction types that target a contract directly, such as `L1_HANDLER` and `DEPLOY_ACCOUNT`. Normal `INVOKE` rows usually use `sender_address` instead and can leave this `NULL`.
- `l1_sender_address`: Parsed L1 sender for L1 handler transactions. This is expected to be `NULL` for non-`L1_HANDLER` transaction types.
- `nonce`: Transaction nonce.
- `actual_fee_amount`: Actual fee amount charged by Starknet.
- `actual_fee_unit`: Fee unit, usually `WEI` or `FRI`.
- `events_count`: Number of receipt events in the transaction.
- `messages_sent_count`: Number of L2-to-L1 messages in the transaction.
- `revert_reason`: Revert reason if the transaction reverted.
- `normalized_status`: Processing status inside our pipeline.
- `decode_error`: Pipeline error message if decoding failed.
- `calldata`: Raw transaction calldata array.
- `raw_transaction`: Full raw transaction payload.
- `raw_receipt`: Full raw receipt payload.
- `created_at`: Time when this row was inserted.
- `updated_at`: Time when this row was last updated.
- `processed_at`: Time when this transaction finished our processing pipeline.

## `stark_unknown_event_audit`

This table stores events we intentionally did not trust or could not decode.

- `audit_id`: Unique id for the audit row.
- `lane`: Finality lane for this audit row.
- `block_number`: Block where the audited event happened.
- `block_hash`: Block hash for the audited event.
- `transaction_hash`: Transaction containing the audited event.
- `transaction_index`: Transaction position inside the block.
- `source_event_index`: Event index that was audited.
- `emitter_address`: Contract that emitted the audited event.
- `selector`: Event selector for the audited event.
- `reason`: Reason why the event was audited instead of promoted.
- `metadata`: Extra context explaining the audit reason.
- `created_at`: Time when the audit row was inserted.

## `view_unidentified_protocols`

This internal view counts unknown locker warnings so the team can see which protocol lockers still need registry coverage.

- `locker_identifier`: Stable grouping key for the unidentified locker, using the router label when available.
- `router_protocol`: The unknown locker label stored on the trade row, usually `unknown_locker_[HEX]`.
- `locker_address`: Raw locker address if the decoder captured one.
- `execution_protocol`: Execution venue tied to the unknown locker event.
- `protocol`: Protocol family that produced the trade row.
- `occurrence_count`: Number of times this unknown locker appeared.
- `first_seen_block_number`: First block where this locker was seen.
- `last_seen_block_number`: Latest block where this locker was seen.
- `first_seen_at`: First time this locker was recorded.
- `last_seen_at`: Latest time this locker was recorded.

## `stark_wallet_bridge_flows`

This table stores per-wallet bridge flow rollups.

- `lane`: Finality lane for this wallet bridge rollup.
- `wallet_address`: Wallet whose bridge flow is being summarized.
- `token_address`: Token the bridge flow summary belongs to.
- `bridge_in_amount`: Total inbound bridged amount for the wallet/token pair.
- `bridge_out_amount`: Total outbound bridged amount for the wallet/token pair.
- `net_bridge_flow`: Inbound minus outbound amount.
- `bridge_inflow_usd`: USD value of all inbound bridge flow.
- `bridge_outflow_usd`: USD value of all outbound bridge flow.
- `net_bridge_flow_usd`: Net USD bridge flow.
- `bridge_in_count`: Number of bridge-in activities.
- `bridge_out_count`: Number of bridge-out activities.
- `unresolved_activity_count`: Count of bridge rows we could not fully price or parse.
- `avg_settlement_seconds`: Average bridge settlement time for matched L1-linked flows in this wallet/token pair.
- `min_settlement_seconds`: Fastest matched bridge settlement time seen for this wallet/token pair.
- `max_settlement_seconds`: Slowest matched bridge settlement time seen for this wallet/token pair.
- `pending_l1_match_count`: Number of bridge rows for this wallet/token pair that are still waiting for L1 matching.
- `l1_verified_inflow_usd`: USD value of inbound bridge flow that is now backed by a confirmed L1 match.
- `l1_verified_outflow_usd`: USD value of outbound bridge flow that is now backed by a confirmed L1 match.
- `price_source`: Price source used for this rollup.
- `price_is_stale`: Flag showing whether the price source was stale.
- `price_updated_at_block`: Block where the price source was last refreshed.
- `last_bridge_block_number`: Most recent block where this wallet had bridge activity for the token.
- `last_bridge_transaction_hash`: Most recent bridge transaction hash for the wallet/token pair.
- `metadata`: Extra rollup details such as classification counts.
- `created_at`: Time when this row was inserted.
- `updated_at`: Time when this row was last updated.

## `stark_wallet_pnl_events`

This table stores wallet-level realized PnL events produced from trades.

- `pnl_event_key`: Unique id for this wallet PnL event.
- `lane`: Finality lane for this PnL event.
- `wallet_address`: Wallet whose PnL is being tracked.
- `token_address`: Token position affected by this event.
- `trade_key`: Trade row that caused this PnL event.
- `block_number`: Block where the PnL event happened.
- `block_hash`: Block hash for the PnL event.
- `block_timestamp`: Timestamp of the event block.
- `transaction_hash`: Transaction that caused the PnL event.
- `transaction_index`: Position of the transaction inside the block.
- `source_event_index`: Event index that caused the PnL event.
- `side`: Whether the event is a buy-side or sell-side PnL event.
- `quantity`: Total quantity involved in the event.
- `external_quantity`: Quantity attributed to external bridge inventory rather than traded inventory.
- `traded_quantity`: Quantity attributed to traded inventory.
- `proceeds_usd`: USD proceeds realized by this event.
- `cost_basis_usd`: USD cost basis consumed by this event.
- `realized_pnl_usd`: Realized PnL for this event.
- `position_amount_after`: Position amount remaining after this event.
- `remaining_cost_basis_usd`: Remaining cost basis after the event.
- `metadata`: Extra calculation details for this PnL event.
- `created_at`: Time when this row was inserted.
- `updated_at`: Time when this row was last updated.
- `gas_fee_amount`: Raw gas fee amount attributed to this event.
- `gas_fee_token_address`: Token used to pay the gas fee.
- `gas_fee_usd`: USD value of gas attributed to this event.

## `stark_wallet_positions`

This table stores current wallet positions by token.

- `lane`: Finality lane for this wallet position.
- `wallet_address`: Wallet whose position is being tracked.
- `token_address`: Token of the position.
- `traded_quantity`: Quantity acquired through trading logic.
- `external_quantity`: Quantity attributed to non-trading inflows like bridges.
- `total_quantity`: Total quantity held in this modeled position.
- `traded_cost_basis_usd`: Cost basis tied to traded inventory.
- `external_cost_basis_usd`: Cost basis tied to external inventory.
- `dust_loss_usd`: Cost basis written off when microscopic FIFO lots are closed by the dust threshold.
- `average_traded_entry_price_usd`: Average entry price for traded inventory.
- `last_price_usd`: Latest price used to mark the position.
- `realized_pnl_usd`: Cumulative realized PnL for this wallet/token pair.
- `unrealized_pnl_usd`: Current unrealized PnL for this wallet/token pair.
- `trade_count`: Number of trades that affected this position.
- `bridge_in_count`: Number of bridge-in events affecting this position.
- `bridge_out_count`: Number of bridge-out events affecting this position.
- `first_activity_block_number`: First block where this wallet/token pair became active.
- `last_activity_block_number`: Most recent block where this wallet/token pair changed.
- `last_activity_timestamp`: Most recent timestamp where this position changed.
- `pending_pricing`: Flag showing whether the position needs a repair pass due to missing prices.
- `metadata`: Extra position details and repair flags.
- `created_at`: Time when this row was inserted.
- `updated_at`: Time when this row was last updated.

## `stark_wallet_stats`

This table stores wallet-level summary analytics.

- `lane`: Finality lane for this wallet stats row.
- `wallet_address`: Wallet being summarized.
- `first_trade_block_number`: First block where this wallet traded.
- `last_trade_block_number`: Most recent block where this wallet traded.
- `total_trades`: Total number of trades attributed to this wallet.
- `total_volume_usd`: Total traded volume in USD.
- `total_dust_loss_usd`: Aggregate dust write-off tracked across all wallet positions.
- `realized_pnl_usd`: Total realized PnL in USD.
- `unrealized_pnl_usd`: Total unrealized PnL in USD.
- `net_pnl_usd`: Net PnL combining realized and unrealized values after subtracting dust loss.
- `bridge_inflow_usd`: Total inbound bridge flow in USD.
- `bridge_outflow_usd`: Total outbound bridge flow in USD.
- `net_bridge_flow_usd`: Net bridge flow in USD.
- `l1_wallet_address`: Ethereum wallet address linked to this Starknet wallet when we successfully match StarkGate deposits.
- `l1_bridge_inflow_usd`: Confirmed L1-backed inbound bridge value in USD.
- `l1_bridge_outflow_usd`: Confirmed L1-backed outbound bridge value in USD.
- `avg_bridge_settlement_s`: Average bridge settlement time in seconds for this wallet.
- `first_l1_activity_block`: First Ethereum block where this wallet had a matched bridge event.
- `last_l1_activity_block`: Latest Ethereum block where this wallet had a matched bridge event.
- `bridge_activity_count`: Total number of bridge activities for this wallet.
- `winning_trade_count`: Number of profitable trade exits.
- `losing_trade_count`: Number of losing trade exits.
- `win_rate`: Winning trades divided by resolved trade exits.
- `best_trade_pnl_usd`: Best single trade PnL seen for this wallet.
- `best_trade_tx_hash`: Transaction hash for the best trade.
- `best_trade_token_address`: Token involved in the best trade.
- `best_trade_at_block`: Block where the best trade happened.
- `metadata`: Extra wallet-level statistics and counters.
- `created_at`: Time when this row was inserted.
- `updated_at`: Time when this row was last updated.
- `total_gas_fees_usd`: Total gas fees attributed to this wallet in USD.

## `stark_whale_alert_candidates`

This table stores wallets and events that look whale-like and may deserve alerting.

- `alert_key`: Unique id for this whale alert candidate.
- `lane`: Finality lane for this alert row.
- `block_number`: Block number used for this alert.
- `wallet_address`: Wallet that triggered the alert.
- `token_address`: Token relevant to the alert.
- `alert_type`: Type of alert, such as bridge flow, concentration, or bridge-then-trade.
- `severity`: Severity label for the alert.
- `metric_amount`: Raw token amount that triggered the alert.
- `metric_usd`: USD value that triggered the alert.
- `related_trade_key`: Trade row linked to this alert, if any.
- `related_bridge_key`: Bridge row linked to this alert, if any.
- `metadata`: Extra evidence and scoring details for the alert.
- `created_at`: Time when this alert row was inserted.
- `updated_at`: Time when this alert row was last updated.
- `velocity_score`: Score showing how quickly the wallet bridged and then traded.
- `eth_tx_hash`: Ethereum transaction hash that triggered this alert when the alert was driven by L1 bridge activity.
- `eth_block_number`: Ethereum block number for the L1 trigger.
- `l1_trigger_type`: Human-readable L1 trigger label such as `large_deposit`.
- `l1_trigger_amount`: Raw L1 amount that triggered the alert.
- `l1_trigger_usd`: USD value of the L1 trigger amount.
- `l1_to_l2_seconds`: Time from the L1 trigger to the observed L2 response.

## `eth_block_journal`

This table stores raw Ethereum L1 block truth for the StarkGate indexer.

- `block_number`: Ethereum block number.
- `block_hash`: Block hash for this Ethereum block.
- `parent_hash`: Parent block hash.
- `block_timestamp`: Timestamp of the Ethereum block.
- `transaction_count`: Number of transactions in the block.
- `gas_used`: Total gas used by the block.
- `base_fee_per_gas`: Base fee for the block.
- `is_orphaned`: Flag showing whether this Ethereum block was orphaned or replaced.
- `raw_block`: Full original Ethereum block payload.
- `created_at`: Time when this row was inserted.
- `updated_at`: Time when this row was last updated.

## `eth_tx_raw`

This table stores raw Ethereum transactions and receipts that contained StarkGate activity.

- `transaction_hash`: Ethereum transaction hash.
- `block_number`: Ethereum block number where the tx was included.
- `block_hash`: Ethereum block hash for the tx.
- `transaction_index`: Position of the tx inside the Ethereum block.
- `from_address`: Ethereum sender address.
- `to_address`: Ethereum target address.
- `tx_type`: Internal high-level label such as deposit or withdrawal.
- `status`: Processing state for this raw tx row, such as `PENDING`, `PROCESSED`, or `FAILED`.
- `execution_status`: Ethereum execution result, usually success or reverted.
- `gas_used`: Gas used by the tx.
- `effective_gas_price`: Effective gas price used for the receipt.
- `actual_fee_eth`: Exact fee paid on Ethereum in raw wei.
- `log_count`: Number of receipt logs in this tx.
- `raw_transaction`: Full original Ethereum transaction JSON.
- `raw_receipt`: Full original Ethereum receipt JSON.
- `processed_at`: Time when the tx decode finished.
- `decode_error`: Decode failure message if processing failed.
- `created_at`: Time when this row was inserted.
- `updated_at`: Time when this row was last updated.

## `eth_event_raw`

This table stores raw Ethereum logs before business matching.

- `block_number`: Ethereum block number for the log.
- `transaction_hash`: Ethereum transaction hash that emitted the log.
- `log_index`: Log position inside the Ethereum receipt.
- `block_hash`: Ethereum block hash for the log.
- `block_timestamp`: Timestamp of the Ethereum block.
- `transaction_index`: Position of the tx inside the Ethereum block.
- `emitter_address`: Contract address that emitted the log.
- `topic0`: Primary event topic.
- `topic1`: Second topic if present.
- `topic2`: Third topic if present.
- `topic3`: Fourth topic if present.
- `data`: Raw non-indexed event data payload.
- `event_type`: Decoded event type when recognized. Current StarkGate decoding recognizes both the current ETH bridge topics (`Deposit(address,address,uint256,uint256,uint256,uint256)` and `Withdrawal(address,address,uint256)`) and the older StarkGate topics already handled by the L1 decoder.
- `normalized_status`: Decode state for this log row. `PROCESSED` means the log was decoded into `eth_starkgate_events`; `UNKNOWN_EVENT` means the emitter was indexed but the topic is not currently a supported StarkGate business event; `FAILED` means decoding threw an error.
- `decode_error`: Decode failure message when the log could not be processed.
- `raw_log`: Full original Ethereum log JSON.
- `processed_at`: Time when the log decode finished.
- `created_at`: Time when this row was inserted.
- `updated_at`: Time when this row was last updated.

## `eth_starkgate_events`

This table stores decoded L1 StarkGate business facts.

- `event_key`: Internal unique id for the decoded L1 event.
- `eth_block_number`: Ethereum block number where the event happened.
- `eth_block_hash`: Ethereum block hash for the event.
- `eth_block_timestamp`: Ethereum timestamp for the event.
- `eth_transaction_hash`: Ethereum transaction hash that emitted the event.
- `eth_log_index`: Log index inside the Ethereum receipt.
- `emitter_contract`: StarkGate L1 contract that emitted the event.
- `event_type`: Normalized event type such as `deposit_initiated` or `withdrawal_completed`.
- `l1_sender`: Ethereum sender for inbound bridge activity when the event exposes it.
- `l1_recipient`: Ethereum recipient for outbound bridge completion when the event exposes it.
- `l2_recipient`: Starknet wallet that should receive bridged funds.
- `l2_sender`: Starknet sender that originated the L2-to-L1 withdrawal when known.
- `l1_token_address`: Ethereum token address for the bridge event.
- `l2_token_address`: Starknet token address mapped from the L1 token when known.
- `is_native_eth`: Flag showing whether the event represents native ETH rather than an ERC-20 token.
- `token_symbol`: Symbol we resolved for the token when known.
- `amount`: Raw bridge amount from Ethereum in exact integer form.
- `amount_human`: Decimal-normalized human amount when token decimals are known.
- `amount_usd`: USD value of the event when pricing is available.
- `nonce`: StarkGate nonce when the event exposes it.
- `stark_tx_hash`: Matched Starknet tx hash after cross-chain linking.
- `stark_block_number`: Matched Starknet block number after linking.
- `stark_bridge_key`: Matched `stark_bridge_activities.bridge_key`.
- `matched_at`: Time when this row was linked to the Starknet side.
- `match_status`: Cross-chain state for this event, such as `PENDING`, `MATCHED`, or `UNMATCHED`.
- `match_strategy`: Strategy that produced the match, such as `nonce` or `amount_time`.
- `settlement_seconds`: Seconds between the Ethereum event and the matched Starknet result.
- `settlement_blocks_l1`: Ethereum block distance observed when the match was recorded.
- `settlement_blocks_l2`: Starknet block distance observed when the match was recorded.
- `metadata`: Extra decode and matching details.
- `created_at`: Time when this row was inserted.
- `updated_at`: Time when this row was last updated.

## `eth_index_state`

This table stores the L1 StarkGate indexer checkpoint.

- `indexer_key`: Logical name of the Ethereum indexer state row.
- `last_processed_block_number`: Latest Ethereum block number successfully processed.
- `last_processed_block_hash`: Hash of the latest processed Ethereum block.
- `last_processed_timestamp`: Timestamp of the latest processed Ethereum block.
- `last_finalized_block_number`: Latest Ethereum block number we consider finalized for this indexer.
- `last_error`: Last recorded runtime error for the Ethereum indexer.
- `last_committed_at`: Time when the indexer last committed progress.
- `created_at`: Time when this state row was created.
- `updated_at`: Time when this state row was last updated.

## Keys Reference

The live schema currently has primary keys on every table and no foreign key constraints.
This section lists the keys for quick reference.

- `eth_block_journal`: Primary key `(block_number, block_hash)`; foreign keys none.
- `eth_event_raw`: Primary key `(block_number, transaction_hash, log_index)`; foreign keys none.
- `eth_index_state`: Primary key `indexer_key`; foreign keys none.
- `eth_starkgate_events`: Primary key `event_key`; foreign keys none.
- `eth_tx_raw`: Primary key `(transaction_hash, block_number)`; foreign keys none.
- `stark_action_norm`: Primary key `action_key`; foreign keys none.
- `stark_block_journal`: Primary key `(lane, block_number, block_hash)`; foreign keys none.
- `stark_block_state_updates`: Primary key `(lane, block_number, block_hash)`; foreign keys none.
- `stark_bridge_activities`: Primary key `bridge_key`; foreign keys none.
- `stark_contract_registry`: Primary key `(contract_address, class_hash)`; foreign keys none.
- `stark_contract_security`: Primary key `contract_address`; foreign keys none.
- `stark_event_raw`: Primary key `(lane, block_number, transaction_hash, receipt_event_index)`; foreign keys none.
- `stark_holder_balance_deltas`: Primary key `delta_key`; foreign keys none.
- `stark_holder_balances`: Primary key `(lane, token_address, holder_address)`; foreign keys none.
- `stark_index_state`: Primary key `(indexer_key, lane)`; foreign keys none.
- `stark_leaderboards`: Primary key `(lane, leaderboard_name, entity_key)`; foreign keys none.
- `stark_message_l2_to_l1`: Primary key `(lane, block_number, transaction_hash, message_index)`; foreign keys none.
- `stark_ohlcv_1m`: Primary key `candle_key`; foreign keys none.
- `stark_pool_latest`: Primary key `(lane, pool_id)`; foreign keys none.
- `stark_pool_state`: Primary key `(lane, pool_id)`; foreign keys none.
- `stark_pool_state_history`: Primary key `pool_state_key`; foreign keys none.
- `stark_price_ticks`: Primary key `tick_key`; foreign keys none.
- `stark_prices`: Primary key `(lane, token_address)`; foreign keys none.
- `stark_reconciliation_log`: Primary key `reconciliation_id`; foreign keys none.
- `stark_token_concentration`: Primary key `(lane, token_address, holder_address)`; foreign keys none.
- `stark_token_metadata`: Primary key `token_address`; foreign keys none.
- `stark_token_metadata_refresh_queue`: Primary key `queue_key`; foreign keys none.
- `stark_trades`: Primary key `trade_key`; foreign keys none.
- `stark_transfers`: Primary key `transfer_key`; foreign keys none.
- `stark_tx_raw`: Primary key `(lane, block_number, transaction_hash)`; foreign keys none.
- `stark_unknown_event_audit`: Primary key `audit_id`; foreign keys none.
- `stark_wallet_bridge_flows`: Primary key `(lane, wallet_address, token_address)`; foreign keys none.
- `stark_wallet_pnl_events`: Primary key `pnl_event_key`; foreign keys none.
- `stark_wallet_positions`: Primary key `(lane, wallet_address, token_address)`; foreign keys none.
- `stark_wallet_stats`: Primary key `(lane, wallet_address)`; foreign keys none.
- `stark_whale_alert_candidates`: Primary key `alert_key`; foreign keys none.
- `tokens`: Primary key `address`; foreign keys none.
- `view_unidentified_protocols`: View only, so it has no primary key or foreign keys.
## Pool Taxonomy Registry

Pool taxonomy is now stored canonically in `stark_pool_registry`.

Purpose:

- separate venue identity from raw contract-address assumptions
- support singleton pool identities like Ekubo
- materialize a stable `protocol` / `pool_family` / `pool_model` taxonomy into serving tables

Core columns:

- `pool_key` primary key
- `protocol`
- `contract_address`
- `pool_id`
- `class_hash`
- `factory_address`
- `token0_address`
- `token1_address`
- `pool_family`
- `pool_model`
- `stable_flag`
- `confidence_level`
- `first_seen_block`
- `metadata`

`stark_pool_state_history` and `stark_pool_latest` now also carry nullable `pool_family` and `pool_model` columns. These are synchronized from the registry by the pool taxonomy worker.

Important identity rule:

- normal pair/pool contracts can use contract address as `pool_id`
- singleton designs cannot
- Ekubo uses the normalized pool-key string `token0:token1:fee:tickSpacing:extension`

Operational rule:

- AVNU and Fibrous must not be inserted into `stark_pool_registry` as pools
- they remain router / aggregator entities only
- `factory_address` and `stable_flag` are nullable by design. They apply to factory/pair style pools; singleton CLMM pools such as Ekubo do not have a per-pool factory address or stable/volatile flag.
