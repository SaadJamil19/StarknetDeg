'use strict';

const FINALITY_LANES = Object.freeze({
  PRE_CONFIRMED: 'PRE_CONFIRMED',
  ACCEPTED_ON_L2: 'ACCEPTED_ON_L2',
  ACCEPTED_ON_L1: 'ACCEPTED_ON_L1',
});

const EXECUTION_STATUSES = Object.freeze({
  SUCCEEDED: 'SUCCEEDED',
  REVERTED: 'REVERTED',
});

function normalizeFinalityStatus(value) {
  const normalized = String(value || '').trim().toUpperCase();

  if (!Object.values(FINALITY_LANES).includes(normalized)) {
    throw new Error(`Unsupported Starknet finality status: ${value}`);
  }

  return normalized;
}

function normalizeExecutionStatus(value) {
  const normalized = String(value || '').trim().toUpperCase();

  if (!Object.values(EXECUTION_STATUSES).includes(normalized)) {
    throw new Error(`Unsupported Starknet execution status: ${value}`);
  }

  return normalized;
}

function assertValidFinalityLane(value) {
  return normalizeFinalityStatus(value);
}

function isBusinessSafeReceipt(receipt) {
  return normalizeExecutionStatus(receipt.execution_status) === EXECUTION_STATUSES.SUCCEEDED;
}

function summarizeBlockReceipts(blockWithReceipts) {
  const entries = Array.isArray(blockWithReceipts.transactions) ? blockWithReceipts.transactions : [];
  let succeeded = 0;
  let reverted = 0;
  let l1Handlers = 0;

  for (const entry of entries) {
    const receipt = entry.receipt || entry;
    const transaction = entry.transaction || entry;
    const executionStatus = normalizeExecutionStatus(receipt.execution_status);

    if (executionStatus === EXECUTION_STATUSES.SUCCEEDED) {
      succeeded += 1;
    } else {
      reverted += 1;
    }

    if (String(transaction.type || receipt.type || '').trim().toUpperCase() === 'L1_HANDLER') {
      l1Handlers += 1;
    }
  }

  return {
    total: entries.length,
    succeeded,
    reverted,
    l1Handlers,
  };
}

module.exports = {
  EXECUTION_STATUSES,
  FINALITY_LANES,
  assertValidFinalityLane,
  isBusinessSafeReceipt,
  normalizeExecutionStatus,
  normalizeFinalityStatus,
  summarizeBlockReceipts,
};
