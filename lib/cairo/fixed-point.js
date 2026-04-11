'use strict';

const { toBigIntStrict } = require('./bigint');

const DEFAULT_SCALE = 30;
const SCALE_FACTOR_CACHE = new Map();

function absBigInt(value) {
  const numericValue = toBigIntStrict(value, 'value');
  return numericValue < 0n ? -numericValue : numericValue;
}

function compareBigInt(a, b) {
  const left = toBigIntStrict(a, 'left');
  const right = toBigIntStrict(b, 'right');

  if (left === right) {
    return 0;
  }

  return left > right ? 1 : -1;
}

function decimalStringToScaled(value, scale = DEFAULT_SCALE) {
  if (value === undefined || value === null) {
    return null;
  }

  const normalized = String(value).trim();
  if (!normalized) {
    throw new TypeError('Decimal string cannot be empty.');
  }

  const sign = normalized.startsWith('-') ? -1n : 1n;
  const unsigned = normalized.startsWith('-') || normalized.startsWith('+') ? normalized.slice(1) : normalized;

  if (!/^\d+(\.\d+)?$/.test(unsigned)) {
    throw new TypeError(`Invalid decimal string: ${value}`);
  }

  const [wholePart, fractionalPart = ''] = unsigned.split('.');
  const paddedFraction = fractionalPart.padEnd(scale, '0').slice(0, scale);
  const scaled = (BigInt(wholePart) * getScaleFactor(scale)) + BigInt(paddedFraction || '0');

  return sign < 0n ? -scaled : scaled;
}

function getScaleFactor(scale = DEFAULT_SCALE) {
  const normalizedScale = normalizeScale(scale);

  if (!SCALE_FACTOR_CACHE.has(normalizedScale)) {
    SCALE_FACTOR_CACHE.set(normalizedScale, 10n ** BigInt(normalizedScale));
  }

  return SCALE_FACTOR_CACHE.get(normalizedScale);
}

function integerAmountToScaled(value, decimals, scale = DEFAULT_SCALE) {
  const amount = absBigInt(value);
  const normalizedDecimals = normalizeDecimals(decimals);
  const scaled = (amount * getScaleFactor(scale)) / (10n ** BigInt(normalizedDecimals));
  const signed = toBigIntStrict(value, 'integer amount');

  return signed < 0n ? -scaled : scaled;
}

function normalizeDecimals(decimals) {
  if (decimals === undefined || decimals === null) {
    throw new TypeError('Token decimals are required for this calculation.');
  }

  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new TypeError(`Invalid decimals value: ${decimals}`);
  }

  return decimals;
}

function normalizeScale(scale) {
  if (!Number.isInteger(scale) || scale < 0) {
    throw new TypeError(`Invalid scale value: ${scale}`);
  }

  return scale;
}

function scaledDivide(numerator, denominator, scale = DEFAULT_SCALE) {
  const left = toBigIntStrict(numerator, 'numerator');
  const right = toBigIntStrict(denominator, 'denominator');

  if (right === 0n) {
    throw new RangeError('Cannot divide by zero.');
  }

  return (left * getScaleFactor(scale)) / right;
}

function scaledMultiply(left, right, scale = DEFAULT_SCALE) {
  const a = toBigIntStrict(left, 'left');
  const b = toBigIntStrict(right, 'right');

  return (a * b) / getScaleFactor(scale);
}

function scaledRatio(numerator, denominator, decimalExponent = 0, scale = DEFAULT_SCALE) {
  let left = absBigInt(numerator);
  let right = absBigInt(denominator);

  if (right === 0n) {
    throw new RangeError('Cannot divide by zero.');
  }

  if (decimalExponent > 0) {
    left *= 10n ** BigInt(decimalExponent);
  } else if (decimalExponent < 0) {
    right *= 10n ** BigInt(-decimalExponent);
  }

  const sign = toBigIntStrict(numerator, 'numerator') < 0n ? -1n : 1n;
  const scaled = (left * getScaleFactor(scale)) / right;

  return sign < 0n ? -scaled : scaled;
}

function scaledToNumericString(value, scale = DEFAULT_SCALE) {
  const numericValue = toBigIntStrict(value, 'scaled value');
  const normalizedScale = normalizeScale(scale);
  const factor = getScaleFactor(normalizedScale);
  const sign = numericValue < 0n ? '-' : '';
  const absolute = numericValue < 0n ? -numericValue : numericValue;
  const whole = absolute / factor;
  const fraction = absolute % factor;

  if (fraction === 0n) {
    return `${sign}${whole.toString(10)}`;
  }

  const paddedFraction = fraction.toString(10).padStart(normalizedScale, '0').replace(/0+$/, '');
  return `${sign}${whole.toString(10)}.${paddedFraction}`;
}

