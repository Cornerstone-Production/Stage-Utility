import { Trash2Icon, PlusIcon } from "lucide-react";

import { Button, NumberInput, Input, Collapsible } from "../../components/ui";
import { uid } from "../../lib/uid";

const KINDS: { value: PatchDeviceKind; label: string }[] = [
  { value: "rack", label: "SD Rack" },
  { value: "snake", label: "Snake" },
  { value: "drop-snake", label: "Drop snake" },
  { value: "pocket", label: "Floor pocket" },
  { value: "wireless", label: "Wireless / RF" },
  { value: "array", label: "Array" },
  { value: "other", label: "Other" },
];

/**
 * Device manager for the patch editor — add/remove racks and stage boxes and set
 * their input/output channel counts. Racks are the endpoint spine; the others
 * (snakes, pockets, drops, RF) are referenced by each endpoint's From/To path.
 */
export function PatchDeviceManager({ devices, onChange }: { devices: PatchDevice[]; onChange: (d: PatchDevice[]) => void }) {
  function update(id: string, patch: Partial<PatchDevice>) {
    onChange(devices.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  }
  function add() {
    onChange([...devices, { id: uid("dev"), name: `Device ${devices.length + 1}`, kind: "rack", inputs: 8, outputs: 0 }]);
  }
  function remove(id: string) {
    onChange(devices.filter((d) => d.id !== id));
  }

  return (
    <div className="rounded-xl border border-line bg-surface">
      <Collapsible label="Devices" summary={`${devices.length}`} defaultOpen={devices.length === 0} headerClassName="px-4 py-2.5">
        <div className="flex flex-col gap-2 px-3 pb-3">
          {devices.map((d) => (
            <div key={d.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface-raised px-3 py-2">
              <Input value={d.name} onChange={(e) => update(d.id, { name: e.target.value })} className="w-44" placeholder="Device name" />
              <select
                value={d.kind}
                onChange={(e) => update(d.id, { kind: e.target.value as PatchDeviceKind })}
                className="h-7 rounded-md border border-line-strong bg-field px-2 text-footnote text-fg focus:outline-none focus:border-focus"
              >
                {KINDS.map((k) => (
                  <option key={k.value} value={k.value}>{k.label}</option>
                ))}
              </select>
              <label className="flex items-center gap-1.5 text-caption2 text-fg-muted">
                in <NumberInput value={d.inputs} min={0} max={256} onChange={(v) => update(d.id, { inputs: v })} />
              </label>
              <label className="flex items-center gap-1.5 text-caption2 text-fg-muted">
                out <NumberInput value={d.outputs} min={0} max={256} onChange={(v) => update(d.id, { outputs: v })} />
              </label>
              <button
                type="button"
                onClick={() => remove(d.id)}
                className="ml-auto rounded-md p-1.5 text-fg-subtle hover:bg-fill hover:text-warn-11 transition-colors"
                aria-label={`Remove ${d.name}`}
              >
                <Trash2Icon className="size-4" />
              </button>
            </div>
          ))}
          <Button variant="filled" size="small" onClick={add}>
            <PlusIcon className="size-3.5" /> Add device
          </Button>
        </div>
      </Collapsible>
    </div>
  );
}
