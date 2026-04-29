---
name: mixin-conversations
description: This skill should be used when working with Mixin conversations — creating groups, adding/removing/promoting participants, fetching conversation metadata, searching users by Mixin number, or interpreting SYSTEM_CONVERSATION events.
---

# Mixin Conversations

Mixin has two conversation kinds:

- **`CONTACT`** — 1:1 between two users (or bot+user). The `conversation_id` is deterministic: `UuidV5(0x6ba7b810..., min(a,b) + max(a,b))`.
- **`GROUP`** — multi-party. Random UUID; bot creates and manages members.

Both SDKs expose helpers to deterministically derive the 1:1 ID, so you don't have to call the API to send a 1:1 message.

## Deterministic 1:1 ID

```go
// Go
convID := bot.UniqueConversationId(botUserID, peerUserID)
```

```js
// Node — utility helper in the SDK utils.
const convID = client.utils.uniqueConversationID(botUserID, peerUserID);
```

The order of arguments doesn't matter; the helper sorts internally.

## Searching users

User search by **Mixin number** (the public 7-9 digit identifier):

```go
// Go
user, err := bot.SearchUser(ctx, "39427696", su)
// returns *bot.User with full_name, avatar_url, mixin_number, etc.
```

```js
// Node
const user = await client.user.search('39427696');
```

Use `client.user.fetch(user_id)` / `bot.GetUser` when you already have the UUID.

## Creating a group

A bot creates a group and is automatically the owner:

```go
// Go
ps := []*bot.Participant{
    {UserId: aliceID, Role: "ADMIN"},
    {UserId: bobID,   Role: ""},     // empty == regular member
}
conv, err := bot.CreateConversation(ctx, "GROUP", "", "Repo Watch", "announcement text", ps, su)
// conv.ConversationId is the new group ID. The bot itself is implicit owner.
```

```js
// Node
const conv = await client.conversation.createGroup({
  name: 'Repo Watch',
  participants: [
    { user_id: aliceID, role: 'ADMIN' },
    { user_id: bobID },
  ],
});
```

## Managing participants

```go
// Go — add / remove / promote
err = bot.AddParticipant(ctx, convID, []string{newUserID}, su)
err = bot.RemoveParticipant(ctx, convID, []string{kickedID}, su)
err = bot.UpdateParticipantRole(ctx, convID, promotedID, "ADMIN", su)
```

```js
// Node
await client.conversation.addParticipants(convID, [newUserID]);
await client.conversation.removeParticipants(convID, [kickedID]);
await client.conversation.adminParticipants(convID, [promotedID]);
```

Both SDKs accept arrays so you can batch participant changes in one call.

## Fetching a conversation

```go
conv, err := bot.ConversationShow(ctx, convID, su)
// conv.Participants is the full member list.
```

```js
const conv = await client.conversation.fetch(convID);
// conv.participants is the full member list.
```

## SYSTEM_CONVERSATION events

When a bot is in a group, Blaze delivers a `SYSTEM_CONVERSATION` message every time membership changes. Re-fetch on receipt — don't try to maintain local state from deltas:

```js
const handler = {
  onConversation: async (msg) => {
    // msg.action: 'CREATE' | 'ADD' | 'REMOVE' | 'JOIN' | 'EXIT' | 'ROLE' | 'UPDATE'
    const conv = await client.conversation.fetch(msg.conversation_id);
    syncGroupStateInDB(conv);
  },
};
```

Go: the Blaze listener's `OnMessage` fires with `msg.Category == "SYSTEM_CONVERSATION"`. Decode `msg.Data` (JSON) to read `action`, `participant_id`, `role`.

## Conversation IDs vs MTG group IDs

A regular `GROUP` conversation is **not** the same as an MTG (Mixin Trusted Group). MTG groups are derived from sorted member UUIDs + threshold + epoch and are used as a Safe multisig recipient. See [`mixin-mtg-multisig`](../mixin-mtg-multisig/SKILL.md) for MTG specifics; this skill only covers messaging conversations.

## Bot-only group

A common pattern: a bot creates a private group containing the bot + the bot's owner, then uses it as a notification channel. Create once, persist `conversation_id`, post messages there.

```js
const me = await client.user.profile();
const conv = await client.conversation.createGroup({
  name: 'Notifications',
  participants: [{ user_id: me.app.creator_id }], // bot itself is implicit
});
persist('NOTIFY_CONV_ID', conv.conversation_id);
```

## Validation

- After `CreateConversation`, fetch the conversation back and assert all expected participants are present.
- For SYSTEM_CONVERSATION handling, write a test that drops a few synthetic events out of order and confirms the resulting persisted state matches a fresh fetch.
- For 1:1 IDs, assert that `uniqueConversationID(a, b) === uniqueConversationID(b, a)`.
