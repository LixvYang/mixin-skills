#!/usr/bin/env node
/**
 * Mixin Safe — List Recent Snapshots
 *
 * Fetches the latest Safe snapshots for the bot's account.
 *
 * Usage:
 *   node safe-snapshots.mjs --config=mixin-bot.json [--limit=20] [--asset=ASSET_ID]
 */

import { readFileSync } from "fs";
import { MixinApi } from "@mixin.dev/mixin-node-sdk";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.join("=")];
  })
);

if (!args.config) {
  console.error("Usage: node safe-snapshots.mjs --config=mixin-bot.json [--limit=20] [--asset=ASSET_ID]");
  process.exit(1);
}

const keystore = JSON.parse(readFileSync(args.config, "utf8"));
const client = MixinApi({ keystore });

const snaps = await client.safe.fetchSafeSnapshots({
  asset: args.asset || undefined,
  limit: parseInt(args.limit || "20", 10),
  // RFC3339NANO
  // offset: new Date().toISOString(), // fetch latest
});

console.log(`Snapshots (${snaps.length}):\n`);
for (const s of snaps) {
  console.log(`  ${s.created_at}`);
  console.log(`  amount: ${s.amount}  asset: ${s.asset_id}`);
  if (s.opponent_id) console.log(`  from: ${s.opponent_id}`);
  if (s.memo) console.log(`  memo: ${s.memo}`);
  console.log(`  tx: ${s.transaction_hash}`);
  console.log();
}
