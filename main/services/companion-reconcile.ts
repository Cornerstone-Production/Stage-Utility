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
// A RELABELLED button renames its cue, in a second pass over the same result.
// The cue name is the URL Home Assistant calls, so a cue called
// `projectors_on` whose button now says "Screens ON" is a name nobody in the
// building would guess — but a bare rename breaks the pasted config, so the old
// name is kept as an alias and keeps answering. A cue somebody named by hand is
// never renamed, a collision keeps the name, and an ON/OFF pair renames together
// or not at all. See renamePass.
//
// The read is the SAME cached export the picker uses, never a second fetch path.
// When it cannot be read, nothing changes and nothing is logged here — the export
// fetch already writes `[companion] export unavailable`, and a run that
// downgraded every cue to `missing` because a switch was rebooting would refuse
// every cue in the building.

import { errorMessage } from "./errors.js";
import { scrub, scrubError } from "./scrub.js";
import { automationEngine } from "./automation-engine.js";
import { companionApi } from "./companion-api.js";
import {
  type CompanionButton,
  type PairHalf,
  importedCueNames,
  importedCues,
} from "./companion-export.js";
import { encodeAliases, nextAliases } from "./cue-aliases.js";
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

/**
 * What one cue answers to, for the rename pass.
 *
 * EVERY cue in the engine is passed, not only the ones with a press action: a
 * cue whose action is something else still holds a name, and renaming onto it
 * would be the collision this whole pass exists to avoid.
 */
export interface CueIdentity {
  ruleId: string;
  name: string;
  /** Former names, oldest first. See cue-aliases.ts. */
  aliases: string[];
  /** What the assistant says. Follows the label when it was the label. */
  says: string;
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
  /** The TRIGGER params to merge — a rename — or null when the name is unchanged. */
  triggerPatch: Record<string, string | number> | null;
  /**
   * The line about the rename, or about refusing to.
   *
   * Separate from `log` because a button can be moved and relabelled between two
   * passes, and those are two facts an operator reads for different reasons.
   */
  renameLog: string | null;
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
    // The literal, as every other action id is written in this app — there is
    // no shared constant for any of them and inventing one for this alone would
    // be two conventions.
    if (rule.action.id !== "companion.press") continue;
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
  cues: readonly CueIdentity[],
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
  const relabelled: Relabelled[] = [];
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
      triggerPatch: null,
      renameLog: null,
    });

    // A relabelled button, collected for the second pass. Only ever a button
    // that was FOUND, and only one whose identity had been confirmed before —
    // `status === null` is a rule the pass has just adopted at its coordinates,
    // where a differing label means "this may be a different button", not
    // "somebody renamed this one".
    if (decided.found && was.status !== null && decided.found.label !== was.label) {
      relabelled.push({ ruleId: entry.ruleId, was, button: decided.found });
    }
  }

  // SECOND PASS, because a rename has to see every relabelled cue at once: two
  // buttons can be relabelled to the same words, and an ON/OFF pair renames
  // together or not at all.
  for (const [ruleId, renamed] of renamePass(relabelled, cues, buttons)) {
    const change = changes.find((c) => c.ruleId === ruleId);
    if (!change) continue;
    change.triggerPatch = renamed.patch;
    change.renameLog = renamed.log;
  }

  return { changes, counts, checked };
}

/** A found button whose label is not the one the cue remembers. */
interface Relabelled {
  ruleId: string;
  was: ButtonFingerprint;
  button: CompanionButton;
}

/** What the rename pass decided for one cue. */
interface Renamed {
  /** The trigger params to merge, or null when the name is kept. */
  patch: Record<string, string | number> | null;
  log: string | null;
}

/**
 * Rename the cues whose buttons were relabelled, PURE.
 *
 * The rule, and every clause of it is a bug somebody would otherwise hit:
 *
 *  - A HAND-NAMED CUE IS NEVER RENAMED. The operator typed that name into Home
 *    Assistant on purpose; a Companion label is not authority over it. The only
 *    evidence is whether the current name is one the import would have produced
 *    from the OLD label — see importedCueNames, which covers the page-qualified
 *    spelling and a pair's `_on`/`_off` suffix.
 *  - THE NEW NAME IS THE ONE THE IMPORT WOULD GIVE IT NOW, disambiguation and
 *    all, from the same helper the import uses. Naming it any other way is two
 *    naming schemes, and the second one only ever appears after a rename.
 *  - A COLLISION KEEPS THE NAME. The target being taken — by another cue's name,
 *    by another cue's former name, or by another cue being renamed in this same
 *    pass — is the one case where renaming would silently move somebody else's
 *    Home Assistant switch onto this button.
 *  - A PAIR RENAMES TOGETHER OR NOT AT ALL. The switch in Home Assistant is the
 *    two halves' names; renaming one of them leaves a switch with no off, which
 *    is worse than a switch under the old name.
 *  - THE OLD NAME KEEPS ANSWERING, as an alias. The rename would otherwise break
 *    the HomeKit switch the household actually uses until somebody re-pastes the
 *    YAML.
 */
