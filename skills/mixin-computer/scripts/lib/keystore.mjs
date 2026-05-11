/**
 * Keystore loading with priority:
 *   1. --config=path flag (JSON file, same format as bot dashboard export)
 *   2. Individual env vars  → MIXIN_APP_ID / SESSION_ID / PRIVATE_KEY / SERVER_PUBLIC_KEY / SPEND_KEY
 */

import { readFileSync } from "fs";
import path from "path";

export function loadKeystore(args) {
  if (args.config) {
    const resolved = args.config.startsWith("~")
      ? path.join(process.env.HOME ?? "", args.config.slice(1))
      : args.config;
    const raw = JSON.parse(readFileSync(resolved, "utf-8"));
    const ks = {
      app_id: raw.app_id ?? raw.client_id,
      session_id: raw.session_id,
      session_private_key: raw.session_private_key ?? raw.private_key,
      server_public_key: raw.server_public_key,
      spend_key: raw.spend_private_key,
    };
    validate(ks);
    return ks;
  }

  const ks = {
    app_id: process.env.MIXIN_APP_ID ?? "",
    session_id: process.env.MIXIN_SESSION_ID ?? "",
    session_private_key: process.env.MIXIN_PRIVATE_KEY ?? "",
    server_public_key: process.env.MIXIN_SERVER_PUBLIC_KEY ?? "",
    spend_key: process.env.MIXIN_SPEND_KEY ?? "",
  };
  validate(ks);
  return ks;
}

function validate(ks) {
  const missing = Object.keys(ks).filter((k) => !ks[k]);
  if (missing.length) {
    throw new Error(
      `Keystore missing: ${missing.join(", ")}\n` +
        "Pass --config=keystore.json or set MIXIN_APP_ID, MIXIN_SESSION_ID, " +
        "MIXIN_PRIVATE_KEY, MIXIN_SERVER_PUBLIC_KEY, MIXIN_SPEND_KEY env vars."
    );
  }
}

export function parseArgs() {
  return Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const [k, ...v] = a.replace(/^--/, "").split("=");
      return [k, v.length ? v.join("=") : "true"];
    })
  );
}
