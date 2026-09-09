// companion-reconcile.ts — keeping a cue pointed at its button when the button moves.
//
// A `companion.press` action stores three coordinates. Coordinates are the one
// thing about a Companion button that does not last: somebody drags a button one
// key over, or inserts a page ahead of it, and the cue presses whatever is now at
// p17 r2 c6. Nothing anywhere says so — Companion answers 204 for an empty
// coordinate and a cheerful 200 for the wrong button.
//
// So each press action also stores the page's opaque id and the button's action
// ids (see companion-fingerprint.ts), and this compares the two against the
// export:
//
//   the ids match at the stored coordinates          -> in-place, label refreshed
//   exactly one button on that page has those ids    -> moved, coordinates updated
//   none, or more than one, or the page is gone      -> missing
//
// MISSING REFUSES. It does not fall back to the coordinates and it does not pick
// the closest label: a cue that presses the wrong button during setup is worse
// than one that says it cannot. Ambiguity is missing for the same reason — two
// buttons carrying one identity is a Companion somebody duplicated, and guessing
// between them is a coin toss on real gear.
//
// The read is the SAME cached export the picker uses, never a second fetch path.
// When it cannot be read, nothing changes and nothing is logged here — the export
// fetch already writes `[companion] export unavailable`, and a run that
// downgraded every cue to `missing` because a switch was rebooting would refuse
// every cue in the building.

import { scrub, scrubError } from "./scrub.js";
import { automationEngine } from "./automation-engine.js";
import { companionApi } from "./companion-api.js";
import type { CompanionButton } from "./companion-export.js";
import {
  type ButtonFingerprint,
  type ButtonLocation,
  type CueButtonStatus,
  fingerprintParams,
  readFingerprint,
  sameFingerprint,
  shortLocation,
} from "./companion-fingerprint.js";
import type { Rule } from "../types/automation.js";

export const PRESS_ACTION_ID = "companion.press";

/** Room for a whole sentence: scrub()'s 200-character default would cut a moved
 *  line off mid-coordinate, and these lines are what an operator reads. */
const LOG_MAX = 600;

/** One press action to check, reduced to what the pure pass needs. */
export interface PressEntry {
  ruleId: string;
  /** What a log line calls it: the cue name, or the rule's name when it is not a cue. */
  label: string;
  params: Record<string, string | number>;
}

/** What one press action's check decided. */
export interface ReconcileChange {
  ruleId: string;
  label: string;
  status: CueButtonStatus;
  /** The params to merge, or null when nothing about it changed. */
  patch: Record<string, string | number> | null;
  /** The line to log, or null when the change is not worth one. */
  log: string | null;
}

export interface ReconcileResult {
  changes: ReconcileChange[];
  counts: Record<CueButtonStatus, number>;
  /** How many press actions were looked at, including the unchanged ones. */
  checked: number;
}

/** Every press action among these rules, with the name a log line would use. */
export function pressEntries(rules: readonly Rule[]): PressEntry[] {
  const out: PressEntry[] = [];
  for (const rule of rules) {
    if (rule.action.id !== PRESS_ACTION_ID) continue;
    out.push({
      ruleId: rule.id,
      label: automationEngine.cueNameOf(rule) || rule.name,
      params: rule.action.params,
    });
  }
  return out;
}

const keyOf = (ids: readonly string[]): string => [...ids].sort().join(",");

/**
 * The whole decision, PURE.
 *
 * `buttons` is the parsed export. `nowIso` is stamped onto anything that
 * changed, so a caller can reproduce a run exactly.
 */
