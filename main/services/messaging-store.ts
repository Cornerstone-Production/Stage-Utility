// messaging-store.ts — the groups, quick messages and quick replies an operator
// sets up for stage messages.
//
// Operator config, so "config": somebody typed these, one at a time, and losing
// them to a reinstall is losing their work. Being config is also what puts the
// file in every backup — the snapshot allowlist is derived from the
// classification. The messages themselves are the opposite, an observation of
// one day, and live in messages-store.ts.
//
// Group ids are generated HERE and nowhere else. A screen's `Output.groups`
// names them, so they are permanent: renaming a group changes its `name` and
// nothing that points at it. An id off the wire is checked against GROUP_ID and
// then against the groups that exist, and is never used as a property name —
// every lookup below goes through a Map.

import { randomBytes } from "node:crypto";

import {
  DEFAULT_QUICK_MESSAGES,
  DEFAULT_QUICK_REPLIES,
  EVERYONE,
  GROUP_ID,
  GROUPS_MAX,
  GROUP_NAME_MAX,
  MESSAGE_MAX,
  QUICK_MESSAGES_MAX,
  QUICK_REPLIES_MAX,
  QUICK_REPLY_MAX,
  type MessageGroup,
  type MessagingConfig,
} from "../types/messages.js";
import { DataStore } from "./data-store.js";
import { MessageRefused, checkedText } from "./message-rules.js";
import { plural } from "./plural.js";
import { scrub } from "./scrub.js";

/**
 * The config this was based on is not the stored one any more: another window
 * saved first. Routes answer it 409; nothing was changed.
 */
export class MessagingConflict extends Error {
  constructor() {
    super("The groups and quick messages were changed in another window. Reload and try again.");
    this.name = "MessagingConflict";
  }
}

function defaults(): MessagingConfig {
  return {
    version: 0,
    groups: [],
    quickMessages: [...DEFAULT_QUICK_MESSAGES],
    quickReplies: [...DEFAULT_QUICK_REPLIES],
  };
}

function copyOf(config: MessagingConfig): MessagingConfig {
  return {
    version: config.version,
    groups: config.groups.map((g) => ({ id: g.id, name: g.name })),
    quickMessages: [...config.quickMessages],
    quickReplies: [...config.quickReplies],
  };
}

// ── The rules, once ───────────────────────────────────────────────────────
//
// Each checks ONE entry and throws MessageRefused naming what is wrong with it.
// A PUT lets the first one propagate; reading the file catches it per entry and
// leaves that entry out, so /log says the same thing the operator would have been
// told. They only read the sets they are given: the caller adds an entry's name
// and id once every check on it has passed, so a refused entry claims nothing.

/** A group's name, against the lower-cased names the groups before it hold. */
function checkedGroupName(raw: unknown, seen: ReadonlySet<string>): string {
  const name = checkedText(raw, "a group name", GROUP_NAME_MAX);
  const key = name.toLowerCase();
  if (key === EVERYONE) throw new MessageRefused(`"${name}" is built in; pick another group name`);
  if (seen.has(key)) throw new MessageRefused(`two groups are named "${name}" (names are not case-sensitive)`);
  return name;
}

/** A group's id, as the server issues them, against the ids the groups before it hold. */
function checkedGroupId(raw: unknown, seen: ReadonlySet<string>): string {
  if (typeof raw !== "string" || !GROUP_ID.test(raw)) throw new MessageRefused("a group id is not one this app issued");
  if (seen.has(raw)) throw new MessageRefused(`the group id ${raw} appears twice`);
  return raw;
}

function groupRow(entry: unknown): { id?: unknown; name?: unknown } {
  if (entry === null || typeof entry !== "object") throw new MessageRefused("every group must be { name } or { id, name }");
  return entry as { id?: unknown; name?: unknown };
}

/** Run `check`; what it returns, or the reason it refused. Anything but a refusal is a bug and propagates. */
function attempt<T>(check: () => T): { value: T } | { why: string } {
  try {
    return { value: check() };
  } catch (err) {
    if (err instanceof MessageRefused) return { why: err.message };
    throw err;
  }
}

/**
 * Read what a file held, total: it runs on whatever `messaging.json` contains,
 * including a hand edit or a restore from a build with other limits.
 *
 * An entry that breaks a rule is left out of the live config and named on /log
 * with the rule it broke, not repaired into something the operator did not write.
 * The file keeps it until the next save.
 *
 * Sets `readClean` only when the file gave the groups back whole: an object whose
 * `groups` is a list, with no entry left out. Anything else, and a file that was
 * missing or would not parse (which never reaches here), leaves it false.
 */
