'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { normalizeOptionalAddress } = require('./normalize');

const CACHE_PATH = path.resolve(__dirname, '..', 'data', 'registry', 'known-erc20.json');

const cache = buildCache(JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')));

function buildCache(payload) {
  const byBridgeFamily = new Map();
  const byBridgePair = new Map();
  const byBridgeToken = new Map();
  const bySymbol = new Map();
  const tokens = [];
  const byToken = new Map();

  for (const family of payload.bridge_families ?? []) {
    const normalized = {
      family: family.family ?? 'unknown',
      l1BridgeAddress: normalizeOptionalAddress(family.l1_bridge_address, 'known erc20 bridge family l1 bridge'),
      l1ManagerAddress: normalizeOptionalAddress(family.l1_manager_address, 'known erc20 bridge family l1 manager'),
      l1RegistryAddress: normalizeOptionalAddress(family.l1_registry_address, 'known erc20 bridge family l1 registry'),
      l2BridgeAddress: normalizeOptionalAddress(family.l2_bridge_address, 'known erc20 bridge family l2 bridge'),
      verificationSource: family.verification_source ?? null,
    };

    const pairKey = buildBridgePairKey(normalized.l1BridgeAddress, normalized.l2BridgeAddress);
    if (pairKey) {
      byBridgeFamily.set(pairKey, normalized);
    }
  }

  for (const token of payload.tokens ?? []) {
    const normalized = {
      comment: token.comment ?? null,
      decimals: token.decimals === null || token.decimals === undefined ? null : Number(token.decimals),
      id: token.id ?? null,
      l1BridgeAddress: normalizeOptionalAddress(token.l1_bridge_address, 'known erc20 l1 bridge'),
      l1TokenAddress: normalizeOptionalAddress(token.l1_token_address, 'known erc20 l1 token'),
      l2BridgeAddress: normalizeOptionalAddress(token.l2_bridge_address, 'known erc20 l2 bridge'),
      l2TokenAddress: normalizeOptionalAddress(token.l2_token_address, 'known erc20 l2 token'),
      name: token.name ?? null,
      symbol: token.symbol ?? null,
      verificationSource: token.verification_source ?? null,
    };

    if (!normalized.l2TokenAddress) {
      continue;
    }

    tokens.push(normalized);
    byToken.set(normalized.l2TokenAddress, normalized);
    const normalizedSymbol = normalized.symbol ? String(normalized.symbol).toUpperCase() : null;
    if (normalizedSymbol) {
      if (!bySymbol.has(normalizedSymbol)) {
        bySymbol.set(normalizedSymbol, []);
      }
      bySymbol.get(normalizedSymbol).push(normalized);
    }

    const pairKey = buildBridgePairKey(normalized.l1BridgeAddress, normalized.l2BridgeAddress);
    if (pairKey) {
      if (!byBridgePair.has(pairKey)) {
        byBridgePair.set(pairKey, []);
      }
      byBridgePair.get(pairKey).push(normalized);

      const tokenKey = buildBridgeTokenKey(normalized.l1BridgeAddress, normalized.l2BridgeAddress, normalized.l1TokenAddress);
      if (tokenKey) {
        byBridgeToken.set(tokenKey, normalized);
      }
    }
  }

  return {
    byBridgeFamily,
    byBridgePair,
    byBridgeToken,
    bySymbol,
    byToken,
    tokens,
  };
}

function buildBridgePairKey(l1BridgeAddress, l2BridgeAddress) {
  const normalizedL1Bridge = normalizeOptionalAddress(l1BridgeAddress, 'bridge pair l1 bridge');
  const normalizedL2Bridge = normalizeOptionalAddress(l2BridgeAddress, 'bridge pair l2 bridge');

  if (!normalizedL1Bridge || !normalizedL2Bridge) {
    return null;
  }

  return `${normalizedL1Bridge}:${normalizedL2Bridge}`;
}

function buildBridgeTokenKey(l1BridgeAddress, l2BridgeAddress, l1TokenAddress) {
  const pairKey = buildBridgePairKey(l1BridgeAddress, l2BridgeAddress);
  const normalizedL1Token = normalizeOptionalAddress(l1TokenAddress, 'bridge token l1 token');

  if (!pairKey || !normalizedL1Token) {
    return null;
  }

  return `${pairKey}:${normalizedL1Token}`;
}

function has(address) {
  const normalizedAddress = normalizeOptionalAddress(address, 'known erc20 lookup address');
  return Boolean(normalizedAddress && cache.byToken.has(normalizedAddress));
}

function getToken(address) {
  const normalizedAddress = normalizeOptionalAddress(address, 'known erc20 token address');
  if (!normalizedAddress) {
    return null;
  }

  return cache.byToken.get(normalizedAddress) ?? null;
}

function getBridgeFamily({ l1BridgeAddress, l2BridgeAddress }) {
  const pairKey = buildBridgePairKey(l1BridgeAddress, l2BridgeAddress);
  if (!pairKey) {
    return null;
  }

  return cache.byBridgeFamily.get(pairKey) ?? null;
}

function findBySymbol(symbol) {
  if (symbol === undefined || symbol === null) {
    return [];
  }

  return cache.bySymbol.get(String(symbol).toUpperCase()) ?? [];
}

function getAllTokens() {
  return [...cache.tokens];
}

function getTokensForBridgePair({ l1BridgeAddress, l2BridgeAddress }) {
  const pairKey = buildBridgePairKey(l1BridgeAddress, l2BridgeAddress);
  if (!pairKey) {
    return [];
  }

  return cache.byBridgePair.get(pairKey) ?? [];
}

function resolveStarkgateL2Token({ l1BridgeAddress, l2BridgeAddress, l1TokenAddress }) {
  const tokenKey = buildBridgeTokenKey(l1BridgeAddress, l2BridgeAddress, l1TokenAddress);
  if (tokenKey && cache.byBridgeToken.has(tokenKey)) {
    return cache.byBridgeToken.get(tokenKey);
  }

  const candidates = getTokensForBridgePair({ l1BridgeAddress, l2BridgeAddress });
  if (candidates.length === 1) {
    return candidates[0];
  }

  return null;
}

const knownErc20Cache = Object.freeze({
  findBySymbol,
  getAllTokens,
  getBridgeFamily,
  getToken,
  getTokensForBridgePair,
  has,
  resolveStarkgateL2Token,
  size: cache.byToken.size,
});

module.exports = {
  buildBridgePairKey,
  knownErc20Cache,
};
