// pco-prep-tags.ts — what Planning Center says a person brings to a mic slot.
//
// Stage crew tag people in Planning Center with a person tag named
// "Capsule: <model>" or "IEMs: Own". The slot card shows the capsule on a plate
// and a small ears badge for a person in their own in-ears, so the one on stage
// gets the right capsule on the right mic without anyone reading a spreadsheet.
//
// Two halves:
//
//   - the PURE half, below: parse a tag's name, and fold "which people carry
//     which tag" into one Map keyed by person id. No I/O, so every odd value has
//     a test.
//   - PrepTagBook: holds the last good Map, retries a failed read on a floor,
//     and says what it did on a tagged line. Best-effort by design, like
//     PersonDirectory: Planning Center being unreachable must never blank a slot,
//     so a failed read keeps the last good Map and is logged, once per outage.

import type { PrepTags } from "../types/pco.js";
import { errorMessage } from "./errors.js";
import { RepeatLog } from "./repeat-log.js";
import { scrub } from "./scrub.js";

/** "Capsule: KSM9", "IEMs: Own", "iem : own". Anything else is not a prep tag. */
const PREP_TAG = /^\s*(capsule|iems?)\s*:\s*(.+?)\s*$/i;

export interface ParsedPrepTag {
  kind: "capsule" | "iems";
  value: string;
}

/** The parts of a tag name, or null when it is not a prep tag. */
export function parsePrepTagName(name: string): ParsedPrepTag | null {
  const m = PREP_TAG.exec(name);
  // `(.+?)` can settle on a single space when the name is only blank after the
  // colon, so an empty value is refused here rather than trusted to the pattern.
  if (!m || m[2].trim() === "") return null;
  return { kind: m[1].toLowerCase() === "capsule" ? "capsule" : "iems", value: m[2] };
}

/** One prep tag as read from Planning Center: its name, and who carries it. */
export interface TaggedPeople {
  tagName: string;
  personIds: string[];
}

export interface PrepTagResult {
  map: Map<string, PrepTags>;
  /** Tags whose name matched the prep pattern and so had their people read. */
  tagCount: number;
  /** `IEMs:` values other than "Own", ignored; first spelling seen per value. */
  unknownIemValues: string[];
  /** A person carrying more than one capsule: the one kept and the ones ignored. */
  duplicateCapsules: { personId: string; kept: string; ignored: string[] }[];
}

/** Fold tags-with-people into a map by person. Pure. */
export function buildPrepMap(tagged: TaggedPeople[]): PrepTagResult {
  const capsules = new Map<string, Map<string, string>>(); // person -> lowercase value -> spelling
  const ownIems = new Set<string>();
  const unknown = new Map<string, string>(); // lowercase value -> spelling
  let tagCount = 0;

  for (const { tagName, personIds } of tagged) {
    const tag = parsePrepTagName(tagName);
    if (!tag) continue;
    tagCount++;
    if (tag.kind === "iems") {
      if (tag.value.toLowerCase() === "own") {
        for (const id of personIds) ownIems.add(id);
      } else if (!unknown.has(tag.value.toLowerCase())) {
        unknown.set(tag.value.toLowerCase(), tag.value);
      }
      continue;
    }
    for (const id of personIds) {
      let mine = capsules.get(id);
      if (!mine) capsules.set(id, (mine = new Map()));
      if (!mine.has(tag.value.toLowerCase())) mine.set(tag.value.toLowerCase(), tag.value);
    }
  }

  const map = new Map<string, PrepTags>();
  const duplicateCapsules: PrepTagResult["duplicateCapsules"] = [];
  for (const [personId, byValue] of capsules) {
    // First alphabetically, case-insensitively, so the same person gets the same
    // capsule on every read whatever order Planning Center listed the tags in.
    const sorted = [...byValue.keys()].sort();
    const kept = byValue.get(sorted[0])!;
    if (sorted.length > 1) {
      duplicateCapsules.push({ personId, kept, ignored: sorted.slice(1).map((k) => byValue.get(k)!) });
    }
    map.set(personId, { capsule: kept, ownIems: ownIems.has(personId) });
  }
  for (const personId of ownIems) {
    if (!map.has(personId)) map.set(personId, { capsule: null, ownIems: true });
  }

  return { map, tagCount, unknownIemValues: [...unknown.values()], duplicateCapsules };
}