function renamePass(
  relabelled: readonly Relabelled[],
  cues: readonly CueIdentity[],
  buttons: readonly CompanionButton[],
): Map<string, Renamed> {
  const out = new Map<string, Renamed>();
  if (relabelled.length === 0) return out;

  const byRuleId = new Map(cues.map((c) => [c.ruleId, c]));
  /** Every name and former name in use, and which rule holds it. */
  const held = new Map<string, string>();
  for (const c of cues) {
    if (c.name) held.set(c.name, c.ruleId);
    for (const alias of c.aliases) if (!held.has(alias)) held.set(alias, c.ruleId);
  }
  const wouldBe = importedCues(buttons);

  // The candidates: a relabelled button whose cue was named after it and whose
  // new label yields a different, usable name.
  const candidates: Candidate[] = [];
  for (const r of relabelled) {
    const cue = byRuleId.get(r.ruleId);
    if (!cue?.name) continue;
    const target = wouldBe.get(`${r.button.page}:${r.button.row}:${r.button.col}`);
    if (!target?.slug || target.slug === cue.name) continue;
    if (!importedCueNames(r.was.label, r.button.pageName).includes(cue.name)) continue;
    candidates.push({ cue, was: r.was, button: r.button, slug: target.slug, pair: target.pair });
  }

  const claimed = new Set<string>();
  const done = new Set<string>();

  for (const candidate of candidates) {
    if (done.has(candidate.cue.ruleId)) continue;
    const half = pairHalfOf(candidate.cue.name);
    const partnerId = half ? held.get(`${half.base}_${half.other}`) : undefined;

    // Not half of a pair: its own name is all that is at stake.
    if (!half || !partnerId) {
      done.add(candidate.cue.ruleId);
      const taken = takenBy(candidate.slug, held, claimed, [candidate.cue.ruleId]);
      if (taken) {
        out.set(candidate.cue.ruleId, { patch: null, log: kept(candidate, `${candidate.slug} is taken`) });
        continue;
      }
      claimed.add(candidate.slug);
      out.set(candidate.cue.ruleId, renameTo(candidate, candidate.slug));
      continue;
    }

    // Half of a pair. Both halves rename, to matching names, or neither does.
    const partner = candidates.find((c) => c.cue.ruleId === partnerId);
    done.add(candidate.cue.ruleId);
    done.add(partnerId);
    const refuse = (why: string): void => {
      // ONE line for the pair, on the half the pass reached first: two lines
      // saying the same thing about one switch is a puzzle, not a warning.
      out.set(candidate.cue.ruleId, { patch: null, log: kept(candidate, why, true) });
      out.set(partnerId, { patch: null, log: null });
    };

    if (!partner) {
      const partnerName = byRuleId.get(partnerId)?.name ?? `${half.base}_${half.other}`;
      refuse(`its ${half.other.toUpperCase()} half ${partnerName} was not relabelled`);
      continue;
    }
    // Both halves must land on `<base>_on` and `<base>_off` of ONE base, or the
    // pair has stopped being a pair and renaming it would dissolve the switch.
    if (!candidate.pair || !partner.pair || candidate.pair.base !== partner.pair.base) {
      refuse(`${candidate.slug} and ${partner.slug} are no longer an ON/OFF pair`);
      continue;
    }
    const ids = [candidate.cue.ruleId, partnerId];
    const blocked =
      takenBy(candidate.slug, held, claimed, ids) ?? takenBy(partner.slug, held, claimed, ids);
    if (blocked) {
      refuse(`${blocked} is taken`);
      continue;
    }
    claimed.add(candidate.slug);
    claimed.add(partner.slug);
    out.set(candidate.cue.ruleId, renameTo(candidate, candidate.slug));
    out.set(partnerId, renameTo(partner, partner.slug));
  }

  return out;
}

/** A relabelled cue that could be renamed, with the name it would take. */
interface Candidate {
  cue: CueIdentity;
  was: ButtonFingerprint;
  button: CompanionButton;
  slug: string;
  pair: { base: string; half: PairHalf } | null;
}

/** `projectors_on` -> the pair's base and the other half's suffix, or null. */
function pairHalfOf(name: string): { base: string; other: PairHalf } | null {
  for (const [half, other] of [["on", "off"], ["off", "on"]] as const) {
    if (name.endsWith(`_${half}`)) {
      const base = name.slice(0, -`_${half}`.length);
      if (base) return { base, other };
    }
  }
  return null;
}

