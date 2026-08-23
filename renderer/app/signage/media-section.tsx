// media-section.tsx — the media library grid.
//
// Uploading is the only place in the app that sends raw bytes, so it carries its
// own progress and error state per file rather than going through the shared
// query layer. A failure names the file it belongs to: dropping eight graphics
// and getting one unattributed "upload failed" is useless.
//
// Selecting and ordering are NOT here. selection.ts and media-order.ts own them,
// because the picker dialog has to behave identically — a shift-click that means
// one thing in the library and another in the picker is worse than neither.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FilmIcon, ImageIcon, SearchIcon, Trash2Icon, UploadIcon } from "lucide-react";
import type { SignageMedia, SignagePlaylist } from "@main/types/signage";
import { isSignageVideo } from "@main/types/signage";

import { errorMessage } from "@main/services/errors";
import { Button } from "../../components/ui/button";
import { ContextMenu, type ContextMenuItem } from "../../components/ui/context-menu";
import { MediaThumb } from "./media-thumb";
import { EmptyState } from "../../components/ui/empty-state";
import { Input } from "../../components/ui/input";
import { confirmDelete } from "./confirm-delete";
import { toast } from "../../components/ui/toast";
import { invoke } from "../../lib/api";
import { size } from "./format";
import { StorageBar } from "./storage-bar";
import { SelectField } from "./select-field";
import {
  DEFAULT_VIEW,
  KIND_LABELS,
  SORT_LABELS,
  orderMedia,
  type MediaKind,
  type MediaSort,
  type MediaView,
} from "./media-order";
import {
  EMPTY,
  clickSelect,
  contextTarget,
  modsOf,
  pruneSelection,
  selectAll,
  type Selection,
} from "./selection";
import { uid } from "../../lib/uid";
import { uploadMedia } from "./use-signage-config";

/** The panel nearly every wall screen is. Not a preference — it is the size a
 *  graphic has to reach before it stops being upscaled on arrival. */
const PANEL_W = 1920;
const PANEL_H = 1080;

/** Will this be blown up to fill a normal screen? */
function belowPanel(m: SignageMedia): boolean {
  return m.w < PANEL_W || m.h < PANEL_H;
}

