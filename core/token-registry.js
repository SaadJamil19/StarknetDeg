'use strict';

const { createTtlCache } = require('../lib/cache');
const { knownErc20Cache } = require('./known-erc20-cache');
const { normalizeAddress } = require('./normalize');

const TOKEN_CACHE = createTtlCache({
  defaultTtlMs: 30_000,
  maxEntries: 20_000,
});

const STABLE_SYMBOLS = new Set(['USDC', 'USDT', 'DAI', 'CASH']);

function buildKnownTokenSeeds() {
  return knownErc20Cache.getAllTokens().map((token) => ({
    address: normalizeAddress(token.l2TokenAddress, 'known token registry address'),
    decimals: token.decimals === undefined || token.decimals === null ? null : Number(token.decimals),
    isStable: isStableSymbol(token.symbol),
    isVerified: true,
    metadata: {
      comment: token.comment ?? null,
      l1_bridge_address: token.l1BridgeAddress ?? null,
      l1_token_address: token.l1TokenAddress ?? null,
      verification_source: token.verificationSource ?? 'known_erc20_cache',
    },
    name: token.name ?? null,
    symbol: token.symbol ?? null,
    tokenType: 'ERC20',
    verificationSource: token.verificationSource ?? 'known_erc20_cache',
  }));
}

const KNOWN_TOKEN_SEEDS = Object.freeze(buildKnownTokenSeeds());
const KNOWN_SEED_ADDRESS_SET = new Set(KNOWN_TOKEN_SEEDS.map((token) => token.address));

async function seedKnownTokens(client) {
  if (!client || typeof client.query !== 'function') {
    return 0;
  }

  let upserted = 0;
  for (const token of KNOWN_TOKEN_SEEDS) {
    await upsertTokenRegistryRow(client, token);
    upserted += 1;
  }

  return upserted;
}

async function syncTokenRegistryFromMetadata(client, metadata) {
  if (!client || typeof client.query !== 'function' || !metadata?.tokenAddress) {
    return;
  }

  await upsertTokenRegistryRow(client, {
    address: metadata.tokenAddress,
    decimals: metadata.decimals === null || metadata.decimals === undefined ? null : Number(metadata.decimals),
    isStable: metadata.isStable ?? isStableSymbol(metadata.symbol),
    isVerified: Boolean(metadata.isVerified),
    metadata: {
      source: metadata.source ?? 'stark_token_metadata',
      stark_token_metadata: metadata.registryMetadata ?? metadata.metadata ?? {},
    },
    name: metadata.name ?? null,
    symbol: metadata.symbol ?? null,
    tokenType: metadata.tokenType ?? 'ERC20',
    verificationSource: metadata.source ?? 'stark_token_metadata',
    verifiedAtBlock: metadata.verifiedAtBlock
      ?? metadata.latestSourceBlockNumber
      ?? metadata.refreshedAtBlock
      ?? metadata.lastRefreshedBlock
      ?? null,
  });
}

async function markTokenRegistryForReverification(client, { fromBlockNumber }) {
  if (!client || typeof client.query !== 'function' || fromBlockNumber === null || fromBlockNumber === undefined) {
    return {
      tokenMetadataDeleted: 0,
      tokenRowsDeleted: 0,
      tokenSeedsReset: 0,
    };
  }

  const numericBlock = fromBlockNumber.toString(10);
  const seedAddresses = Array.from(KNOWN_SEED_ADDRESS_SET);

  const deletedMetadata = await client.query(
    `DELETE FROM stark_token_metadata
      WHERE last_refreshed_block IS NOT NULL
        AND last_refreshed_block >= $1`,
    [numericBlock],
  );

  const resetSeeds = await client.query(
    `UPDATE tokens
        SET verified_at_block = NULL,
            verification_source = COALESCE(verification_source, 'known_erc20_cache'),
            metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
              'reorg_reset',
              jsonb_build_object(
                'from_block', $1::text,
                'kind', 'seed_row_retained'
              )
            ),
            updated_at = NOW()
      WHERE address = ANY($2::text[])
        AND verified_at_block IS NOT NULL
        AND verified_at_block >= $1`,
    [numericBlock, seedAddresses],
  );

  const deletedTokens = await client.query(
    `DELETE FROM tokens
      WHERE address <> ALL($2::text[])
        AND verified_at_block IS NOT NULL
        AND verified_at_block >= $1`,
    [numericBlock, seedAddresses],
  );

  TOKEN_CACHE.clear();

  return {
    tokenMetadataDeleted: deletedMetadata.rowCount,
    tokenRowsDeleted: deletedTokens.rowCount,
    tokenSeedsReset: resetSeeds.rowCount,
  };
}

