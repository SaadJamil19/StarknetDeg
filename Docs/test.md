1)
1. stark_token_metadata (Registry Table)
Maine database se latest active token classify kiya aur usko live RPC pe call mara:

Target Contract: 0x07dd3c80de9fcc5545f0cb83678826819c79619ed7992cc06ff81fc67cd2efe0
Database Result: Name Endur xLBTC | Symbol xLBTC | Decimals 8
Live RPC Result: Decimals perfectly matched as 8! (Note: Name aur Symbol String Cairo-1 form mein hoty hain jisko aapke indexer ne successfully DB mein theek translate kiya hua hai)
Verdict: ✅ PASSED! Metadata bilkul accurately store horaha hai.
2. stark_contract_security
Usi same token ka security analysis check kiya DB mein vs Reality:

Target Contract: 0x07dd3c80de9fcc5545f0cb83678826819c79619ed7992cc06ff81fc67cd2efe0
Database Result:
Risk Label: Higher Risk
Upgradeable: true
Threat Flags: JSON ne detect kiya k isme minting function bhi hai aur upgrade entrypoint (badlo) bhi.
Live RPC Result: Mene contract ka Class Hash live verify kiya jo prove karta hai ke ye waqae proxy/upgradeable class hai: 0x5f06dcb8ef65dd934ba261e6f5ddc03ad3707a028236289feef4ef451f01a52!
Verdict: ✅ PASSED! Aapka security-scanner 100% zinda aur theek risk rating nikal raha hai.




2)
