// media-order.ts — searching, filtering and sorting the media library.
//
// PURE, and separate from the grid that draws it, because the ORDER is what a
// shift-click extends over. The selection model takes "the list as shown"; this
// is what produces it, and the two have to agree or a range selects things the
// operator cannot see.

import type { SignageMedia } from "@main/types/signage";
import { isSignageVideo } from "@main/types/signage";

export type MediaKind = "all" | "image" | "video";
export type MediaSort = "recent" | "oldest" | "name" | "largest";

export interface MediaView {
  search: string;
  kind: MediaKind;
  sort: MediaSort;
}

export const DEFAULT_VIEW: MediaView = { search: "", kind: "all", sort: "recent" };

export const SORT_LABELS: Record<MediaSort, string> = {
  recent: "Newest first",
  oldest: "Oldest first",
  name: "Name",
  largest: "Largest first",
};

export const KIND_LABELS: Record<MediaKind, string> = {
  all: "Everything",
  image: "Graphics",
  video: "Video",
};

/**
 * Case- and accent-insensitive, because the library has real filenames in it.
 *
 * "Bienvenido á casa" has to be findable by typing "casa", and by typing "a" for
 * the "á" — an operator searching a list does not know which of the two the
 * uploader's keyboard produced.
 */
function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** The library as shown: filtered, searched, sorted. */
export function orderMedia(media: readonly SignageMedia[], view: MediaView): SignageMedia[] {
  const needle = fold(view.search.trim());

  const out = media.filter((m) => {
    if (view.kind === "image" && isSignageVideo(m.mime)) return false;
    if (view.kind === "video" && !isSignageVideo(m.mime)) return false;
    return needle === "" || fold(m.name).includes(needle);
  });

  // A stable tie-break on id, so two files uploaded in the same millisecond — a
  // multi-file drop does exactly that — do not swap places between renders and
  // move under the pointer.
  const tie = (a: SignageMedia, b: SignageMedia) => a.id.localeCompare(b.id);

  switch (view.sort) {
    case "recent":
      return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || tie(a, b));
    case "oldest":
      return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || tie(a, b));
    case "largest":
      return out.sort((a, b) => b.bytes - a.bytes || tie(a, b));
    case "name":
      // Numeric collation, so "slide 2" comes before "slide 10" — the whole
      // reason anyone sorts a media library by name.
      return out.sort(
        (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) || tie(a, b),
      );
  }
}
