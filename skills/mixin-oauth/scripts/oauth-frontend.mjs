#!/usr/bin/env node
/**
 * Mixin OAuth — frontend PKCE flow (no client_secret)
 *
 * Usage:
 *   node oauth-frontend.mjs --app=APP_ID [--scope="PROFILE:READ ASSETS:READ"]
 *
 * Connects to wss://blaze.mixin.one, prints a mixin://codes/... URL (scan it
 * with the Mixin app), then prints the resulting OAuthKeystore to stdout.
 */

import { createRequire } from "module";
const require = createRequire(import.meta.url);

import {
  MixinApi,
  getChallenge,
  getED25519KeyPair,
  base64RawURLEncode,
} from "@mixin.dev/mixin-node-sdk";
import { v4 as uuid } from "uuid";
import pako from "pako";
import WebSocket from "ws";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.join("=")];
  })
);

const APP_ID = args.app;
const SCOPE = args.scope ?? "PROFILE:READ";

if (!APP_ID) {
  console.error("Usage: node oauth-frontend.mjs --app=APP_ID [--scope='PROFILE:READ ASSETS:READ']");
  process.exit(1);
}

const { verifier, challenge } = getChallenge();
const { seed, publicKey } = getED25519KeyPair();

console.log("PKCE verifier  :", verifier.slice(0, 12) + "...");
console.log("Ed25519 pubkey :", base64RawURLEncode(publicKey).slice(0, 20) + "...");
console.log("Scope          :", SCOPE);
console.log("\nConnecting to Mixin WebSocket...\n");

const ws = new WebSocket("wss://blaze.mixin.one", "Mixin-OAuth-1");

let lastAuthorizationId = "";
let handled = false;

const send = (msg) => ws.send(pako.gzip(JSON.stringify(msg)));

const refreshCode = (authorizationId = "") => {
  send({
    id: uuid().toUpperCase(),
    action: "REFRESH_OAUTH_CODE",
    params: {
      client_id: APP_ID,
      scope: SCOPE,
      code_challenge: challenge,
      authorization_id: authorizationId,
    },
  });
};

ws.on("open", () => refreshCode());

ws.on("message", async (data) => {
  if (handled) return;

  const msg = JSON.parse(pako.ungzip(data, { to: "string" }));
  const d = msg.data;
  if (!d) return;

  if (d.code_id && !d.authorization_code) {
    console.log("Scan this URL in Mixin app:");
    console.log("  mixin://codes/" + d.code_id);
    console.log("\nWaiting for user to approve...");
    lastAuthorizationId = d.authorization_id ?? "";
    setTimeout(() => {
      if (!handled) refreshCode(lastAuthorizationId);
    }, 2000);
    return;
  }

  if (d.authorization_code?.length > 16) {
    handled = true;
    ws.close();

    console.log("\nAuthorization code received. Exchanging for token...");

    const client = MixinApi();
    const { scope, authorization_id } = await client.oauth.getToken({
      client_id: APP_ID,
      code: d.authorization_code,
      ed25519: base64RawURLEncode(publicKey),
      code_verifier: verifier,
    });

    const keystore = {
      app_id: APP_ID,
      scope,
      authorization_id,
      session_private_key: seed.toString("hex"),
    };

    console.log("\n--- OAuthKeystore (save this, keep session_private_key secret) ---");
    console.log(JSON.stringify(keystore, null, 2));

    // Fetch profile to confirm it works
    const userClient = MixinApi({ keystore });
    const me = await userClient.user.profile();
    console.log("\n--- User Profile ---");
    console.log("user_id        :", me.user_id);
    console.log("full_name      :", me.full_name);
    console.log("identity_number:", me.identity_number);
  }
});

ws.on("error", (err) => {
  console.error("WebSocket error:", err.message);
  process.exit(1);
});
