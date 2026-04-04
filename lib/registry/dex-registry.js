'use strict';

const { selector } = require('starknet');
const { normalizeAddress, normalizeHex, normalizeSelector } = require('../../core/normalize');

const SELECTORS = Object.freeze({
  AVNU_OPTIMIZED_SWAP: normalizeSelector(selector.getSelectorFromName('OptimizedSwap')),
  AVNU_SPONSORED_TRANSACTION: normalizeSelector(selector.getSelectorFromName('SponsoredTransaction')),
  CREATE_MARKET: normalizeSelector(selector.getSelectorFromName('CreateMarket')),
  CREATE_ORDER: normalizeSelector(selector.getSelectorFromName('CreateOrder')),
  ERC20_TRANSFER: normalizeSelector(selector.getSelectorFromName('Transfer')),
  EKUBO_FEES_ACCUMULATED: normalizeSelector(selector.getSelectorFromName('FeesAccumulated')),
  EKUBO_LOADED_BALANCE: normalizeSelector(selector.getSelectorFromName('LoadedBalance')),
  EKUBO_POOL_INITIALIZED: normalizeSelector(selector.getSelectorFromName('PoolInitialized')),
  EKUBO_POSITION_FEES_COLLECTED: normalizeSelector(selector.getSelectorFromName('PositionFeesCollected')),
  EKUBO_POSITION_UPDATED: normalizeSelector(selector.getSelectorFromName('PositionUpdated')),
  EKUBO_SAVED_BALANCE: normalizeSelector(selector.getSelectorFromName('SavedBalance')),
  EKUBO_SWAPPED: normalizeSelector(selector.getSelectorFromName('Swapped')),
  MODIFY_POSITION: normalizeSelector(selector.getSelectorFromName('ModifyPosition')),
  MULTI_SWAP: normalizeSelector(selector.getSelectorFromName('MultiSwap')),
  BURN: normalizeSelector(selector.getSelectorFromName('Burn')),
  COLLECT_ORDER: normalizeSelector(selector.getSelectorFromName('CollectOrder')),
  MINT: normalizeSelector(selector.getSelectorFromName('Mint')),
  PAIR_CREATED: normalizeSelector(selector.getSelectorFromName('PairCreated')),
  POOL_CREATED: normalizeSelector(selector.getSelectorFromName('PoolCreated')),
  SWAP: normalizeSelector(selector.getSelectorFromName('Swap')),
  SYNC: normalizeSelector(selector.getSelectorFromName('Sync')),
});

const SELECTOR_NAMES_BY_VALUE = new Map(Object.entries(SELECTORS).map(([name, value]) => [value, name]));
const STANDARD_DEX_SELECTOR_SET = new Set([
  SELECTORS.SWAP,
  SELECTORS.MINT,
  SELECTORS.BURN,
  SELECTORS.SYNC,
  SELECTORS.PAIR_CREATED,
  SELECTORS.POOL_CREATED,
  SELECTORS.MULTI_SWAP,
  SELECTORS.MODIFY_POSITION,
  SELECTORS.CREATE_ORDER,
  SELECTORS.COLLECT_ORDER,
  SELECTORS.CREATE_MARKET,
  SELECTORS.AVNU_OPTIMIZED_SWAP,
  SELECTORS.AVNU_SPONSORED_TRANSACTION,
]);

const DEFAULT_PROBE = Object.freeze({
  factoryEntrypoints: ['factory'],
  stableEntrypoints: ['stable'],
  token0Entrypoints: ['token0'],
  token1Entrypoints: ['token1'],
});