function resolveUsdPriceFromGraph({
  anchorPricesByToken = new Map(),
  edges = [],
  maxHops = 2,
  minLiquidityUsdScaled = 0n,
  targetTokenAddress,
}) {
  const normalizedTarget = normalizeGraphAddress(targetTokenAddress);
  const normalizedMinLiquidity = toBigIntStrict(minLiquidityUsdScaled, 'min liquidity usd');

  const directAnchor = normalizeAnchorPrice(anchorPricesByToken.get(normalizedTarget));
  if (directAnchor && !directAnchor.priceIsStale) {
    return {
      anchorTokenAddress: normalizedTarget,
      hops: 0,
      path: [],
      pathLiquidityUsdScaled: null,
      pathSource: directAnchor.priceSource,
      priceIsStale: false,
      priceUpdatedAtBlock: directAnchor.priceUpdatedAtBlock,
      priceUsdScaled: directAnchor.priceUsdScaled,
    };
  }

  const adjacency = buildAdjacency(edges, normalizedMinLiquidity);
  const queue = [{
    currentTokenAddress: normalizedTarget,
    hops: 0,
    seenTokenAddresses: new Set([normalizedTarget]),
    path: [],
    pathLiquidityUsdScaled: null,
    rateScaled: getScaleFactor(DEFAULT_SCALE),
  }];
  const visited = new Map([[
    normalizedTarget,
    {
      hops: 0,
      pathLiquidityUsdScaled: null,
    },
  ]]);
  let best = null;
  let shortestAnchorHops = null;

  while (queue.length > 0) {
    const state = queue.shift();

    if (state.hops >= maxHops) {
      continue;
    }

    const neighbors = adjacency.get(state.currentTokenAddress) ?? [];
    for (const edge of neighbors) {
      if (state.seenTokenAddresses.has(edge.toTokenAddress)) {
        continue;
      }

      const nextHops = state.hops + 1;
      const nextRateScaled = scaledMultiply(state.rateScaled, edge.rateScaled, DEFAULT_SCALE);
      const nextLiquidity = state.pathLiquidityUsdScaled === null
        ? edge.liquidityUsdScaled
        : minBigInt(state.pathLiquidityUsdScaled, edge.liquidityUsdScaled);
      const nextPath = [
        ...state.path,
        {
          fromTokenAddress: edge.fromTokenAddress,
          liquidityUsdScaled: edge.liquidityUsdScaled,
          priceSource: edge.priceSource,
          rateScaled: edge.rateScaled,
          toTokenAddress: edge.toTokenAddress,
        },
      ];
      const anchor = normalizeAnchorPrice(anchorPricesByToken.get(edge.toTokenAddress));

      if (anchor) {
        const candidate = {
          anchorTokenAddress: edge.toTokenAddress,
          hops: nextHops,
          path: nextPath,
          pathLiquidityUsdScaled: nextLiquidity,
          pathSource: buildPathSource(nextPath, anchor.priceSource),
          priceIsStale: anchor.priceIsStale,
          priceUpdatedAtBlock: anchor.priceUpdatedAtBlock,
          priceUsdScaled: scaledMultiply(nextRateScaled, anchor.priceUsdScaled, DEFAULT_SCALE),
          shortestAnchorHops: shortestAnchorHops === null ? nextHops : Math.min(shortestAnchorHops, nextHops),
        };

        shortestAnchorHops = shortestAnchorHops === null
          ? nextHops
          : Math.min(shortestAnchorHops, nextHops);

        if (best === null || compareResolvedPaths(candidate, best) < 0) {
          best = candidate;
        }
      }

      const nextTraversalState = {
        hops: nextHops,
        pathLiquidityUsdScaled: nextLiquidity,
      };
      const visitedState = visited.get(edge.toTokenAddress);
      if (visitedState && compareTraversalState(visitedState, nextTraversalState) <= 0) {
        continue;
      }

      visited.set(edge.toTokenAddress, nextTraversalState);
      queue.push({
        currentTokenAddress: edge.toTokenAddress,
        hops: nextHops,
        seenTokenAddresses: new Set([...state.seenTokenAddresses, edge.toTokenAddress]),
        path: nextPath,
        pathLiquidityUsdScaled: nextLiquidity,
        rateScaled: nextRateScaled,
      });
    }
  }

  if (best) {
    best.shortestAnchorHops = shortestAnchorHops ?? best.hops;
  }

  return best;
}

