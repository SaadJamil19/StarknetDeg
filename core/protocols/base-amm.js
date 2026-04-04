'use strict';

const { SELECTORS } = require('../../lib/registry/dex-registry');
const {
  normalizeAddress,
  normalizeOptionalAddress,
  parseSignedU32FromArray,
  parseSignedU256FromArray,
  parseU128,
  parseU256FromArray,
  sqrtPriceX96ToPriceRatio,
} = require('../normalize');
const { buildActionKey, normalizeActionMetadata } = require('./shared');

function decodeEvent({ contractMetadata, event, tx }) {
  switch (event.selector) {
    case SELECTORS.SWAP:
      return decodeSwap({ contractMetadata, event, tx });
    case SELECTORS.MINT:
      return decodeMint({ contractMetadata, event, tx });
    case SELECTORS.BURN:
      return decodeBurn({ contractMetadata, event, tx });
    case SELECTORS.SYNC:
      return decodeSync({ contractMetadata, event, tx });
    case SELECTORS.PAIR_CREATED:
    case SELECTORS.POOL_CREATED:
      return decodePoolCreated({ contractMetadata, event, tx });
    default:
      return emptyResult();
  }
}

function decodeSwap({ contractMetadata, event, tx }) {
  const variant = contractMetadata.metadata?.ammVariant ?? 'xyk';
  if (variant === 'clmm') {
    return decodeClmmSwap({ contractMetadata, event, tx });
  }

  return decodeXykSwap({ contractMetadata, event, tx });
}

function decodeMint({ contractMetadata, event, tx }) {
  const variant = contractMetadata.metadata?.ammVariant ?? 'xyk';
  if (variant === 'clmm') {
    return decodeClmmMint({ contractMetadata, event, tx });
  }

  return decodeXykMint({ contractMetadata, event, tx });
}

function decodeBurn({ contractMetadata, event, tx }) {
  const variant = contractMetadata.metadata?.ammVariant ?? 'xyk';
  if (variant === 'clmm') {
    return decodeClmmBurn({ contractMetadata, event, tx });
  }

  return decodeXykBurn({ contractMetadata, event, tx });
}

function decodeSync({ contractMetadata, event, tx }) {
  const tokenInfo = resolveTokenInfo(contractMetadata, event, tx, 'sync');
  if (tokenInfo.error) {
    return tokenInfo.error;
  }

  if (!Array.isArray(event.data) || event.data.length < 4) {
    return auditResult(tx, event, `${contractMetadata.protocol.toUpperCase()}_SYNC_SHAPE_MISMATCH`, {
      data_length: Array.isArray(event.data) ? event.data.length : null,
    });
  }

  const reserve0 = parseU256FromArray(event.data, 0, `${contractMetadata.protocol}.sync.reserve0`);
  const reserve1 = parseU256FromArray(event.data, 2, `${contractMetadata.protocol}.sync.reserve1`);

  return {
    actions: [
      {
        actionKey: buildActionKey({
          actionType: 'sync',
          lane: tx.lane,
          sourceEventIndex: event.receiptEventIndex,
          transactionHash: tx.transactionHash,
        }),
        actionType: 'sync',
        amount0: reserve0,
        amount1: reserve1,
        emitterAddress: event.fromAddress,
        executionProtocol: contractMetadata.protocol,
        metadata: normalizeActionMetadata({
          amm_variant: contractMetadata.metadata?.ammVariant ?? 'xyk',
          factory_address: contractMetadata.metadata?.factory_address ?? null,
          pool_model: contractMetadata.metadata?.pool_model ?? 'xyk',
          reserve0,
          reserve1,
          stable: Boolean(contractMetadata.metadata?.stable),
        }),
        poolId: event.fromAddress,
        protocol: contractMetadata.protocol,
        sourceEventIndex: event.receiptEventIndex,
        token0Address: tokenInfo.token0Address,
        token1Address: tokenInfo.token1Address,
      },
    ],
    audits: [],
    transfers: [],
  };
}

