// integration-ids.ts — the canonical list of integrations the app ships.
//
// Kept separate from integration-manager.ts so that tests can read it without
// pulling the manager (and every device provider behind it) into scope.
//
// Adding an id here fails the automation coverage test until that integration has
// at least one trigger or condition. That is the point: automation entries are
// hand-written per integration, so without a guardrail a new integration would
// quietly ship with no way to automate it and nobody would notice for months.

export const INTEGRATION_IDS = [
  "companion",
  "obs",
  "osc",
  "planning-center",
  "prodcom",
  "propresenter",
  "reaper",
  "resi",
  "ross-tsl",
  "rosstalk",
  "sensource",
  "smaart",
  "youtube",
  "wireless",
] as const;

export type IntegrationId = (typeof INTEGRATION_IDS)[number];

/**
 * The integrations whose connection is re-applied when their config or their
 * enabled flag changes.
 *
 * Separate from INTEGRATION_IDS because not every integration has a connection
 * to re-apply. The five that are absent are absent for a reason:
 *
 *  - `companion` and `rosstalk` are INBOUND. Something else connects to us, so
 *    there is nothing to dial on a config change.
 *  - `osc` is fire-and-forget UDP with no session to rebuild.
 *  - `planning-center` and `wireless` do different work in setConfig than in
 *    setEnabled, so they stay written out where that difference is visible.
 *
 * integration-manager types its applier map as `Record<ConnectionManagedId, …>`,
 * so adding an id here without an applier is a compile error rather than an
 * integration that silently never reconnects.
 */
export const CONNECTION_MANAGED_IDS = [
  "obs",
  "prodcom",
  "propresenter",
  "reaper",
  "resi",
  "ross-tsl",
  "sensource",
  "smaart",
  "youtube",
] as const;

export type ConnectionManagedId = (typeof CONNECTION_MANAGED_IDS)[number];
