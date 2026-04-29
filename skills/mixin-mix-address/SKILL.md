---
name: mixin-mix-address
description: This skill should be used when encoding or decoding Mixin address-format payloads — MIX addresses (multisig recipients), MIN invoices (multi-output payment requests), MTG extra payload encoding, mixin:// URL schemes for pay/transfer/users/conversations, and the storage-entry pattern for >256-byte transaction extra.
---

# Mixin Mix Address, Invoice, MTG Extra, URL Scheme

Four related encodings power Mixin's "send a structured payment intent" surface. Use whichever matches your audience:

| Format | Audience | Use for |
|--------|----------|---------|
| `MIX...` address | other Mixin programs | recipient of a Safe transaction |
| `MIN...` invoice | wallet UI / app card | "tap to pay" with one or more outputs |
| MTG `extra` (base64) | MTG group worker | operation dispatch payload |
| `mixin://...` URL | wallet UI | open a screen / pre-fill a transfer |
| `https://mixin.one/pay/...` | web | `code.schemes` → mixin:// after server resolves |

## MIX address — multisig recipient encoding

A `MIX` address packs `(members[], threshold, version)` into a base58check string. Two flavours:

- `bot.NewUUIDMixAddress([]string{u1, u2, ...}, threshold)` — UUID members (Mixin users / bots).
- `bot.NewMainnetMixAddress([]string{XIN_ADDR_1, ...}, threshold)` — mainnet kernel addresses.

```go
addr, _ := bot.NewUUIDMixAddress([]string{aliceUUID, bobUUID}, 2)
fmt.Println(addr.String())  // "MIX..."

// parse back
parsed, _ := bot.NewMixAddressFromString(addr.String())
fmt.Println(parsed.Members(), parsed.Threshold)
```

```js
const { buildMixAddress, parseMixAddress } = require('@mixin.dev/mixin-node-sdk');

const mix = buildMixAddress({ members: [aliceUUID, bobUUID], threshold: 2 });
// "MIX..."

const { members, threshold } = parseMixAddress(mix);
```

**Members are sorted internally** by both SDKs. If you persist or hash the input list elsewhere, sort it the same way (lex UUID).

A 1-of-1 MIX address is the canonical "user MIX address" — generate it from a single UUID + `threshold = 1`.

## MIN invoice — multi-output payment request

An invoice is a single string that encodes one or more outputs (asset + amount + memo + optional storage refs) for a single recipient (a `MixAddress`). When a wallet renders a `MIN...` string, the user sees the breakdown and approves with one tap.

```go
inv := bot.NewMixinInvoice(recipientMixAddr)
err := inv.AddEntry(assetID, "0.5", []byte("payment for X"), nil) // refs nil
err  = inv.AddEntry(otherAsset, "0.01", []byte("fee"), nil)
encoded := inv.Encode()  // "MIN..."
```

```js
// Node — see the kit/SDK invoice helpers; same shape
```

Constraints (validate before encoding):

- Per-entry memo length ≤ kernel `ExtraSizeGeneralLimit` (256 bytes).
- Per-entry references count ≤ 32.
- Recipient threshold matches the consuming worker (1 for personal, t-of-n for multisig / MTG).

Use storage entries (below) when an entry needs to carry more than 256 bytes.

## MTG extra — operation dispatch payload

When sending a Safe transaction *to* an MTG group, the group worker decodes `tx.extra` to find which app + which operation should execute:

```go
import "github.com/MixinNetwork/safe/mtg"

extraB64 := mtg.EncodeMixinExtraBase64(appID, payload)
// pass as `extra` to BuildSafeTransaction
```

The MTG worker calls the matching app worker's `ProcessOutput(out, extra)` after `mtg.DecodeMixinExtraBase64(extra)`.

If `payload` would push `extra` past the kernel limit, replace it with a short reference and store the actual payload via the storage pattern.

## Storage entry — large extra workaround

When `extra` exceeds the kernel's `ExtraSizeGeneralLimit` (256 bytes), the payload cannot ride on the operational transaction directly. Instead:

1. Send a **storage transaction** that contains the full payload as its extra and is paid in **XIN** (the only asset eligible for storage).
2. Take the storage tx's kernel hash.
3. Put a *short* placeholder in the operational tx's extra (often the MTG memo prefix only) and add the storage hash to that tx's `references`.

The MTG worker, when processing the operational tx, looks up `references[i]` to retrieve the full payload.

### Production gating logic (from `MixinNetwork/computer`)

