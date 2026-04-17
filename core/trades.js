'use strict';

const { fetchLatestQuotes } = require('../lib/cmc');
const { getKnownLockerMatchByAddress, getProtocolDisplayName } = require('../lib/registry/dex-registry');
const {
  DEFAULT_SCALE,
  absBigInt,
  compareBigInt,
  decimalStringToScaled,
  integerAmountToScaled,
  resolveUsdPriceFromGraph,
  scaledDivide,
  scaledMultiply,
  scaledRatio,
  scaledToNumericString,
} = require('../lib/cairo/fixed-point');
const { toBigIntStrict, toNumericString } = require('../lib/cairo/bigint');
const { knownErc20Cache } = require('./known-erc20-cache');
const { enqueueTradeChainingTransactions } = require('./post-processor');
const { parsePoolKeyId, sortTokenPair } = require('./normalize');
const { toJsonbString } = require('./protocols/shared');
const { getTokenRegistryInfo, isStableTokenInfo, loadTokenRegistryByAddress } = require('./token-registry');

const DEFAULT_BRIDGE_SYMBOLS = ['STRK', 'ETH', 'WBTC', 'USDC', 'USDT', 'DAI'];
const DEFAULT_CMC_ALLOWLIST = ['STRK', 'ETH', 'WBTC', 'WSTETH', 'EKUBO'];
const DEFAULT_PENDING_DECIMALS = 18;
const USD_ONE_SCALED = decimalStringToScaled('1', DEFAULT_SCALE);
const HUNDRED_SCALED = decimalStringToScaled('100', DEFAULT_SCALE);

async function persistTradesForBlock(client, { blockHash, blockNumber, blockTimestamp, lane }) {
  const actions = buildMaterializedTradeActions(await loadSwapActions(client, { blockNumber, lane }));

  if (actions.length === 0) {
    return emptyTradeResult();
  }

  const blockTimestampDate = toBlockTimestampDate(blockTimestamp);
  const tradeTokenAddresses = collectTradeTokenAddresses(actions);
  const tokenMetadataByAddress = await loadTokenRegistryByAddress(client, tradeTokenAddresses);
  const priceContext = await loadLatestPriceContext(client, {
    blockNumber,
    lane,
    tokenAddresses: tradeTokenAddresses,
  });
  seedStablePrices(priceContext, {
    blockNumber,
    tokenAddresses: tradeTokenAddresses,
    tokenMetadataByAddress,
  });

  const cmcResult = await hydrateCmcReferencePrices({
    blockHash,
    blockTimestampDate,
    blockNumber,
    lane,
    priceContext,
    tokenAddresses: tradeTokenAddresses,
  });
  const latestUsdByToken = buildLatestUsdByToken(priceContext);
  const bridgeEdges = await loadBridgeEdges(client, {
    lane,
    tokenAddresses: tradeTokenAddresses,
  });
  const poolLiquidityById = await loadPoolLiquidityById(client, {
    lane,
    poolIds: actions.map((action) => action.poolId),
  });

  const trades = [];
  const priceCandidates = [...cmcResult.externalPriceCandidates];

  for (const action of actions) {
    const trade = deriveTrade(action, {
      blockHash,
      blockNumber,
      blockTimestampDate,
      bridgeEdges,
      lane,
      latestUsdByToken,
      poolLiquidityById,
      priceContext,
      tokenMetadataByAddress,
    });

    if (!trade) {
      continue;
    }

    await upsertTrade(client, trade);
    trades.push(trade);

    for (const candidate of trade.priceCandidates) {
      priceContext.set(candidate.tokenAddress, {
        priceIsStale: candidate.priceIsStale,
        priceSource: candidate.priceSource,
        priceUpdatedAtBlock: candidate.priceUpdatedAtBlock,
        priceUsdScaled: candidate.priceUsdScaled,
      });
      latestUsdByToken.set(candidate.tokenAddress, candidate.priceUsdScaled);
      priceCandidates.push(candidate);
    }
  }

  const queuedTransactions = await enqueueTradeChainingTransactions(client, trades);

  return {
    latestUsdByToken,
    priceCandidates,
    realtimeTrades: trades.map(serializeRealtimeTrade),
    summary: {
      priceCandidates: priceCandidates.length,
      pricedTrades: trades.filter((item) => item.notionalUsdScaled !== null).length,
      queuedTransactions,
      trades: trades.length,
    },
    trades,
  };
}

function collectTradeTokenAddresses(actions) {
  const set = new Set();

  for (const action of actions) {
    set.add(action.token0Address);
    set.add(action.token1Address);
  }

  return Array.from(set);
}

function buildMaterializedTradeActions(actions) {
  const groupedByTransaction = new Map();

  for (const action of actions ?? []) {
    if (!action?.transactionHash) {
      continue;
    }

    if (!groupedByTransaction.has(action.transactionHash)) {
      groupedByTransaction.set(action.transactionHash, []);
    }

    groupedByTransaction.get(action.transactionHash).push(action);
  }

  const materialized = [];

  for (const transactionActions of groupedByTransaction.values()) {
    const ordered = [...transactionActions].sort(compareActionOrder);
    const hasVenueSwapLegs = ordered.some((action) => !isAggregatorSummaryAction(action));
    const selected = hasVenueSwapLegs
      ? ordered.filter((action) => !isAggregatorSummaryAction(action))
      : ordered;

    materialized.push(...selected);
  }

  return materialized.sort(compareActionOrder);
}

function isAggregatorSummaryAction(action) {
  return Boolean(
    action?.metadata?.is_aggregator_trade ||
    action?.metadata?.is_user_facing_aggregated_trade ||
    action?.protocol === 'avnu'
  );
}

function compareActionOrder(left, right) {
  if (left.blockNumber !== right.blockNumber) {
    return left.blockNumber < right.blockNumber ? -1 : 1;
  }

  if (left.transactionIndex !== right.transactionIndex) {
    return left.transactionIndex < right.transactionIndex ? -1 : 1;
  }

  if (left.sourceEventIndex !== right.sourceEventIndex) {
    return left.sourceEventIndex < right.sourceEventIndex ? -1 : 1;
  }

  return left.actionKey < right.actionKey ? -1 : 1;
}