const DEX_CATALOG = Object.freeze([
  {
    key: 'ekubo',
    protocol: 'ekubo',
    displayName: 'Ekubo',
    decoder: 'ekubo',
    family: 'singleton_clmm',
    verificationStatus: 'verified',
    selectorHandlers: Object.freeze({
      [SELECTORS.EKUBO_SWAPPED]: 'swap',
      [SELECTORS.EKUBO_POSITION_UPDATED]: 'position_update',
      [SELECTORS.EKUBO_POOL_INITIALIZED]: 'pool_initialized',
      [SELECTORS.EKUBO_FEES_ACCUMULATED]: 'fees_accumulated',
      [SELECTORS.EKUBO_POSITION_FEES_COLLECTED]: 'position_fees_collected',
      [SELECTORS.EKUBO_SAVED_BALANCE]: 'saved_balance',
      [SELECTORS.EKUBO_LOADED_BALANCE]: 'loaded_balance',
    }),
    selectors: [
      SELECTORS.EKUBO_SWAPPED,
      SELECTORS.EKUBO_POSITION_UPDATED,
      SELECTORS.EKUBO_POOL_INITIALIZED,
      SELECTORS.EKUBO_FEES_ACCUMULATED,
      SELECTORS.EKUBO_POSITION_FEES_COLLECTED,
      SELECTORS.EKUBO_SAVED_BALANCE,
      SELECTORS.EKUBO_LOADED_BALANCE,
    ],
    roles: [
      {
        address: '0x00000005dd3d2f4429af886cd1a3b08289dbcea99a294197e9eb43b0e0325b4b',
        classHash: '0x0577604a2611c851e9cfc4da2ba7f7fc1d44a9327cc734d68b2b271340a6551c',
        role: 'core',
        abiVersion: 'core-mainnet-current',
      },
      { address: '0x0199741822c2dc722f6f605204f35e56dbc23bceed54818168c4c49e4fb8737e', role: 'router' },
      { address: '0x04505a9f06f2bd639b6601f37a4dc0908bb70e8e0e0c34b1220827d64f4fc066', role: 'router' },
      { address: '0x03266fe47923e1500aec0fa973df8093b5850bbce8dcd0666d3f47298b4b806e', role: 'router' },
      { address: '0x010c7eb57cbfeb18bde525912c1b6e9a7ebb4f692e0576af1ba7be8b3b9a70f6', role: 'router' },
      { address: '0x01b6f560def289b32e2a7b0920909615531a4d9d5636ca509045843559dc23d5', role: 'router_legacy' },
    ],
    sourceUrls: [
      'file://StarkNet_DEX_Indexer_Reference.docx',
      'https://docs.ekubo.org/integration-guides/reference/starknet-contracts',
    ],
  },
  {
    key: 'avnu',
    protocol: 'avnu',
    displayName: 'AVNU',
    decoder: 'avnu',
    family: 'aggregator',
    verificationStatus: 'verified',
    selectorHandlers: Object.freeze({
      [SELECTORS.SWAP]: 'swap',
      [SELECTORS.AVNU_OPTIMIZED_SWAP]: 'route_optimization',
      [SELECTORS.AVNU_SPONSORED_TRANSACTION]: 'sponsored_transaction',
    }),
    selectors: [SELECTORS.SWAP, SELECTORS.AVNU_OPTIMIZED_SWAP],
    roles: [
      {
        address: '0x04270219d365d6b017231b52e92b3fb5d7c8378b05e9abc97724537a80e93b0f',
        role: 'exchange',
      },
      {
        address: '0x0127021a1b5a52d3174c2ab077c2b043c80369250d29428cee956d76ee51584f',
        role: 'forwarder',
      },
    ],
    sourceUrls: [
      'file://StarkNet_DEX_Indexer_Reference.docx',
      'https://github.com/avnu-labs/avnu-contracts-v2',
    ],
  },
  {
    key: 'jediswap_v2',
    protocol: 'jediswap_v2',
    displayName: 'JediSwap V2',
    decoder: 'base-amm',
    family: 'clmm',
    verificationStatus: 'verified',
    selectorHandlers: Object.freeze({
      [SELECTORS.SWAP]: 'swap',
      [SELECTORS.MINT]: 'mint',
      [SELECTORS.BURN]: 'burn',
      [SELECTORS.POOL_CREATED]: 'pool_created',
    }),
    selectors: [SELECTORS.SWAP, SELECTORS.MINT, SELECTORS.BURN, SELECTORS.POOL_CREATED],
    roles: [
      {
        address: '0x01aa950c9b974294787de8df8880ecf668840a6ab8fa8290bf2952212b375148',
        role: 'factory',
      },
      {
        address: '0x0359550b990167afd6635fa574f3bdadd83cb51850e1d00061fe693158c23f80',
        role: 'router',
      },
      {
        classHash: '0x2cd3c16a0112b22ded4903707f268125fcf46fd7733761e62c13fc0157afd8d',
        role: 'pool',
      },
    ],
    metadata: {
      ammVariant: 'clmm',
      poolModel: 'clmm',
    },
    sourceUrls: [
      'file://StarkNet_DEX_Indexer_Reference.docx',
    ],
  },
  {
    key: 'jediswap_v1',
    protocol: 'jediswap_v1',
    displayName: 'JediSwap V1',
    decoder: 'base-amm',
    family: 'xyk',
    verificationStatus: 'verified',
    selectorHandlers: Object.freeze({
      [SELECTORS.SWAP]: 'swap',
      [SELECTORS.MINT]: 'mint',
      [SELECTORS.BURN]: 'burn',
      [SELECTORS.SYNC]: 'sync',
      [SELECTORS.PAIR_CREATED]: 'pair_created',
    }),
    selectors: [SELECTORS.SWAP, SELECTORS.MINT, SELECTORS.BURN, SELECTORS.SYNC, SELECTORS.PAIR_CREATED],
    roles: [
      {
        address: '0x00dad44c139a476c7a17fc8141e6db680e9abc9f56fe249a105094c44382c2fd',
        role: 'factory',
      },
      {
        address: '0x041fd22b238fa21cfcf5dd45a8548974d8263b3a531a60388411c5e230f97023',
        role: 'router',
      },
    ],
    metadata: {
      ammVariant: 'xyk',
      poolModel: 'xyk',
      probe: DEFAULT_PROBE,
    },
    sourceUrls: [
      'file://StarkNet_DEX_Indexer_Reference.docx',
    ],
  },
  {
    key: '10kswap',
    protocol: '10kswap',
    displayName: '10KSwap',
    decoder: 'base-amm',
    family: 'xyk',
    verificationStatus: 'verified',
    selectorHandlers: Object.freeze({
      [SELECTORS.SWAP]: 'swap',
      [SELECTORS.MINT]: 'mint',
      [SELECTORS.BURN]: 'burn',
      [SELECTORS.SYNC]: 'sync',
      [SELECTORS.PAIR_CREATED]: 'pair_created',
    }),
    selectors: [SELECTORS.SWAP, SELECTORS.MINT, SELECTORS.BURN, SELECTORS.SYNC, SELECTORS.PAIR_CREATED],
    roles: [
      {
        address: '0x01c0a36e26a8f822e0d81f20a5a562b16a8f8a3dfd99801367dd2aea8f1a87a2',
        role: 'factory',
      },
      {
        address: '0x07a6f98c03379b9513ca84cca1373ff452a7462a3b61598f0af5bb27ad7f76d1',
        role: 'router',
      },
      {
        classHash: '0x231adde42526bad434ca2eb983efdd64472638702f87f97e6e3c084f264e06f',
        role: 'pair',
      },
    ],
    metadata: {
      ammVariant: 'xyk',
      poolModel: 'xyk',
      probe: DEFAULT_PROBE,
    },
    sourceUrls: [
      'file://StarkNet_DEX_Indexer_Reference.docx',
    ],
  },
  {
    key: 'myswap_v1',
    protocol: 'myswap_v1',
    displayName: 'mySwap V1',
    decoder: 'myswap',
    family: 'fixed_pool',
    verificationStatus: 'verified',
    selectorHandlers: Object.freeze({
      [SELECTORS.SWAP]: 'swap',
    }),
    selectors: [SELECTORS.SWAP],
    roles: [
      {
        address: '0x010884171baf1914edc28d7afb619b40a4051cfae78a094a55d230f19e944a28',
        role: 'amm',
      },
    ],
    metadata: {
      poolModel: 'fixed_pool',
    },
    sourceUrls: [
      'file://StarkNet_DEX_Indexer_Reference.docx',
    ],
  },
  {
    key: 'sithswap',
    protocol: 'sithswap',
    displayName: 'SithSwap',
    decoder: 'base-amm',
    family: 'solidly',
    verificationStatus: 'verified',
    selectorHandlers: Object.freeze({
      [SELECTORS.SWAP]: 'swap',
      [SELECTORS.MINT]: 'mint',
      [SELECTORS.BURN]: 'burn',
      [SELECTORS.SYNC]: 'sync',
      [SELECTORS.PAIR_CREATED]: 'pair_created',
    }),
    selectors: [SELECTORS.SWAP, SELECTORS.MINT, SELECTORS.BURN, SELECTORS.SYNC, SELECTORS.PAIR_CREATED],
    roles: [
      {
        address: '0x041ccddcd56c5a5e1fd9fd8c0bee0c4f1afbe2438d5d29ddeb7a2c39be27c6c3',
        role: 'factory',
      },
      {
        address: '0x0684df1609dd0b82e28a4b1588de93c0e0a73e6af2c33e7f8bfcb3a6b56a768',
        role: 'router',
      },
    ],
    metadata: {
      ammVariant: 'solidly',
      poolModel: 'solidly',
      probe: DEFAULT_PROBE,
    },
    sourceUrls: [
      'file://StarkNet_DEX_Indexer_Reference.docx',
    ],
  },
  {
    key: 'haiko',
    protocol: 'haiko',
    displayName: 'Haiko',
    decoder: 'haiko',
    family: 'market_manager',
    verificationStatus: 'verified',
    selectorHandlers: Object.freeze({
      [SELECTORS.SWAP]: 'swap',
      [SELECTORS.MULTI_SWAP]: 'multiswap',
      [SELECTORS.MODIFY_POSITION]: 'position_update',
      [SELECTORS.CREATE_ORDER]: 'order_create',
      [SELECTORS.COLLECT_ORDER]: 'order_collect',
      [SELECTORS.CREATE_MARKET]: 'market_create',
    }),
    selectors: [
      SELECTORS.SWAP,
      SELECTORS.MULTI_SWAP,
      SELECTORS.MODIFY_POSITION,
      SELECTORS.CREATE_ORDER,
      SELECTORS.COLLECT_ORDER,
      SELECTORS.CREATE_MARKET,
    ],
    roles: [
      {
        address: '0x038925b0bcf4dce081042ca26a96300d9e181b910328db54a6c89e5451503f5',
        role: 'market_manager',
      },
    ],
    metadata: {
      poolModel: 'haiko',
    },
    sourceUrls: [
      'https://haiko-docs.gitbook.io/docs/developers/events/marketmanager-amm.md',
    ],
  },
  {
    key: 'ammos',
    protocol: 'ammos',
    displayName: 'Ammos',
    decoder: null,
    family: 'unknown',
    verificationStatus: 'catalog_only',
    selectorHandlers: Object.freeze({
      [SELECTORS.SWAP]: 'swap',
      [SELECTORS.MINT]: 'mint',
      [SELECTORS.BURN]: 'burn',
      [SELECTORS.SYNC]: 'sync',
    }),
    selectors: [SELECTORS.SWAP, SELECTORS.MINT, SELECTORS.BURN, SELECTORS.SYNC],
    roles: [],
    notes: 'Catalog placeholder only. No verified Starknet mainnet address/class hash was found in the provided reference doc or the official sources reviewed during this pass.',
  },
  {
    key: 'myswap_v2',
    protocol: 'myswap_v2',
    displayName: 'mySwap V2',
    decoder: null,
    family: 'unknown',
    verificationStatus: 'catalog_only',
    selectorHandlers: Object.freeze({
      [SELECTORS.SWAP]: 'swap',
      [SELECTORS.MINT]: 'mint',
      [SELECTORS.BURN]: 'burn',
      [SELECTORS.SYNC]: 'sync',
    }),
    selectors: [SELECTORS.SWAP, SELECTORS.MINT, SELECTORS.BURN, SELECTORS.SYNC],
    roles: [],
    notes: 'Catalog placeholder only. The provided reference doc covers mySwap V1, but not a separately verified mySwap V2 Starknet mainnet deployment.',
  },
  {
    key: 'nostra',
    protocol: 'nostra',
    displayName: 'Nostra',
    decoder: null,
    family: 'aggregator_alias',
    verificationStatus: 'catalog_only',
    selectorHandlers: Object.freeze({
      [SELECTORS.SWAP]: 'swap',
    }),
    selectors: [SELECTORS.SWAP],
    roles: [],
    notes: 'Catalog placeholder only. Current official public materials point to Nostra Swap routing through external liquidity/aggregators rather than a separately verified swap-emitting Starknet mainnet core contract for this indexer pass.',
    sourceUrls: [
      'https://nostra.finance/disclaimer',
    ],
  },
  {
    key: 'starkdefi',
    protocol: 'starkdefi',
    displayName: 'StarkDeFi',
    decoder: null,
    family: 'unknown',
    verificationStatus: 'catalog_only',
    selectorHandlers: Object.freeze({
      [SELECTORS.SWAP]: 'swap',
      [SELECTORS.MINT]: 'mint',
      [SELECTORS.BURN]: 'burn',
      [SELECTORS.SYNC]: 'sync',
    }),
    selectors: [SELECTORS.SWAP, SELECTORS.MINT, SELECTORS.BURN, SELECTORS.SYNC],
    roles: [],
    notes: 'Catalog placeholder only. StarkDeFi official docs expose the product area but the current core-contract pages do not publish verified mainnet contract addresses.',
    sourceUrls: [
      'https://docs.starkdefi.com/core-contracts/swap/router',
    ],
  },
]);

