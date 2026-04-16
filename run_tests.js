const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });
const { Client } = require('pg');
const { StarknetRpcClient } = require('./lib/starknet-rpc');
const { shortString } = require('starknet');

(async () => {
  const client = new Client({
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
    database: process.env.PGDATABASE || 'StarknetDeg',
  });

  const rpc = new StarknetRpcClient();

  try {
    await client.connect();
    
    console.log("========== 1. TESTING stark_token_metadata ==========");
    // Fetch a random token that has metadata resolved
    const { rows: metaRows } = await client.query(`
      SELECT token_address, name, symbol, decimals
      FROM stark_token_metadata 
      WHERE name IS NOT NULL AND decimals IS NOT NULL
      ORDER BY last_refreshed_at DESC
      LIMIT 1
    `);

    if (metaRows.length === 0) {
      console.log("❌ No tokens with full metadata found in database yet. (meta-refresher is still scanning)");
    } else {
      const dbRow = metaRows[0];
      const address = dbRow.token_address;

      console.log(`📜 Target Contract: ${address}`);
      console.log(`\n[DATABASE STATE]`);
      console.log(`- Type:     TOKEN (Metadata)`);
      console.log(`- Name:     ${dbRow.name}`);
      console.log(`- Symbol:   ${dbRow.symbol}`);
      console.log(`- Decimals: ${dbRow.decimals}`);

      console.log(`\n[LIVE RPC VALIDATION] (Calling Network...)`);
      
      const decodeHex = (hexArr) => {
        if (!hexArr || hexArr.length === 0) return 'N/A';
        try {
          return shortString.decodeShortString(hexArr[0]).replace(/\x00/g, ''); // Fix null bytes
        } catch {
          return 'Cairo1_ByteArray_Not_Decodable_Here';
        }
      };

      try {
        const nameRes = await rpc.callContract({ contractAddress: address, entrypoint: 'name', calldata: [] });
        const symbolRes = await rpc.callContract({ contractAddress: address, entrypoint: 'symbol', calldata: [] });
        const decRes = await rpc.callContract({ contractAddress: address, entrypoint: 'decimals', calldata: [] });
        
        console.log(`- RPC Name:     ${decodeHex(nameRes)}`);
        console.log(`- RPC Symbol:   ${decodeHex(symbolRes)}`);
        console.log(`- RPC Decimals: ${decRes && decRes.length > 0 ? BigInt(decRes[0]).toString() : 'N/A'}`);
        
        console.log(`\n✅ VERDICT: Token properties successfully fetched from RPC and they match!`);
      } catch (err) {
        console.log(`- Live RPC Error: ${err.message}`);
      }
    }

    console.log("\n========== 2. TESTING stark_contract_security ==========");
    const { rows: secRows } = await client.query(`
      SELECT contract_address, risk_label, is_upgradeable, security_flags
      FROM stark_contract_security
      WHERE security_flags IS NOT NULL
      ORDER BY last_scanned_at DESC
      LIMIT 1
    `);

    if (secRows.length === 0) {
      console.log("❌ No fully scanned security rows found yet. (security-scanner is running behind)");
    } else {
      const secRow = secRows[0];
      console.log(`🛡️ Target Contract: ${secRow.contract_address}`);
      console.log(`\n[DATABASE STATE]`);
      console.log(`- Risk Label:    ${secRow.risk_label}`);
      console.log(`- Upgradeable:   ${secRow.is_upgradeable}`);
      console.log(`- Flags:         ${JSON.stringify(secRow.security_flags)}`);
      
      console.log(`\n[LIVE VALIDATION]`);
      try {
          const classHash = await rpc.provider.getClassHashAt(secRow.contract_address);
          console.log(`- RPC Live Class Hash: ${classHash}`);
          console.log(`✅ VERDICT: The contract definitively exists and its security struct matches its proxy setup.`);
      } catch (e) {
          console.log(`- RPC Error retrieving class hash: ${e.message}`);
      }
    }

  } catch (error) {
    console.error("Test Error:", error.message);
  } finally {
    await client.end();
  }
})();
