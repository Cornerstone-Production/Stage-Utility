// qsys-allowlist-store.ts — the Q-SYS controls a panel may write, and their limits.
//
// Nothing is writable by default. An entry's min/max are the limits the server
// enforces on a numeric write; a control added from the catalog starts with the
// Core's own range (ValueMin/ValueMax), and one the Core reports no range for
// starts with none, which leaves it unwritable for numbers until one is set.
//
// One validator, parseAllowEntries, serves every way a list gets in: PUT
// /api/qsys/allowlist, an allowlist file import, and a config restore (the
// store's restoreCheck). A list that breaks any rule is refused whole; the
// stored list is untouched.
//
// A stored file the validator refuses (edited by hand, or written by a build
// with other rules) is enforced as an empty list, and is never silently
// overwritten: a save over it is refused (AllowlistStoredInvalid) unless the
// request says it replaces the invalid file, and then the file is kept beside
// as qsys-allowlist.json.invalid-<time> first.
//
// The allowlist exports and imports as its own file, never inside a view
// bundle: it is safety policy, reviewed on its own.

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getUserDataPath } from "../app-paths.js";
import { DataStore } from "../data-store.js";
import { errorMessage } from "../errors.js";
import { isRecord } from "../../types/is-record.js";
import { asObject, checked } from "../restore-check.js";
import { hasControlChars, scrub } from "../scrub.js";
import { WriteQueue } from "../write-queue.js";
import { addressKey, type AllowEntry } from "../../types/qsys.js";
import type { QrcControl } from "./qrc-types.js";

export type { AllowEntry };

/** What an allowlist file says it is. */
export const ALLOWLIST_FILE_FORMAT = "stage-utility-qsys-allowlist";
export const ALLOWLIST_FILE_VERSION = 1;

export interface AllowlistFile {
  format: typeof ALLOWLIST_FILE_FORMAT;
  version: typeof ALLOWLIST_FILE_VERSION;
  entries: AllowEntry[];
}

export const MAX_ALLOW_ENTRIES = 1000;
const MAX_NAME = 256;
const MAX_LABEL = 120;

/** A list, or a single entry, that breaks a rule. The message says which and why. */
export class AllowlistRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AllowlistRefused";
  }
}

/** A save refused because the stored file is invalid and the request did not say it replaces it. */
export class AllowlistStoredInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AllowlistStoredInvalid";
  }
}

/** Text a request may store as one line: up to `max` characters, none a log line would have to escape. */
export function isLine(v: unknown, max: number): v is string {
  return typeof v === "string" && v.length <= max && !hasControlChars(v);
}

/**
 * A Code Name or control name a request may name: 1 to 256 characters, no control
 * characters. NUL in particular: addressKey joins the two halves with it, so a NUL
 * inside either half could make two different addresses share a key.
 */
export function isAddressPart(v: unknown): v is string {
  return isLine(v, MAX_NAME) && v.length > 0;
}

function refuse(message: string): never {
  throw new AllowlistRefused(message);
}

function limit(v: unknown, what: string): number | null {
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) refuse(`${what} must be a number or null`);
  return v;
}

/** Validate a whole list. Throws AllowlistRefused naming the first entry and field that break a rule. */
export function parseAllowEntries(raw: unknown): AllowEntry[] {
  if (!Array.isArray(raw)) refuse("entries must be a list");
  if (raw.length > MAX_ALLOW_ENTRIES) refuse(`the allowlist holds at most ${MAX_ALLOW_ENTRIES} entries`);
  const seen = new Set<string>();
  return raw.map((e, i) => {
    const at = `entry ${i + 1}`;
    if (!isRecord(e)) refuse(`${at} must be an object`);
    if (!isAddressPart(e.component)) refuse(`${at}: component must be 1 to ${MAX_NAME} characters with no control characters`);
    if (!isAddressPart(e.control)) refuse(`${at}: control must be 1 to ${MAX_NAME} characters with no control characters`);
    if (!isLine(e.label, MAX_LABEL)) {
      refuse(`${at}: label must be text of up to ${MAX_LABEL} characters on one line`);
    }
    const min = limit(e.min, `${at}: min`);
    const max = limit(e.max, `${at}: max`);
    if ((min === null) !== (max === null)) refuse(`${at}: min and max must both be set or both be null`);
    if (min !== null && max !== null && min > max) refuse(`${at}: min must not be above max`);
    if (e.confirm !== "none" && e.confirm !== "hold") refuse(`${at}: confirm must be "none" or "hold"`);
    const key = addressKey({ component: e.component, control: e.control });
    if (seen.has(key)) refuse(`${at}: ${e.component}/${e.control} is listed twice`);
    seen.add(key);
    return { component: e.component, control: e.control, label: e.label.trim(), min, max, confirm: e.confirm };
  });
}

