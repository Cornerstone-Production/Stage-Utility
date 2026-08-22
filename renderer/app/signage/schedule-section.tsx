// schedule-section.tsx — the ordered schedule list.
//
// ORDER IS PRIORITY. When two schedules both match a display at the same moment,
// the one nearer the top wins, and nothing else decides it. That is why this is
// a list you drag rather than a table you sort: sorting by name or by time would
// hide the one property that actually determines what a wall shows.
//
// The row that is currently winning for each group is marked from the same
// resolver output the displays are using, so the page cannot disagree with the
// wall about which schedule is in charge.

import { useCallback, useMemo, useState } from "react";
import { CalendarClockIcon, ChevronDownIcon, ChevronUpIcon, PlusIcon, Trash2Icon } from "lucide-react";
import type { ServiceTypeDTO } from "@main/types/stage";
import type { SignageGroup, SignagePlaylist, SignageSchedule } from "@main/types/signage";

import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { EmptyState } from "../../components/ui/empty-state";
import { Input } from "../../components/ui/input";
import { Switch } from "../../components/ui/switch";
import { confirm } from "../../components/ui/confirm-dialog";
import { invoke } from "../../lib/api";
import { newSignageId } from "./ids";
import { SelectField } from "./select-field";
import { WindowEditor, describeWindow } from "./window-editor";

