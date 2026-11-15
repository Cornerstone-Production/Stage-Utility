// How the sidebar is arranged: its sections, their order and names, and the
// pages taken out of it.
//
// Operator config, so "config": somebody arranged this sidebar to suit how their
// team works, and losing it to a reinstall is losing their setup. Being config is
// also what puts it in every backup.
//
// GLOBAL, like the context bar: the app has no user accounts, and every browser
// on every device reads the same sidebar.
//
// What is saved is the operator's arrangement and nothing more, and empty means
// the default. sidebar-arrangement.ts explains why, and holds the rules this
// file and the renderer share.

import { DataStore } from "./data-store.js";
import { checked } from "./restore-check.js";
import { toError } from "./errors.js";
import { scrub } from "./scrub.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getUserDataPath } from "./app-paths.js";
import { EMPTY_SIDEBAR, readSidebarLeniently, validateSidebarArrangement, type SidebarArrangement } from "./sidebar-arrangement.js";

/** A restore is checked by the same function a save is. */
const restoreCheck = checked((raw) => validateSidebarArrangement(raw));

const FILE = "sidebar-config.json";
const store = new DataStore<SidebarArrangement>(FILE, EMPTY_SIDEBAR, "config", { restoreCheck });

let cache: SidebarArrangement = EMPTY_SIDEBAR;

export const sidebarConfigStore = {
  /**
   * Load the saved arrangement.
   *
   * A file that breaks the save rules (edited by hand, or written by a build with
   * other rules) is kept: a copy goes beside it as
   * `sidebar-config.json.invalid-<time>` BEFORE anything can overwrite it, the
   * sidebar is drawn from what in it can be read, and the next save replaces
   * sidebar-config.json. The operator's arrangement is theirs, so the original is
   * never lost to a save it could not pass. Said on one line, so a sidebar that
   * looks different after an update has a reason to read.
   */
  async init(): Promise<void> {
    // From disk, not a cache: a restore writes the file and restarts, and a test
    // writes it by hand.
    const raw = await store.reload();
    try {
      cache = validateSidebarArrangement(raw);
      return;
    } catch (err) {
      cache = readSidebarLeniently(raw);
      const reason = toError(err).message;
      const aside = `${FILE}.invalid-${Date.now()}`;
      try {
        await fs.copyFile(path.join(getUserDataPath(), FILE), path.join(getUserDataPath(), aside));
        console.error(
          `[sidebar] sidebar-config.json breaks the save rules (${scrub(reason)}). A copy is kept as ${scrub(aside)}; the sidebar is drawn from what in it can be read, and the next save replaces sidebar-config.json.`,
        );
      } catch (copyErr) {
        console.error(
          `[sidebar] sidebar-config.json breaks the save rules (${scrub(reason)}) and could not be copied aside (${scrub(toError(copyErr).message)}). The sidebar is drawn from what in it can be read; copy sidebar-config.json somewhere safe before the next save replaces it.`,
        );
      }
    }
  },

  get(): SidebarArrangement {
    return cache;
  },

  /** Replace the arrangement with one already validated. Awaited: a write that
   *  silently failed would read as saved until the next restart. */
  async set(next: SidebarArrangement): Promise<SidebarArrangement> {
    await store.save(next);
    cache = next;
    return cache;
  },
};
