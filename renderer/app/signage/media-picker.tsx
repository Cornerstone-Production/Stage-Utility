// media-picker.tsx — pick graphics out of the library, several at a time.
//
// Replaces a <select> of every file in the library. That worked at four items
// and falls apart at four hundred: a dropdown cannot be searched, shows one line
// per file with no thumbnail, and adds exactly one thing per trip. Choosing the
// twelve graphics for a weekend loop meant twelve round trips through a list you
// cannot see.
//
// So: a grid you can search and filter, cmd/shift select over, and add in one
// go. The selection model and the ordering are their own modules — selection.ts
// and media-order.ts — because both are fiddly, pure, and shared with the media
// page, which has to behave identically.

import { useMemo, useState } from "react";
import { SearchIcon } from "lucide-react";
import type { SignageMedia } from "@main/types/signage";

import { Button } from "../../components/ui/button";
import {
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogRoot,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { SelectField } from "./select-field";
import { MediaThumb } from "./media-thumb";
import { size } from "./format";
import {
  DEFAULT_VIEW,
  KIND_LABELS,
  SORT_LABELS,
  orderMedia,
  type MediaKind,
  type MediaSort,
  type MediaView,
} from "./media-order";
import { EMPTY, clickSelect, modsOf, selectAll, type Selection } from "./selection";

export function MediaPicker({
  open,
  onOpenChange,
  media,
  onAdd,
  /** Named so the button can say what it will do — "Add 3 to bathrooms". */
  destination,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  media: SignageMedia[];
  /** Called with the picked ids, in the order they are shown. */
  onAdd: (ids: string[]) => void;
  destination?: string;
}) {
  const [view, setView] = useState<MediaView>(DEFAULT_VIEW);
  const [selection, setSelection] = useState<Selection>(EMPTY);

  const shown = useMemo(() => orderMedia(media, view), [media, view]);
  const order = useMemo(() => shown.map((m) => m.id), [shown]);
  const picked = new Set(selection.ids);

  const close = (next: boolean) => {
    onOpenChange(next);
    // Cleared on the way out, not the way in: reopening should be a fresh pick,
    // and leaving the old selection to flash before an effect cleared it is the
    // kind of thing that gets added twice.
    if (!next) {
      setSelection(EMPTY);
      setView(DEFAULT_VIEW);
    }
  };

  const add = () => {
    if (selection.ids.length === 0) return;
    // In the order SHOWN, so picking down a sorted grid puts them in the
    // playlist the way they were read.
    onAdd(order.filter((id) => picked.has(id)));
    close(false);
  };

  return (
    <DialogRoot open={open} onOpenChange={close}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Add media</DialogTitle>
          <DialogDescription>
            Click to pick, cmd-click for several, shift-click for a run.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-end gap-2">
          <label className="relative min-w-0 flex-1">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" />
            <Input
              value={view.search}
              onChange={(e) => setView({ ...view, search: e.target.value })}
              placeholder="Search the library"
              aria-label="Search the library"
              className="pl-8"
              autoFocus
            />
          </label>
          <SelectField
            label="Show"
            hideLabel
            value={view.kind}
            onChange={(v) => setView({ ...view, kind: v as MediaKind })}
            options={Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label }))}
          />
          <SelectField
            label="Sort"
            hideLabel
            value={view.sort}
            onChange={(v) => setView({ ...view, sort: v as MediaSort })}
            options={Object.entries(SORT_LABELS).map(([value, label]) => ({ value, label }))}
          />
        </div>

        <div className="mt-3 max-h-[46vh] overflow-y-auto rounded-lg border border-line p-2">
          {shown.length === 0 ? (
            <p className="px-1 py-6 text-center text-footnote text-fg-subtle">
              {media.length === 0
                ? "The library is empty. Upload something on the Media tab."
                : "Nothing matches that."}
            </p>
          ) : (
            <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(132px,1fr))]">
              {shown.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  aria-pressed={picked.has(m.id)}
                  onClick={(e) => setSelection(clickSelect(selection, order, m.id, modsOf(e)))}
                  // Double-click adds just that one, which is the impatient path
                  // and the one a mouse reaches for without being told.
                  onDoubleClick={() => {
                    onAdd([m.id]);
                    close(false);
                  }}
                  className={
                    picked.has(m.id)
                      ? "flex flex-col gap-1 rounded-lg border-2 border-accent bg-fill p-1 text-left"
                      : "flex flex-col gap-1 rounded-lg border-2 border-transparent p-1 text-left transition-colors hover:bg-fill-hover"
                  }
                >
                  <span className="relative block aspect-video overflow-hidden rounded bg-black">
                    {/* preload="metadata" so the grid shows a poster frame
                        without pulling a hundred megabytes — see MediaThumb. */}
                    <MediaThumb media={m} />
                  </span>
                  <span className="truncate text-caption1 text-fg">{m.name}</span>
                  <span className="truncate text-caption2 text-fg-subtle">
                    {m.w} × {m.h} · {size(m.bytes)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="mt-4 flex items-center gap-2">
          <span className="text-caption1 text-fg-subtle">
            {selection.ids.length
              ? `${selection.ids.length} selected`
              : `${shown.length} of ${media.length} shown`}
          </span>
          {shown.length > 0 ? (
            <Button size="small" onClick={() => setSelection(selectAll(order))}>
              Select all
            </Button>
          ) : null}
          <div className="ml-auto flex gap-2">
            <Button onClick={() => close(false)}>Cancel</Button>
            <Button variant="accent" disabled={selection.ids.length === 0} onClick={add}>
              {selection.ids.length
                ? `Add ${selection.ids.length}${destination ? ` to ${destination}` : ""}`
                : "Add"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </DialogRoot>
  );
}