export function ScheduleSection({
  schedules,
  groups,
  playlists,
  serviceTypes,
  winningIds,
  onChange,
}: {
  schedules: SignageSchedule[];
  groups: SignageGroup[];
  playlists: SignagePlaylist[];
  serviceTypes: ServiceTypeDTO[];
  /** Schedule ids currently winning somewhere, from the resolver. */
  winningIds: Set<string>;
  onChange: () => Promise<void>;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState<SignageSchedule | null>(null);

  const playlistName = useMemo(
    () => new Map(playlists.map((p) => [p.id, p.name])),
    [playlists],
  );
  const groupName = useMemo(() => new Map(groups.map((g) => [g.id, g.name])), [groups]);

  const save = useCallback(
    async (schedule: SignageSchedule) => {
      await invoke("signage:saveSchedule", { schedule });
      setDraft(null);
      await onChange();
    },
    [onChange],
  );

  const create = useCallback(async () => {
    const schedule: SignageSchedule = {
      id: newSignageId("sc"),
      name: "New schedule",
      enabled: true,
      groupIds: [],
      playlistId: playlists[0]?.id ?? "",
      window: { kind: "weekly", days: [0], start: "05:00", end: "13:00" },
      createdAt: new Date().toISOString(),
    };
    await save(schedule);
    setOpenId(schedule.id);
  }, [playlists, save]);

  const remove = useCallback(
    async (s: SignageSchedule) => {
      const ok = await confirm({
        title: `Delete ${s.name}?`,
        message: "Screens it was driving fall through to whatever is next in the list.",
        confirmLabel: "Delete",
        destructive: true,
      });
      if (!ok) return;
      await invoke("signage:deleteSchedule", { id: s.id });
      await onChange();
    },
    [onChange],
  );

  /** Move a schedule up or down, which changes which one wins. */
  const move = useCallback(
    async (index: number, delta: number) => {
      const to = index + delta;
      if (to < 0 || to >= schedules.length) return;
      const ids = schedules.map((s) => s.id);
      const [moved] = ids.splice(index, 1);
      ids.splice(to, 0, moved);
      await invoke("signage:reorderSchedules", { ids });
      await onChange();
    },
    [schedules, onChange],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-headline text-fg">Schedule</h2>
          <p className="text-caption1 text-fg-subtle">
            The topmost matching schedule wins. Move one up to give it priority.
          </p>
        </div>
        <Button variant="accent" onClick={() => void create()}>
          <PlusIcon className="size-4" />
          New schedule
        </Button>
      </div>

      {schedules.length === 0 ? (
        <EmptyState
          icon={<CalendarClockIcon />}
          title="No schedules yet"
          hint="A schedule puts a playlist on a group of screens between certain times."
        />
      ) : (
        <div className="flex flex-col gap-1.5">
          {schedules.map((s, i) => {
            const editing = draft?.id === s.id ? draft : s;
            const open = openId === s.id;
            const winning = winningIds.has(s.id);
            return (
              <div
                key={s.id}
                className={
                  winning
                    ? "rounded-xl border border-live-9/45 bg-live-9/8 px-3 py-2"
                    : "rounded-xl border border-line bg-surface-raised px-3 py-2"
                }
              >
                <div className="flex items-center gap-2.5">
                  <span className="w-4 text-center font-mono text-caption2 text-fg-faint">{i + 1}</span>

                  {/* Reordering is the priority control, so it is on the row
                      rather than hidden in the editor. Buttons rather than a
                      drag handle alone: a handle is not operable by keyboard. */}
                  <div className="flex flex-col">
                    <button
                      aria-label={`Move ${s.name} up`}
                      disabled={i === 0}
                      onClick={() => void move(i, -1)}
                      className="text-fg-faint transition-colors hover:text-fg disabled:opacity-25"
                    >
                      <ChevronUpIcon className="size-3.5" />
                    </button>
                    <button
                      aria-label={`Move ${s.name} down`}
                      disabled={i === schedules.length - 1}
                      onClick={() => void move(i, 1)}
                      className="text-fg-faint transition-colors hover:text-fg disabled:opacity-25"
                    >
                      <ChevronDownIcon className="size-3.5" />
                    </button>
                  </div>

                  <button
                    onClick={() => setOpenId(open ? null : s.id)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="block truncate text-footnote font-medium text-fg">{s.name}</span>
                    <span className="block truncate text-caption2 text-fg-subtle">
                      {describeWindow(s.window)}
                      {" · "}
                      {playlistName.get(s.playlistId) ?? "no playlist"}
                      {" · "}
                      {s.groupIds.length
                        ? s.groupIds.map((g) => groupName.get(g) ?? g).join(", ")
                        : "no groups"}
                    </span>
                  </button>

                  {winning ? (
                    <span className="shrink-0 text-caption2 font-medium text-live-11">winning</span>
                  ) : null}

                  <Switch
                    checked={s.enabled}
                    onCheckedChange={(on) => void save({ ...s, enabled: on })}
                    aria-label={`${s.name} enabled`}
                  />
                  <Button size="small" iconOnly tooltip={`Delete ${s.name}`} onClick={() => void remove(s)}>
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </div>

                {open ? (
                  <div className="mt-3 flex flex-col gap-3 border-t border-line pt-3">
                    <Input
                      value={editing.name}
                      onChange={(e) => setDraft({ ...editing, name: e.target.value })}
                      className="max-w-xs"
                    />

                    <SelectField
                      label="Playlist"
                      value={editing.playlistId}
                      onChange={(v) => setDraft({ ...editing, playlistId: v })}
                      options={playlists.map((p) => ({ value: p.id, label: p.name }))}
                      placeholder="Pick a playlist"
                    />

                    <div className="flex flex-col gap-1">
                      <span className="text-caption1 text-fg-muted">Groups</span>
                      {groups.length === 0 ? (
                        <p className="text-caption2 text-fg-subtle">Make a group first.</p>
                      ) : (
                        <div className="flex flex-wrap gap-3">
                          {groups.map((g) => (
                            <label key={g.id} className="flex items-center gap-1.5 text-footnote text-fg">
                              <Checkbox
                                checked={editing.groupIds.includes(g.id)}
                                onCheckedChange={(on) =>
                                  setDraft({
                                    ...editing,
                                    groupIds: on
                                      ? [...editing.groupIds, g.id]
                                      : editing.groupIds.filter((x) => x !== g.id),
                                  })
                                }
                              />
                              {g.name}
                            </label>
                          ))}
                        </div>
                      )}
                    </div>

                    <WindowEditor
                      window={editing.window}
                      serviceTypes={serviceTypes}
                      onChange={(w) => setDraft({ ...editing, window: w })}
                    />

                    {draft?.id === s.id ? (
                      <div className="flex gap-2">
                        <Button variant="accent" onClick={() => void save(draft)}>
                          Save
                        </Button>
                        <Button onClick={() => setDraft(null)}>Discard</Button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
