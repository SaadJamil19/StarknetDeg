'use strict';

const { keccak_256 } = require('@noble/hashes/sha3');
const { bytesToHex } = require('@noble/hashes/utils');
const { knownErc20Cache } = require('../core/known-erc20-cache');
const { normalizeAddress, normalizeHex, normalizeOptionalAddress, ZERO_ADDRESS } = require('../core/normalize');
const { integerAmountToScaled, scaledToNumericString, DEFAULT_SCALE } = require('./cairo/fixed-point');

const WARNED_UNKNOWN_L1_TOKENS = new Set();

const STARKGATE_L1_CONTRACTS = Object.freeze({
  ETH_BRIDGE: normalizeEthAddress('0xae0Ee0A63A2cE6BaeEFFE56e7714FB4EFE48D419', 'ETH bridge'),
  ERC20_BRIDGE: normalizeEthAddress('0x283751A21eafBFcD52297820D27C1f1963D9b5b4', 'ERC20 bridge'),
  STRK_BRIDGE: normalizeEthAddress('0xCE5485Cfb26914C5dcE00B9BAF0580364daFC7a4', 'STRK bridge'),
  STARKNET_CORE: normalizeEthAddress('0xc662c410C0ECf747543f5bA90660f6ABeBD9C8c4', 'Starknet core'),
});

const EVENT_TOPICS = Object.freeze({
  DEPOSIT_V2: computeEventTopic('Deposit(address,address,uint256,uint256,uint256,uint256)'),
  DEPOSIT_WITH_MESSAGE: computeEventTopic('DepositWithMessage(address,uint256,uint256,address,uint256,uint256[])'),
  DEPOSIT: computeEventTopic('Deposit(address,uint256,uint256)'),
  WITHDRAWAL_V2: computeEventTopic('Withdrawal(address,address,uint256)'),
  WITHDRAWAL_INITIATED: computeEventTopic('WithdrawalInitiated(address,uint256,uint256)'),
});

const L1_TOKEN_CANDIDATES = buildL1TokenCandidates();

function buildL1TokenCandidates() {
  const byL1Bridge = new Map();
  const byL1Token = new Map();

  for (const token of knownErc20Cache.getAllTokens()) {
    const candidate = {
      decimals: token.decimals ?? null,
      l1BridgeAddress: normalizeOptionalEthAddress(token.l1BridgeAddress, 'known token l1 bridge'),
      l1TokenAddress: normalizeOptionalEthAddress(token.l1TokenAddress, 'known token l1 token'),
      l2TokenAddress: normalizeAddress(token.l2TokenAddress, 'known token l2 token'),
      symbol: token.symbol ?? null,
      verificationSource: token.verificationSource ?? 'known_erc20_cache',
    };

    if (candidate.l1BridgeAddress) {
      if (!byL1Bridge.has(candidate.l1BridgeAddress)) {
        byL1Bridge.set(candidate.l1BridgeAddress, []);
      }
      byL1Bridge.get(candidate.l1BridgeAddress).push(candidate);
    }

    if (candidate.l1TokenAddress) {
      if (!byL1Token.has(candidate.l1TokenAddress)) {
        byL1Token.set(candidate.l1TokenAddress, []);
      }
      byL1Token.get(candidate.l1TokenAddress).push(candidate);
    }
  }

  return {
    byL1Bridge,
    byL1Token,
  };
}

function computeEventTopic(signature) {
  return `0x${bytesToHex(keccak_256(Buffer.from(signature, 'utf8'))).toLowerCase()}`;
}

function normalizeEthAddress(value, label = 'ethereum address') {
  if (value === undefined || value === null || value === '') {
    throw new Error(`${label} is required.`);
  }

  const normalizedHex = normalizeHex(value, { label, padToBytes: 32 });
  return `0x${normalizedHex.slice(-40).toLowerCase()}`;
}

function normalizeOptionalEthAddress(value, label = 'ethereum address') {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  return normalizeEthAddress(value, label);
}

function normalizeL2AddressFromUint256(value, label = 'l2 address') {
  return normalizeAddress(value, label);
}

