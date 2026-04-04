'use strict';

const { createClient } = require('redis');

let redisClientPromise;

async function getRedisClient() {
  const redisUrl = String(process.env.REDIS_URL ?? '').trim();

  if (!redisUrl) {
    return null;
  }

  if (!redisClientPromise) {
    redisClientPromise = (async () => {
      const client = createClient({ url: redisUrl });
      client.on('error', (error) => {
        console.error(`[realtime] redis error: ${error.message}`);
      });
      await client.connect();
      return client;
    })();
  }

  return redisClientPromise;
}

async function publishJson(channel, payload) {
  const client = await getRedisClient();

  if (!client) {
    return false;
  }

  await client.publish(channel, JSON.stringify(payload));
  return true;
}

async function closeRedis() {
  if (!redisClientPromise) {
    return;
  }

  const client = await redisClientPromise;
  redisClientPromise = undefined;
  await client.quit();
}

module.exports = {
  closeRedis,
  getRedisClient,
  publishJson,
};
