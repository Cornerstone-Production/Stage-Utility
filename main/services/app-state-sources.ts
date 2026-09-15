// app-state-sources.ts — state a cue pair reads from STAGE UTILITY itself.
//
// A bound pair's state normally comes from a Companion variable (see
// cue-pairs.ts): Companion answers a press the moment it hands it to a control
// and never says what the device did, so the operator's own buttons publish the
// answer and this app reads it.
//
// A cue that does not press a Companion button at all has no such variable, and
// does not need one — Stage Utility is already talking to the device. A cue that
// starts a REAPER recording is bound to `app:reaper.recording`, which is read
// straight off the REAPER transport poll. The `app:` prefix is what keeps the
// two namespaces apart: everything without it is a Companion ref, exactly as
// before.
//
// PURE, and it must stay that way. The rule editor imports cue-pairs.ts, which
// imports this — a browser bundle that reached reaper-service.ts would drag the
// whole server into the renderer. The READERS therefore live in
// app-state-reads.ts, which is server-only, and a `Record<AppStateSourceId, …>`
// over the union below is what stops a source shipping without one.

/** What marks a `stateVariable` as read from this app rather than Companion. */
export const APP_STATE_PREFIX = "app:";

/** Every source, as a union — see the header for why the readers are elsewhere. */
export const APP_STATE_SOURCE_IDS = ["reaper.recording"] as const;

export type AppStateSourceId = (typeof APP_STATE_SOURCE_IDS)[number];

export interface AppStateSourceDef {
  /** What the rule editor calls it. */
  label: string;
  /** The one line the rule editor says under it. Declared here so a second
   *  source cannot arrive with the first one's wording. */
  hint: string;
  /**
   * The broadcast channel whose producer has to be running for this to be
   * fresh. A bound pair is demand on that channel — REAPER polls every five
   * seconds with nobody watching, which is a cue state five seconds stale on
   * the unattended box this feature is for. automation-engine.ts registers it.
   */
  channel: string;
  /**
   * The integration this comes from, as INTEGRATION_IDS spells it. The rule
   * editor offers a source only when its integration is set up — there is no
   * state to read otherwise — and deriving that from the source id's first
   * segment would be a convention nothing enforces.
   */
  integrationId: string;
  /** The two values this source reports. A pair bound to it is fixed to them. */
  onValue: string;
  offValue: string;
}

export const APP_STATE_SOURCES = new Map<AppStateSourceId, AppStateSourceDef>([
  [
    "reaper.recording",
    {
      label: "REAPER recording (Stage Utility)",
      hint: "Read from Stage Utility's REAPER connection. Nothing to set up.",
      channel: "reaper:status",
      integrationId: "reaper",
      onValue: "on",
      offValue: "off",
    },
  ],
]);

/** The full ref for a source — what a rule stores in `stateVariable`. */
export function appStateRef(id: AppStateSourceId): string {
  return `${APP_STATE_PREFIX}${id}`;
}

/** Is this `stateVariable` an app source rather than a Companion variable? */
export function isAppStateRef(variable: string): boolean {
  return variable.trim().startsWith(APP_STATE_PREFIX);
}

/** The source this ref names, or null when nothing here answers to it. */
export function appStateSourceId(variable: string): AppStateSourceId | null {
  const trimmed = variable.trim();
  if (!isAppStateRef(trimmed)) return null;
  const id = trimmed.slice(APP_STATE_PREFIX.length);
  return APP_STATE_SOURCES.has(id as AppStateSourceId) ? (id as AppStateSourceId) : null;
}

/** The source this ref names, with its label, values and hint, or null. */
export function appStateSourceDef(variable: string): AppStateSourceDef | null {
  const id = appStateSourceId(variable);
  return id ? (APP_STATE_SOURCES.get(id) ?? null) : null;
}

/**
 * Why this app ref cannot be saved, or null when it can.
 *
 * REFUSED rather than accepted and read as unknown forever: `app:reaper` is a
 * typo whose only symptom would be a switch that never reports anything, so the
 * known sources are listed at the moment it is typed.
 */
export function appStateProblem(variable: string): string | null {
  if (appStateSourceId(variable)) return null;
  const known = [...APP_STATE_SOURCES.keys()].map((id) => appStateRef(id)).join(", ");
  return `"${variable.trim()}" is not a Stage Utility state source — ${known}`;
}