function decodeStarkgateLog(log) {
  const emitterContract = normalizeEthAddress(log.address, 'starkgate log emitter');
  const topic0 = String(log.topics?.[0] ?? '').toLowerCase();
  const blockNumber = BigInt(log.blockNumber);
  const transactionIndex = BigInt(log.transactionIndex);
  const logIndex = BigInt(log.logIndex);
  const eventKey = `${blockNumber.toString(10)}:${log.transactionHash}:${logIndex.toString(10)}`;

  if (topic0 === EVENT_TOPICS.DEPOSIT_V2) {
    const l1Sender = normalizeEthAddress(log.topics[1], 'starkgate v2 deposit topic[1] l1 sender');
    const l1TokenAddress = normalizeEthAddress(log.topics[2], 'starkgate v2 deposit topic[2] token');
    const l2Recipient = normalizeL2AddressFromUint256(log.topics[3], 'starkgate v2 deposit topic[3] l2 recipient');
    const slots = decodeDataSlots(log.data);
    const amount = BigInt(slots[0] ?? '0x0');
    const nonce = slots[1] === undefined ? null : BigInt(slots[1]);
    const fee = slots[2] === undefined ? null : BigInt(slots[2]);
    const tokenResolution = resolveL1Token({
      emitterContract,
      l1TokenAddress,
    });

    return buildNormalizedEvent({
      amount,
      emitterContract,
      eventKey,
      eventType: 'deposit_initiated',
      isNativeEth: tokenResolution.isNativeEth,
      l1Sender,
      l1TokenAddress: tokenResolution.l1TokenAddress,
      l2Recipient,
      l2TokenAddress: tokenResolution.l2TokenAddress,
      log,
      metadata: {
        decode_path: 'deposit_v2',
        fee_wei: fee === null ? null : fee.toString(10),
        token_resolution_source: tokenResolution.verificationSource,
        unknown_l1_token: tokenResolution.unknown,
      },
      nonce,
      tokenDecimals: tokenResolution.decimals,
      tokenSymbol: tokenResolution.symbol,
    });
  }

  if (topic0 === EVENT_TOPICS.DEPOSIT_WITH_MESSAGE) {
    const l1Sender = normalizeEthAddress(log.topics[1], 'deposit topic[1] l1 sender');
    const l2Recipient = normalizeL2AddressFromUint256(log.topics[2], 'deposit topic[2] l2 recipient');
    const nonce = BigInt(log.topics[3]);
    const slots = decodeDataSlots(log.data);
    const l1TokenAddress = normalizeEthAddress(slots[0] ?? ZERO_ADDRESS, 'deposit token address');
    const amount = BigInt(slots[1] ?? '0x0');
    const tokenResolution = resolveL1Token({
      emitterContract,
      l1TokenAddress,
    });

    return buildNormalizedEvent({
      amount,
      emitterContract,
      eventKey,
      eventType: 'deposit_initiated',
      isNativeEth: tokenResolution.isNativeEth,
      l1Sender,
      l1TokenAddress: tokenResolution.l1TokenAddress,
      l2Recipient,
      l2TokenAddress: tokenResolution.l2TokenAddress,
      log,
      metadata: {
        decode_path: 'deposit_with_message',
        message_data_words: Math.max(slots.length - 3, 0),
        token_resolution_source: tokenResolution.verificationSource,
        unknown_l1_token: tokenResolution.unknown,
      },
      nonce,
      tokenDecimals: tokenResolution.decimals,
      tokenSymbol: tokenResolution.symbol,
    });
  }

  if (topic0 === EVENT_TOPICS.DEPOSIT) {
    const l1Sender = normalizeEthAddress(log.topics[1], 'legacy deposit topic[1] l1 sender');
    const l2Recipient = normalizeL2AddressFromUint256(log.topics[2], 'legacy deposit topic[2] l2 recipient');
    const slots = decodeDataSlots(log.data);
    const amount = BigInt(slots[0] ?? '0x0');
    const tokenResolution = resolveL1Token({
      emitterContract,
      l1TokenAddress: null,
    });

    return buildNormalizedEvent({
      amount,
      emitterContract,
      eventKey,
      eventType: 'deposit_initiated',
      isNativeEth: tokenResolution.isNativeEth,
      l1Sender,
      l1TokenAddress: tokenResolution.l1TokenAddress,
      l2Recipient,
      l2TokenAddress: tokenResolution.l2TokenAddress,
      log,
      metadata: {
        decode_path: 'deposit_legacy',
        token_resolution_source: tokenResolution.verificationSource,
        unknown_l1_token: tokenResolution.unknown,
      },
      nonce: null,
      tokenDecimals: tokenResolution.decimals,
      tokenSymbol: tokenResolution.symbol,
    });
  }

  if (topic0 === EVENT_TOPICS.WITHDRAWAL_V2) {
    const l1Recipient = normalizeEthAddress(log.topics[1], 'starkgate v2 withdrawal topic[1] l1 recipient');
    const l1TokenAddress = normalizeEthAddress(log.topics[2], 'starkgate v2 withdrawal topic[2] token');
    const slots = decodeDataSlots(log.data);
    const amount = BigInt(slots[0] ?? '0x0');
    const tokenResolution = resolveL1Token({
      emitterContract,
      l1TokenAddress,
    });

    return buildNormalizedEvent({
      amount,
      emitterContract,
      eventKey,
      eventType: 'withdrawal_completed',
      isNativeEth: tokenResolution.isNativeEth,
      l1Recipient,
      l1TokenAddress: tokenResolution.l1TokenAddress,
      l2TokenAddress: tokenResolution.l2TokenAddress,
      log,
      metadata: {
        decode_path: 'withdrawal_v2',
        token_resolution_source: tokenResolution.verificationSource,
        unknown_l1_token: tokenResolution.unknown,
      },
      nonce: null,
      tokenDecimals: tokenResolution.decimals,
      tokenSymbol: tokenResolution.symbol,
    });
  }

  if (topic0 === EVENT_TOPICS.WITHDRAWAL_INITIATED) {
    const l1Recipient = normalizeEthAddress(log.topics[1], 'withdrawal topic[1] l1 recipient');
    const l2Sender = normalizeL2AddressFromUint256(log.topics[2], 'withdrawal topic[2] l2 sender');
    const slots = decodeDataSlots(log.data);
    const amount = BigInt(slots[0] ?? '0x0');
    const tokenResolution = resolveL1Token({
      emitterContract,
      l1TokenAddress: null,
    });

    return buildNormalizedEvent({
      amount,
      emitterContract,
      eventKey,
      eventType: 'withdrawal_completed',
      isNativeEth: tokenResolution.isNativeEth,
      l1Recipient,
      l1TokenAddress: tokenResolution.l1TokenAddress,
      l2Sender,
      l2TokenAddress: tokenResolution.l2TokenAddress,
      log,
      metadata: {
        decode_path: 'withdrawal_initiated',
        token_resolution_source: tokenResolution.verificationSource,
        unknown_l1_token: tokenResolution.unknown,
      },
      nonce: null,
      tokenDecimals: tokenResolution.decimals,
      tokenSymbol: tokenResolution.symbol,
    });
  }

  return null;
}

