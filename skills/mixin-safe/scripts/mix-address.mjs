#!/usr/bin/env node
/**
 * Mixin Safe — Create MIX Addresses
 *
 * Derives a MIX address from one or more member UUIDs.
 * No keystore needed.
 *
 * Usage:
 *   node mix-address.mjs --members=UUID1[,UUID2,...] [--threshold=2]
 */

import { buildMixAddress, parseMixAddress } from "@mixin.dev/mixin-node-sdk";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.join("=")];
  })
);

if (!args.members) {
  console.error("Usage: node mix-address.mjs --members=UUID1[,UUID2,...] [--threshold=2]");
  process.exit(1);
}

const members = args.members.split(",");
const threshold = parseInt(args.threshold || "1", 10);
const mix = buildMixAddress({
  version: 2,
  uuidMembers: members,
  xinMembers: [],
  threshold,
});

console.log(`\nMembers (${members.length}):`);
for (const m of members) console.log(`  - ${m}`);
console.log(`Threshold: ${threshold}`);
console.log(`\nMIX Address: ${mix}\n`);

// round-trip check
const parsed = parseMixAddress(mix);
const same = JSON.stringify(parsed.members.sort()) === JSON.stringify([...members].sort());
console.log(`Round-trip: ${same ? "✓ ok" : "✗ failed"}`);
