'use strict';

const { fetchLatestQuotes } = require('../lib/cmc');
const {
  DEFAULT_SCALE,
  absBigInt,
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
const { toJsonbString } = require('./protocols/shared');

const STABLE_TOKEN_SYMBOLS = new Set(['DAI', 'USDC', 'USDT']);
const DEFAULT_BRIDGE_SYMBOLS = ['STRK', 'ETH', 'WBTC', 'USDC', 'USDT', 'DAI'];
const DEFAULT_CMC_ALLOWLIST = ['STRK', 'ETH', 'WBTC', 'WSTETH', 'EKUBO'];
const DEFAULT_PENDING_DECIMALS = 18;
const USD_ONE_SCALED = decimalStringToScaled('1', DEFAULT_SCALE);

async function persistTradesForBlock(client, { blockHash, blockNumber, blockTimestamp, lane }) {
  const actions = await loadSwapActions(client, { blockNumber, lane });

  if (actions.length === 0) {
    return emptyTradeResult();
  }

  const blockTimestampDate = toBlockTimestampDate(blockTimestamp);
  const tradeTokenAddresses = collectTradeTokenAddresses(actions);
  const tokenMetadataByAddress = await loadTokenMetadataByAddress(client, tradeTokenAddresses);
  const priceContext = await loadLatestPriceContext(client, {
    blockNumber,
    lane,
    tokenAddresses: tradeTokenAddresses,
  });
  seedStablePrices(priceContext, { blockNumber, tokenAddresses: tradeTokenAddresses });

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

  return {
    latestUsdByToken,
    priceCandidates,
    realtimeTrades: trades.map(serializeRealtimeTrade),
    summary: {
      priceCandidates: priceCandidates.length,
      pricedTrades: trades.filter((item) => item.notionalUsdScaled !== null).length,
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
    priceContext: context.priceContext,
    priceScaled: priceBundle.priceToken1PerToken0Scaled,
    tradeGraphEdges: graphEdges,
  });
  const token1Price = resolveUsdPriceForToken(action.token1Address, {
    blockNumber: context.blockNumber,
    directStableAddress: action.token0Address,
    inverse: true,
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
  const notionalUsdScaled = resolveNotionalUsd({
    amountInHumanScaled,
    amountOutHumanScaled,
    tokenInAddress: direction.tokenInAddress,
    tokenInPrice,
    tokenOutAddress: direction.tokenOutAddress,
    tokenOutPrice,
  });

  const priceCandidates = buildPriceCandidates(action, {
    blockHash: context.blockHash,
    blockNumber: context.blockNumber,
    blockTimestampDate: context.blockTimestampDate,
    lane: context.lane,
    priceBundle,
    token0Price,
    token1Price,
  });

  const bucketStart = floorToMinute(context.blockTimestampDate);
  const metadata = {
    amount0_delta: action.amount0Delta,
    amount1_delta: action.amount1Delta,
    decimals_known: priceBundle.priceIsDecimalsNormalized,
    default_decimals_applied: pendingEnrichment ? DEFAULT_PENDING_DECIMALS : null,
    missing_decimals_for: missingDecimalsFor,
    original_action_key: action.actionKey,
    pending_enrichment: pendingEnrichment,
    pool_id: action.poolId,
    price_source: priceBundle.priceSource,
    protocol: action.protocol,
    token0_price_path: token0Price?.pathSource ?? null,
    token1_price_path: token1Price?.pathSource ?? null,
  };

  return {
    amount0Delta: action.amount0Delta,
    amount1Delta: action.amount1Delta,
    amountIn: direction.amountIn,
    amountOut: direction.amountOut,
    blockHash: context.blockHash,
    blockNumber: context.blockNumber,
    blockTimestampDate: context.blockTimestampDate,
    bucketStart,
    executionProtocol: action.executionProtocol,
    lane: context.lane,
    metadata,
    notionalUsdScaled,
    poolId: action.poolId,
    priceCandidates,
    priceIsDecimalsNormalized: priceBundle.priceIsDecimalsNormalized,
    priceRawToken0PerToken1Scaled: priceBundle.priceRawToken0PerToken1Scaled,
    priceRawToken1PerToken0Scaled: priceBundle.priceRawToken1PerToken0Scaled,
    priceSource: priceBundle.priceSource,
    priceToken0PerToken1Scaled: priceBundle.priceToken0PerToken1Scaled,
    priceToken1PerToken0Scaled: priceBundle.priceToken1PerToken0Scaled,
    protocol: action.protocol,
    routerProtocol: action.routerProtocol,
    sourceEventIndex: action.sourceEventIndex,
    pendingEnrichment,
    token0Address: action.token0Address,
    token1Address: action.token1Address,
    tokenInAddress: direction.tokenInAddress,
    tokenOutAddress: direction.tokenOutAddress,
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

  return {
    priceIsDecimalsNormalized: Boolean(decimalsConfirmed),
    priceRawToken0PerToken1Scaled,
    priceRawToken1PerToken0Scaled,
    priceSource,
    priceToken0PerToken1Scaled: scaledRatio(rawDenominator, rawNumerator, inverseDecimalExponent, DEFAULT_SCALE),
    priceToken1PerToken0Scaled: scaledRatio(rawNumerator, rawDenominator, decimalExponent, DEFAULT_SCALE),
  };
}

function resolveUsdPriceForToken(targetAddress, {
  blockNumber,
  directStableAddress,
  inverse = false,
  priceContext,
  priceScaled,
  tradeGraphEdges,
}) {
  if (isStableTokenAddress(targetAddress)) {
    return {
      path: [],
      pathSource: 'stable_seed',
      priceIsStale: false,
      priceUpdatedAtBlock: blockNumber,
      priceUsdScaled: USD_ONE_SCALED,
    };
  }

  if (isStableTokenAddress(directStableAddress)) {
    return {
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

  return resolved;
}

function resolveNotionalUsd({
  amountInHumanScaled,
  amountOutHumanScaled,
  tokenInAddress,
  tokenInPrice,
  tokenOutAddress,
  tokenOutPrice,
}) {
  if (amountInHumanScaled !== null && isStableTokenAddress(tokenInAddress)) {
    return amountInHumanScaled;
  }

  if (amountOutHumanScaled !== null && isStableTokenAddress(tokenOutAddress)) {
    return amountOutHumanScaled;
  }

  if (amountInHumanScaled !== null && tokenInPrice?.priceUsdScaled) {
    return scaledMultiply(amountInHumanScaled, tokenInPrice.priceUsdScaled, DEFAULT_SCALE);
  }

  if (amountOutHumanScaled !== null && tokenOutPrice?.priceUsdScaled) {
    return scaledMultiply(amountOutHumanScaled, tokenOutPrice.priceUsdScaled, DEFAULT_SCALE);
  }

  return null;
}

function buildPriceCandidates(action, { blockHash, blockNumber, blockTimestampDate, lane, priceBundle, token0Price, token1Price }) {
  const candidates = [];

  if (token0Price?.priceUsdScaled) {
    candidates.push({
      blockHash,
      blockNumber,
      blockTimestampDate,
      lane,
      metadata: {
        execution_protocol: action.executionProtocol,
        path_source: token0Price.pathSource ?? null,
        pool_id: action.poolId,
        price_source: priceBundle.priceSource,
      },
      poolId: action.poolId,
      priceIsStale: token0Price.priceIsStale,
      priceQuoteScaled: priceBundle.priceToken1PerToken0Scaled,
      priceSource: token0Price.pathSource ?? resolveUsdPriceSource(action.token1Address, priceBundle.priceSource),
      priceUpdatedAtBlock: token0Price.priceUpdatedAtBlock ?? blockNumber,
      priceUsdScaled: token0Price.priceUsdScaled,
      quoteTokenAddress: action.token1Address,
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
      lane,
      metadata: {
        execution_protocol: action.executionProtocol,
        path_source: token1Price.pathSource ?? null,
        pool_id: action.poolId,
        price_source: priceBundle.priceSource,
      },
      poolId: action.poolId,
      priceIsStale: token1Price.priceIsStale,
      priceQuoteScaled: priceBundle.priceToken0PerToken1Scaled,
      priceSource: token1Price.pathSource ?? resolveUsdPriceSource(action.token0Address, priceBundle.priceSource),
      priceUpdatedAtBlock: token1Price.priceUpdatedAtBlock ?? blockNumber,
      priceUsdScaled: token1Price.priceUsdScaled,
      quoteTokenAddress: action.token0Address,
      sourceEventIndex: action.sourceEventIndex,
      tokenAddress: action.token1Address,
      transactionHash: action.transactionHash,
      transactionIndex: action.transactionIndex,
    });
  }

  return candidates;
}

function resolveUsdPriceSource(counterpartyAddress, baseSource) {
  return isStableTokenAddress(counterpartyAddress) ? `stable_direct:${baseSource}` : `bridge_latest:${baseSource}`;
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

function seedStablePrices(priceContext, { blockNumber, tokenAddresses }) {
  for (const tokenAddress of tokenAddresses) {
    if (!isStableTokenAddress(tokenAddress)) {
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

async function loadTokenMetadataByAddress(client, tokenAddresses) {
  const uniqueTokenAddresses = Array.from(new Set((tokenAddresses ?? []).filter(Boolean)));
  const metadataByAddress = new Map();

  for (const tokenAddress of uniqueTokenAddresses) {
    const knownToken = knownErc20Cache.getToken(tokenAddress);
    if (knownToken) {
      metadataByAddress.set(tokenAddress, {
        decimals: knownToken.decimals ?? null,
        isVerified: true,
        name: knownToken.name ?? null,
        symbol: knownToken.symbol ?? null,
      });
    }
  }

  if (uniqueTokenAddresses.length === 0) {
    return metadataByAddress;
  }

  const result = await client.query(
    `SELECT token_address, name, symbol, decimals, is_verified
       FROM stark_token_metadata
      WHERE token_address = ANY($1::text[])`,
    [uniqueTokenAddresses],
  );

  for (const row of result.rows) {
    const existing = metadataByAddress.get(row.token_address) ?? {};
    metadataByAddress.set(row.token_address, {
      ...existing,
      decimals: row.decimals === null ? existing.decimals ?? null : Number.parseInt(String(row.decimals), 10),
      isVerified: row.is_verified ?? existing.isVerified ?? false,
      name: row.name ?? existing.name ?? null,
      symbol: row.symbol ?? existing.symbol ?? null,
    });
  }

  return metadataByAddress;
}

function getTokenInfo(tokenAddress, tokenMetadataByAddress = null) {
  if (tokenMetadataByAddress instanceof Map && tokenMetadataByAddress.has(tokenAddress)) {
    return tokenMetadataByAddress.get(tokenAddress);
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

function isStableTokenAddress(tokenAddress) {
  const token = getTokenInfo(tokenAddress);
  if (!token?.symbol) {
    return false;
  }

  return STABLE_TOKEN_SYMBOLS.has(String(token.symbol).toUpperCase());
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
        AND COALESCE((metadata->>'is_route_leg')::boolean, FALSE) = FALSE
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
         trader_address,
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
         price_raw_token1_per_token0,
         price_raw_token0_per_token1,
         price_token1_per_token0,
         price_token0_per_token1,
         price_is_decimals_normalized,
         pending_enrichment,
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
         $31, $32, $33::jsonb, NOW(), NOW()
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
         trader_address = EXCLUDED.trader_address,
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
         price_raw_token1_per_token0 = EXCLUDED.price_raw_token1_per_token0,
         price_raw_token0_per_token1 = EXCLUDED.price_raw_token0_per_token1,
         price_token1_per_token0 = EXCLUDED.price_token1_per_token0,
         price_token0_per_token1 = EXCLUDED.price_token0_per_token1,
         price_is_decimals_normalized = EXCLUDED.price_is_decimals_normalized,
         pending_enrichment = EXCLUDED.pending_enrichment,
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
      trade.traderAddress ?? null,
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
      scaledToNumericString(trade.priceRawToken1PerToken0Scaled, DEFAULT_SCALE),
      scaledToNumericString(trade.priceRawToken0PerToken1Scaled, DEFAULT_SCALE),
      scaledToNumericString(trade.priceToken1PerToken0Scaled, DEFAULT_SCALE),
      scaledToNumericString(trade.priceToken0PerToken1Scaled, DEFAULT_SCALE),
      trade.priceIsDecimalsNormalized,
      trade.pendingEnrichment,
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
    const tokenMetadataByAddress = await loadTokenMetadataByAddress(client, tradeTokenAddresses);
    const priceContext = await loadLatestPriceContext(client, {
      blockNumber: items[items.length - 1].blockNumber,
      lane,
      tokenAddresses: tradeTokenAddresses,
    });
    seedStablePrices(priceContext, {
      blockNumber: items[items.length - 1].blockNumber,
      tokenAddresses: tradeTokenAddresses,
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
    lane: row.lane,
    metadata: row.metadata ?? {},
    poolId: row.pool_id,
    protocol: row.protocol,
    routerProtocol: row.router_protocol,
    sourceEventIndex: toBigIntStrict(row.source_event_index, 'pending trade source event index'),
    token0Address: row.token0_address,
    token1Address: row.token1_address,
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