function readFile(parsed: unknown): MessagingConfig {
  const out = defaults();
  const skipped: string[] = [];
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.warn("[messages] messaging.json is not an object; using the defaults");
    return out;
  }
  const raw = parsed as Record<string, unknown>;
  if (typeof raw.version === "number" && Number.isSafeInteger(raw.version) && raw.version > 0) out.version = raw.version;

  // A field that is there but is not a list is named, like any other bad shape.
  // Absent is fine: it is what a file written before the field existed holds.
  const notAList = (field: string) => {
    if (raw[field] !== undefined && !Array.isArray(raw[field])) skipped.push(`${field}: not a list`);
  };
  notAList("groups");
  notAList("quickMessages");
  notAList("quickReplies");

  if (Array.isArray(raw.groups)) {
    const ids = new Set<string>();
    const names = new Set<string>();
    out.groups = [];
    for (const entry of raw.groups) {
      const result = attempt((): MessageGroup => {
        if (out.groups.length >= GROUPS_MAX) throw new MessageRefused(`groups can hold at most ${GROUPS_MAX}`);
        const row = groupRow(entry);
        return { id: checkedGroupId(row.id, ids), name: checkedGroupName(row.name, names) };
      });
      if ("why" in result) {
        const row = entry as { id?: unknown; name?: unknown } | null;
        const label = typeof row?.name === "string" && row.name.trim() !== "" ? row.name.trim() : row?.id;
        skipped.push(`group ${scrub(label, 40)}: ${result.why}`);
        continue;
      }
      ids.add(result.value.id);
      names.add(result.value.name.toLowerCase());
      out.groups.push(result.value);
    }
  }
  const list = (value: unknown, fallback: string[], max: number, each: number, what: string, whats: string): string[] => {
    if (!Array.isArray(value)) return fallback;
    const kept: string[] = [];
    for (const entry of value) {
      const result = attempt(() => {
        if (kept.length >= max) throw new MessageRefused(`${whats} can hold at most ${max}`);
        return checkedText(entry, `a ${what}`, each);
      });
      if ("why" in result) {
        skipped.push(`${what} ${scrub(typeof entry === "string" ? entry.trim() : entry, 40)}: ${result.why}`);
        continue;
      }
      kept.push(result.value);
    }
    return kept;
  };
  out.quickMessages = list(raw.quickMessages, out.quickMessages, QUICK_MESSAGES_MAX, MESSAGE_MAX, "quick message", "quick messages");
  out.quickReplies = list(raw.quickReplies, out.quickReplies, QUICK_REPLIES_MAX, QUICK_REPLY_MAX, "quick reply", "quick replies");

  if (skipped.length > 0) {
    console.warn(
      `[messages] messaging.json: left out ${scrub(plural(skipped.length, "entry", "entries"))} that break a rule: ${scrub(skipped.join(", "), 600)}`,
    );
  }
  readClean = skipped.length === 0 && Array.isArray(raw.groups);
  return out;
}

/**
 * Whether the config in memory is what messaging.json held, whole: the file was
 * there, parsed, and gave the groups back with nothing left out; or a save in this
 * process has since put a valid config on disk. False after a file that is
 * missing, would not parse, was not an object, or lost entries. Set by readFile,
 * which a missing or unparseable file never reaches.
 */
let readClean = false;

const store = new DataStore<MessagingConfig>("messaging.json", defaults(), "config", { normalize: readFile });

/**
 * What get() answers, synchronously. DataStore holds the truth and serialises the
 * writes; this is the copy the rest of the app can read without awaiting. It is
 * set when a replace lands, so a write that fails never shows.
 */
let mirror: MessagingConfig | null = null;

function adopt(config: MessagingConfig): void {
  mirror = copyOf(config);
  // The operator's own save, validated: whatever the file was before, this is it.
  readClean = true;
}

function newGroupId(taken: ReadonlySet<string>): string {
  for (;;) {
    const id = `g-${randomBytes(4).toString("hex")}`;
    if (!taken.has(id)) return id;
  }
}

function asList(value: unknown, field: string, max: number): unknown[] {
  if (!Array.isArray(value)) throw new MessageRefused(`${field} (array) is required`);
  if (value.length > max) throw new MessageRefused(`${field} can hold at most ${max} (this has ${value.length})`);
  return value;
}