function decodePoolCreated({ contractMetadata, event, tx }) {
  const data = Array.isArray(event.data) ? event.data : [];
  const token0Address = data.length > 0 ? normalizeOptionalAddress(data[0], `${contractMetadata.protocol}.pool_created.token0`) : null;
  const token1Address = data.length > 1 ? normalizeOptionalAddress(data[1], `${contractMetadata.protocol}.pool_created.token1`) : null;
  const createdPoolAddress = data.length > 2 ? normalizeOptionalAddress(data[2], `${contractMetadata.protocol}.pool_created.pool`) : null;

  return {
    actions: [
      {
        actionKey: buildActionKey({
          actionType: 'pool_created',
          lane: tx.lane,
          sourceEventIndex: event.receiptEventIndex,
          transactionHash: tx.transactionHash,
        }),
        actionType: 'pool_created',
        emitterAddress: event.fromAddress,
        executionProtocol: contractMetadata.protocol,
        metadata: normalizeActionMetadata({
          raw_data: event.data,
          raw_keys: event.keys,
          role: contractMetadata.role,
          token0_address: token0Address,
          token1_address: token1Address,
          created_pool_address: createdPoolAddress,
        }),
        poolId: createdPoolAddress ?? null,
        protocol: contractMetadata.protocol,
        sourceEventIndex: event.receiptEventIndex,
        token0Address,
        token1Address,
      },
    ],
    audits: [],
    transfers: [],
  };
}

function decodeXykSwap({ contractMetadata, event, tx }) {
  const tokenInfo = resolveTokenInfo(contractMetadata, event, tx, 'swap');
  if (tokenInfo.error) {
    return tokenInfo.error;
  }

  const shape = resolveXykSwapShape(event, contractMetadata.protocol);
  if (!shape) {
    return auditResult(tx, event, `${contractMetadata.protocol.toUpperCase()}_SWAP_SHAPE_MISMATCH`, {
      data_length: Array.isArray(event.data) ? event.data.length : null,
      keys_length: Array.isArray(event.keys) ? event.keys.length : null,
    });
  }

  const amount0In = parseU256FromArray(event.data, shape.amount0InOffset, `${contractMetadata.protocol}.swap.amount0_in`);
  const amount1In = parseU256FromArray(event.data, shape.amount1InOffset, `${contractMetadata.protocol}.swap.amount1_in`);
  const amount0Out = parseU256FromArray(event.data, shape.amount0OutOffset, `${contractMetadata.protocol}.swap.amount0_out`);
  const amount1Out = parseU256FromArray(event.data, shape.amount1OutOffset, `${contractMetadata.protocol}.swap.amount1_out`);
  const sender = shape.senderSource === 'keys'
    ? normalizeAddress(event.keys[shape.senderIndex], `${contractMetadata.protocol}.swap.sender`)
    : normalizeAddress(event.data[shape.senderIndex], `${contractMetadata.protocol}.swap.sender`);
  const recipient = normalizeAddress(event.data[shape.recipientIndex], `${contractMetadata.protocol}.swap.recipient`);

  return {
    actions: [
      {
        actionKey: buildActionKey({
          actionType: 'swap',
          lane: tx.lane,
          sourceEventIndex: event.receiptEventIndex,
          transactionHash: tx.transactionHash,
        }),
        actionType: 'swap',
        accountAddress: tx.senderAddress ?? sender,
        amount0: amount0In - amount0Out,
        amount1: amount1In - amount1Out,
        emitterAddress: event.fromAddress,
        executionProtocol: contractMetadata.protocol,
        metadata: normalizeActionMetadata({
          amount0_in: amount0In,
          amount0_out: amount0Out,
          amount1_in: amount1In,
          amount1_out: amount1Out,
          factory_address: contractMetadata.metadata?.factory_address ?? null,
          pool_model: contractMetadata.metadata?.pool_model ?? 'xyk',
          raw_sender: sender,
          recipient,
          stable: Boolean(contractMetadata.metadata?.stable),
        }),
        poolId: event.fromAddress,
        protocol: contractMetadata.protocol,
        sourceEventIndex: event.receiptEventIndex,
        token0Address: tokenInfo.token0Address,
        token1Address: tokenInfo.token1Address,
      },
    ],
    audits: [],
    transfers: [],
  };
}

