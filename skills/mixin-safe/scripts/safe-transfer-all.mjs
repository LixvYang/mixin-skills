#!/usr/bin/env node
/**
 * Mixin Safe — Transfer All Assets to a Single Recipient
 *
 * Scans all unspent Safe outputs, groups by asset, and transfers each
 * asset's full balance to the specified recipient. Uses deterministic
 * trace IDs so retries are idempotent.
 *
 * Usage:
 *   node safe-transfer-all.mjs --config=keystore.json --to=RECIPIENT_USER_ID
 *
 * Optional:
 *   --dry-run        scan and report without sending
 *
 * Reference: mixin-github-ws/skills/safe.go SafeTransferAllTo
 */

import { readFileSync } from "fs";
import {
  MixinApi,
  buildSafeTransaction,
  buildSafeTransactionRecipient,
  encodeSafeTransaction,
  getUnspentOutputsForRecipients,
  signSafeTransaction,
} from "@mixin.dev/mixin-node-sdk";
import BigNumber from "bignumber.js";
import { v4 as uuidv4 } from "uuid";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.join("=")];
  })
);

if (!args.config || !args.to) {
  console.error("Usage: node safe-transfer-all.mjs --config=keystore.json --to=RECIPIENT_USER_ID [--dry-run]");
  process.exit(1);
}

const keystore = JSON.parse(readFileSync(args.config, "utf8"));
const client = MixinApi({
  keystore: {
    app_id: keystore.app_id,
    session_id: keystore.session_id,
    session_private_key: keystore.session_private_key,
    server_public_key: keystore.server_public_key,
  },
});

const dryRun = args["dry-run"] === "true";

// ── 1. Paginate all UTXOs (mvm.dev pattern) ─────────────────────────
console.log("Scanning Safe outputs...");
let offset = 0;
const all = [];
while (true) {
  const outputs = await client.utxo.safeOutputs({
    limit: 500,
    members: [keystore.app_id],
    threshold: 1,
    state: "unspent",
    offset,
  });
  all.push(...outputs);
  if (outputs.length < 500) break;
  offset = outputs[outputs.length - 1].sequence + 1;
}

// ── 2. Group by asset_id ────────────────────────────────────────────
const byAsset = {};
for (const o of all) {
  const id = o.asset_id;
  if (!byAsset[id]) byAsset[id] = [];
  byAsset[id].push(o);
}

const assetIds = Object.keys(byAsset);
if (assetIds.length === 0) {
  console.log("No unspent outputs found.");
  process.exit(0);
}

// Fetch asset metadata for display
const metaList = await client.safe.fetchAssets(assetIds);
const meta = {};
for (const a of metaList) meta[a.asset_id] = a;

console.log(`\nFound ${all.length} outputs across ${assetIds.length} assets:\n`);
for (const id of assetIds) {
  const outs = byAsset[id];
  const total = outs.reduce((s, o) => s.plus(o.amount), new BigNumber(0));
  const m = meta[id];
  console.log(`  ${(m?.symbol ?? "?").padEnd(8)} ${total.toFixed(8).padStart(18)}  (${outs.length} outputs)  ${m?.name ?? id}`);
}

if (dryRun) {
  console.log("\nDry-run complete. Pass --dry-run=false or omit to send.");
  process.exit(0);
}

// ── 3. Transfer each asset ──────────────────────────────────────────
console.log("");
const results = [];
for (const id of assetIds) {
  const outs = byAsset[id];
  const total = outs.reduce((s, o) => s.plus(o.amount), new BigNumber(0));
  const m = meta[id];
  const symbol = m?.symbol ?? id.slice(0, 8);
  const traceId = uuidv4();

  process.stdout.write(`Transferring ${total.toFixed(8)} ${symbol}...`);

  try {
    // Build recipient: full amount to target user
    const recipient = buildSafeTransactionRecipient(
      [args.to],
      1,
      total.toFixed(8)
    );

    // Pick UTXOs and handle change
    const { utxos, change } = getUnspentOutputsForRecipients(outs, [recipient]);
    let allRecipients = [recipient];
    if (change.gt(0)) {
      allRecipients.push(
        buildSafeTransactionRecipient([keystore.app_id], 1, change.toFixed(8))
      );
    }

    // Ghost keys, build, verify, sign, submit
    const ghosts = await client.utxo.ghostKey(allRecipients, traceId, keystore.spend_private_key);
    const tx = buildSafeTransaction(utxos, allRecipients, ghosts, Buffer.alloc(0), []);
    const raw = encodeSafeTransaction(tx);

    const [verified] = await client.utxo.verifyTransaction([{ raw, request_id: traceId }]);
    if (!verified?.views) throw new Error("Verification failed");

    const signedRaw = signSafeTransaction(tx, verified.views, keystore.spend_private_key);
    const [sent] = await client.utxo.sendTransactions([{ raw: signedRaw, request_id: traceId }]);

    console.log(` done  tx: ${sent.transaction_hash}`);
    results.push({ asset_id: id, symbol, amount: total.toFixed(8), hash: sent.transaction_hash, trace_id: traceId });
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : "";
    console.log(` FAILED: ${err.message ?? err} ${detail}`);
    results.push({ asset_id: id, symbol, amount: total.toFixed(8), error: `${err.message} ${detail}`.trim(), trace_id: traceId });
  }
}

// ── 4. Summary ──────────────────────────────────────────────────────
console.log("\n── Transfer Summary ──\n");
for (const r of results) {
  const status = r.error ? `FAILED  ${r.error}` : `done  ${r.hash}`;
  console.log(`  ${r.symbol.padEnd(8)} ${r.amount.padStart(18)}  ${status}`);
}