function deriveTrade(action, context) {
  const direction = determineTradeDirection(action.amount0Delta, action.amount1Delta);
  if (!direction) {
    return null;
  }

  const token0Info = getTokenInfo(action.token0Address, context.tokenMetadataByAddress);
  const token1Info = getTokenInfo(action.token1Address, context.tokenMetadataByAddress);
  const token0Decimals = resolveTokenDecimals(token0Info);
  const token1Decimals = resolveTokenDecimals(token1Info);
  const decimals0 = token0Decimals.value;
  const decimals1 = token1Decimals.value;
  const pendingEnrichment = !token0Decimals.confirmed || !token1Decimals.confirmed;
  const missingDecimalsFor = [
    token0Decimals.confirmed ? null : action.token0Address,
    token1Decimals.confirmed ? null : action.token1Address,
  ].filter(Boolean);
  direction.tokenInAddress = direction.tokenInIndex === 0 ? action.token0Address : action.token1Address;
  direction.tokenOutAddress = direction.tokenOutIndex === 0 ? action.token0Address : action.token1Address;
  direction.tokenInDecimals = direction.tokenInIndex === 0 ? decimals0 : decimals1;
  direction.tokenOutDecimals = direction.tokenOutIndex === 0 ? decimals0 : decimals1;

  const priceBundle = deriveTradePrice(action, {
    decimals0,
    decimals1,
    decimalsConfirmed: token0Decimals.confirmed && token1Decimals.confirmed,
  });
  const actionLiquidityUsdScaled = context.poolLiquidityById.get(action.poolId) ?? null;
  const actionEdges = buildActionEdges(action, {
    actionLiquidityUsdScaled,
    priceBundle,
  });
  const graphEdges = [...context.bridgeEdges, ...actionEdges];

  const token0Price = resolveUsdPriceForToken(action.token0Address, {
    blockNumber: context.blockNumber,
    directStableAddress: action.token1Address,
    tokenMetadataByAddress: context.tokenMetadataByAddress,
    priceContext: context.priceContext,
    priceScaled: priceBundle.priceToken1PerToken0Scaled,
    tradeGraphEdges: graphEdges,
  });
  const token1Price = resolveUsdPriceForToken(action.token1Address, {
    blockNumber: context.blockNumber,
    directStableAddress: action.token0Address,
    inverse: true,
    tokenMetadataByAddress: context.tokenMetadataByAddress,
    priceContext: context.priceContext,
    priceScaled: priceBundle.priceToken1PerToken0Scaled,
    tradeGraphEdges: graphEdges,
  });

  const amountInHumanScaled = direction.tokenInDecimals === null
    ? null
    : integerAmountToScaled(direction.amountIn, direction.tokenInDecimals, DEFAULT_SCALE);
  const amountOutHumanScaled = direction.tokenOutDecimals === null
    ? null
    : integerAmountToScaled(direction.amountOut, direction.tokenOutDecimals, DEFAULT_SCALE);

  const tokenInPrice = direction.tokenInAddress === action.token0Address ? token0Price : token1Price;
  const tokenOutPrice = direction.tokenOutAddress === action.token0Address ? token0Price : token1Price;
  const valuation = resolveTradeValuation({
    amountInHumanScaled,
    amountOutHumanScaled,
    tokenInAddress: direction.tokenInAddress,
    tokenInPrice,
    tokenOutAddress: direction.tokenOutAddress,
    tokenOutPrice,
    tokenMetadataByAddress: context.tokenMetadataByAddress,
  });
  const notionalUsdScaled = valuation.notionalUsdScaled;
  const hopsFromStable = valuation.hopsFromStable;
  const lowConfidence = hopsFromStable !== null && hopsFromStable > 1n;
  const isAggregatorDerived = Boolean(
    action.metadata?.is_aggregator_trade ||
    action.metadata?.is_user_facing_aggregated_trade ||
    action.protocol === 'avnu'
  );
  const blockPriceCandidateHops = parseNonNegativeBigInt(process.env.PHASE3_MAX_PRICE_TABLE_HOPS_FROM_STABLE, 1n);
  const allowAggregatorPrices = parseBoolean(process.env.PHASE3_ALLOW_AGGREGATOR_PRICE_TABLES, false);
  const excludeFromPriceTicks = isAggregatorDerived && !allowAggregatorPrices;
  const excludeFromLatestPrices = (hopsFromStable !== null && hopsFromStable > blockPriceCandidateHops);
  const priceTablesRejectionReason = excludeFromPriceTicks
    ? 'aggregator_derived'
    : (excludeFromLatestPrices ? 'hops_from_stable' : null);
  const lockerAddress = action.lockerAddress ?? action.metadata?.locker_address ?? action.metadata?.raw_locker ?? null;
  const routerAttribution = resolveMaterializedRouterProtocol({
    executionProtocol: action.executionProtocol,
    fallbackRouterProtocol: action.routerProtocol,
    lockerAddress,
  });

  const priceCandidates = buildPriceCandidates(action, {
    blockHash: context.blockHash,
    blockNumber: context.blockNumber,
    blockTimestampDate: context.blockTimestampDate,
    excludeFromLatestPrices,
    excludeFromPriceTicks,
    hopsFromStable,
    isAggregatorDerived,
    lane: context.lane,
    lowConfidence,
    priceBundle,
    priceTablesRejectionReason,
    tokenMetadataByAddress: context.tokenMetadataByAddress,
    token0Price,
    token1Price,
  });

  const bucketStart = floorToMinute(context.blockTimestampDate);
  const poolKeyParts = parseActionPoolKeyParts(action);
  const metadata = {
    amount0_delta: action.amount0Delta,
    amount1_delta: action.amount1Delta,
    decimals_known: priceBundle.priceIsDecimalsNormalized,
    default_decimals_applied: pendingEnrichment ? DEFAULT_PENDING_DECIMALS : null,
    exclude_from_latest_prices: excludeFromLatestPrices,
    exclude_from_price_ticks: excludeFromPriceTicks,
    extension_address: poolKeyParts?.extension ?? action.metadata?.extension_address ?? null,
    fee_tier: poolKeyParts?.fee ?? action.metadata?.fee_tier ?? null,
    hops_from_stable: hopsFromStable,
    is_aggregator_derived: isAggregatorDerived,
    is_multi_hop: Boolean(action.isMultiHop),
    liquidity_after: action.metadata?.liquidity_after ?? null,
    locker_address: lockerAddress,
    low_confidence: lowConfidence,
    low_confidence_reason: lowConfidence ? 'hops_from_stable' : null,
    missing_decimals_for: missingDecimalsFor,
    original_action_key: action.actionKey,
    pending_enrichment: pendingEnrichment,
    price_deviation_pct: priceBundle.priceDeviationPctScaled === null ? null : scaledToNumericString(priceBundle.priceDeviationPctScaled, DEFAULT_SCALE),
    price_raw_execution: scaledToNumericString(priceBundle.priceRawExecutionToken1PerToken0Scaled, DEFAULT_SCALE),
    pool_id: action.poolId,
    price_source: priceBundle.priceSource,
    protocol: action.protocol,
    sequence_id: action.sequenceId ?? null,
    route_group_key: action.routeGroupKey ?? null,
    route_rejection_reason: priceTablesRejectionReason,
    router_protocol_key: routerAttribution.protocolKey,
    router_protocol_source: routerAttribution.source,
    sqrt_ratio_after: action.metadata?.sqrt_ratio_after ?? null,
    tick_after: action.metadata?.tick_after ?? null,
    tick_spacing: poolKeyParts?.tickSpacing ?? action.metadata?.tick_spacing ?? null,
    token0_price_path: token0Price?.pathSource ?? null,
    token1_price_path: token1Price?.pathSource ?? null,
    total_hops: action.totalHops ?? 1n,
  };

  return {
    amount0Delta: action.amount0Delta,
    amount1Delta: action.amount1Delta,
    amountIn: direction.amountIn,
    amountInHumanScaled,
    amountOut: direction.amountOut,
    amountOutHumanScaled,
    blockHash: context.blockHash,
    blockNumber: context.blockNumber,
    blockTimestampDate: context.blockTimestampDate,
    bucketStart,
    executionProtocol: action.executionProtocol,
    extensionAddress: poolKeyParts?.extension ?? action.metadata?.extension_address ?? null,
    feeTier: poolKeyParts?.fee ?? action.metadata?.fee_tier ?? null,
    hopIndex: action.hopIndex ?? null,
    hopsFromStable,
    isAggregatorDerived,
    isMultiHop: Boolean(action.isMultiHop),
    lane: context.lane,
    liquidityAfter: action.metadata?.liquidity_after === undefined ? null : toBigIntStrict(action.metadata.liquidity_after, 'trade liquidity after'),
    lockerAddress,
    metadata,
    notionalUsdScaled,
    poolId: action.poolId,
    priceCandidates,
    priceDeviationPctScaled: priceBundle.priceDeviationPctScaled,
    priceIsDecimalsNormalized: priceBundle.priceIsDecimalsNormalized,
    priceRawExecutionScaled: priceBundle.priceRawExecutionToken1PerToken0Scaled,
    priceRawToken0PerToken1Scaled: priceBundle.priceRawToken0PerToken1Scaled,
    priceRawToken1PerToken0Scaled: priceBundle.priceRawToken1PerToken0Scaled,
    priceSource: priceBundle.priceSource,
    priceToken0PerToken1Scaled: priceBundle.priceToken0PerToken1Scaled,
    priceToken1PerToken0Scaled: priceBundle.priceToken1PerToken0Scaled,
    protocol: action.protocol,
    routeGroupKey: action.routeGroupKey ?? null,
    routerProtocol: routerAttribution.displayName,
    sequenceId: action.sequenceId ?? null,
    sourceEventIndex: action.sourceEventIndex,
    sqrtRatioAfter: action.metadata?.sqrt_ratio_after === undefined ? null : toBigIntStrict(action.metadata.sqrt_ratio_after, 'trade sqrt ratio after'),
    pendingEnrichment,
    tickAfter: action.metadata?.tick_after === undefined ? null : toBigIntStrict(action.metadata.tick_after, 'trade tick after'),
    tickSpacing: poolKeyParts?.tickSpacing ?? action.metadata?.tick_spacing ?? null,
    token0Address: action.token0Address,
    token1Address: action.token1Address,
    tokenInAddress: direction.tokenInAddress,
    tokenOutAddress: direction.tokenOutAddress,
    totalHops: action.totalHops ?? 1n,
    tradeKey: buildTradeKey(action),
    traderAddress: action.accountAddress,
    transactionHash: action.transactionHash,
    transactionIndex: action.transactionIndex,
    volumeToken0: absBigInt(action.amount0Delta),
    volumeToken1: absBigInt(action.amount1Delta),
  };
}

