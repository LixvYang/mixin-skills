#!/usr/bin/env node
/**
 * MTG — Decode Extra Payload
 *
 * Decodes a base64-encoded MTG extra back into app_id + memo.
 *
 * Usage:
 *   node mtg-extra-decode.mjs --extra=BASE64_ENCODED
 *
 * Example:
 *   node mtg-extra-decode.mjs --extra="Ae1qS0bL8E...=="
 */

import { decodeBase64 } from "@mixin.dev/mixin-node-sdk";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.join("=")];
  })
);

if (!args.extra) {
  console.error("Usage: node mtg-extra-decode.mjs --extra=BASE64_ENCODED");
  process.exit(1);
}

const raw = decodeBase64(args.extra);
const appBytes = raw.slice(0, 16);
const memoBytes = raw.slice(16);

function bytesToUUID(b) {
  const hex = Buffer.from(b).toString("hex");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

console.log("Decoded MTG Extra:\n");
console.log("App ID    :", bytesToUUID(appBytes));
console.log("Memo bytes:", memoBytes.length);
console.log("Memo (hex):", Buffer.from(memoBytes).toString("hex"));
try {
  const text = new TextDecoder().decode(memoBytes);
  console.log("Memo (text):", text.replace(/[\x00-\x1f]/g, "·"));
} catch {}
