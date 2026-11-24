// qsys-write-log.ts — every Q-SYS write a panel asked for, and what came of it.
//
// One entry per write gesture, newest first, capped: a successful write is
// recorded when it is a gesture's last (see WriteRequest.final), a refusal every
// time. Runtime: it is an observation, never restored onto another box.
//
// A refusal made before anything was sent, repeating one already recorded (same
// remote address, panel, control and reason, within a minute of its last), is
// counted on that entry (`repeats`, `lastAt`) instead of pushing real entries
// out: a client looping on a bad request cannot empty the log of what actually
// happened. Anything that reached the Core (a success, or a core-error that may
// have landed) always keeps its own entry and its own value.
//
// A write does not wait for the file. Entries go into memory at once and the
// file follows: one save in flight at a time, and whatever arrives meanwhile is
// carried by a single save after it, so a fader drag cannot queue a rewrite per
// sample. A save that fails is logged once per run of failures and reported by
// list() (`saveError`, a fixed phrase: the detail, which names the data
// directory, goes to /log only), so the page can say the log is in memory only.

import { DataStore } from "../data-store.js";
import { errorMessage } from "../errors.js";
import { scrub } from "../scrub.js";
import type { WriteRefusal } from "./qsys-write.js";

export interface WriteLogEntry {
  at: number;
  panelId: string | null;
  device: string;
  /** The remote address alone (absent in entries from before it was kept). */
  remote?: string;
  component: string;
  control: string;
  /** The Core's value when the gesture started, as the watch last read it; null when nothing watched it. */
  from: unknown;
  /** The value sent (after clamping), or for a refusal the value asked for. */
  to: unknown;
  /** `ok`, `clamped`, `mismatch`, or the refusal's reason. */
  result: string;
  /** For a write the server made itself (a momentary's lease ending): why. */
  cause?: string;
  /** For a refusal that repeated: how many times in all, and when the last was. */
  repeats?: number;
  lastAt?: number;
}

/** The phrase list() answers while the file cannot be read or saved. */
export const WRITE_LOG_SAVE_ERROR = "the write log could not be saved, so recent entries are in memory only; see /log";
/**
 * Whether each refusal is made before anything is sent to the Core. A Record, so
 * a new reason cannot be added without saying which it is. Only these merge here,
 * and only these have their [qsys] lines limited (QsysWriter).
 */
const BEFORE_SEND: Record<WriteRefusal, boolean> = {
  "bad-value": true,
  "core-error": false,
  "no-lease": true,
  "no-range": true,
  "not-allowed": true,
  "not-in-design": true,
  offline: true,
  "read-only": true,
};
export const PRE_SEND_REFUSALS: ReadonlySet<string> = new Set(
  (Object.keys(BEFORE_SEND) as WriteRefusal[]).filter((r) => BEFORE_SEND[r]),
);
/** How far back, in entries and in time, a refusal looks for one it repeats. */
const REPEAT_LOOKBACK = 50;
const REPEAT_WINDOW_MS = 60_000;

/** An entry read from disk is served only if it has the shape one is written with. */
function isEntry(v: unknown): v is WriteLogEntry {
  const e = v as Partial<WriteLogEntry> | null;
  return (
    !!e &&
    typeof e === "object" &&
    !Array.isArray(e) &&
    typeof e.at === "number" &&
    Number.isFinite(e.at) &&
    (e.panelId === null || typeof e.panelId === "string") &&
    typeof e.device === "string" &&
    (e.remote === undefined || typeof e.remote === "string") &&
    typeof e.component === "string" &&
    typeof e.control === "string" &&
    typeof e.result === "string" &&
    (e.cause === undefined || typeof e.cause === "string")
  );
}

export const WRITE_LOG_CAP = 2000;

const store = new DataStore<WriteLogEntry[]>("qsys-write-log.json", [], "runtime");

let entries: WriteLogEntry[] | null = null;
let loading: Promise<WriteLogEntry[]> | null = null;
let saving: Promise<void> | null = null;
let again = false;
let failing = false;

async function loaded(): Promise<WriteLogEntry[]> {
  if (entries) return entries;
  loading ??= store.load().then(
    (stored) => {
      entries = (Array.isArray(stored) ? stored : []).filter(isEntry).slice(0, WRITE_LOG_CAP);
      return entries;
    },
    (err: unknown) => {
      // A write must not fail for its log: keep entries in memory and say so,
      // here and in list(). DataStore refuses to save over a file it could not read.
      console.error(`[qsys] could not read the write log; entries are in memory only: ${scrub(errorMessage(err))}`);
      failing = true;
      entries = [];
      return entries;
    },
  );
  return loading;
}

function persist(): void {
  if (saving) {
    again = true;
    return;
  }
  saving = store
    .save([...entries!])
    .then(
      () => {
        if (failing) console.log("[qsys] write log saved again");
        failing = false;
      },
      (err: unknown) => {
        // Not swallowed: list() hands it to the page. Logged once per run of failures.
        if (!failing) console.error(`[qsys] could not save the write log; entries since are in memory only: ${scrub(errorMessage(err))}`);
        failing = true;
      },
    )
    .finally(() => {
      saving = null;
      if (again) {
        again = false;
        persist();
      }
    });
}

export const qsysWriteLog = {
  /** Never rejects: a failure to read or save the file is reported by list(). */
  async add(entry: WriteLogEntry): Promise<void> {
    const list = await loaded();
    if (PRE_SEND_REFUSALS.has(entry.result) && entry.remote !== undefined) {
      const same = list
        .slice(0, REPEAT_LOOKBACK)
        .find(
          (e) =>
            e.result === entry.result &&
            e.remote === entry.remote &&
            e.panelId === entry.panelId &&
            e.component === entry.component &&
            e.control === entry.control &&
            entry.at >= (e.lastAt ?? e.at) &&
            entry.at - (e.lastAt ?? e.at) < REPEAT_WINDOW_MS,
        );
      if (same) {
        same.repeats = (same.repeats ?? 1) + 1;
        same.lastAt = entry.at;
        same.to = entry.to;
        persist();
        return;
      }
    }
    list.unshift(entry);
    if (list.length > WRITE_LOG_CAP) list.length = WRITE_LOG_CAP;
    persist();
  },

  async list(): Promise<{ entries: WriteLogEntry[]; saveError: string | null }> {
    return { entries: (await loaded()).map((e) => ({ ...e })), saveError: failing ? WRITE_LOG_SAVE_ERROR : null };
  },

  /** Resolves once every save started so far has settled. Never rejects. For tests. */
  async whenIdle(): Promise<void> {
    while (saving) await saving;
  },
};
