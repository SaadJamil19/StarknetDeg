'use strict';

const { createTtlCache } = require('../lib/cache');
const { toBigIntStrict } = require('../lib/cairo/bigint');
const { knownErc20Cache } = require('./known-erc20-cache');
const { normalizeAddress } = require('./normalize');

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
    const result = await client.query(
      `SELECT token_address,
              name,
              symbol,
              decimals,
              is_verified
         FROM stark_token_metadata
        WHERE token_address = $1
        LIMIT 1`,
      [normalizedTokenAddress],
    );

    if (result.rowCount === 0) {
      return null;
    }

    const row = result.rows[0];
    const hasUsableMetadata = row.decimals !== null && (row.symbol !== null || row.name !== null);
    if (!hasUsableMetadata) {
      return null;
    }

    return {
      decimals: Number(toBigIntStrict(row.decimals, 'trusted token decimals')),
      name: row.name ?? null,
      symbol: row.symbol ?? null,
      tokenAddress: row.token_address,
      verificationGate: 'stark_token_metadata',
      verificationLevel: row.is_verified ? 'metadata_verified' : 'metadata_resolved',
      verificationSource: row.is_verified ? 'stark_token_metadata_verified' : 'stark_token_metadata',
    };
  });
}

module.exports = {
  resolveTrustedToken,
};
