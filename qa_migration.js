const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });
const { Client } = require('pg');

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
    console.log("Applying QA Schema Migration...");
    
    await client.query(`ALTER TABLE stark_trades ADD COLUMN IF NOT EXISTS amount_in_human NUMERIC(78,30);`);
    await client.query(`ALTER TABLE stark_trades ADD COLUMN IF NOT EXISTS amount_out_human NUMERIC(78,30);`);
    
    console.log("Migration Successful: amount_in_human & amount_out_human added to stark_trades.");

  } catch (error) {
    console.error("Migration Error:", error.message);
  } finally {
    await client.end();
  }
})();