function determineTradeDirection(amount0Delta, amount1Delta) {
  const delta0 = toBigIntStrict(amount0Delta, 'amount0 delta');
  const delta1 = toBigIntStrict(amount1Delta, 'amount1 delta');

  if (delta0 > 0n && delta1 < 0n) {
    return {
      amountIn: delta0,
      amountOut: -delta1,
      tokenInDecimals: null,
      tokenInIndex: 0,
      tokenOutDecimals: null,
      tokenOutIndex: 1,
    };
  }

  if (delta0 < 0n && delta1 > 0n) {
    return {
      amountIn: delta1,
      amountOut: -delta0,
      tokenInDecimals: null,
      tokenInIndex: 1,
      tokenOutDecimals: null,
      tokenOutIndex: 0,
    };
  }

  return null;
}

function resolveMaterializedRouterProtocol({ executionProtocol, fallbackRouterProtocol, lockerAddress }) {
  const lockerMatch = lockerAddress ? getKnownLockerMatchByAddress(lockerAddress) : null;
  if (lockerMatch) {
    return {
      displayName: lockerMatch.displayName ?? lockerMatch.protocol ?? fallbackRouterProtocol ?? null,
      protocolKey: lockerMatch.protocolKey ?? lockerMatch.protocol ?? null,
      source: 'locker_registry',
    };
  }

  if (fallbackRouterProtocol && fallbackRouterProtocol.startsWith('unknown_locker_')) {
    return {
      displayName: fallbackRouterProtocol,
      protocolKey: null,
      source: 'unknown_locker',
    };
  }

  const fallbackDisplayName = getProtocolDisplayName(fallbackRouterProtocol);
  if (fallbackDisplayName) {
    return {
      displayName: fallbackDisplayName,
      protocolKey: fallbackRouterProtocol,
      source: 'action_router_protocol',
    };
  }

  if (!fallbackRouterProtocol && executionProtocol && executionProtocol !== 'ekubo') {
    const executionDisplayName = getProtocolDisplayName(executionProtocol);
    if (executionDisplayName) {
      return {
        displayName: executionDisplayName,
        protocolKey: executionProtocol,
        source: 'execution_protocol_fallback',
      };
    }
  }

  return {
    displayName: fallbackRouterProtocol ?? null,
    protocolKey: fallbackRouterProtocol ?? null,
    source: fallbackRouterProtocol ? 'action_router_protocol_unmapped' : null,
  };
}

function deriveTradePrice(action, { decimals0, decimals1, decimalsConfirmed }) {
  let rawNumerator;
  let rawDenominator;
  let priceSource;

  if (
    action.metadata &&
    action.metadata.price_ratio_numerator !== undefined &&
    action.metadata.price_ratio_denominator !== undefined
  ) {
    rawNumerator = toBigIntStrict(action.metadata.price_ratio_numerator, `${action.protocol} price ratio numerator`);
    rawDenominator = toBigIntStrict(action.metadata.price_ratio_denominator, `${action.protocol} price ratio denominator`);
    priceSource = action.metadata?.pool_model === 'clmm' ? 'clmm_sqrt_price' : `${action.protocol}_reported_ratio`;
  } else {
    rawNumerator = absBigInt(action.amount1Delta);
    rawDenominator = absBigInt(action.amount0Delta);
    priceSource = 'swap_delta_ratio';
  }

  const priceRawToken1PerToken0Scaled = scaledRatio(rawNumerator, rawDenominator, 0, DEFAULT_SCALE);
  const priceRawToken0PerToken1Scaled = scaledRatio(rawDenominator, rawNumerator, 0, DEFAULT_SCALE);
  const decimalExponent = decimals0 - decimals1;
  const inverseDecimalExponent = decimals1 - decimals0;
  const priceToken1PerToken0Scaled = scaledRatio(rawNumerator, rawDenominator, decimalExponent, DEFAULT_SCALE);
  const priceToken0PerToken1Scaled = scaledRatio(rawDenominator, rawNumerator, inverseDecimalExponent, DEFAULT_SCALE);
  const priceRawExecutionToken1PerToken0Scaled = scaledRatio(absBigInt(action.amount1Delta), absBigInt(action.amount0Delta), decimalExponent, DEFAULT_SCALE);
  const priceRawExecutionToken0PerToken1Scaled = scaledRatio(absBigInt(action.amount0Delta), absBigInt(action.amount1Delta), inverseDecimalExponent, DEFAULT_SCALE);

  return {
    priceIsDecimalsNormalized: Boolean(decimalsConfirmed),
    priceDeviationPctScaled: computeDeviationPct(priceToken1PerToken0Scaled, priceRawExecutionToken1PerToken0Scaled),
    priceRawExecutionToken0PerToken1Scaled,
    priceRawExecutionToken1PerToken0Scaled,
    priceRawToken0PerToken1Scaled,
    priceRawToken1PerToken0Scaled,
    priceSource,
    priceToken0PerToken1Scaled,
    priceToken1PerToken0Scaled,
  };
}

function computeDeviationPct(referenceScaled, executionScaled) {
  if (referenceScaled === null || executionScaled === null || executionScaled === 0n) {
    return null;
  }

  const delta = absBigInt(referenceScaled - executionScaled);
  const ratio = scaledDivide(delta, executionScaled, DEFAULT_SCALE);
  return scaledMultiply(ratio, HUNDRED_SCALED, DEFAULT_SCALE);
}

