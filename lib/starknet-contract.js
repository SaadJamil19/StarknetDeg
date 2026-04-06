'use strict';

function normalizeAbiPayload(classDefinition) {
  const abi = classDefinition?.abi;
  if (!abi) {
    return [];
  }

  if (Array.isArray(abi)) {
    return abi;
  }

  if (typeof abi === 'string') {
    try {
      const parsed = JSON.parse(abi);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }

  return [];
}

function collectAbiNames(abi) {
  const functions = new Set();
  const events = new Set();

  walkAbiItems(normalizeAbiPayload({ abi }), (item) => {
    const type = String(item?.type ?? '').toLowerCase();
    const name = typeof item?.name === 'string' ? item.name : null;
    if (!name) {
      return;
    }

    if (type.includes('event')) {
      events.add(name);
      return;
    }

    if (type.includes('function') || type.includes('interface') || type === 'constructor' || type === 'l1_handler') {
      functions.add(name);
    }
  });

  return {
    events: Array.from(events).sort(),
    functions: Array.from(functions).sort(),
  };
}

function walkAbiItems(items, visitor) {
  for (const item of Array.isArray(items) ? items : []) {
    visitor(item);

    if (Array.isArray(item?.items)) {
      walkAbiItems(item.items, visitor);
    }

    if (Array.isArray(item?.variants)) {
      walkAbiItems(item.variants, visitor);
    }
  }
}

module.exports = {
  collectAbiNames,
  normalizeAbiPayload,
};
