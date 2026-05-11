#!/usr/bin/env node
/**
 * Mixin Computer — Query Deployed Assets
 *
 * Lists assets deployed on Solana via Computer. Public API, no auth.
 *
 * Usage:
 *   node query-assets.mjs
 */

import { computerApi } from "./lib/computer-api.mjs";

const assets = await computerApi.assets();

if (!assets || assets.length === 0) {
  console.log("No deployed assets found.");
  process.exit(0);
}

console.log("Deployed Assets\n");
for (const a of assets) {
  console.log(`  ${(a.symbol ?? "?").padEnd(12)} ${a.name ?? "?"}`);
  console.log(`    Mixin Asset     : ${a.asset_id ?? "?"}`);
  console.log(`    Solana Address  : ${a.address ?? "?"}`);
  console.log(`    Decimals        : ${a.decimals ?? "?"}`);
  console.log(`    Price (USD)     : ${a.price_usd ?? "?"}`);
  console.log();
}