function parseActionPoolKeyParts(action) {
  if (!action?.poolId) {
    return null;
  }

  try {
    return parsePoolKeyId(action.poolId, 'trade pool id');
  } catch (error) {
    return null;
  }
}

function resolveUsdPriceForToken(targetAddress, {
  blockNumber,
  directStableAddress,
  inverse = false,
  tokenMetadataByAddress,
  priceContext,
  priceScaled,
  tradeGraphEdges,
}) {
  if (isStableTokenAddress(targetAddress, tokenMetadataByAddress)) {
    return {
      anchorTokenAddress: targetAddress,
      hopsFromStable: 0n,
      path: [],
      pathSource: 'stable_seed',
      priceIsStale: false,
      priceUpdatedAtBlock: blockNumber,
      priceUsdScaled: USD_ONE_SCALED,
    };
  }

  if (isStableTokenAddress(directStableAddress, tokenMetadataByAddress)) {
    return {
      anchorTokenAddress: directStableAddress,
      hopsFromStable: 0n,
      path: [],
      pathSource: 'stable_direct_current_trade',
      priceIsStale: false,
      priceUpdatedAtBlock: blockNumber,
      priceUsdScaled: inverse ? scaledDivide(USD_ONE_SCALED, priceScaled, DEFAULT_SCALE) : scaledMultiply(priceScaled, USD_ONE_SCALED, DEFAULT_SCALE),
    };
  }

  const resolved = resolveUsdPriceFromGraph({
    anchorPricesByToken: priceContext,
    edges: tradeGraphEdges,
    maxHops: 2,
    minLiquidityUsdScaled: parseUsdThreshold(process.env.PHASE3_MIN_PATH_LIQUIDITY_USD, '50000'),
    targetTokenAddress: targetAddress,
  });

  if (!resolved) {
    return null;
  }

  return {
    ...resolved,
    hopsFromStable: normalizeHopsFromStable(resolved.shortestAnchorHops ?? resolved.hops),
  };
}

function normalizeHopsFromStable(resolvedHops) {
  const normalized = toBigIntStrict(resolvedHops, 'resolved hops');
  if (normalized <= 0n) {
    return 0n;
  }

  return normalized - 1n;
}

function resolveTradeValuation({
  amountInHumanScaled,
  amountOutHumanScaled,
  tokenInAddress,
  tokenInPrice,
  tokenOutAddress,
  tokenOutPrice,
  tokenMetadataByAddress,
}) {
  if (amountInHumanScaled !== null && isStableTokenAddress(tokenInAddress, tokenMetadataByAddress)) {
    return {
      hopsFromStable: 0n,
      notionalUsdScaled: amountInHumanScaled,
    };
  }

  if (amountOutHumanScaled !== null && isStableTokenAddress(tokenOutAddress, tokenMetadataByAddress)) {
    return {
      hopsFromStable: 0n,
      notionalUsdScaled: amountOutHumanScaled,
    };
  }

  if (amountInHumanScaled !== null && tokenInPrice?.priceUsdScaled) {
    return {
      hopsFromStable: tokenInPrice.hopsFromStable ?? null,
      notionalUsdScaled: scaledMultiply(amountInHumanScaled, tokenInPrice.priceUsdScaled, DEFAULT_SCALE),
    };
  }

  if (amountOutHumanScaled !== null && tokenOutPrice?.priceUsdScaled) {
    return {
      hopsFromStable: tokenOutPrice.hopsFromStable ?? null,
      notionalUsdScaled: scaledMultiply(amountOutHumanScaled, tokenOutPrice.priceUsdScaled, DEFAULT_SCALE),
    };
  }

  return {
    hopsFromStable: null,
    notionalUsdScaled: null,
  };
}

function buildPriceCandidates(action, {
  blockHash,
  blockNumber,
  blockTimestampDate,
  excludeFromLatestPrices,
  excludeFromPriceTicks,
  hopsFromStable,
  isAggregatorDerived,
  lane,
  lowConfidence,
  priceBundle,
  priceTablesRejectionReason,
  tokenMetadataByAddress,
  token0Price,
  token1Price,
}) {
  const candidates = [];

  if (token0Price?.priceUsdScaled) {
    candidates.push({
      blockHash,
      blockNumber,
      blockTimestampDate,
      excludeFromLatestPrices,
      excludeFromPriceTicks,
      hopsFromStable: token0Price.hopsFromStable ?? hopsFromStable ?? null,
      isAggregatorDerived,
      lane,
      lowConfidence: lowConfidence || ((token0Price.hopsFromStable ?? hopsFromStable ?? null) !== null && (token0Price.hopsFromStable ?? hopsFromStable ?? null) > 1n),
      metadata: {
        exclude_from_latest_prices: excludeFromLatestPrices,
        exclude_from_price_ticks: excludeFromPriceTicks,
        execution_protocol: action.executionProtocol,
        low_confidence: lowConfidence || ((token0Price.hopsFromStable ?? hopsFromStable ?? null) !== null && (token0Price.hopsFromStable ?? hopsFromStable ?? null) > 1n),
        low_confidence_reason: (lowConfidence || ((token0Price.hopsFromStable ?? hopsFromStable ?? null) !== null && (token0Price.hopsFromStable ?? hopsFromStable ?? null) > 1n))
          ? 'hops_from_stable'
          : null,
        price_deviation_pct: priceBundle.priceDeviationPctScaled === null ? null : scaledToNumericString(priceBundle.priceDeviationPctScaled, DEFAULT_SCALE),
        price_raw_execution: scaledToNumericString(priceBundle.priceRawExecutionToken1PerToken0Scaled, DEFAULT_SCALE),
        path_source: token0Price.pathSource ?? null,
        pool_id: action.poolId,
        price_source: priceBundle.priceSource,
        rejection_reason: priceTablesRejectionReason,
      },
      poolId: action.poolId,
      priceIsStale: token0Price.priceIsStale,
      priceDeviationPctScaled: priceBundle.priceDeviationPctScaled,
      priceRawExecutionScaled: priceBundle.priceRawExecutionToken1PerToken0Scaled,
      priceQuoteScaled: priceBundle.priceToken1PerToken0Scaled,
      priceSource: token0Price.pathSource ?? resolveUsdPriceSource(action.token1Address, priceBundle.priceSource, tokenMetadataByAddress),
      priceUpdatedAtBlock: token0Price.priceUpdatedAtBlock ?? blockNumber,
      priceUsdScaled: token0Price.priceUsdScaled,
      quoteTokenAddress: action.token1Address,
      buyAmountRaw: absBigInt(action.amount1Delta),
      sellAmountRaw: absBigInt(action.amount0Delta),
      sourceEventIndex: action.sourceEventIndex,
      tokenAddress: action.token0Address,
      transactionHash: action.transactionHash,
      transactionIndex: action.transactionIndex,
    });
  }

  if (token1Price?.priceUsdScaled) {
    candidates.push({
      blockHash,
      blockNumber,
      blockTimestampDate,
      excludeFromLatestPrices,
      excludeFromPriceTicks,
      hopsFromStable: token1Price.hopsFromStable ?? hopsFromStable ?? null,
      isAggregatorDerived,
      lane,
      lowConfidence: lowConfidence || ((token1Price.hopsFromStable ?? hopsFromStable ?? null) !== null && (token1Price.hopsFromStable ?? hopsFromStable ?? null) > 1n),
      metadata: {
        exclude_from_latest_prices: excludeFromLatestPrices,
        exclude_from_price_ticks: excludeFromPriceTicks,
        execution_protocol: action.executionProtocol,
        low_confidence: lowConfidence || ((token1Price.hopsFromStable ?? hopsFromStable ?? null) !== null && (token1Price.hopsFromStable ?? hopsFromStable ?? null) > 1n),
        low_confidence_reason: (lowConfidence || ((token1Price.hopsFromStable ?? hopsFromStable ?? null) !== null && (token1Price.hopsFromStable ?? hopsFromStable ?? null) > 1n))
          ? 'hops_from_stable'
          : null,
        price_deviation_pct: priceBundle.priceDeviationPctScaled === null ? null : scaledToNumericString(priceBundle.priceDeviationPctScaled, DEFAULT_SCALE),
        price_raw_execution: scaledToNumericString(priceBundle.priceRawExecutionToken1PerToken0Scaled, DEFAULT_SCALE),
        path_source: token1Price.pathSource ?? null,
        pool_id: action.poolId,
        price_source: priceBundle.priceSource,
        rejection_reason: priceTablesRejectionReason,
      },
      poolId: action.poolId,
      priceIsStale: token1Price.priceIsStale,
      priceDeviationPctScaled: priceBundle.priceDeviationPctScaled,
      priceRawExecutionScaled: priceBundle.priceRawExecutionToken0PerToken1Scaled ?? priceBundle.priceRawExecutionToken1PerToken0Scaled,
      priceQuoteScaled: priceBundle.priceToken0PerToken1Scaled,
      priceSource: token1Price.pathSource ?? resolveUsdPriceSource(action.token0Address, priceBundle.priceSource, tokenMetadataByAddress),
      priceUpdatedAtBlock: token1Price.priceUpdatedAtBlock ?? blockNumber,
      priceUsdScaled: token1Price.priceUsdScaled,
      quoteTokenAddress: action.token0Address,
      buyAmountRaw: absBigInt(action.amount0Delta),
      sellAmountRaw: absBigInt(action.amount1Delta),
      sourceEventIndex: action.sourceEventIndex,
      tokenAddress: action.token1Address,
      transactionHash: action.transactionHash,
      transactionIndex: action.transactionIndex,
    });
  }

  return candidates;
}

