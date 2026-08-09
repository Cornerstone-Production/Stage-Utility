// wireless-credentials.ts — keep wireless passwords out of the config store.
//
// A wireless connection's `config` is provider-defined, and for Sennheiser
// Spectera it contains the base station's API password. That whole object used
// to be persisted verbatim in wireless-connections.json, returned unmasked by
// GET /api/wireless/connections, broadcast over SSE, and — because the file is
// in CONFIG_FILES — written into every config snapshot, directly contradicting
// what the snapshot tells the operator ("secrets are not included, so the file
// is safe to store").
//
// Credentials now follow the same route integration secrets already take: split
// out of the config on the way to disk, stored encrypted, and replaced with a
// mask on the way out. The mask is the same "••••" integration-manager uses, and
// means the same thing — "a value is set, and it is not being shown to you". An
// incoming config that still carries the mask is saying "leave it alone", which
// is what lets the UI round-trip a form it never received the real value for.

import { providerRegistry } from "../providers/registry.js";

export const MASK = "••••";

/**
 * Is this value a mask rather than a password?
 *
 * Any run of bullets, not just our own MASK: the panel renders its own
 * `"••••••••"` into the field it shows, and matches with the same `/^•+$/`. If
 * only the exact constant counted, a form that echoed the longer one back would
 * store a row of bullets AS the base station's password — and the real one would
 * be gone with no way to tell from the UI, which shows bullets either way.
 */
export function isMask(value: unknown): boolean {
  return typeof value === "string" && /^•+$/.test(value);
}

/** Which config keys for this provider hold a credential. */
export function credentialKeys(providerId: string): string[] {
  const schema = providerRegistry.getDescriptor(providerId)?.configSchema ?? [];
  return schema.filter((f) => f.type === "password").map((f) => f.key);
}

/** Split a full config into the part safe to persist and the part that is not. */
export function splitConfig(
  providerId: string,
  config: Record<string, unknown>,
): { safe: Record<string, unknown>; secret: Record<string, string> } {
  const keys = credentialKeys(providerId);
  const safe: Record<string, unknown> = { ...config };
  const secret: Record<string, string> = {};
  for (const key of keys) {
    const value = safe[key];
    delete safe[key];
    // The mask is not a value — it is the UI saying "unchanged". Never store it.
    if (typeof value === "string" && value !== "" && !isMask(value)) secret[key] = value;
  }
  return { safe, secret };
}

/**
 * The config a client may see, from the full in-memory one.
 *
 * Takes the config with credentials present and returns it with each replaced by
 * the mask (or "" when unset), so a caller cannot leak a password by forgetting
 * to strip it first.
 */
export function publicConfig(
  providerId: string,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const { safe } = splitConfig(providerId, config);
  for (const key of credentialKeys(providerId)) {
    const value = config[key];
    safe[key] = typeof value === "string" && value !== "" ? MASK : "";
  }
  return safe;
}

/** The config a driver needs: non-secret values plus the real credentials. */
export function withSecrets(
  safe: Record<string, unknown>,
  secret: Record<string, string>,
): Record<string, unknown> {
  return { ...safe, ...secret };
}

/**
 * Fold an incoming patch into the stored credentials.
 *
 * A masked or absent value keeps what is already stored; an empty string is an
 * explicit clear. Without this an operator editing only the IP would blank the
 * password, because the form posts back the mask it was given.
 */
export function mergeSecrets(
  providerId: string,
  incoming: Record<string, unknown>,
  stored: Record<string, string>,
): Record<string, string> {
  const next = { ...stored };
  for (const key of credentialKeys(providerId)) {
    if (!(key in incoming)) continue;
    const value = incoming[key];
    if (isMask(value)) continue; // unchanged
    if (value === "") delete next[key]; // explicit clear
    else if (typeof value === "string") next[key] = value;
  }
  return next;
}
