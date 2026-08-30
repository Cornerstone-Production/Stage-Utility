import { invoke } from "../lib/api";
import { usePeopleCountState } from "../main/use-people-count-state";
import { useState, type ChangeEvent } from "react";
import {
  Button,
  Input,
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
  NumberInput,
  InfoHint,
  toast,
} from "./ui";
import { PlusIcon, TrashIcon, Loader2Icon } from "lucide-react";
import { feedId } from "./integration-panel-helpers";

// ---- Ross TSL feeds editor --------------------------------------------------

interface TslFeed {
  id: string;
  metric: "attendance" | "occupancy";
  zoneId: string | null;
  displayIndex: number;
  prefix?: string;
  suffix?: string;
}

// Maps each people count (attendance/occupancy, building total or a zone) to a
// TSL display address on the Ross multiviewer. Stored as non-secret config.feeds.
export function RossTslFeedsPanel({
  state,
  onStateChange,
}: {
  state: IntegrationState;
  onStateChange: (next: IntegrationState) => void;
}) {
  const people = usePeopleCountState();
  const zones = people?.zones ?? [];
  const initial = Array.isArray(state.config.feeds) ? (state.config.feeds as TslFeed[]) : [];
  const [feeds, setFeeds] = useState<TslFeed[]>(initial);
  const [saving, setSaving] = useState(false);

  function update(idx: number, patch: Partial<TslFeed>) {
    setFeeds((prev) => prev.map((f, i) => (i === idx ? { ...f, ...patch } : f)));
  }
  function remove(idx: number) {
    setFeeds((prev) => prev.filter((_, i) => i !== idx));
  }
  function add() {
    setFeeds((prev) => [
      ...prev,
      { id: feedId(), metric: "attendance", zoneId: null, displayIndex: prev.length, prefix: "", suffix: "" },
    ]);
  }

  async function save() {
    setSaving(true);
    try {
      const next = await invoke<IntegrationState>("integrations:setConfig", {
        id: "ross-tsl",
        config: { feeds },
      });
      onStateChange(next);
      toast.success("TSL feeds saved.");
    } catch (err) {
      toast.error(`Could not save feeds: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="flex items-center gap-1.5 text-caption2 font-semibold uppercase tracking-wider text-gray-9">
        Multiviewer feeds
        <InfoHint>
          Each feed drives one multiviewer tile. Pick the metric (Attendance = total counted; In room =
          occupancy) and a zone (or building total), set TSL # to the tile&apos;s UMD address on the Ross
          (0–126, must match the tile), and optional prefix/suffix wrap the number (e.g. &quot;In room: &quot; … &quot; ppl&quot;).
        </InfoHint>
      </span>
      {feeds.length === 0 && (
        <span className="text-caption2 text-gray-9">
          Add a feed to drive a multiviewer tile&apos;s text. Set the same TSL address on the Ross tile.
        </span>
      )}
      {feeds.map((f, i) => (
        <div key={f.id} className="flex flex-wrap items-center gap-1.5">
          <Select value={f.metric} onValueChange={(v: string) => update(i, { metric: v as TslFeed["metric"] })}>
            <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="attendance">Attendance</SelectItem>
              <SelectItem value="occupancy">In room</SelectItem>
            </SelectContent>
          </Select>
          <Select value={f.zoneId ?? ""} onValueChange={(v: string) => update(i, { zoneId: v || null })}>
            <SelectTrigger className="w-36"><SelectValue placeholder="Building total" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="">Building total</SelectItem>
              {zones.map((z) => <SelectItem key={z.id} value={z.id}>{z.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <div className="flex items-center gap-1">
            <span className="text-caption2 text-gray-9">TSL #</span>
            <NumberInput value={f.displayIndex} step={1} min={0} max={126} onChange={(v) => update(i, { displayIndex: Math.round(v) })} className="w-24" />
          </div>
          <Input value={f.prefix ?? ""} onChange={(e: ChangeEvent<HTMLInputElement>) => update(i, { prefix: e.target.value })} placeholder="prefix" className="w-20" />
          <Input value={f.suffix ?? ""} onChange={(e: ChangeEvent<HTMLInputElement>) => update(i, { suffix: e.target.value })} placeholder="suffix" className="w-20" />
          <Button variant="transparent" size="small" iconOnly onClick={() => remove(i)} aria-label="Remove feed">
            <TrashIcon className="size-3.5" />
          </Button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Button variant="transparent" size="small" onClick={add}>
          <PlusIcon className="size-3.5" /> Add feed
        </Button>
        <Button variant="filled" size="small" onClick={save} disabled={saving}>
          {saving ? <Loader2Icon className="size-3.5 animate-spin" /> : null} Save feeds
        </Button>
      </div>
    </div>
  );
}
