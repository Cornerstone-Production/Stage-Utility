// now-board.tsx — what every group is playing, and why.
//
// Reads the resolver's own output rather than working it out again, so the board
// and a wall cannot disagree about which schedule is in charge. The preview uses
// the same player a display uses, fed the same entry.
//
// It is also where anything wrong gets SAID. A stale PCO window and an empty
// playlist both degrade quietly by design — the window keeps working, the
// playlist falls through — and this is the only place an operator finds out.

import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MonitorPlayIcon } from "lucide-react";
import type { Output, View } from "@main/types/stage";
import type { SignageGroup, SignageHorizon, SignageOverride, SignagePlaylist } from "@main/types/signage";

import { errorMessage } from "@main/services/errors";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import { toast } from "../../components/ui/toast";
import { SignagePlayer } from "../../main/signage-player";
import { invoke } from "../../lib/api";
import { SelectField } from "./select-field";
import { boardEntry } from "./board-entry";
import { ContextMenu, type ContextMenuItem } from "../../components/ui/context-menu";
import { MultiSelect } from "../../components/ui/multi-select";
import { confirm } from "../../components/ui/confirm-dialog";
import { Input } from "../../components/ui/input";
import { MoreHorizontalIcon } from "lucide-react";
import { SIGNAGE_NOW_KEY, SIGNAGE_OVERRIDES_KEY } from "./use-signage-config";
import { useNow } from "./use-now";

interface NowResponse {
  horizons: Record<string, SignageHorizon>;
  staleWindows: boolean;
  pcoError: string | null;
}

const TAKE_OVER = "__pick__";

