#!/usr/bin/env node
/**
 * Mixin Bot — Send Direct Message
 *
 * Sends a PLAIN_TEXT message or APP_CARD to a specific user.
 *
 * Usage:
 *   node send-direct.mjs --config=mixin-bot.json --to=USER_ID --text="hello"
 *   node send-direct.mjs --config=mixin-bot.json --to=USER_ID --card --title="Mixin" --desc="Hello" [--cover=URL] [--action=https://...]
 *
 * Action URLs can use Mixin-native schemas to avoid domain whitelisting:
 *   https://mixin.one        external URL (requires dashboard whitelist)
 *   mixin://send/            open send screen
 *   mixin://users/{uuid}     open user profile
 *   mixin://conversations/{uuid}  open conversation
 *   mixin://pay/{code}       open payment page
 *   input:share              trigger share sheet
 *   input:                     prefix for bot input commands
 */

import { readFileSync } from "fs";
import { MixinApi, base64RawURLEncode, uniqueConversationID } from "@mixin.dev/mixin-node-sdk";
import { v4 } from "uuid";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.length ? v.join("=") : "true"]; // boolean flags get value "true"
  })
);

if (!args.config || !args.to) {
  console.error("Usage:");
  console.error("  text: node send-direct.mjs --config=mixin-bot.json --to=USER_ID --text=message");
  console.error("  card: node send-direct.mjs --config=mixin-bot.json --to=USER_ID --card --title=X --desc=Y");
  process.exit(1);
}

const keystore = JSON.parse(readFileSync(args.config, "utf8"));
const client = MixinApi({ keystore });

if (args.card) {
  const card = {
    app_id: keystore.app_id,
    title: args.title || "Mixin Card",
    description: args.desc || args.text || "Desc",
    cover_url: args.cover,
    actions: [{ label: "Open", color: "#ABABAB", action: "https://mixin.one" }],
    shareable: true,
  };
  await client.message.sendLegacy({
    conversation_id: uniqueConversationID(keystore.app_id, args.to),
    recipient_id: args.to,
    message_id: v4(),
    category: "APP_CARD",
    data_base64: base64RawURLEncode(JSON.stringify(card)),
  });
  console.log("Sent app card to", args.to);
} else {
  await client.message.sendText(args.to, args.text);
  console.log("Sent direct message to", args.to);
}
