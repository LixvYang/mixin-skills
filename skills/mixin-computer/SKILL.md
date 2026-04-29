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

Node.js equivalents (encoding only) live in `@mixin.dev/mixin-node-sdk` utils:

```js
const { buildComputerExtra, buildSystemCallExtra, encodeMtgExtra, checkSystemCallSize, OperationTypeAddUser, OperationTypeSystemCall } =
  require('@mixin.dev/mixin-node-sdk/dist/client/utils');

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
| `GET /` | `bot.GetComputerInfo(ctx)` | observer, payer, MTG `app_id`, `members`, `threshold`, operation asset + price |
| `GET /users/:id` | `bot.GetComputerUser(ctx, address)` | `{uid, mix, solana_address}` |
| `GET /assets` | `bot.GetComputerDeployedAssets(ctx)` | deployed Solana asset table; each entry exposes `GetSolanaAssetId()` derived as `UniqueObjectId(SolanaChainId, asset.address)` |
| `GET /system_calls/:id` | `bot.GetComputerSystemCall(ctx, callID)` | call status, hash, error, sub-calls |
| `GET /fees/sol/:amount` | `bot.GetFeeOnXINBasedOnSOL(ctx, solAmount)` | fee in XIN, `fee_id` |

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

## Reference

- `github.com/MixinNetwork/bot-api-go-client/v3/computer.go` — all the helpers above (`OperationTypeAddUser`, `OperationTypeSystemCall`, `OperationTypeUserDeposit`, `EncodeOperationMemo`, `EncodeMtgExtra`, `BuildSystemCallExtra`, `RegisterComputer`, `GetComputerInfo`, `GetComputerUser`, `GetComputerDeployedAssets`, `GetComputerSystemCall`, `GetFeeOnXINBasedOnSOL`, `ComputerDeployExternalAsset`, `LockComputerNonceAccount`, `ComputerUserIDToBytes`).
- `MixinNetwork/bot-api-nodejs-client/src/client/utils/computer.ts` — Node.js encoding helpers (`OperationTypeAddUser`, `OperationTypeSystemCall`, `OperationTypeUserDeposit`, `MAX_SOLANA_TX_SIZE`, `checkSystemCallSize`, `userIdToBytes`, `buildSystemCallExtra`, `buildComputerExtra`, `encodeMtgExtra`).
- `github.com/MixinNetwork/computer` — full MTG-side runtime; the canonical reference for what a Computer node actually does with these extras.
- https://mvm.dev/register — Computer registration UI documentation.

## Related skills

- [`mixin-safe-transactions`](../mixin-safe-transactions/SKILL.md) — underlying UTXO + ghost key + raw tx flow used to send extras to the MTG.
- [`mixin-mix-address`](../mixin-mix-address/SKILL.md) — MIX address derivation, MTG extra encoding, object-storage entry pattern.
- [`mixin-mtg-multisig`](../mixin-mtg-multisig/SKILL.md) — what runs on the other side of the MTG, if you want to understand or implement a Computer-style worker.
- [`mixin-kit-go`](../mixin-kit-go/SKILL.md) — the kit's `ComputerClient` is a thin wrapper around the same public endpoints; use the kit when your project already does.
