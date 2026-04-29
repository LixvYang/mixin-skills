---
name: mixin-safe-transactions
description: This skill should be used when sending or signing Mixin Safe (UTXO) transactions — listing safeOutputs, computing change, ghost keys, building/encoding/signing/verifying raw transactions, MixAddress recipients, transaction-to-group, multisig requests (createSafeMultisigs / signSafeMultisigs / unlock / cancel), and references / extra encoding within the kernel limit.
---

# Mixin Safe Transactions

Mixin Safe is the UTXO-based asset layer. Every transfer is a kernel transaction signed locally with the spend key. The flow is the same in Go and Node, but the SDKs spell it differently.

```
┌────────────────────────────────────────────────────────────────────────┐
│                       SAFE TRANSACTION LIFECYCLE                       │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  1. List unspent outputs   ─►  /safe/outputs (filter by asset, owner)  │
│  2. Pick inputs + change   ─►  greedy / SDK helper                     │
│  3. Build recipients       ─►  MixAddress(members, threshold) + amount │
│  4. Request ghost keys     ─►  /safe/keys (one per recipient slot)     │
│  5. Build raw transaction  ─►  inputs + outputs + extra                │
│  6. Verify (sequencer)     ─►  /safe/transaction/requests              │
│  7. Sign each input        ─►  spend_private_key + returned views      │
│  8. Submit                 ─►  /safe/transactions                      │
│  9. Confirm                ─►  hash matches what you signed            │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

## Recipients: addresses and thresholds

A Safe recipient is `(members[], threshold, amount)`. Wrap it in a `MixAddress` for human display or for use as a recipient in another transfer:

| Form | When |
|------|------|
| 1-of-1 (single user) | personal payment |
| t-of-n (multiple users) | bot-managed group / business multisig |
| MTG group | program owned by an MTG (members, threshold from group config) |

Members are **sorted internally** by both SDKs. If you persist a derived ID (trace, group ID), sort the same way.

## Go: full Safe transfer

```go
import (
    "context"
    bot "github.com/MixinNetwork/bot-api-go-client/v3"
    "github.com/MixinNetwork/mixin/common"
    "github.com/gofrs/uuid/v5"
    "github.com/shopspring/decimal"
)

// 1. List unspent outputs.
outs, err := bot.ListUnspentOutputs(ctx, "", []string{su.UserId}, 1, assetID, 0, 256, su)

// 2. Build recipients. recipientUUID is one or more user UUIDs.
amount := decimal.RequireFromString("0.01")
recv, _ := bot.NewUUIDMixAddress([]string{recipientUUID}, 1)
recipients := []*bot.TransactionRecipient{
    {MixAddress: recv, Amount: amount.String()},
}

// 3. Pick inputs + add change recipient.
selected, change, err := bot.SelectOutputsForRecipients(outs, recipients)
if change.Sign() > 0 {
    selfAddr, _ := bot.NewUUIDMixAddress([]string{su.UserId}, 1)
    recipients = append(recipients, &bot.TransactionRecipient{MixAddress: selfAddr, Amount: change.String()})
}

requestID := uuid.Must(uuid.NewV4()).String()

// 4. Ghost keys for each recipient slot.
ghosts, err := bot.GhostKeyForRecipients(ctx, recipients, requestID, su.SpendPrivateKey, su)

// 5. Build + encode raw tx.
tx, err := bot.BuildSafeTransaction(selected, recipients, ghosts, []byte("hello"))
raw := tx.Marshal()

// 6. Verify with sequencer.
verified, err := bot.VerifySafeTransaction(ctx, []*bot.SafeTransactionRequest{
    {RequestId: requestID, Raw: hex.EncodeToString(raw)},
}, su)

// 7. Sign each input.
signedRaw, err := bot.SignSafeTransaction(tx, verified[0].Views, su.SpendPrivateKey)

