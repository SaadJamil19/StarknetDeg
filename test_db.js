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
    
    const { rows: finalityRows } = await client.query(`
      SELECT finality_status, COUNT(*) as count 
      FROM stark_block_journal 
      GROUP BY finality_status
    `);
    console.log("DB Block Finalities:", finalityRows);
    
    const { rows: laneRows } = await client.query(`
      SELECT lane, COUNT(*) as count 
      FROM stark_block_journal 
      GROUP BY lane
    `);
    console.log("DB Block Lanes:", laneRows);

  } catch (error) {
    console.error("DB Error:", error.message);
  } finally {
    await client.end();
  }
})();