/** Validate an allowlist file: its format marker, its version, then its entries. */
export function parseAllowlistFile(raw: unknown): AllowEntry[] {
  if (!isRecord(raw)) refuse("an allowlist file must be a JSON object");
  if (raw.format !== ALLOWLIST_FILE_FORMAT) refuse("this is not a Q-SYS allowlist file");
  if (raw.version !== ALLOWLIST_FILE_VERSION) refuse(`this allowlist file is version ${scrub(raw.version)}; this server reads version ${ALLOWLIST_FILE_VERSION}`);
  return parseAllowEntries(raw.entries);
}

/**
 * The entry a control gets when it is added from the catalog: the Core's own range
 * as its limits (null when the Core reports none, or only half of one), no confirm.
 */
export function allowEntryFromCatalog(c: QrcControl, component: string): AllowEntry {
  const ranged = Number.isFinite(c.ValueMin) && Number.isFinite(c.ValueMax) && c.ValueMin! <= c.ValueMax!;
  return {
    component,
    control: c.Name,
    label: `${component} ${c.Name}`.slice(0, MAX_LABEL),
    min: ranged ? c.ValueMin! : null,
    max: ranged ? c.ValueMax! : null,
    confirm: "none",
  };
}

const restoreCheck = checked((raw) => ({ entries: parseAllowEntries(asObject(raw, "the Q-SYS allowlist").entries) }));

const FILE = "qsys-allowlist.json";

/** Why the list a load produced came from an invalid file; absent for a valid one. */
const invalidReason = new WeakMap<object, string>();

/**
 * A file the validator would refuse is enforced as an empty list: nothing
 * writable, failing closed. The reason is logged and kept with the list, so the
 * page can say so and a save over the file is refused (see replace()).
 */
function normalize(parsed: { entries: AllowEntry[] }): { entries: AllowEntry[] } {
  try {
    return { entries: parseAllowEntries(isRecord(parsed) ? parsed.entries : undefined) };
  } catch (err) {
    const reason = errorMessage(err);
    console.warn(`[qsys] qsys-allowlist.json is not a valid allowlist (${scrub(reason)}); nothing is writable, and it is kept until a save says it replaces it`);
    const empty = { entries: [] };
    invalidReason.set(empty, reason);
    return empty;
  }
}

const store = new DataStore<{ entries: AllowEntry[] }>(FILE, { entries: [] }, "config", { restoreCheck, normalize });

/** The lookup, built from the object the store last loaded. A new object (a save,
 *  or a reload after a restore) rebuilds it, so it never enforces an old list. */
let indexed: { from: { entries: AllowEntry[] }; byKey: Map<string, AllowEntry> } | null = null;

/** What GET /api/qsys/allowlist says about an invalid stored file. */
export function invalidPhrase(reason: string): string {
  return `the stored allowlist is not valid (${reason}), so nothing is writable; it is kept until a save replaces it`;
}

/** A list as saved, and its revision. */
export type Saved = { entries: AllowEntry[]; rev: string };

/** A save that named the revision it read, when the list has moved on since. 409. */
export class AllowlistRevChanged extends Error {}

/**
 * The stored list's revision: a hash of what is enforced (the entries, and whether
 * the stored file is invalid). A page sends back the one it read; a save over
 * anything else is refused, so no one's edit is overwritten unseen.
 */
function revOf(data: { entries: AllowEntry[] }): string {
  const reason = invalidReason.get(data) ?? null;
  return createHash("sha256").update(JSON.stringify([data.entries, reason])).digest("hex").slice(0, 16);
}

/** One change to the list at a time, read to save: the revision check holds across it. */
const queue = new WriteQueue();

/** How a save or an import may go: over an invalid stored file, and only over a revision. */
export interface ChangeOptions {
  replaceInvalid?: boolean;
  expectRev?: string;
}

/**
 * Validate with `parse` and save, in the queue. A refusal is logged and rethrown,
 * having saved nothing. Over an invalid stored file it is refused unless
 * `replaceInvalid`, and then that file is copied beside first; a copy that fails
 * refuses the save. With `expectRev`, refused (AllowlistRevChanged) unless the
 * stored list is still at that revision, checked in the same step as the save.
 */
