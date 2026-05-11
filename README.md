# Mixin Network Skills

Claude Code skills for building on the [Mixin Network](https://developers.mixin.one/docs/api-overview). These skills provide context-aware guidance for the official **Go** and **Node.js** SDKs, plus the third-party `mixin-kit-go` wrapper and the MTG / Trusted Group programming model.

Each skill lives under `skills/<skill-name>/SKILL.md` and is loaded contextually when its trigger keywords appear in a conversation.

## Installation

```bash
# browse and select interactively
npx skills add LixvYang/mixin-skills

# install a specific skill globally
npx skills add LixvYang/mixin-skills --skill mixin-computer -g -a claude-code

# install all skills globally
npx skills add LixvYang/mixin-skills --all -g -a claude-code
```

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
| [`mixin-bot`](skills/mixin-bot/SKILL.md) | keystore, SafeUser, MixinApi, session/spend key, JWT auth, message, sendText, AppCard, Blaze, WebSocket, blaze.loop, conversation, group, search user, bare user, TIP PIN, kit-go, ClientWrapper, Web3, Route | Core bot development — keystore loading, messaging, Blaze WebSocket, conversations, kit wrapper |
| [`mixin-safe`](skills/mixin-safe/SKILL.md) | Safe, UTXO, ghost key, raw transaction, MixAddress, multisig, withdrawal, fee, MixinCashier, deposit, address book, asset, snapshot, ticker, MIX address, MIN invoice, MTG extra, mixin:// URL, storage entry | Safe UTXO transfers, withdrawals, asset queries, address encoding |
| [`mixin-computer`](skills/mixin-computer/SKILL.md) | Mixin Computer, MVM, OperationTypeAddUser, OperationTypeSystemCall, RegisterComputer, GetComputerInfo, system call, nonce account | Public Computer client (Go) + AddUser / SystemCall extras (Go + Node.js encoding utils) |
| [`mixin-mtg-multisig`](skills/mixin-mtg-multisig/SKILL.md) | MTG, mtg.Group, observer, signer, FROST, multi-party-sig, replay check | MTG programs, observer/signer, MPC sessions (Go) |
| [`mixin-oauth`](skills/mixin-oauth/SKILL.md) | oauth, mixin login, authorize, PKCE, client_secret, OAuthGetAccessToken, OAuthKeystore, mixin://codes, scope, identity provider | User login via Mixin OAuth — frontend PKCE (no secret) and backend client_secret flows |

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

### Keystore JSON format

A bot keystore is a JSON file exported from [developers.mixin.one](https://developers.mixin.one) or constructed manually:

```json
{
  "app_id": "uuid",
  "session_id": "uuid",
  "server_public_key": "hex",
  "session_private_key": "hex",
  "spend_private_key": "hex"
}
```

**Field aliases** accepted by scripts:

| Standard name | Alias | Used in |
|--------------|-------|---------|
| `app_id` | `client_id` | OAuth responses |
| `session_private_key` | `private_key` | some older exports |
| `spend_private_key` | `spend_key` | env var `MIXIN_SPEND_KEY` |

Scripts accept keystore via `--config=keystore.json` (file path) or individual env vars (`MIXIN_APP_ID`, `MIXIN_SESSION_ID`, `MIXIN_PRIVATE_KEY`, `MIXIN_SERVER_PUBLIC_KEY`, `MIXIN_SPEND_KEY`).

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
├── README.md
├── CLAUDE.md                         # guidance for Claude Code
├── package.json                      # enables npx skills add
└── skills/
    ├── mixin-architecture/SKILL.md   # router / overview
    ├── mixin-bot/
    │   ├── SKILL.md                  # keystore + messaging + blaze + convs + kit
    │   └── scripts/                  # ping, send-direct, blaze-echo
    ├── mixin-safe/
    │   ├── SKILL.md                  # safe txs + withdrawals + assets + address encoding
    │   └── scripts/                  # safe-snapshots, safe-balance, mix-address, safe-transfer-all
    ├── mixin-computer/
    │   ├── SKILL.md
    │   └── scripts/                  # computer-info, computer-user, query-fees, query-assets, query-system-call, register-computer, submit-system-call
    ├── mixin-mtg-multisig/
    │   ├── SKILL.md
    │   └── scripts/                  # mtg-extra-encode, mtg-extra-decode
    └── mixin-oauth/
        ├── SKILL.md
        └── scripts/                  # oauth-backend, oauth-frontend
```

Most SKILL.md files cover both Go and Node.js. `mixin-mtg-multisig` is Go-only. `mixin-bot` includes a Go-only section for the `mixin-kit-go` wrapper. `mixin-computer` covers Go end-to-end, plus Node.js helpers for encoding Computer extras.

## Helper scripts

Each skill with a `scripts/` directory has runnable demonstrations. Install deps first, then run:

```bash
# Bot — validate keystore, send messages, listen via Blaze
node skills/mixin-bot/scripts/ping.mjs --config=keystore.json
node skills/mixin-bot/scripts/send-direct.mjs --config=keystore.json --to=USER_ID --text="hello"
node skills/mixin-bot/scripts/blaze-echo.mjs --config=keystore.json

# Safe — check balances, list snapshots, transfer all assets
node skills/mixin-safe/scripts/safe-balance.mjs --config=keystore.json
node skills/mixin-safe/scripts/safe-snapshots.mjs --config=keystore.json --limit=10
node skills/mixin-safe/scripts/safe-transfer-all.mjs --config=keystore.json --to=USER_ID --dry-run

# Computer — read-only queries (no keystore)
node skills/mixin-computer/scripts/computer-info.mjs
node skills/mixin-computer/scripts/query-fees.mjs --sol=0.01
node skills/mixin-computer/scripts/query-assets.mjs
node skills/mixin-computer/scripts/query-system-call.mjs --id=CALL_UUID

# Computer — registration + system call submission (keystore required)
node skills/mixin-computer/scripts/register-computer.mjs --config=keystore.json
node skills/mixin-computer/scripts/submit-system-call.mjs --config=keystore.json

# MTG — encode/decode extras
node skills/mixin-mtg-multisig/scripts/mtg-extra-encode.mjs --app=APP_ID --memo=hello
node skills/mixin-mtg-multisig/scripts/mtg-extra-decode.mjs --extra=BASE64_RAW_URL

# OAuth — backend + frontend flow demos
node skills/mixin-oauth/scripts/oauth-backend.mjs --config=keystore.json --code=AUTH_CODE
node skills/mixin-oauth/scripts/oauth-frontend.mjs
```

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