async function loadTokenRegistryByAddress(client, tokenAddresses) {
  const normalizedAddresses = Array.from(new Set((tokenAddresses ?? [])
    .filter(Boolean)
    .map((value) => normalizeAddress(value, 'token registry lookup address'))));
  const registryByAddress = new Map();

  for (const address of normalizedAddresses) {
    const knownToken = knownErc20Cache.getToken(address);
    if (knownToken) {
      registryByAddress.set(address, normalizeRegistryRow({
        address,
        decimals: knownToken.decimals ?? null,
        is_stable: isStableSymbol(knownToken.symbol),
        is_verified: true,
        metadata: {
          comment: knownToken.comment ?? null,
          source: 'known_erc20_cache',
          verification_source: knownToken.verificationSource ?? 'known_erc20_cache',
        },
        name: knownToken.name ?? null,
        symbol: knownToken.symbol ?? null,
        token_type: 'ERC20',
      }));
    }
  }

  if (!client || typeof client.query !== 'function' || normalizedAddresses.length === 0) {
    return registryByAddress;
  }

  const cacheKey = normalizedAddresses.join(',');
  const databaseRows = await TOKEN_CACHE.getOrLoad(cacheKey, async () => {
    const result = await client.query(
      `SELECT address,
              symbol,
              name,
              decimals,
              token_type,
              is_stable,
              is_verified,
              verified_at_block,
              verification_source,
              metadata
         FROM tokens
        WHERE address = ANY($1::text[])`,
      [normalizedAddresses],
    );

    return result.rows;
  });

  for (const row of databaseRows) {
    registryByAddress.set(row.address, mergeRegistryRow(
      registryByAddress.get(row.address) ?? null,
      normalizeRegistryRow(row),
    ));
  }

  const missingFromTokens = normalizedAddresses.filter((address) => !registryByAddress.has(address) || !registryByAddress.get(address).hasMetadata);
  if (missingFromTokens.length === 0) {
    return registryByAddress;
  }

  const metadataRows = await client.query(
    `SELECT token_address,
            name,
            symbol,
            decimals,
            is_verified,
            metadata
       FROM stark_token_metadata
      WHERE token_address = ANY($1::text[])`,
    [missingFromTokens],
  );

  for (const row of metadataRows.rows) {
    const normalizedAddress = normalizeAddress(row.token_address, 'token metadata address');
    registryByAddress.set(normalizedAddress, mergeRegistryRow(
      registryByAddress.get(normalizedAddress) ?? null,
      normalizeRegistryRow({
        address: normalizedAddress,
        decimals: row.decimals === null ? null : Number.parseInt(String(row.decimals), 10),
        is_stable: isStableSymbol(row.symbol),
        is_verified: row.is_verified,
        metadata: {
          source: 'stark_token_metadata',
          stark_token_metadata: row.metadata ?? {},
        },
        name: row.name ?? null,
        symbol: row.symbol ?? null,
        token_type: 'ERC20',
      }),
    ));
  }

  return registryByAddress;
}

function getTokenRegistryInfo(tokenAddress, registryByAddress) {
  const normalizedAddress = normalizeAddress(tokenAddress, 'token registry info address');
  return registryByAddress?.get(normalizedAddress) ?? null;
}

function isStableTokenInfo(tokenInfo) {
  if (!tokenInfo) {
    return false;
  }

  if (tokenInfo.isStable === true) {
    return true;
  }

  return isStableSymbol(tokenInfo.symbol);
}

