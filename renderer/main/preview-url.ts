// The address of a settings live preview: what a Screens card writes, and what
// the kiosk page inside its iframe reads back.
//
// The route is `/preview-<viewId>` and it names a VIEW. That was enough while a
// preview only had to draw the view's content, and it stopped being enough the
// moment a preview had to reflect a setting that belongs to a SCREEN: two screens
// can show one view with the top bar hidden on only one of them, so the view id
// alone cannot say which answer is the right one.
//
// So the card that stands in for a screen says which screen it stands in for. The
// writer is ViewPreview's iframe src; the reader is StageView, resolving its own
// location. They are the same contract seen from two ends, and they are here
// together because a mismatch between the two ends fails silently: the iframe
// loads, the picture is right, and the flag simply never arrives.
//
// The path half is the same literal the server reserves as `RESERVED_SLUG_PREFIX`,
// and it is spelled again here rather than imported: reserved-slugs.ts says in its
// own header that the renderer must not import it at runtime, because it pulls in
// the server's route tables. So the copy is deliberate and preview-url.test.ts
// asserts the two are equal — a test may import from main where this module may
// not.

/** Prefix the settings preview route is reserved under. */
const PREVIEW_PREFIX = "preview-";

/** Query key carrying the Output a preview stands in for. */
const OUTPUT_PARAM = "output";

/** The `src` for a preview of `viewId`, optionally standing in for an Output. */
export function previewSrc(viewId: string, outputId?: string | null): string {
  const path = `/${PREVIEW_PREFIX}${encodeURIComponent(viewId)}`;
  return outputId ? `${path}?${OUTPUT_PARAM}=${encodeURIComponent(outputId)}` : path;
}

/**
 * The Output a preview stands in for, from a location's query string, or null.
 *
 * Null unless this really is a preview: `previewViewId` is the caller's own
 * answer to "am I a preview", and a real display must never pick an output id out
 * of its own URL — a wall screen's address is its identity, and letting a query
 * param name a different screen's settings would make that address a suggestion.
 */
export function previewOutputId(search: string, previewViewId: string | null): string | null {
  if (!previewViewId) return null;
  const id = new URLSearchParams(search).get(OUTPUT_PARAM);
  return id !== null && id !== "" ? id : null;
}

/**
 * The View a preview slug names, or null when the slug is not a preview at all.
 *
 * Takes the already-resolved path SEGMENT rather than a pathname, because the
 * caller has to resolve a friendly display slug to its canonical id first and
 * that answer is the thing this asks about. Here beside the writer so the round
 * trip can be tested through the parse the kiosk really runs — a test that
 * re-implements the parse cannot fail on the parse being wrong.
 */
export function previewViewIdFromSlug(slug: string): string | null {
  return slug.startsWith(PREVIEW_PREFIX) ? slug.slice(PREVIEW_PREFIX.length) : null;
}
