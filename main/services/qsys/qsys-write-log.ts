// qsys-write-log.ts — every Q-SYS write a panel asked for, and what came of it.
//
// One entry per write call, refused or not, newest first, capped. Runtime: it is
// an observation, never restored onto another box.
//
// A write does not wait for the file. Entries go into memory at once and the
// file follows: one save in flight at a time, and whatever arrives meanwhile is
// carried by a single save after it, so a fader drag cannot queue a rewrite per
// sample. A save that fails is logged once per run of failures and reported by
// list() (`saveError`), so /qsys/manage can say the log is in memory only.

import { DataStore } from "../data-store.js";
import { errorMessage } from "../errors.js";
import { scrub } from "../scrub.js";

export interface WriteLogEntry {
  at: number;
  panelId: string | null;
  device: string;
  component: string;
  control: string;
  /** The Core's value before the write as the watch last read it, or null when no open panel watches it. */
  from: unknown;
  /** The value sent (after clamping), or for a refusal the value asked for. */
  to: unknown;
  /** `ok`, `clamped`, `mismatch`, or the refusal's reason. */
  result: string;
}

export const WRITE_LOG_CAP = 2000;

const store = new DataStore<WriteLogEntry[]>("qsys-write-log.json", [], "runtime");

let entries: WriteLogEntry[] | null = null;
let loading: Promise<WriteLogEntry[]> | null = null;
let saving: Promise<void> | null = null;
let again = false;
let saveError: string | null = null;

async function loaded(): Promise<WriteLogEntry[]> {
  if (entries) return entries;
  loading ??= store.load().then(
    (stored) => {
      entries = (Array.isArray(stored) ? stored : []).slice(0, WRITE_LOG_CAP);
      return entries;
    },
    (err: unknown) => {
      // A write must not fail for its log: keep entries in memory and say so,
      // here and in list(). DataStore refuses to save over a file it could not read.
      console.error(`[qsys] could not read the write log; entries are in memory only: ${scrub(errorMessage(err))}`);
      saveError = errorMessage(err);
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
        if (saveError) console.log("[qsys] write log saved again");
        saveError = null;
      },
      (err: unknown) => {
        // Not swallowed: list() hands it to the page. Logged once per run of failures.
        if (!saveError) console.error(`[qsys] could not save the write log; entries since are in memory only: ${scrub(errorMessage(err))}`);
        saveError = errorMessage(err);
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
    list.unshift(entry);
    if (list.length > WRITE_LOG_CAP) list.length = WRITE_LOG_CAP;
    persist();
  },

  async list(): Promise<{ entries: WriteLogEntry[]; saveError: string | null }> {
    return { entries: [...(await loaded())], saveError };
  },

  /** Resolves once every save started so far has settled. Never rejects. For tests. */
  async whenIdle(): Promise<void> {
    while (saving) await saving;
  },
};