function isStableSymbol(symbol) {
  if (symbol === undefined || symbol === null) {
    return false;
  }

  return STABLE_SYMBOLS.has(String(symbol).trim().toUpperCase());
}

async function upsertTokenRegistryRow(client, token) {
  const normalizedAddress = normalizeAddress(token.address, 'token registry upsert address');
  await client.query(
    `INSERT INTO tokens (
         address,
         symbol,
         name,
         decimals,
         token_type,
         is_stable,
         is_verified,
         verified_at_block,
         verification_source,
         metadata,
         created_at,
         updated_at
     ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, NOW(), NOW()
     )
     ON CONFLICT (address)
     DO UPDATE SET
         symbol = COALESCE(EXCLUDED.symbol, tokens.symbol),
         name = COALESCE(EXCLUDED.name, tokens.name),
         decimals = COALESCE(EXCLUDED.decimals, tokens.decimals),
         token_type = COALESCE(EXCLUDED.token_type, tokens.token_type),
         is_stable = EXCLUDED.is_stable OR tokens.is_stable,
         is_verified = EXCLUDED.is_verified OR tokens.is_verified,
         verified_at_block = CASE
           WHEN EXCLUDED.verified_at_block IS NULL THEN tokens.verified_at_block
           ELSE EXCLUDED.verified_at_block
         END,
         verification_source = COALESCE(EXCLUDED.verification_source, tokens.verification_source),
         metadata = COALESCE(EXCLUDED.metadata, tokens.metadata),
         updated_at = NOW()`,
     [
      normalizedAddress,
      token.symbol ?? null,
      token.name ?? null,
      token.decimals === undefined || token.decimals === null ? null : Number(token.decimals),
      token.tokenType ?? 'ERC20',
      Boolean(token.isStable ?? isStableSymbol(token.symbol)),
      Boolean(token.isVerified),
      token.verifiedAtBlock === undefined || token.verifiedAtBlock === null ? null : token.verifiedAtBlock.toString(10),
      token.verificationSource ?? null,
      JSON.stringify(token.metadata ?? {}),
    ],
  );
  TOKEN_CACHE.clear();
}

function normalizeRegistryRow(row) {
  return {
    address: normalizeAddress(row.address, 'token registry row address'),
    decimals: row.decimals === null || row.decimals === undefined ? null : Number(row.decimals),
    hasMetadata: Boolean(row.symbol || row.name || row.decimals !== null),
    isStable: Boolean(row.is_stable ?? false),
    isVerified: Boolean(row.is_verified ?? false),
    metadata: row.metadata ?? {},
    name: row.name ?? null,
    symbol: row.symbol ?? null,
    tokenType: row.token_type ?? 'ERC20',
    verificationSource: row.verification_source ?? null,
    verifiedAtBlock: row.verified_at_block === null || row.verified_at_block === undefined
      ? null
      : BigInt(row.verified_at_block),
  };
}

function mergeRegistryRow(existing, next) {
  if (!existing) {
    return next;
  }

  return {
    address: next.address ?? existing.address,
    decimals: next.decimals === null || next.decimals === undefined ? existing.decimals : next.decimals,
    hasMetadata: Boolean(existing.hasMetadata || next.hasMetadata),
    isStable: Boolean(existing.isStable || next.isStable || isStableSymbol(next.symbol) || isStableSymbol(existing.symbol)),
    isVerified: Boolean(existing.isVerified || next.isVerified),
    metadata: {
      ...(existing.metadata ?? {}),
      ...(next.metadata ?? {}),
    },
    name: next.name ?? existing.name,
    symbol: next.symbol ?? existing.symbol,
    tokenType: next.tokenType ?? existing.tokenType,
    verificationSource: next.verificationSource ?? existing.verificationSource ?? null,
    verifiedAtBlock: next.verifiedAtBlock ?? existing.verifiedAtBlock ?? null,
  };
}

module.exports = {
  KNOWN_TOKEN_SEEDS,
  getTokenRegistryInfo,
  isStableTokenInfo,
  isStableSymbol,
  loadTokenRegistryByAddress,
  markTokenRegistryForReverification,
  seedKnownTokens,
  syncTokenRegistryFromMetadata,
};