export function reconcileCues(
  entries: readonly PressEntry[],
  buttons: readonly CompanionButton[],
  nowIso: string,
): ReconcileResult {
  // Indexed by the page's own id, because the page NUMBER is what may have
  // moved. Two pages cannot share an id, so the first wins is not a case.
  const byPageId = new Map<string, { page: number; pageName: string; buttons: CompanionButton[] }>();
  const nameByPageNum = new Map<number, string>();
  for (const b of buttons) {
    nameByPageNum.set(b.page, b.pageName);
    if (!b.pageId) continue;
    const page = byPageId.get(b.pageId) ?? { page: b.page, pageName: b.pageName, buttons: [] };
    page.buttons.push(b);
    byPageId.set(b.pageId, page);
  }

  const changes: ReconcileChange[] = [];
  const counts: Record<CueButtonStatus, number> = { "in-place": 0, moved: 0, missing: 0 };
  let checked = 0;

  for (const entry of entries) {
    const was = readFingerprint(entry.params);
    // A rule whose button has never been chosen — the action's own three fields
    // are still blank. There is nothing to reconcile and nothing to refuse.
    if (was.page < 1) continue;
    checked++;

    const decided = decide(was, entry, byPageId, nameByPageNum, nowIso);
    counts[decided.status]++;

    // Compared as FINGERPRINTS, not as raw params, and `lastSeenAt` is not one
    // of the compared fields: an hourly run that rewrote it every time would
    // save the rules file every hour and put a fresh "updated just now" under an
    // amber pill that had not moved in a week.
    const { patch } = decided;
    const unchanged = sameFingerprint(readFingerprint({ ...entry.params, ...patch }), was);
    changes.push({
      ruleId: entry.ruleId,
      label: entry.label,
      status: decided.status,
      patch: unchanged ? null : patch,
      log: unchanged ? null : decided.log,
    });
  }

  return { changes, counts, checked };
}

/** One press action's verdict. See the header for the three outcomes. */
function decide(
  was: ButtonFingerprint,
  entry: PressEntry,
  byPageId: Map<string, { page: number; pageName: string; buttons: CompanionButton[] }>,
  nameByPageNum: Map<number, string>,
  nowIso: string,
): { status: CueButtonStatus; patch: Record<string, string | number>; log: string | null } {
  const missing = (why: string): {
    status: CueButtonStatus;
    patch: Record<string, string | number>;
    log: string | null;
  } => ({
    status: "missing",
    // The coordinates and the identity are KEPT. They are what an operator
    // reads to find the button again, and what the next reconcile matches on
    // when somebody puts it back.
    patch: { status: "missing", lastSeenAt: nowIso, movedFrom: "" },
    log: `[companion] cue ${entry.label}: ${why}`,
  });

  const notFoundHere = (pageNum: number): string => {
    const name = nameByPageNum.get(pageNum) ?? "no such page";
    return `button not found on page ${pageNum} (${name})`;
  };

  // No page id: a rule created before the fingerprint existed, or written by
  // hand. ADOPTED at its own coordinates rather than refused — an upgrade must
  // not break every working cue on the box.
  if (!was.pageId) {
    const here = atCoordinates(byPageId, was);
    if (!here) return missing(notFoundHere(was.page));
    return {
      status: "in-place",
      patch: fingerprintParams(here, "in-place", nowIso),
      log: `[companion] cue ${entry.label}: adopted the button at p${here.page} ${shortLocation(here)} ("${here.label}")`,
    };
  }

  const page = byPageId.get(was.pageId);
  if (!page) return missing(notFoundHere(was.page));

  const wanted = keyOf(was.actionIds);
  const here = page.buttons.find((b) => b.row === was.row && b.col === was.col);

  /**
   * `moved` STICKS until somebody re-picks the button.
   *
   * The pass that follows a move finds the button exactly where it now says it
   * is, so a plain "in-place" here would clear the amber pill within the hour —
   * and the one thing the pill is for is telling an operator that a button they
   * did not think had moved, has. Re-picking it in the editor writes `in-place`
   * and clears it; nothing else does, deliberately.
   */
  const carried: { status: CueButtonStatus; from: ButtonLocation | null } =
    was.status === "moved" && was.movedFrom
      ? { status: "moved", from: was.movedFrom }
      : { status: "in-place", from: null };

  if (here && keyOf(here.actionIds) === wanted) {
    const renumbered = page.page !== was.page;
    return {
      status: carried.status,
      patch: fingerprintParams(here, carried.status, nowIso, carried.from),
      log: renumbered
        ? `[companion] cue ${entry.label}: page renumbered ${was.page} -> ${page.page}`
        : null,
    };
  }

  // An empty fingerprint cannot be searched for: 59 of the 536 buttons on the
  // install this was built against run nothing at all, and every one of them
  // would match every other. Coordinates are all such a button ever had.
  if (wanted === "") {
    return here
      ? {
          status: carried.status,
          patch: fingerprintParams(here, carried.status, nowIso, carried.from),
          log: null,
        }
      : missing(notFoundHere(page.page));
  }

  const found = page.buttons.filter((b) => keyOf(b.actionIds) === wanted);
  if (found.length !== 1) {
    // More than one is refused as loudly as none. Two buttons carrying one
    // identity is a Companion somebody duplicated, and picking between them is
    // a coin toss on real gear.
    return missing(
      found.length === 0
        ? notFoundHere(page.page)
        : `${found.length} buttons on page ${page.page} (${page.pageName}) carry its actions — refusing to guess`,
    );
  }

  const now = found[0]!;
  const from: ButtonLocation = { page: was.page, row: was.row, col: was.col };
  return {
    status: "moved",
    patch: fingerprintParams(now, "moved", nowIso, from),
    log:
      `[companion] cue ${entry.label}: button moved ` +
      `p${from.page} ${shortLocation(from)} -> p${now.page} ${shortLocation(now)}`,
  };
}

