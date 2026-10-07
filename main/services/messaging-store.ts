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
import { scrub } from "./scrub.js";
import { WriteQueue } from "./write-queue.js";

/**
 * The caller's mistake rather than ours: a body the limits refuse. Routes answer
 * it 400 with the message; anything else that throws out of here is a failed
 * write and is not dressed up as one.
 */
export class MessagingRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MessagingRefused";
  }
}

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

/**
 * Read what a file held, total: it runs on whatever `messaging.json` contains,
 * including a hand edit or a restore from a build with other limits.
 *
 * An entry that breaks a limit is left out of the live config and named on /log,
 * not repaired into something the operator did not write. The file keeps it
 * until the next save.
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

  if (Array.isArray(raw.groups)) {
    const ids = new Set<string>();
    const names = new Set<string>();
    out.groups = [];
    for (const g of raw.groups) {
      const row = g as { id?: unknown; name?: unknown } | null;
      const name = typeof row?.name === "string" ? row.name.trim() : "";
      const id = typeof row?.id === "string" ? row.id : "";
      const key = name.toLowerCase();
      if (
        !GROUP_ID.test(id) || ids.has(id)
        || name.length < 1 || name.length > GROUP_NAME_MAX
        || key === EVERYONE || names.has(key)
        || out.groups.length >= GROUPS_MAX
      ) {
        skipped.push(`group ${scrub(name || id, 40)}`);
        continue;
      }
      ids.add(id);
      names.add(key);
      out.groups.push({ id, name });
    }
  }
  const list = (value: unknown, fallback: string[], max: number, each: number, what: string): string[] => {
    if (!Array.isArray(value)) return fallback;
    const kept: string[] = [];
    for (const entry of value) {
      const text = typeof entry === "string" ? entry.trim() : "";
      if (text.length < 1 || text.length > each || kept.length >= max) {
        skipped.push(`${what} ${scrub(text || entry, 40)}`);
        continue;
      }
      kept.push(text);
    }
    return kept;
  };
  out.quickMessages = list(raw.quickMessages, out.quickMessages, QUICK_MESSAGES_MAX, MESSAGE_MAX, "quick message");
  out.quickReplies = list(raw.quickReplies, out.quickReplies, QUICK_REPLIES_MAX, QUICK_REPLY_MAX, "quick reply");

  if (skipped.length > 0) {
    console.warn(
      `[messages] messaging.json: left out ${scrub(skipped.length)} entr${scrub(skipped.length === 1 ? "y" : "ies")} that break a limit: ${scrub(skipped.join(", "), 600)}`,
    );
  }
  return out;
}

const store = new DataStore<MessagingConfig>("messaging.json", defaults(), "config", { normalize: readFile });

let cache: MessagingConfig | null = null;
let loading: Promise<void> | null = null;

/** Serialises replace(): it reads the groups that exist to decide which were
 *  removed, and two interleaved calls would each decide against a stale list. */
const writes = new WriteQueue();

async function ensureLoaded(): Promise<void> {
  if (cache) return;
  // The load in flight, shared, so two callers arriving cold do not each
  // reassign the cache over the other's write.
  loading ??= (async () => {
    cache = copyOf(await store.load());
  })();
  try {
    await loading;
  } finally {
    loading = null;
  }
}

function newGroupId(taken: ReadonlySet<string>): string {
  for (;;) {
    const id = `g-${randomBytes(4).toString("hex")}`;
    if (!taken.has(id)) return id;
  }
}

function asList(value: unknown, field: string, max: number): unknown[] {
  if (!Array.isArray(value)) throw new MessagingRefused(`${field} (array) is required`);
  if (value.length > max) throw new MessagingRefused(`${field} can hold at most ${max} (this has ${value.length})`);
  return value;
}

function checkedText(value: unknown, what: string, max: number): string {
  if (typeof value !== "string") throw new MessagingRefused(`${what} must be text`);
  const text = value.trim();
  if (text.length < 1) throw new MessagingRefused(`${what} cannot be empty`);
  if (text.length > max) throw new MessagingRefused(`${what} is at most ${max} characters (this one is ${text.length})`);
  return text;
}

