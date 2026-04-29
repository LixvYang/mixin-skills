---
name: mixin-blaze
description: This skill should be used when building or debugging Mixin Blaze WebSocket bots — the long-running connection at wss://blaze.mixin.one. Triggers include "blaze.loop", "BlazeListener", "OnMessage", "OnAckReceipt", "SyncAck", subprotocol "Mixin-Blaze-1", and reconnect logic.
---

# Mixin Blaze

Blaze is the bot's inbox: a single long-lived WebSocket at `wss://blaze.mixin.one` (subprotocol `Mixin-Blaze-1`, gzip binary frames). Every inbound message arrives here. The bot also acks received messages back over the same socket.

```
                  ┌─────────────────────────────────────────────┐
                  │         wss://blaze.mixin.one               │
                  │         subprotocol: Mixin-Blaze-1          │
                  │         frames: binary, gzip                │
                  └────────┬─────────────────────────┬──────────┘
                           │                         │
              CREATE_MESSAGE / ACK                   │ ACKNOWLEDGE_MESSAGE_RECEIPT
                           ▼                         │
                    ┌────────────┐                   │
                    │  Bot       │ ──────────────────┘
                    │  handler   │
                    └────────────┘
```

## What Blaze delivers

| Inbound | Trigger |
|---------|---------|
| user message | another user / group sent to the bot's conversation |
| `SYSTEM_ACCOUNT_SNAPSHOT` | bot received a legacy transfer (use `/snapshots` instead — see [`mixin-network-assets`](../mixin-network-assets/SKILL.md)) |
| `SYSTEM_CONVERSATION` | a group's membership changed |
| `ACKNOWLEDGE_MESSAGE_RECEIPT` | another participant read a message the bot sent |

## Pending message rule

When the bot reconnects, Blaze re-delivers all messages the bot has not yet acked. **Handlers must be idempotent** on `message_id`. If you have side effects (DB writes, outbound API calls), guard them by `message_id` lookup.

## Go: the listener interface

```go
import (
    "context"
    bot "github.com/MixinNetwork/bot-api-go-client/v3"
)

type myHandler struct {
    su *bot.SafeUser
}

// Required by bot.BlazeListener.
func (h *myHandler) OnMessage(ctx context.Context, msg bot.MessageView, userID string) error {
    if msg.Category == "PLAIN_TEXT" {
        text, _ := base64.RawURLEncoding.DecodeString(msg.Data)
        return bot.PostMessage(ctx, msg.UserId, "echo: "+string(text),
            bot.UuidNewV4().String(), h.su)
    }
    return nil
}

func (h *myHandler) OnAckReceipt(ctx context.Context, msg bot.MessageView, userID string) error {
    return nil
}

func (h *myHandler) SyncAck() bool { return true }  // SDK acks each message before next handler call

func main() {
    ctx := context.Background()
    su := /* keystore.FullUser() */

    client := bot.NewBlazeClientWithSafeUser(su)
    for {
        if err := client.Loop(ctx, &myHandler{su: su}); err != nil {
            log.Printf("blaze loop exited: %v; reconnecting in 5s", err)
        }
        select {
        case <-ctx.Done():
            return
        case <-time.After(5 * time.Second):
        }
    }
}
```

### Reconnect outside `Loop`

`Loop` returns when the connection drops. Always wrap it in a reconnect loop with a bounded backoff. Respect `ctx.Done()` for graceful shutdown.

### `SyncAck` semantics

- `SyncAck() == true` — the SDK sends an ACK back to Blaze before invoking the next handler call. Slow handlers slow ack throughput; the bot won't accidentally drop messages.
- `SyncAck() == false` — handler is invoked with greater concurrency; you are responsible for ordering and ack timing. Only choose this if you've measured throughput problems with `true`.

## Node.js: the listener object

```js
const { MixinApi } = require('@mixin.dev/mixin-node-sdk');

const client = MixinApi({
  keystore,
  blazeOptions: {
    parse: true,    // SDK base64-decodes msg.data into msg.data (string)
    syncAck: true,  // SDK acks each message before next handler runs
  },
});

const handler = {
  onMessage: async (msg) => {
    // msg.data is already decoded if blazeOptions.parse === true.
    if (msg.category === 'PLAIN_TEXT') {
      await client.message.sendText(msg.user_id, `echo: ${msg.data}`);
    }
  },
  onAckReceipt: async (msg) => {
    // msg.status === 'READ' | 'DELIVERED'
  },
  // SYSTEM_ACCOUNT_SNAPSHOT — legacy transfers. Prefer polling /safe/snapshots.
  onTransfer: async (msg) => { /* ... */ },
  // SYSTEM_CONVERSATION — group membership changed.
  onConversation: async (msg) => {
    const group = await client.conversation.fetch(msg.conversation_id);
    console.log(`group ${group.name} updated`);
  },
};

// blaze.loop reconnects automatically on close. No outer loop needed.
client.blaze.loop(handler);
```

The Node `client.blaze.loop` *does* reconnect on its own — the Go `bot.BlazeClient.Loop` does **not**.

## Sending replies from the handler

Both SDKs let you call message helpers from the handler. Replies travel over the same WebSocket where possible (Blaze message), or over REST if you call `client.message.sendLegacy` / `bot.PostMessage`. Do not block the handler on long DB writes — fire and forget, or queue.

## Common pitfalls

- **Forgetting to base64-decode.** Go does not decode `msg.Data` for you; Node only decodes when `blazeOptions.parse === true`.
- **Rotating message IDs in retries.** Reuse the original `message_id` when resending; the server dedupes.
- **Treating `ACKNOWLEDGE_MESSAGE_RECEIPT` as a delivery confirmation for outbound messages.** It tells you another participant *read* a message; the bot's own outbound delivery is confirmed by REST `2xx`.
- **Trusting `SYSTEM_ACCOUNT_SNAPSHOT` for new code.** It only fires for legacy transfers. New code should poll `/safe/snapshots` (see [`mixin-network-assets`](../mixin-network-assets/SKILL.md)).
- **Logging full payloads.** Messages can include private text, asset balances, etc. Redact before logging.

## Validation

- Test handler logic against synthetic `MessageView` / `msg` objects, decoupled from the WebSocket.
- Stage a reconnect test: kill the network for 30 seconds and confirm pending messages are re-delivered and processed exactly once.
- For high-volume bots, measure handler latency. If `SyncAck` causes backpressure, switch to async ack and add explicit dedup.
