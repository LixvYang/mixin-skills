#!/usr/bin/env node
/**
 * Mixin OAuth — backend client_secret flow
 *
 * Usage:
 *   node oauth-backend.mjs --config=mixin-bot.json --secret=CLIENT_SECRET --code=OAUTH_CODE
 *
 * Where OAUTH_CODE comes from your OAuth redirect callback (?code=xxx).
 * CLIENT_SECRET is from https://developers.mixin.one (separate from keystore).
 */

import { readFileSync } from "fs";
import { MixinApi } from "@mixin.dev/mixin-node-sdk";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.join("=")];
  })
);

const { config, secret, code } = args;

if (!secret || !code) {
  console.error("Usage: node oauth-backend.mjs --config=mixin-bot.json --secret=CLIENT_SECRET --code=OAUTH_CODE");
  process.exit(1);
}

let clientId;
if (config) {
  const ks = JSON.parse(readFileSync(config, "utf8"));
  clientId = ks.app_id;
  console.log(`Loaded keystore: app_id=${clientId}`);
} else {
  console.error("--config is required (keystore JSON with app_id)");
  process.exit(1);
}

const client = MixinApi();

console.log("\nExchanging OAuth code for access token...");
const { access_token, scope } = await client.oauth.getToken({
  client_id: clientId,
  client_secret: secret,
  code,
});

console.log("\n--- Token ---");
console.log("scope      :", scope);
console.log("access_token (first 40 chars):", access_token.slice(0, 40) + "...");

// Use the token to fetch the user's profile
const userClient = MixinApi({ keystore: { access_token } });
const me = await userClient.user.profile();

console.log("\n--- User Profile ---");
console.log("user_id        :", me.user_id);
console.log("full_name      :", me.full_name);
console.log("identity_number:", me.identity_number);
console.log("avatar_url     :", me.avatar_url);
