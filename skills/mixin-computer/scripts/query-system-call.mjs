#!/usr/bin/env node
/**
 * Mixin Computer — Query System Call
 *
 * Checks the status of a submitted system call by its call ID.
 * Public API, no auth.
 *
 * Usage:
 *   node query-system-call.mjs --id=CALL_UUID
 *   node query-system-call.mjs --id=CALL_UUID --watch  (poll until done)
 */

import { computerApi } from "./lib/computer-api.mjs";
import { parseArgs } from "./lib/keystore.mjs";

const args = parseArgs();

if (!args.id) {
  console.error("Usage: node query-system-call.mjs --id=CALL_UUID [--watch]");
  process.exit(1);
}

const POLL_INTERVAL = 10_000;

async function showCall(id) {
  const sc = await computerApi.systemCall(id);
  if (!sc) {
    console.log("System call not found:", id);
    return null;
  }

  console.log("System Call:", id);
  console.log("  State      :", sc.state);
  console.log("  User ID    :", sc.user_id);
  console.log("  Nonce      :", sc.nonce_account);

  if (sc.hash) console.log("  Solana tx  :", sc.hash);
  if (sc.error) console.log("  Error      :", sc.error);
  if (sc.subs?.length) {
    console.log("  Sub-calls  :");
    for (const sub of sc.subs) {
      console.log(`    - state=${sub.state ?? "-"} hash=${sub.hash ?? "-"} err=${sub.error ?? "-"}`);
    }
  }

  return sc;
}

if (args.watch) {
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const sc = await showCall(args.id);
    if (!sc) process.exit(1);
    if (sc.state === "done" || sc.state === "confirmed" || sc.state === "failed") {
      process.exit(sc.state === "failed" ? 1 : 0);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
  console.error("Timed out waiting for system call.");
  process.exit(1);
} else {
  await showCall(args.id);
}