function buildNormalizedEvent({
  amount,
  emitterContract,
  eventKey,
  eventType,
  isNativeEth,
  l1Recipient = null,
  l1Sender = null,
  l1TokenAddress = null,
  l2Recipient = null,
  l2Sender = null,
  l2TokenAddress = null,
  log,
  metadata,
  nonce,
  tokenDecimals,
  tokenSymbol,
}) {
  const amountHuman = tokenDecimals === null || tokenDecimals === undefined
    ? null
    : scaledToNumericString(integerAmountToScaled(amount, tokenDecimals, DEFAULT_SCALE), DEFAULT_SCALE);

  return {
    amount,
    amountHuman,
    amountUsd: null,
    emitterContract,
    ethBlockHash: log.blockHash,
    ethBlockNumber: BigInt(log.blockNumber),
    ethLogIndex: BigInt(log.logIndex),
    ethTransactionHash: log.transactionHash,
    ethTransactionIndex: BigInt(log.transactionIndex),
    eventKey,
    eventType,
    isNativeEth: Boolean(isNativeEth),
    l1Recipient,
    l1Sender,
    l1TokenAddress,
    l2Recipient,
    l2Sender,
    l2TokenAddress,
    matchStatus: 'PENDING',
    metadata: metadata ?? {},
    nonce,
    tokenSymbol: tokenSymbol ?? null,
  };
}

