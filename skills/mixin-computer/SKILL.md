---
name: mixin-computer
description: This skill should be used when calling the public Mixin Safe Computer service at https://computer.mixin.one — registering a Mixin user as a Computer user (AddUser), submitting Solana system calls via MTG transactions, encoding the OperationTypeAddUser / OperationTypeSystemCall extra format, querying computer info / users / deployed assets / system calls / nonce accounts, requesting fees in XIN based on SOL, deploying external assets, and locking nonce accounts.
---

# Mixin Computer

Mixin Safe Computer (MVM) is a decentralized compute layer inside Mixin Safe. Its current runtime targets Solana. A bot interacts with Computer in three layers:

```
┌──────────────────────────────────────────────────────────────────────┐
│                            COMPUTER LAYERS                           │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  1. Public HTTP API at https://computer.mixin.one                    │
│     ── read-only queries: info, user, assets, calls, nonce, fees     │
│                                                                      │
│  2. Bot SDK helpers (github.com/MixinNetwork/bot-api-go-client/v3)   │
│     ── encode operation extras + send Mixin Safe tx to Computer MTG  │
│                                                                      │
│  3. Computer MTG worker (runs at Mixin Network)                      │
│     ── decodes extras, executes Solana txs, emits results            │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

This skill covers layers 1 and 2. The MTG worker side (running a Computer node) is implemented in `github.com/MixinNetwork/computer` and uses [`mixin-mtg-multisig`](../mixin-mtg-multisig/SKILL.md) patterns.

> **SDK note.** The Go SDK (`github.com/MixinNetwork/bot-api-go-client/v3`) contains both HTTP wrappers for `https://computer.mixin.one` and helpers for encoding MTG extras. The Node.js SDK (`@mixin.dev/mixin-node-sdk`) currently exposes **encoding helpers** (extra layout + MTG extra encoding + size check) but does not provide first-class HTTP wrappers for `computer.mixin.one` endpoints — call those endpoints directly (axios/fetch) if needed.

## Operation byte layouts

Every Computer operation is a Mixin Safe transaction whose `extra` is `EncodeMtgExtra(computerAppID, operationMemo)`, where `operationMemo` follows a fixed binary layout:

```
operationMemo = operationType(1 byte) || operationPayload
mtgExtra      = base64rawurl( computerAppIDBytes(16) || operationMemo )
```

| `operationType` | Constant | Payload layout |
|---|---|---|
| `1` | `OperationTypeAddUser` | UTF-8 of a single-member `MIX...` address |
| `2` | `OperationTypeSystemCall` | `uid(8 BE bytes) ‖ callID(16 uuid bytes) ‖ skip(1 byte) ‖ feeID?(16 uuid bytes)` |
| `3` | `OperationTypeUserDeposit` | reserved |

`uid` is the Computer user ID — an integer rendered as 8 big-endian bytes (`bot.ComputerUserIDToBytes`). `feeID` is optional; omit the trailing 16 bytes when no fee output exists.

The bot SDK does the encoding for you:

```go
import bot "github.com/MixinNetwork/bot-api-go-client/v3"

memo  := bot.EncodeOperationMemo(bot.OperationTypeAddUser, []byte(mixAddr))
extra := bot.EncodeMtgExtra(info.Members.AppId, memo)  // base64 raw URL
```

```go
sys, _ := bot.BuildSystemCallExtra(uid, callID, skipProcess, feeID)
memo   := bot.EncodeOperationMemo(bot.OperationTypeSystemCall, sys)
extra  := bot.EncodeMtgExtra(info.Members.AppId, memo)
```

Node.js equivalents live in `@mixin.dev/mixin-node-sdk` (main export):

```js
import {
  buildComputerExtra, buildSystemCallExtra, encodeMtgExtra, checkSystemCallSize,
  OperationTypeAddUser, OperationTypeSystemCall,
} from "@mixin.dev/mixin-node-sdk";

// OperationTypeAddUser: payload is UTF-8 MIX address bytes
const memo = buildComputerExtra(OperationTypeAddUser, Buffer.from(mixAddr, 'utf8'));
const mtgExtra = encodeMtgExtra(mtgAppId, memo); // base64 raw URL

// OperationTypeSystemCall: uid(8 bytes) || callID(16) || skip(1) || feeID?(16)
const sys = buildSystemCallExtra(uid /* decimal string */, callID /* uuid */, skipPostProcess, feeID /* optional uuid */);
const memo2 = buildComputerExtra(OperationTypeSystemCall, sys);
const mtgExtra2 = encodeMtgExtra(mtgAppId, memo2);

// bytes of Solana tx: Buffer.from(tx.serialize())
if (!checkSystemCallSize(solanaTxBytes)) throw new Error('Solana tx too large for Computer system call');
```

