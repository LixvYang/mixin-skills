#!/usr/bin/env node
/**
 * Mixin Computer — Query Fees
 *
 * Quotes the XIN fee for a given SOL amount. Computer charges fees in XIN
 * based on the SOL amount needed for rent / execution.
 *
 * Usage:
 *   node query-fees.mjs --sol=0.01
 *   node query-fees.mjs --sol=0.1 --sol=0.5  (multiple amounts)
 */

import { computerApi } from "./lib/computer-api.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.join("=")];
  })
);

const solAmounts = args.sol
  ? [args.sol].flat()
  : ["0.001", "0.01", "0.1", "1"];

console.log("SOL Amount → XIN Fee\n");
for (const sol of solAmounts) {
  try {
    const fee = await computerApi.getFee(sol);
    console.log(`  ${sol.padStart(8)} SOL → ${(fee.xin_amount ?? "?").padStart(12)} XIN  (fee_id: ${fee.fee_id ?? "?"})`);
  } catch (err) {
    console.log(`  ${sol.padStart(8)} SOL → ERROR: ${err.message}`);
  }
}
