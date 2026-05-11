/**
 * Build, sign, and submit a Mixin Safe transaction.
 *
 * Ported from fluxor_earn2 patterns — reusable for Computer payments,
 * registration, and system-call fee entries.
 */

import {
  MixinApi,
  buildSafeTransaction,
  buildSafeTransactionRecipient,
  encodeSafeTransaction,
  getUnspentOutputsForRecipients,
  signSafeTransaction,
} from "@mixin.dev/mixin-node-sdk";

/**
 * @param {ReturnType<typeof MixinApi>} client
 * @param {string} spendKey
 * @param {string} senderUserId
 * @param {string} asset
 * @param {Array<{members: string[], threshold: number, amount: string}>} recipients
 * @param {Buffer} extra
 * @param {string[]} [references]
 * @param {string} [requestId]
 * @returns {Promise<string>} transaction hash
 */
export async function sendSafeTx(
  client,
  spendKey,
  senderUserId,
  asset,
  recipients,
  extra,
  references = [],
  requestId
) {
  if (!requestId) {
    const { v4: randomUUID } = await import("uuid");
    requestId = randomUUID();
  }

  const outputs = await client.utxo.safeOutputs({
    members: [senderUserId],
    threshold: 1,
    asset,
    state: "unspent",
  });

  const { utxos, change } = getUnspentOutputsForRecipients(outputs, recipients);

  let allRecipients = recipients;
  if (change.gt(0)) {
    allRecipients = [
      ...recipients,
      buildSafeTransactionRecipient([senderUserId], 1, change.toFixed(8)),
    ];
  }

  const ghosts = await client.utxo.ghostKey(allRecipients, requestId, spendKey);
  const tx = buildSafeTransaction(utxos, allRecipients, ghosts, extra, references);
  const raw = encodeSafeTransaction(tx);

  const [verified] = await client.utxo.verifyTransaction([{ raw, request_id: requestId }]);
  if (!verified?.views) throw new Error("Transaction verification failed");

  const signedRaw = signSafeTransaction(tx, verified.views, spendKey);
  const [sent] = await client.utxo.sendTransactions([{ raw: signedRaw, request_id: requestId }]);

  return sent.transaction_hash;
}

/**
 * Like sendSafeTx but retries for up to 2 minutes on "insufficient total input outputs",
 * which occurs when a prior tx's change UTXO is not yet spendable.
 *
 * @param {ReturnType<typeof MixinApi>} client
 * @param {string} spendKey
 * @param {string} senderUserId
 * @param {string} asset
 * @param {Array<{members: string[], threshold: number, amount: string} | {mixAddress: string, amount: string}>} recipients
 * @param {Buffer} extra
 * @param {string[]} [references]
 * @param {string} [requestId]
 * @returns {Promise<string>} transaction hash
 */
export async function sendSafeTxWithRetry(
  client,
  spendKey,
  senderUserId,
  asset,
  recipients,
  extra,
  references = [],
  requestId
) {
  const deadline = Date.now() + 120_000;
  let lastError;

  while (Date.now() < deadline) {
    try {
      return await sendSafeTx(client, spendKey, senderUserId, asset, recipients, extra, references, requestId);
    } catch (err) {
      lastError = err;
      if (!(err?.message ?? "").includes("insufficient total input outputs")) throw err;
      process.stdout.write("  waiting for UTXO change to settle...\n");
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }

  throw lastError;
}
