// media-section.tsx — the media library grid.
//
// Uploading is the only place in the app that sends raw bytes, so it carries its
// own progress and error state per file rather than going through the shared
// query layer. A failure names the file it belongs to: dropping eight graphics
// and getting one unattributed "upload failed" is useless.

import { useCallback, useRef, useState } from "react";
import { FilmIcon, ImageIcon, Trash2Icon, UploadIcon } from "lucide-react";
import type { SignageMedia, SignagePlaylist } from "@main/types/signage";
import { isSignageVideo } from "@main/types/signage";

import { errorMessage } from "@main/services/errors";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import { Input } from "../../components/ui/input";
import { confirm } from "../../components/ui/confirm-dialog";
import { invoke } from "../../lib/api";
import { size } from "./format";
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
}: {
  media: SignageMedia[];
  playlists: SignagePlaylist[];
  loading: boolean;
  onChange: () => Promise<void>;
}) {
  const [pending, setPending] = useState<Pending[]>([]);
  const [dragging, setDragging] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

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
      const ok = await confirm({
        title: `Delete ${m.name}?`,
        message: uses.length
          ? `It is in ${uses.join(", ")}. Deleting removes it from ${uses.length === 1 ? "that playlist" : "those playlists"}.`
          : "It is not in any playlist.",
        confirmLabel: "Delete",
        destructive: true,
      });
      if (!ok) return;
      await invoke("signage:deleteMedia", { id: m.id });
      await onChange();
    },
    [playlists, onChange],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-headline text-fg">Media library</h2>
          <p className="text-caption1 text-fg-subtle">
            {media.length} {media.length === 1 ? "item" : "items"} ·{" "}
            {size(media.reduce((n, m) => n + m.bytes, 0))} · deduplicated on upload
          </p>
        </div>
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
        ) : (
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(160px,1fr))]">
            {media.map((m) => (
              <div key={m.id} className="flex flex-col gap-1.5">
                <div className="relative aspect-video overflow-hidden rounded-lg border border-line bg-black">
                  {isSignageVideo(m.mime) ? (
                    <>
                      {/* No poster frame is generated: it would mean decoding on
                          the server. The clip's own first frame is enough. */}
                      <video
                        src={`/signage-media/${m.file}`}
                        muted
                        playsInline
                        preload="metadata"
                        className="size-full object-contain"
                      />
                      <span className="absolute bottom-1 left-1 flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-caption2 text-white">
                        <FilmIcon className="size-3" />
                        {m.durationMs ? duration(m.durationMs) : "video"}
                      </span>
                    </>
                  ) : (
                    <img
                      src={`/signage-media/${m.file}`}
                      alt=""
                      className="size-full object-contain"
                      loading="lazy"
                    />
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
                  {usedBy(m, playlists).length ? ` · in ${usedBy(m, playlists).length}` : ""}
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
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