const MATCHABLE_ENTRIES = Object.freeze(buildMatchableEntries(DEX_CATALOG));
const SYNCABLE_ENTRIES = Object.freeze(MATCHABLE_ENTRIES.filter((entry) => entry.contractAddress));
const STATIC_ADDRESS_INDEX = buildMap(MATCHABLE_ENTRIES.filter((entry) => entry.contractAddress), 'contractAddress');
const STATIC_CLASS_HASH_INDEX = buildMap(MATCHABLE_ENTRIES.filter((entry) => entry.classHash), 'classHash');
const FACTORY_INDEX = buildFactoryIndex(DEX_CATALOG);

function buildMatchableEntries(catalog) {
  const entries = [];

  for (const protocol of catalog) {
    if (protocol.verificationStatus !== 'verified') {
      continue;
    }

    for (const role of protocol.roles ?? []) {
      entries.push({
        abiVersion: role.abiVersion ?? null,
        classHash: role.classHash ? normalizeHex(role.classHash, { label: `${protocol.key}.classHash`, padToBytes: 32 }) : null,
        contractAddress: role.address ? normalizeAddress(role.address, `${protocol.key}.address`) : null,
        decoder: protocol.decoder,
        displayName: protocol.displayName,
        family: protocol.family,
        metadata: {
          ...(protocol.metadata ?? {}),
          protocol_key: protocol.key,
          role: role.role,
          selector_handlers: protocol.selectorHandlers ?? {},
          source_urls: protocol.sourceUrls ?? [],
          verification_status: protocol.verificationStatus,
        },
        protocol: protocol.protocol,
        protocolKey: protocol.key,
        role: role.role,
        selectorSet: new Set(protocol.selectors ?? []),
        sourceUrls: protocol.sourceUrls ?? [],
      });
    }
  }

  return entries;
}

