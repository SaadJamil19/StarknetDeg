'use strict';

const { normalizeAddress } = require('../normalize');

const STATIC_CORE_TOKENS = Object.freeze([
  {
    address: normalizeAddress('0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7', 'static core ETH'),
    decimals: 18,
    isLegacy: false,
    isStable: false,
    key: 'ETH',
    name: 'Ether',
    symbol: 'ETH',
    verificationSource: 'static_core_registry',
  },
  {
    address: normalizeAddress('0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8', 'static core USDC'),
    decimals: 6,
    isLegacy: false,
    isStable: true,
    key: 'USDC',
    name: 'USD Coin',
    symbol: 'USDC',
    verificationSource: 'static_core_registry',
  },
  {
    address: normalizeAddress('0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8', 'static core USDT'),
    decimals: 6,
    isLegacy: false,
    isStable: true,
    key: 'USDT',
    name: 'Tether USD',
    symbol: 'USDT',
    verificationSource: 'static_core_registry',
  },
  {
    address: normalizeAddress('0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d', 'static core STRK'),
    decimals: 18,
    isLegacy: false,
    isStable: false,
    key: 'STRK',
    name: 'Starknet Token',
    symbol: 'STRK',
    verificationSource: 'static_core_registry',
  },
  {
    address: normalizeAddress('0x05574eb6b8789a91466f902c380d978e472db68170ff82a5b650b95a58ddf4ad', 'static core DAI'),
    decimals: 18,
    isLegacy: false,
    isStable: true,
    key: 'DAI',
    name: 'Dai Stablecoin',
    symbol: 'DAI',
    verificationSource: 'static_core_registry',
  },
  {
    address: normalizeAddress('0x00da114221cb83fa859dbdb4c44beeaa0bb37c7537ad5ae66fe5e0efd20e6eb3', 'static legacy DAI v0'),
    decimals: 18,
    isLegacy: true,
    isStable: true,
    key: 'DAI_V0',
    name: 'Dai Stablecoin',
    symbol: 'DAI',
    verificationSource: 'static_core_registry',
  },
  {
    address: normalizeAddress('0x03fe2b97c1fd336e750087d68b9b867997fd64a2661ff3ca5a7c771641e8e7ac', 'static core WBTC'),
    decimals: 8,
    isLegacy: false,
    isStable: false,
    key: 'WBTC',
    name: 'Wrapped BTC',
    symbol: 'WBTC',
    verificationSource: 'static_core_registry',
  },
]);

const STATIC_CORE_TOKENS_BY_ADDRESS = new Map(
  STATIC_CORE_TOKENS.map((token) => [token.address, token]),
);

function getStaticCoreToken(address) {
  if (!address) {
    return null;
  }

  return STATIC_CORE_TOKENS_BY_ADDRESS.get(normalizeAddress(address, 'static core token lookup')) ?? null;
}

function listStaticCoreTokens() {
  return [...STATIC_CORE_TOKENS];
}

module.exports = {
  STATIC_CORE_TOKENS,
  getStaticCoreToken,
  listStaticCoreTokens,
};