function resolveUsdPriceSource(counterpartyAddress, baseSource, tokenMetadataByAddress = null) {
  return isStableTokenAddress(counterpartyAddress, tokenMetadataByAddress) ? `stable_direct:${baseSource}` : `bridge_latest:${baseSource}`;
}

function buildLatestUsdByToken(priceContext) {
  const latestUsdByToken = new Map();

  for (const [tokenAddress, value] of priceContext.entries()) {
    if (value?.priceUsdScaled !== undefined && value?.priceUsdScaled !== null) {
      latestUsdByToken.set(tokenAddress, value.priceUsdScaled);
    }
  }

  return latestUsdByToken;
}

async function loadLatestPriceContext(client, { blockNumber, lane, tokenAddresses }) {
  const priceContext = new Map();
  if (tokenAddresses.length === 0) {
    return priceContext;
  }

  const symbols = collectBridgeSymbols();
  const anchorAddresses = symbols.flatMap((symbol) => knownErc20Cache.findBySymbol(symbol).map((token) => token.l2TokenAddress));
  const lookupAddresses = Array.from(new Set([...tokenAddresses, ...anchorAddresses]));

  const result = await client.query(
    `SELECT token_address,
            price_usd,
            price_source,
            price_is_stale,
            price_updated_at_block,
            block_number
       FROM stark_prices
      WHERE lane = $1
        AND token_address = ANY($2::text[])`,
    [lane, lookupAddresses],
  );

  for (const row of result.rows) {
    const priceUpdatedAtBlock = row.price_updated_at_block === null
      ? toBigIntStrict(row.block_number, 'latest price block number')
      : toBigIntStrict(row.price_updated_at_block, 'price updated at block');
    priceContext.set(row.token_address, {
      priceIsStale: row.price_is_stale,
      priceSource: row.price_source,
      priceUpdatedAtBlock,
      priceUsdScaled: decimalStringToScaled(row.price_usd, DEFAULT_SCALE),
    });
  }

  return priceContext;
}

function seedStablePrices(priceContext, { blockNumber, tokenAddresses, tokenMetadataByAddress }) {
  for (const tokenAddress of tokenAddresses) {
    if (!isStableTokenAddress(tokenAddress, tokenMetadataByAddress)) {
      continue;
    }

    priceContext.set(tokenAddress, {
      priceIsStale: false,
      priceSource: 'stable_seed',
      priceUpdatedAtBlock: blockNumber,
      priceUsdScaled: USD_ONE_SCALED,
    });
  }
}

async function hydrateCmcReferencePrices({ blockHash, blockTimestampDate, blockNumber, lane, priceContext, tokenAddresses }) {
  const cmcSymbols = collectCmcSymbols(tokenAddresses, priceContext);
  const quotesBySymbol = await fetchLatestQuotes(cmcSymbols);
  const externalPriceCandidates = [];

  for (const tokenAddress of tokenAddresses) {
    const token = knownErc20Cache.getToken(tokenAddress);
    const symbol = normalizeCmcSymbol(token?.symbol);
    if (!symbol || !quotesBySymbol.has(symbol)) {
      continue;
    }

    const quote = quotesBySymbol.get(symbol);
    priceContext.set(tokenAddress, {
      priceIsStale: false,
      priceSource: 'cmc_latest',
      priceUpdatedAtBlock: blockNumber,
      priceUsdScaled: quote.priceUsdScaled,
    });

    externalPriceCandidates.push({
      blockHash,
      blockNumber,
      blockTimestampDate,
      lane,
      metadata: {
        cmc_id: quote.cmcId,
        cmc_last_updated: quote.lastUpdated,
        cmc_symbol: quote.symbol,
        volume_24h_usd: quote.volume24hUsdScaled === null ? null : scaledToNumericString(quote.volume24hUsdScaled, DEFAULT_SCALE),
      },
      poolId: null,
      priceIsStale: false,
      priceQuoteScaled: null,
      priceSource: 'cmc_latest',
      priceUpdatedAtBlock: blockNumber,
      priceUsdScaled: quote.priceUsdScaled,
      quoteTokenAddress: null,
      sourceEventIndex: 0n,
      tokenAddress,
      transactionHash: `cmc:${symbol}:${blockNumber.toString(10)}`,
      transactionIndex: 0n,
    });
  }

  return {
    externalPriceCandidates,
  };
}

function collectCmcSymbols(tokenAddresses, priceContext) {
  const allowlist = new Set(collectCmcAllowlist());
  const symbols = new Set();

  for (const tokenAddress of tokenAddresses) {
    const token = knownErc20Cache.getToken(tokenAddress);
    const symbol = normalizeCmcSymbol(token?.symbol);
    if (!symbol || !allowlist.has(symbol)) {
      continue;
    }

    if (priceContext.has(tokenAddress) && !priceContext.get(tokenAddress).priceIsStale) {
      continue;
    }

    symbols.add(symbol);
  }

  return Array.from(symbols);
}

