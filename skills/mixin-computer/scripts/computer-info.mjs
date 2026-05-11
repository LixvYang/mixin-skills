#!/usr/bin/env node
/**
 * Mixin Computer — Query Info
 *
 * Calls the public Mixin Computer HTTP API (no auth needed).
 *
 * Usage:
 *   node computer-info.mjs
 */

const info = await (await fetch("https://computer.mixin.one")).json();

console.log("Mixin Computer Info\n");
console.log("Observer    :", info.observer);
console.log("Payer       :", info.payer);
console.log("Height      :", info.height);
console.log("Version     :", info.version);
console.log("MTG App ID  :", info.members?.app_id ?? "?");
console.log("Members     :", info.members?.members?.length ?? "?", `(threshold: ${info.members?.threshold ?? "?"})`);

const op = info.params?.operation;
if (op) {
  console.log("\nRegistration cost:");
  console.log("  Asset :", op.asset);
  console.log("  Price :", op.price, "XIN");
}
