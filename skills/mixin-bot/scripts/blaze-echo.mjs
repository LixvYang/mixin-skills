#!/usr/bin/env node
/**
 * Mixin Bot — Blaze Echo Listener
 *
 * Connects to the Blaze WebSocket and echoes back any PLAIN_TEXT
 * messages it receives. Runs until Ctrl+C.
 *
 * Usage:
 *   node blaze-echo.mjs --config=mixin-bot.json
 */

import { readFileSync } from "fs";
import { MixinApi } from "@mixin.dev/mixin-node-sdk";
import { BlazeKeystoreClient } from "@mixin.dev/mixin-node-sdk/blaze";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.join("=")];
  })
);

if (!args.config) {
  console.error("Usage: node blaze-echo.mjs --config=mixin-bot.json");
  process.exit(1);
}

const keystore = JSON.parse(readFileSync(args.config, "utf8"));
const client = MixinApi({ keystore });

const handler = {
  onMessage: async (msg) => {
    console.log(`[${msg.category}] from ${msg.user_id}:`, msg.data_base64?.slice(0, 120));
    if (msg.category === "PLAIN_TEXT") {
      const text = Buffer.from(msg.data_base64, "base64").toString();
      await client.message.sendText(msg.user_id, `echo: ${text}`);
    }
  },
  onAckReceipt: async () => {},
};

console.log("Connecting to Blaze... (Ctrl+C to stop)");
const blaze = BlazeKeystoreClient(keystore, { parse: true, syncAck: true });
blaze.loop(handler);
