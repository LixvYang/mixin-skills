---
name: mixin-safe
description: This skill should be used for Mixin Safe operations — listing Safe outputs (UTXOs), building/encoding/signing/verifying raw transactions, ghost keys, MixAddress recipients, multisig requests (create/sign/unlock/cancel), output selection, withdrawal fees, withdrawal destination first output, MixinCashier, deposit entries, address book, asset metadata fetch, balances, snapshots, network ticker, transaction-to-group (MTG), MIX/MIN address encoding, MTG extra payload, storage entry pattern, mixin:// and https://mixin.one/pay URL schemes.
---

# Mixin Safe & Assets

Mixin Safe is the UTXO-based asset layer. Every transfer is a kernel transaction signed locally with the spend key.

```
┌────────────────────────────────────────────────────────────────────────┐
│                       SAFE TRANSACTION LIFECYCLE                       │
├────────────────────────────────────────────────────────────────────────┤
│  1. List unspent outputs   ─►  /safe/outputs (filter by asset, owner)  │
│  2. Pick inputs + change   ─►  greedy / SDK helper                     │
│  3. Build recipients       ─►  MixAddress(members, threshold) + amount │
│  4. Request ghost keys     ─►  /safe/keys (one per recipient slot)     │
│  5. Build raw transaction  ─►  inputs + outputs + extra                │
│  6. Verify (sequencer)     ─►  /safe/transaction/requests              │
│  7. Sign each input        ─►  spend_private_key + returned views      │
│  8. Submit                 ─►  /safe/transactions                      │
│  9. Confirm                ─►  hash matches what you signed            │
└────────────────────────────────────────────────────────────────────────┘
```

---

## Asset Queries

### Asset metadata

```js
// Node
const asset = await client.safe.fetchAsset(assetID);
const chain = asset.chain_id === asset.asset_id
  ? asset
  : await client.safe.fetchAsset(asset.chain_id);
```

```go
// Go
asset, err := bot.SafeAssetFetch(ctx, assetID, su)
```

Fields: `symbol`, `name`, `precision`, `chain_id`, `mixin_id`, `icon_url`, `dispersion`, `price_usd`.

### Network APIs (no auth required)

```js
const top    = await client.network.topAssets();
const found  = await client.network.searchAssets('btc');
const ticker = await client.network.ticker(assetID, '2025-01-01T00:00:00Z');
const a      = await client.network.fetchAsset(assetID);
```

```go
top,    _ := bot.NetworkTopAssets(ctx)
found,  _ := bot.NetworkSearchAssets(ctx, "btc")
ticker, _ := bot.NetworkTicker(ctx, assetID, t)
asset,  _ := bot.NetworkFetchAsset(ctx, assetID)
```

Use `client.network.*` / `bot.Network*` when a session-scoped balance isn't needed — cheaper, less rate-limited.

### Safe outputs and balance

```js
const outputs = await client.utxo.safeOutputs({
  members: [keystore.app_id], threshold: 1, asset: assetID, state: 'unspent',
});
const balance = await client.utxo.safeAssetBalance({
  members: [keystore.app_id], threshold: 1, asset: assetID, state: 'unspent',
});
```

```go
outputs, _ := bot.ListUnspentOutputs(ctx, "", []string{su.UserId}, 1, assetID, 0, 256, su)
```

### Safe snapshots — balance changes

Poll `/safe/snapshots` to detect inbound transfers. Preferred over legacy Blaze `SYSTEM_ACCOUNT_SNAPSHOT`.

```js
const snaps = await client.safe.fetchSafeSnapshots({
  asset: assetID,
  opponent: userID,
  offset: cursor,
  limit: 100,
  order: 'DESC',
});
```

```go
snaps, _ := bot.SafeSnapshotsRead(ctx, assetID, opponentID, cursor, "DESC", 100, su)
```

Persist the `created_at` cursor. Snapshots include `transaction_hash` for correlation with outgoing txs.

### Notify a snapshot