/** The button at a fingerprint's stored coordinates, on any page. */
function atCoordinates(
  byPageId: Map<string, { page: number; pageName: string; buttons: CompanionButton[] }>,
  was: ButtonFingerprint,
): CompanionButton | undefined {
  for (const page of byPageId.values()) {
    if (page.page !== was.page) continue;
    const hit = page.buttons.find((b) => b.row === was.row && b.col === was.col);
    if (hit) return hit;
  }
  return undefined;
}

// ── Running it ────────────────────────────────────────────────────────────────

/** The summary of one run, or null when Companion could not be read. */
export interface ReconcileRun {
  checked: number;
  applied: number;
  counts: Record<CueButtonStatus, number>;
}

/**
 * Read the cached export, reconcile every press action, persist what changed.
 *
 * Writes go through `automationEngine.updateRule`, which is what saves the rules
 * file and broadcasts — an open settings page sees a moved button without a
 * reload, and nothing here knows where the file is.
 *
 * Returns null when the export could not be read, having changed nothing.
 */
export async function runCompanionReconcile(): Promise<ReconcileRun | null> {
  const result = await companionApi.fetchExport();
  if (!result.ok) return null;

  const rules = automationEngine.listRules();
  const nowIso = new Date().toISOString();
  const { changes, counts, checked } = reconcileCues(pressEntries(rules), result.buttons, nowIso);

  let applied = 0;
  for (const change of changes) {
    if (!change.patch) continue;
    const rule = rules.find((r) => r.id === change.ruleId);
    if (!rule) continue;
    try {
      await automationEngine.updateRule(rule.id, {
        action: { ...rule.action, params: { ...rule.action.params, ...change.patch } },
      });
      applied++;
      // The barrier is HERE, at the console call, not inside the pure pass that
      // built the sentence: scrub() has to be visible at the log site or the
      // static scan cannot see it, and a value laundered through a helper is
      // exactly the shape log-injection.test.ts refuses. See scrub.ts.
      if (change.log) console.warn(scrub(change.log, LOG_MAX));
    } catch (err) {
      // Rethrowing would abandon the rest of the rules over one of them, and
      // swallowing it would leave a cue silently unreconciled. Reported, and the
      // pass carries on to the others.
      // ONE template, no trailing argument: a cue label can contain a `%`, and
      // `console.error(fmt, arg)` would read it as a format specifier and eat
      // the reason. See log-injection.test.ts.
      // A literal format string with the values in an argument: a cue label can
      // contain a `%`, and `console.error(fmt, arg)` reads that as a format
      // specifier and eats the reason after it.
      console.error(
        "[companion] could not record a button status:",
        scrub(change.label),
        scrub(scrubError(err), LOG_MAX),
      );
    }
  }

  console.log(
    `[companion] reconciled ${scrub(checked)} cues: ${scrub(counts["in-place"])} in place, ` +
      `${scrub(counts.moved)} moved, ${scrub(counts.missing)} missing`,
  );
  return { checked, applied, counts };
}

/** Hourly. Long enough that a Companion being edited settles, short enough that
 *  a button moved on Thursday is amber before Sunday. */
const RECONCILE_EVERY_MS = 60 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;

/**
 * Start the hourly pass. Idempotent, and a no-op with no Companion host — there
 * is nothing to read and a timer would only ask a service that is switched off.
 *
 * unref'd: a housekeeping sweep must never be what keeps the process alive. An
 * un-unref'd one held every test file that boots the controller open forever.
 */
export function startCompanionReconcile(hasHost: boolean): void {
  stopCompanionReconcile();
  if (!hasHost) return;
  timer = setInterval(() => {
    void runCompanionReconcile().catch((err) => console.error("[companion] reconcile failed:", scrubError(err)));
  }, RECONCILE_EVERY_MS);
  timer.unref();
}

export function stopCompanionReconcile(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