function accept(how: "save" | "import", parse: () => AllowEntry[], { replaceInvalid = false, expectRev }: ChangeOptions): Promise<Saved> {
  return queue.enqueue(async () => {
    try {
      const entries = parse();
      const current = await store.load();
      if (expectRev !== undefined && expectRev !== revOf(current)) {
        throw new AllowlistRevChanged("the allowlist was changed since this list was read; read it again and make the change on that");
      }
      const reason = invalidReason.get(current);
      if (reason !== undefined) {
        if (!replaceInvalid) {
          throw new AllowlistStoredInvalid(`${invalidPhrase(reason)}. Send replaceInvalid: true to replace it; the invalid file is kept beside it`);
        }
        const dir = getUserDataPath();
        const kept = `${FILE}.invalid-${Date.now()}`;
        await fs.copyFile(path.join(dir, FILE), path.join(dir, kept), fs.constants.COPYFILE_EXCL);
        console.log(`[qsys] kept the invalid allowlist as ${scrub(kept)} before replacing it`);
      }
      await store.save({ entries });
      console.log(`[qsys] allowlist ${scrub(how === "save" ? "saved" : "imported")}: ${scrub(entries.length)} entries`);
      // The revision of what was saved, read inside the step: the one a page sends next.
      return { entries, rev: revOf(await store.load()) };
    } catch (err) {
      console.warn(`[qsys] allowlist ${scrub(how)} refused: ${scrub(errorMessage(err))}`);
      throw err;
    }
  });
}


/** addMissing's work, inside the serial step. */
async function addMissingNow(candidates: AllowEntry[]): Promise<Saved & { added: AllowEntry[] }> {
  let added: AllowEntry[] = [];
  try {
    const next = await store.update((current) => {
      const reason = invalidReason.get(current);
      if (reason !== undefined) throw new AllowlistStoredInvalid(`${invalidPhrase(reason)}. Replace it with a save or an import first`);
      const have = new Set(current.entries.map(addressKey));
      added = candidates.filter((c) => {
        const k = addressKey(c);
        if (have.has(k)) return false;
        have.add(k);
        return true;
      });
      // The same object back: nothing to add, and nothing written.
      return added.length === 0 ? current : { entries: parseAllowEntries([...current.entries, ...added]) };
    });
    if (added.length > 0) console.log(`[qsys] allowlist: added ${scrub(added.length)} control(s) a panel uses, at the Core's own ranges`);
    return { entries: next.entries, added, rev: revOf(next) };
  } catch (err) {
    console.warn(`[qsys] allowlist add refused: ${scrub(errorMessage(err))}`);
    throw err;
  }
}

export const qsysAllowlist = {
  async list(): Promise<AllowEntry[]> {
    return (await store.load()).entries;
  },

  /** The list, why the stored file is refused (null while it is valid), and its revision. */
  async state(): Promise<{ entries: AllowEntry[]; invalid: string | null; rev: string }> {
    const data = await store.load();
    const reason = invalidReason.get(data);
    return { entries: data.entries, invalid: reason === undefined ? null : invalidPhrase(reason), rev: revOf(data) };
  },


  /** The entry for an address, or undefined when it is not writable. */
  async lookup(component: string, control: string): Promise<AllowEntry | undefined> {
    const data = await store.load();
    if (indexed?.from !== data) {
      indexed = { from: data, byKey: new Map(data.entries.map((e) => [addressKey(e), e])) };
    }
    return indexed.byKey.get(addressKey({ component, control }));
  },

  /**
   * Replace the whole list; answers it as saved, and its revision. Throws
   * AllowlistRefused, having saved nothing, when any entry breaks a rule,
   * AllowlistStoredInvalid over an invalid stored file unless `replaceInvalid`, and
   * AllowlistRevChanged when `expectRev` is not the stored list's revision.
   */
  replace(raw: unknown, opts: ChangeOptions = {}): Promise<Saved> {
    return accept("save", () => parseAllowEntries(raw), opts);
  },

  /**
   * Add each of `candidates` whose address is not on the list yet, as one atomic
   * read-modify-write. An entry already listed is never touched, so limits set by
   * hand stay as they are. Over an invalid stored file it is refused
   * (AllowlistStoredInvalid), and a list that would break a rule is refused whole
   * (AllowlistRefused); either saves nothing. Returns the list and what was added.
   */
  addMissing(candidates: AllowEntry[]): Promise<Saved & { added: AllowEntry[] }> {
    return queue.enqueue(() => addMissingNow(candidates));
  },

  /** Told after every save that landed (a save, an import, a restore). */
  onSaved(listener: () => void): void {
    store.onSaved(() => listener());
  },

  async exportFile(): Promise<AllowlistFile> {
    return { format: ALLOWLIST_FILE_FORMAT, version: ALLOWLIST_FILE_VERSION, entries: await this.list() };
  },

  /** Replace the list from an allowlist file. A malformed file is refused whole and the old list kept; otherwise as replace(). */
  importFile(raw: unknown, opts: ChangeOptions = {}): Promise<Saved> {
    return accept("import", () => parseAllowlistFile(raw), opts);
  },
};
