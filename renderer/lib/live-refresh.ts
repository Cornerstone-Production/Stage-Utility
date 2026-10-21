// live-refresh.ts — keeping what a page has read current.
//
// In the building a page reads again on a timer. On the public page every read is a
// request to a Cloudflare Worker with a free plan's day to spend, and the same read
// every minute from every open tab is most of it for nothing. The Worker says when a
// doc changes (`publish:docs`), so a public page reads then, after each (re)connect of
// its socket (the transport says every doc has changed), and on a slow timer only while
// it has no socket to be told by.

import { DOCS_CHANNEL, type DocsFrameData } from "@main/types/servicecue-publish";
import { onNotification } from "./api";
import { isPublicSocketOpen } from "./public-live";
import { isPublicMode } from "./public-mode";

/** How often a public page reads again while it has no socket: a net under the notices, not how it learns of a change. */
export const PUBLIC_SAFETY_READ_MS = 10 * 60_000;

/** Does this `publish:docs` message name one of these docs, or say that any may have changed? */
export function docsChanged(data: unknown, keys: readonly string[]): boolean {
  const { keys: named, all } = (data ?? {}) as Partial<DocsFrameData>;
  return all === true || (Array.isArray(named) && keys.some((key) => named.includes(key)));
}

/**
 * Call `load` again whenever what it reads (the docs under `keys`) may have changed,
 * until the function returned is called. In the building that is every `everyMs`, or
 * never if it is null: some pages read once and stay as they were.
 */
export function refreshWhileMounted(load: () => void, keys: readonly string[], everyMs: number | null): () => void {
  if (!isPublicMode()) {
    if (everyMs === null) return () => {};
    const timer = setInterval(load, everyMs);
    return () => clearInterval(timer);
  }
  const off = onNotification(DOCS_CHANNEL, (data) => {
    if (docsChanged(data, keys)) load();
  });
  const safety = setInterval(() => {
    if (!isPublicSocketOpen()) load();
  }, PUBLIC_SAFETY_READ_MS);
  return () => {
    off();
    clearInterval(safety);
  };
}
