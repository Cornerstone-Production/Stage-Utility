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
// The allowlist exports and imports as its own file, never inside a view
// bundle: it is safety policy, reviewed on its own.

import { DataStore } from "../data-store.js";
import { errorMessage } from "../errors.js";
import { isRecord } from "../is-record.js";
import { asObject, checked } from "../restore-check.js";
import { scrub } from "../scrub.js";
import { addressKey } from "../../types/qsys.js";
import type { QrcControl } from "./qrc-types.js";

export interface AllowEntry {
  component: string;
  control: string;
  label: string;
  /** The value limits enforced on a numeric write; both null when no range is set. */
  min: number | null;
  max: number | null;
  /** `hold`: every object bound to it asks for hold-to-confirm. */
  confirm: "none" | "hold";
}

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

// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * A Code Name or control name a request may name: 1 to 256 characters, no control
 * characters. NUL in particular: addressKey joins the two halves with it, so a NUL
 * inside either half could make two different addresses share a key.
 */
export function isAddressPart(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_NAME && !CONTROL_CHARS.test(v);
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
    if (typeof e.label !== "string" || e.label.length > MAX_LABEL || CONTROL_CHARS.test(e.label)) {
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

/**
 * A file the validator would refuse (edited by hand, or written by a build with
 * other rules) is enforced as an empty list: nothing writable, failing closed.
 * The file itself is left as it is until the next save, and the reason is logged.
 */
function normalize(parsed: { entries: AllowEntry[] }): { entries: AllowEntry[] } {
  try {
    return { entries: parseAllowEntries(isRecord(parsed) ? parsed.entries : undefined) };
  } catch (err) {
    console.warn(`[qsys] qsys-allowlist.json is not a valid allowlist (${scrub(errorMessage(err))}); nothing is writable until it is saved again`);
    return { entries: [] };
  }
}

const store = new DataStore<{ entries: AllowEntry[] }>("qsys-allowlist.json", { entries: [] }, "config", { restoreCheck, normalize });

/** The lookup, built from the object the store last loaded. A new object (a save,
 *  or a reload after a restore) rebuilds it, so it never enforces an old list. */
let indexed: { from: { entries: AllowEntry[] }; byKey: Map<string, AllowEntry> } | null = null;

async function save(entries: AllowEntry[], how: string): Promise<AllowEntry[]> {
  await store.save({ entries });
  console.log(`[qsys] allowlist ${scrub(how)}: ${scrub(entries.length)} entries`);
  return entries;
}

/** Run a validation; a refusal is logged and rethrown. */
function validated(how: string, fn: () => AllowEntry[]): AllowEntry[] {
  try {
    return fn();
  } catch (err) {
    if (err instanceof AllowlistRefused) console.warn(`[qsys] allowlist ${scrub(how)} refused: ${scrub(err.message)}`);
    throw err;
  }
}

export const qsysAllowlist = {
  async list(): Promise<AllowEntry[]> {
    return (await store.load()).entries;
  },

  /** The entry for an address, or undefined when it is not writable. */
  async lookup(component: string, control: string): Promise<AllowEntry | undefined> {
    const data = await store.load();
    if (indexed?.from !== data) {
      indexed = { from: data, byKey: new Map(data.entries.map((e) => [addressKey(e), e])) };
    }
    return indexed.byKey.get(addressKey({ component, control }));
  },

  /** Replace the whole list. Throws AllowlistRefused, having saved nothing, when any entry breaks a rule. */
  async replace(raw: unknown): Promise<AllowEntry[]> {
    return save(validated("save", () => parseAllowEntries(raw)), "saved");
  },

  async exportFile(): Promise<AllowlistFile> {
    return { format: ALLOWLIST_FILE_FORMAT, version: ALLOWLIST_FILE_VERSION, entries: await this.list() };
  },

  /** Replace the list from an allowlist file. A malformed file is refused whole and the old list kept. */
  async importFile(raw: unknown): Promise<AllowEntry[]> {
    return save(validated("import", () => parseAllowlistFile(raw)), "imported");
  },
};