/**
 * The strict reading of a body, for PUT. Throws MessagingRefused naming the
 * first thing wrong; returns the config to store.
 *
 * `existing` is the groups as they stand: a group in the body that carries an
 * id must be one of them. Ids are the server's to hand out, so a well-formed id
 * nobody issued is refused rather than taken — otherwise a stale page could
 * bring a deleted group back under its old id.
 */
function validate(input: unknown, current: MessagingConfig): MessagingConfig {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new MessagingRefused("body must be { version, groups, quickMessages, quickReplies }");
  }
  const body = input as Record<string, unknown>;
  // First, before any other rule: a body built from an older config is stale
  // whatever else is wrong with it, and "reload" is the answer that helps.
  if (typeof body.version !== "number") {
    throw new MessagingRefused("version (number) is required: send the version the config was read at");
  }
  if (body.version !== current.version) throw new MessagingConflict();
  const existing = current.groups;
  const known = new Map(existing.map((g) => [g.id, g]));
  const taken = new Set(known.keys());
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();

  const groups: MessageGroup[] = asList(body.groups, "groups", GROUPS_MAX).map((entry) => {
    if (entry === null || typeof entry !== "object") throw new MessagingRefused("every group must be { name } or { id, name }");
    const row = entry as { id?: unknown; name?: unknown };
    const name = checkedText(row.name, "a group name", GROUP_NAME_MAX);
    const key = name.toLowerCase();
    if (key === EVERYONE) throw new MessagingRefused(`"${name}" is built in; pick another group name`);
    if (seenNames.has(key)) throw new MessagingRefused(`two groups are named "${name}" (names are not case-sensitive)`);
    seenNames.add(key);

    let id: string;
    if (row.id === undefined) {
      id = newGroupId(taken);
      taken.add(id);
    } else {
      if (typeof row.id !== "string" || !GROUP_ID.test(row.id)) throw new MessagingRefused("a group id is not one this app issued");
      if (!known.has(row.id)) throw new MessagingRefused(`no group has the id ${row.id}; reload and try again`);
      if (seenIds.has(row.id)) throw new MessagingRefused(`the group id ${row.id} appears twice`);
      id = row.id;
    }
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
    await ensureLoaded();
  },

  /**
   * The config as loaded. A copy, so a caller cannot edit what the next reader
   * sees. Before `init()` has run this is the defaults — callers that decide
   * something from it (send, assigning a screen to a group) `init()` first.
   */
  get(): MessagingConfig {
    return copyOf(cache ?? defaults());
  },

  /**
   * Replace the whole config. Returns what is now stored, the groups that are
   * gone, and whether the groups (names included) differ from what was there,
   * so the caller can take them off the screens that had them and say so to
   * the ones that draw them.
   *
   * Refuses with MessagingRefused when a limit is broken, and with
   * MessagingConflict when the body's `version` is not the stored one. The file is written
   * before the live config changes: a write that fails (a full SD card) throws
   * to the caller and leaves what was there, instead of a config every reader
   * calls saved that the next restart loses.
   */
  async replace(input: unknown): Promise<{ config: MessagingConfig; removed: MessageGroup[]; groupsChanged: boolean }> {
    return writes.enqueue(async () => {
      await ensureLoaded();
      const before = cache ?? defaults();
      const next = validate(input, before);
      await store.save(copyOf(next));
      cache = copyOf(next);
      const kept = new Set(next.groups.map((g) => g.id));
      return {
        config: copyOf(next),
        removed: before.groups.filter((g) => !kept.has(g.id)),
        // Decided here, against the groups this write replaced, because a caller
        // that read them before the call can have two overlapping saves each
        // compare against a list the other has already changed.
        groupsChanged: JSON.stringify(before.groups) !== JSON.stringify(next.groups),
      };
    });
  },
};
