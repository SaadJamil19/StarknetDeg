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
    
    // Check distribution of multi_hop flags
    const { rows: stats } = await client.query(`
      SELECT is_multi_hop, COUNT(*) as count 
      FROM stark_trades 
      GROUP BY is_multi_hop
    `);
    console.log("Multi Hop Flags:", stats);

    const { rows: tHops } = await client.query(`
      SELECT total_hops, COUNT(*) as count 
      FROM stark_trades 
      GROUP BY total_hops
    `);
    console.log("Total Hops Distribution:", tHops);

  } catch (error) {
    console.error("DB Error:", error.message);
  } finally {
    await client.end();
  }
})();
