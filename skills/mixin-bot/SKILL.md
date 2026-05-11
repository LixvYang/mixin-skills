---
name: mixin-bot
description: This skill should be used when building Mixin bots — loading keystores and constructing SafeUser (Go) / MixinApi (Node), JWT auth, session/spend key separation, sending messages (direct, group, text, post, app card, buttons), Blaze WebSocket loop at wss://blaze.mixin.one (Mixin-Blaze-1, gzip), conversations and group management, user search, bare user TIP PIN registration, OAuth third-party login, idempotency, message_id dedup, and the mixin-kit-go wrapper (Go-only).
---

# Mixin Bot

All Mixin bots start with the same three layers:

```
keystore.json ──► SafeUser / MixinApi ──► send messages, listen via Blaze, manage conversations
```

---

## Bootstrapping

A Mixin bot's identity is a JSON keystore exported from `https://developers.mixin.one`.

### Keystore fields

```json
{
  "app_id": "uuid",
  "session_id": "uuid",
  "server_public_key": "hex",
  "session_private_key": "hex",
  "spend_private_key": "hex"
}
```

| Field | Used for | Required for |
|-------|----------|--------------|
| `app_id` | bot's `user_id` (a bot is a user) | every call |
| `session_id` | session identifier | every call |
| `session_private_key` | EdDSA-sign request JWTs | every call |
| `server_public_key` | encrypt PIN/TIP payloads, Safe registration | PIN flow, Safe register |
| `spend_private_key` | sign Safe raw transactions | every Safe / withdrawal / multisig money op |

**A bot's `app_id` is the same value as its `user_id`.** The Go SDK stores it on `SafeUser.UserId`.

### Auth model

The SDK signs each request as a JWT with EdDSA over the `session_private_key`. Claims bind:

- `method` (HTTP verb, uppercase)
- `uri` (path **including** query string)
- `body` (sha256 hash hex)
- `request_id`, `uid`, `sid`, `scope`, `iat`, `exp`

If you build a custom signed call, the signed `uri` must exactly match the request URI — query parameters included.

### Go: load keystore and build SafeUser

```go
package mixinapp

import (
    "context"
    "encoding/json"
    "fmt"
    "os"

    bot "github.com/MixinNetwork/bot-api-go-client/v3"
)

type Keystore struct {
    AppID             string `json:"app_id"`
    SessionID         string `json:"session_id"`
    ServerPublicKey   string `json:"server_public_key"`
    SessionPrivateKey string `json:"session_private_key"`
    SpendPrivateKey   string `json:"spend_private_key"`
}

func LoadKeystore(path string) (*Keystore, error) {
    raw, err := os.ReadFile(path)
    if err != nil {
        return nil, fmt.Errorf("read keystore: %w", err)
    }
    var ks Keystore
    if err := json.Unmarshal(raw, &ks); err != nil {
        return nil, fmt.Errorf("parse keystore: %w", err)
    }
    return &ks, nil
}

// MessagingUser — for code that only sends/receives messages.
func (k *Keystore) MessagingUser() *bot.SafeUser {
    return &bot.SafeUser{
        UserId:            k.AppID,
        SessionId:         k.SessionID,
        SessionPrivateKey: k.SessionPrivateKey,
    }
}

// FullUser — for code that signs Safe transactions / multisigs.
func (k *Keystore) FullUser() *bot.SafeUser {
    return &bot.SafeUser{
        UserId:            k.AppID,
        SessionId:         k.SessionID,
        SessionPrivateKey: k.SessionPrivateKey,
        ServerPublicKey:   k.ServerPublicKey,
        SpendPrivateKey:   k.SpendPrivateKey,
    }
}

func ProfileMe(ctx context.Context, ks *Keystore) (*bot.User, error) {
    return bot.UserMe(ctx, ks.AppID, ks.SessionID, ks.SessionPrivateKey)
}
```

**Build narrow SafeUsers.** Code paths that don't move money should not even know the spend key. Pass `MessagingUser()` to message senders, `FullUser()` only to transfer/withdrawal helpers.

#### Process-global SDK config (Go)

```go
bot.SetBaseUri("https://api.mixin.one")
bot.SetBlazeUri("blaze.mixin.one")
bot.SetUserAgent("my-bot/1.0")
```

These mutate package-level globals. Call them only from `main()` / startup.

### Node.js: load keystore and build MixinApi