function decodeXykMint({ contractMetadata, event, tx }) {
  const tokenInfo = resolveTokenInfo(contractMetadata, event, tx, 'mint');
  if (tokenInfo.error) {
    return tokenInfo.error;
  }

  const shape = resolveXykMintShape(event);
  if (!shape) {
    return auditResult(tx, event, `${contractMetadata.protocol.toUpperCase()}_MINT_SHAPE_MISMATCH`, {
      data_length: Array.isArray(event.data) ? event.data.length : null,
      keys_length: Array.isArray(event.keys) ? event.keys.length : null,
    });
  }

  const sender = shape.senderSource === 'keys'
    ? normalizeAddress(event.keys[shape.senderIndex], `${contractMetadata.protocol}.mint.sender`)
    : normalizeAddress(event.data[shape.senderIndex], `${contractMetadata.protocol}.mint.sender`);
  const amount0 = parseU256FromArray(event.data, shape.amount0Offset, `${contractMetadata.protocol}.mint.amount0`);
  const amount1 = parseU256FromArray(event.data, shape.amount1Offset, `${contractMetadata.protocol}.mint.amount1`);

  return {
    actions: [
      {
        actionKey: buildActionKey({
          actionType: 'mint',
          lane: tx.lane,
          sourceEventIndex: event.receiptEventIndex,
          transactionHash: tx.transactionHash,
        }),
        actionType: 'mint',
        accountAddress: tx.senderAddress ?? sender,
        amount0,
        amount1,
        emitterAddress: event.fromAddress,
        executionProtocol: contractMetadata.protocol,
        metadata: normalizeActionMetadata({
          pool_model: contractMetadata.metadata?.pool_model ?? 'xyk',
          raw_sender: sender,
          stable: Boolean(contractMetadata.metadata?.stable),
        }),
        poolId: event.fromAddress,
        protocol: contractMetadata.protocol,
        sourceEventIndex: event.receiptEventIndex,
        token0Address: tokenInfo.token0Address,
        token1Address: tokenInfo.token1Address,
      },
    ],
    audits: [],
    transfers: [],
  };
}

function decodeXykBurn({ contractMetadata, event, tx }) {
  const tokenInfo = resolveTokenInfo(contractMetadata, event, tx, 'burn');
  if (tokenInfo.error) {
    return tokenInfo.error;
  }

  const shape = resolveXykBurnShape(event);
  if (!shape) {
    return auditResult(tx, event, `${contractMetadata.protocol.toUpperCase()}_BURN_SHAPE_MISMATCH`, {
      data_length: Array.isArray(event.data) ? event.data.length : null,
      keys_length: Array.isArray(event.keys) ? event.keys.length : null,
    });
  }

  const sender = shape.senderSource === 'keys'
    ? normalizeAddress(event.keys[shape.senderIndex], `${contractMetadata.protocol}.burn.sender`)
    : normalizeAddress(event.data[shape.senderIndex], `${contractMetadata.protocol}.burn.sender`);
  const amount0 = parseU256FromArray(event.data, shape.amount0Offset, `${contractMetadata.protocol}.burn.amount0`);
  const amount1 = parseU256FromArray(event.data, shape.amount1Offset, `${contractMetadata.protocol}.burn.amount1`);
  const recipient = normalizeAddress(event.data[shape.recipientIndex], `${contractMetadata.protocol}.burn.recipient`);

  return {
    actions: [
      {
        actionKey: buildActionKey({
          actionType: 'burn',
          lane: tx.lane,
          sourceEventIndex: event.receiptEventIndex,
          transactionHash: tx.transactionHash,
        }),
        actionType: 'burn',
        accountAddress: tx.senderAddress ?? sender,
        amount0: -amount0,
        amount1: -amount1,
        emitterAddress: event.fromAddress,
        executionProtocol: contractMetadata.protocol,
        metadata: normalizeActionMetadata({
          pool_model: contractMetadata.metadata?.pool_model ?? 'xyk',
          raw_sender: sender,
          recipient,
          stable: Boolean(contractMetadata.metadata?.stable),
        }),
        poolId: event.fromAddress,
        protocol: contractMetadata.protocol,
        sourceEventIndex: event.receiptEventIndex,
        token0Address: tokenInfo.token0Address,
        token1Address: tokenInfo.token1Address,
      },
    ],
    audits: [],
    transfers: [],
  };
}

