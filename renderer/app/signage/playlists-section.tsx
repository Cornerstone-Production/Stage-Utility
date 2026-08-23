// playlists-section.tsx — build a playlist and watch it play.
//
// The preview uses the SAME component a wall screen uses, fed the same shape the
// server will push, so what an operator approves here is what a display draws.
// A bespoke preview is how an editor comes to disagree with the wall.

import { useCallback, useMemo, useState } from "react";
import { GripVerticalIcon, ListVideoIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import type {
  SignageFit,
  SignageMedia,
  SignagePlaylist,
  SignageTransition,
  SignageTransitionKind,
} from "@main/types/signage";
import { DEFAULT_TRANSITION, MAX_TRANSITION_MS, isSignageVideo } from "@main/types/signage";
import { resolveItemDurations, resolvedCycleMs } from "@main/services/signage-playlist-items";

import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import { Input } from "../../components/ui/input";
import { NumberInput } from "../../components/ui/number-input";
import { confirm } from "../../components/ui/confirm-dialog";
import { SelectField } from "./select-field";
import { SignagePlayer } from "../../main/signage-player";
import { invoke } from "../../lib/api";
import { newSignageId } from "./ids";
import { useElapsed } from "./use-now";
import { toHorizonPlaylist } from "./preview-entry";

const KINDS: { value: SignageTransitionKind; label: string }[] = [
  { value: "cut", label: "Cut" },
  { value: "crossfade", label: "Crossfade" },
  { value: "fade-through-black", label: "Fade through black" },
  { value: "slide", label: "Slide" },
  { value: "wipe", label: "Wipe" },
];

const DIRECTIONS = [
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
  { value: "up", label: "Up" },
  { value: "down", label: "Down" },
];

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)}s`;
}

export function PlaylistsSection({
  playlists,
  media,
  onChange,
}: {
  playlists: SignagePlaylist[];
  media: SignageMedia[];
  onChange: () => Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(playlists[0]?.id ?? null);
  const [draft, setDraft] = useState<SignagePlaylist | null>(null);

  const selected = playlists.find((p) => p.id === selectedId) ?? null;

  // The preview's OWN clock, counting from when this playlist was opened rather
  // than from the epoch. A tenth of a second, because a transition is 600ms.
  //
  // Not the wall clock: positioned by `Date.now() % cycleMs`, every press of the
  // duration stepper landed on an unrelated item and holding it flipped through
  // the playlist. See useElapsed.
  const now = useElapsed(selectedId, 100);

  // Editing works on a draft so a half-made change is never pushed to a wall.
  const editing = draft ?? selected;

  const save = useCallback(
    async (playlist: SignagePlaylist) => {
      await invoke("signage:savePlaylist", { playlist });
      setDraft(null);
      await onChange();
    },
    [onChange],
  );

  const create = useCallback(async () => {
    const playlist: SignagePlaylist = {
      id: newSignageId("pl"),
      name: "New playlist",
      items: [],
      defaultDurationMs: 8000,
      fit: "contain",
      transition: DEFAULT_TRANSITION,
      createdAt: new Date().toISOString(),
    };
    await save(playlist);
    setSelectedId(playlist.id);
  }, [save]);

  const remove = useCallback(
    async (p: SignagePlaylist) => {
      const ok = await confirm({
        title: `Delete ${p.name}?`,
        message: "Any schedule using it will say so rather than being deleted with it.",
        confirmLabel: "Delete",
        destructive: true,
      });
      if (!ok) return;
      await invoke("signage:deletePlaylist", { id: p.id });
      setSelectedId(null);
      setDraft(null);
      await onChange();
    },
    [onChange],
  );

  const resolved = useMemo(
    () => (editing ? resolveItemDurations(editing, media) : []),
    [editing, media],
  );
  const cycle = resolvedCycleMs(resolved);
  const dropped = editing ? editing.items.length - resolved.length : 0;

  // startedAt 0, because `now` above is already elapsed-since-opened.
  const previewEntry = useMemo(
    () => (resolved.length ? toHorizonPlaylist(editing as SignagePlaylist, resolved, 0) : null),
    [editing, resolved],
  );

  const patch = (change: Partial<SignagePlaylist>) => {
    if (!editing) return;
    setDraft({ ...editing, ...change });
  };

  const patchItem = (index: number, change: Record<string, unknown>) => {
    if (!editing) return;
    setDraft({
      ...editing,
      items: editing.items.map((it, i) => (i === index ? { ...it, ...change } : it)),
    });
  };

  const move = (from: number, to: number) => {
    if (!editing || to < 0 || to >= editing.items.length) return;
    const items = [...editing.items];
    const [moved] = items.splice(from, 1);
    items.splice(to, 0, moved);
    setDraft({ ...editing, items });
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[240px_1fr_320px]">
      {/* ── the playlists ── */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="text-headline text-fg">Playlists</h2>
          <Button size="small" onClick={() => void create()}>
            <PlusIcon className="size-3.5" />
            New
          </Button>
        </div>
        {playlists.length === 0 ? (
          <p className="text-caption1 text-fg-subtle">None yet.</p>
        ) : (
          <div className="flex flex-col gap-1">
            {playlists.map((p) => (
              <button
                key={p.id}
                onClick={() => {
                  setSelectedId(p.id);
                  setDraft(null);
                }}
                className={
                  p.id === selectedId
                    ? "rounded-lg bg-fill px-2.5 py-1.5 text-left text-footnote font-medium text-fg"
                    : "rounded-lg px-2.5 py-1.5 text-left text-footnote text-fg-muted transition-colors hover:bg-fill-hover hover:text-fg"
                }
              >
                <span className="block truncate">{p.name}</span>
                <span className="block text-caption2 text-fg-subtle">
                  {p.items.length} {p.items.length === 1 ? "item" : "items"}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── its items ── */}
      {!editing ? (
        <EmptyState
          icon={<ListVideoIcon />}
          title="No playlist selected"
          hint="Pick one on the left, or make a new one."
          className="lg:col-span-2"
        />
      ) : (
        <>
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <Input
                value={editing.name}
                onChange={(e) => patch({ name: e.target.value })}
                className="max-w-xs"
              />
              <span className="text-caption1 text-fg-subtle">
                {resolved.length} {resolved.length === 1 ? "item" : "items"} · {seconds(cycle)} cycle
              </span>
              <Button
                size="small"
                iconOnly
                tooltip={`Delete ${editing.name}`}
                onClick={() => void remove(editing)}
                className="ml-auto"
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            </div>

            {dropped > 0 ? (
              <p className="rounded-md border border-amber-6 bg-amber-3 px-3 py-1.5 text-caption1 text-amber-11">
                {dropped} {dropped === 1 ? "item is" : "items are"} missing their file and will be
                skipped.
              </p>
            ) : null}

            <div className="flex flex-col gap-1.5">
              {editing.items.map((item, i) => {
                const m = media.find((x) => x.id === item.mediaId);
                const video = m ? isSignageVideo(m.mime) : false;
                return (
                  <div
                    key={`${item.mediaId}-${i}`}
                    className="flex items-center gap-2 rounded-lg border border-line bg-surface-raised px-2 py-1.5"
                  >
                    {/* Keyboard-reachable reordering. A drag handle alone is not
                        operable without a mouse. */}
                    <div className="flex flex-col">
                      <button
                        aria-label="Move up"
                        onClick={() => move(i, i - 1)}
                        disabled={i === 0}
                        className="text-fg-faint hover:text-fg disabled:opacity-30"
                      >
                        <GripVerticalIcon className="size-3.5 rotate-90" />
                      </button>
                    </div>
                    <div className="relative aspect-video w-14 shrink-0 overflow-hidden rounded bg-black">
                      {m ? (
                        video ? (
                          <video src={`/signage-media/${m.file}`} muted className="size-full object-contain" />
                        ) : (
                          <img src={`/signage-media/${m.file}`} alt="" className="size-full object-contain" />
                        )
                      ) : null}
                    </div>
                    <span className="min-w-0 flex-1 truncate text-footnote text-fg">
                      {m?.name ?? "Missing file"}
                    </span>
                    {video ? (
                      <span className="text-caption1 text-fg-subtle">
                        {m?.durationMs ? seconds(m.durationMs) : "—"} · clip length
                      </span>
                    ) : (
                      <NumberInput
                        value={Math.round((item.durationMs ?? editing.defaultDurationMs) / 1000)}
                        min={1}
                        max={3600}
                        onChange={(v) => patchItem(i, { durationMs: v * 1000 })}
                        className="w-20"
                        aria-label={`Seconds for ${m?.name ?? "item"}`}
                      />
                    )}
                    <Button
                      size="small"
                      iconOnly
                      tooltip="Remove from playlist"
                      onClick={() =>
                        setDraft({ ...editing, items: editing.items.filter((_, j) => j !== i) })
                      }
                    >
                      <XIcon className="size-3.5" />
                    </Button>
                  </div>
                );
              })}
            </div>

            <SelectField
              label="Add media"
              value=""
              placeholder="Pick a graphic or clip"
              onChange={(v) => {
                if (!v) return;
                setDraft({ ...editing, items: [...editing.items, { mediaId: v }] });
              }}
              options={media.map((m) => ({ value: m.id, label: m.name }))}
              className="max-w-xs"
            />
          </div>

          {/* ── how it plays ── */}
          <div className="flex flex-col gap-3">
            <div className="overflow-hidden rounded-lg border border-line">
              <SignagePlayer
                entry={previewEntry}
                nowMs={now}
                className="block aspect-video w-full"
              />
            </div>

            <label className="flex flex-col gap-1">
              <span className="text-caption1 text-fg-muted">Default seconds per graphic</span>
              <NumberInput
                value={Math.round(editing.defaultDurationMs / 1000)}
                min={1}
                max={3600}
                onChange={(v) => patch({ defaultDurationMs: v * 1000 })}
              />
            </label>

            <SelectField
              label="Fit"
              value={editing.fit}
              onChange={(v) => patch({ fit: v as SignageFit })}
              options={[
                { value: "contain", label: "Contain - whole graphic, black bars" },
                { value: "cover", label: "Cover - fills the screen, crops" },
              ]}
            />

            <SelectField
              label="Transition"
              value={editing.transition.kind}
              onChange={(v) =>
                patch({ transition: { ...editing.transition, kind: v as SignageTransitionKind } })
              }
              options={KINDS}
            />

            {editing.transition.kind === "slide" || editing.transition.kind === "wipe" ? (
              <SelectField
                label="Direction"
                value={editing.transition.direction ?? "left"}
                onChange={(v) =>
                  patch({
                    transition: {
                      ...editing.transition,
                      direction: v as SignageTransition["direction"],
                    },
                  })
                }
                options={DIRECTIONS}
              />
            ) : null}

            {editing.transition.kind !== "cut" ? (
              <label className="flex flex-col gap-1">
                <span className="text-caption1 text-fg-muted">Transition milliseconds</span>
                <NumberInput
                  value={editing.transition.ms}
                  min={0}
                  max={MAX_TRANSITION_MS}
                  step={50}
                  onChange={(v) => patch({ transition: { ...editing.transition, ms: v } })}
                />
              </label>
            ) : null}

            {draft ? (
              <div className="flex gap-2">
                <Button variant="accent" onClick={() => void save(draft)}>
                  Save
                </Button>
                <Button onClick={() => setDraft(null)}>Discard</Button>
              </div>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
