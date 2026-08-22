// groups-section.tsx — named sets of signage screens.
//
// A display can be in any number of groups, and nothing here decides what
// happens when two of them disagree: the SCHEDULE list order does. Keeping that
// rule in one place is why this section has no priority control of its own.
//
// "Add displays" will create the signage View and route the output if it has to,
// so a screen never has to be set up in two places before it can show anything.

import { useCallback, useMemo, useState } from "react";
import { MonitorPlayIcon, PlusIcon, Trash2Icon } from "lucide-react";
import type { Output, View } from "@main/types/stage";
import type { SignageGroup, SignagePlaylist } from "@main/types/signage";

import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { EmptyState } from "../../components/ui/empty-state";
import { Input } from "../../components/ui/input";
import { confirm } from "../../components/ui/confirm-dialog";
import { invoke } from "../../lib/api";
import { newSignageId } from "./ids";
import { SelectField } from "./select-field";

const NO_DEFAULT = "__none__";

export function GroupsSection({
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
  const [busy, setBusy] = useState(false);

  // A screen is signage-capable when the View it is routed to is a signage View.
  const signageViewIds = useMemo(
    () => new Set(views.filter((v) => v.kind === "signage").map((v) => v.id)),
    [views],
  );
  const signageOutputs = useMemo(
    () => outputs.filter((o) => o.viewId && signageViewIds.has(o.viewId)),
    [outputs, signageViewIds],
  );
  const otherOutputs = useMemo(
    () => outputs.filter((o) => !o.viewId || !signageViewIds.has(o.viewId)),
    [outputs, signageViewIds],
  );

  const save = useCallback(
    async (group: SignageGroup) => {
      await invoke("signage:saveGroup", { group });
      await onChange();
    },
    [onChange],
  );

  const create = useCallback(async () => {
    await save({
      id: newSignageId("gr"),
      name: "New group",
      outputIds: [],
      createdAt: new Date().toISOString(),
    });
  }, [save]);

  const remove = useCallback(
    async (g: SignageGroup) => {
      const ok = await confirm({
        title: `Delete ${g.name}?`,
        message: "Any schedule targeting it will say so rather than being deleted with it.",
        confirmLabel: "Delete",
        destructive: true,
      });
      if (!ok) return;
      await invoke("signage:deleteGroup", { id: g.id });
      await onChange();
    },
    [onChange],
  );

  /** Route an output to a signage View, making one if none exists yet. */
  const makeSignage = useCallback(
    async (output: Output) => {
      setBusy(true);
      try {
        let viewId = views.find((v) => v.kind === "signage")?.id ?? null;
        if (!viewId) {
          // Reuses the existing view/output channels rather than adding
          // signage-specific ones: this is exactly what Screens does, and a
          // second path to route an output is a second path to get it wrong.
          //
          // POST /api/views answers with the whole StageState, not the created
          // view - so the id is read back out of it. Assuming it returned the
          // view left viewId undefined, which the PATCH below then rejected with
          // "body.viewId (string|null) ... required".
          const state = await invoke<{ views: View[] }>("views:add", {
            name: "Signage",
            kind: "signage",
          });
          viewId = state.views.find((v) => v.kind === "signage")?.id ?? null;
          if (!viewId) throw new Error("the Signage view was not created");
        }
        await invoke("outputs:setView", { id: output.id, viewId });
        await onChange();
      } finally {
        setBusy(false);
      }
    },
    [views, onChange],
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-headline text-fg">Groups</h2>
          <p className="text-caption1 text-fg-subtle">
            A screen can be in any number of groups. Which schedule wins is decided by the schedule
            list, not by the groups.
          </p>
        </div>
        <Button variant="accent" onClick={() => void create()}>
          <PlusIcon className="size-4" />
          New group
        </Button>
      </div>

      {groups.length === 0 ? (
        <EmptyState
          icon={<MonitorPlayIcon />}
          title="No groups yet"
          hint="A group is a set of screens you schedule together — a foyer, a hallway, a lobby."
        />
      ) : (
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
          {groups.map((g) => (
            <div key={g.id} className="flex flex-col gap-3 rounded-xl border border-line bg-surface-raised p-3">
              <div className="flex items-center gap-2">
                <Input
                  value={g.name}
                  onChange={(e) => void save({ ...g, name: e.target.value })}
                  className="min-w-0 flex-1"
                />
                <Button size="small" iconOnly tooltip={`Delete ${g.name}`} onClick={() => void remove(g)}>
                  <Trash2Icon className="size-3.5" />
                </Button>
              </div>

              <div className="flex flex-col gap-1">
                <span className="text-caption1 text-fg-muted">Screens</span>
                {signageOutputs.length === 0 ? (
                  <p className="text-caption2 text-fg-subtle">
                    No screens are set to signage yet. Turn one on below.
                  </p>
                ) : (
                  signageOutputs.map((o) => (
                    <label key={o.id} className="flex items-center gap-2 text-footnote text-fg">
                      <Checkbox
                        checked={g.outputIds.includes(o.id)}
                        onCheckedChange={(on) =>
                          void save({
                            ...g,
                            outputIds: on
                              ? [...g.outputIds, o.id]
                              : g.outputIds.filter((id) => id !== o.id),
                          })
                        }
                      />
                      <span className="truncate">{o.name}</span>
                    </label>
                  ))
                )}
              </div>

              <SelectField
                label="Default playlist"
                value={g.defaultPlaylistId ?? NO_DEFAULT}
                onChange={(v) =>
                  void save({ ...g, defaultPlaylistId: v === NO_DEFAULT ? null : v })
                }
                options={[
                  { value: NO_DEFAULT, label: "None — go black" },
                  ...playlists.map((p) => ({ value: p.id, label: p.name })),
                ]}
              />
              <p className="text-caption2 text-fg-subtle">
                Played when no schedule matches, and by a screen that starts up with no server.
              </p>
            </div>
          ))}
        </div>
      )}

      {otherOutputs.length ? (
        <div className="flex flex-col gap-2 border-t border-line pt-3">
          <span className="text-caption1 text-fg-muted">Turn a screen into a signage screen</span>
          <div className="flex flex-wrap gap-2">
            {otherOutputs.map((o) => (
              <Button key={o.id} size="small" disabled={busy} onClick={() => void makeSignage(o)}>
                {o.name}
              </Button>
            ))}
          </div>
          <p className="text-caption2 text-fg-subtle">
            This routes the screen to a Signage view, making one if this install does not have one
            yet. Its previous view is not deleted.
          </p>
        </div>
      ) : null}
    </div>
  );
}
