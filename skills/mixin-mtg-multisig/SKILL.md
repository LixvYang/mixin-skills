---
name: mixin-mtg-multisig
description: This skill should be used when designing, implementing, reviewing, or debugging Mixin MTG / multisig Go programs — Mixin Trusted Group services, observer/signer nodes, deterministic action processing, threshold configuration, FROST or MPC signing, mtg.Group / AttachWorker, and Mixin Trusted Computer style services using github.com/MixinNetwork/safe/mtg and github.com/MixinNetwork/multi-party-sig.
---

# Mixin MTG Multisig (Go)

Use this skill for Mixin Safe **group programs** and **multi-party signing services**. It is based on patterns from `github.com/MixinNetwork/computer`, which combines `bot-api-go-client/v3`, `github.com/MixinNetwork/safe`, and `github.com/MixinNetwork/multi-party-sig`.

For client code that only calls the public Mixin Computer HTTP API, use [`mixin-bot`](../mixin-bot/SKILL.md) (mixin-kit-go section). For the underlying Safe transaction shape, use [`mixin-safe`](../mixin-safe/SKILL.md).

> **Go only.** There is no Node.js MTG implementation. Bots written in Node.js can *send* transactions to an MTG (using the Safe transaction flow) and *receive* outputs from one, but cannot run as an MTG node.

## What is an MTG

An **MTG (Mixin Trusted Group)** is a fixed `(members, threshold, epoch)` tuple that runs a deterministic worker. Every MTG node:

1. Polls Mixin Safe outputs addressed to the group's MIX address (`/safe/outputs`, ordered by `sequence`).
2. Decodes each output's `extra` to find which app + which operation.
3. Runs the matching app's `ProcessOutput` handler **deterministically** — same inputs, same state, same transactions emitted.
4. Cooperates with peer nodes via a messenger network for MPC signing of any transactions the worker produces.

The `mtg.Group` worker abstraction enforces this: it persists its own checkpoint, replays on restart, and uses `mtg.ReplayCheck` to verify that two parallel runs of the same action produce the same transactions.

```
   /safe/outputs ──► mtg.Group ──► AttachWorker(appID, worker)
                         │              │
                         │              ▼
                         │      ProcessOutput(out, extra)
                         │              │ produces:
                         │              ▼
                         │       deterministic *bot.Transaction list
                         ▼              │
                   peer messenger ◄─────┘
                  (FROST signing)
```

## Minimum config schema

A working MTG node needs every one of these. Missing a field at boot is the most common failure mode.

```toml
# This file is per-node. genesis.* must be byte-identical across all nodes.
# Only [mtg.app] differs — it is the keystore of THIS node.

[mtg.app]
# THIS node's bot keystore. The bot must already be a member of
# the messenger conversation (see [mtg.messenger]).
app_id              = "uuid"   # also this bot's user_id
session_id          = "uuid"
session_private_key = "hex"
server_public_key   = "hex"    # required for Safe register / PIN
spend_private_key   = "hex"    # required for Safe transaction signing

[mtg.genesis]
# Identical on every node.
members   = ["uuid_of_node1", "uuid_of_node2", "uuid_of_node3"]
threshold = 2                  # see threshold rules above
epoch     = 1234567890         # Mixin sequence to start scanning from

[mtg.messenger]
# A regular Mixin Messenger group containing all member bots.
# Used for member-to-member coordination (MPC round messages, observer notifications).
conversation_id = "uuid"

[mtg.store]
# THIS node's local SQLite directory. Must be private to this node.
dir = "/var/lib/myapp/node1.sqlite"

[mtg.network]
mixin_rpc          = "https://api.mixin.one"
mixin_messenger_api = "https://api.mixin.one"
```

`computer/config/example.toml` is the canonical full-size example. The schema above is the irreducible minimum — everything else (observer chains, signer parameters, app-specific tables) is layered on top.

Setup procedure:

1. Provision one Mixin bot/app keystore per node. All bots must already be created.
2. Create a Mixin Messenger group containing every member bot. Record its `conversation_id`.
3. Pick `(members, threshold, epoch)` and freeze them. Threshold/member changes are migrations — they re-derive group MIX addresses, trace seeds, and signer party IDs.
4. Hand each operator the same config file with only `[mtg.app]` swapped to their own bot.
5. Each operator boots with their own private `[mtg.store].dir`.
6. The worker's `ProcessOutput` must depend only on Mixin outputs and on facts already committed to Mixin via observer transactions — see "Determinism rules" below.

## First checks before editing

1. Inspect `go.mod` for `github.com/MixinNetwork/safe` and `github.com/MixinNetwork/multi-party-sig`, plus `github.com/MixinNetwork/bot-api-go-client/v3`.
2. If the repo only imports `github.com/DomeLiquid/mixin-kit-go` (no `safe/mtg`, no `multi-party-sig`), it's a Computer-API client — use [`mixin-kit-go`](../mixin-kit-go/SKILL.md) instead.
3. Read the app config struct and the example config file before changing thresholds, members, stores, or keys.
4. Find the `mtg.Group` worker implementation and its `ProcessOutput` / action handler.
5. Find persistence boundaries: MTG store, wallet store, app store, session/signature tables, checkpoints.

## Outputs, snapshots, and transactions

