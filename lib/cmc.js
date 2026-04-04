'use strict';

const { DEFAULT_SCALE, decimalStringToScaled } = require('./cairo/fixed-point');

const DEFAULT_TTL_MS = 60_000;
const QUOTE_URL = 'https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest';
const quoteCache = new Map();

async function fetchLatestQuotes(symbols) {
  const apiKey = String(process.env.CMC_API_KEY ?? '').trim();
  if (!apiKey) {
    return new Map();
  }

  const uniqueSymbols = normalizeSymbols(symbols);
  if (uniqueSymbols.length === 0) {
    return new Map();
  }

  const ttlMs = parsePositiveInteger(process.env.CMC_CACHE_TTL_MS, DEFAULT_TTL_MS);
  const now = Date.now();
  const staleSymbols = uniqueSymbols.filter((symbol) => shouldRefresh(symbol, now, ttlMs));

  if (staleSymbols.length > 0) {
    const freshQuotes = await requestQuotes(staleSymbols, apiKey);

    for (const [symbol, quote] of freshQuotes.entries()) {
      quoteCache.set(symbol, {
        fetchedAtMs: now,
        quote,
      });
    }
  }

  const resolved = new Map();
  for (const symbol of uniqueSymbols) {
    const cached = quoteCache.get(symbol);
    if (cached?.quote) {
      resolved.set(symbol, cached.quote);
    }
  }

  return resolved;
}

function normalizeSymbols(symbols) {
  return Array.from(
    new Set(
      (Array.isArray(symbols) ? symbols : [])
        .map((symbol) => String(symbol ?? '').trim().toUpperCase())
        .filter(Boolean),
    ),
  );
}

function shouldRefresh(symbol, now, ttlMs) {
  const cached = quoteCache.get(symbol);
  if (!cached) {
    return true;
  }

  return (now - cached.fetchedAtMs) >= ttlMs;
}

async function requestQuotes(symbols, apiKey) {
  const response = await fetch(`${QUOTE_URL}?symbol=${encodeURIComponent(symbols.join(','))}&convert=USD`, {
    headers: {
      Accept: 'application/json',
      'X-CMC_PRO_API_KEY': apiKey,
    },
    method: 'GET',
  });

  const payload = await response.json();
  if (!response.ok || payload?.status?.error_code) {
    throw new Error(`CMC quotes/latest failed: ${payload?.status?.error_message || response.statusText || response.status}`);
  }

  const quotes = new Map();
  for (const symbol of symbols) {
    const record = payload?.data?.[symbol];
    if (!record) {
      continue;
    }

    const normalizedRecord = Array.isArray(record) ? (record.length === 1 ? record[0] : null) : record;
    if (!normalizedRecord?.quote?.USD?.price) {
      continue;
    }

    quotes.set(symbol, {
      cmcId: normalizedRecord.id ?? null,
      lastUpdated: normalizedRecord.quote.USD.last_updated ?? normalizedRecord.last_updated ?? null,
      marketCapUsdScaled: normalizedRecord.quote.USD.market_cap === undefined || normalizedRecord.quote.USD.market_cap === null
        ? null
        : decimalStringToScaled(normalizedRecord.quote.USD.market_cap, DEFAULT_SCALE),
      priceUsdScaled: decimalStringToScaled(normalizedRecord.quote.USD.price, DEFAULT_SCALE),
      symbol,
      volume24hUsdScaled: normalizedRecord.quote.USD.volume_24h === undefined || normalizedRecord.quote.USD.volume_24h === null
        ? null
        : decimalStringToScaled(normalizedRecord.quote.USD.volume_24h, DEFAULT_SCALE),
    });
  }

  return quotes;
}

function parsePositiveInteger(value, fallbackValue) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallbackValue;
  }

  const parsed = Number.parseInt(String(value).trim(), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallbackValue;
  }

  return parsed;
}

module.exports = {
  fetchLatestQuotes,
};
