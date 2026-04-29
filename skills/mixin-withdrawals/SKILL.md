---
name: mixin-withdrawals
description: This skill should be used for Mixin on-chain withdrawals — fetching fees, building a withdrawal Safe transaction with the destination as the first output, the chain-asset fee transaction with reference linkage, MixinCashier, deposit entry registration, and the withdrawal address book (create/list/delete).
---

# Mixin Withdrawals

A Mixin withdrawal moves an asset from a Safe account to an external chain address. Mechanically it's a Safe transaction with two special features:

1. **The destination output (the actual withdrawal) goes first.** It does not need a ghost key — the destination is a chain address, not a Mixin user.
2. **A fee output goes to `MixinCashier`.** Either as another output in the same tx (when the fee is paid in the withdrawal asset), or as a separate fee transaction that **references** the main tx (when the fee is paid in the chain asset).

```
                        WITHDRAWAL TX
            ┌──────────────────────────────────┐
            │ output 0:   destination chain    │  ◄── no ghost key
            │             amount, tag (memo)   │
            ├──────────────────────────────────┤
            │ output 1:   MixinCashier (fee)   │  ── only when fee_asset == withdrawal_asset
            ├──────────────────────────────────┤
            │ output 2..: change to self       │
            └──────────────────────────────────┘

  When fee_asset != withdrawal_asset:
                        FEE TX  ── references blake3(withdrawal_raw)
            ┌──────────────────────────────────┐
            │ output 0: MixinCashier (fee)     │
            │ output 1: change to self         │
            └──────────────────────────────────┘
```

## Fetching the fee

The fee depends on `(asset_id, destination)`. Always fetch it; never hardcode.

```js
// Node
const asset  = await client.safe.fetchAsset(withdrawal_asset_id);
const chain  = asset.chain_id === asset.asset_id ? asset : await client.safe.fetchAsset(asset.chain_id);
const fees   = await client.safe.fetchFee(asset.asset_id, withdrawal_destination);
const assetFee = fees.find(f => f.asset_id === asset.asset_id);
const chainFee = fees.find(f => f.asset_id === chain.asset_id);
const fee    = assetFee ?? chainFee;
```

```go
// Go
asset, _  := bot.SafeAssetFetch(ctx, withdrawalAssetID, su)
fees,  _  := bot.SafeFeeFetch(ctx, asset.AssetId, withdrawalDestination, su)
// pick fee whose AssetId == withdrawalAssetID, else fee in chain asset.
```

The returned fee object has:

```
{ asset_id, amount }
```

If `fee.asset_id == withdrawal_asset_id` → single transaction. Otherwise → two transactions linked by reference.

## Node.js: same-asset fee (single tx)

```js
const {
  MixinApi, MixinCashier,
  buildSafeTransactionRecipient, getUnspentOutputsForRecipients,
  buildSafeTransaction, encodeSafeTransaction, signSafeTransaction,
} = require('@mixin.dev/mixin-node-sdk');
const { v4 } = require('uuid');

const outputs = await client.utxo.safeOutputs({ asset: withdrawal_asset_id, state: 'unspent' });

const recipients = [
  // 0: destination — no ghost key
  { amount: withdrawal_amount, destination: withdrawal_destination, tag: withdrawal_memo },
  // 1: fee → MixinCashier
  buildSafeTransactionRecipient([MixinCashier], 1, fee.amount),
];
const { utxos, change } = getUnspentOutputsForRecipients(outputs, recipients);
if (!change.isZero() && !change.isNegative()) {
  recipients.push(buildSafeTransactionRecipient(
    outputs[0].receivers, outputs[0].receivers_threshold, change.toString(),
  ));
}

const request_id = v4();
const ghosts = await client.utxo.ghostKey(recipients, request_id, spendPrivateKey);
// First output (destination) does not consume a ghost key — pad with `undefined`.
const tx = buildSafeTransaction(
  utxos, recipients,
  [undefined, ...ghosts],
  Buffer.from('mainnet-transaction-extra'),
);
const raw = encodeSafeTransaction(tx);

const verified = await client.utxo.verifyTransaction([{ raw, request_id }]);
const signedRaw = signSafeTransaction(tx, verified[0].views, spendPrivateKey);
await client.utxo.sendTransactions([{ raw: signedRaw, request_id }]);
```

## Node.js: chain-asset fee (two tx, reference-linked)