function decodeDataSlots(data) {
  const hex = String(data ?? '0x').replace(/^0x/i, '');
  if (!hex) {
    return [];
  }

  const slots = [];
  for (let offset = 0; offset < hex.length; offset += 64) {
    const slot = hex.slice(offset, offset + 64);
    if (slot.length === 64) {
      slots.push(`0x${slot}`);
    }
  }

  return slots;
}

function resolveL1Token({ emitterContract, l1TokenAddress }) {
  const normalizedEmitter = normalizeEthAddress(emitterContract, 'L1 token emitter contract');
  const normalizedL1Token = normalizeOptionalEthAddress(l1TokenAddress, 'L1 token address');

  if (normalizedEmitter === STARKGATE_L1_CONTRACTS.ETH_BRIDGE || isNativeEthToken(normalizedL1Token)) {
    return {
      decimals: 18,
      isNativeEth: true,
      l1TokenAddress: normalizedL1Token ?? '0x0000000000000000000000000000000000455448',
      l2TokenAddress: normalizeAddress('0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7', 'ETH L2 token'),
      symbol: 'ETH',
      unknown: false,
      verificationSource: 'known_erc20_cache',
    };
  }

  const byToken = normalizedL1Token ? (L1_TOKEN_CANDIDATES.byL1Token.get(normalizedL1Token) ?? []) : [];
  const byBridge = L1_TOKEN_CANDIDATES.byL1Bridge.get(normalizedEmitter) ?? [];
  const exactBridgeMatch = byToken.find((candidate) => candidate.l1BridgeAddress === normalizedEmitter) ?? null;
  const bridgeOnlyMatch = byBridge.length === 1 ? byBridge[0] : null;
  const tokenOnlyMatch = byToken.length === 1 ? byToken[0] : null;
  const candidate = exactBridgeMatch ?? bridgeOnlyMatch ?? tokenOnlyMatch;

  if (candidate) {
    return {
      decimals: candidate.decimals,
      isNativeEth: false,
      l1TokenAddress: candidate.l1TokenAddress,
      l2TokenAddress: candidate.l2TokenAddress,
      symbol: candidate.symbol,
      unknown: false,
      verificationSource: candidate.verificationSource,
    };
  }

  warnUnknownL1Token({
    emitterContract: normalizedEmitter,
    l1TokenAddress: normalizedL1Token,
  });

  return {
    decimals: null,
    isNativeEth: false,
    l1TokenAddress: normalizedL1Token,
    l2TokenAddress: null,
    symbol: null,
    unknown: true,
    verificationSource: 'unknown_l1_token',
  };
}

function warnUnknownL1Token({ emitterContract, l1TokenAddress }) {
  const tokenLabel = l1TokenAddress ?? 'null';
  const warningKey = `${emitterContract}:${tokenLabel}`;
  if (WARNED_UNKNOWN_L1_TOKENS.has(warningKey)) {
    return;
  }

  WARNED_UNKNOWN_L1_TOKENS.add(warningKey);
  console.warn(`[LOG_LEVEL_WARN] l1 starkgate unknown token emitter=${emitterContract} l1_token_address=${tokenLabel}`);
}

function isNativeEthToken(address) {
  if (!address) {
    return false;
  }

  return address === '0x0000000000000000000000000000000000000000'
    || address === '0x0000000000000000000000000000000000455448';
}

module.exports = {
  EVENT_TOPICS,
  STARKGATE_L1_CONTRACTS,
  decodeStarkgateLog,
  normalizeEthAddress,
  normalizeL2AddressFromUint256,
  resolveL1Token,
};