## UUID vs MIX address — pay attention

Computer interfaces don't accept a raw Mixin `user_id` UUID. The corresponding 1-of-1 MIX address is required:

| Field | Form | How to get it |
|---|---|---|
| `ComputerUser.address` | MIX address, Computer UID, or Solana chain address | from a UUID: `bot.NewUUIDMixAddress([]string{userID}, 1).String()` |
| `LockComputerNonceAccount.mix` | MIX address | same as above |
| `BuildComputerAddUserExtra.mix` | MIX address | same |
| `BuildSystemCallExtra.uid` | Computer UID (decimal string) | from `GetComputerUser(...).UID` |
| `BuildSystemCallExtra.callID` | UUID | caller-generated |
| `BuildSystemCallExtra.feeID` | UUID (optional) | from the fee quote response |

`computer-register-preview` and `RegisterComputer` derive the bot's own MIX address internally, but anywhere else you pass an address explicitly, **convert from UUID first**.

## Public read endpoints (no auth)

| Endpoint | SDK helper | Returns |
|---|---|---|
| `GET /` | `bot.GetComputerInfo(ctx)` | `{observer, payer, height, version, members, params.operation}` |
| `GET /users/:id` | `bot.GetComputerUser(ctx, address)` | `{id, mix_address, chain_address}` or `nil` (404) |
| `GET /deployed_assets` | `bot.GetComputerDeployedAssets(ctx)` | `[{asset_id, chain_id, address, name, symbol, decimals, price_usd, uri}]` |
| `GET /system_calls/:id` | `bot.GetComputerSystemCall(ctx, callID)` | `{id, type, user_id, nonce_account, raw, state, hash, reason, subs[]}` |
| `POST /fee` | `bot.GetFeeOnXINBasedOnSOL(ctx, solAmount)` | `{fee_id, xin_amount}` |
| `POST /nonce_accounts` | `bot.LockComputerNonceAccount(ctx, mix)` | `{mix, nonce_address, nonce_hash}` |

```go
info, _ := bot.GetComputerInfo(ctx)
fmt.Println(info.Members.AppId, info.Members.Members, info.Members.Threshold)
fmt.Println(info.Params.Operation.Asset, info.Params.Operation.Price)
```

These run over the public internet — no Mixin keystore needed.

## Register a Mixin user as a Computer user

`RegisterComputer` sends a Mixin Safe transaction from the bot to the Computer MTG group. It needs a **full** keystore (`server_public_key` + `spend_private_key`):

```go
// Preview — no network state changes; useful in CLI / dry-run
preview, _ := computerRegisterPreview(ctx, su)
fmt.Println(preview.MixAddress, preview.TraceID, preview.MTGExtra)

// Real — sends the Mixin transaction
seq, err := bot.RegisterComputer(ctx, su)
// seq.TransactionHash is the kernel hash of the registration tx
```

Internally `bot.RegisterComputer`:

1. Calls `GetComputerInfo` for `(operation.asset, operation.price, MTG members, MTG threshold)`.
2. Derives the bot's 1-of-1 MIX address.
3. Encodes extra: `EncodeMtgExtra(MTG.AppId, EncodeOperationMemo(OperationTypeAddUser, []byte(mix)))`.
4. Derives `trace = UniqueObjectId(mix, "computer_register")`.
5. Calls `bot.SendTransaction(operation.asset, [{MixAddress: MTG, Amount: operation.price}], trace, extra, nil, su)`.

The resulting MTG sees an output with the AddUser memo and registers the user on Solana. Use `bot.GetComputerUser(ctx, mix)` to poll until `uid` and `solana_address` are populated.

### Node.js registration shape

In Node.js, do the same registration manually: load the bot keystore, fetch Computer info, derive the bot's 1-of-1 MIX address, check whether it is already registered, then send the Computer AddUser payment from the bot's XIN balance.