/** The name that blocks a rename onto `slug`, or null when it is free. */
function takenBy(
  slug: string,
  held: Map<string, string>,
  claimed: Set<string>,
  mine: readonly string[],
): string | null {
  const holder = held.get(slug);
  if (holder !== undefined && !mine.includes(holder)) return slug;
  if (claimed.has(slug)) return slug;
  return null;
}

/** The trigger params and the line for a rename that is going ahead. */
function renameTo(candidate: Candidate, slug: string): Renamed {
  const { cue, was, button } = candidate;
  const patch: Record<string, string | number> = {
    name: slug,
    aliases: encodeAliases(nextAliases(cue.aliases, cue.name, slug)),
  };
  // `says` FOLLOWS THE LABEL only when it WAS the label. An operator who typed
  // "the big screens" meant it, and a Companion relabel is not permission to
  // overwrite the words somebody says out loud.
  if (cue.says.trim() === was.label.trim()) patch.says = button.label;
  return {
    patch,
    log:
      `[companion] cue ${cue.name} renamed to ${slug} after its button's label changed; ` +
      `${cue.name} still answers`,
  };
}

/** The line for a rename that was refused. */
function kept(candidate: Candidate, why: string, pair = false): string {
  return (
    `[companion] cue ${candidate.cue.name}: label changed to "${candidate.button.label}" ` +
    `but ${why}; ${pair ? "both names kept" : "name kept"}`
  );
}

/** One press action's verdict. See the header for the three outcomes. */
interface Verdict {
  status: CueButtonStatus;
  /** The button it was matched to, or null when it is missing — what the rename
   *  pass reads the current label off. */
  found: CompanionButton | null;
  patch: Record<string, string | number>;
  log: string | null;
}

