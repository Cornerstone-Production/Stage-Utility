// history-milestones-panel.tsx — the operator's list of dates worth marking.
//
// "Moved to two services", "new building", "Kickoff 2026". They draw as marks
// under the Trends chart on History → All services. The chart also derives its
// own marks, where a plan's series title changes between consecutive recordings
// of one type; those are not editable here because they are not an opinion —
// they are a fact about the recordings, re-derived on every read.
//
// In Advanced rather than on History itself: it is a short list somebody edits
// twice a year, and the History tab is a reading surface.
//
// The store REFUSES a date it cannot draw (see history-milestones-store.ts), so
// a bad one comes back as a failure toast rather than as a row that silently
// never appears.

import { useEffect, useState } from "react";
import { PlusIcon, Trash2Icon } from "lucide-react";

import { errorMessage } from "@main/services/errors";
import { invoke } from "../../lib/api";
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  confirm,
  toast,
} from "../../components/ui";
import type { StoredMilestone } from "./history-trends/trends";

/** Every service type that has ever recorded, for the optional scope picker. */
function useServiceTypes(): { id: string; name: string }[] {
  const [types, setTypes] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    let cancelled = false;
    invoke<ServiceTimeline[]>("serviceTimeline:list")
      .then((list) => {
        if (cancelled) return;
        const seen = new Map<string, string>();
        for (const t of list ?? []) {
          if (t.serviceTypeId && !seen.has(t.serviceTypeId)) seen.set(t.serviceTypeId, t.serviceTypeName ?? t.serviceTypeId);
        }
        setTypes([...seen].map(([id, name]) => ({ id, name })));
      })
      .catch(() => {
        // The picker offers "Every service type" alone. A milestone that applies
        // to everything is the common case and is still reachable.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return types;
}

/** The value the Select carries for "no service type" — Radix treats "" as
 *  "nothing selected" and would render the placeholder instead of the option. */
const EVERY_TYPE = "__all";

export function HistoryMilestonesPanel() {
  const [list, setList] = useState<StoredMilestone[]>([]);
  const [date, setDate] = useState("");
  const [label, setLabel] = useState("");
  const [typeId, setTypeId] = useState(EVERY_TYPE);
  const [saving, setSaving] = useState(false);
  const types = useServiceTypes();

  useEffect(() => {
    let cancelled = false;
    invoke<StoredMilestone[]>("history:listMilestones")
      .then((l) => !cancelled && setList(l ?? []))
      .catch((e) => !cancelled && toast.error(`Couldn't read the milestones: ${errorMessage(e)}`));
    return () => {
      cancelled = true;
    };
  }, []);

  async function add() {
    if (!date || !label.trim()) return;
    setSaving(true);
    try {
      setList(await invoke<StoredMilestone[]>("history:saveMilestone", {
        date,
        label: label.trim(),
        serviceTypeId: typeId === EVERY_TYPE ? null : typeId,
      }));
      setDate("");
      setLabel("");
      setTypeId(EVERY_TYPE);
    } catch (e) {
      toast.error(`Couldn't save that milestone: ${errorMessage(e)}`);
    } finally {
      setSaving(false);
    }
  }

  async function remove(m: StoredMilestone) {
    if (!(await confirm({
      title: "Delete milestone?",
      message: `Remove "${m.label}" from the Trends chart. The recordings themselves are untouched.`,
      confirmLabel: "Delete",
      destructive: true,
    }))) return;
    try {
      setList(await invoke<StoredMilestone[]>("history:deleteMilestone", { id: m.id }));
    } catch (e) {
      toast.error(`Couldn't delete that milestone: ${errorMessage(e)}`);
    }
  }

  const typeName = (id: string | null) => (id ? types.find((t) => t.id === id)?.name ?? id : "Every service type");

  return (
    <div data-testid="history-milestones" className="flex flex-col gap-2 px-4 pb-4">
      <p className="text-caption2 text-fg-subtle">
        Dates marked under the Trends chart on History → All services, so a step in attendance has a
        reason beside it. The chart also marks where a plan&apos;s series title changes on its own.
      </p>

      <div className="flex flex-col gap-1">
        {list.map((m) => (
          <div key={m.id} data-milestone-row={m.id} className="flex items-center gap-2 rounded-lg border border-line px-2.5 py-1.5">
            <span className="shrink-0 font-mono text-caption1 tabular-nums text-fg-muted">{m.date}</span>
            <span className="min-w-0 flex-1 truncate text-footnote text-fg">{m.label}</span>
            <span className="shrink-0 truncate text-caption2 text-fg-subtle">{typeName(m.serviceTypeId)}</span>
            <Button
              variant="transparent"
              size="small"
              onClick={() => void remove(m)}
              aria-label={`Delete milestone ${m.label}`}
              className="shrink-0 text-danger-11"
            >
              <Trash2Icon className="size-3.5" />
            </Button>
          </div>
        ))}
        {list.length === 0 && <p className="text-caption2 text-fg-subtle">No milestones yet.</p>}
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-caption2 text-fg-subtle">
          Date
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            aria-label="Milestone date"
            className="rounded-md border border-line-strong bg-field px-2.5 py-1 text-footnote text-fg"
          />
        </label>
        <label className="flex min-w-40 flex-1 flex-col gap-1 text-caption2 text-fg-subtle">
          Label
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void add();
            }}
            placeholder="Moved to two services"
            aria-label="Milestone label"
          />
        </label>
        <label className="flex flex-col gap-1 text-caption2 text-fg-subtle">
          Applies to
          <Select value={typeId} onValueChange={setTypeId}>
            <SelectTrigger aria-label="Milestone service type" className="h-8 text-footnote">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={EVERY_TYPE}>Every service type</SelectItem>
              {types.map((t) => (
                <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <Button variant="accent" size="small" disabled={!date || !label.trim() || saving} onClick={() => void add()}>
          <PlusIcon className="size-3.5" /> Add
        </Button>
      </div>
    </div>
  );
}
