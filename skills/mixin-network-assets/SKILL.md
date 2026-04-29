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

`outputs` are unspent UTXOs the (members, threshold) pair owns. `balance` is the sum.

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

## Safe snapshots — what landed in your account

A snapshot is a record of an output you received. Polling `/safe/snapshots` is the *recommended* way to detect inbound transfers (preferred over the legacy Blaze `SYSTEM_ACCOUNT_SNAPSHOT`).

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
