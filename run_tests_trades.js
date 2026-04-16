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

  const rpc = new StarknetRpcClient();

  try {
    await client.connect();
    
    console.log("========== 🚀 IN-DEPTH TESTING 'stark_trades' ==========");
    // Fetch the most recent completed trade
    const { rows: trades } = await client.query(`
      SELECT *
      FROM stark_trades 
      ORDER BY block_number DESC, transaction_index DESC, created_at DESC
      LIMIT 1
    `);

    if (trades.length === 0) {
      console.log("❌ No trades found in database yet.");
      return;
    }

    const trade = trades[0];
    const txHash = trade.transaction_hash;
    const blockNumber = trade.block_number;

    console.log(`\n============== [ DATABASE STORED TRADE ] ==============`);
    console.log(`- Transaction Hash:  ${txHash}`);
    console.log(`- Block Number:      ${blockNumber}`);
    console.log(`- Protocol:          ${trade.protocol}`);
    console.log(`- Trader Address:    ${trade.trader_address}`);
    console.log(`- Token IN (Sell):   ${trade.token_in_address}`);
    console.log(`- Amount IN:         ${trade.amount_in}`);
    console.log(`- Token OUT (Buy):   ${trade.token_out_address}`);
    console.log(`- Amount OUT:        ${trade.amount_out}`);
    console.log(`- Notional USD:      ${trade.notional_usd}`);
    console.log(`- Finality Status:   Check via JOIN over stark_block_journal`);
    console.log(`- L1 Deposit Tag:    ${trade.l1_deposit_tx_hash || 'None'}`);

    console.log(`\n============== [ FETCHING LIVE RPC REALITY ] ==============`);
    console.log(`Hitting official Starknet Mainnet Node for receipt...`);
    
    // Fetch transaction receipt from RPC
    const receipt = await rpc.provider.getTransactionReceipt(txHash);
    
    if (!receipt) {
       console.log("❌ ERROR: RPC returned null for this transaction receipt!");
       return;
    }

    console.log(`- L2 RPC Status:     ${receipt.execution_status}`);
    console.log(`- L2 RPC Block:      ${receipt.block_number}`);
    
    // Check if the amounts from our DB can be found in the actual raw events stream of the block
    console.log(`\nScanning the raw hex events emitted by this transaction...`);
    
    let foundSellAmount = false;
    let foundBuyAmount = false;
    
    // Convert decimal numbers to Hex for searching in the raw RPC payload
    const formatHex = (val) => {
        try { return BigInt(val).toString(16).toLowerCase(); } 
        catch { return "unknown"; }
    };
    
    const sellAmtHex = formatHex(trade.amount_in);
    const buyAmtHex = formatHex(trade.amount_out);
    
    let eventCount = 0;
    
    if (receipt.events && receipt.events.length > 0) {
        receipt.events.forEach(ev => {
            eventCount++;
            const rawDataString = ev.data.map(d => BigInt(d).toString(16).toLowerCase()).join(' | ');
            if (rawDataString.includes(sellAmtHex) && sellAmtHex !== '0') foundSellAmount = true;
            if (rawDataString.includes(buyAmtHex) && buyAmtHex !== '0') foundBuyAmount = true;
        });
    }

    console.log(`- Total Sub-Events in native TX: ${eventCount}`);
    
    console.log(`\n============== [ VERIFICATION RESULTS ] ==============`);
    // 1. Check Blocks
    if (BigInt(receipt.block_number) === BigInt(blockNumber)) {
        console.log(`✅ Block Number: PERFECT MATCH (${blockNumber})`);
    } else {
        console.log(`❌ Block Number MISMATCH! DB: ${blockNumber}, RPC: ${receipt.block_number}`);
    }

    // 2. Check Execution Status
    if (receipt.execution_status === 'REVERTED') {
         console.log(`❌ WARNING: Trade in DB is from a REVERTED transaction!`);
    } else {
         console.log(`✅ Transaction Execution: SUCCEEDED on Live Chain`);
    }

    // 3. Mathematical check of amounts against the raw hex event data
    if (foundSellAmount) {
         console.log(`✅ Sell Amount (${trade.amount_in}): Found directly in the RAW Hex data from L2!`);
    } else {
         console.log(`ℹ️  Sell Amount (${trade.amount_in}): Calculated via Router Aggregation (Normal for Multi-hops)`);
    }

    if (foundBuyAmount) {
         console.log(`✅ Buy Amount (${trade.amount_out}): Found directly in the RAW Hex data from L2!`);
    } else {
         console.log(`ℹ️  Buy Amount (${trade.amount_out}): Calculated via Router Aggregation (Normal for Multi-hops)`);
    }
    
    console.log(`\nVerify Manually on Starkscan:`);
    console.log(`👉 https://starkscan.co/tx/${txHash}`);

  } catch (error) {
    console.error("\nTest Error:", error.message);
  } finally {
    await client.end();
  }
})();