```ts
import {
  MixinApi,
  buildComputerExtra,
  encodeMtgExtra,
  buildMixAddress,
  buildSafeTransactionRecipient,
  OperationTypeAddUser,
} from "@mixin.dev/mixin-node-sdk";
import BigNumber from "bignumber.js";

const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 120_000;

const ks = loadKeystore();
const client = MixinApi({
  keystore: {
    app_id: ks.app_id,
    session_id: ks.session_id,
    session_private_key: ks.session_private_key,
    server_public_key: ks.server_public_key,
  },
});

const info = await computerApi.info();

const mixAddress = buildMixAddress({
  version: 2,
  xinMembers: [],
  uuidMembers: [ks.app_id],
  threshold: 1,
});

try {
  const existing = await computerApi.user(mixAddress);
  if (existing?.id) {
    return existing;
  }
} catch {
  // 404 means not registered yet.
}
```

Build the AddUser extra from the bot's MIX address and pay the Computer MTG group:

```ts
const memo = buildComputerExtra(
  OperationTypeAddUser,
  Buffer.from(mixAddress, "utf-8")
);
const extra = Buffer.from(encodeMtgExtra(info.members.app_id, memo), "utf-8");

const mtgRecipient = buildSafeTransactionRecipient(
  info.members.members,
  info.members.threshold,
  info.params.operation.price
);
```

Before sending, check the bot has enough XIN UTXOs for `info.params.operation.price`:

```ts
const outputs = await client.utxo.safeOutputs({
  members: [ks.app_id],
  threshold: 1,
  asset: info.params.operation.asset,
  state: "unspent",
});

const balance = outputs.reduce(
  (sum, output) => sum.plus(output.amount),
  new BigNumber(0)
);

if (balance.lt(info.params.operation.price)) {
  throw new Error(`Insufficient XIN for Computer registration`);
}
```

Send the Safe transaction with the bot spend key. The exact `sendSafeTx` helper is project-specific, but it must build, verify, sign, and submit a normal Safe transaction with the AddUser extra:

```ts
const txHash = await sendSafeTx(
  client,
  ks.spend_key,
  ks.app_id,
  info.params.operation.asset,
  [mtgRecipient],
  extra
);
```

After submission, poll `GET /users/:mix` until Computer returns the UID and Solana authority:

```ts
const deadline = Date.now() + POLL_TIMEOUT_MS;

while (Date.now() < deadline) {
  await sleep(POLL_INTERVAL_MS);

  try {
    const user = await computerApi.user(mixAddress);
    if (user?.id) {
      return {
        uid: user.id,
        mix: user.mix_address,
        solana: user.chain_address,
        registrationTx: txHash,
      };
    }
  } catch {
    // The MTG has not processed the registration yet.
  }
}

throw new Error("Timed out waiting for Computer registration");
```

## Submit a system call

A "system call" is a Solana transaction proxied through the Computer MTG. Full flow:

1. Build the Solana transaction bytes (fee payer = Computer payer, advance nonce, business instructions).
2. **Store** the Solana bytes via a Mixin storage transaction. The storage tx hash becomes a reference.
3. If rent / fee is needed, call `bot.GetFeeOnXINBasedOnSOL(ctx, solAmount)` → `fee_id` + XIN amount; pay the fee in a separate Safe transaction.
4. Build the operation extra: `BuildSystemCallExtra(uid, callID, skipProcess, feeID)` → wrap with `EncodeOperationMemo(OperationTypeSystemCall, …)` → wrap with `EncodeMtgExtra(MTGAppID, …)`.
5. Send a Mixin Safe transaction to the MTG MIX address with that extra and **`references` = [storageTxHash, optional asset payment refs]**.
6. Poll `bot.GetComputerSystemCall(ctx, callID)` for execution status.

Step 2 is the standard Mixin "object storage" pattern — see [`mixin-mix-address`](../mixin-mix-address/SKILL.md). Step 5 follows the [`mixin-safe-transactions`](../mixin-safe-transactions/SKILL.md) flow with non-empty `references`.