function buildMap(entries, key) {
  const map = new Map();

  for (const entry of entries) {
    const value = entry[key];
    if (!map.has(value)) {
      map.set(value, []);
    }
    map.get(value).push(entry);
  }

  return map;
}

function buildFactoryIndex(catalog) {
  const map = new Map();

  for (const protocol of catalog) {
    if (protocol.verificationStatus !== 'verified') {
      continue;
    }

    const probe = protocol.metadata?.probe ?? null;
    const factoryRole = (protocol.roles ?? []).find((item) => item.role === 'factory' && item.address);
    if (!factoryRole || !probe) {
      continue;
    }

    map.set(normalizeAddress(factoryRole.address, `${protocol.key}.factoryAddress`), {
      ammVariant: protocol.metadata?.ammVariant ?? 'xyk',
      decoder: protocol.decoder,
      family: protocol.family,
      probe,
      protocol: protocol.protocol,
      protocolKey: protocol.key,
      selectorSet: new Set(protocol.selectors ?? []),
    });
  }

  return map;
}

function getSelectorName(value) {
  return SELECTOR_NAMES_BY_VALUE.get(normalizeSelector(value)) ?? null;
}

function getCatalog() {
  return DEX_CATALOG;
}

function getMatchableEntries() {
  return MATCHABLE_ENTRIES;
}