```js
const { blake3Hash } = require('@mixin.dev/mixin-node-sdk');

// 1. build withdrawal tx (destination only, no fee output here)
let recipients = [
  { amount: withdrawal_amount, destination: withdrawal_destination, tag: withdrawal_memo },
];
const { utxos, change } = getUnspentOutputsForRecipients(outputs, recipients);
if (!change.isZero() && !change.isNegative()) {
  recipients.push(buildSafeTransactionRecipient(
    outputs[0].receivers, outputs[0].receivers_threshold, change.toString(),
  ));
}
const txId = v4();
const ghosts = await client.utxo.ghostKey(recipients, txId, spendPrivateKey);
const tx = buildSafeTransaction(utxos, recipients, [undefined, ...ghosts], Buffer.from('mainnet-transaction-extra'));
const raw = encodeSafeTransaction(tx);
const ref = blake3Hash(Buffer.from(raw, 'hex')).toString('hex');

// 2. build fee tx using the chain-asset UTXOs and reference the withdrawal raw
const feeOutputs = await client.utxo.safeOutputs({ asset: fee.asset_id, state: 'unspent' });
const feeRecipients = [buildSafeTransactionRecipient([MixinCashier], 1, fee.amount)];
const { utxos: feeUtxos, change: feeChange } = getUnspentOutputsForRecipients(feeOutputs, feeRecipients);
if (!feeChange.isZero() && !feeChange.isNegative()) {
  feeRecipients.push(buildSafeTransactionRecipient(
    feeOutputs[0].receivers, feeOutputs[0].receivers_threshold, feeChange.toString(),
  ));
}
const feeId = v4();
const feeGhosts = await client.utxo.ghostKey(feeRecipients, feeId, spendPrivateKey);
const feeTx = buildSafeTransaction(
  feeUtxos, feeRecipients, feeGhosts,
  Buffer.from('mainnet-fee-transaction-extra'),
  [ref],   // ← reference to the withdrawal raw
);
const feeRaw = encodeSafeTransaction(feeTx);

// 3. verify both, sign both, submit both — atomically as a pair
const verified = await client.utxo.verifyTransaction([
  { raw, request_id: txId },
  { raw: feeRaw, request_id: feeId },
]);
const signedRaw    = signSafeTransaction(tx,    verified[0].views, spendPrivateKey);
const signedFeeRaw = signSafeTransaction(feeTx, verified[1].views, spendPrivateKey);
await client.utxo.sendTransactions([
  { raw: signedRaw,    request_id: txId },
  { raw: signedFeeRaw, request_id: feeId },
]);
```

The `[ref]` array on the fee tx makes the kernel commit them together — neither can land without the other.

## Go: same idea

The Go SDK provides `bot.SendWithdrawalTransaction` (high-level helper) and the lower-level `bot.BuildSafeTransaction` with a `WithdrawalDestination` field on the first recipient and `bot.MixinCashierMixAddress` for the fee output. The two-tx variant uses `bot.BuildSafeTransaction` twice with `[]string{refHex}` references on the fee tx, then `bot.VerifySafeTransaction` and `bot.SendSafeTransactions` over both items in one batch — same shape as Node.

## Deposit entries

Receiving an external-chain deposit requires registering a deposit entry. The bot/app calls `/safe/deposit/entries` once per (asset, destination_kind), persists the returned entry, and tells users to send the chain asset to that entry. Mixin credits the corresponding Safe output when the deposit confirms.

```js
const entries = await client.safe.depositEntries({
  members: [keystore.app_id],
  threshold: 1,
  chain_id,
});
// entries[].destination + entries[].tag → display these to depositors
```

```go
entries, err := bot.SafeCreateDepositEntries(ctx, []string{su.UserId}, 1, chainID, su)
```

The same `(members, threshold, chain_id)` tuple always returns the same entry. Persist the result.

## Withdrawal address book

The address book stores trusted destinations so future withdrawals don't need re-confirmation:

```js
// Create — needs spend key
const created = await client.address.createSafe({
  asset_id, destination, tag, label,
}, spendPrivateKey);

// List
const list = await client.address.fetchListSafe(asset_id);

// Delete — needs spend key
await client.address.deleteSafe(addressId, spendPrivateKey);
```

```go
// Create
addr, _ := bot.SafeCreateAddress(ctx, &bot.AddressInput{
    AssetId: assetID, Destination: dest, Tag: tag, Label: label,
}, su)
// Read
addrs, _ := bot.SafeReadAddresses(ctx, assetID, su)
// Delete
err := bot.SafeDeleteAddress(ctx, addressID, su)
```

## Safety rules

- Fetch the fee fresh per withdrawal. Hardcoded fees break silently when the chain re-prices.
- Use the same `request_id` across retries. The pair (`txId`, `feeId`) must also remain stable across retries of the same logical withdrawal.
- The withdrawal output (`destination + tag`) is **not** scrubbed by the SDK. Validate destination format before signing — wrong-chain addresses can result in unrecoverable funds.
- Tag/memo length is chain-dependent (e.g. EOS tag, BNB memo). Both SDKs validate at submission, but you should mirror the validation upstream.
- Don't leak `spendPrivateKey` into logs or error messages around withdrawal failures.

## Validation

- Confirm both `transaction_hash` values are present in `client.utxo.fetchTransaction` results before treating the withdrawal as in-flight.
- For chain-asset-fee withdrawals, simulate failure between the two `sendTransactions` calls and confirm the kernel rejects orphaned partial submissions (because of the reference).
- Keep an automated reconciliation that compares `address.fetchListSafe` against your local store of saved destinations.

## Related skills

- [`mixin-safe-transactions`](../mixin-safe-transactions/SKILL.md) — underlying UTXO + ghost key + raw tx flow.
- [`mixin-network-assets`](../mixin-network-assets/SKILL.md) — query assets / chain metadata before withdrawing.
