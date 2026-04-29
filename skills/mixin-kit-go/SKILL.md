---
name: mixin-kit-go
description: This skill should be used when building, reviewing, or debugging Go applications that use github.com/DomeLiquid/mixin-kit-go — including ClientWrapper setup, fox-one mixin SDK Safe transfers (TransferOne / TransferMany / TransferManyN), inscription transfers, MAX_UTXO_NUM aggregation, Mixin invoices (NewMixinInvoiceUserId), Mixin Route Web3 quote/swap APIs, and the public Mixin Computer HTTP API client.
---

# mixin-kit-go (Go)

Use this skill for projects importing `github.com/DomeLiquid/mixin-kit-go`. The kit is an application-level wrapper that combines:

- `fox-one/mixin-sdk-go/v2` — the Safe transaction builder.
- `MixinNetwork/bot-api-go-client/v3` — the bot API auth client (`bot.BotAuthClient`, `bot.SafeUser`).
- Mixin Route (Web3) HTTP client.
- `MixinNetwork/mixin` — kernel primitives (key parsing, common types).
- A `ComputerClient` that calls `https://computer.mixin.one`.

For low-level bot SDK work, use [`mixin-keystore`](../mixin-keystore/SKILL.md) and [`mixin-messaging`](../mixin-messaging/SKILL.md). For raw Safe transaction internals, use [`mixin-safe-transactions`](../mixin-safe-transactions/SKILL.md). For MTG node implementation, use [`mixin-mtg-multisig`](../mixin-mtg-multisig/SKILL.md).

> **Go only.** No Node.js equivalent.

## First checks

1. Inspect `go.mod` for `github.com/DomeLiquid/mixin-kit-go` and its version (or `replace` path).
2. Search for `kit.NewMixinClientWrapper`, `TransferOne`, `TransferMany`, `TransferManyN`, `InscriptionTransfer`, `Web3Quote`, `Web3Swap`, `NewMixinInvoiceUserId`, `NewComputerClient`.
3. Read how `kit.Config` is loaded. Required JSON fields: `app_id`, `session_id`, `server_public_key`, `session_private_key`, `spend_key`.
4. Identify whether the change is **Safe transfer**, **Web3 / Route**, **invoice**, or **Computer API**, and load the matching section below.

## Bootstrapping

```go
import "github.com/DomeLiquid/mixin-kit-go"

cfg := kit.Config{
    AppID:             "...",
    SessionID:         "...",
    ServerPublicKey:   "...",
    SessionPrivateKey: "...",
    SpendKey:          "...",
}
wrapper, err := kit.NewMixinClientWrapper(cfg)
```

`NewMixinClientWrapper` does network I/O during init: it calls `UserMe(ctx)` to confirm credentials. In tests, prefer wrapping behind a small interface or constructing the inner clients (fox-one `mixin.Client`, `bot.BotAuthClient`) directly.

`wrapper` exposes:

- Fox-one `*mixin.Client` (for low-level Safe builder access).
- Bot SDK auth client (used by Web3 sign helpers).
- `Web3Client` and `ComputerClient` attached on the wrapper.

## Safe transfer helpers

