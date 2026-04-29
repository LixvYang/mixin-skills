---
name: mixin-keystore
description: This skill should be used when the user asks about loading a Mixin keystore, constructing a `SafeUser` (Go) or `MixinApi` client (Node.js), the difference between session_private_key / server_public_key / spend_private_key, JWT signing, OAuth bare-user creation, or TIP PIN registration.
---

# Mixin Keystore

A Mixin bot's identity is a JSON keystore exported from `https://developers.mixin.one`. Every other skill assumes you already have a constructed client; this is where that comes from.

## Keystore fields

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

**A bot's `app_id` is the same value as its `user_id`.** The Go SDK stores it on `SafeUser.UserId`. Don't be confused by the rename.

## Auth model

The SDK signs each request as a JWT with EdDSA over the `session_private_key`. Claims bind:

- `method` (HTTP verb, uppercase)
- `uri` (path **including** query string)
- `body` (sha256 hash hex)
- `request_id`, `uid`, `sid`, `scope`, `iat`, `exp`

If you build a custom signed call, the signed `uri` must exactly match the request URI — query parameters included.

## Go: load keystore and build SafeUser

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

### Process-global SDK config (Go)

```go
bot.SetBaseUri("https://api.mixin.one")
bot.SetBlazeUri("blaze.mixin.one")
bot.SetUserAgent("my-bot/1.0")
```

These mutate package-level globals. Call them only from `main()` / startup. Don't call them from a library that may be reused.

## Node.js: load keystore and build MixinApi

```ts
import { MixinApi, KeystoreClientReturnType } from '@mixin.dev/mixin-node-sdk';
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

The Node SDK accepts a *partial* keystore for read-only / OAuth flows. If you only have `app_id` + `scope` + `authorization_id` + `session_private_key` (an OAuth-issued user keystore), you can still call user-scoped endpoints.

### Node keystore for app vs user

| Keystore source | Has `pin_token_base64` | Has `spend_private_key` | Can | Cannot |
|-----------------|------------------------|--------------------------|-----|--------|
| Bot dashboard export | yes | yes | bot APIs, Safe transfers, multisig | n/a |
| OAuth `getToken` response | no | no | user-scoped read APIs | move money |
| `client.user.createBareUser` + TIP register | yes | yes (you generate) | full bot/user APIs after `safe.register` | n/a |

### Bare user + TIP PIN registration (Node)

When your app provisions sub-accounts (managed users), you generate two ed25519 keypairs — one for session, one for spend — register the user, set TIP PIN to the spend public key, and finally call `safe.register`:

```js
const { MixinApi, getED25519KeyPair, base64RawURLEncode } = require('@mixin.dev/mixin-node-sdk');

const root = MixinApi({ keystore });

// 1. Session key for the new user.
const session = getED25519KeyPair();
const newUser = await root.user.createBareUser('alice', base64RawURLEncode(session.publicKey));

// 2. New client, signed as the new user.
const userClient = MixinApi({
  keystore: {
    app_id: newUser.user_id,
    session_id: newUser.session_id,
    pin_token_base64: newUser.pin_token_base64,
    session_private_key: session.seed.toString('hex'),
  },
});

// 3. Spend key — set as TIP PIN, then register Safe.
const spend = getED25519KeyPair();
await userClient.pin.updateTipPin('', spend.publicKey.toString('hex'), newUser.tip_counter + 1);
await userClient.pin.verifyTipPin(spend.seed);
const account = await userClient.safe.register(
  newUser.user_id,
  spend.seed.toString('hex'),
  spend.seed,
);
```

Persist the new user's `session_private_key` and `spend_private_key` securely **before** completing TIP registration — they cannot be recovered from Mixin servers.

## OAuth (Node) — third-party login

```js
const { MixinApi, getED25519KeyPair, base64RawURLEncode } = require('@mixin.dev/mixin-node-sdk');

const { seed, publicKey } = getED25519KeyPair();
const anon = MixinApi();
const { scope, authorization_id } = await anon.oauth.getToken({
  client_id: app_id,
  code,                              // from OAuth redirect
  ed25519: base64RawURLEncode(publicKey),
  client_secret,
});
const userClient = MixinApi({
  keystore: { app_id, scope, authorization_id, session_private_key: Buffer.from(seed).toString('hex') },
});
const profile = await userClient.user.profile();
```

The corresponding Go helper is `bot.OAuthGetAccessToken`.

## Safety rules

- Never write the keystore JSON or `spend_private_key` into source control or logs.
- `IsSpendPrivateSum` (Go) is only set in MTG signer contexts, where the spend key is the sum of MPC shares — leave it false otherwise.
- For browsers: `@mixin.dev/mixin-node-sdk` uses Node `Buffer`. Use a polyfill (e.g. `vite-plugin-node-polyfills`) when shipping to a browser bundle.

## Validation

- After loading, call `bot.UserMe` (Go) or `client.user.profile()` (Node) to confirm the credentials work and the bot's `user_id` matches `app_id`.
- For Safe-capable keystores, also call `client.safe.fetchAsset(...)` once to confirm the spend key is registered against the asset/account.
