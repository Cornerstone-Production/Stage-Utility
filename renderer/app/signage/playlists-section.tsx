// playlists-section.tsx — build a playlist and watch it play.
//
// The preview uses the SAME component a wall screen uses, fed the same shape the
// server will push, so what an operator approves here is what a display draws.
// A bespoke preview is how an editor comes to disagree with the wall.

import { useCallback, useMemo, useState } from "react";
import { GripVerticalIcon, ListVideoIcon, PlusIcon, RotateCcwIcon, Trash2Icon, XIcon } from "lucide-react";
import type {
  SignageFit,
  SignageGroup,
  SignageMedia,
  SignagePlaylist,
  SignageTransition,
  SignageTransitionKind,
} from "@main/types/signage";
import { DEFAULT_TRANSITION, MAX_TRANSITION_MS, isSignageVideo } from "@main/types/signage";
import { resolveItemDurations, trimOf } from "@main/services/signage-playlist-items";
// The SAME cycle length the wall computes. It was written out twice - the
// server-side copy said "mirrors the renderer's cycleMs" in its own doc comment
// - so the editor's "cycle: 32s" label and a display's position came from two
// functions with identical bodies.
import { cycleMs } from "../../main/signage-cycle";

import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import { Input } from "../../components/ui/input";
import { NumberInput } from "../../components/ui/number-input";
import { confirmDelete } from "./confirm-delete";
import { SelectField } from "./select-field";
import { SignagePlayer } from "../../main/signage-player";
import { invoke } from "../../lib/api";
import { uid } from "../../lib/uid";
import { useElapsed } from "./use-now";
import { toHorizonPlaylist } from "./preview-entry";
import { MediaPicker } from "./media-picker";
import { DraftFooter, useRegisterDraft } from "./unsaved-guard";
import { ContextMenu, type ContextMenuItem } from "../../components/ui/context-menu";
import { MediaThumb } from "./media-thumb";
import { TagPicker } from "./tag-picker";

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
  clipboard,
  groups,
  onCreateGroup,
}: {
  playlists: SignagePlaylist[];
  media: SignageMedia[];
  onChange: () => Promise<void>;
  /** Media ids copied on the Media tab, ready to paste into a playlist. */
  clipboard: string[];
  /** Every tag, for the "Default for" picker. */
  groups: SignageGroup[];
  /** Make a tag from inside the picker, so naming one does not mean leaving. */
  onCreateGroup: (name: string) => Promise<string | null>;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(playlists[0]?.id ?? null);
  const [draft, setDraft] = useState<SignagePlaylist | null>(null);
  const [picking, setPicking] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);

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
      id: uid("pl"),
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
      const ok = await confirmDelete(`${p.name}`, "Any schedule using it will say so rather than being deleted with it.");
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
  const cycle = cycleMs(resolved);
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

  /**
   * Tags this playlist claims that another playlist claims too.
   *
   * Reported rather than refused: two playlists defaulting for one set of
   * screens is something an operator legitimately wants. What they must not
   * have to guess is which one plays.
   */
  const conflicts = useMemo(() => {
    if (!editing) return [];
    const mine = editing.defaultForGroupIds ?? [];
    const out: { group: string; by: string; winning: boolean }[] = [];
    for (const gid of mine) {
      const claimants = playlists.filter((p) => (p.defaultForGroupIds ?? []).includes(gid));
      const others = claimants.filter((p) => p.id !== editing.id);
      if (others.length === 0) continue;
      // "Winning" is decided the way the resolver decides it: the first
      // claimant in playlist order.
      const first = claimants[0];
      out.push({
        group: groups.find((g) => g.id === gid)?.name ?? gid,
        by: others.map((p) => p.name).join(", "),
        winning: first?.id === editing.id,
      });
    }
    return out;
  }, [editing, playlists, groups]);

  // So switching tab asks instead of silently throwing the draft away.
  // The shared registration — see useDraft. It was written out here and in
  // the other section, character for character.
  const discardDraft = useCallback(() => setDraft(null), []);
  useRegisterDraft(draft, save, discardDraft);

  /** The menu for a right-click on a playlist row. */
  const menuFor = useCallback(
    (p: SignagePlaylist): ContextMenuItem[] => [
      {
        label: clipboard.length ? `Paste ${clipboard.length}` : "Paste",
        shortcut: "⌘V",
        // Disabled rather than hidden: an operator who just pressed Copy needs
        // to see that this is where it lands, even before there is anything in
        // it. A menu whose shape changes is a menu you have to re-read.
        disabled: clipboard.length === 0,
        onSelect: () => {
          const items = [...p.items, ...clipboard.map((mediaId) => ({ mediaId }))];
          void save({ ...p, items });
        },
      },
      { separator: true },
      {
        label: "Duplicate",
        onSelect: () =>
          void save({
            ...p,
            id: uid("pl"),
            name: `${p.name} copy`,
            createdAt: new Date().toISOString(),
          }),
      },
      { label: "Rename…", onSelect: () => {
        setSelectedId(p.id);
        setDraft({ ...p });
      } },
      { separator: true },
      { label: "Delete", danger: true, onSelect: () => void remove(p) },
    ],
    [clipboard, save, remove],
  );

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
                onContextMenu={(e) => {
                  e.preventDefault();
                  setSelectedId(p.id);
                  setMenu({ x: e.clientX, y: e.clientY, items: menuFor(p) });
                }}
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
                      {/* The shared thumbnail. This row used to build its own
                          and omitted the `#t=0.1` the other two carry, so every
                          clip in a playlist rendered as a black rectangle. */}
                      {m ? <MediaThumb media={m} /> : null}
                    </div>
                    <span className="min-w-0 flex-1 truncate text-footnote text-fg">
                      {m?.name ?? "Missing file"}
                    </span>
                    {video ? (
                      // Trim points, in seconds. Nothing is re-encoded and no
                      // file is touched — the player asks for a range of the
                      // same clip — so one video can be trimmed two different
                      // ways in two playlists and the library holds one copy.
                      (() => {
                        const clip = m?.durationMs ?? 0;
                        const t = trimOf(item, clip);
                        const trimmed = t.startMs > 0 || t.endMs < clip;
                        return (
                          <span className="flex items-center gap-1.5">
                            <NumberInput
                              value={Math.round(t.startMs / 1000)}
                              min={0}
                              max={Math.max(0, Math.round(clip / 1000))}
                              onChange={(v) => patchItem(i, { trimStartMs: v * 1000 })}
                              className="w-16"
                              aria-label={`Start ${m?.name ?? "clip"} at, in seconds`}
                            />
                            <span className="text-caption2 text-fg-subtle">to</span>
                            <NumberInput
                              value={Math.round(t.endMs / 1000)}
                              min={0}
                              max={Math.max(0, Math.round(clip / 1000))}
                              onChange={(v) => patchItem(i, { trimEndMs: v * 1000 })}
                              className="w-16"
                              aria-label={`End ${m?.name ?? "clip"} at, in seconds`}
                            />
                            <span
                              className={
                                t.durationMs <= 0
                                  ? "text-caption2 text-amber-11"
                                  : "text-caption2 text-fg-subtle"
                              }
                            >
                              {t.durationMs <= 0
                                ? "nothing left — this will be skipped"
                                : trimmed
                                  ? `${seconds(t.durationMs)} of ${seconds(clip)}`
                                  : `${seconds(clip)} clip`}
                            </span>
                            {trimmed ? (
                              <Button
                                size="small"
                                iconOnly
                                tooltip="Play the whole clip"
                                onClick={() =>
                                  patchItem(i, { trimStartMs: undefined, trimEndMs: undefined })
                                }
                              >
                                <RotateCcwIcon className="size-3.5" />
                              </Button>
                            ) : null}
                          </span>
                        );
                      })()
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

            {/* A picker, not a dropdown. A <select> of the whole library works
                at four files and falls apart at four hundred: no search, no
                thumbnail, and one item per trip. */}
            <Button className="self-start" onClick={() => setPicking(true)}>
              <PlusIcon className="size-3.5" />
              Add media
            </Button>

            <MediaPicker
              open={picking}
              onOpenChange={setPicking}
              media={media}
              destination={editing.name}
              onAdd={(ids) =>
                setDraft({ ...editing, items: [...editing.items, ...ids.map((mediaId) => ({ mediaId }))] })
              }
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
                // "Fit" and "Fill", with no explanation. The words carry it —
                // and the preview above shows the answer immediately, which is
                // a better explanation than a sentence in a dropdown.
                { value: "contain", label: "Fit" },
                { value: "cover", label: "Fill" },
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

            {/* Where the offline story is configured, and the fallback when no
                schedule matches. On the playlist rather than on the tag because
                this is the moment an operator decides it: they have just built
                the loop. */}
            <div className="flex flex-col gap-1">
              <span className="text-caption1 text-fg-muted">Default for</span>
              <TagPicker
                groups={groups}
                selected={editing.defaultForGroupIds ?? []}
                onChange={(next) => patch({ defaultForGroupIds: next })}
                onCreate={onCreateGroup}
                placeholder="No screens"
              />
              <span className="text-caption2 text-fg-subtle">
                Played on these screens when no schedule matches, and by a screen that starts up
                with no server.
              </span>
              {conflicts.length ? (
                // Allowed on purpose — a weekend loop and a youth loop on the
                // same foyer screens is a real thing to want. But the operator
                // has to be told which one actually plays, and the answer is
                // list order, which they can see and change.
                <span className="text-caption2 text-amber-11">
                  {conflicts.map((c) => `${c.group} is also claimed by ${c.by}`).join("; ")}.
                  {" "}
                  {conflicts.every((c) => c.winning)
                    ? "This one is higher in the list, so it wins."
                    : "The one higher in the list wins."}
                </span>
              ) : null}
            </div>

            {draft ? (
              <DraftFooter onSave={() => void save(draft)} onDiscard={discardDraft} />
            ) : null}
          </div>
        </>
      )}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}