function decide(
  was: ButtonFingerprint,
  entry: PressEntry,
  byPageId: Map<string, { page: number; pageName: string; buttons: CompanionButton[] }>,
  nameByPageNum: Map<number, string>,
  nowIso: string,
): Verdict {
  const missing = (why: string): Verdict => ({
    status: "missing",
    // Nothing to rename against: a missing button's label is whatever it said
    // the last time anybody could see it.
    found: null,
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

  /**
   * The page this cue's fingerprint names is not in the export at all.
   *
   * Names NO page, deliberately. `was.page` is the number the page had when the
   * button was last seen, and pages renumber — so looking that number up in the
   * export names whatever page is there NOW, which is a different page. The line
   * read "button not found on page 3 (Room A: Lighting)" while the cue's button
   * had been on the cameras page, and an operator would go and look at the
   * lighting page.
   *
   * "no longer in the export" rather than "deleted": a page whose buttons have
   * all been removed has no pressable controls, so it is not in the parsed list
   * either, and this cannot tell the two apart.
   */
  const pageGone = (): string =>
    `button not found — page ${was.page}, as it was numbered then, is no longer in Companion's export`;

  // No page id: a rule created before the fingerprint existed, or written by
  // hand. ADOPTED at its own coordinates rather than refused — an upgrade must
  // not break every working cue on the box.
  if (!was.pageId) {
    const here = atCoordinates(byPageId, was);
    if (!here) return missing(notFoundHere(was.page));
    return {
      status: "in-place",
      found: here,
      patch: fingerprintParams(here, "in-place", nowIso),
      log: `[companion] cue ${entry.label}: adopted the button at p${here.page} ${shortLocation(here)} ("${here.label}")`,
    };
  }

  const page = byPageId.get(was.pageId);
  if (!page) return missing(pageGone());

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
      found: here,
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
          found: here,
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
    found: now,
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

/** One cue whose new status could not be written. */
export interface ReconcileFailure {
  ruleId: string;
  /** The cue name, or the rule's name when it is not a cue. */
  label: string;
  /** Why the save failed, scrubbed and ready to put in an answer. */
  detail: string;
}

/** The summary of one run, or null when Companion could not be read. */
export interface ReconcileRun {
  checked: number;
  applied: number;
  counts: Record<CueButtonStatus, number>;
  /**
   * The cues whose status could not be saved. Empty on a clean run.
   *
   * RETURNED, not only logged. A pass that caught its own write failures and
   * answered `ok: true` told the operator their buttons had been reconciled
   * while a read-only rules file meant nothing had been written — and the pill
   * on the row would still say what the last successful pass found, so there
   * was nothing on screen to notice.
   */
  failed: ReconcileFailure[];
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
  // Every cue in the engine, press action or not: the rename pass has to see
  // every name and former name that is already taken.
  const cues: CueIdentity[] = automationEngine.cueRules().map((r) => ({
    ruleId: r.id,
    name: automationEngine.cueNameOf(r),
    aliases: automationEngine.cueAliasesOf(r),
    says: String(r.trigger.params.says ?? ""),
  }));
  const { changes, counts, checked } = reconcileCues(pressEntries(rules), result.buttons, nowIso, cues);

  let applied = 0;
  const failed: ReconcileFailure[] = [];
  for (const change of changes) {
    // A refusal to rename has no patch and still has something to say.
    if (!change.patch && !change.triggerPatch) {
      if (change.renameLog) console.warn(scrub(change.renameLog, LOG_MAX));
      continue;
    }
    // RE-READ, immediately before the write, never from the snapshot above.
    // `rules` was taken before Companion was even dialled, and the write below
    // is `{ ...rule.action, params: { ...rule.action.params, ...patch } }` — so
    // every OTHER field of the action and the trigger goes back as it was when
    // the pass started. An operator who saved the rule while it ran (a `room`
    // typed in, a says edited, the action swapped for another) had that change
    // silently reverted by a housekeeping sweep they never asked for.
    const rule = automationEngine.listRules().find((r) => r.id === change.ruleId);
    if (!rule) {
      // Deleted while the pass was running. Not an error, but not silent
      // either: the log is where a status that never appeared is explained.
      console.warn(
        `[companion] cue ${scrub(change.label, LOG_MAX)}: deleted while reconciling; status not saved`,
      );
      continue;
    }
    try {
      // ONE save for both halves of what this pass decided about the rule. Two
      // updateRule calls would broadcast twice and could leave the name renamed
      // with the fingerprint unwritten.
      await automationEngine.updateRule(rule.id, {
        ...(change.patch
          ? { action: { ...rule.action, params: { ...rule.action.params, ...change.patch } } }
          : {}),
        ...(change.triggerPatch
          ? { trigger: { ...rule.trigger, params: { ...rule.trigger.params, ...change.triggerPatch } } }
          : {}),
      });
      applied++;
      // The barrier is HERE, at the console call, not inside the pure pass that
      // built the sentence: scrub() has to be visible at the log site or the
      // static scan cannot see it, and a value laundered through a helper is
      // exactly the shape log-injection.test.ts refuses. See scrub.ts.
      if (change.log) console.warn(scrub(change.log, LOG_MAX));
      if (change.renameLog) console.warn(scrub(change.renameLog, LOG_MAX));
    } catch (err) {
      // Rethrowing would abandon the rest of the rules over one of them, so this
      // COLLECTS the failure and carries on — and returns it, because a caller
      // that answered `ok: true` over a rules file it could not write is how a
      // failed save reads as saved. See ReconcileRun.failed.
      //
      // A literal format string with the values in an argument: a cue label can
      // contain a `%`, and `console.error(fmt, arg)` reads that as a format
      // specifier and eats the reason after it.
      //
      // scrub() is spelled out AT THE LOG SITE, not hoisted into the variable
      // above it. The barrier has to be visible where the value reaches the
      // console or log-injection.test.ts cannot see it, and a value laundered
      // through a helper or a local is exactly the shape that scan refuses. It
      // caught this being hoisted. See scrub.ts.
      // The RETURNED detail is the message; the LOGGED one is the stack.
      // `failed` goes into an HTTP body on a LAN-visible endpoint and into a
      // toast, and driving this against a read-only data directory put four
      // lines of absolute filesystem paths in both. The stack belongs in the
      // log, where an operator debugging at 9am wants it.
      const detail = scrubError(err);
      failed.push({
        ruleId: change.ruleId,
        label: change.label,
        detail: scrub(errorMessage(err), LOG_MAX),
      });
      console.error(
        "[companion] could not record a button status:",
        scrub(change.label),
        scrub(detail, LOG_MAX),
      );
    }
  }

  // Only when something HAPPENED. This runs hourly and logs to the same /log
  // page an operator reads on a Sunday morning, so a summary of a pass that
  // changed nothing is 24 lines a day burying the ones that matter. Every
  // actual decision already has its own line above; this one exists to give
  // those a total.
  if (applied > 0 || failed.length > 0) {
    console.log(
      `[companion] reconciled ${scrub(checked)} cues: ${scrub(counts["in-place"])} in place, ` +
        `${scrub(counts.moved)} moved, ${scrub(counts.missing)} missing`,
    );
  }
  return { checked, applied, counts, failed };
}

/** Hourly. Long enough that a Companion being edited settles, short enough that
 *  a button moved on Thursday is amber before Sunday. */
export const RECONCILE_EVERY_MS = 60 * 60 * 1000;

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

/**
 * Disarm it. Exported for the test that checks the lifecycle, and because
 * "start(false)" is a strange way for anything else to say "stop".
 */
export function stopCompanionReconcile(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
