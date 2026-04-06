'use strict';

class TtlCache {
  constructor(options = {}) {
    this.defaultTtlMs = normalizePositiveInteger(options.defaultTtlMs, 60_000);
    this.maxEntries = normalizePositiveInteger(options.maxEntries, 5_000);
    this.entries = new Map();
    this.inFlight = new Map();
  }

  clear() {
    this.entries.clear();
    this.inFlight.clear();
  }

  delete(key) {
    this.entries.delete(key);
    this.inFlight.delete(key);
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }

    if (entry.expiresAtMs <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }

    return entry.value;
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  async getOrLoad(key, loader, ttlMs = this.defaultTtlMs) {
    const cached = this.get(key);
    if (cached !== undefined) {
      return cached;
    }

    if (this.inFlight.has(key)) {
      return this.inFlight.get(key);
    }

    const promise = Promise.resolve()
      .then(() => loader())
      .then((value) => {
        this.set(key, value, ttlMs);
        this.inFlight.delete(key);
        return value;
      })
      .catch((error) => {
        this.inFlight.delete(key);
        throw error;
      });

    this.inFlight.set(key, promise);
    return promise;
  }

  set(key, value, ttlMs = this.defaultTtlMs) {
    this.pruneExpiredEntries();

    if (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) {
        this.entries.delete(oldestKey);
      }
    }

    this.entries.set(key, {
      expiresAtMs: Date.now() + normalizePositiveInteger(ttlMs, this.defaultTtlMs),
      value,
    });
  }

  pruneExpiredEntries() {
    const now = Date.now();
    for (const [key, entry] of this.entries.entries()) {
      if (entry.expiresAtMs <= now) {
        this.entries.delete(key);
      }
    }
  }
}

function normalizePositiveInteger(value, fallbackValue) {
  if (value === undefined || value === null || value === '') {
    return fallbackValue;
  }

  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallbackValue;
  }

  return parsed;
}

function createTtlCache(options = {}) {
  return new TtlCache(options);
}

module.exports = {
  TtlCache,
  createTtlCache,
};