function decodeClmmSwap({ contractMetadata, event, tx }) {
  const tokenInfo = resolveTokenInfo(contractMetadata, event, tx, 'swap');
  if (tokenInfo.error) {
    return tokenInfo.error;
  }

  if (!Array.isArray(event.data) || event.data.length < 13) {
    return auditResult(tx, event, `${contractMetadata.protocol.toUpperCase()}_CLMM_SWAP_SHAPE_MISMATCH`, {
      data_length: Array.isArray(event.data) ? event.data.length : null,
    });
  }

  const sender = normalizeAddress(event.data[0], `${contractMetadata.protocol}.swap.sender`);
  const recipient = normalizeAddress(event.data[1], `${contractMetadata.protocol}.swap.recipient`);
  const amount0 = parseSignedU256FromArray(event.data, 2, `${contractMetadata.protocol}.swap.amount0`);
  const amount1 = parseSignedU256FromArray(event.data, 5, `${contractMetadata.protocol}.swap.amount1`);
  const sqrtPriceX96 = parseU256FromArray(event.data, 8, `${contractMetadata.protocol}.swap.sqrt_price_x96`);
  const liquidity = parseU128(event.data[10], `${contractMetadata.protocol}.swap.liquidity`);
  const tick = parseSignedU32FromArray(event.data, 11, `${contractMetadata.protocol}.swap.tick`);
  const priceRatio = sqrtPriceX96ToPriceRatio(sqrtPriceX96, `${contractMetadata.protocol}.swap.sqrt_price_x96`);

  return {
    actions: [
      {
        actionKey: buildActionKey({
          actionType: 'swap',
          lane: tx.lane,
          sourceEventIndex: event.receiptEventIndex,
          transactionHash: tx.transactionHash,
        }),
        actionType: 'swap',
        accountAddress: tx.senderAddress ?? sender,
        amount0,
        amount1,
        emitterAddress: event.fromAddress,
        executionProtocol: contractMetadata.protocol,
        metadata: normalizeActionMetadata({
          liquidity_after: liquidity,
          pool_model: 'clmm',
          price_ratio_denominator: priceRatio.denominator,
          price_ratio_numerator: priceRatio.numerator,
          raw_sender: sender,
          recipient,
          sqrt_price_x96_after: sqrtPriceX96,
          tick_after: tick,
        }),
        poolId: event.fromAddress,
        protocol: contractMetadata.protocol,
        sourceEventIndex: event.receiptEventIndex,
        token0Address: tokenInfo.token0Address,
        token1Address: tokenInfo.token1Address,
      },
    ],
    audits: [],
    transfers: [],
  };
}

