'use strict';

const { createTtlCache } = require('../lib/cache');
const { getStaticCoreToken, listStaticCoreTokens } = require('./constants/tokens');
const { knownErc20Cache } = require('./known-erc20-cache');
const { normalizeAddress } = require('./normalize');

const TOKEN_CACHE = createTtlCache({
  defaultTtlMs: 30_000,
  maxEntries: 20_000,
});

const STABLE_SYMBOLS = new Set(['USDC', 'USDT', 'DAI', 'CASH']);
const COINGECKO_ID_OVERRIDES = Object.freeze({
  '1inch': '1inch',
  aave: 'aave',
  aioz: 'aioz-network',
  ape: 'apecoin',
  arb: 'arbitrum',
  arkm: 'arkham',
  axs: 'axie-infinity',
  axl: 'axelar',
  beam: 'beam-2',
  bgb: 'bitget-token',
  bonk: 'bonk',
  btt: 'bittorrent',
  chz: 'chiliz',
  comp: 'compound-governance-token',
  cro: 'crypto-com-chain',
  dai: 'dai',
  dydx: 'dydx-chain',
  ens: 'ethereum-name-service',
  eth: 'ethereum',
  ezeth: 'renzo-restaked-eth',
  fdusd: 'first-digital-usd',
  fet: 'fetch-ai',
  frax: 'frax',
  frxeth: 'frax-ether',
  ftm: 'fantom',
  gno: 'gnosis',
  grt: 'the-graph',
  jasmy: 'jasmycoin',
  ldo: 'lido-dao',
  leo: 'leo-token',
  lpt: 'livepeer',
  mana: 'decentraland',
  meth: 'mantle-staked-ether',
  mnt: 'mantle',
  okb: 'okb',
  om: 'mantra-dao',
  ondo: 'ondo-finance',
  people: 'constitutiondao',
  pol: 'polygon-ecosystem-token',
  qnt: 'quant-network',
  reth: 'rocket-pool-eth',
  rndr: 'render-token',
  rseth: 'kelp-dao-restaked-eth',
  safe: 'safe',
  sand: 'the-sandbox',
  sfrxeth: 'staked-frax-ether',
  snx: 'havven',
  strk: 'starknet',
  tbtc: 'tbtc',
  toncoin: 'the-open-network',
  uni: 'uniswap',
  usdc: 'usd-coin',
  usde: 'ethena-usde',
  usdt: 'tether',
  wbtc: 'wrapped-bitcoin',
  weth: 'weth',
  wld: 'worldcoin-wld',
  wsteth: 'wrapped-steth',
  xaut: 'tether-gold',
});

