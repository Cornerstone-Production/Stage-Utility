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
  "ross-tsl",
  "rosstalk",
  "sensource",
  "smaart",
  "wireless",
] as const;

export type IntegrationId = (typeof INTEGRATION_IDS)[number];
