I checked one real live row from stark_trades. This is the latest sample:

trade_key: 0x072782d1a364b95950a347218603cc959b54cfeeddaa47d032a0b491a60324bc:1
protocol: ekubo
block_number: 8613934
source_event_index: 1
token0: USDC
token1: ETH
amount0_delta: -284732086
amount1_delta: 130447609821294080
amount_in: 130447609821294080
amount_out: 284732086
pool_id: token0:token1:fee:tickSpacing:extension style Ekubo pool key
How this row is built

Raw event first enters the decode pipeline in event-router.js.
Because this tx is Ekubo, it goes into Ekubo decoder at ekubo.js in decodeSwapped(...).
In that function:
pool key is decoded from event data by ekubo.js
swap params are decoded by ekubo.js
signed deltas are decoded by ekubo.js
Then normalized swap action is built in ekubo.js.
There:
amount0 is assigned at ekubo.js
amount1 is assigned at ekubo.js
poolId is assigned at ekubo.js
Ekubo pool_id string itself is built in normalize.js. It joins:
token0
token1
fee
tickSpacing
extension
Then how it reaches stark_action_norm

The normalized action is inserted by event-router.js.
In that insert:
pool_id goes in at event-router.js
amount0 goes in at event-router.js
amount1 goes in at event-router.js
For this same sample, stark_action_norm has:

action_type = swap
amount0 = -284732086
amount1 = 130447609821294080
Then how stark_trades is built

Trade builder loads swap actions from stark_action_norm in trades.js.
Each action is converted into a trade in trades.js deriveTrade(...).
The important logic is trades.js determineTradeDirection(...).
That function says:

if amount0 > 0 and amount1 < 0
token0 was input
token1 was output
if amount0 < 0 and amount1 > 0
token1 was input
token0 was output
In your sample:

amount0_delta = -284732086
amount1_delta = 130447609821294080
So branch 2 applies:

user gave token1 = ETH
user received token0 = USDC
That is why:

amount_in = amount1_delta = 130447609821294080
amount_out = abs(amount0_delta) = 284732086
Those assignments happen here:

amountIn in trades.js
amountOut in trades.js
pool_id copied into trade in trades.js
final DB insert happens in trades.js
So are amount0/amount1 and amount_in/amount_out the same?
No.

amount0 and amount1 are signed deltas in fixed pool token order: token0, token1
amount_in and amount_out are unsigned user-facing trade amounts after direction detection
In this sample:

amount0_delta = -284732086 means pool lost USDC
amount1_delta = 130447609821294080 means pool gained ETH
therefore trader paid ETH and got USDC
So numerically:

amount_in equals the positive delta side
amount_out equals the absolute value of the negative delta side