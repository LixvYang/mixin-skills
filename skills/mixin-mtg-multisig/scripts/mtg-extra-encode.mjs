#!/usr/bin/env node
/**
 * MTG — Encode Extra Payload
 *
 * Encodes an MTG operation extra (app_id + memo) into the base64 format
 * used in Safe transactions. Also reports the encoded byte count.
 *
 * Usage:
 *   node mtg-extra-encode.mjs --app=APP_ID --memo=hex_or_text
 *
 * Examples:
 *   node mtg-extra-encode.mjs --app=COMPUTER_APP_ID --memo="hello"
 *   node mtg-extra-encode.mjs --app=COMPUTER_APP_ID --memo="deadbeef" --memo-is-hex
 */

import { MixinApi, base64RawURLEncode } from "@mixin.dev/mixin-node-sdk";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.join("=")];
  })
);

if (!args.app || !args.memo) {
  console.error("Usage: node mtg-extra-encode.mjs --app=APP_ID --memo=payload [--memo-is-hex]");
  process.exit(1);
}

const appID = args.app.replace(/-/g, "");
if (appID.length !== 32) {
  console.error("app_id must be a UUID (32 hex chars without dashes)");
  process.exit(1);
}

const memoBuf = args["memo-is-hex"]
  ? Buffer.from(args.memo, "hex")
  : Buffer.from(args.memo, "utf8");

const appBytes = Buffer.from(appID, "hex");
const extra = Buffer.concat([appBytes, memoBuf]);
const encoded = base64RawURLEncode(new Uint8Array(extra));

console.log("App ID        :", args.app);
console.log("Memo bytes    :", memoBuf.length);
console.log("Total bytes   :", extra.length);
console.log("Extra (base64):", encoded);
console.log(`\nKernel limit: 256 bytes — ${extra.length <= 256 ? "✓ within limit" : "✗ exceeds limit, use storage pattern"}`);
