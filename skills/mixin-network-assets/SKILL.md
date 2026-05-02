---
name: mixin-network-assets
description: This skill should be used for read-only Mixin asset and snapshot queries — fetching Safe asset / chain metadata, balances, snapshots, snapshot notification, network top-assets / search / ticker, and the public Mixin Computer info / asset endpoints.
---

# Mixin Network Assets

Read-only data — assets, chain info, balances, snapshots (Safe inflows/outflows), network-wide ticker. None of these need the spend key.

## Asset metadata (Safe)

Every Mixin asset has a UUID `asset_id` and a chain UUID `chain_id`. Native assets (BTC on bitcoin, ETH on ethereum) have `asset_id == chain_id`.

```js
// Node
const asset = await client.safe.fetchAsset(assetID);
const chain = asset.chain_id === asset.asset_id
  ? asset
  : await client.safe.fetchAsset(asset.chain_id);
```

```go
// Go
asset, _ := bot.SafeAssetFetch(ctx, assetID, su)
```

Returned fields you'll commonly use: `symbol`, `name`, `precision`, `chain_id`, `mixin_id`, `icon_url`, `dispersion`, `price_usd`.

## Network APIs (no auth required)

For unauthenticated reads (asset listing, search, ticker), the Node SDK exposes a `network.*` namespace and the Go SDK exposes `bot.Network*`:

```js
// Top assets (ranked)
const top    = await client.network.topAssets();
// Search by symbol or name
const found  = await client.network.searchAssets('btc');
// Ticker history
const ticker = await client.network.ticker(assetID, '2025-01-01T00:00:00Z');
// Single asset (network view)
const a      = await client.network.fetchAsset(assetID);
```

```go
top, _    := bot.NetworkTopAssets(ctx)
found, _  := bot.NetworkSearchAssets(ctx, "btc")
ticker, _ := bot.NetworkTicker(ctx, assetID, t)
asset, _  := bot.NetworkFetchAsset(ctx, assetID)
```

Use `client.network.*` / `bot.Network*` whenever a session-scoped balance isn't needed — cheaper, less rate-limited.

## Safe outputs and balance

`outputs` are the current UTXO set owned by a `(members, threshold)` pair. Use `/safe/outputs` when you need spendable inputs, balance reconstruction, or an ordered stream of group-addressed outputs for MTG-style processing. The `offset` cursor is the Sequencer output `sequence`, not a timestamp.

```js
const outputs = await client.utxo.safeOutputs({
  members: [keystore.app_id], threshold: 1, asset: assetID, state: 'unspent',
});
const balance = await client.utxo.safeAssetBalance({
  members: [keystore.app_id], threshold: 1, asset: assetID, state: 'unspent',
});
```

```go
outputs, _ := bot.ListUnspentOutputs(ctx, "", []string{su.UserId}, 1, assetID, 0, 256, su)
// `balance` in Go is generally derived by summing outputs.
```

For UTXO selection rules, see [`mixin-safe-transactions`](../mixin-safe-transactions/SKILL.md).

## Safe snapshots — balance changes

A snapshot is a record of a balance-changing event. For ordinary bots and clients, polling `/safe/snapshots` is the recommended way to detect inbound transfers or reconcile account activity (preferred over the legacy Blaze `SYSTEM_ACCOUNT_SNAPSHOT`). This is distinct from MTG worker processing: group programs consume `/safe/outputs` by sequence and use snapshots/transaction state only to confirm their own submitted transactions.

```js
const snaps = await client.safe.fetchSafeSnapshots({
  asset: assetID,         // optional
  opponent: userID,       // optional
  offset: cursor,         // ISO timestamp from previous batch's last item
  limit: 100,
  order: 'DESC',
});
// snaps[].snapshot_id, snapshot_hash, opponent_id, asset_id, amount, memo, transaction_hash, ...
```

```go
snaps, _ := bot.SafeSnapshotsRead(ctx, assetID, opponentID, cursor, "DESC", 100, su)
```

Persist the latest `created_at` cursor and resume from there. Snapshots include the kernel `transaction_hash` so you can correlate with your own outgoing transactions.

## Single-bot deposit worker pattern

For a centralized bot or backend service (not MTG), make deposits snapshot-driven:

1. Create a `MIN...` invoice or payment request with a stable UUID `trace_id` / `request_id` and an application memo.
2. Run a background worker that polls `/safe/snapshots` with the bot `app` parameter and a persisted RFC3339Nano time cursor.
3. Ignore non-positive amounts and unsupported assets; decode the memo and map the snapshot to the intended order/deposit.
4. Store `snapshot_id`, `request_id`, `trace_id`, `opponent_id`, `asset_id`, amount, memo, and status in your database with unique constraints on `snapshot_id` and `trace_id`.
5. Process each snapshot idempotently. If business processing fails after receiving funds, create a refund/withdrawal task with a deterministic Safe transfer request ID.
6. For outbound transfers, build and submit a Safe transaction, then poll `/safe/transactions/:id` until state is `spent`.

Use `/safe/outputs` in this architecture only when the bot needs spendable UTXOs for outgoing Safe transfers or local balance reconstruction. Do not poll `/safe/outputs` as the ordinary deposit event feed for a single bot.

## Safe transactions — submitted transfer state

Use `/safe/transactions/:id` after broadcasting a Safe transaction to read the request state (`signed` or `spent`) plus `snapshot_hash` / `snapshot_at` when the transaction has landed. Do not use snapshots as the source of spendable inputs; use `/safe/outputs` for UTXO selection.

### Notify a snapshot

To attach a memo / message to a specific received snapshot (e.g. credit confirmation), call `safe.notifySnapshot`:

```js
await client.safe.notifySnapshot({ snapshot_id, message: 'credited' });
```

```go
err := bot.SafeSnapshotNotify(ctx, snapshotID, message, su)
```

## Validation

- For polling snapshots, wrap the cursor in your own persistence (DB row), not in-memory state, so a restart resumes correctly.
- For network/ticker calls, cache responses; ticker is per-day stable.
- For balance, sum outputs locally and compare against `safeAssetBalance` to catch stale local state.
- For MTG or Computer-style services, process `/safe/outputs` by monotonically increasing `sequence`; snapshots are for user-visible activity history and transaction confirmation.