function buildKnownTokenSeeds() {
  const seedsByAddress = new Map();

  for (const token of listStaticCoreTokens()) {
    seedsByAddress.set(token.address, {
      address: token.address,
      coingeckoId: resolveCoingeckoId(token),
      decimals: Number(token.decimals),
      isStable: Boolean(token.isStable),
      isVerified: true,
      logoUrl: resolveLogoUrl(token),
      metadata: {
        is_legacy: Boolean(token.isLegacy),
        static_core_registry: true,
        verification_source: token.verificationSource,
      },
      name: token.name ?? null,
      symbol: token.symbol ?? null,
      tokenType: 'ERC20',
      verificationSource: token.verificationSource,
    });
  }

  for (const token of knownErc20Cache.getAllTokens()) {
    const address = normalizeAddress(token.l2TokenAddress, 'known token registry address');
    const existing = seedsByAddress.get(address) ?? null;
    const next = {
      address,
      coingeckoId: resolveCoingeckoId(token),
      decimals: token.decimals === undefined || token.decimals === null ? null : Number(token.decimals),
      isStable: isStableSymbol(token.symbol),
      isVerified: true,
      logoUrl: resolveLogoUrl(token),
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
    };

    seedsByAddress.set(address, existing ? {
      address,
      coingeckoId: existing.coingeckoId ?? next.coingeckoId ?? null,
      decimals: existing.decimals ?? next.decimals,
      isStable: Boolean(existing.isStable || next.isStable),
      isVerified: Boolean(existing.isVerified || next.isVerified),
      logoUrl: existing.logoUrl ?? next.logoUrl ?? null,
      metadata: {
        ...(next.metadata ?? {}),
        ...(existing.metadata ?? {}),
      },
      name: existing.name ?? next.name ?? null,
      symbol: existing.symbol ?? next.symbol ?? null,
      tokenType: existing.tokenType ?? next.tokenType ?? 'ERC20',
      verificationSource: existing.verificationSource ?? next.verificationSource ?? null,
      verifiedAtBlock: existing.verifiedAtBlock ?? next.verifiedAtBlock ?? null,
    } : next);
  }

  return Array.from(seedsByAddress.values()).map((token) => ({
    address: token.address,
    coingeckoId: token.coingeckoId ?? null,
    decimals: token.decimals,
    isStable: token.isStable,
    isVerified: token.isVerified,
    logoUrl: token.logoUrl ?? null,
    metadata: token.metadata,
    name: token.name,
    symbol: token.symbol,
    tokenType: token.tokenType ?? 'ERC20',
    verificationSource: token.verificationSource ?? null,
    verifiedAtBlock: token.verifiedAtBlock ?? null,
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

  await backfillTokenDeploymentInfo(client);

  return upserted;
}

async function syncTokenRegistryFromMetadata(client, metadata) {
  if (!client || typeof client.query !== 'function' || !metadata?.tokenAddress) {
    return;
  }

  await upsertTokenRegistryRow(client, {
    address: metadata.tokenAddress,
    coingeckoId: metadata.coingeckoId
      ?? metadata.coingecko_id
      ?? metadata.registryMetadata?.coingecko_id
      ?? metadata.metadata?.coingecko_id
      ?? resolveCoingeckoId(knownErc20Cache.getToken(metadata.tokenAddress))
      ?? null,
    decimals: metadata.decimals === null || metadata.decimals === undefined ? null : Number(metadata.decimals),
    deployTxHash: metadata.deployTxHash
      ?? metadata.deploy_tx_hash
      ?? metadata.registryMetadata?.deploy_tx_hash
      ?? metadata.metadata?.deploy_tx_hash
      ?? null,
    deployedAt: metadata.deployedAt
      ?? metadata.deployed_at
      ?? metadata.registryMetadata?.deployed_at
      ?? metadata.metadata?.deployed_at
      ?? null,
    isStable: metadata.isStable ?? isStableSymbol(metadata.symbol),
    isVerified: Boolean(metadata.isVerified),
    logoUrl: metadata.logoUrl
      ?? metadata.logo_url
      ?? metadata.registryMetadata?.logo_url
      ?? metadata.metadata?.logo_url
      ?? resolveLogoUrl(knownErc20Cache.getToken(metadata.tokenAddress))
      ?? null,
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
    const staticCoreToken = getStaticCoreToken(address);
    if (staticCoreToken) {
      registryByAddress.set(address, normalizeRegistryRow({
        address,
        decimals: staticCoreToken.decimals,
        is_stable: staticCoreToken.isStable,
        is_verified: true,
        metadata: {
          is_legacy: Boolean(staticCoreToken.isLegacy),
          source: 'static_core_registry',
        },
        name: staticCoreToken.name ?? null,
        symbol: staticCoreToken.symbol ?? null,
        token_type: 'ERC20',
        verification_source: staticCoreToken.verificationSource,
      }));
    }

    const knownToken = knownErc20Cache.getToken(address);
    if (knownToken) {
      registryByAddress.set(address, mergeRegistryRow(
        registryByAddress.get(address) ?? null,
        normalizeRegistryRow({
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
          verification_source: knownToken.verificationSource ?? 'known_erc20_cache',
        }),
      ));
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
              coingecko_id,
              logo_url,
              deploy_tx_hash,
              deployed_at,
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
         coingecko_id,
         logo_url,
         deploy_tx_hash,
         deployed_at,
         metadata,
         created_at,
         updated_at
     ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, NOW(), NOW()
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
         coingecko_id = COALESCE(EXCLUDED.coingecko_id, tokens.coingecko_id),
         logo_url = COALESCE(EXCLUDED.logo_url, tokens.logo_url),
         deploy_tx_hash = COALESCE(EXCLUDED.deploy_tx_hash, tokens.deploy_tx_hash),
         deployed_at = COALESCE(EXCLUDED.deployed_at, tokens.deployed_at),
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
      sanitizeText(token.coingeckoId ?? token.coingecko_id ?? null),
      sanitizeText(token.logoUrl ?? token.logo_url ?? null),
      sanitizeText(token.deployTxHash ?? token.deploy_tx_hash ?? null),
      normalizeTimestampValue(token.deployedAt ?? token.deployed_at ?? null),
      JSON.stringify(token.metadata ?? {}),
    ],
  );
  TOKEN_CACHE.clear();
}

async function backfillTokenDeploymentInfo(client) {
  const result = await client.query(
    `WITH deployed AS (
         SELECT DISTINCT ON (deployment.address)
                deployment.address,
                to_timestamp(journal.block_timestamp::double precision) AS deployed_at
           FROM stark_block_state_updates AS state
           JOIN stark_block_journal AS journal
             ON journal.lane = state.lane
            AND journal.block_number = state.block_number
            AND journal.block_hash = state.block_hash
            AND journal.is_orphaned = FALSE
          CROSS JOIN LATERAL (
                SELECT deploy_item ->> 'address' AS address
                  FROM jsonb_array_elements(state.deployed_contracts) AS deploy_item
                 WHERE deploy_item ->> 'address' IS NOT NULL
          ) AS deployment
          WHERE journal.block_timestamp IS NOT NULL
          ORDER BY deployment.address, state.block_number ASC
     ),
     deploy_txs AS (
         SELECT DISTINCT ON (contract_address)
                contract_address AS address,
                transaction_hash
           FROM stark_tx_raw
          WHERE contract_address IS NOT NULL
            AND tx_type IN ('DEPLOY', 'DEPLOY_ACCOUNT')
          ORDER BY contract_address, block_number ASC, transaction_index ASC
     )
     UPDATE tokens AS token
        SET deployed_at = COALESCE(token.deployed_at, deployed.deployed_at),
            deploy_tx_hash = COALESCE(token.deploy_tx_hash, deploy_txs.transaction_hash),
            metadata = COALESCE(token.metadata, '{}'::jsonb) || jsonb_build_object(
              'deployment_backfill_source',
              'indexed_state_update'
            ),
            updated_at = NOW()
       FROM deployed
       LEFT JOIN deploy_txs
              ON deploy_txs.address = deployed.address
      WHERE token.address = deployed.address
        AND (
             token.deployed_at IS NULL
          OR (token.deploy_tx_hash IS NULL AND deploy_txs.transaction_hash IS NOT NULL)
        )`,
  );

  if (result.rowCount > 0) {
    TOKEN_CACHE.clear();
  }

  return result.rowCount;
}

function normalizeRegistryRow(row) {
  return {
    address: normalizeAddress(row.address, 'token registry row address'),
    coingeckoId: row.coingecko_id ?? null,
    decimals: row.decimals === null || row.decimals === undefined ? null : Number(row.decimals),
    deployedAt: row.deployed_at ?? null,
    deployTxHash: row.deploy_tx_hash ?? null,
    hasMetadata: Boolean(row.symbol || row.name || row.decimals !== null),
    isStable: Boolean(row.is_stable ?? false),
    isVerified: Boolean(row.is_verified ?? false),
    logoUrl: row.logo_url ?? null,
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
    coingeckoId: next.coingeckoId ?? existing.coingeckoId ?? null,
    decimals: next.decimals === null || next.decimals === undefined ? existing.decimals : next.decimals,
    deployedAt: next.deployedAt ?? existing.deployedAt ?? null,
    deployTxHash: next.deployTxHash ?? existing.deployTxHash ?? null,
    hasMetadata: Boolean(existing.hasMetadata || next.hasMetadata),
    isStable: Boolean(existing.isStable || next.isStable || isStableSymbol(next.symbol) || isStableSymbol(existing.symbol)),
    isVerified: Boolean(existing.isVerified || next.isVerified),
    logoUrl: next.logoUrl ?? existing.logoUrl ?? null,
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

function resolveCoingeckoId(token) {
  const rawId = sanitizeText(token?.coingeckoId ?? token?.coingecko_id ?? token?.id ?? token?.key ?? null);
  const symbol = sanitizeText(token?.symbol ?? token?.key ?? null)?.toLowerCase() ?? null;
  const lookupKey = rawId?.toLowerCase() ?? symbol;

  if (!lookupKey) {
    return null;
  }

  return COINGECKO_ID_OVERRIDES[lookupKey] ?? rawId;
}

function resolveLogoUrl(token) {
  const explicit = sanitizeText(token?.logoUrl ?? token?.logo_url ?? null);
  if (explicit) {
    return explicit;
  }

  const symbol = sanitizeText(token?.symbol ?? token?.key ?? null)?.toUpperCase() ?? null;
  if (symbol === 'ETH') {
    return 'https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/info/logo.png';
  }

  const l1TokenAddress = normalizeEthereumAddressCandidate(token?.l1TokenAddress ?? token?.l1_token_address ?? null);
  if (!l1TokenAddress) {
    return null;
  }

  return `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/${l1TokenAddress}/logo.png`;
}

function normalizeEthereumAddressCandidate(value) {
  const text = sanitizeText(value);
  if (!text) {
    return null;
  }

  if (/^0x[0-9a-fA-F]{40}$/.test(text)) {
    return text;
  }

  const zeroPaddedMatch = /^0x0{24}([0-9a-fA-F]{40})$/.exec(text);
  if (zeroPaddedMatch) {
    return `0x${zeroPaddedMatch[1]}`;
  }

  return null;
}

function sanitizeText(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const text = String(value).trim();
  return text || null;
}

function normalizeTimestampValue(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

module.exports = {
  KNOWN_TOKEN_SEEDS,
  backfillTokenDeploymentInfo,
  getTokenRegistryInfo,
  isStableTokenInfo,
  isStableSymbol,
  loadTokenRegistryByAddress,
  markTokenRegistryForReverification,
  seedKnownTokens,
  syncTokenRegistryFromMetadata,
};