`computer/solana/transaction.go` does it like this:

```
extra = mtg.EncodeMixinExtraBase64(appId, memo)

if len(extra) <= ExtraSizeGeneralLimit:
    SendTransactionUntilSufficient(asset=anyAsset, extra=extra, ...)
else:
    if asset != XIN:
        # cannot inline — operational asset is not XIN, and storage requires XIN
        error("payload too large for non-XIN operation")
    storageHash = CreateObjectStorageUntilSufficient(payload=extra, ...)
    SendTransactionUntilSufficient(asset=XIN, extra=shortMemo, references=[storageHash], ...)
```

Two preconditions, both load-bearing:

- The fallback only works when the operational asset is **XIN**. Storage transactions are XIN-only; if your operation pays in a different asset, restructure the operation (e.g., pre-send the payload via a XIN storage tx in a prior step, then reference its hash from the actual operation tx).
- `references` count is capped at 32 by the kernel. A single payload split across multiple storage transactions burns reference slots fast.

### Node.js helper

```js
const { getRecipientForStorage } = require('@mixin.dev/mixin-node-sdk');

const extra = Buffer.from('long-payload-bytes...', 'hex');
const storageRecipient = getRecipientForStorage(extra);
// Build a Safe transaction whose first recipient is `storageRecipient`,
// whose asset is XIN (c94ac88f-4671-3976-b60a-09064f1811e8),
// and whose `extra` is `extra` itself.
// Submit it through the normal Safe flow. The returned tx hash becomes the reference.
```

### Go helper

In production code, the canonical helper is `common.CreateObjectStorageUntilSufficient(...)` from `MixinNetwork/computer` (it wraps wallet UTXO selection + retry-on-insufficient). The bot SDK exposes the lower-level pieces (`bot.NewUUIDMixAddress`, `bot.BuildSafeTransaction`, references on `*SafeTransactionRequest`) for hand-rolled flows.

The storage transaction needs the same machinery as a normal Safe send (full keystore including `SpendPrivateKey`, wallet store, UTXO selection, signing) — it's not a metadata-only call. Plan for it in projects that emit large extras; don't try to bolt it on at the last minute.

## mixin:// URL scheme

Used inside app cards, web pages, deep links. Rendered by the Mixin Messenger client.

| Path | Effect |
|------|--------|
| `mixin://users/<user_id>` | open user profile |
| `mixin://transfer/<recipient_user_id>` | open a transfer pre-filled |
| `mixin://send?category=...&data=...` | send a message into a conversation |
| `mixin://pay?recipient=...&asset=...&amount=...&memo=...&trace=...` | open the standard Pay sheet |
| `mixin://snapshots?snapshot=...` | open a snapshot detail |

```go
url := fmt.Sprintf("mixin://pay?recipient=%s&asset=%s&amount=%s&trace=%s&memo=%s",
    url.QueryEscape(recipientUserID), assetID, amount, traceID, url.QueryEscape(memo))
```

```js
const url = new URL('mixin://pay');
url.searchParams.set('recipient', recipientUserID);
url.searchParams.set('asset', assetID);
url.searchParams.set('amount', amount);
url.searchParams.set('trace', traceID);
url.searchParams.set('memo', memo);
```

A `https://mixin.one/pay/<base64>` URL is the server-resolvable form. Convert it via `client.code.schemes(url)` (Node) or `bot.CodeSchemes` (Go) to get the canonical `mixin://schemes/<scheme_id>`.

```js
const { MixinApi } = require('@mixin.dev/mixin-node-sdk');
const client = MixinApi();
const resp = await client.code.schemes('https://mixin.one/pay/MIN...');
// resp.scheme_id → render as mixin://schemes/<scheme_id>
```

## When to choose what

| Scenario | Format |
|----------|--------|
| "send to this group of users" | MIX address as recipient |
| "let user pay multiple outputs in one tap" | MIN invoice |
| "trigger an MTG app operation" | MTG extra (encoded into a Safe tx) |
| "open Mixin from web" | `https://mixin.one/pay/...` or `mixin://...` |
| "in-app card opens external URL" | app card with `action: https://...` |
| "in-app card pre-fills a payment" | app card with `action: mixin://pay?...` |

## Validation

- Round-trip every encoded form: encode → decode → assert structural equality.
- For invoices, assert per-entry memo and reference counts before encode.
- For mixin:// URLs, percent-encode every user-supplied value; never concatenate raw user input.
