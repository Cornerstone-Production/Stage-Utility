import { useEffect, useRef, useState } from "react";
import { Trash2Icon, PlusIcon, ChevronRightIcon } from "lucide-react";

import { Button, NumberInput, Input } from "../../components/ui";
import { cn } from "../../lib/cn";
import { uid } from "../../lib/uid";
import { DeviceDot } from "./patch-dot";
import { generateLabels } from "../../lib/patch-ripple";

const KINDS: { value: PatchDeviceKind; label: string }[] = [
  { value: "rack", label: "Input Rack" },
  { value: "snake", label: "Snake" },
  { value: "drop-snake", label: "Drop snake" },
  { value: "pocket", label: "Floor pocket" },
  { value: "wireless", label: "Wireless / RF" },
  { value: "array", label: "Array" },
  { value: "other", label: "Other" },
];

// A curated, dark-legible palette for tinting a device's channels.
const PATCH_COLORS = ["#e5484d", "#f76b15", "#ffb224", "#46a758", "#12a594", "#0091ff", "#3e63dd", "#8e4ec6", "#e93d82", "#8b8d98"];

/** One-line summary of a device's current connector labels, e.g. "B-1…B-12". */
function labelSummary(labels: string[] | undefined): string | null {
  if (!labels || labels.length === 0) return null;
  return labels.length === 1 ? labels[0] : `${labels[0]}…${labels[labels.length - 1]}`;
}

export const EYEBROW = "text-caption2 font-semibold uppercase tracking-wider text-fg-subtle";

/**
 * Everything editable about one device, shown under its row in the list: name,
 * kind, channel counts, the color it tints its channels with, and the connector
 * labels that autocomplete in the From/To cells and ripple cleanly in the table.
 */
function DeviceEditor({ device: d, focusName, onUpdate, onRemove }: { device: PatchDevice; focusName: boolean; onUpdate: (patch: Partial<PatchDevice>) => void; onRemove: () => void }) {
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusName) {
      nameRef.current?.focus();
      nameRef.current?.select();
    }
    // Once, when the editor opens: a device just added is named next.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // The label generator's inputs are the editor's own, so opening another
  // device does not inherit the last one's prefix.
  const [prefix, setPrefix] = useState("");
  const [start, setStart] = useState(1);
  const inSum = labelSummary(d.inLabels);
  const outSum = labelSummary(d.outLabels);

  return (
    <div className="mb-1.5 mt-0.5 flex flex-col gap-3 rounded-lg border border-line bg-surface-raised p-2.5">
      <div className="flex flex-col gap-2">
        <Input ref={nameRef} value={d.name} onChange={(e) => onUpdate({ name: e.target.value })} placeholder="Device name" aria-label="Device name" />
        {/* Left as a raw <select>: KINDS is a fixed, exhaustive list of
            main/types/patch.ts's PatchDeviceKind union, which has never
            dropped a member — a device's kind cannot hold a value this
            list does not carry. */}
        <select
          value={d.kind}
          onChange={(e) => onUpdate({ kind: e.target.value as PatchDeviceKind })}
          aria-label="Device kind"
          className="h-7 w-full rounded-md border border-line-strong bg-field px-2 text-footnote text-fg focus:border-focus focus:outline-none"
        >
          {KINDS.map((k) => (
            <option key={k.value} value={k.value}>{k.label}</option>
          ))}
        </select>
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1 text-caption2 text-fg-subtle">
            In
            <NumberInput value={d.inputs} min={0} max={256} onChange={(v) => onUpdate({ inputs: v })} />
          </label>
          <label className="flex flex-col gap-1 text-caption2 text-fg-subtle">
            Out
            <NumberInput value={d.outputs} min={0} max={256} onChange={(v) => onUpdate({ outputs: v })} />
          </label>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className={EYEBROW}>Color</span>
        <div className="flex flex-wrap items-center gap-2">
          {PATCH_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => onUpdate({ color: c })}
              className={cn("size-5 rounded-full transition-transform hover:scale-110", d.color === c && "ring-2 ring-fg ring-offset-2 ring-offset-surface-raised")}
              style={{ background: c }}
              aria-label={`Use ${c}`}
              aria-pressed={d.color === c}
            />
          ))}
          {d.color && (
            <button type="button" onClick={() => onUpdate({ color: undefined })} className="rounded-md px-2 py-1 text-caption2 text-fg-subtle hover:text-fg">
              None
            </button>
          )}
        </div>
        <p className="text-caption2 text-fg-faint">Tints every channel sourced from this device in the table and the /patch view.</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className={EYEBROW}>Connector labels</span>
        {(inSum || outSum) && (
          <span className="text-caption2 tabular-nums text-fg-muted">
            {inSum && `in ${inSum}`}{inSum && outSum && " · "}{outSum && `out ${outSum}`}
          </span>
        )}
        <div className="flex items-end gap-2">
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-caption2 text-fg-subtle">
            Prefix
            <Input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="e.g. B-" />
          </label>
          <label className="flex flex-col gap-1 text-caption2 text-fg-subtle">
            Start #
            <NumberInput className="w-24 flex-none" value={start} min={0} max={999} onChange={setStart} />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button variant="filled" size="small" disabled={d.inputs <= 0} onClick={() => onUpdate({ inLabels: generateLabels(d.inputs, prefix, start) })}>
            Label {d.inputs} inputs
          </Button>
          <Button variant="filled" size="small" disabled={d.outputs <= 0} onClick={() => onUpdate({ outLabels: generateLabels(d.outputs, prefix, start) })}>
            Label {d.outputs} outputs
          </Button>
          {(inSum || outSum) && (
            <Button variant="transparent" size="small" onClick={() => onUpdate({ inLabels: undefined, outLabels: undefined })}>
              Clear
            </Button>
          )}
        </div>
        <p className="text-caption2 text-fg-faint">
          Generates connectors {prefix}{start}…{prefix}{start + Math.max(d.inputs, d.outputs, 1) - 1}. They autocomplete in From/To cells and ripple cleanly in the table.
        </p>
      </div>

      <div className="border-t border-line pt-2">
        <Button variant="transparent" size="small" onClick={onRemove} className="text-fg-subtle hover:text-danger-11">
          <Trash2Icon className="size-3.5" /> Remove device
        </Button>
      </div>
    </div>
  );
}

