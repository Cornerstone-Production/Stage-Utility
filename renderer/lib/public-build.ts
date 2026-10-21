// public-build.ts — a page left open across a deploy reloads itself, once.
//
// The build stamps its document with an id (VIEWER_BUILD_META) and the Worker puts the
// id of the document it serves on every heartbeat. A page that hears one that is not its
// own reloads, on the same address. Once: the id it reloaded for is kept in the tab
// (sessionStorage, so each tab has its own) before the reload, and an offer of that same
// id is not acted on again, so a stale document cannot loop it. With no storage that
// keeps what is written, nothing is reloaded.

import { VIEWER_BUILD_META, isViewerBuildId } from "@main/types/servicecue-publish";
import { readStored, writeStored, type RemovableStorage } from "./safe-storage";

/** The tab's note of the build it last reloaded for. */
export const RELOADED_FOR_KEY = "servicecue:reloaded-for";

/**
 * The id of the build whose document loaded this page, or null when the document
 * carries none (a build from before ids, or the page under a dev server) — in which
 * case there is nothing to compare an offer with.
 */
export function runningBuild(): string | null {
  if (typeof document === "undefined") return null;
  const content = document.querySelector(`meta[name="${VIEWER_BUILD_META}"]`)?.getAttribute("content");
  return isViewerBuildId(content) ? content : null;
}

/** What `reloadForNewBuild` did with an offer. */
export type BuildCheck =
  /** The offer is not an id, or the page has none of its own to compare it with. */
  | "unknown"
  /** The page is the build the Worker is serving. */
  | "same"
  /** A different build: the page was reloaded. */
  | "reloading"
  /** A different build, and this tab already reloaded for it: left alone, so as not to loop. */
  | "already-tried"
  /** A different build, and the tab cannot be made to remember: left alone, so as not to loop. */
  | "cannot-remember";

let reloadPage = (): void => window.location.reload();
/** Test seam: what "reload" does. jsdom's `location.reload` cannot be replaced or observed. */
export function __setReloadForTests(reload: (() => void) | null): void {
  reloadPage = reload ?? (() => window.location.reload());
}

/** The tab's own storage, or null where there is none or touching it throws. */
function tabStorage(): RemovableStorage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** The build this tab last reloaded for, or null when none is written or the tab has no storage to say. */
function readNote(tab: RemovableStorage | null): string | null {
  return readStored(RELOADED_FOR_KEY, (raw) => raw, null, tab);
}

/** The offers already said on the console, so a heartbeat every 30 seconds does not say it every 30 seconds. */
const said = new Set<string>();
function sayOnce(key: string, message: string): void {
  if (said.has(key)) return;
  said.add(key);
  console.warn(`[public-build] ${message}`);
}

/**
 * The Worker says the page it serves is build `offered`. If that is not the build
 * this page is, reload it, once.
 */
export function reloadForNewBuild(offered: unknown): BuildCheck {
  const running = runningBuild();
  if (running === null || !isViewerBuildId(offered)) return "unknown";
  if (offered === running) return "same";

  const tab = tabStorage();
  if (readNote(tab) === offered) {
    sayOnce(`tried:${offered}`, `this tab already reloaded for build ${offered} and is still on ${running}; not reloading again`);
    return "already-tried";
  }
  // Remembered BEFORE the reload, so a reload that comes back to the same page finds the
  // note, and read back, because a storage that takes a write and keeps nothing would
  // send the page round for as long as the Worker offers that build.
  if (!writeStored(RELOADED_FOR_KEY, offered, tab) || readNote(tab) !== offered) {
    sayOnce(`storage:${offered}`, `build ${offered} is being served and this page is ${running}, but the tab cannot remember a reload, so it will not risk a loop`);
    return "cannot-remember";
  }
  console.log(`[public-build] build ${offered} is being served and this page is ${running}; reloading`);
  reloadPage();
  return "reloading";
}

/** Test seam: forget what has been said. */
export function __resetPublicBuildForTests(): void {
  said.clear();
}