```ts
import { MixinApi } from '@mixin.dev/mixin-node-sdk';
import keystore from './keystore.json';

const client = MixinApi({
  keystore,
  blazeOptions: {
    parse: true,    // SDK decodes message data_base64 for you
    syncAck: true,  // ack each received message synchronously
  },
});

const me = await client.user.profile();
```

The Node SDK accepts a *partial* keystore for read-only / OAuth flows.

#### Keystore types

| Source | Has `spend_private_key` | Can |
|--------|--------------------------|-----|
| Bot dashboard export | yes | bot APIs, Safe transfers, multisig |
| OAuth `getToken` response | no | user-scoped read APIs |
| Bare user + TIP register | yes | full bot/user APIs after `safe.register` |

#### Bare user + TIP PIN registration (Node)

When your app provisions sub-accounts, generate two Ed25519 keypairs — session and spend:

```js
const { MixinApi, getED25519KeyPair, base64RawURLEncode } = require('@mixin.dev/mixin-node-sdk');

const root = MixinApi({ keystore });
const session = getED25519KeyPair();
const newUser = await root.user.createBareUser('alice', base64RawURLEncode(session.publicKey));

const userClient = MixinApi({
  keystore: {
    app_id: newUser.user_id,
    session_id: newUser.session_id,
    pin_token_base64: newUser.pin_token_base64,
    session_private_key: session.seed.toString('hex'),
  },
});

const spend = getED25519KeyPair();
await userClient.pin.updateTipPin('', spend.publicKey.toString('hex'), newUser.tip_counter + 1);
await userClient.pin.verifyTipPin(spend.seed);
const account = await userClient.safe.register(
  newUser.user_id,
  spend.seed.toString('hex'),
  spend.seed,
);
```

Persist `session_private_key` and `spend_private_key` **before** completing TIP registration — they cannot be recovered from Mixin servers.

### Validation

- After loading, call `bot.UserMe` (Go) or `client.user.profile()` (Node) to confirm credentials work.
- Never write the keystore JSON or `spend_private_key` into source control or logs.
- For browsers: `@mixin.dev/mixin-node-sdk` uses Node `Buffer`. Use a polyfill (e.g. `vite-plugin-node-polyfills`) when shipping to a browser bundle.

---

## Messaging

### Categories

| Category | Payload (`data` decoded) |
|----------|--------------------------|
| `PLAIN_TEXT` | UTF-8 text |
| `PLAIN_POST` | Markdown |
| `PLAIN_IMAGE`, `PLAIN_DATA`, `PLAIN_VIDEO`, `PLAIN_AUDIO` | JSON: `{attachment_id, mime_type, ...}` |
| `APP_CARD` | JSON `{app_id, cover_url?, icon_url?, title, description, actions, shareable}` |
| `APP_BUTTON_GROUP` | JSON array `[{label, color, action}, ...]` (max 6 buttons) |
| `SYSTEM_ACCOUNT_SNAPSHOT` | inbound: bot received a legacy transfer |
| `SYSTEM_CONVERSATION` | inbound: group membership changed |

### Idempotency rule

Pass a deterministic `message_id` (UUID-v3/v5 or any stable UUID). The Mixin server dedupes on `message_id`. Common pattern: `uuid.NewV5(namespace, intent || conversation_id || sender || hash(payload))`.

### Go: direct message

```go
msgID := uuid.Must(uuid.NewV4()).String()
err := bot.PostMessage(ctx, recipientUserID, "hello", msgID, su)
```

For richer payloads:

```go
req := &bot.MessageRequest{
    ConversationId: bot.UniqueConversationId(su.UserId, recipientUserID),
    RecipientId:    recipientUserID,
    MessageId:      msgID,
    Category:       "PLAIN_POST",
    Data:           base64.RawURLEncoding.EncodeToString([]byte("# Hello\nMarkdown body")),
}
err := bot.PostMessage2(ctx, req, su)
```

### Go: app card / app button

App cards use the new format with `cover_url` (16:10 image), `actions` array (replaces deprecated single `action`), and `shareable`:

```go
card := bot.AppCardData{
    AppId:   su.UserId,
    Title:   "Open Web",
    Description: "tap to view",
    Action:  "https://example.com/page",    // deprecated, fallback
    Cover:   "https://example.com/cover.png", // 16:10 image
    Actions: []bot.AppButtonData{
        {Label: "Open",  Color: "#ABABAB", Action: "https://example.com"},
        {Label: "Share", Color: "#4CAF50", Action: "input:share"},
    },
    Shareable: true,
}
data, _ := json.Marshal(card)
req := &bot.MessageRequest{
    ConversationId: convID,
    RecipientId:    recipientID,
    MessageId:      uuid.Must(uuid.NewV4()).String(),
    Category:       "APP_CARD",
    Data:           base64.RawURLEncoding.EncodeToString(data),
}
err := bot.PostMessage2(ctx, req, su)
```

**New vs deprecated fields:**

| Field | Status | Constraint |
|-------|--------|------------|
| `title` | required | 1–36 chars |
| `description` | required | 1–1024 chars |
| `cover_url` | recommended | 16:10 image URL |
| `icon_url` | deprecated | — |
| `actions` | recommended | array of `{label, color, action}`, max 6 |
| `action` | deprecated | fallback when `actions` absent |
| `shareable` | optional | boolean, default false |

Buttons use `APP_BUTTON_GROUP` with `[]bot.AppButtonData`.

#### Action URL schemas for APP_CARD

The `action` / `actions[].action` field supports these schemas:

| Schema | Example | Effect |
|--------|---------|--------|
| `https://...` | `https://example.com/page` | external URL (requires dashboard domain whitelist) |
| `mixin://users/<uuid>` | `mixin://users/a1b2...` | open user profile |
| `mixin://conversations/<uuid>` | `mixin://conversations/a1b2...` | open conversation |
| `mixin://send/` | `mixin://send/` | open send screen |
| `mixin://pay?...` | `mixin://pay?recipient=...&asset=...&amount=...&trace=...` | open Pay sheet |
| `input:share` | `input:share` | trigger share sheet |
| `input:<text>` | `input:/help` | pre-fill bot input |

External `https://` domains must be whitelisted at `developers.mixin.one` → your bot → OAuth → Redirect URIs. Mixin-native schemas (`mixin://`, `input:`) work without whitelisting.

### Go: group fan-out

The bot writes one message with `ConversationId` set to the group ID. Mixin fans it out. To skip bots:

```go
parts, err := bot.ParticipantsConversation(ctx, conversationID, su)
humans := make([]string, 0, len(parts))
for _, p := range parts {
    user, _ := bot.GetUser(ctx, p.UserId, su)
    if user != nil && user.App == nil {
        humans = append(humans, p.UserId)
    }
}
```

### Node.js: direct message

```js
import { uniqueConversationID } from '@mixin.dev/mixin-node-sdk';
const { v4 } = require('uuid');

await client.message.sendText(recipientUserID, 'hello');
// equivalent to:
await client.message.sendLegacy({
  conversation_id: uniqueConversationID(keystore.app_id, recipientUserID),
  recipient_id: recipientUserID,
  message_id: v4(),
  category: 'PLAIN_TEXT',
  data: 'hello',
});
```

### Node.js: app card / app button

```js
await client.message.sendLegacy({
  conversation_id: convID,
  recipient_id: recipientID,
  message_id: v4(),
  category: 'APP_CARD',
  data_base64: base64RawURLEncode(JSON.stringify({
    app_id: client.keystore.app_id,
    cover_url: 'https://example.com/cover.png',
    title: 'Open Web',
    description: 'tap to view',
    actions: [
      { label: 'Open',  color: '#ABABAB', action: 'https://example.com' },
      { label: 'Share', color: '#4CAF50', action: 'input:share' },
    ],
    shareable: true,
  })),
});
```

Old deprecated fields (`icon_url`, single `action`) still work but prefer the new format.

### Node.js: group fan-out

```js
await client.message.sendLegacy({
  conversation_id: groupConversationID,
  message_id: v4(),
  category: 'PLAIN_TEXT',
  data: 'hi everyone',
});
```

### Reply patterns

When your Blaze handler receives a message, reply using the same SDK helpers:

```js
import { BlazeKeystoreClient } from "@mixin.dev/mixin-node-sdk/blaze";

const handler = {
  onMessage: async (msg) => {
    if (msg.category === 'PLAIN_TEXT') {
      const text = Buffer.from(msg.data_base64, 'base64').toString();
      if (text === '/help') {
        await client.message.sendText(msg.user_id, 'Commands: /help /balance');
      }
    }
  },
};
BlazeKeystoreClient(keystore, { parse: true, syncAck: true }).loop(handler);
```