```js
await client.safe.notifySnapshot({ snapshot_id, message: 'credited' });
```

```go
err := bot.SafeSnapshotNotify(ctx, snapshotID, message, su)
```

---

## Safe Transactions

### Go: full Safe transfer

```go
import (
    bot "github.com/MixinNetwork/bot-api-go-client/v3"
    "github.com/gofrs/uuid/v5"
    "github.com/shopspring/decimal"
)

// 1. List unspent outputs.
outs, err := bot.ListUnspentOutputs(ctx, "", []string{su.UserId}, 1, assetID, 0, 256, su)

// 2. Build recipients.
amount := decimal.RequireFromString("0.01")
recv, _ := bot.NewUUIDMixAddress([]string{recipientUUID}, 1)
recipients := []*bot.TransactionRecipient{
    {MixAddress: recv, Amount: amount.String()},
}

// 3. Pick inputs + add change.
selected, change, err := bot.SelectOutputsForRecipients(outs, recipients)
if change.Sign() > 0 {
    selfAddr, _ := bot.NewUUIDMixAddress([]string{su.UserId}, 1)
    recipients = append(recipients, &bot.TransactionRecipient{MixAddress: selfAddr, Amount: change.String()})
}

requestID := uuid.Must(uuid.NewV4()).String()

// 4. Ghost keys.
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

### Node.js: full Safe transfer

```js
const {
  MixinApi, buildSafeTransactionRecipient, getUnspentOutputsForRecipients,
  buildSafeTransaction, encodeSafeTransaction, signSafeTransaction,
} = require('@mixin.dev/mixin-node-sdk');
const { v4 } = require('uuid');

const client = MixinApi({ keystore });

// 1. List unspent outputs.
const outputs = await client.utxo.safeOutputs({
  members: [keystore.app_id], threshold: 1, asset: assetID, state: 'unspent',
});

// 2. Build recipients.
const recipients = [buildSafeTransactionRecipient([recipientUUID], 1, '0.01')];

