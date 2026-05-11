---
name: mixin-oauth
description: Use this skill when the user asks about Mixin OAuth login, authorizing users via Mixin, mixin://codes QR code login, PKCE frontend login without client_secret, backend OAuth code exchange with client_secret, OAuthGetAccessToken, SignOauthAccessToken, OAuthKeystore, scope, or using Mixin as an identity provider for web/mobile apps.
---

# Mixin OAuth

Two flows share the same authorization entry point but differ in how the code is exchanged.

```
                    ┌──────────────────────────────────────────┐
                    │  Entry point (both flows)                 │
                    │                                           │
                    │  Web redirect:                            │
                    │  https://mixin.one/oauth/authorize        │
                    │    ?client_id=APP_ID                      │
                    │    &scope=PROFILE:READ ASSETS:READ        │
                    │    &response_type=code                    │
                    │    &redirect_uri=https://yourapp.com/cb   │
                    │                                           │
                    │  QR / in-app (frontend flow):             │
                    │  mixin://codes/{code_id}                  │
                    └──────────────────────────────────────────┘
                                       │
                          user grants → authorization_code
                                       │
                   ┌───────────────────┴───────────────────┐
                   │                                       │
          Flow A: Frontend PKCE                  Flow B: Backend secret
          (no client_secret)                     (requires client_secret)
          Node.js SDK                            Go bot-api-go-client/v3
```

| | Flow A — Frontend PKCE | Flow B — Backend secret |
|---|---|---|
| client_secret needed | No | Yes |
| Token signing | Ed25519 keypair (local) | Mixin-issued JWT |
| QR / WebSocket | Yes | No (redirect only) |
| SDK | `@mixin.dev/mixin-node-sdk` | `bot-api-go-client/v3` |

---

## Common scopes

| Scope | Grants |
|-------|--------|
| `PROFILE:READ` | user_id, full_name, avatar_url, identity_number |
| `ASSETS:READ` | asset balances |
| `SNAPSHOTS:READ` | transaction history |
| `MESSAGES:REPRESENT` | send messages on the user's behalf |

Always request the minimum scopes needed.

---

## Flow A — Frontend PKCE (Node.js, no client_secret)

The frontend generates a throwaway Ed25519 keypair. Mixin signs a token that can only be verified by that key — no server secret ever needed.

### Step 1 — open QR WebSocket

```ts
import {
  getChallenge,
  getED25519KeyPair,
  base64RawURLEncode,
  OAuthKeystore,
} from "@mixin.dev/mixin-node-sdk";
import ReconnectingWebSocket from "reconnecting-websocket";
import pako from "pako";
import { v4 as uuid } from "uuid";

const APP_ID = "your-app-uuid";
const SCOPE = "PROFILE:READ ASSETS:READ SNAPSHOTS:READ";

const { verifier, challenge } = getChallenge();   // PKCE pair
const { seed, publicKey } = getED25519KeyPair();  // throwaway keypair

const ws = new ReconnectingWebSocket(
  "wss://blaze.mixin.one",
  "Mixin-OAuth-1",
  { maxRetries: Infinity }
);

const send = (msg: object) =>
  ws.send(pako.gzip(JSON.stringify(msg)));

const refreshCode = (authorizationId = "") => {
  send({
    id: uuid().toUpperCase(),
    action: "REFRESH_OAUTH_CODE",
    params: {
      client_id: APP_ID,
      scope: SCOPE,
      code_challenge: challenge,
      authorization_id: authorizationId,
    },
  });
};

ws.addEventListener("open", () => refreshCode());

ws.addEventListener("message", async (event) => {
  const buf = await event.data.arrayBuffer();
  const msg = JSON.parse(pako.ungzip(new Uint8Array(buf), { to: "string" }));
  const data = msg.data;

  if (!data) return;

  // First message: data.code_id → show QR
  if (data.code_id && !data.authorization_code) {
    console.log("QR URL:", `mixin://codes/${data.code_id}`);
    setTimeout(() => refreshCode(data.authorization_id), 1000);
    return;
  }

  // User approved: authorization_code arrives (length > 16)
  if (data.authorization_code?.length > 16) {
    await exchangeToken(data.authorization_code);
    ws.close();
  }
});
```

### Step 2 — exchange code for OAuthKeystore

```ts
import { MixinApi } from "@mixin.dev/mixin-node-sdk";

