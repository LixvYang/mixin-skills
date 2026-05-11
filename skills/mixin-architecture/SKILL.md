---
name: mixin-architecture
description: This skill should be used when the user asks about "Mixin SDK", "how does Mixin work", "what's the difference between session key and spend key", "Safe vs legacy", or needs a high-level overview of the Mixin Network programming model in Go or Node.js.
---

# Mixin Architecture

Mixin Network is a multi-asset peer-to-peer network. Bots and apps interact with it through:

1. **Mixin Bot API** at `https://api.mixin.one` — REST, JWT (EdDSA) authenticated.
2. **Mixin Blaze** at `wss://blaze.mixin.one` — WebSocket, subprotocol `Mixin-Blaze-1`, gzip binary frames.
3. **Mixin Safe APIs** (a subset of the Bot API under `/safe/*`) — UTXO-style asset accounting and on-chain interactions.

This skill orients you. Pick a focused skill below for the actual operation you want to perform.

```
┌──────────────────────────────────────────────────────────────────────┐
│                  MIXIN APP / BOT INTEGRATION                         │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│         ┌────────────────┐               ┌────────────────┐          │
│         │  Go bot        │               │ Node.js bot    │          │
│         │  bot-api-go-   │               │ @mixin.dev/    │          │
│         │  client/v3     │               │ mixin-node-sdk │          │
│         └────────┬───────┘               └────────┬───────┘          │
│                  │                                │                  │
│                  │   keystore (app_id, session_id, ...)              │
│                  │                                │                  │
│                  ▼                                ▼                  │
│         ┌──────────────────────────────────────────────┐             │
│         │ JWT (EdDSA) signed: method + uri + body hash │             │
│         └──────────────────────────────────────────────┘             │
│                  │                                │                  │
│                  ▼                                ▼                  │
│   ┌──────────────────────┐          ┌──────────────────────┐         │
│   │ REST api.mixin.one   │          │ WS  blaze.mixin.one  │         │
│   │ /me /messages /safe  │          │   pending → message  │         │
│   │ /multisigs /external │          │   bot replies sync   │         │
│   └──────────────────────┘          └──────────────────────┘         │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

## Two SDK shapes — same protocol

### Go (`bot-api-go-client/v3`)

- Package import alias is `bot`.
- Auth model: build a `*bot.SafeUser` and pass it to the per-call helper.
- Defaults to `https://api.mixin.one` and `blaze.mixin.one`. Override with `bot.SetBaseUri`, `bot.SetBlazeUri`, `bot.SetUserAgent`, `bot.WithAPIKey` — all process-global, do not call from libraries.

```go
su := &bot.SafeUser{
    UserId:            ks.AppID,            // app_id == bot user_id
    SessionId:         ks.SessionID,
    SessionPrivateKey: ks.SessionPrivateKey,
    ServerPublicKey:   ks.ServerPublicKey,  // for PIN encryption / Safe register
    SpendPrivateKey:   ks.SpendPrivateKey,  // for money movement only
}
me, err := bot.UserMe(ctx, su.UserId, su.SessionId, su.SessionPrivateKey)
```

### Node.js (`@mixin.dev/mixin-node-sdk`)

- One client object per keystore via `MixinApi({ keystore })`.
- Methods are namespaced: `client.user.*`, `client.message.*`, `client.utxo.*`, `client.safe.*`, `client.multisig.*`, `client.blaze.*`.

```js
const { MixinApi } = require('@mixin.dev/mixin-node-sdk');
const client = MixinApi({
  keystore: {
    app_id: '...',
    session_id: '...',
    server_public_key: '...',
    session_private_key: '...',
    // spend_key for Safe is provided per-call in utility functions, not on the keystore.
  },
});
const me = await client.user.profile();
```

## Two API surfaces — Safe vs legacy

| Concern | Legacy / direct | Safe (UTXO) |
|---------|-----------------|-------------|
| Endpoint | `/transfers`, `/multisigs/*` | `/safe/*` |
| Accounting | balance per asset | UTXO outputs |
| Auth | session key + PIN | session key + spend key (sign raw tx) |
| Go entry | `bot.SendTransferTransaction` | `bot.ListOutputs` → build raw → `bot.VerifyTransaction` → sign → `bot.SendTransactions` |
| Node entry | `client.transfer.*` | `client.utxo.*`, `client.safe.*`, `client.multisig.createSafeMultisigs` |
| When to use | older bots, legacy multisig groups | all new development, all on-chain withdrawals, MTG groups |

**Default to Safe for new code.** Use legacy only when the target system already requires it.

## Skills router

| Goal | Skill |
|------|-------|
| Load keystore, send/receive messages, manage groups, Blaze loop, kit wrapper | [`mixin-bot`](../mixin-bot/SKILL.md) |
| Safe transfers, withdrawals, asset queries, address encoding | [`mixin-safe`](../mixin-safe/SKILL.md) |
| Mixin Computer (MVM): RegisterComputer, system calls, deployed assets | [`mixin-computer`](../mixin-computer/SKILL.md) — Go end-to-end, Node.js extra encoding helpers |
| MTG group / observer / signer / FROST | [`mixin-mtg-multisig`](../mixin-mtg-multisig/SKILL.md) — Go only |
| User login via Mixin OAuth | [`mixin-oauth`](../mixin-oauth/SKILL.md) |

## Universal safety rules

- Treat `spend_private_key` as money authority. Don't log it, don't pass through URLs, don't ship in client-side code.
- Use stable `request_id` / `trace_id` / `message_id`. The network deduplicates; rotating IDs inside a retry loop creates duplicate transfers or duplicate messages.
- Use decimal strings (Go: `decimal.Decimal` or `mixin/common.Integer`; Node: BigNumber from `bignumber.js` — the SDK uses it internally) for amounts. Never `float64` / `Number`.
- Sort UUIDs deterministically before deriving group IDs, MixAddress members, signing index, or trace seeds. Both SDKs sort internally — match that order in your own derivations.
- Include all query parameters in the path you sign for output / multisig reads.