| Helper | When |
|--------|------|
| `TransferOne` | one output to one user / MIX address |
| `TransferMany` | multiple outputs in one tx, ≤ `MAX_UTXO_NUM = 255` |
| `TransferManyN` | > 255 outputs; chunks and derives child request IDs |
| `InscriptionTransfer` | inscription UTXO movement |
| `SyncArrgegateUtxos` | aggregate dust before a big send (note SDK's exported spelling) |

```go
amount := decimal.RequireFromString("0.5")
tx, err := wrapper.TransferOne(ctx, kit.TransferRequest{
    AssetID:   assetID,
    Amount:    amount,
    OpponentID: recipientUUID,
    RequestID: requestID,    // stable per intent
    Memo:      "thanks",
})
```

Constraints — pulled from the kit source:

- Amounts: `decimal.Decimal` from strings. **Never** `decimal.NewFromFloat` in production payment paths.
- Normal transfers skip inscription UTXOs. Use `InscriptionTransfer` when you need to spend inscriptions.
- Wrapper serializes transfer helpers with `transferMutex`. Don't add concurrent transfer code that bypasses the lock.
- `RequestID` stays stable across retries.

Keep the kit's exported identifier spelling — including `SyncArrgegateUtxos` and `GetDepolyedAssets` — unless the task is an explicit breaking API cleanup. Renaming them is a public-API change.

## Web3 / Mixin Route

Web3 calls go to `https://api.route.mixin.one`. The kit signs requests with `bot.BotAuthClient.SignRequest` and adds headers:

- `MR-ACCESS-TIMESTAMP` — unix seconds
- `MR-ACCESS-SIGN` — signature

```go
tokens, _    := wrapper.Web3.Web3Tokens(ctx)
quote,  _    := wrapper.Web3.Web3Quote(ctx, kit.QuoteRequest{InputMint, OutputMint, InputAmount})
swap,   _    := wrapper.Web3.Web3Swap(ctx, kit.SwapRequest{...})
order,  _    := wrapper.Web3.GetWeb3SwapOrder(ctx, swap.OrderID)
```

After `Web3Swap`, the API returns a `mixin://.../pay/...` URL. Decode it with `kit.DecodeTx` to get the `(payee, asset, amount, memo, trace)` tuple, then pay it with `TransferOne`.

When adding new query APIs to the kit, build query strings with `url.Values{}` — never manual `?a=...&b=...` concatenation.

## Invoices

```go
inv := kit.NewMixinInvoiceUserId(recipientUUID)  // 1-of-1 recipient invoice
inv.AddEntryHash(assetID, amount, memo, hashRefs)
inv.AddEntryIndex(assetID, amount, memo, indexRefs)
inv.AddStorageEntry(...)  // for >256-byte memo via storage
encoded := inv.Encode()  // "MIN..."
```

`AddEntry*` validates memo length against `common.ExtraSizeGeneralLimit` and reference count limits before appending. See [`mixin-mix-address`](../mixin-mix-address/SKILL.md) for invoice semantics.

## Mixin Computer API (HTTP)

```go
cc := kit.NewComputerClient(cfg)  // https://computer.mixin.one
info,    _ := cc.GetComputerInfo(ctx)
user,    _ := cc.GetUser(ctx, mixinUserID)
assets,  _ := cc.GetDepolyedAssets(ctx)            // note kit spelling
calls,   _ := cc.SystemCalls(ctx, cursor, limit)
nonces,  _ := cc.NonceAccounts(ctx)
deploy,  _ := cc.DeployAsset(ctx, kit.DeployAssetReq{...})
fee,     _ := cc.GetFeeOnXIN(ctx, assetID)
```

`NewComputerClient` is **only** an HTTP API client. It does **not** implement MTG consensus, observer loops, or MPC signing — for that, see [`mixin-mtg-multisig`](../mixin-mtg-multisig/SKILL.md).

## Safety rules

- Treat `SpendKey` and the derived `SpendKey` field as money authority. Never log config, raw keys, signed raw transactions, or Route signatures.
- For amounts, `decimal.Decimal` from strings.
- Stable `RequestID` across retries.
- The kit's exported names with typos (`SyncArrgegateUtxos`, `GetDepolyedAssets`) are stable API — don't silently rename.

## Validation

- For chunking (`TransferManyN`), test boundary at exactly 255 outputs and at 256.
- For Web3, test URL decoding (`DecodeTx`) against the format the swap API actually returns.
- For invoice, test memo-length and reference-count rejection paths.
- For Computer API, use `httptest` or a custom `resty.Client` injected via the kit's options where exposed.
- Around `transferMutex`: write a concurrency stress test that fires 50 `TransferOne` calls and asserts request IDs are not reused.
