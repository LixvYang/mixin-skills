---
name: mixin-messaging
description: This skill should be used when the user asks about sending Mixin messages — direct (1:1) text, group fan-out, post messages, app cards, app buttons, base64 message data, MessageId / message_id idempotency, or filtering bots out of group sends.
---

# Mixin Messaging

Send messages from a bot to users, groups, or 1:1 conversations. The same fields apply to both SDKs: `conversation_id`, `recipient_id` (1:1 only), `category`, `message_id`, and base64-encoded `data`.

## Categories you'll actually use

| Category | Payload (`data` decoded) |
|----------|--------------------------|
| `PLAIN_TEXT` | UTF-8 text |
| `PLAIN_POST` | Markdown |
| `PLAIN_IMAGE`, `PLAIN_DATA`, `PLAIN_VIDEO`, `PLAIN_AUDIO` | JSON: `{attachment_id, mime_type, ...}` |
| `APP_CARD` | JSON `{app_id, icon_url, title, description, action}` |
| `APP_BUTTON_GROUP` | JSON array `[{label, color, action}, ...]` (max 6 buttons) |
| `SYSTEM_ACCOUNT_SNAPSHOT` | inbound: bot received a transfer (legacy) |
| `SYSTEM_CONVERSATION` | inbound: group membership changed |

The SDK either base64-encodes `data` for you (`sendText`, etc.) or you provide `data_base64` directly (low-level `sendLegacy` / `bot.SendMessage`).

## Idempotency rule

Pass a deterministic `message_id` (UUID-v3/v5 or app-controlled). The Mixin server dedupes on `message_id`. Resending with the same `message_id` is safe and is the correct retry strategy.

A common pattern is `uuid.NewV5(namespace, intent || conversation_id || sender || hash(payload))`.

## Go: direct message

```go
import (
    bot "github.com/MixinNetwork/bot-api-go-client/v3"
    "github.com/gofrs/uuid/v5"
)

// 1:1 — send to a user. The SDK creates the conversation_id deterministically.
msgID := uuid.Must(uuid.NewV4()).String()
err := bot.PostMessage(ctx, recipientUserID, "hello", msgID, su)
```

For richer payloads, use `bot.SendMessage` and craft the `*bot.MessageRequest` directly:

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

## Go: group fan-out

There is no "send to conversation" shortcut — the bot writes one message with `ConversationId` set to the group ID. Mixin fans it out to all participants. To skip bot accounts, fetch participants and filter:

```go
parts, err := bot.ParticipantsConversation(ctx, conversationID, su)
if err != nil { return err }

humans := make([]string, 0, len(parts))
for _, p := range parts {
    user, _ := bot.GetUser(ctx, p.UserId, su)
    if user != nil && user.App == nil {  // bots have App set
        humans = append(humans, p.UserId)
    }
}
// To send to humans only, send 1:1 messages instead of a group message.
```

Most apps skip the human filter and post a single group message; only fan out manually when you specifically need to exclude bots.

## Go: app card / app button

```go
card := bot.AppCardData{
    AppId:       su.UserId,
    IconUrl:     "https://example.com/icon.png",
    Title:       "Open Web",
    Description: "tap to view",
    Action:      "https://example.com/page",
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

Buttons:

```go
buttons := []bot.AppButtonData{
    {Label: "Yes", Color: "#4CAF50", Action: "input:yes"},
    {Label: "No",  Color: "#F44336", Action: "input:no"},
}
data, _ := json.Marshal(buttons)
req.Category = "APP_BUTTON_GROUP"
req.Data = base64.RawURLEncoding.EncodeToString(data)
```

`Action` can be `https://...` (open URL), `input:...` (echo back to bot as plain text), or a `mixin://` URL scheme — see [`mixin-mix-address`](../mixin-mix-address/SKILL.md).

## Node.js: direct message

```js
const { v4 } = require('uuid');

await client.message.sendText(recipientUserID, 'hello');
// — equivalent to —
await client.message.sendLegacy({
  conversation_id: client.utils.uniqueConversationID(client.keystore.app_id, recipientUserID),
  recipient_id: recipientUserID,
  message_id: v4(),
  category: 'PLAIN_TEXT',
  data: 'hello',  // SDK base64-encodes
});
```

## Node.js: group fan-out

```js
await client.message.sendLegacy({
  conversation_id: groupConversationID,
  message_id: v4(),
  category: 'PLAIN_TEXT',
  data: 'hi everyone',
});
```

Skip bots in a group by fetching participants:

```js
const conv = await client.conversation.fetch(groupConversationID);
for (const p of conv.participants) {
  const u = await client.user.fetch(p.user_id);
  if (!u.app) {
    await client.message.sendText(u.user_id, `direct to ${u.full_name}`);
  }
}
```

## Node.js: app card / app button

```js
await client.message.sendLegacy({
  conversation_id: convID,
  recipient_id: recipientID,
  message_id: v4(),
  category: 'APP_CARD',
  data_base64: base64RawURLEncode(JSON.stringify({
    app_id: client.keystore.app_id,
    icon_url: 'https://example.com/icon.png',
    title: 'Open Web',
    description: 'tap to view',
    action: 'https://example.com/page',
  })),
});
```

App buttons (`APP_BUTTON_GROUP`) take a JSON array of `{label, color, action}`.

## Reply patterns

When your Blaze handler receives a message, reply with the same SDK helpers. The handler runs *inside* the WebSocket loop — do not block. Use `await` (Node) or pass `ctx` (Go) and offload heavy work to a queue/goroutine.

```js
const handler = {
  onMessage: async (msg) => {
    if (msg.category === 'PLAIN_TEXT' && Buffer.from(msg.data, 'base64').toString() === '/help') {
      await client.message.sendText(msg.user_id, 'Commands: /help /balance');
    }
  },
};
client.blaze.loop(handler);
```

## Validation

- Test handler logic against synthetic `msg` objects, separate from the actual WebSocket loop.
- For idempotency, write a test that sends the same `message_id` twice and asserts both calls succeed without producing duplicate user-visible messages.
- For app cards, test against the schema constraints: title ≤ 36 chars, description ≤ 128 chars, ≤ 6 buttons.