```go
sys, _    := bot.BuildSystemCallExtra(uid, callID, skipProcess, feeID)
memo      := bot.EncodeOperationMemo(bot.OperationTypeSystemCall, sys)
mtgExtra  := bot.EncodeMtgExtra(info.Members.AppId, memo)
mtgAddr   := bot.NewUUIDMixAddress(info.Members.Members, byte(info.Members.Threshold))

raw, _    := bot.BuildSafeTransaction(/* utxos */, []*bot.TransactionRecipient{
    {MixAddress: mtgAddr, Amount: dustAmount},
}, ghosts, []byte(mtgExtra))
// attach references = [storageTxHash, ...] in the verify/submit calls
```

The `skipProcess` flag (1 byte) tells the MTG worker not to broadcast the resulting Solana tx — useful for dry-run / pre-validation.

### Use case: bot-paid invoice-style system call

Use this shape when a backend bot already has a serialized Solana transaction and should pay Computer directly through Mixin Safe. Do not send one plain Safe transaction with `extra = systemCallExtra` and two ordinary outputs. The reliable shape is invoice-style:

1. A storage entry that stores the serialized Solana transaction bytes.
2. A system-call fee entry whose `extra` is the Computer system-call payload.
3. A reference from the fee entry to the storage entry.

Build the Solana transaction for Computer execution:

```ts
const nonce = await computerApi.getNonce(botMix);
const computerPayer = new PublicKey(info.payer);

const nonceAdvanceIx = SystemProgram.nonceAdvance({
  noncePubkey: new PublicKey(nonce.nonce_address),
  authorizedPubkey: computerPayer,
});

const messageV0 = new TransactionMessage({
  payerKey: computerPayer,
  recentBlockhash: nonce.nonce_hash,
  instructions: [nonceAdvanceIx, ...instructions],
}).compileToV0Message(addressLookupTables);

const tx = new VersionedTransaction(messageV0);
const txBuf = Buffer.from(tx.serialize());
const callId = uniqueConversationID(txBuf.toString("hex"), "system call");
```

If Computer must fund SOL for rent or execution, quote the exact top-up before building the Computer extra. Include enough SOL for both the new account rent and any balance the Computer-controlled authority must keep after execution:

```ts
const rentLamports = BigInt(
  await connection.getMinimumBalanceForRentExemption(accountSize)
);
const authorityReserveLamports = BigInt(
  await connection.getMinimumBalanceForRentExemption(0)
);
const requiredAuthorityLamports = rentLamports + authorityReserveLamports;
const currentAuthorityLamports = BigInt(
  await connection.getBalance(authority, "confirmed")
);
const topUpLamports =
  requiredAuthorityLamports > currentAuthorityLamports
    ? requiredAuthorityLamports - currentAuthorityLamports
    : 0n;

const fee = topUpLamports > 0n
  ? await computerApi.getFee(lamportsToSol(topUpLamports))
  : undefined;
```

Put the Computer extra on the system-call fee entry, not on the outer payment envelope:

```ts
const callPayload = buildSystemCallExtra(
  computerUser.id,
  callId,
  false,
  fee?.fee_id
);
const computerExtra = buildComputerExtra(OperationTypeSystemCall, callPayload);
const encodedExtra = encodeMtgExtra(computerInfo.members.app_id, computerExtra);
const extraBuf = Buffer.from(encodedExtra, "utf-8");
```

Build the invoice with storage first and the system-call entry second. The `index_references: [0]` link is what tells Computer which storage transaction contains the Solana transaction bytes:

```ts
const computerRecipient = buildMixAddress({
  version: 2,
  xinMembers: [],
  uuidMembers: computerInfo.members.members,
  threshold: computerInfo.members.threshold,
});

const invoice = newMixinInvoice(computerRecipient);
if (!invoice) throw new Error("Failed to build Computer invoice");

attachStorageEntry(invoice, uniqueConversationID(callId, "storage"), txBuf);

const totalXin = new BigNumber(computerInfo.params.operation.price)
  .plus(fee?.xin_amount ?? "0")
  .toFixed(8, BigNumber.ROUND_CEIL);

attachInvoiceEntry(invoice, {
  trace_id: callId,
  asset_id: XINAssetID,
  amount: totalXin,
  extra: extraBuf,
  index_references: [0],
  hash_references: [],
});
```

When paying the entries programmatically, submit them in order and convert invoice index references into actual Safe transaction hashes. Storage entries use the storage recipient derived from their own `extra`; the system-call entry pays the Computer MTG MIX address:

```ts
const txHashes: string[] = [];

for (const [index, entry] of invoice.entries.entries()) {
  const recipient = isStorageEntry(entry)
    ? getRecipientForStorage(entry.extra)
    : {
        mixAddress: invoice.recipient,
        amount: entry.amount,
      };

  const references = [
    ...entry.hash_references,
    ...entry.index_references.map((ref) => {
      const hash = txHashes[ref];
      if (!hash) {
        throw new Error(`Invoice entry ${index} references unpaid entry ${ref}`);
      }
      return hash;
    }),
  ];

  const hash = await sendSafeTx(
    client,
    spendKey,
    senderUserId,
    entry.asset_id,
    [recipient],
    entry.extra,
    references
  );
  txHashes.push(hash);
}
```

If one XIN UTXO pays the storage entry, its change output may not be immediately spendable for the fee entry. Retry `insufficient total input outputs` for a short bounded window before treating it as fatal.

## Deploy external assets

```go
err := bot.ComputerDeployExternalAsset(ctx, []string{assetID1, assetID2})
```

The Computer rejects the Solana chain ID itself — only Mixin asset UUIDs that map to non-Solana chains are eligible. The asset becomes mintable on Solana once deployment finalizes.

## Lock a nonce account

```go
nonce, err := bot.LockComputerNonceAccount(ctx, mixAddress)
// nonce.Address is the Solana nonce account; persist with the upcoming callID
```

A locked nonce account is consumed by exactly one system call. Lock immediately before building the Solana transaction; if the system call is abandoned, unlock paths are out of band.

## Safety rules

- The operation extra is binary. **Don't string-concatenate.** Use `EncodeOperationMemo` and `EncodeMtgExtra`; their layouts are kernel-relevant.
- `RegisterComputer` requires `ServerPublicKey` and `SpendPrivateKey`. Reject early when either is empty (the agent wrappers do this — copy that pattern).
- `info.Params.Operation.Price` is the registration cost in `info.Params.Operation.Asset`. Re-fetch each call; don't cache across runs.
- `trace` for AddUser is `UniqueObjectId(mix, "computer_register")` — **deterministic**. Re-running `RegisterComputer` with the same MIX is idempotent at the Mixin layer (the MTG sees a duplicate trace).
- For system calls, `callID` is caller-generated. Persist it with whatever business object originated the call **before** sending the tx, so a crash mid-send doesn't leave the call orphaned.
- Solana addresses returned by Computer are not validated by the bot SDK. If you display them to users, validate base58 + length yourself.

## Validation

- After `RegisterComputer`, poll `GetComputerUser(mix)` with bounded retries; fail if `uid` is still zero after MTG round-trip time (~30s typical).
- For system calls, after submission poll `GetComputerSystemCall(callID)` and assert state transitions: `pending → submitted → confirmed | failed`. Surface `error` from sub-calls.
- Round-trip the operation extra: `EncodeOperationMemo` → decode (the first byte is type, the rest is payload) → assert payload re-parses cleanly into the original fields.
- Register on a test bot first; addresses, nonce accounts, and deployed assets are append-only.

## Helper scripts

All scripts live in `skills/mixin-computer/scripts/`. Install deps first:

```bash
npm install
```

### Read-only (no keystore)

```bash
# Query Computer info — payer, MTG members, operation price
node skills/mixin-computer/scripts/computer-info.mjs

# Look up a Computer user by MIX address
node skills/mixin-computer/scripts/computer-user.mjs --address=MIX_ADDRESS

# Quote XIN fee for a SOL amount
node skills/mixin-computer/scripts/query-fees.mjs --sol=0.01

# List assets deployed on Solana via Computer
node skills/mixin-computer/scripts/query-assets.mjs

# Check system call status
node skills/mixin-computer/scripts/query-system-call.mjs --id=CALL_UUID
# Poll until done:
node skills/mixin-computer/scripts/query-system-call.mjs --id=CALL_UUID --watch
```

### Registration (keystore required)

```bash
# Register a bot as a Computer user (pays XIN from bot balance)
node skills/mixin-computer/scripts/register-computer.mjs --config=keystore.json

# Keystore can also be passed via env vars:
#   MIXIN_APP_ID MIXIN_SESSION_ID MIXIN_PRIVATE_KEY
#   MIXIN_SERVER_PUBLIC_KEY MIXIN_SPEND_KEY
```

