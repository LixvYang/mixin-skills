#!/usr/bin/env node
/**
 * Mixin Safe — Check Asset Balances
 *
 * Queries Safe UTXOs (paginated, following mvm.dev pattern) and aggregates
 * balances per asset. When no --asset is specified, lists all assets with
 * unspent outputs.
 *
 * Usage:
 *   node safe-balance.mjs --config=mixin-bot.json [--asset=ASSET_ID]
 */

import { readFileSync } from "fs";
import { MixinApi } from "@mixin.dev/mixin-node-sdk";
import BigNumber from "bignumber.js";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.join("=")];
  })
);

if (!args.config) {
  console.error("Usage: node safe-balance.mjs --config=mixin-bot.json [--asset=ASSET_ID]");
  process.exit(1);
}

const keystore = JSON.parse(readFileSync(args.config, "utf8"));
const client = MixinApi({ keystore });

// Paginated UTXO query (mvm.dev pattern)
const members = [keystore.app_id];
let offset = 0;
const all = [];
while (true) {
  const outputs = await client.utxo.safeOutputs({
    limit: 500,
    members,
    threshold: 1,
    state: "unspent",
    asset: args.asset || "",
    offset,
  });
  all.push(...outputs);
  if (outputs.length < 500) break;
  offset = outputs[outputs.length - 1].sequence + 1;
}

// Aggregate by asset_id
const byAsset = {};
for (const o of all) {
  const id = o.asset_id;
  if (!byAsset[id]) byAsset[id] = { asset_id: id, amount: new BigNumber(0), count: 0 };
  byAsset[id].amount = byAsset[id].amount.plus(o.amount);
  byAsset[id].count++;
}

// Fetch asset metadata for all found asset IDs (mvm.dev pattern)
const assetIds = Object.keys(byAsset);
const assets = assetIds.length ? await client.safe.fetchAssets(assetIds) : [];
const assetMeta = {};
for (const a of assets) {
  assetMeta[a.asset_id] = a;
}

if (args.asset) {
  const e = byAsset[args.asset];
  const meta = assetMeta[args.asset];
  console.log(`Asset: ${meta?.symbol ?? "?"} (${meta?.name ?? "?"})`);
  console.log(`Balance: ${e?.amount.toFixed(8) ?? "0"}`);
  console.log(`Outputs: ${e?.count ?? 0}`);
} else {
  console.log(`Balances (${assetIds.length} assets, ${all.length} total outputs):\n`);
  for (const id of assetIds) {
    const e = byAsset[id];
    const meta = assetMeta[id];
    console.log(`  ${(meta?.symbol ?? "?").padEnd(8)} ${e.amount.toFixed(8).padStart(18)}  (${e.count} outputs)  ${meta?.name ?? id}`);
  }
}