/**
 * The Devices card: every rack and stage box in the sheet, one line each — color,
 * name, kind and channel counts. Racks are the endpoint spine; the others
 * (snakes, pockets, drops, RF) are referenced by each endpoint's From/To path.
 * A click opens that device's editor under its row; one is open at a time.
 */
export function PatchDeviceManager({ devices, onChange }: { devices: PatchDevice[]; onChange: (d: PatchDevice[]) => void }) {
  const [openId, setOpenId] = useState<string | null>(null);
  // Set by Add device, so the new device's name is selected for typing.
  const [addedId, setAddedId] = useState<string | null>(null);

  function update(id: string, patch: Partial<PatchDevice>) {
    onChange(devices.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  }
  function add() {
    const id = uid("dev");
    onChange([...devices, { id, name: `Device ${devices.length + 1}`, kind: "rack", inputs: 8, outputs: 0 }]);
    setOpenId(id);
    setAddedId(id);
  }
  function remove(id: string) {
    onChange(devices.filter((d) => d.id !== id));
    if (openId === id) setOpenId(null);
  }

  return (
    <section aria-label="Devices" className="rounded-xl border border-line bg-surface p-2.5">
      <div className="flex items-center px-1.5 pb-2 pt-1">
        <span className={EYEBROW}>Devices</span>
        <span className="ml-auto font-mono text-caption1 text-fg-subtle">{devices.length}</span>
      </div>
      {devices.map((d) => {
        const open = openId === d.id;
        return (
          <div key={d.id}>
            <button
              type="button"
              onClick={() => {
                setOpenId(open ? null : d.id);
                // Only the opening that Add device caused selects the name.
                setAddedId(null);
              }}
              aria-expanded={open}
              className={cn("grid w-full grid-cols-[10px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-fill", open && "bg-fill")}
            >
              <DeviceDot color={d.color} className="size-2.5" />
              <span className="min-w-0">
                <span className="block truncate text-footnote text-fg">{d.name || "Unnamed device"}</span>
                <span className="block text-caption1 text-fg-subtle">{KINDS.find((k) => k.value === d.kind)?.label ?? d.kind}</span>
              </span>
              <span className="flex items-center gap-1 font-mono text-caption2 text-fg-muted">
                {d.inputs} / {d.outputs}
                <ChevronRightIcon className={cn("size-3 text-fg-subtle transition-transform", open && "rotate-90")} />
              </span>
            </button>
            {open && <DeviceEditor device={d} focusName={addedId === d.id} onUpdate={(patch) => update(d.id, patch)} onRemove={() => remove(d.id)} />}
          </div>
        );
      })}
      <Button variant="transparent" size="small" onClick={add} className="mt-1.5">
        <PlusIcon className="size-3.5" /> Add device
      </Button>
    </section>
  );
}
