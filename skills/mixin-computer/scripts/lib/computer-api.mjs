/**
 * Typed Computer HTTP API client.
 * All endpoints are public (no auth). The POST endpoints (nonce, fee)
 * accept JSON body but do not require Mixin authentication.
 */

const BASE = process.env.COMPUTER_API_URL ?? "https://computer.mixin.one";

async function req(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Computer ${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

export const computerApi = {
  /** GET / — observer, payer, MTG members, operation asset + price */
  info: () => req("GET", "/"),

  /** GET /users/:id — look up by MIX address, UUID, or Solana address */
  user: (address) => req("GET", `/users/${encodeURIComponent(address)}`),

  /** GET /deployed_assets — list all deployed Solana assets */
  assets: () => req("GET", "/deployed_assets"),

  /** GET /system_calls/:id — check call status, hash, error */
  systemCall: (id) => req("GET", `/system_calls/${encodeURIComponent(id)}`),

  /** POST /nonce_accounts — get a nonce for a registered MIX address */
  getNonce: (mix) => req("POST", "/nonce_accounts", { mix }),

  /** POST /fee — quote XIN fee for a given SOL amount */
  getFee: (solAmount) => req("POST", "/fee", { sol_amount: solAmount }),
};