/** Retry a failed read no sooner than this. The roster tick asks every minute. */
export const PREP_RETRY_MS = 5 * 60_000;

export class PrepTagBook {
  private current: ReadonlyMap<string, PrepTags> = new Map();
  /** What the last good read looked like, so an unchanged read stays silent. */
  private lastSignature: string | null = null;
  private failedAt: number | null = null;
  private readonly failures = new RepeatLog("[pco-tags] read failed:");
  private readonly loggedUnknown = new Set<string>();
  private readonly loggedDuplicates = new Set<string>();
  private generation = 0;

  constructor(
    /** Reads every tagged person. Throws on failure. Null itself when there are
     *  no PCO credentials, so nothing is asked. */
    private readonly read: () => (() => Promise<TaggedPeople[]>) | null,
    private readonly now: () => number = Date.now,
  ) {}

  /** The last good map. Empty until a read succeeds. */
  get map(): ReadonlyMap<string, PrepTags> {
    return this.current;
  }

  /**
   * Read the tags (the service caches on its LONG tier, so this is cheap to call
   * often). Resolves to whether the map CHANGED, so the caller knows to re-resolve,
   * and whether the read FAILED. A failure is logged once per outage and the last
   * good map stays: nothing is thrown at a caller that would blank a slot.
   */
  async refresh(): Promise<{ changed: boolean; failed: boolean }> {
    const read = this.read();
    if (!read) return { changed: false, failed: false };
    if (this.failedAt !== null && this.now() - this.failedAt < PREP_RETRY_MS) {
      return { changed: false, failed: true };
    }
    const generation = this.generation;
    let tagged: TaggedPeople[];
    try {
      tagged = await read();
    } catch (err) {
      if (generation !== this.generation) return { changed: false, failed: false };
      this.failedAt = this.now();
      const d = this.failures.fail(errorMessage(err), this.now());
      if (d.line) console.error(scrub(d.line));
      return { changed: false, failed: true };
    }
    if (generation !== this.generation) return { changed: false, failed: false };
    this.failedAt = null;
    const recovered = this.failures.ok(this.now());
    if (recovered.line) console.info(scrub(recovered.line));

    const result = buildPrepMap(tagged);
    for (const value of result.unknownIemValues) {
      if (this.loggedUnknown.has(value.toLowerCase())) continue;
      this.loggedUnknown.add(value.toLowerCase());
      console.warn(`[pco-tags] ignoring the IEMs tag value ${scrub(value)}; only "Own" is read`);
    }
    for (const d of result.duplicateCapsules) {
      const key = `${d.personId}:${d.kept}:${d.ignored.join("|")}`.toLowerCase();
      if (this.loggedDuplicates.has(key)) continue;
      this.loggedDuplicates.add(key);
      console.warn(
        `[pco-tags] person ${scrub(d.personId)} has more than one capsule tag; using ${scrub(d.kept)}, ignoring ${scrub(d.ignored.join(", "))}`,
      );
    }

    const signature = JSON.stringify([...result.map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    if (signature === this.lastSignature) return { changed: false, failed: false };
    this.lastSignature = signature;
    this.current = result.map;
    console.log(`[pco-tags] read ${scrub(result.map.size)} tagged people from ${scrub(result.tagCount)} tags`);
    return { changed: true, failed: false };
  }

  /** The credentials changed: every answer may differ. */
  reset(): void {
    this.generation++;
    this.current = new Map();
    this.lastSignature = null;
    this.failedAt = null;
  }
}
