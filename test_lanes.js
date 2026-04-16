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
    
    // Check if 'lane' was updated in trades
    const { rows: trades } = await client.query(`
      SELECT lane, COUNT(*) as count 
      FROM stark_trades 
      GROUP BY lane
    `);
    console.log("Trades Lanes:", trades);

    // See if any table actually has finality_status besides the main 3
    const { rows: cols } = await client.query(`
      SELECT table_name 
      FROM information_schema.columns 
      WHERE column_name = 'finality_status'
    `);
    console.log("Tables with finality_status:", cols.map(r => r.table_name));

  } catch (error) {
    console.error("DB Error:", error.message);
  } finally {
    await client.end();
  }
})();