export function NowBoard({
  groups,
  playlists,
  outputs,
  views,
  onChange,
}: {
  groups: SignageGroup[];
  playlists: SignagePlaylist[];
  outputs: Output[];
  views: View[];
  onChange: () => Promise<void>;
}) {
  // 100ms, because these previews run the real player and a transition is 600ms.
  const now = useNow(100);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  /** A screen is signage-capable when the View it is routed to is a signage View. */
  const signageViewIds = useMemo(
    () => new Set(views.filter((v) => v.kind === "signage").map((v) => v.id)),
    [views],
  );

  const { data } = useQuery({
    queryKey: SIGNAGE_NOW_KEY,
    queryFn: () => invoke<NowResponse>("signage:now"),
    refetchInterval: 5000,
  });
  const { data: overrideData } = useQuery({
    queryKey: SIGNAGE_OVERRIDES_KEY,
    queryFn: () => invoke<{ overrides: SignageOverride[] }>("signage:listOverrides"),
    refetchInterval: 5000,
  });

  const outputName = useMemo(() => new Map(outputs.map((o) => [o.id, o.name])), [outputs]);
  // Only signage screens are offered. Tagging a slots display would make a card
  // that can never play anything, and the operator would have to work out why.
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

  const saveGroup = useCallback(
    async (group: SignageGroup) => act(() => invoke("signage:saveGroup", { group })),
    [act],
  );

  /** The menu for a right-click (or the three dots) on a group card.
   *
   *  This is where a tag is renamed, re-pointed at different screens, or
   *  deleted — the three things the Groups page used to exist for. Doing it on
   *  the card means doing it while looking at what that tag is playing. */
  const menuFor = useCallback(
    (g: SignageGroup): ContextMenuItem[] => [
      { label: "Rename…", onSelect: () => setRenaming(g.id) },
      { separator: true },
      {
        label: "Delete tag",
        danger: true,
        onSelect: () =>
          void (async () => {
            const ok = await confirm({
              title: `Delete ${g.name}?`,
              message:
                "Screens keep working — they stop carrying this tag. Any schedule targeting it will say so rather than being deleted with it.",
              confirmLabel: "Delete",
              destructive: true,
            });
            if (ok) await act(() => invoke("signage:deleteGroup", { id: g.id }));
          })(),
      },
    ],
    [act],
  );

  if (groups.length === 0) {
    return (
      <EmptyState
        icon={<MonitorPlayIcon />}
        title="No screen tags yet"
        hint="Tag a screen on the Screens page, or make a tag from a playlist's Default-for picker. This is where you will see what each one is playing."
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

      {overrides.length ? (
        <div className="flex flex-col gap-1.5 rounded-lg border border-amber-6 bg-amber-3 px-3 py-2">
          {overrides.map((o) => {
            const g = groups.find((x) => x.id === o.groupId);
            const p = playlists.find((x) => x.id === o.playlistId);
            return (
              <div key={o.groupId} className="flex items-center gap-2 text-footnote text-amber-11">
                <span>
                  <strong className="text-fg">{g?.name ?? o.groupId}</strong> is overridden —{" "}
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

      <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(270px,1fr))]">
        {groups.map((g) => {
          // Every screen in a group resolves the same way, so the first member
          // stands for the group. A group with no screens has nothing to show.
          const outputId = g.outputIds[0];
          const horizon = outputId ? (data?.horizons[outputId] ?? []) : [];
          // boardEntry, not a strict match: after any edit the server rebuilds
          // the horizon starting at ITS now, and a board clock a moment behind
          // that would blank every card until its next tick.
          const entry = boardEntry(horizon, now);
          const override = overrides.find((o) => o.groupId === g.id) ?? null;
          const overridden = override !== null;

          return (
            <div
              key={g.id}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, items: menuFor(g) });
              }}
              // Amber all the way round a taken-over card, not just on its pill.
              // A wall of these is scanned, not read, and the question being
              // asked is "which one am I holding?" — a border answers it from
              // across the room, a chip has to be found first.
              className={
                overridden
                  ? "flex flex-col gap-2.5 rounded-xl border-2 border-amber-6 bg-surface-raised p-3"
                  : "flex flex-col gap-2.5 rounded-xl border-2 border-line bg-surface-raised p-3"
              }
            >
              <div className="flex items-center justify-between gap-2">
                {renaming === g.id ? (
                  <Input
                    autoFocus
                    defaultValue={g.name}
                    onBlur={(e) => {
                      setRenaming(null);
                      const name = e.currentTarget.value.trim();
                      if (name && name !== g.name) void saveGroup({ ...g, name });
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                      if (e.key === "Escape") setRenaming(null);
                    }}
                  />
                ) : (
                  <h3 className="truncate text-callout font-medium text-fg">{g.name}</h3>
                )}
                <Button
                  variant="transparent"
                  size="small"
                  iconOnly
                  tooltip={`Edit ${g.name}`}
                  className="shrink-0"
                  onClick={(e) => {
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    setMenu({ x: r.left, y: r.bottom + 4, items: menuFor(g) });
                  }}
                >
                  <MoreHorizontalIcon className="size-3.5" />
                </Button>
                <span
                  className={
                    overridden
                      ? "shrink-0 rounded-full border border-amber-6 bg-amber-3 px-2 py-0.5 text-caption2 font-medium text-amber-11"
                      : "shrink-0 rounded-full border border-line px-2 py-0.5 text-caption2 text-fg-muted"
                  }
                >
                  {overridden ? "Override" : entry ? reasonWord(entry.reason) : "Blank"}
                </span>
              </div>

              <div className="overflow-hidden rounded-lg border border-line">
                <SignagePlayer entry={entry} nowMs={now} className="block aspect-video w-full" />
              </div>

              <p className="text-caption1 text-fg-muted">
                {entry?.playlist ? entry.reasonLabel : "Nothing scheduled"}
                {entry && entry.until < Number.MAX_SAFE_INTEGER ? (
                  <span className="text-fg-subtle"> · until {clock(entry.until)}</span>
                ) : null}
              </p>

              {/* The screens carrying this tag, and the control that changes
                  them. Editable here because this is the card that shows what
                  the tag is playing — the question "should that screen be in
                  this?" is asked while looking at it, not on another page. */}
              <MultiSelect
                options={signageOutputs.map((o) => ({ value: o.id, label: o.name }))}
                selected={g.outputIds}
                onChange={(outputIds) => void saveGroup({ ...g, outputIds })}
                placeholder="No screens"
                summary={
                  g.outputIds.length === 0
                    ? "No screens"
                    : g.outputIds.length === 1
                      ? (outputName.get(g.outputIds[0]) ?? g.outputIds[0])
                      : `${g.outputIds.length} screens`
                }
                searchable={signageOutputs.length > 8}
                className="w-full"
              />

              <div className="flex items-center gap-1.5">
                {/* Shows what is ACTUALLY taken over, not a standing invitation.
                    Reading "Take over with…" while a group is held is the
                    control disagreeing with the wall, and the operator's next
                    move is to pick the same playlist again to be sure. */}
                <SelectField
                  label="Take over"
                  hideLabel
                  value={override && !override.blank ? (override.playlistId ?? TAKE_OVER) : TAKE_OVER}
                  placeholder="Take over"
                  onChange={(v) => {
                    if (v === TAKE_OVER) return;
                    void act(() => invoke("signage:setOverride", { groupId: g.id, playlistId: v }));
                  }}
                  options={[
                    { value: TAKE_OVER, label: "Take over with…" },
                    ...playlists.map((p) => ({ value: p.id, label: p.name })),
                  ]}
                  className="min-w-0 flex-1"
                />
                <Button
                  size="small"
                  // Blank is a take-over too, so it reads as held rather than as
                  // something still to press.
                  variant={override?.blank ? "accent" : undefined}
                  disabled={busy}
                  onClick={() => void act(() => invoke("signage:setOverride", { groupId: g.id, blank: true }))}
                >
                  Blank
                </Button>
                {overridden ? (
                  <Button
                    size="small"
                    disabled={busy}
                    onClick={() => void act(() => invoke("signage:clearOverride", { groupId: g.id }))}
                  >
                    Release
                  </Button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}

function reasonWord(reason: string): string {
  switch (reason) {
    case "schedule": return "Schedule";
    case "default": return "Group default";
    case "override": return "Override";
    default: return "Blank";
  }
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
