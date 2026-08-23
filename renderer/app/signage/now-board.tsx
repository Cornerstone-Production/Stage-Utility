// now-board.tsx — what every signage SCREEN is playing, and why.
//
// A card per screen, not per tag. Content is resolved per OUTPUT — that is the
// whole shape of this feature — so there is no such thing as "what a tag is
// playing", and a card that claimed to show one had to pick a member and stand
// it in for the rest. With one screen carrying two tags it was not an
// approximation, it was wrong: a tag's card showed neither of the things its
// screens were showing, because the member it read happened to be driven by the
// OTHER tag's schedule. And when that member was a screen someone had since
// deleted, the card was simply blank.
//
// So the preview is the display, and the picker on it assigns TAGS TO A SCREEN —
// the same direction as the Screens page, and the same component. Assignment
// running one way here and the other way there was two mental models for one
// relationship.
//
// Taking over stays per TAG, above the grid. "Put the announcement on the foyer"
// is a per-tag action by nature, it is per-group in the data model, and burying
// it on one card among twelve is the wrong place for the control you reach for
// when something is wrong.
//
// It is also where anything wrong gets SAID. A stale PCO window and an empty
// playlist both degrade quietly by design — the window keeps working, the
// playlist falls through — and this is the only place an operator finds out.

import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MonitorPlayIcon } from "lucide-react";
import type { Output, View } from "@main/types/stage";
import type {
  SignageGroup,
  SignageOverride,
  SignagePlaylist,
} from "@main/types/signage";

import { errorMessage } from "@main/services/errors";
import { Button } from "../../components/ui/button";
import { ButtonGroup } from "../../components/ui/button-group";
import { EmptyState } from "../../components/ui/empty-state";
import { toast } from "../../components/ui/toast";
import { confirmDelete } from "./confirm-delete";
import { SignagePlayer } from "../../main/signage-player";
import { invoke } from "../../lib/api";
import { SelectField } from "./select-field";
import { PrepareOffline } from "./prepare-offline";
import { ScreenMenu } from "./screen-menu";
import { formatClock } from "../../lib/clock-format";
import { TagPicker } from "./tag-picker";
import { boardEntry } from "./board-entry";
import { SIGNAGE_NOW_KEY, SIGNAGE_OVERRIDES_KEY , type SignageNow } from "./use-signage-config";
import { useNow } from "./use-now";

const PICK = "__pick__";