// 8. Submit.
results, err := bot.SendSafeTransactions(ctx, []*bot.SafeTransactionRequest{
    {RequestId: requestID, Raw: signedRaw},
}, su)

// 9. results[0].TransactionHash is the kernel hash.
```

Function names track the Go SDK's actual symbols (`ListUnspentOutputs`, `BuildSafeTransaction`, `VerifySafeTransaction`, `SignSafeTransaction`, `SendSafeTransactions`). For higher-level helpers, see `bot.SendTransferTransaction` (single recipient) or `bot.SendTransactionWithOutputs` (controlled inputs).

## Node.js: full Safe transfer

```js
const {
  MixinApi,
  buildSafeTransactionRecipient,
  getUnspentOutputsForRecipients,
  buildSafeTransaction,
  encodeSafeTransaction,
  signSafeTransaction,
} = require('@mixin.dev/mixin-node-sdk');
const { v4 } = require('uuid');

const client = MixinApi({ keystore });
const spendPrivateKey = ''; // hex string

// 1. List unspent outputs.
const outputs = await client.utxo.safeOutputs({
  members: [keystore.app_id],
  threshold: 1,
  asset: assetID,
  state: 'unspent',
});

// 2. Build recipients.
const recipients = [
  buildSafeTransactionRecipient([recipientUUID], 1, '0.01'),
];

// 3. Pick inputs + add change.
const { utxos, change } = getUnspentOutputsForRecipients(outputs, recipients);
if (!change.isZero() && !change.isNegative()) {
  recipients.push(buildSafeTransactionRecipient(
    outputs[0].receivers,
    outputs[0].receivers_threshold,
    change.toString(),
  ));
}

const request_id = v4();

// 4. Ghost keys.
const ghosts = await client.utxo.ghostKey(recipients, request_id, spendPrivateKey);

// 5. Build + encode raw tx.
const tx = buildSafeTransaction(utxos, recipients, ghosts, Buffer.from('hello'));
const raw = encodeSafeTransaction(tx);

// 6. Verify.
const verified = await client.utxo.verifyTransaction([{ raw, request_id }]);

// 7. Sign.
const signedRaw = signSafeTransaction(tx, verified[0].views, spendPrivateKey);

// 8. Submit.
const sent = await client.utxo.sendTransactions([{ raw: signedRaw, request_id }]);

// 9. sent[0].transaction_hash is the kernel hash.
```

## Output selection — gotchas

- **Cap input count.** Both SDKs use `MAX_UTXO_NUM = 255`. If a transfer needs more than 255 inputs, aggregate first via a self-transfer that consumes many small outputs and produces one large output.
- **Skip inscription outputs.** Standard transfers skip inscription UTXOs. Use the inscription-specific helpers (`bot.SendInscriptionTransaction` / `client.utxo.inscriptionTransfer`-equivalent) if you mean to spend inscriptions.
- **Sort `members` deterministically** when constructing the input filter; both SDKs do internally, but if you persist a hash of `members` somewhere, match the SDK's sort (lexicographic UUID).

## Multisig requests (Safe)

A "multisig request" stores a partially signed raw tx on Mixin servers so other signers can fetch and add their signatures.

### Go

```go
// Initiator
req, err := bot.CreateSafeMultisigRequest(ctx, &bot.SafeMultisigRequest{
    RequestId: requestID,
    Raw:       hex.EncodeToString(raw),
}, su)

// Each signer:
resp, _ := bot.FetchSafeMultisigRequest(ctx, requestID, su)
tx, _   := bot.DecodeSafeTransaction(resp.RawTransaction)
idx     := indexOfSelfInSenders(resp.Senders, mySu.UserId)
signed  := bot.SignSafeMultisig(tx, resp.Views, mySu.SpendPrivateKey, idx)
req,  _ = bot.SignSafeMultisigRequest(ctx, requestID, signed, mySu)
// Final signer's response includes a fully signed raw tx that can be submitted.