async function exchangeToken(code: string) {
  const client = MixinApi(); // unauthenticated client is fine here

  const { scope, authorization_id } = await client.oauth.getToken({
    client_id: APP_ID,
    code,
    ed25519: base64RawURLEncode(publicKey),
    code_verifier: verifier,
  });

  const keystore: OAuthKeystore = {
    app_id: APP_ID,
    scope,
    authorization_id,
    session_private_key: seed.toString("hex"), // keep this secret
  };

  // Now build an authenticated client from OAuthKeystore
  const userClient = MixinApi({ keystore });
  const me = await userClient.user.profile();
  console.log(me.full_name, me.user_id);
}
```

**Key invariant:** `seed` is the private key — never log or transmit it. The `authorization_id` is stable for the life of the grant; re-use it on the next `REFRESH_OAUTH_CODE` call so the user isn't re-prompted.

---

## Flow B — Backend client_secret (Go, bot-api-go-client/v3)

The bot's keystore has `app_id` but **not** `client_secret`. The secret is a separate value from the Mixin Developer Dashboard — store it in env/config, never in keystore JSON.

### Step 1 — build the authorization URL

```go
import "fmt"

func authURL(clientID, redirectURI, scope string) string {
    return fmt.Sprintf(
        "https://mixin.one/oauth/authorize?client_id=%s&scope=%s&response_type=code&redirect_uri=%s",
        clientID, scope, redirectURI,
    )
}
```

### Step 2 — exchange code for access token

```go
import (
    "context"
    bot "github.com/MixinNetwork/bot-api-go-client/v3"
)

func handleOAuthCallback(ctx context.Context, clientID, clientSecret, code string) (*bot.SafeUser, string, error) {
    // OAuthGetAccessToken: pass ed25519="" to use client_secret path
    // returns: accessToken, scope, authorizationID, error
    accessToken, scope, _, err := bot.OAuthGetAccessToken(ctx, clientID, clientSecret, code, "", "")
    if err != nil {
        return nil, "", err
    }

    // Fetch the user's profile using their access token
    user, err := bot.GetMe(ctx, accessToken)
    if err != nil {
        return nil, "", err
    }

    _ = scope // store or validate as needed
    return user, accessToken, nil
}
```

`accessToken` is a Mixin-signed JWT with `scp` claim. Use it as `Authorization: Bearer <token>` for subsequent calls on behalf of this user.

### Decode scope from the JWT (no secret needed)

```go
import "github.com/golang-jwt/jwt/v5"

func extractScope(token string) string {
    var claims struct {
        jwt.RegisteredClaims
        Scp string `json:"scp"`
    }
    // ParseWithClaims with nil key func only decodes, does not verify
    jwt.ParseWithClaims(token, &claims, nil) //nolint:errcheck
    return claims.Scp
}
```

---

## Helper scripts

Run these locally to test either OAuth flow without building a full application.

### Backend flow — `scripts/oauth-backend.mjs`

```bash
# exchange a one-time code for an access token
node skills/mixin-oauth/scripts/oauth-backend.mjs \
  --config=mixin-bot.json \
  --secret=CLIENT_SECRET \
  --code=OAUTH_CODE_FROM_CALLBACK
```

### Frontend PKCE flow — `scripts/oauth-frontend.mjs`

```bash
# opens WebSocket, prints QR URL, waits for user scan, prints OAuthKeystore
node skills/mixin-oauth/scripts/oauth-frontend.mjs \
  --app=APP_ID \
  --scope="PROFILE:READ ASSETS:READ"
```