function duration(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Which playlists use this item — shown so a delete is never a surprise. */
function usedBy(media: SignageMedia, playlists: SignagePlaylist[]): string[] {
  return playlists.filter((p) => p.items.some((i) => i.mediaId === media.id)).map((p) => p.name);
}

interface Pending {
  name: string;
  error?: string;
}

export function MediaSection({
  media,
  playlists,
  loading,
  onChange,
  clipboard,
  onCopy,
}: {
  media: SignageMedia[];
  playlists: SignagePlaylist[];
  loading: boolean;
  onChange: () => Promise<void>;
  /** Media ids copied and waiting to be pasted into a playlist. */
  clipboard: string[];
  onCopy: (ids: string[]) => void;
}) {
  const [pending, setPending] = useState<Pending[]>([]);
  const [dragging, setDragging] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [view, setView] = useState<MediaView>(DEFAULT_VIEW);
  const [rawSelection, setSelection] = useState<Selection>(EMPTY);
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const shown = useMemo(() => orderMedia(media, view), [media, view]);
  const order = useMemo(() => shown.map((m) => m.id), [shown]);
  // Pruned every render against what still EXISTS — not against what is shown,
  // or filtering the grid would silently drop the selection behind it.
  // Memoised: this is an argument to a call on every render, and the byId map
  // two lines down already is.
  const allIds = useMemo(() => media.map((m) => m.id), [media]);
  const selection = pruneSelection(rawSelection, allIds);
  const picked = new Set(selection.ids);

  const send = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      setPending(files.map((f) => ({ name: f.name })));
      const failures: Pending[] = [];
      for (const file of files) {
        try {
          await uploadMedia(file);
        } catch (err) {
          // Named, not aggregated. Eight files and one anonymous failure tells
          // the operator nothing about which one to try again.
          failures.push({ name: file.name, error: errorMessage(err) });
        }
      }
      setPending(failures);
      await onChange();
    },
    [onChange],
  );

  const rename = useCallback(
    async (id: string, name: string) => {
      setRenaming(null);
      await invoke("signage:renameMedia", { id, name });
      await onChange();
    },
    [onChange],
  );

  const remove = useCallback(
    async (m: SignageMedia) => {
      const uses = usedBy(m, playlists);
      const ok = await confirmDelete(`${m.name}`, uses.length
          ? `It is in ${uses.join(", ")}. Deleting removes it from ${uses.length === 1 ? "that playlist" : "those playlists"}.`
          : "It is not in any playlist.");
      if (!ok) return;
      await invoke("signage:deleteMedia", { id: m.id });
      await onChange();
    },
    [playlists, onChange],
  );

  const byId = useMemo(() => new Map(media.map((m) => [m.id, m])), [media]);
  /** Delete a whole selection, saying what it is in before it goes. */
  const removeMany = useCallback(
    async (ids: string[]) => {
      const items = ids.map((id) => byId.get(id)).filter((m): m is SignageMedia => !!m);
      if (items.length === 0) return;
      // Every playlist any of them appears in, listed once. Deleting eight
      // graphics and finding out afterwards which loops lost items is the thing
      // this exists to prevent.
      const uses = [...new Set(items.flatMap((m) => usedBy(m, playlists)))];
      const ok = await confirmDelete(
        items.length === 1 ? items[0].name : `${items.length} items`,
        uses.length
          ? `Used by ${uses.join(", ")}. Deleting removes ${items.length === 1 ? "it" : "them"} from ${uses.length === 1 ? "that playlist" : "those playlists"}.`
          : "Not used by any playlist.",
      );
      if (!ok) return;
      // Sequential, not Promise.all: each delete rewrites the playlists store,
      // and concurrent read-modify-writes lose each other's edits.
      const failed: string[] = [];
      for (const m of items) {
        try {
          await invoke("signage:deleteMedia", { id: m.id });
        } catch (err) {
          failed.push(`${m.name} (${errorMessage(err)})`);
        }
      }
      setSelection(EMPTY);
      await onChange();
      // Returned to the operator rather than swallowed: a "Delete 8" that
      // removed six must not look like it removed eight.
      if (failed.length) toast.error(`Could not delete ${failed.join(", ")}`);
    },
    [byId, playlists, onChange],
  );

  /** Append a selection to an existing playlist. */
  const addToPlaylist = useCallback(
    async (playlist: SignagePlaylist, ids: string[]) => {
      const items = [...playlist.items, ...ids.map((mediaId) => ({ mediaId }))];
      await invoke("signage:savePlaylist", { playlist: { ...playlist, items } });
      await onChange();
      toast.success(`Added ${ids.length} to ${playlist.name}`);
    },
    [onChange],
  );

  /** Make a new playlist holding exactly this selection. */
  const newPlaylistFrom = useCallback(
    async (ids: string[]) => {
      const playlist = {
        id: uid("pl"),
        // Named after what is in it, which beats "New playlist" when three of
        // them accumulate.
        name: ids.length === 1 ? (byId.get(ids[0])?.name ?? "New playlist") : `${ids.length} graphics`,
        items: ids.map((mediaId) => ({ mediaId })),
        defaultDurationMs: 8000,
        fit: "contain" as const,
        transition: { kind: "crossfade" as const, ms: 600 },
        createdAt: new Date().toISOString(),
      };
      await invoke("signage:savePlaylist", { playlist });
      await onChange();
      toast.success(`Made ${playlist.name}`);
    },
    [byId, onChange],
  );

  /** The menu for a right-click on `id`. */
  const menuFor = useCallback(
    (id: string): ContextMenuItem[] => {
      // Right-clicking inside a selection acts on all of it; outside, on the one
      // row — and selects it, so the menu and the highlight agree.
      const target = contextTarget(selection, id);
      setSelection(target);
      const ids = [...target.ids];
      const many = ids.length > 1;

      return [
        {
          label: many ? `Add ${ids.length} to playlist` : "Add to playlist",
          items: [
            ...playlists.map((p) => ({
              label: p.name,
              onSelect: () => void addToPlaylist(p, ids),
            })),
            ...(playlists.length ? [{ separator: true }] : []),
            { label: "New playlist…", onSelect: () => void newPlaylistFrom(ids) },
          ],
        },
        { separator: true },
        { label: many ? `Copy ${ids.length}` : "Copy", shortcut: "⌘C", onSelect: () => onCopy(ids) },
        ...(many
          ? []
          : [{ label: "Rename", onSelect: () => setRenaming(id) }]),
        { separator: true },
        {
          label: many ? `Delete ${ids.length}` : "Delete",
          danger: true,
          onSelect: () => void removeMany(ids),
        },
      ];
    },
    [selection, playlists, addToPlaylist, newPlaylistFrom, removeMany, onCopy],
  );

  // Keyboard, rather than more buttons on the page. Select-all and delete are
  // things a hand already knows how to ask for, and a row of controls that
  // appears when something is selected pushes the whole grid down the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Never while typing. The search field and the rename field are both
      // inputs on this page, and cmd-A in one of them means select the text.
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSelection(selectAll(order));
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c" && selection.ids.length) {
        e.preventDefault();
        onCopy([...selection.ids]);
        return;
      }
      if (e.key === "Escape" && selection.ids.length) {
        setSelection(EMPTY);
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selection.ids.length) {
        e.preventDefault();
        void removeMany([...selection.ids]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [order, selection.ids, onCopy, removeMany]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-headline text-fg">Media library</h2>
          <p className="text-caption1 text-fg-subtle">
            {selection.ids.length
              ? `${selection.ids.length} selected`
              : shown.length === media.length
                ? `${media.length} ${media.length === 1 ? "item" : "items"}`
                : `${shown.length} of ${media.length} shown`}{" "}
            · {size(shown.reduce((n, m) => n + m.bytes, 0))}
            {clipboard.length ? ` · ${clipboard.length} copied, paste in a playlist` : ""}
          </p>
        </div>
        {/* Everything else a selection can do is on the right-click menu, where
            it does not cost a row. Delete is here because it is the one action
            worth reaching for without a right-click — and it sits in a row that
            is ALWAYS rendered, so selecting something no longer shoves the grid
            down the page. */}
        {selection.ids.length ? (
          <Button
            className="ml-auto"
            onClick={() => void removeMany([...selection.ids])}
          >
            <Trash2Icon className="size-4" />
            Delete {selection.ids.length}
          </Button>
        ) : null}
        <Button variant="accent" onClick={() => fileInput.current?.click()}>
          <UploadIcon className="size-4" />
          Upload
        </Button>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm"
          className="hidden"
          onChange={(e) => {
            void send([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
      </div>

      {pending.length ? (
        <div className="flex flex-col gap-1">
          {pending.map((p) => (
            <p
              key={p.name}
              className={
                p.error
                  ? "rounded-md border border-red-6 bg-red-3 px-3 py-1.5 text-caption1 text-red-11"
                  : "text-caption1 text-fg-muted"
              }
            >
              {p.error ? `${p.name} — ${p.error}` : `Uploading ${p.name}…`}
            </p>
          ))}
        </div>
      ) : null}

      <StorageBar />

      {media.length ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="relative min-w-0 flex-1 max-w-xs">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" />
            <Input
              value={view.search}
              onChange={(e) => setView({ ...view, search: e.target.value })}
              placeholder="Search"
              aria-label="Search the library"
              className="pl-8"
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
      ) : null}

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void send([...e.dataTransfer.files]);
        }}
        className={dragging ? "rounded-xl outline-2 outline-dashed outline-accent" : ""}
      >
        {loading ? (
          <p className="text-footnote text-fg-subtle">Loading…</p>
        ) : media.length === 0 ? (
          <EmptyState
            icon={<ImageIcon />}
            title="No media yet"
            hint="Drop graphics or video here, or press Upload. PNG, JPG, WebP, GIF, MP4 and WebM."
          />
        ) : shown.length === 0 ? (
          <EmptyState
            icon={<SearchIcon />}
            title="Nothing matches that"
            hint="Try a different search, or show everything."
          />
        ) : (
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(160px,1fr))]">
            {shown.map((m) => {
              // Once per card, not twice in one expression: each call walks
              // every playlist's items.
              const uses = usedBy(m, playlists);
              return (
              <div
                key={m.id}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, items: menuFor(m.id) });
                }}
                className="flex flex-col gap-1.5"
              >
                <div
                  role="button"
                  tabIndex={0}
                  aria-pressed={picked.has(m.id)}
                  onClick={(e) => setSelection(clickSelect(selection, order, m.id, modsOf(e)))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelection(clickSelect(selection, order, m.id, modsOf(e)));
                    }
                  }}
                  className={
                    picked.has(m.id)
                      ? "relative aspect-video cursor-pointer overflow-hidden rounded-lg border-2 border-accent bg-black"
                      : "relative aspect-video cursor-pointer overflow-hidden rounded-lg border-2 border-line bg-black"
                  }
                >
                  {/* No poster frame is generated: it would mean decoding on
                      the server. The clip's own first frame is enough — see
                      MediaThumb for how it is coaxed out of the element. */}
                  <MediaThumb media={m} />
                  {isSignageVideo(m.mime) && (
                    <span className="absolute bottom-1 left-1 flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-caption2 text-white">
                      <FilmIcon className="size-3" />
                      {m.durationMs ? duration(m.durationMs) : "video"}
                    </span>
                  )}
                  <Button
                    variant="transparent"
                    size="small"
                    iconOnly
                    tooltip={`Delete ${m.name}`}
                    onClick={() => void remove(m)}
                    className="absolute right-1 top-1 bg-black/60 text-white hover:bg-black/80"
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </div>

                {renaming === m.id ? (
                  <Input
                    autoFocus
                    defaultValue={m.name}
                    onBlur={(e) => void rename(m.id, e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void rename(m.id, e.currentTarget.value);
                      if (e.key === "Escape") setRenaming(null);
                    }}
                  />
                ) : (
                  <button
                    onClick={() => setRenaming(m.id)}
                    className="truncate text-left text-caption1 text-fg hover:underline"
                    title={`${m.name} — click to rename`}
                  >
                    {m.name}
                  </button>
                )}
                <span className="text-caption2 text-fg-subtle">
                  <span className={belowPanel(m) ? "text-amber-11" : undefined}>
                    {m.w} × {m.h}
                  </span>
                  {" · "}
                  {size(m.bytes)}
                  {/* Once, not twice: each call walks every playlist's items,
                      and this is per card per render. */}
                  {uses.length ? ` · in ${uses.length}` : ""}
                </span>
                {belowPanel(m) ? (
                  // The one place quality is actually lost. Nothing in the
                  // pipeline resizes a graphic — the server serves the bytes it
                  // was given — so a soft picture on the wall means the SOURCE
                  // was smaller than the panel, and there is nothing downstream
                  // that can fix it. Said here, where it can still be replaced.
                  <span className="text-caption2 text-amber-11">
                    Below 1080p — this will be upscaled on a normal screen
                  </span>
                ) : null}
              </div>
              );
            })}
          </div>
        )}
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}