// Cancel before reaching threshold:
err = bot.CancelSafeMultisigRequest(ctx, requestID, mySu)
err = bot.UnlockSafeMultisigRequest(ctx, requestID, mySu)
```

### Node

```js
const { MixinApi, decodeSafeTransaction, signSafeTransaction } = require('@mixin.dev/mixin-node-sdk');
const client = MixinApi({ keystore });

// Initiator
let multisig = await client.multisig.createSafeMultisigs([{ raw, request_id }]);

// Each signer (after fetching):
multisig = await client.multisig.fetchSafeMultisigs(request_id);
const tx = decodeSafeTransaction(multisig.raw_transaction);
const idx = multisig.senders.sort().findIndex(u => u === mySpenderID);
const signedRaw = signSafeTransaction(tx, multisig.views, mySpendKey, idx);
multisig = await client.multisig.signSafeMultisigs(request_id, signedRaw);

// Cancel / unlock:
await client.multisig.unlockSafeMultisigs(request_id);
await client.multisig.cancelSafeMultisigs(request_id);
```

The `idx` is the position of the signer in the sorted senders array — both SDKs `sort()` ascending UUIDs.

## Transaction `extra` and references

- The general `extra` ceiling is 256 bytes (kernel constant). For larger payloads, use the **storage** pattern (the SDK helper `getRecipientForStorage` in Node, `mtg.EncodeMixinExtraBase64` + storage entry in Go) — see [`mixin-mix-address`](../mixin-mix-address/SKILL.md) and [`mixin-mtg-multisig`](../mixin-mtg-multisig/SKILL.md).
- References (`refs[]`) link transactions: a fee transaction references the main tx's blake3 hash so they're committed together. Cap reference count at 32 (kernel constant); both SDKs validate.

```js
// Reference: blake3 of the main raw bytes.
const ref = blake3Hash(Buffer.from(raw, 'hex')).toString('hex');
const feeTx = buildSafeTransaction(feeUtxos, feeRecipients, feeGhosts,
                                    Buffer.from('mainnet-fee-extra'),
                                    [ref]);  // <-- references
```

## Transaction-to-group (MTG)

To send assets *to* a Mixin Trusted Group, the recipient is a `MixAddress(group_members, group_threshold)`. The MTG can spend the resulting UTXO when its members sign.

To trigger a group action, encode the operation in `extra`:

```go
// Go — MTG operation extra
extra := mtg.EncodeMixinExtraBase64(appID, []byte(operationPayload))
// then build a Safe transaction whose recipient is the MTG MixAddress
// and whose `extra` is `extra`.
```

The MTG worker decodes `extra` to get `(appID, payload)`, dispatches to the matching app, and the app processes deterministically. See [`mixin-mtg-multisig`](../mixin-mtg-multisig/SKILL.md).

## Safety rules

- Never `float64` / `Number` for amounts. Use `decimal.Decimal` (Go) or `BigNumber` (Node, via `bignumber.js`).
- Same `request_id` for the same intended transfer, including across retries on `UtxoInsufficientError`. Use exponential backoff to wait for unspent outputs to mature.
- Validate `verified[0].views.length === tx.inputs.length` before signing — a length mismatch indicates the sequencer rejected an input.
- Confirm `sent[0].transaction_hash` matches the local hash of `signedRaw` before treating the transfer as committed.
- For UUID members, use `bot.NewUUIDMixAddress` / `buildSafeTransactionRecipient`. For mainnet `XIN...` addresses, use `bot.NewMainnetMixAddress` / `getMainnetAddressGhostKey`.
- The withdrawal first output is special — see [`mixin-withdrawals`](../mixin-withdrawals/SKILL.md).

## Validation

- Test the change calculation on edge cases: exact amount, single-output, dust amount.
- Test insufficient-output retries: same `request_id`, same recipients, escalating wait between attempts.
- For multisig, simulate every signer permutation against the same request and assert the final raw tx is identical regardless of signing order.
