#!/usr/bin/env node
/**
 * Mixin Computer — Submit System Call (Demo)
 *
 * Submits a minimal Solana transaction via Computer: nonce advance + memo
 * instruction. Demonstrates the full invoice flow without external Solana
 * program dependencies.
 *
 * Usage:
 *   node submit-system-call.mjs --config=keystore.json
 *
 * The bot's MIX address is derived from the keystore app_id automatically.
 *
 * Optional:
 *   SOLANA_RPC_URL=https://api.mainnet-beta.solana.com  (default)
 *
 * Flow:
 *   1. Fetch Computer info + registered user
 *   2. Lock nonce account from Computer
 *   3. Build Solana tx: nonceAdvance + memo
 *   4. Quote SOL fee (skipped if authority already has enough SOL)
 *   5. Build Mixin invoice: storage entry + system-call entry
 *   6. Submit invoice entries in order (with UTXO retry)
 *   7. Poll GET /system_calls/:id until confirmed
 *
 * Reference: fluxor_earn2/scripts/init-marginfi-account.ts
 */

import {
  MixinApi,
  attachInvoiceEntry,
  attachStorageEntry,
  buildComputerExtra,
  buildMixAddress,
  buildSystemCallExtra,
  checkSystemCallSize,
  encodeMtgExtra,
  estimateStorageCost,
  getInvoiceString,
  newMixinInvoice,
  OperationTypeSystemCall,
  uniqueConversationID,
  XINAssetID,
} from "@mixin.dev/mixin-node-sdk";
import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import BigNumber from "bignumber.js";

import { computerApi } from "./lib/computer-api.mjs";
import { payInvoiceEntries } from "./lib/invoice.mjs";
import { loadKeystore, parseArgs } from "./lib/keystore.mjs";

// Memo program stable address (mainnet + devnet)
const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

const POLL_INTERVAL_MS = 10_000;
const POLL_TIMEOUT_MS = 5 * 60_000;

