'use strict';

const { createTtlCache } = require('../lib/cache');
const { knownErc20Cache } = require('./known-erc20-cache');
const { normalizeAddress } = require('./normalize');
const { loadTokenRegistryByAddress } = require('./token-registry');

const tokenTrustCache = createTtlCache({
  defaultTtlMs: 60_000,
  maxEntries: 20_000,
});

async function resolveTrustedToken({ client, tokenAddress }) {
  const normalizedTokenAddress = normalizeAddress(tokenAddress, 'trusted token address');
  const staticToken = knownErc20Cache.getToken(normalizedTokenAddress);
  if (staticToken) {
    return {
      decimals: staticToken.decimals,
      name: staticToken.name,
      symbol: staticToken.symbol,
      tokenAddress: normalizedTokenAddress,
      verificationGate: 'known_erc20_cache',
      verificationLevel: 'static_verified',
      verificationSource: staticToken.verificationSource ?? 'known_erc20_cache',
    };
  }

  if (!client || typeof client.query !== 'function') {
    return null;
  }

  return tokenTrustCache.getOrLoad(normalizedTokenAddress, async () => {
    const registryByAddress = await loadTokenRegistryByAddress(client, [normalizedTokenAddress]);
    const tokenInfo = registryByAddress.get(normalizedTokenAddress);
    if (!tokenInfo) {
      return null;
    }

    const hasUsableMetadata = tokenInfo.decimals !== null && (tokenInfo.symbol !== null || tokenInfo.name !== null);
    if (!hasUsableMetadata) {
      return null;
    }

    return {
      decimals: Number(tokenInfo.decimals),
      name: tokenInfo.name ?? null,
      symbol: tokenInfo.symbol ?? null,
      tokenAddress: normalizedTokenAddress,
      verificationGate: tokenInfo.isVerified ? 'tokens_registry_verified' : 'tokens_registry_resolved',
      verificationLevel: tokenInfo.isVerified ? 'registry_verified' : 'registry_resolved',
      verificationSource: tokenInfo.isVerified ? 'tokens_registry' : 'tokens_registry_enriched',
    };
  });
}

module.exports = {
  resolveTrustedToken,
};