### Validation

- Test handler logic against synthetic `msg` objects, not the live WebSocket.
- Send same `message_id` twice and assert no duplicate user-visible messages.
- App card constraints: title ≤ 36 chars, description ≤ 128 chars, ≤ 6 buttons.

---

## Conversations

### CONTACT vs GROUP

- **`CONTACT`** — 1:1 between two users (or bot+user). `conversation_id` is deterministic.
- **`GROUP`** — multi-party, random UUID.

### Deterministic 1:1 ID

```go
// Go
convID := bot.UniqueConversationId(botUserID, peerUserID)
```

```js
// Node
const convID = uniqueConversationID(botUserID, peerUserID);
```

Order of arguments doesn't matter; the helper sorts internally.

### Search users

```go
// Go — by Mixin number (7-9 digit identifier)
user, err := bot.SearchUser(ctx, "39427696", su)
```

```js
// Node
const user = await client.user.search('39427696');
```

Use `client.user.fetch(user_id)` / `bot.GetUser` when you already have the UUID.

### Create group

```go
conv, err := bot.CreateConversation(ctx, "GROUP", "", "Repo Watch", "announcement text", []*bot.Participant{
    {UserId: aliceID, Role: "ADMIN"},
    {UserId: bobID,   Role: ""},
}, su)
```

```js
const conv = await client.conversation.createGroup({
  name: 'Repo Watch',
  participants: [
    { user_id: aliceID, role: 'ADMIN' },
    { user_id: bobID },
  ],
});
```

### Manage participants

```go
err = bot.AddParticipant(ctx, convID, []string{newUserID}, su)
err = bot.RemoveParticipant(ctx, convID, []string{kickedID}, su)
err = bot.UpdateParticipantRole(ctx, convID, promotedID, "ADMIN", su)
```

```js
await client.conversation.addParticipants(convID, [newUserID]);
await client.conversation.removeParticipants(convID, [kickedID]);
await client.conversation.adminParticipants(convID, [promotedID]);
```

### Fetch conversation

```go
conv, err := bot.ConversationShow(ctx, convID, su)
```

```js
const conv = await client.conversation.fetch(convID);
```

### Bot-only notification group

Create once, persist `conversation_id`:

```js
const me = await client.user.profile();
const conv = await client.conversation.createGroup({
  name: 'Notifications',
  participants: [{ user_id: me.app.creator_id }],
});
persist('NOTIFY_CONV_ID', conv.conversation_id);
```

---

## Blaze WebSocket

Blaze is the bot's inbox: `wss://blaze.mixin.one` (subprotocol `Mixin-Blaze-1`, gzip binary frames).

### What Blaze delivers

| Inbound | Trigger |
|---------|---------|
| user message | another user / group sent to the bot's conversation |
| `SYSTEM_ACCOUNT_SNAPSHOT` | bot received a legacy transfer |
| `SYSTEM_CONVERSATION` | group membership changed |
| `ACKNOWLEDGE_MESSAGE_RECEIPT` | another participant read a message the bot sent |

### Pending message rule

When the bot reconnects, Blaze re-delivers all un-acked messages. **Handlers must be idempotent** on `message_id`.

### Go: listener interface

```go
type myHandler struct{ su *bot.SafeUser }

func (h *myHandler) OnMessage(ctx context.Context, msg bot.MessageView, userID string) error {
    if msg.Category == "PLAIN_TEXT" {
        text, _ := base64.RawURLEncoding.DecodeString(msg.Data)
        return bot.PostMessage(ctx, msg.UserId, "echo: "+string(text),
            bot.UuidNewV4().String(), h.su)
    }
    return nil
}

func (h *myHandler) OnAckReceipt(ctx context.Context, msg bot.MessageView, userID string) error { return nil }

func (h *myHandler) SyncAck() bool { return true }

func main() {
    ctx := context.Background()
    su := /* keystore.FullUser() */
    client := bot.NewBlazeClientWithSafeUser(su)
    for {
        if err := client.Loop(ctx, &myHandler{su: su}); err != nil {
            log.Printf("blaze loop exited: %v; reconnecting in 5s", err)
        }
        select {
        case <-ctx.Done(): return
        case <-time.After(5 * time.Second):
        }
    }
}
```