async function main() {
  const args = parseArgs();
  if (!args.config) {
    console.error("Usage: node submit-system-call.mjs --config=keystore.json");
    process.exit(1);
  }

  const ks = loadKeystore(args);
  const client = MixinApi({
    keystore: {
      app_id: ks.app_id,
      session_id: ks.session_id,
      session_private_key: ks.session_private_key,
      server_public_key: ks.server_public_key,
    },
  });

  const botMix = buildMixAddress({ version: 2, xinMembers: [], uuidMembers: [ks.app_id], threshold: 1 });
  const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";

  // 1. Fetch Computer info + registered user
  console.log("Fetching Computer info and registered user...");
  const [info, cu] = await Promise.all([
    computerApi.info(),
    computerApi.user(botMix).catch(() => null),
  ]);

  if (!cu?.id) {
    console.error("Bot is not registered with Computer. Run register-computer.mjs first.");
    process.exit(1);
  }

  console.log(`  Computer UID:   ${cu.id}`);
  console.log(`  Solana address: ${cu.chain_address}`);
  console.log(`  Computer payer: ${info.payer}`);

  // 2. Lock nonce account
  console.log("\nLocking nonce account...");
  const nonce = await computerApi.getNonce(botMix);
  console.log(`  Nonce address: ${nonce.nonce_address}`);
  console.log(`  Nonce hash:    ${nonce.nonce_hash}`);

  // 3. Build Solana transaction: nonceAdvance + memo
  const computerPayer = new PublicKey(info.payer);
  const noncePubkey = new PublicKey(nonce.nonce_address);

  const nonceAdvanceIx = SystemProgram.nonceAdvance({
    noncePubkey,
    authorizedPubkey: computerPayer,
  });

  const memoIx = new TransactionInstruction({
    keys: [],
    programId: MEMO_PROGRAM_ID,
    data: Buffer.from("hello from mixin-skills", "utf-8"),
  });

  const message = new TransactionMessage({
    payerKey: computerPayer,
    recentBlockhash: nonce.nonce_hash,
    instructions: [nonceAdvanceIx, memoIx],
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  const txBuf = Buffer.from(tx.serialize());

  console.log(`\nSolana tx size: ${txBuf.length} bytes`);
  if (!checkSystemCallSize(txBuf)) {
    throw new Error(`Transaction too large for Computer system call: ${txBuf.length} bytes`);
  }

  // 4. Quote SOL fee if the Computer authority needs SOL top-up
  // (memo instruction doesn't create new accounts, so fee is usually 0)
  const connection = new Connection(rpcUrl, "confirmed");
  const authority = new PublicKey(cu.chain_address);
  const authorityLamports = BigInt(await connection.getBalance(authority, "confirmed"));
  const reserveLamports = BigInt(await connection.getMinimumBalanceForRentExemption(0));
  const topUpLamports = reserveLamports > authorityLamports ? reserveLamports - authorityLamports : 0n;

  let fee;
  if (topUpLamports > 0n) {
    const solAmount = lamportsToSol(topUpLamports);
    console.log(`  Authority needs ${solAmount} SOL top-up — quoting fee...`);
    fee = await computerApi.getFee(solAmount);
    console.log(`  Fee: ${fee.xin_amount} XIN (fee_id: ${fee.fee_id})`);
  } else {
    console.log("  Authority has enough SOL — no fee needed");
  }

  // 5. Build Computer system-call extra
  const callId = uniqueConversationID(txBuf.toString("hex"), "system call");
  const callPayload = buildSystemCallExtra(cu.id, callId, false, fee?.fee_id);
  const memo = buildComputerExtra(OperationTypeSystemCall, callPayload);
  const extraBuf = Buffer.from(encodeMtgExtra(info.members.app_id, memo), "utf-8");

  const totalXin = new BigNumber(info.params.operation.price)
    .plus(fee?.xin_amount ?? "0")
    .toFixed(8, BigNumber.ROUND_CEIL);
  const storageCost = estimateStorageCost(txBuf).toFixed(8);

  console.log(`\n  call_id:      ${callId}`);
  console.log(`  total XIN:    ${totalXin} (operation) + ${storageCost} (storage)`);

  // 6. Build Mixin invoice: [0] storage entry, [1] system-call fee entry
  const computerRecipient = buildMixAddress({
    version: 2,
    xinMembers: [],
    uuidMembers: info.members.members,
    threshold: info.members.threshold,
  });

  const invoice = newMixinInvoice(computerRecipient);
  if (!invoice) throw new Error("Failed to build Computer invoice");

  attachStorageEntry(invoice, uniqueConversationID(callId, "storage"), txBuf);
  attachInvoiceEntry(invoice, {
    trace_id: callId,
    asset_id: XINAssetID,
    amount: totalXin,
    extra: extraBuf,
    index_references: [0],  // system-call tx references the storage tx
    hash_references: [],
  });

  console.log(`\nInvoice URL:    https://mixin.one/pay/${getInvoiceString(invoice)}`);
  console.log(`System call:    https://computer.mixin.one/system_calls/${callId}`);

  // Check XIN balance covers storage + operation price
  const xinOutputs = await client.utxo.safeOutputs({
    members: [ks.app_id],
    threshold: 1,
    asset: info.params.operation.asset,
    state: "unspent",
  });
  const xinBalance = xinOutputs.reduce((s, o) => s.plus(o.amount), new BigNumber(0));
  const needed = new BigNumber(totalXin).plus(storageCost);
  console.log(`\nXIN balance: ${xinBalance.toFixed(8)} (need ~${needed.toFixed(8)})`);
  if (xinBalance.lt(needed)) {
    console.error(`Insufficient XIN. Transfer at least ${needed.toFixed(8)} XIN to the bot (${ks.app_id}).`);
    process.exit(1);
  }

  // 7. Submit invoice entries in order
  console.log("\nSubmitting invoice entries...");
  const txHashes = await payInvoiceEntries(client, ks.spend_key, ks.app_id, invoice);
  console.log(`  Storage tx:     ${txHashes[0]}`);
  console.log(`  System-call tx: ${txHashes[1]}`);

  // 8. Poll until Computer confirms the system call
  console.log(`\nWaiting for Computer to execute system call...`);
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    try {
      const sc = await computerApi.systemCall(callId);
      process.stdout.write(`\r  state: ${sc.state}        `);
      if (sc.state === "done" || sc.state === "confirmed") {
        process.stdout.write("\n");
        console.log("\nSystem call confirmed!");
        if (sc.hash) console.log(`Solana tx: ${sc.hash}`);
        return;
      }
      if (sc.state === "failed") {
        process.stdout.write("\n");
        console.error(`System call failed: ${sc.error ?? "(no details)"}`);
        if (sc.subs?.length) {
          for (const sub of sc.subs) {
            if (sub.error) console.error(`  sub: ${sub.error}`);
          }
        }
        process.exit(1);
      }
    } catch {
      // system call not yet visible — MTG still processing
    }
  }

  console.error(`\nTimed out. Check: https://computer.mixin.one/system_calls/${callId}`);
  process.exit(1);
}

function lamportsToSol(lamports) {
  const LAMPORTS_PER_SOL = 1_000_000_000n;
  const whole = lamports / LAMPORTS_PER_SOL;
  const fraction = (lamports % LAMPORTS_PER_SOL).toString().padStart(9, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error("Fatal:", e.message ?? e);
  process.exit(1);
});