async function loadBridgeEdges(client, { lane, tokenAddresses }) {
  const universe = new Set(tokenAddresses);
  for (const symbol of collectBridgeSymbols()) {
    for (const token of knownErc20Cache.findBySymbol(symbol)) {
      universe.add(token.l2TokenAddress);
    }
  }

  const result = await client.query(
    `SELECT pool_id,
            protocol,
            token0_address,
            token1_address,
            price_token1_per_token0,
            price_token0_per_token1,
            tvl_usd
       FROM stark_pool_latest
      WHERE lane = $1
        AND token0_address = ANY($2::text[])
        AND token1_address = ANY($2::text[])`,
    [lane, Array.from(universe)],
  );

  const edges = [];
  for (const row of result.rows) {
    if (row.price_token1_per_token0 === null || row.price_token0_per_token1 === null || row.tvl_usd === null) {
      continue;
    }

    const liquidityUsdScaled = decimalStringToScaled(row.tvl_usd, DEFAULT_SCALE);
    edges.push({
      fromTokenAddress: row.token0_address,
      liquidityUsdScaled,
      priceSource: `pool_latest:${row.protocol}:${row.pool_id}`,
      rateScaled: decimalStringToScaled(row.price_token1_per_token0, DEFAULT_SCALE),
      toTokenAddress: row.token1_address,
    });
    edges.push({
      fromTokenAddress: row.token1_address,
      liquidityUsdScaled,
      priceSource: `pool_latest:${row.protocol}:${row.pool_id}`,
      rateScaled: decimalStringToScaled(row.price_token0_per_token1, DEFAULT_SCALE),
      toTokenAddress: row.token0_address,
    });
  }

  return edges;
}

async function loadPoolLiquidityById(client, { lane, poolIds }) {
  const liquidityById = new Map();
  const uniquePoolIds = Array.from(new Set(poolIds.filter(Boolean)));
  if (uniquePoolIds.length === 0) {
    return liquidityById;
  }

  const result = await client.query(
    `SELECT pool_id, tvl_usd
       FROM stark_pool_latest
      WHERE lane = $1
        AND pool_id = ANY($2::text[])`,
    [lane, uniquePoolIds],
  );

  for (const row of result.rows) {
    if (row.tvl_usd !== null) {
      liquidityById.set(row.pool_id, decimalStringToScaled(row.tvl_usd, DEFAULT_SCALE));
    }
  }

  return liquidityById;
}

function buildActionEdges(action, { actionLiquidityUsdScaled, priceBundle }) {
  if (actionLiquidityUsdScaled === null || actionLiquidityUsdScaled === undefined) {
    return [];
  }

  return [
    {
      fromTokenAddress: action.token0Address,
      liquidityUsdScaled: actionLiquidityUsdScaled,
      priceSource: `current_trade:${action.protocol}:${action.poolId}`,
      rateScaled: priceBundle.priceToken1PerToken0Scaled,
      toTokenAddress: action.token1Address,
    },
    {
      fromTokenAddress: action.token1Address,
      liquidityUsdScaled: actionLiquidityUsdScaled,
      priceSource: `current_trade:${action.protocol}:${action.poolId}`,
      rateScaled: priceBundle.priceToken0PerToken1Scaled,
      toTokenAddress: action.token0Address,
    },
  ];
}

function getTokenInfo(tokenAddress, tokenMetadataByAddress = null) {
  if (tokenMetadataByAddress instanceof Map) {
    return getTokenRegistryInfo(tokenAddress, tokenMetadataByAddress);
  }

  return knownErc20Cache.getToken(tokenAddress);
}

function resolveTokenDecimals(tokenInfo) {
  if (tokenInfo?.decimals !== undefined && tokenInfo?.decimals !== null && Number.isInteger(Number(tokenInfo.decimals))) {
    return {
      confirmed: true,
      value: Number(tokenInfo.decimals),
    };
  }

  return {
    confirmed: false,
    value: DEFAULT_PENDING_DECIMALS,
  };
}

function isStableTokenAddress(tokenAddress, tokenMetadataByAddress = null) {
  const token = getTokenInfo(tokenAddress, tokenMetadataByAddress);
  if (tokenMetadataByAddress instanceof Map) {
    const registryToken = getTokenRegistryInfo(tokenAddress, tokenMetadataByAddress);
    if (registryToken) {
      return isStableTokenInfo(registryToken);
    }
  }

  return isStableTokenInfo(token);
}

function collectBridgeSymbols() {
  const configured = String(process.env.PHASE3_BRIDGE_SYMBOLS ?? '').trim();
  if (!configured) {
    return DEFAULT_BRIDGE_SYMBOLS;
  }

  return configured.split(',').map((value) => String(value).trim().toUpperCase()).filter(Boolean);
}

function collectCmcAllowlist() {
  const configured = String(process.env.CMC_ALLOWED_SYMBOLS ?? '').trim();
  if (!configured) {
    return DEFAULT_CMC_ALLOWLIST;
  }

  return configured.split(',').map((value) => String(value).trim().toUpperCase()).filter(Boolean);
}

function normalizeCmcSymbol(symbol) {
  if (symbol === undefined || symbol === null) {
    return null;
  }

  return String(symbol).trim().toUpperCase() || null;
}

function parseUsdThreshold(value, fallback) {
  return decimalStringToScaled(String(value ?? fallback), DEFAULT_SCALE);
}

async function loadSwapActions(client, { blockNumber, lane }) {
  const result = await client.query(
    `SELECT action_key,
            block_hash,
            transaction_hash,
            transaction_index,
            source_event_index,
            protocol,
            account_address,
            pool_id,
            token0_address,
            token1_address,
            router_protocol,
            execution_protocol,
            amount0,
            amount1,
            metadata
       FROM stark_action_norm
      WHERE lane = $1
        AND block_number = $2
        AND action_type = 'swap'
      ORDER BY transaction_index ASC, source_event_index ASC, action_key ASC`,
    [lane, toNumericString(blockNumber, 'block number')],
  );

  return result.rows.map((row) => ({
    actionKey: row.action_key,
    accountAddress: row.account_address,
    amount0Delta: toBigIntStrict(row.amount0, 'trade amount0 delta'),
    amount1Delta: toBigIntStrict(row.amount1, 'trade amount1 delta'),
    blockHash: row.block_hash,
    executionProtocol: row.execution_protocol,
    metadata: row.metadata ?? {},
    poolId: row.pool_id,
    protocol: row.protocol,
    routerProtocol: row.router_protocol,
    sourceEventIndex: toBigIntStrict(row.source_event_index, 'trade source event index'),
    token0Address: row.token0_address,
    token1Address: row.token1_address,
    transactionHash: row.transaction_hash,
    transactionIndex: toBigIntStrict(row.transaction_index, 'trade transaction index'),
  }));
}