function getSyncableEntries() {
  return SYNCABLE_ENTRIES;
}

function getStaticMatchesByAddress(address) {
  const normalizedAddress = normalizeAddress(address, 'registry address lookup');
  return STATIC_ADDRESS_INDEX.get(normalizedAddress) ?? [];
}

function getStaticMatchesByClassHash(classHash) {
  const normalizedClassHash = normalizeHex(classHash, { label: 'registry class hash lookup', padToBytes: 32 });
  return STATIC_CLASS_HASH_INDEX.get(normalizedClassHash) ?? [];
}

function getFactoryMetadataByAddress(address) {
  const normalizedAddress = normalizeAddress(address, 'factory address lookup');
  return FACTORY_INDEX.get(normalizedAddress) ?? null;
}

function getCandidateProtocolsForSelector(selectorValue) {
  const normalizedSelector = normalizeSelector(selectorValue);
  const protocols = [];

  for (const protocol of DEX_CATALOG) {
    if ((protocol.selectors ?? []).includes(normalizedSelector)) {
      protocols.push(protocol.key);
    }
  }

  return protocols;
}

function isStandardDexSelector(selectorValue) {
  return STANDARD_DEX_SELECTOR_SET.has(normalizeSelector(selectorValue));
}

function isAggregatorSwapEvent(event) {
  const addressMatches = getStaticMatchesByAddress(event.fromAddress).some((entry) =>
    entry.protocolKey === 'avnu' && entry.role === 'exchange');
  return addressMatches && normalizeSelector(event.selector) === SELECTORS.SWAP;
}

module.exports = {
  DEX_CATALOG,
  MATCHABLE_ENTRIES,
  SELECTORS,
  STANDARD_DEX_SELECTOR_SET,
  getCandidateProtocolsForSelector,
  getCatalog,
  getFactoryMetadataByAddress,
  getMatchableEntries,
  getSelectorName,
  getStaticMatchesByAddress,
  getStaticMatchesByClassHash,
  getSyncableEntries,
  isAggregatorSwapEvent,
  isStandardDexSelector,
};