- MTG input stream: `/safe/outputs` for the group `(members, threshold)`, ordered by Sequencer `sequence`.
- User-facing activity: `/safe/snapshots` for balance changes and account history; do not drive MTG consensus from snapshots.
- Submitted transaction state: `/safe/transactions/:id` to confirm `signed` / `spent` and read `snapshot_hash` after broadcasting.
- External-chain facts: observers read external systems, then commit those facts back as Mixin group transactions before deterministic workers consume them.

## Architecture pattern

- Build an `mtg.Group` from configured genesis members, threshold, epoch, and app credentials.
- Attach one deterministic worker per app ID with `group.AttachWorker(appID, worker)`.
- Register deposit entries when the app owns external-chain deposit destinations.
- Use a messenger / network layer for member-to-member MPC messages.
- Keep observer logic, signer logic, and group action processing **separate** even when running in one process — they have different determinism contracts.
- Build `bot.SafeUser` from MTG app credentials for Safe API calls and spend-key signing.

## Determinism rules

- Group action processing must depend **only** on Mixin outputs, stored state, and explicitly notified facts already committed via Mixin transactions.
- Do not read wall-clock, random data, external-chain RPCs, HTTP APIs, or local mutable environment from inside consensus-critical request handling.
- Observer nodes *may* read external systems, but must turn those facts into Mixin group transactions before group logic relies on them.
- Run replay checks: process the same action twice and compare emitted transactions / compaction output. `computer` deliberately runs each action twice and compares.
- Make every store write idempotent: `WriteIfNotExist`, action-result caches, request IDs, session IDs, state transitions.

## Threshold rules (from `computer`)

Validate at boot:

```
mtgThreshold >= mpcThreshold
mtgThreshold >= len(members) * 2/3 + 1
```

For FROST signing, expect a prepared signer set of `mpcThreshold + 1` (some protocols / code in `multi-party-sig` use this convention).

Sort member UUIDs **before** deriving group IDs, trace IDs, party slices, or MixAddress recipients. Threshold/member changes are migrations — they affect addresses, trace derivation, and consensus.

## Observer vs signer roles

| Role | Reads | Writes |
|------|-------|--------|
| User | their own keystore | sends Mixin outputs to the MTG |
| Observer | external systems (Solana RPC, Bitcoin RPC, …) | Mixin group transactions encoding facts |
| Signer | MTG state + own MPC share | MPC round messages via messenger |

Verify each action's declared role before processing. Duplicate observer notifications must be harmless — store them, short-circuit already-handled `request_id`s.

## Sending transactions to the group

- Encode operation type plus operation extra deterministically.
- Derive trace IDs from operation/session identity plus MTG genesis/members/threshold context.
- Use `mtg.EncodeMixinExtraBase64(appID, payload)` for group extras.
- Check the `ExtraSizeGeneralLimit`. If a XIN payload is too large, use the storage-entry pattern (see [`mixin-mix-address`](../mixin-mix-address/SKILL.md)) instead of silently truncating.
- Keep the same trace ID when retrying an insufficient-output send for the same operation.

```go
import (
    "github.com/MixinNetwork/safe/mtg"
    bot "github.com/MixinNetwork/bot-api-go-client/v3"
)

extraB64 := mtg.EncodeMixinExtraBase64(appID, opPayload)

// Build a Safe transaction whose recipient is the MTG MixAddress
mtgAddr, _ := bot.NewUUIDMixAddress(group.Members(), group.Threshold())
recipients := []*bot.TransactionRecipient{
    {MixAddress: mtgAddr, Amount: minDust.String()},  // dust trigger
}
// extra (decoded base64) goes in tx.Extra
```

## MPC / FROST sessions

- Persist session state and signer results before broadcasting dependent results.
- Verify incoming round messages: session ID / SSID, sender, recipient, membership, round number.
- Time out stalled sessions and record missing members for debugging.
- Verify the final signature against the stored public key before committing.
- **Never** log shares, private keys, or raw secret material.

```go
// Sketch — actual API depends on multi-party-sig version
import "github.com/MixinNetwork/multi-party-sig/protocols/frost"

session, err := frost.Sign(party, signers, msgHash, store)
// drive session.Next() with messages received from messenger
// when state == final, signature := session.Result()
```

## Validation

- Add replay / determinism tests for every new action type.
- Test crash / restart with partially written requests and sessions.
- Test duplicate observer messages and duplicate signer messages.
- Test insufficient-balance paths and retry trace IDs.
- Test threshold boundary cases: too few members, threshold below quorum, missing prepared signer.

## Helper scripts

```bash
# Encode an MTG operation extra (no auth needed)
node skills/mixin-mtg-multisig/scripts/mtg-extra-encode.mjs --app=APP_ID --memo="hello"

# Decode a base64 MTG extra back to app_id + memo
node skills/mixin-mtg-multisig/scripts/mtg-extra-decode.mjs --extra="BASE64_EXTRA"
```

## Reference

The canonical reference implementation is `~/code/github/computer` (`github.com/MixinNetwork/computer`). Read in this order when learning the patterns:

1. `cmd/` — boot wiring (config → group → workers).
2. `solana/node.go` — `mtg.Group.AttachWorker` integration, observer/signer composition.
3. `solana/observer.go` — external-chain → Mixin facts.
4. `solana/signer.go` — FROST sessions, persisted signer results.
5. `mtg/...` upstream — `Group`, `Worker`, replay/determinism primitives.