/**
 * The strict reading of a body, for PUT. Throws MessageRefused naming the
 * first thing wrong, or MessagingConflict when it was built from another version;
 * returns the config to store.
 *
 * `current` is the config as it stands: a group in the body that carries an id
 * must be one of its groups. Ids are the server's to hand out, so a well-formed id
 * nobody issued is refused rather than taken — otherwise a stale page could
 * bring a deleted group back under its old id.
 */
function validate(input: unknown, current: MessagingConfig): MessagingConfig {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new MessageRefused("body must be { version, groups, quickMessages, quickReplies }");
  }
  const body = input as Record<string, unknown>;
  // First, before any other rule: a body built from an older config is stale
  // whatever else is wrong with it, and "reload" is the answer that helps.
  if (typeof body.version !== "number") {
    throw new MessageRefused("version (number) is required: send the version the config was read at");
  }
  if (body.version !== current.version) throw new MessagingConflict();
  const known = new Set(current.groups.map((g) => g.id));
  const taken = new Set(known);
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();

  const groups: MessageGroup[] = asList(body.groups, "groups", GROUPS_MAX).map((entry) => {
    const row = groupRow(entry);
    const name = checkedGroupName(row.name, seenNames);
    let id: string;
    if (row.id === undefined) {
      id = newGroupId(taken);
      taken.add(id);
    } else {
      id = checkedGroupId(row.id, seenIds);
      if (!known.has(id)) throw new MessageRefused(`no group has the id ${id}; reload and try again`);
    }
    seenNames.add(name.toLowerCase());
    seenIds.add(id);
    return { id, name };
  });

  const quickMessages = asList(body.quickMessages, "quickMessages", QUICK_MESSAGES_MAX).map((t) =>
    checkedText(t, "a quick message", MESSAGE_MAX),
  );
  const quickReplies = asList(body.quickReplies, "quickReplies", QUICK_REPLIES_MAX).map((t) =>
    checkedText(t, "a quick reply", QUICK_REPLY_MAX),
  );
  return { version: current.version + 1, groups, quickMessages, quickReplies };
}

export const messagingStore = {
  /** Read the file into memory. Idempotent, and safe to call concurrently. */
  async init(): Promise<void> {
    if (!mirror) mirror = copyOf(await store.load());
  },

  /**
   * Whether the config was read whole from disk (or has been saved since). A caller
   * about to DELETE something because the config does not mention it asks this
   * first: a config that fell back to its defaults mentions nothing.
   */
  readCleanly(): boolean {
    return readClean;
  },

  /** Read the file again, discarding what is in memory: after a restore. */
  async reload(): Promise<void> {
    readClean = false;
    mirror = null;
    mirror = copyOf(await store.reload());
  },

  /**
   * The config as loaded. A copy, so a caller cannot edit what the next reader
   * sees. Before `init()` has run this is the defaults — callers that decide
   * something from it (send, assigning a screen to a group) `init()` first.
   */
  get(): MessagingConfig {
    return copyOf(mirror ?? defaults());
  },

  /**
   * Replace the whole config. Returns what is now stored, the groups that are
   * gone, and whether anything `messages:state` carries (the groups, names
   * included, or either quick list) differs from what was there, so the caller
   * can take the groups off the screens that had them and say so to the ones
   * that draw them.
   *
   * Refuses with MessageRefused when a rule is broken, and with MessagingConflict
   * when the body's `version` is not the stored one. Runs through the store's own
   * update(), which serialises writes and does not let a write that failed stay
   * in memory: a save that cannot reach the disk (a full SD card) throws to the
   * caller and leaves what was there, instead of a config every reader calls
   * saved that the next restart loses. Which groups are gone is decided inside
   * that serialised step, against the config this write replaces.
   */
  async replace(input: unknown): Promise<{ config: MessagingConfig; removed: MessageGroup[]; stateChanged: boolean }> {
    let removed: MessageGroup[] = [];
    let stateChanged = false;
    const stored = await store.update((current) => {
      const next = validate(input, current);
      const kept = new Set(next.groups.map((g) => g.id));
      removed = current.groups.filter((g) => !kept.has(g.id));
      // The three things the channel carries, not `version`: a save that changed
      // nothing a screen draws sends no frame.
      stateChanged =
        JSON.stringify([current.groups, current.quickMessages, current.quickReplies]) !==
        JSON.stringify([next.groups, next.quickMessages, next.quickReplies]);
      return next;
    });
    adopt(stored);
    return { config: copyOf(stored), removed, stateChanged };
  },
};
