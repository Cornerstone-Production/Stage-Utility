// clipboard.ts — the plot editor's own clipboard: Cut, Copy and Paste of plot items.
//
// Not the system clipboard. Production is plain HTTP, where the browser offers no
// clipboard API, and a plot item means nothing to another app anyway. What is copied
// is kept in this page and in the browser's storage, so a copy pastes into another
// plot, another venue, or the editor open in another tab of the same browser. Storage
// refused (a private window) keeps it for this page only.
//
// Each paste of one copy lands a little further down and right than the last
// (Duplicate's offset), so repeated pastes do not stack. A cut's first paste lands
// where the item was.

import type { PlotItem } from "@main/types/stageplots";

import { readStored, removeStored, writeStored } from "../../lib/safe-storage";
import { uid } from "../../lib/uid";
import { DUPLICATE_OFFSET } from "./editor-state";

export const CLIPBOARD_KEY = "stageplots:clipboard";

interface Clip {
  items: PlotItem[];
  /** Pastes made from this copy so far: the next lands this many offsets on. */
  pastes: number;
}

let held: Clip | null = null;

function isClip(v: unknown): v is Clip {
  return !!v && typeof v === "object" && Array.isArray((v as Clip).items) && typeof (v as Clip).pastes === "number";
}

function current(): Clip | null {
  const stored = readStored<Clip | null>(
    CLIPBOARD_KEY,
    (raw) => {
      const v: unknown = raw === null ? null : JSON.parse(raw);
      return isClip(v) ? v : null;
    },
    null,
  );
  return stored ?? held;
}

function keep(clip: Clip): void {
  held = clip;
  writeStored(CLIPBOARD_KEY, JSON.stringify(clip));
}

/** Copy items. `cut` makes the first paste land where they were. */
export function copyItems(items: readonly PlotItem[], { cut = false }: { cut?: boolean } = {}): void {
  if (items.length === 0) return;
  keep({ items: structuredClone([...items]), pastes: cut ? -1 : 0 });
}

/** Whether anything is there to paste. */
export function canPaste(): boolean {
  return (current()?.items.length ?? 0) > 0;
}

/**
 * What to paste, each item with a new id, and how far it moves from where it was
 * copied; null when nothing is copied. Counts the paste, so the next lands further on.
 */
export function takePaste(): { items: PlotItem[]; offset: number } | null {
  const clip = current();
  if (!clip || clip.items.length === 0) return null;
  const n = clip.pastes + 1;
  keep({ ...clip, pastes: n });
  return { items: clip.items.map((it) => ({ ...structuredClone(it), id: uid("i") })), offset: n * DUPLICATE_OFFSET };
}

/** For a test: forget what is copied. */
export function clearClipboard(): void {
  held = null;
  removeStored(CLIPBOARD_KEY);
}
