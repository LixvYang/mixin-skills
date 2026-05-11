#!/usr/bin/env node
/**
 * Mixin Computer — Query User
 *
 * Looks up a Computer user by MIX address
 * Public API, no auth.
 *
 * Usage:
 *   node computer-user.mjs --address=MIX_ADDRESS
 */

import { computerApi } from "./lib/computer-api.mjs";
import { parseArgs } from "./lib/keystore.mjs";

const args = parseArgs();

if (!args.address) {
  console.error("Usage: node computer-user.mjs --address=MIX_ADDRESS_OR_UID_OR_SOLANA");
  process.exit(1);
}

try {
  const u = await computerApi.user(args.address);
  if (!u) {
    console.error("User not found:", args.address);
    process.exit(1);
  }
  console.log("Computer User:\n");
  console.log("UID           :", u.id ?? "?");
  console.log("MIX Address   :", u.mix_address ?? "?");
  console.log("Solana Address:", u.chain_address ?? "?");
} catch (err) {
  console.error("Error:", err.message);
  process.exit(1);
}
