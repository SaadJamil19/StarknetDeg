'use strict';

const { publishJson } = require('../lib/redis');

async function publishBlockRealtimeUpdates({ candles = [], trades = [] }) {
  const summary = {
    candleMessages: 0,
    tradeMessages: 0,
  };

  for (const trade of trades) {
    const published = await publishJson(`trades:${trade.poolId}`, {
      data: trade,
      stream: 'trade',
    });

    if (published) {
      summary.tradeMessages += 1;
    }
  }

  for (const candle of candles) {
    const published = await publishJson(`candles:1m:${candle.poolId}`, {
      data: candle,
      stream: 'candle_1m',
    });

    if (published) {
      summary.candleMessages += 1;
    }
  }

  return summary;
}

module.exports = {
  publishBlockRealtimeUpdates,
};