function decodeClmmMint({ contractMetadata, event, tx }) {
  const tokenInfo = resolveTokenInfo(contractMetadata, event, tx, 'mint');
  if (tokenInfo.error) {
    return tokenInfo.error;
  }

  if (!Array.isArray(event.data) || event.data.length < 11) {
    return auditResult(tx, event, `${contractMetadata.protocol.toUpperCase()}_CLMM_MINT_SHAPE_MISMATCH`, {
      data_length: Array.isArray(event.data) ? event.data.length : null,
    });
  }

  const sender = normalizeAddress(event.data[0], `${contractMetadata.protocol}.mint.sender`);
  const owner = normalizeAddress(event.data[1], `${contractMetadata.protocol}.mint.owner`);
  const tickLower = parseSignedU32FromArray(event.data, 2, `${contractMetadata.protocol}.mint.tick_lower`);
  const tickUpper = parseSignedU32FromArray(event.data, 4, `${contractMetadata.protocol}.mint.tick_upper`);
  const liquidityAmount = parseU128(event.data[6], `${contractMetadata.protocol}.mint.liquidity`);
  const amount0 = parseU256FromArray(event.data, 7, `${contractMetadata.protocol}.mint.amount0`);
  const amount1 = parseU256FromArray(event.data, 9, `${contractMetadata.protocol}.mint.amount1`);

  return {
    actions: [
      {
        actionKey: buildActionKey({
          actionType: 'mint',
          lane: tx.lane,
          sourceEventIndex: event.receiptEventIndex,
          transactionHash: tx.transactionHash,
        }),
        actionType: 'mint',
        accountAddress: tx.senderAddress ?? owner,
        amount0,
        amount1,
        emitterAddress: event.fromAddress,
        executionProtocol: contractMetadata.protocol,
        metadata: normalizeActionMetadata({
          liquidity_amount: liquidityAmount,
          owner,
          pool_model: 'clmm',
          raw_sender: sender,
          tick_lower: tickLower,
          tick_upper: tickUpper,
        }),
        poolId: event.fromAddress,
        protocol: contractMetadata.protocol,
        sourceEventIndex: event.receiptEventIndex,
        token0Address: tokenInfo.token0Address,
        token1Address: tokenInfo.token1Address,
      },
    ],
    audits: [],
    transfers: [],
  };
}

function decodeClmmBurn({ contractMetadata, event, tx }) {
  const tokenInfo = resolveTokenInfo(contractMetadata, event, tx, 'burn');
  if (tokenInfo.error) {
    return tokenInfo.error;
  }

  if (!Array.isArray(event.data) || event.data.length < 10) {
    return auditResult(tx, event, `${contractMetadata.protocol.toUpperCase()}_CLMM_BURN_SHAPE_MISMATCH`, {
      data_length: Array.isArray(event.data) ? event.data.length : null,
    });
  }

  const owner = normalizeAddress(event.data[0], `${contractMetadata.protocol}.burn.owner`);
  const tickLower = parseSignedU32FromArray(event.data, 1, `${contractMetadata.protocol}.burn.tick_lower`);
  const tickUpper = parseSignedU32FromArray(event.data, 3, `${contractMetadata.protocol}.burn.tick_upper`);
  const liquidityAmount = parseU128(event.data[5], `${contractMetadata.protocol}.burn.liquidity`);
  const amount0 = parseU256FromArray(event.data, 6, `${contractMetadata.protocol}.burn.amount0`);
  const amount1 = parseU256FromArray(event.data, 8, `${contractMetadata.protocol}.burn.amount1`);

  return {
    actions: [
      {
        actionKey: buildActionKey({
          actionType: 'burn',
          lane: tx.lane,
          sourceEventIndex: event.receiptEventIndex,
          transactionHash: tx.transactionHash,
        }),
        actionType: 'burn',
        accountAddress: tx.senderAddress ?? owner,
        amount0: -amount0,
        amount1: -amount1,
        emitterAddress: event.fromAddress,
        executionProtocol: contractMetadata.protocol,
        metadata: normalizeActionMetadata({
          liquidity_amount: liquidityAmount,
          owner,
          pool_model: 'clmm',
          tick_lower: tickLower,
          tick_upper: tickUpper,
        }),
        poolId: event.fromAddress,
        protocol: contractMetadata.protocol,
        sourceEventIndex: event.receiptEventIndex,
        token0Address: tokenInfo.token0Address,
        token1Address: tokenInfo.token1Address,
      },
    ],
    audits: [],
    transfers: [],
  };
}

