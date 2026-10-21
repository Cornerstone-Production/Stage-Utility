// integration-targets.ts — where an integration connects, read off its saved
// config, and so where its stored credential is sent.
//
// The dialling code in integration-manager.ts and the check that drops a
// credential whose address changed both read the target from here, so the two
// cannot disagree about it. They used to be able to: the form seeds an unset
// port with the integration's default and posts it back on every save, and a
// comparison that saw "unset" before and "4455" after would have cleared the OBS
// password on a save that changed nothing.
//
// Kept apart from integration-manager.ts so a config restore can work out
// targets without loading the manager and every provider behind it.

import type { CredentialTarget } from "./credential-target.js";
import type { IntegrationId } from "./integration-ids.js";

/**
 * A saved number, which the settings form may have stored as a number or as the
 * string it was typed as. NaN when unset, blank or not a number.
 */
export function configNumber(raw: unknown): number {
  if (typeof raw === "number") return raw;
  if (typeof raw === "string" && raw.trim()) return parseInt(raw, 10);
  return NaN;
}

/** {@link configNumber}, kept only when it is a positive number. */
export function positiveConfigNumber(raw: unknown): number | null {
  const n = configNumber(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * A host/port target off an integration's config, defaulting the port.
 *
 * Only defaults the port when a host was given AND there is a default worth
 * giving: no host is "not configured", and an integration whose port has no
 * conventional value (PVP's is whatever its Preferences pane shows) must not be
 * reported as configured on the strength of a guess.
 */
export function hostPortOf(
  cfg: Record<string, unknown>,
  defaultPort: number | null,
): { host: string | null; port: number | null } {
  const host = typeof cfg.host === "string" && cfg.host.trim() ? cfg.host.trim() : null;
  return { host, port: positiveConfigNumber(cfg.port) ?? (host ? defaultPort : null) };
}

/** obs-websocket's standard port. */
const OBS_DEFAULT_PORT = 4455;
/** Smaart's standard API port, the default when only a host is given. */
const SMAART_DEFAULT_PORT = 26000;

export const obsTarget = (cfg: Record<string, unknown>) => hostPortOf(cfg, OBS_DEFAULT_PORT);
export const smaartTarget = (cfg: Record<string, unknown>) => hostPortOf(cfg, SMAART_DEFAULT_PORT);
/** ProdCom has no conventional port, so a stored one is required. */
export const prodcomTarget = (cfg: Record<string, unknown>) => hostPortOf(cfg, null);
/** PVP's Network API port is whatever its Preferences pane shows. The setup
 *  form PREFILLS 50742 (the descriptor's `default`), which is what a real
 *  install shows — but a prefill is a suggestion the operator saves, and this
 *  is the dialling path. Assuming a port here would let "configured" point at
 *  one nothing is listening on, so a stored value is still required. */
export const pvpTarget = (cfg: Record<string, unknown>) => ({ ...hostPortOf(cfg, null), https: cfg.https === "on" });

/**
 * Where each integration with a credential sends it.
 *
 * Exactly the integrations whose credential goes to an address the operator
 * types; integration-credential-moves.test.ts pins that against the
 * descriptors. The others' go to a fixed service (Planning Center, Resi,
 * YouTube, SenSource), so there is no address to move. A Map typed by
 * IntegrationId, so a misspelt id is a compile error rather than a credential
 * that never gets dropped.
 */
const CREDENTIAL_TARGETS = new Map<IntegrationId, (cfg: Record<string, unknown>) => CredentialTarget>([
  ["obs", obsTarget],
  ["prodcom", prodcomTarget],
  ["pvp", (cfg) => {
    const t = pvpTarget(cfg);
    // Encrypted or not, so turning HTTPS off is a move: the token would
    // otherwise go to the same host in the clear. Turning it on is not.
    return { host: t.host, port: t.port, encrypted: t.https };
  }],
  ["smaart", smaartTarget],
]);

/** Where `id` sends its credential under `cfg`, or null when its credential (if
 *  it has one) goes to a fixed service. */
export function credentialTargetFor(id: string, cfg: Record<string, unknown> | undefined): CredentialTarget | null {
  const target = CREDENTIAL_TARGETS.get(id as IntegrationId);
  return target ? target(cfg ?? {}) : null;
}

/** The integrations {@link credentialTargetFor} answers for, sorted. */
export function credentialTargetIds(): string[] {
  return [...CREDENTIAL_TARGETS.keys()].sort();
}
