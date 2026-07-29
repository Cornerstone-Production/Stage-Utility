/** Resolve a URL path segment to a display's canonical id.
 *
 *  A display keeps a permanent id (`/display-1`) and may carry an optional friendly
 *  slug (`/left-mic`). Both resolve here; everything downstream — slotsByDisplay,
 *  resolvedByOutput, reload targeting — keys off the id, so a slug must never reach
 *  them.
 *
 *  Ids are matched BEFORE slugs, and deliberately not because validation makes a
 *  collision impossible: if a bad slug ever does land in config, an existing display
 *  must not become unreachable at its own permanent address.
 *
 *  Resolution lives in the renderer because that is the only place it happens — the
 *  kiosk selects its own slice of `/api/state` client-side, and the server's other
 *  displayId callers receive a real id in a POST body from the settings UI. */
export function resolveDisplayId(
  pathSlug: string,
  outputs: readonly { id: string; slug?: string }[] | undefined,
): string | null {
  const s = pathSlug.trim().toLowerCase();
  if (s === "" || !outputs) return null;
  const byId = outputs.find((o) => o.id.toLowerCase() === s);
  if (byId) return byId.id;
  const bySlug = outputs.find((o) => o.slug != null && o.slug.trim().toLowerCase() === s);
  return bySlug ? bySlug.id : null;
}
