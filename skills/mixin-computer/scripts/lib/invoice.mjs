/**
 * Invoice entry payment helpers.
 *
 * A Computer system call is submitted as a Mixin invoice with two entries:
 *   [0] storage entry  — stores the serialized Solana transaction bytes
 *   [1] system-call entry — carries the Computer extra and references entry [0]
 *
 * Entries must be paid in order; each entry's `index_references` become
 * actual Safe tx hashes before the next entry is submitted.
 */

import { isStorageEntry, getRecipientForStorage } from "@mixin.dev/mixin-node-sdk";
import { sendSafeTxWithRetry } from "./safe-tx.mjs";

/**
 * Pay all entries of a Mixin invoice in order.
 *
 * @param {ReturnType<import("@mixin.dev/mixin-node-sdk").MixinApi>} client
 * @param {string} spendKey
 * @param {string} senderUserId
 * @param {import("@mixin.dev/mixin-node-sdk").MixinInvoice} invoice
 * @returns {Promise<string[]>} ordered list of submitted Safe tx hashes
 */
export async function payInvoiceEntries(client, spendKey, senderUserId, invoice) {
  const txHashes = [];

  for (const [index, entry] of invoice.entries.entries()) {
    console.log(`  Entry ${index + 1}/${invoice.entries.length}: ${entry.amount} ${entry.asset_id}`);

    const references = [
      ...entry.hash_references,
      ...entry.index_references.map((ref) => {
        const hash = txHashes[ref];
        if (!hash) throw new Error(`Invoice entry ${index} references unpaid entry ${ref}`);
        return hash;
      }),
    ];

    const recipient = isStorageEntry(entry)
      ? getRecipientForStorage(entry.extra)
      : { mixAddress: invoice.recipient, amount: entry.amount };

    const hash = await sendSafeTxWithRetry(
      client,
      spendKey,
      senderUserId,
      entry.asset_id,
      [recipient],
      entry.extra,
      references,
      entry.trace_id
    );

    txHashes.push(hash);
  }

  return txHashes;
}