function resolveXykSwapShape(event) {
  if (Array.isArray(event.keys) && event.keys.length >= 2 && Array.isArray(event.data) && event.data.length >= 9) {
    return {
      amount0InOffset: 0,
      amount0OutOffset: 4,
      amount1InOffset: 2,
      amount1OutOffset: 6,
      recipientIndex: 8,
      senderIndex: 1,
      senderSource: 'keys',
    };
  }

  if (Array.isArray(event.data) && event.data.length >= 10) {
    return {
      amount0InOffset: 1,
      amount0OutOffset: 5,
      amount1InOffset: 3,
      amount1OutOffset: 7,
      recipientIndex: 9,
      senderIndex: 0,
      senderSource: 'data',
    };
  }

  return null;
}

function resolveXykMintShape(event) {
  if (Array.isArray(event.keys) && event.keys.length >= 2 && Array.isArray(event.data) && event.data.length >= 4) {
    return {
      amount0Offset: 0,
      amount1Offset: 2,
      senderIndex: 1,
      senderSource: 'keys',
    };
  }

  if (Array.isArray(event.data) && event.data.length >= 5) {
    return {
      amount0Offset: 1,
      amount1Offset: 3,
      senderIndex: 0,
      senderSource: 'data',
    };
  }

  return null;
}

function resolveXykBurnShape(event) {
  if (Array.isArray(event.keys) && event.keys.length >= 2 && Array.isArray(event.data) && event.data.length >= 5) {
    return {
      amount0Offset: 0,
      amount1Offset: 2,
      recipientIndex: 4,
      senderIndex: 1,
      senderSource: 'keys',
    };
  }

  if (Array.isArray(event.data) && event.data.length >= 6) {
    return {
      amount0Offset: 1,
      amount1Offset: 3,
      recipientIndex: 5,
      senderIndex: 0,
      senderSource: 'data',
    };
  }

  return null;
}

function resolveTokenInfo(contractMetadata, event, tx, actionType) {
  const token0Address = contractMetadata.metadata?.token0_address
    ? normalizeAddress(contractMetadata.metadata.token0_address, `${contractMetadata.protocol}.${actionType}.token0`)
    : null;
  const token1Address = contractMetadata.metadata?.token1_address
    ? normalizeAddress(contractMetadata.metadata.token1_address, `${contractMetadata.protocol}.${actionType}.token1`)
    : null;

  if (!token0Address || !token1Address) {
    return {
      error: auditResult(tx, event, `${contractMetadata.protocol.toUpperCase()}_POOL_TOKEN_METADATA_MISSING`, {
        factory_address: contractMetadata.metadata?.factory_address ?? null,
        role: contractMetadata.role,
      }),
    };
  }

  return {
    token0Address,
    token1Address,
  };
}

function auditResult(tx, event, reason, metadata) {
  return {
    actions: [],
    audits: [
      {
        blockHash: tx.blockHash,
        blockNumber: tx.blockNumber,
        emitterAddress: event.fromAddress,
        lane: tx.lane,
        metadata: normalizeActionMetadata(metadata),
        reason,
        selector: event.selector,
        sourceEventIndex: event.receiptEventIndex,
        transactionHash: tx.transactionHash,
        transactionIndex: tx.transactionIndex,
      },
    ],
    transfers: [],
  };
}

function emptyResult() {
  return { actions: [], audits: [], transfers: [] };
}

module.exports = {
  decodeEvent,
};
