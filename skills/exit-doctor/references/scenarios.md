# Explicit state scenarios

Scenarios answer a conditional question under specified assumptions. Keep them separate from captured quotes and wallet-call simulations. The native scenario engine is a static V2 reserve model; it does not actually call LP burns, rival-wallet sales, or future transactions.

## Another sale occurs first

Apply the stated raw X input to the captured pool, compute its output with integer math, and update reserves to include the full input and subtract the output. Then calculate the user's sale using those changed reserves. Do not reuse the original quote for the second trade.

State who supplied the hypothetical size. If naming an actual wallet, verify its relevant current holdings and distinguish owner/controller hypotheses from addresses. A prior Autopsy transfer delta is not an ending balance. Do not assume that the actor sells, chooses this route, or executes before the user.

## Proportional liquidity removal

For a specified removal fraction, reduce both reserve sides proportionally with explicit integer rounding, then quote the user's sale. This models proportional withdrawal from a homogeneous V2 pool. It is not a proof that anyone can withdraw that liquidity, an exact LP-burn execution simulation, or a concentrated-liquidity range model.

Do not reduce only the output reserve and call it an LP withdrawal. Do not infer withdrawal fractions from a wallet's token inventory. Verify LP-share ownership/locks and the actual mechanism before attributing a possible withdrawal to an address.

## Buy then sell

Start with an explicit Y input. Swap it into X with the reverse pool orientation. Add the full Y input and subtract the acquired X. Then sell exactly the acquired X through the post-buy pool. Include both embedded fees and each trade's rounding.

Display initial Y spend, acquired X, returned Y, and loss before additional costs. Do not call this realized profit or a future exit estimate. If the first leg yields zero units, no valid round trip exists. Taxes, changing fees, other transactions, and route changes are outside the simple model.

## Shared liquidity and time

Alternative routes sharing a pool cannot be added as independent capacity. Splitting a trade requires a joint sequence against shared state. A multi-pool portfolio needs order-aware simulation; the native one-pool analyzer does not optimize it.

Every model scenario begins from the same captured base unless explicitly labeled sequential. Independent size rows also reset to base. Record the hypothetical order and avoid presenting scenario outputs as observations at the original block.

## Use with Autopsy

Consume an available autopsy.report.v1 report as sourced context. Match exact chain and token; inspect its cutoff, coverage, evidence, and claim kinds. Recheck balances and venue state for the present decision. Choose a transparent address set, avoid overlapping cohort counts, and keep broader ownership scenarios separate from strict observed relationships.

A useful combined result is: “These addresses received the stated launch allocation. If a sale of Q units reaches this pool before your sale, the standard-pool model returns Y under the stated state and fee assumptions.” That statement neither asserts common control nor predicts the sale.