// 3. Pick inputs + add change.
const { utxos, change } = getUnspentOutputsForRecipients(outputs, recipients);
if (!change.isZero() && !change.isNegative()) {
  recipients.push(buildSafeTransactionRecipient(
    outputs[0].receivers, outputs[0].receivers_threshold, change.toString(),
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
```

### Output selection gotchas

- **Cap input count.** `MAX_UTXO_NUM = 255`. Aggregate dust via self-transfer first if needed.
- **Skip inscription outputs.** Standard transfers skip inscription UTXOs. Use inscription-specific helpers for those.
- **Sort members deterministically** when constructing the input filter.

### Multisig requests

A "multisig request" stores a partially signed raw tx on Mixin servers for other signers.

**Go:**
```go
// Initiator
req, err := bot.CreateSafeMultisigRequest(ctx, &bot.SafeMultisigRequest{
    RequestId: requestID, Raw: hex.EncodeToString(raw),
}, su)

// Each signer:
resp, _ := bot.FetchSafeMultisigRequest(ctx, requestID, su)
tx,   _ := bot.DecodeSafeTransaction(resp.RawTransaction)
idx     := indexOfSelfInSenders(resp.Senders, mySu.UserId)
signed  := bot.SignSafeMultisig(tx, resp.Views, mySu.SpendPrivateKey, idx)
req,  _ = bot.SignSafeMultisigRequest(ctx, requestID, signed, mySu)

// Cancel before threshold:
err = bot.CancelSafeMultisigRequest(ctx, requestID, mySu)
err = bot.UnlockSafeMultisigRequest(ctx, requestID, mySu)
```

**Node:**
```js
// Initiator
let multisig = await client.multisig.createSafeMultisigs([{ raw, request_id }]);

// Each signer:
multisig = await client.multisig.fetchSafeMultisigs(request_id);
const tx = decodeSafeTransaction(multisig.raw_transaction);
const idx = multisig.senders.sort().findIndex(u => u === mySpenderID);
const signedRaw = signSafeTransaction(tx, multisig.views, mySpendKey, idx);
multisig = await client.multisig.signSafeMultisigs(request_id, signedRaw);

// Cancel / unlock:
await client.multisig.unlockSafeMultisigs(request_id);
await client.multisig.cancelSafeMultisigs(request_id);
```

The `idx` is the signer's position in the sorted senders array.

### Transaction extra, references, transaction-to-group

- General `extra` ceiling: 256 bytes. Use storage pattern for larger payloads.
- References link a fee transaction to the main tx via blake3 hash. Cap at 32.
- Transaction-to-group: send to `MixAddress(group_members, group_threshold)` with operation encoded in `extra` via `mtg.EncodeMixinExtraBase64`. See the MTG skill.

### Safety rules

- Never `float64` for amounts. Use `decimal.Decimal` (Go) or `bignumber.js` (Node).
- Same `request_id` for the same intent, including retries.
- Validate `verified.views.length === tx.inputs.length` before signing.
- Confirm `sent.transaction_hash` matches the local hash of `signedRaw`.

---

## Withdrawals

A withdrawal moves an asset from Safe to an external chain address. Two special features:

1. **The destination output (the actual withdrawal) goes first.** No ghost key needed.
2. **A fee output goes to `MixinCashier`** — either in the same tx (if paid in withdrawal asset) or as a separate reference-linked fee tx.

```
┌──────────────────────────────────┐
│ output 0: destination chain addr │  ◄── no ghost key
│ output 1: MixinCashier (fee)     │  ── only when fee_asset == withdrawal_asset
│ output 2..: change to self       │
└──────────────────────────────────┘
```

### Fetch fee

```js
const asset  = await client.safe.fetchAsset(withdrawal_asset_id);
const fees   = await client.safe.fetchFee(asset.asset_id, withdrawal_destination);
const assetFee = fees.find(f => f.asset_id === asset.asset_id);
const chainFee = fees.find(f => f.asset_id === chain.asset_id);
const fee    = assetFee ?? chainFee;
```

```go
asset, _ := bot.SafeAssetFetch(ctx, withdrawalAssetID, su)
fees,  _ := bot.SafeFeeFetch(ctx, asset.AssetId, withdrawalDestination, su)
```

If `fee.asset_id == withdrawal_asset_id` → single tx. Otherwise → two txs linked by reference.

### Node.js: same-asset fee (single tx)

```js
const { MixinApi, MixinCashier, buildSafeTransactionRecipient,
        getUnspentOutputsForRecipients, buildSafeTransaction,
        encodeSafeTransaction, signSafeTransaction } = require('@mixin.dev/mixin-node-sdk');

const outputs = await client.utxo.safeOutputs({ asset: withdrawal_asset_id, state: 'unspent' });
const recipients = [
  { amount: withdrawal_amount, destination: withdrawal_destination, tag: withdrawal_memo },
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
const tx = buildSafeTransaction(utxos, recipients, [undefined, ...ghosts], Buffer.from('mainnet-transaction-extra'));
const raw = encodeSafeTransaction(tx);
const verified = await client.utxo.verifyTransaction([{ raw, request_id }]);
const signedRaw = signSafeTransaction(tx, verified[0].views, spendPrivateKey);
await client.utxo.sendTransactions([{ raw: signedRaw, request_id }]);
```

### Node.js: chain-asset fee (two tx, reference-linked)

```js
const { blake3Hash } = require('@mixin.dev/mixin-node-sdk');

// 1. Build withdrawal tx (destination only).
let recipients = [{ amount: withdrawal_amount, destination: withdrawal_destination, tag: withdrawal_memo }];
const { utxos, change } = getUnspentOutputsForRecipients(outputs, recipients);
if (!change.isZero() && !change.isNegative()) {
  recipients.push(buildSafeTransactionRecipient(outputs[0].receivers, outputs[0].receivers_threshold, change.toString()));
}
const txId = v4();
const ghosts = await client.utxo.ghostKey(recipients, txId, spendPrivateKey);
const tx = buildSafeTransaction(utxos, recipients, [undefined, ...ghosts], Buffer.from('mainnet-transaction-extra'));
const raw = encodeSafeTransaction(tx);
const ref = blake3Hash(Buffer.from(raw, 'hex')).toString('hex');

// 2. Build fee tx referencing the withdrawal raw.
const feeOutputs = await client.utxo.safeOutputs({ asset: fee.asset_id, state: 'unspent' });
const feeRecipients = [buildSafeTransactionRecipient([MixinCashier], 1, fee.amount)];
const { utxos: feeUtxos, change: feeChange } = getUnspentOutputsForRecipients(feeOutputs, feeRecipients);
if (!feeChange.isZero() && !feeChange.isNegative()) {
  feeRecipients.push(buildSafeTransactionRecipient(feeOutputs[0].receivers, feeOutputs[0].receivers_threshold, feeChange.toString()));
}
const feeId = v4();
const feeGhosts = await client.utxo.ghostKey(feeRecipients, feeId, spendPrivateKey);
const feeTx = buildSafeTransaction(feeUtxos, feeRecipients, feeGhosts, Buffer.from('mainnet-fee-transaction-extra'), [ref]);
const feeRaw = encodeSafeTransaction(feeTx);

// 3. Verify + sign + submit both as a pair.
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

### Go withdrawal

The Go SDK provides `bot.SendWithdrawalTransaction` (high-level) and the lower-level `bot.BuildSafeTransaction` with a `WithdrawalDestination` field on the first recipient. Same two-tx pattern using references.

### Deposit entries

Register a deposit entry per `(asset, chain_id)`:

```js
const entries = await client.safe.depositEntries({
  members: [keystore.app_id], threshold: 1, chain_id,
});
```

```go
entries, err := bot.SafeCreateDepositEntries(ctx, []string{su.UserId}, 1, chainID, su)
```

Same tuple always returns the same entry. Display `destination` + `tag` to depositors.

### Withdrawal address book

```js
const created = await client.address.createSafe({ asset_id, destination, tag, label }, spendPrivateKey);
const list    = await client.address.fetchListSafe(asset_id);
await client.address.deleteSafe(addressId, spendPrivateKey);
```

```go
addr, _ := bot.SafeCreateAddress(ctx, &bot.AddressInput{AssetId: assetID, Destination: dest, Tag: tag, Label: label}, su)
addrs, _ := bot.SafeReadAddresses(ctx, assetID, su)
err := bot.SafeDeleteAddress(ctx, addressID, su)
```

### Safety rules

- Fetch the fee fresh per withdrawal — never hardcode.
- Validate destination format before signing. Wrong-chain addresses can lose funds.
- Tag/memo length is chain-dependent. Validate upstream.
- Don't leak `spendPrivateKey` into logs around withdrawal failures.

---

## Address Encodings

### MIX address — multisig recipient

```go
addr, _ := bot.NewUUIDMixAddress([]string{aliceUUID, bobUUID}, 2)
fmt.Println(addr.String())  // "MIX..."
parsed, _ := bot.NewMixAddressFromString(addr.String())
fmt.Println(parsed.Members(), parsed.Threshold)
```

```js
const mix = buildMixAddress({ members: [aliceUUID, bobUUID], threshold: 2 });
const { members, threshold } = parseMixAddress(mix);
```

Members are sorted internally by both SDKs. A 1-of-1 MIX address is the canonical user address.

### MIN invoice — multi-output payment request

An invoice encodes one or more outputs for a single recipient:

```go
inv := bot.NewMixinInvoice(recipientMixAddr)
inv.AddEntry(assetID, "0.5", []byte("payment for X"), nil)
inv.AddEntry(otherAsset, "0.01", []byte("fee"), nil)
encoded := inv.Encode()  // "MIN..."
```

Constraints: per-entry memo ≤ 256 bytes, references ≤ 32.

### MTG extra — operation dispatch

```go
import "github.com/MixinNetwork/safe/mtg"
extraB64 := mtg.EncodeMixinExtraBase64(appID, payload)
```

Pass as `extra` to `BuildSafeTransaction`. The MTG worker decodes and dispatches.

### Storage entry — large extra workaround

When `extra` > 256 bytes, the payload cannot ride on the operational tx:

1. Send a **storage transaction** (must be in XIN) with the full payload as extra.
2. Take the storage tx's kernel hash.
3. Put a short placeholder in the operational tx's extra and add the storage hash to `references`.

```js
const storageRecipient = getRecipientForStorage(extra);
// Build a Safe transaction whose first recipient is storageRecipient,
// asset is XIN (c94ac88f-4671-3976-b60a-09064f1811e8), extra is the payload.
```

Storage transactions are XIN-only. If your operational asset isn't XIN, pre-send the payload in a separate XIN storage tx first.

### mixin:// URL scheme

| Path | Effect |
|------|--------|
| `mixin://users/<user_id>` | open user profile |
| `mixin://transfer/<recipient_user_id>` | open transfer pre-filled |
| `mixin://pay?recipient=...&asset=...&amount=...&memo=...&trace=...` | open Pay sheet |
| `mixin://schemes/<scheme_id>` | resolved from `https://mixin.one/pay/...` |

```go
url := fmt.Sprintf("mixin://pay?recipient=%s&asset=%s&amount=%s&trace=%s&memo=%s",
    url.QueryEscape(recipientUserID), assetID, amount, traceID, url.QueryEscape(memo))
```

```js
const url = new URL('mixin://pay');
url.searchParams.set('recipient', recipientUserID);
// ...
```

Resolve `https://mixin.one/pay/...` URLs via:

```js
const resp = await client.code.schemes('https://mixin.one/pay/MIN...');
// resp.scheme_id → render as mixin://schemes/<scheme_id>
```

### When to choose what

| Scenario | Format |
|----------|--------|
| "send to this group of users" | MIX address as recipient |
| "let user pay multiple outputs in one tap" | MIN invoice |
| "trigger an MTG app operation" | MTG extra (into a Safe tx) |
| "open Mixin from web" | `https://mixin.one/pay/...` or `mixin://...` |
| "in-app card pre-fills a payment" | app card with `action: mixin://pay?...` |

### Validation

- Round-trip every encoded form: encode → decode → assert structural equality.
- For invoices, assert per-entry memo and reference counts before encode.
- For mixin:// URLs, percent-encode every user-supplied value; never concatenate raw input.

## Helper scripts

All scripts live in `skills/mixin-safe/scripts/`. Install deps first:

```bash
npm install
```

### Read-only (no spend key)

```bash
# List recent Safe snapshots
node safe-snapshots.mjs --config=keystore.json [--limit=20] [--asset=ASSET_ID]

# Check asset balances — paginated UTXO query, aggregates by asset
node safe-balance.mjs --config=keystore.json [--asset=ASSET_ID]

# Derive a MIX address from member UUIDs (no keystore needed)
node mix-address.mjs --members=UUID1[,UUID2,...] [--threshold=2]
```

### Transfer (spend key required)

```bash
# Transfer every asset's full balance to a single recipient
node safe-transfer-all.mjs --config=keystore.json --to=RECIPIENT_USER_ID [--dry-run]

# Each asset gets a random trace_id (uuid v4). Dry-run scans + reports without sending.
```

### Notes

- All scripts expect a bot dashboard keystore JSON (`--config` flag) or individual `MIXIN_*` env vars.
- `safe-transfer-all.mjs` paginates all unspent outputs (mvm.dev offset pattern), groups by asset, then builds + signs + submits one Safe transaction per asset. The keystore must have `spend_private_key` and `server_public_key`.
- `safe-balance.mjs` follows the same pagination pattern and fetches asset metadata via `fetchAssets(actualIds)` (not `fetchAssets([])`).