export function NowBoard({
  groups,
  playlists,
  outputs,
  views,
  onChange,
  onCreateGroup,
}: {
  groups: SignageGroup[];
  playlists: SignagePlaylist[];
  outputs: Output[];
  views: View[];
  onChange: () => Promise<void>;
  onCreateGroup: (name: string) => Promise<string | null>;
}) {
  // 100ms, because these previews run the real player and a transition is 600ms.
  const now = useNow(100);
  const [busy, setBusy] = useState(false);
  const [takeOverTag, setTakeOverTag] = useState<string>(PICK);
  /** Show what a push WOULD do, rather than what is on the walls. */
  const [previewingDraft, setPreviewingDraft] = useState(false);

  /** A screen is signage-capable when the View it is routed to is a signage View. */
  const signageViewIds = useMemo(
    () => new Set(views.filter((v) => v.kind === "signage").map((v) => v.id)),
    [views],
  );

  const { data } = useQuery({
    queryKey: SIGNAGE_NOW_KEY,
    queryFn: () => invoke<SignageNow>("signage:now"),
    refetchInterval: 5000,
  });
  const { data: overrideData } = useQuery({
    queryKey: SIGNAGE_OVERRIDES_KEY,
    queryFn: () => invoke<{ overrides: SignageOverride[] }>("signage:listOverrides"),
    refetchInterval: 5000,
  });

  const signageOutputs = useMemo(
    () => outputs.filter((o) => o.viewId && signageViewIds.has(o.viewId)),
    [outputs, signageViewIds],
  );
  const overrides = overrideData?.overrides ?? [];

  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      try {
        await fn();
        await onChange();
      } catch (err) {
        // Said out loud. A take-over that failed silently leaves the operator
        // watching a wall that never changes.
        toast.error(errorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [onChange],
  );

  /** Put this screen in exactly these tags, writing only what changed. */
  const setTags = useCallback(
    async (outputId: string, next: string[]) => {
      const want = new Set(next);
      // Only the tags whose membership actually changed are written. Saving
      // every one on every edit would rewrite the whole store, and each write
      // recomputes the horizon for every screen in the building.
      const changed = groups.filter((g) => g.outputIds.includes(outputId) !== want.has(g.id));
      await act(async () => {
        for (const g of changed) {
          const outputIds = want.has(g.id)
            ? [...g.outputIds, outputId]
            : g.outputIds.filter((id) => id !== outputId);
          await invoke("signage:saveGroup", { group: { ...g, outputIds } });
        }
      });
    },
    [groups, act],
  );

  /** Make a tag with this screen already in it — see TagPicker. */
  const createTagFor = useCallback(
    async (outputId: string, name: string): Promise<string | null> => {
      const id = await onCreateGroup(name);
      if (!id) return null;
      await act(() =>
        invoke("signage:saveGroup", {
          group: { id, name, outputIds: [outputId], createdAt: new Date().toISOString() },
        }),
      );
      return id;
    },
    [onCreateGroup, act],
  );

  const renameTag = useCallback(
    async (id: string, name: string) => {
      const g = groups.find((x) => x.id === id);
      if (!g) return;
      await act(() => invoke("signage:saveGroup", { group: { ...g, name } }));
    },
    [groups, act],
  );

  /** Delete a tag. Named so the confirmation can say what it costs. */
  const deleteTag = useCallback(
    async (g: SignageGroup) => {
      const usedBy = playlists.filter((p) => (p.defaultForGroupIds ?? []).includes(g.id));
      const ok = await confirmDelete(`${g.name}`, [
          g.outputIds.length
            ? `${g.outputIds.length} ${g.outputIds.length === 1 ? "screen stops" : "screens stop"} carrying it.`
            : "No screens carry it.",
          usedBy.length ? `${usedBy.map((p) => p.name).join(", ")} will no longer be a default for anything.` : "",
          "Any schedule targeting it will say so rather than being deleted with it.",
        ]
          .filter(Boolean)
          .join(" "));
      if (ok) await act(() => invoke("signage:deleteGroup", { id: g.id }));
    },
    [playlists, act],
  );

  if (signageOutputs.length === 0) {
    return (
      <EmptyState
        icon={<MonitorPlayIcon />}
        title="No signage screens yet"
        hint="Add a screen under Screens and choose Signage. This is where you will see what each one is playing."
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {data?.staleWindows ? (
        <p className="rounded-lg border border-amber-6 bg-amber-3 px-3 py-2 text-footnote text-amber-11">
          Planning Center is unreachable, so PCO-driven schedules are running on the last plan times
          this server fetched. They keep working; they may be out of date.
          {data.pcoError ? ` (${data.pcoError})` : ""}
        </p>
      ) : null}

      {/* Every active take-over, named, with the way out of it. A forgotten one
          is otherwise a wall that mysteriously ignores its schedule. */}
      {overrides.length ? (
        <div className="flex flex-col gap-1.5 rounded-lg border border-amber-6 bg-amber-3 px-3 py-2">
          {overrides.map((o) => {
            const g = groups.find((x) => x.id === o.groupId);
            const p = playlists.find((x) => x.id === o.playlistId);
            return (
              <div key={o.groupId} className="flex items-center gap-2 text-footnote text-amber-11">
                <span>
                  <strong className="text-fg">{g?.name ?? o.groupId}</strong> is taken over —{" "}
                  {o.blank ? "blanked" : `playing ${p?.name ?? o.playlistId}`}. It beats every
                  schedule until released.
                </span>
                <Button
                  size="small"
                  disabled={busy}
                  className="ml-auto"
                  onClick={() => void act(() => invoke("signage:clearOverride", { groupId: o.groupId }))}
                >
                  Release
                </Button>
              </div>
            );
          })}
        </div>
      ) : null}

      {/* Taking over is per TAG, and it lives here rather than on a card: it is
          the control you reach for when something is wrong, and it acts on a set
          of screens, not on the one you happen to be looking at. */}
      {groups.length ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface-raised px-3 py-2">
          <span className="text-footnote text-fg">Take over</span>
          <SelectField
            label="Tag to take over"
            hideLabel
            value={takeOverTag}
            onChange={setTakeOverTag}
            options={[
              { value: PICK, label: "Which screens…" },
              ...groups.map((g) => ({
                value: g.id,
                label: `${g.name} (${g.outputIds.length})`,
              })),
            ]}
          />
          <SelectField
            label="Playlist to take over with"
            hideLabel
            value={PICK}
            placeholder="with…"
            onChange={(v) => {
              if (v === PICK || takeOverTag === PICK) return;
              void act(() => invoke("signage:setOverride", { groupId: takeOverTag, playlistId: v }));
            }}
            options={[
              { value: PICK, label: "with…" },
              ...playlists.map((p) => ({ value: p.id, label: p.name })),
            ]}
          />
          <Button
            size="small"
            disabled={busy || takeOverTag === PICK}
            onClick={() =>
              void act(() => invoke("signage:setOverride", { groupId: takeOverTag, blank: true }))
            }
          >
            Blank them
          </Button>
          {takeOverTag === PICK ? (
            <span className="text-caption2 text-fg-subtle">
              Beats every schedule on those screens until released.
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Look at the pending edits without pushing them. The whole reason the
          gate exists is that a wall is not a preview surface — so the preview
          has to be here instead. */}
      {data?.draftHorizons ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface-raised px-3 py-2">
          <span className="text-footnote text-fg">Showing</span>
          <ButtonGroup>
            <Button
              size="small"
              variant={previewingDraft ? undefined : "accent"}
              onClick={() => setPreviewingDraft(false)}
            >
              On the screens
            </Button>
            <Button
              size="small"
              variant={previewingDraft ? "accent" : undefined}
              onClick={() => setPreviewingDraft(true)}
            >
              After a push
            </Button>
          </ButtonGroup>
          {previewingDraft ? (
            <span className="text-caption2 text-amber-11">
              This is not what the screens are playing.
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(270px,1fr))]">
        {signageOutputs.map((output) => {
          // THIS screen's own horizon. No stand-in, no first-member — which is
          // what makes the preview true rather than representative.
          const source = previewingDraft && data?.draftHorizons ? data.draftHorizons : data?.horizons;
          const entry = boardEntry(source?.[output.id] ?? [], now);
          const taken = entry?.reason === "override";
          const mine = groups.filter((g) => g.outputIds.includes(output.id)).map((g) => g.id);

          return (
            <div
              key={output.id}
              // Amber all the way round a taken-over screen. A wall of these is
              // scanned, not read, and the question is "which one am I holding?"
              className={
                taken
                  ? "flex flex-col gap-2.5 rounded-xl border-2 border-amber-6 bg-surface-raised p-3"
                  : "flex flex-col gap-2.5 rounded-xl border-2 border-line bg-surface-raised p-3"
              }
            >
              <div className="flex items-center justify-between gap-2">
                <h3 className="truncate text-callout font-medium text-fg">{output.name}</h3>
                <span
                  className={
                    taken
                      ? "shrink-0 rounded-full border border-amber-6 bg-amber-3 px-2 py-0.5 text-caption2 font-medium text-amber-11"
                      : "shrink-0 rounded-full border border-line px-2 py-0.5 text-caption2 text-fg-muted"
                  }
                >
                  {entry ? reasonWord(entry.reason) : "Blank"}
                </span>
                {/* Rename, rotation, open, reload, remove — the actions that
                    used to live on the Screens tab's duplicate row. */}
                <ScreenMenu output={output} onChanged={onChange} />
              </div>

              <div className="overflow-hidden rounded-lg border border-line">
                <SignagePlayer entry={entry} nowMs={now} className="block aspect-video w-full" />
              </div>

              <p className="text-caption1 text-fg-muted">
                {entry?.playlist ? entry.reasonLabel : "Nothing scheduled"}
                {entry && entry.until < Number.MAX_SAFE_INTEGER ? (
                  <span className="text-fg-subtle"> · until {formatClock(entry.until)}</span>
                ) : null}
              </p>

              {/* Tags go ON a screen — the same direction, and the same control,
                  as the Screens page. */}
              <TagPicker
                groups={groups}
                selected={mine}
                onChange={(next) => void setTags(output.id, next)}
                onCreate={(name) => createTagFor(output.id, name)}
                // Renaming and deleting a TAG live on its row in this picker.
                // With the Groups page gone the option list IS the list of tags,
                // and there is nowhere else that shows them all.
                onRename={renameTag}
                onDelete={deleteTag}
                placeholder="No tags"
                className="w-full"
              />

              {/* Caching is per BROWSER, so this has to be opened on the screen
                  itself — which is exactly where the card for that screen is
                  useful. It shipped with no mount point at all when the Groups
                  page was deleted, so the offline promise had no way to be
                  checked before a Pi left the building. */}
              <PrepareOffline outputId={output.id} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function reasonWord(reason: string): string {
  switch (reason) {
    case "schedule": return "Schedule";
    case "default": return "Tag default";
    case "override": return "Taken over";
    default: return "Blank";
  }
}


