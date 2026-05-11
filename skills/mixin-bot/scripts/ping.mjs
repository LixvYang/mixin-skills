#!/usr/bin/env node
/**
 * Mixin Bot — Ping (keystore validation)
 *
 * Loads a keystore, creates an authenticated client, and fetches the bot's
 * own profile. Use this to confirm your keystore is valid.
 *
 * Usage:
 *   node ping.mjs --config=mixin-bot.json
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
  console.error("Usage: node ping.mjs --config=mixin-bot.json");
  process.exit(1);
}

const keystore = JSON.parse(readFileSync(args.config, "utf8"));
console.log("app_id:", keystore.app_id);

const client = MixinApi({ keystore });
const me = await client.user.profile();

console.log("\n--- Bot Profile ---");
console.log("user_id        :", me.user_id);
console.log("full_name      :", me.full_name);
console.log("identity_number:", me.identity_number);
console.log("avatar_url     :", me.avatar_url);
console.log("\n✓ Keystore is valid");
