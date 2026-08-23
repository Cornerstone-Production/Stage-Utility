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

/**
 * Every shape a kiosk URL can take, read once.
 *
 * Three, and they resolve differently enough that spelling the checks out
 * inline three times is how they come to disagree:
 *
 *   /display-9, /foyer-north   a real screen, by id or by friendly slug
 *   /preview-<viewId>          a VIEW, for the layout editor's live preview
 *   /preview-out-<outputId>    an OUTPUT, for the preview on a screen's card
 *
 * The last exists because of signage. One Signage view drives every signage
 * screen and the content is resolved per OUTPUT, so a per-view preview has no
 * output to resolve for — every signage card on the Screens page was a black
 * rectangle. Everything else looks the same whichever screen shows it.
 *
 * `preview-out-` is tested BEFORE `preview-`, or an output preview parses as a
 * view whose id starts with "out-".
 */
export interface ScreenPath {
  /** The output whose content is being rendered. */
  displayId: string;
  /** Set only for a view preview. */
  previewViewId: string | null;
  /** Set only for an output preview. */
  previewOutputId: string | null;
  /** Either kind. Neither is a wall: no presence, no remote refresh, no boot
   *  record, and never rotated — a thumbnail in a settings page is read the way
   *  the browser is. */
  isPreview: boolean;
}

const VIEW_PREVIEW = "preview-";
const OUTPUT_PREVIEW = "preview-out-";

export function parseScreenPath(
  pathSlug: string,
  outputs: readonly { id: string; slug?: string }[] | undefined,
): ScreenPath {
  if (pathSlug.startsWith(OUTPUT_PREVIEW)) {
    const previewOutputId = pathSlug.slice(OUTPUT_PREVIEW.length);
    return { displayId: previewOutputId, previewViewId: null, previewOutputId, isPreview: true };
  }
  if (pathSlug.startsWith(VIEW_PREVIEW)) {
    const previewViewId = pathSlug.slice(VIEW_PREVIEW.length);
    // displayId stays the raw slug: a view preview has no output, and nothing
    // downstream may treat it as one.
    return { displayId: pathSlug, previewViewId, previewOutputId: null, isPreview: true };
  }
  return {
    displayId: resolveDisplayId(pathSlug, outputs) ?? pathSlug,
    previewViewId: null,
    previewOutputId: null,
    isPreview: false,
  };
}