async function upsertTrade(client, trade) {
  await client.query(
    `INSERT INTO stark_trades (
         trade_key,
         lane,
         block_number,
         block_hash,
         block_timestamp,
         transaction_hash,
         transaction_index,
         source_event_index,
         protocol,
         router_protocol,
         execution_protocol,
         pool_id,
         route_group_key,
         sequence_id,
         is_multi_hop,
         hop_index,
         total_hops,
         trader_address,
         locker_address,
         token0_address,
         token1_address,
         token_in_address,
         token_out_address,
         amount0_delta,
         amount1_delta,
         volume_token0,
         volume_token1,
         amount_in,
         amount_out,
         amount_in_human,
         amount_out_human,
         liquidity_after,
         sqrt_ratio_after,
         tick_after,
         tick_spacing,
         fee_tier,
         extension_address,
         price_raw_execution,
         price_raw_token1_per_token0,
         price_raw_token0_per_token1,
         price_token1_per_token0,
         price_token0_per_token1,
         price_deviation_pct,
         price_is_decimals_normalized,
         pending_enrichment,
         hops_from_stable,
         is_aggregator_derived,
         price_source,
         notional_usd,
         bucket_1m,
         metadata,
         created_at,
         updated_at
     ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
         $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
         $21, $22, $23, $24, $25, $26, $27, $28, $29, $30,
         $31, $32, $33, $34, $35, $36, $37, $38, $39, $40,
         $41, $42, $43, $44, $45, $46, $47, $48, $49, $50::jsonb, NOW(), NOW()
     )
     ON CONFLICT (transaction_hash, source_event_index)
     DO UPDATE SET
         trade_key = EXCLUDED.trade_key,
         lane = EXCLUDED.lane,
         block_number = EXCLUDED.block_number,
         block_hash = EXCLUDED.block_hash,
         block_timestamp = EXCLUDED.block_timestamp,
         transaction_index = EXCLUDED.transaction_index,
         protocol = EXCLUDED.protocol,
         router_protocol = EXCLUDED.router_protocol,
         execution_protocol = EXCLUDED.execution_protocol,
         pool_id = EXCLUDED.pool_id,
         route_group_key = EXCLUDED.route_group_key,
         sequence_id = EXCLUDED.sequence_id,
         is_multi_hop = EXCLUDED.is_multi_hop,
         hop_index = EXCLUDED.hop_index,
         total_hops = EXCLUDED.total_hops,
         trader_address = EXCLUDED.trader_address,
         locker_address = EXCLUDED.locker_address,
         token0_address = EXCLUDED.token0_address,
         token1_address = EXCLUDED.token1_address,
         token_in_address = EXCLUDED.token_in_address,
         token_out_address = EXCLUDED.token_out_address,
         amount0_delta = EXCLUDED.amount0_delta,
         amount1_delta = EXCLUDED.amount1_delta,
         volume_token0 = EXCLUDED.volume_token0,
         volume_token1 = EXCLUDED.volume_token1,
         amount_in = EXCLUDED.amount_in,
         amount_out = EXCLUDED.amount_out,
         amount_in_human = EXCLUDED.amount_in_human,
         amount_out_human = EXCLUDED.amount_out_human,
         liquidity_after = EXCLUDED.liquidity_after,
         sqrt_ratio_after = EXCLUDED.sqrt_ratio_after,
         tick_after = EXCLUDED.tick_after,
         tick_spacing = EXCLUDED.tick_spacing,
         fee_tier = EXCLUDED.fee_tier,
         extension_address = EXCLUDED.extension_address,
         price_raw_execution = EXCLUDED.price_raw_execution,
         price_raw_token1_per_token0 = EXCLUDED.price_raw_token1_per_token0,
         price_raw_token0_per_token1 = EXCLUDED.price_raw_token0_per_token1,
         price_token1_per_token0 = EXCLUDED.price_token1_per_token0,
         price_token0_per_token1 = EXCLUDED.price_token0_per_token1,
         price_deviation_pct = EXCLUDED.price_deviation_pct,
         price_is_decimals_normalized = EXCLUDED.price_is_decimals_normalized,
         pending_enrichment = EXCLUDED.pending_enrichment,
         hops_from_stable = EXCLUDED.hops_from_stable,
         is_aggregator_derived = EXCLUDED.is_aggregator_derived,
         price_source = EXCLUDED.price_source,
         notional_usd = EXCLUDED.notional_usd,
         bucket_1m = EXCLUDED.bucket_1m,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()`,
    [
      trade.tradeKey,
      trade.lane,
      toNumericString(trade.blockNumber, 'trade block number'),
      trade.blockHash,
      trade.blockTimestampDate,
      trade.transactionHash,
      toNumericString(trade.transactionIndex, 'trade transaction index'),
      toNumericString(trade.sourceEventIndex, 'trade source event index'),
      trade.protocol,
      trade.routerProtocol ?? null,
      trade.executionProtocol,
      trade.poolId,
      trade.routeGroupKey ?? null,
      trade.sequenceId === null || trade.sequenceId === undefined ? null : toNumericString(trade.sequenceId, 'trade sequence id'),
      trade.isMultiHop,
      trade.hopIndex === null || trade.hopIndex === undefined ? null : toNumericString(trade.hopIndex, 'trade hop index'),
      trade.totalHops === null || trade.totalHops === undefined ? null : toNumericString(trade.totalHops, 'trade total hops'),
      trade.traderAddress ?? null,
      trade.lockerAddress ?? null,
      trade.token0Address,
      trade.token1Address,
      trade.tokenInAddress,
      trade.tokenOutAddress,
      toNumericString(trade.amount0Delta, 'trade amount0 delta'),
      toNumericString(trade.amount1Delta, 'trade amount1 delta'),
      toNumericString(trade.volumeToken0, 'trade volume token0'),
      toNumericString(trade.volumeToken1, 'trade volume token1'),
      toNumericString(trade.amountIn, 'trade amount in'),
      toNumericString(trade.amountOut, 'trade amount out'),
      trade.amountInHumanScaled === null ? null : scaledToNumericString(trade.amountInHumanScaled, DEFAULT_SCALE),
      trade.amountOutHumanScaled === null ? null : scaledToNumericString(trade.amountOutHumanScaled, DEFAULT_SCALE),
      trade.liquidityAfter === null ? null : toNumericString(trade.liquidityAfter, 'trade liquidity after'),
      trade.sqrtRatioAfter === null ? null : toNumericString(trade.sqrtRatioAfter, 'trade sqrt ratio after'),
      trade.tickAfter === null ? null : toNumericString(trade.tickAfter, 'trade tick after'),
      trade.tickSpacing === null || trade.tickSpacing === undefined ? null : toNumericString(trade.tickSpacing, 'trade tick spacing'),
      trade.feeTier === null || trade.feeTier === undefined ? null : toNumericString(trade.feeTier, 'trade fee tier'),
      trade.extensionAddress ?? null,
      trade.priceRawExecutionScaled === null ? null : scaledToNumericString(trade.priceRawExecutionScaled, DEFAULT_SCALE),
      scaledToNumericString(trade.priceRawToken1PerToken0Scaled, DEFAULT_SCALE),
      scaledToNumericString(trade.priceRawToken0PerToken1Scaled, DEFAULT_SCALE),
      scaledToNumericString(trade.priceToken1PerToken0Scaled, DEFAULT_SCALE),
      scaledToNumericString(trade.priceToken0PerToken1Scaled, DEFAULT_SCALE),
      trade.priceDeviationPctScaled === null ? null : scaledToNumericString(trade.priceDeviationPctScaled, DEFAULT_SCALE),
      trade.priceIsDecimalsNormalized,
      trade.pendingEnrichment,
      trade.hopsFromStable === null || trade.hopsFromStable === undefined ? null : toNumericString(trade.hopsFromStable, 'trade hops from stable'),
      trade.isAggregatorDerived,
      trade.priceSource,
      trade.notionalUsdScaled === null ? null : scaledToNumericString(trade.notionalUsdScaled, DEFAULT_SCALE),
      trade.bucketStart,
      toJsonbString(trade.metadata),
    ],
  );
}