### System call (keystore required)

```bash
# Submit a minimal system call (nonce advance + memo instruction).
# Demonstrates the full invoice flow: storage entry + system-call entry.
node skills/mixin-computer/scripts/submit-system-call.mjs \
  --config=keystore.json \
  --mix=MIX_ADDRESS_FROM_REGISTER_OUTPUT

# Optionally set Solana RPC endpoint (defaults to mainnet-beta):
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com \
  node skills/mixin-computer/scripts/submit-system-call.mjs ...
```

### Usage patterns

The scripts demonstrate three practical Computer workflows:

**1. Registration** — `register-computer.mjs`: fetch Computer info → derive 1-of-1 MIX address → check if already registered → build AddUser extra → verify XIN balance → send Safe transaction to Computer MTG → poll for confirmation.

**2. System call** — `submit-system-call.mjs`: fetch info + Computer user → lock nonce → build Solana tx → quote fee (if SOL needed) → build Mixin invoice (storage entry + system-call entry) → submit entries in order with UTXO-change retry → poll `GET /system_calls/:id` until confirmed. The `lib/invoice.mjs` helper handles the ordered payment and reference resolution.

**3. Fee quoting** — always call `POST /fee` before a system call that allocates new Solana accounts (rent). The returned `fee_id` is passed to `buildSystemCallExtra`. Omit when the Computer authority already has enough SOL.

For real-world system call submission (the third layer), see the `fluxor_earn2` project's scripts:

- [`init-marginfi-account.ts`](https://github.com/rebetxin/fluxor_earn2/blob/main/scripts/init-marginfi-account.ts) — build a Solana tx, fetch nonce, inject nonce advance, quote rent SOL, build invoice with storage + fee entries, submit and poll.
- [`p0-deposit.ts`](https://github.com/rebetxin/fluxor_earn2/blob/main/scripts/p0-deposit.ts) — asset deposit through Computer with token account rent top-up.
- [`p0-withdraw.ts`](https://github.com/rebetxin/fluxor_earn2/blob/main/scripts/p0-withdraw.ts) — withdrawal with oracle refresh tx filtering and multi-tx submission.

These use shared lib modules (`computer-api.ts`, `safe-tx.ts`, `computer-system-call.ts`) that the `.mjs` scripts in this skill mirror as `lib/computer-api.mjs`, `lib/safe-tx.mjs`.

## Reference

- `github.com/MixinNetwork/bot-api-go-client/v3/computer.go` — all the helpers above (`OperationTypeAddUser`, `OperationTypeSystemCall`, `OperationTypeUserDeposit`, `EncodeOperationMemo`, `EncodeMtgExtra`, `BuildSystemCallExtra`, `RegisterComputer`, `GetComputerInfo`, `GetComputerUser`, `GetComputerDeployedAssets`, `GetComputerSystemCall`, `GetFeeOnXINBasedOnSOL`, `ComputerDeployExternalAsset`, `LockComputerNonceAccount`, `ComputerUserIDToBytes`).
- `@mixin.dev/mixin-node-sdk` — Node.js encoding helpers and invoice utilities: `OperationTypeAddUser`, `OperationTypeSystemCall`, `OperationTypeUserDeposit`, `checkSystemCallSize`, `userIdToBytes`, `buildSystemCallExtra`, `buildComputerExtra`, `encodeMtgExtra`, `newMixinInvoice`, `attachStorageEntry`, `attachInvoiceEntry`, `isStorageEntry`, `getRecipientForStorage`, `estimateStorageCost`, `getInvoiceString`.
- `github.com/MixinNetwork/computer` — full MTG-side runtime; the canonical reference for what a Computer node actually does with these extras.
- https://mvm.dev/register — Computer registration UI documentation.

## Related skills

- [`mixin-safe`](../mixin-safe/SKILL.md) — Safe UTXO flow, MIX address derivation, MTG extra encoding, storage entry pattern.
- [`mixin-mtg-multisig`](../mixin-mtg-multisig/SKILL.md) — what runs on the other side of the MTG, if you want to understand or implement a Computer-style worker.
- [`mixin-bot`](../mixin-bot/SKILL.md) — the kit wrapper (`mixin-kit-go`) that includes a simple Computer HTTP client.