**Reconnect outside `Loop`.** `Loop` returns when the connection drops. The Node `client.blaze.loop` reconnects on its own — the Go `Loop` does **not**.

### `SyncAck` semantics

- `SyncAck() == true` — SDK acks before next handler call. Safer, slower.
- `SyncAck() == false` — higher concurrency; you handle ordering.

### Node.js: listener object

Blaze is a separate SDK subpath — import it explicitly:

```js
import { MixinApi } from '@mixin.dev/mixin-node-sdk';
import { BlazeKeystoreClient } from '@mixin.dev/mixin-node-sdk/blaze';

const client = MixinApi({ keystore });
const blaze = BlazeKeystoreClient(keystore, { parse: true, syncAck: true });

const handler = {
  onMessage: async (msg) => {
    if (msg.category === 'PLAIN_TEXT') {
      const text = Buffer.from(msg.data_base64, 'base64').toString();
      await client.message.sendText(msg.user_id, `echo: ${text}`);
    }
  },
  onAckReceipt: async (msg) => {},
  onTransfer: async (msg) => {},
  onConversation: async (msg) => {
    const group = await client.conversation.fetch(msg.conversation_id);
    syncGroupStateInDB(group);
  },
};

blaze.loop(handler); // auto-reconnects on close
```

`BlazeKeystoreClient` returns `{ loop, stopLoop, getWebSocket }`.

### Common pitfalls

- **Forgetting to base64-decode.** Go does not decode `msg.Data`; Node sets `parse: true` in `BlazeKeystoreClient` options to decode `msg.data` from `data_base64`.
- **Rotating message IDs in retries.** Reuse the original `message_id`.
- **Treating `SYSTEM_ACCOUNT_SNAPSHOT` for Safe activity.** It only fires for legacy transfers. Poll `/safe/snapshots` instead — see the Mixin Safe skill.
- **Logging full payloads.** Redact before logging.

---

## mixin-kit-go (Go only)

Projects importing `github.com/DomeLiquid/mixin-kit-go` get an application-level wrapper:

- `fox-one/mixin-sdk-go/v2` — Safe transaction builder
- `bot-api-go-client/v3` — auth client
- Mixin Route (Web3) HTTP client
- `ComputerClient`

### Bootstrap

```go
cfg := kit.Config{
    AppID:             "...",
    SessionID:         "...",
    ServerPublicKey:   "...",
    SessionPrivateKey: "...",
    SpendKey:          "...",
}
wrapper, err := kit.NewMixinClientWrapper(cfg) // does UserMe network I/O
```

### Transfer helpers

| Helper | When |
|--------|------|
| `TransferOne` | one output to one user / MIX address |
| `TransferMany` | multiple outputs, ≤ `MAX_UTXO_NUM = 255` |
| `TransferManyN` | > 255 outputs; chunks and derives child request IDs |
| `InscriptionTransfer` | inscription UTXO movement |

```go
tx, err := wrapper.TransferOne(ctx, kit.TransferRequest{
    AssetID:    assetID,
    Amount:     decimal.RequireFromString("0.5"),
    OpponentID: recipientUUID,
    RequestID:  requestID,
    Memo:       "thanks",
})
```

The wrapper serializes transfers with `transferMutex`. Amounts from strings, never `NewFromFloat`.

### Web3 / Mixin Route

```go
tokens, _ := wrapper.Web3.Web3Tokens(ctx)
quote,  _ := wrapper.Web3.Web3Quote(ctx, kit.QuoteRequest{InputMint, OutputMint, InputAmount})
swap,   _ := wrapper.Web3.Web3Swap(ctx, kit.SwapRequest{...})
```

After `Web3Swap`, decode the returned `mixin://.../pay/...` URL with `kit.DecodeTx`, then pay with `TransferOne`.

### Mixin Computer HTTP API

```go
cc := kit.NewComputerClient(cfg)
info,   _ := cc.GetComputerInfo(ctx)
user,   _ := cc.GetUser(ctx, mixinUserID)
assets, _ := cc.GetDepolyedAssets(ctx)
```

`NewComputerClient` is only an HTTP client — no MTG consensus or MPC.

### Safety rules

- Treat `SpendKey` as money authority. Never log config or raw keys.
- Amounts from strings via `decimal.RequireFromString`.
- Stable `RequestID` across retries.
- Exported names with typos (`SyncArrgegateUtxos`, `GetDepolyedAssets`) are stable API — don't silently rename.