async function repricePendingEnrichmentTrades(client, { tokenAddresses }) {
  const normalizedTokenAddresses = Array.from(new Set((tokenAddresses ?? []).filter(Boolean)));
  if (normalizedTokenAddresses.length === 0) {
    return {
      affectedBuckets: [],
      repricedTrades: 0,
    };
  }

  const pendingInputs = await loadPendingTradeInputs(client, normalizedTokenAddresses);
  if (pendingInputs.length === 0) {
    return {
      affectedBuckets: [],
      repricedTrades: 0,
    };
  }

  const affectedBuckets = new Map();
  let repricedTrades = 0;
  const inputsByLane = groupItemsByLane(pendingInputs);

  for (const [lane, items] of inputsByLane.entries()) {
    const tradeTokenAddresses = collectTradeTokenAddresses(items);
    const tokenMetadataByAddress = await loadTokenRegistryByAddress(client, tradeTokenAddresses);
    const priceContext = await loadLatestPriceContext(client, {
      blockNumber: items[items.length - 1].blockNumber,
      lane,
      tokenAddresses: tradeTokenAddresses,
    });
    seedStablePrices(priceContext, {
      blockNumber: items[items.length - 1].blockNumber,
      tokenAddresses: tradeTokenAddresses,
      tokenMetadataByAddress,
    });

    const bridgeEdges = await loadBridgeEdges(client, {
      lane,
      tokenAddresses: tradeTokenAddresses,
    });
    const poolLiquidityById = await loadPoolLiquidityById(client, {
      lane,
      poolIds: items.map((item) => item.poolId),
    });

    for (const item of items) {
      const trade = deriveTrade(item, {
        blockHash: item.blockHash,
        blockNumber: item.blockNumber,
        blockTimestampDate: item.blockTimestampDate,
        bridgeEdges,
        lane,
        latestUsdByToken: new Map(),
        poolLiquidityById,
        priceContext,
        tokenMetadataByAddress,
      });

      if (!trade) {
        continue;
      }

      await upsertTrade(client, trade);
      affectedBuckets.set(`${lane}:${trade.poolId}:${trade.bucketStart.toISOString()}`, {
        bucketStart: trade.bucketStart,
        lane,
        poolId: trade.poolId,
      });
      repricedTrades += 1;
    }
  }

  return {
    affectedBuckets: Array.from(affectedBuckets.values()),
    repricedTrades,
  };
}

async function loadPendingTradeInputs(client, tokenAddresses) {
  const result = await client.query(
    `SELECT trade.lane,
            trade.block_number,
            trade.block_hash,
            trade.block_timestamp,
            trade.transaction_hash,
            trade.transaction_index,
            trade.source_event_index,
            trade.pool_id,
            trade.route_group_key,
            trade.sequence_id,
            trade.is_multi_hop,
            trade.hop_index,
            trade.total_hops,
            trade.locker_address,
            action.action_key,
            action.protocol,
            action.account_address,
            action.token0_address,
            action.token1_address,
            action.router_protocol,
            action.execution_protocol,
            action.amount0,
            action.amount1,
            action.metadata
       FROM stark_trades AS trade
       JOIN stark_action_norm AS action
         ON action.lane = trade.lane
        AND action.block_number = trade.block_number
        AND action.transaction_hash = trade.transaction_hash
        AND action.source_event_index = trade.source_event_index
        AND action.action_type = 'swap'
      WHERE trade.pending_enrichment = TRUE
        AND (
             trade.token0_address = ANY($1::text[])
          OR trade.token1_address = ANY($1::text[])
        )
      ORDER BY trade.lane ASC, trade.block_number ASC, trade.transaction_index ASC, trade.source_event_index ASC`,
    [tokenAddresses],
  );

  return result.rows.map((row) => ({
    actionKey: row.action_key,
    accountAddress: row.account_address,
    amount0Delta: toBigIntStrict(row.amount0, 'pending trade amount0 delta'),
    amount1Delta: toBigIntStrict(row.amount1, 'pending trade amount1 delta'),
    blockHash: row.block_hash,
    blockNumber: toBigIntStrict(row.block_number, 'pending trade block number'),
    blockTimestampDate: new Date(row.block_timestamp),
    executionProtocol: row.execution_protocol,
    hopIndex: row.hop_index === null ? null : toBigIntStrict(row.hop_index, 'pending trade hop index'),
    isMultiHop: Boolean(row.is_multi_hop),
    lane: row.lane,
    lockerAddress: row.locker_address,
    metadata: row.metadata ?? {},
    poolId: row.pool_id,
    protocol: row.protocol,
    routeGroupKey: row.route_group_key,
    routerProtocol: row.router_protocol,
    sequenceId: row.sequence_id === null ? null : toBigIntStrict(row.sequence_id, 'pending trade sequence id'),
    sourceEventIndex: toBigIntStrict(row.source_event_index, 'pending trade source event index'),
    token0Address: row.token0_address,
    token1Address: row.token1_address,
    totalHops: row.total_hops === null ? null : toBigIntStrict(row.total_hops, 'pending trade total hops'),
    transactionHash: row.transaction_hash,
    transactionIndex: toBigIntStrict(row.transaction_index, 'pending trade transaction index'),
  }));
}

function groupItemsByLane(items) {
  const grouped = new Map();

  for (const item of items) {
    if (!grouped.has(item.lane)) {
      grouped.set(item.lane, []);
    }

    grouped.get(item.lane).push(item);
  }

  return grouped;
}

function buildTradeKey(action) {
  return `${action.transactionHash}:${action.sourceEventIndex.toString(10)}`;
}

function serializeRealtimeTrade(trade) {
  return {
    amountIn: trade.amountIn.toString(10),
    amountOut: trade.amountOut.toString(10),
    blockNumber: trade.blockNumber.toString(10),
    blockTimestamp: trade.blockTimestampDate.toISOString(),
    executionProtocol: trade.executionProtocol,
    lane: trade.lane,
    notionalUsd: trade.notionalUsdScaled === null ? null : scaledToNumericString(trade.notionalUsdScaled, DEFAULT_SCALE),
    pendingEnrichment: trade.pendingEnrichment,
    poolId: trade.poolId,
    routeGroupKey: trade.routeGroupKey,
    sequenceId: trade.sequenceId === null || trade.sequenceId === undefined ? null : trade.sequenceId.toString(10),
    priceSource: trade.priceSource,
    priceToken0PerToken1: scaledToNumericString(trade.priceToken0PerToken1Scaled, DEFAULT_SCALE),
    priceToken1PerToken0: scaledToNumericString(trade.priceToken1PerToken0Scaled, DEFAULT_SCALE),
    protocol: trade.protocol,
    sourceEventIndex: trade.sourceEventIndex.toString(10),
    tokenInAddress: trade.tokenInAddress,
    tokenOutAddress: trade.tokenOutAddress,
    tradeKey: trade.tradeKey,
    traderAddress: trade.traderAddress,
    transactionHash: trade.transactionHash,
    transactionIndex: trade.transactionIndex.toString(10),
  };
}

function floorToMinute(date) {
  return new Date(Math.floor(date.getTime() / 60_000) * 60_000);
}

function parseBoolean(value, fallbackValue) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallbackValue;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parseNonNegativeBigInt(value, fallbackValue) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallbackValue;
  }

  try {
    const parsed = BigInt(String(value).trim());
    return parsed >= 0n ? parsed : fallbackValue;
  } catch (error) {
    return fallbackValue;
  }
}

function toBlockTimestampDate(blockTimestamp) {
  const timestamp = toBigIntStrict(blockTimestamp, 'block timestamp');
  return new Date(Number(timestamp) * 1000);
}

function emptyTradeResult() {
  return {
    latestUsdByToken: new Map(),
    priceCandidates: [],
    realtimeTrades: [],
    summary: {
      priceCandidates: 0,
      pricedTrades: 0,
      trades: 0,
    },
    trades: [],
  };
}

module.exports = {
  persistTradesForBlock,
  repricePendingEnrichmentTrades,
};
