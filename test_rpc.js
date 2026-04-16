const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });
const { Client } = require('pg');
const { StarknetRpcClient } = require('./lib/starknet-rpc');

(async () => {
  const client = new Client({
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
    database: process.env.PGDATABASE || 'StarknetDeg',
  });

  try {
    await client.connect();
    
    // DB Bounds
    const { rows: bounds } = await client.query(`
      SELECT MIN(block_number) as min_db, MAX(block_number) as max_db
      FROM stark_block_journal
    `);
    console.log("DB Block Range:", bounds[0]);

    // RPC Bounds
    const rpc = new StarknetRpcClient();
    const l1Status = await rpc.provider.getBlock('latest');
    // We want the L1 tip. Easiest way in starknet.js is checking the latest block that is ACCEPTED_ON_L1. Wait.
    // Let's get the most recent block's number, maybe Starknet doesn't provide a direct API for L1 tip, but we can check if our min_db is ACCEPTED_ON_L1.
    const minDbBlock = await rpc.provider.getBlock(parseInt(bounds[0].min_db));
    console.log(`Min DB Block (${bounds[0].min_db}) RPC Status:`, minDbBlock.status);

  } catch (error) {
    console.error("DB Error:", error.message);
  } finally {
    await client.end();
  }
})();
