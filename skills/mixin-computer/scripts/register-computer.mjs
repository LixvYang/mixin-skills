#!/usr/bin/env node
/**
 * Mixin Computer — Register Bot
 *
 * Registers a Mixin bot as a Computer user. The registration fee is paid
 * from the bot's own XIN Safe balance.
 *
 * Usage:
 *   node register-computer.mjs --config=keystore.json
 *
 * The script:
 *   1. Fetches Computer info (MTG members, operation price)
 *   2. Derives the bot's 1-of-1 MIX address
 *   3. Checks if already registered (idempotent)
 *   4. Builds AddUser extra and sends Safe transaction to Computer MTG
 *   5. Polls until Computer confirms the registration
 *
 * Reference: fluxor_earn2/scripts/register-computer.ts
 */

import { MixinApi, buildComputerExtra, buildMixAddress, buildSafeTransactionRecipient, encodeMtgExtra, OperationTypeAddUser } from "@mixin.dev/mixin-node-sdk";
import BigNumber from "bignumber.js";

import { computerApi } from "./lib/computer-api.mjs";
import { loadKeystore, parseArgs } from "./lib/keystore.mjs";
import { sendSafeTx } from "./lib/safe-tx.mjs";

const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS  = 120_000;

async function main() {
  const args = parseArgs();
  if (!args.config) {
    console.error("Usage: node register-computer.mjs --config=keystore.json");
    process.exit(1);
  }

  // 1. Load keystore
  const ks = loadKeystore(args);
  const client = MixinApi({
    keystore: {
      app_id: ks.app_id,
      session_id: ks.session_id,
      session_private_key: ks.session_private_key,
      server_public_key: ks.server_public_key,
    },
  });
  console.log("Bot app_id:", ks.app_id);

  // 2. Fetch Computer info
  console.log("\nFetching Computer info...");
  const info = await computerApi.info();
  console.log(`  MTG: ${info.members.members.length} members, threshold ${info.members.threshold}`);
  console.log(`  Registration: ${info.params.operation.price} XIN`);

  // 3. Derive bot's 1-of-1 MIX address
  const mixAddress = buildMixAddress({ version: 2, xinMembers: [], uuidMembers: [ks.app_id], threshold: 1 });
  console.log("\nBot MIX address:", mixAddress);

  // 4. Check if already registered
  console.log("\nChecking registration...");
  try {
    const existing = await computerApi.user(mixAddress);
    if (existing?.id) {
      console.log("Already registered!");
      console.log("  UID           :", existing.id);
      console.log("  MIX Address   :", existing.mix_address);
      console.log("  Solana Address:", existing.chain_address);
      return;
    }
  } catch {
    // 404 / error = not registered, continue
  }

  // 5. Build AddUser extra
  const memo = buildComputerExtra(OperationTypeAddUser, Buffer.from(mixAddress, "utf-8"));
  const extra = Buffer.from(encodeMtgExtra(info.members.app_id, memo), "utf-8");

  // 6. Pay the Computer MTG group
  const mtgRecipient = buildSafeTransactionRecipient(
    info.members.members,
    info.members.threshold,
    info.params.operation.price
  );

  // Check XIN balance
  const xinOutputs = await client.utxo.safeOutputs({
    members: [ks.app_id],
    threshold: 1,
    asset: info.params.operation.asset,
    state: "unspent",
  });
  const balance = xinOutputs.reduce((s, o) => s.plus(o.amount), new BigNumber(0));
  if (balance.lt(info.params.operation.price)) {
    console.error(`Insufficient XIN: have ${balance.toFixed(8)}, need ${info.params.operation.price}`);
    console.error(`Send XIN to bot: ${ks.app_id}`);
    process.exit(1);
  }

  console.log(`\nSending registration tx (${info.params.operation.price} XIN)...`);
  const txHash = await sendSafeTx(
    client,
    ks.spend_key,
    ks.app_id,
    info.params.operation.asset,
    [mtgRecipient],
    extra
  );
  console.log("Transaction submitted:", txHash);
  console.log("Waiting for Computer to process...");

  // 7. Poll until registration completes
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    try {
      const cu = await computerApi.user(mixAddress);
      if (cu?.id) {
        console.log("\nRegistration complete!");
        console.log("  UID           :", cu.id);
        console.log("  MIX Address   :", cu.mix_address);
        console.log("  Solana Address:", cu.chain_address);
        console.log("\nAdd to .env:");
        console.log(`  COMPUTER_UID=${cu.id}`);
        console.log(`  SOLANA_BOT_ADDRESS=${cu.chain_address}`);
        return;
      }
    } catch {
      // not yet ready
    }
    process.stdout.write(".");
  }

  console.error("\nTimed out. Check transaction on Mixin explorer.");
  process.exit(1);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error("Fatal:", e.message ?? e);
  process.exit(1);
});
