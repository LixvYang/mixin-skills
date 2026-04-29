# Mixin Network Progressive Disclosure Skills

Progressive disclosure skills for building on the [Mixin Network](https://developers.mixin.one/docs/api-overview). These skills provide context-aware guidance for the official **Go** and **Node.js** SDKs, plus the third-party `mixin-kit-go` wrapper and the MTG / Trusted Group programming model.

Each skill lives under `skills/<skill-name>/SKILL.md` and is loaded contextually when its trigger keywords appear in a conversation.

## SDK landscape

| Language | Package | Repository |
|----------|---------|-----------|
| Go | `github.com/MixinNetwork/bot-api-go-client/v3` | https://github.com/MixinNetwork/bot-api-go-client |
| Node.js / TS | `@mixin.dev/mixin-node-sdk` | https://github.com/MixinNetwork/bot-api-nodejs-client |
| Go (kit) | `github.com/DomeLiquid/mixin-kit-go` | wrapper around `bot-api-go-client/v3` + `fox-one/mixin-sdk-go/v2` |
| Go (MTG) | `github.com/MixinNetwork/safe/mtg`, `github.com/MixinNetwork/multi-party-sig` | for Mixin Trusted Group programs |

## Skills

| Skill | Trigger Keywords | Description |
|-------|------------------|-------------|
| [`mixin-architecture`](skills/mixin-architecture/SKILL.md) | mixin sdk, SafeUser, keystore, bot api | High-level SDK and protocol overview |
| [`mixin-keystore`](skills/mixin-keystore/SKILL.md) | keystore, SafeUser, MixinApi, app_id, session_id, server_public_key, spend_private_key, JWT auth | Load credentials and construct the SDK client |
| [`mixin-messaging`](skills/mixin-messaging/SKILL.md) | sendText, sendPost, AppCard, AppButton, message_id idempotency | Direct, group, rich messages and idempotency |
| [`mixin-blaze`](skills/mixin-blaze/SKILL.md) | Blaze, WebSocket, blaze.loop, BlazeListener, OnMessage, OnAckReceipt | Long-lived bot socket loop |
| [`mixin-conversations`](skills/mixin-conversations/SKILL.md) | conversation, group create, add/remove participant, SYSTEM_CONVERSATION, search user | Conversations, participants, system events |
| [`mixin-safe-transactions`](skills/mixin-safe-transactions/SKILL.md) | Safe, UTXO, ghost key, raw transaction, MixAddress, multisig, sign/unlock/cancel | Safe (UTXO) transfers and multisig flows |
| [`mixin-withdrawals`](skills/mixin-withdrawals/SKILL.md) | withdrawal, fee, deposit entry, address book, MixinCashier | On-chain withdrawal, fee output, deposit, address book |
| [`mixin-mix-address`](skills/mixin-mix-address/SKILL.md) | MIX address, MIN invoice, MTG extra, mixin:// scheme | Address encoding, invoices, URL schemes |
| [`mixin-network-assets`](skills/mixin-network-assets/SKILL.md) | asset, snapshot, network ticker, top assets, asset search | Public asset/snapshot/ticker APIs |
| [`mixin-computer`](skills/mixin-computer/SKILL.md) | Mixin Computer, MVM, OperationTypeAddUser, OperationTypeSystemCall, RegisterComputer, GetComputerInfo, system call, nonce account | Public Computer client + AddUser / SystemCall extras (Go) |
| [`mixin-mtg-multisig`](skills/mixin-mtg-multisig/SKILL.md) | MTG, mtg.Group, observer, signer, FROST, multi-party-sig, replay check | MTG programs, observer/signer, MPC sessions (Go) |
| [`mixin-kit-go`](skills/mixin-kit-go/SKILL.md) | mixin-kit-go, ClientWrapper, TransferOne, TransferMany, Web3Quote, Web3Swap, ComputerClient | DomeLiquid kit wrapper (Go) |

## Mixin Key Concepts

### Bot identity model

```
keystore.json
  ├─ app_id              ──► SafeUser.UserId   (Go)  /  keystore.app_id   (Node)
  ├─ session_id          ──► SafeUser.SessionId       /  keystore.session_id
  ├─ session_private_key ──► API JWT signing (EdDSA)     ── BOT API auth
  ├─ server_public_key   ──► PIN/TIP encryption          ── required for Safe register / PIN encryption
  └─ spend_private_key   ──► transaction signing (Safe)  ── required for any money movement
```

The `app_id` is also the bot's `user_id`. A bot is just a user with extra fields.

### API surface

```
                     ┌────────────────────────────────┐
                     │ https://api.mixin.one (REST)   │
                     │  /me, /assets, /messages,      │
                     │  /safe/*, /multisigs/*,        │
                     │  /external/*                   │
                     └────────────────────────────────┘
                                    ▲
                                    │ EdDSA-signed JWT (method+uri+body hash)
                                    │
            ┌───────────────────────┴───────────────────────┐
            │                                               │
   ┌────────────────┐                              ┌────────────────┐
   │  Go SDK        │                              │  Node.js SDK   │
   │  bot.*         │                              │  client.*      │
   └────────────────┘                              └────────────────┘
            │                                               │
            └─────────► wss://blaze.mixin.one ◄─────────────┘
                            (subprotocol Mixin-Blaze-1, gzip binary)
```

### Two key separations

1. **Session key vs. Spend key.** `session_private_key` authenticates API calls; `spend_private_key` signs Safe transactions. Code paths that don't move money should never load the spend key.
2. **Direct asset transfer vs. Safe (UTXO) transfer.** Legacy `client.transfer.*` (Node) and `bot.SendTransferTransaction` (Go) call high-level helpers. Safe flows use `client.utxo.*` / Safe API + ghost keys + raw tx + verify + sign + submit.

### Trace IDs and idempotency

Every money operation, every multisig request, every Blaze message has a stable ID:

| Concept | Field | Generated by |
|---------|-------|--------------|
| Money transfer | `request_id` / `trace_id` | caller (UUID v4 or deterministic) |
| Multisig request | `request_id` | caller |
| Blaze message | `message_id` | caller |
| Safe transaction | `request_id` | caller, must match raw tx submitted |

**Never rotate the ID inside a retry loop unless the operation is intentionally new.** Mixin uses these IDs to dedupe.

## Repository layout

```
mixin-skills/
├── README.md                         # this file
└── skills/
    ├── mixin-architecture/SKILL.md   # router / overview
    ├── mixin-keystore/SKILL.md
    ├── mixin-messaging/SKILL.md
    ├── mixin-blaze/SKILL.md
    ├── mixin-conversations/SKILL.md
    ├── mixin-safe-transactions/SKILL.md
    ├── mixin-withdrawals/SKILL.md
    ├── mixin-mix-address/SKILL.md
    ├── mixin-network-assets/SKILL.md
    ├── mixin-computer/SKILL.md
    ├── mixin-mtg-multisig/SKILL.md
    └── mixin-kit-go/SKILL.md
```

Most SKILL.md files cover both Go and Node.js. `mixin-computer`, `mixin-mtg-multisig`, and `mixin-kit-go` are Go-only.

## Source references

The skills are derived from inspection of these upstream sources (read at the time of writing):

- `MixinNetwork/bot-api-go-client/v3` — Go SDK, `bot.*` package.
- `MixinNetwork/bot-api-nodejs-client` — Node.js SDK, `@mixin.dev/mixin-node-sdk` (`MixinApi`, `client.utxo.*`, `client.safe.*`, `client.multisig.*`, etc).
- `MixinNetwork/computer` — production reference for MTG / observer / signer patterns.
- `DomeLiquid/mixin-kit-go` — opinionated kit wrapper that combines bot SDK + fox-one SDK + Web3 + Computer client.
- `MixinNetwork/safe` — `mtg.Group`, deterministic worker, action processing.
- `MixinNetwork/multi-party-sig` — FROST keygen/sign sessions.

## License

[GNU General Public License v3.0](LICENSE).