function buildAdjacency(edges, minLiquidityUsdScaled) {
  const adjacency = new Map();

  for (const edge of Array.isArray(edges) ? edges : []) {
    const normalizedEdge = normalizeGraphEdge(edge);
    if (!normalizedEdge) {
      continue;
    }

    if (normalizedEdge.liquidityUsdScaled === null) {
      continue;
    }

    if (compareBigInt(normalizedEdge.liquidityUsdScaled, minLiquidityUsdScaled) < 0) {
      continue;
    }

    if (!adjacency.has(normalizedEdge.fromTokenAddress)) {
      adjacency.set(normalizedEdge.fromTokenAddress, []);
    }

    adjacency.get(normalizedEdge.fromTokenAddress).push(normalizedEdge);
  }

  return adjacency;
}

function normalizeAnchorPrice(value) {
  if (!value || value.priceUsdScaled === null || value.priceUsdScaled === undefined) {
    return null;
  }

  return {
    priceIsStale: Boolean(value.priceIsStale),
    priceSource: value.priceSource ?? null,
    priceUpdatedAtBlock: value.priceUpdatedAtBlock === undefined || value.priceUpdatedAtBlock === null
      ? null
      : toBigIntStrict(value.priceUpdatedAtBlock, 'price updated at block'),
    priceUsdScaled: toBigIntStrict(value.priceUsdScaled, 'price usd'),
  };
}

function normalizeGraphEdge(edge) {
  if (!edge) {
    return null;
  }

  const fromTokenAddress = normalizeGraphAddress(edge.fromTokenAddress);
  const toTokenAddress = normalizeGraphAddress(edge.toTokenAddress);
  if (!fromTokenAddress || !toTokenAddress || fromTokenAddress === toTokenAddress) {
    return null;
  }

  return {
    fromTokenAddress,
    liquidityUsdScaled: edge.liquidityUsdScaled === undefined || edge.liquidityUsdScaled === null
      ? null
      : toBigIntStrict(edge.liquidityUsdScaled, 'edge liquidity usd'),
    priceSource: edge.priceSource ?? null,
    rateScaled: toBigIntStrict(edge.rateScaled, 'edge rate'),
    toTokenAddress,
  };
}

function normalizeGraphAddress(value) {
  return value === undefined || value === null ? null : String(value).toLowerCase();
}

function buildPathSource(path, anchorPriceSource) {
  const edgeSources = path.map((edge) => edge.priceSource).filter(Boolean);
  if (anchorPriceSource) {
    edgeSources.push(anchorPriceSource);
  }
  return edgeSources.join(' -> ') || null;
}

function compareResolvedPaths(left, right) {
  if (left.priceIsStale !== right.priceIsStale) {
    return left.priceIsStale ? 1 : -1;
  }

  if (left.hops !== right.hops) {
    return left.hops - right.hops;
  }

  const leftLiquidity = left.pathLiquidityUsdScaled ?? -1n;
  const rightLiquidity = right.pathLiquidityUsdScaled ?? -1n;
  const liquidityComparison = compareBigInt(rightLiquidity, leftLiquidity);
  if (liquidityComparison !== 0) {
    return liquidityComparison;
  }

  const leftUpdated = left.priceUpdatedAtBlock ?? -1n;
  const rightUpdated = right.priceUpdatedAtBlock ?? -1n;
  return compareBigInt(rightUpdated, leftUpdated);
}

function compareTraversalState(left, right) {
  if (left.hops !== right.hops) {
    return left.hops - right.hops;
  }

  const leftLiquidity = left.pathLiquidityUsdScaled ?? -1n;
  const rightLiquidity = right.pathLiquidityUsdScaled ?? -1n;
  return compareBigInt(rightLiquidity, leftLiquidity);
}

function minBigInt(left, right) {
  return compareBigInt(left, right) <= 0 ? left : right;
}

module.exports = {
  DEFAULT_SCALE,
  absBigInt,
  compareBigInt,
  decimalStringToScaled,
  getScaleFactor,
  integerAmountToScaled,
  resolveUsdPriceFromGraph,
  scaledDivide,
  scaledMultiply,
  scaledRatio,
  scaledToNumericString,
};
