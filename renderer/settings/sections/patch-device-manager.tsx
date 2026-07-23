import { useState } from "react";
import { Trash2Icon, PlusIcon, ListOrderedIcon } from "lucide-react";

import { Button, NumberInput, Input, Collapsible } from "../../components/ui";
import { uid } from "../../lib/uid";
import { generateLabels } from "../../lib/patch-ripple";

const KINDS: { value: PatchDeviceKind; label: string }[] = [
  { value: "rack", label: "SD Rack" },
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

/**
 * Device manager for the patch editor — add/remove racks and stage boxes and set
 * their input/output channel counts. Racks are the endpoint spine; the others
 * (snakes, pockets, drops, RF) are referenced by each endpoint's From/To path.
 *
 * Each device can also generate sequential connector labels (prefix + 1..N, e.g.
 * "B-1…B-12"), which then autocomplete in the From/To path cells and ripple
 * cleanly ("B-1" → "B-2") in the patch table.
 */
export function PatchDeviceManager({ devices, onChange }: { devices: PatchDevice[]; onChange: (d: PatchDevice[]) => void }) {
  // Inline panels: which device has its label-generator / color panel open.
  const [labelFor, setLabelFor] = useState<string | null>(null);
  const [colorFor, setColorFor] = useState<string | null>(null);
  const [prefix, setPrefix] = useState("");
  const [start, setStart] = useState(1);

  // The two inline panels are mutually exclusive per row.
  const openLabel = (id: string) => { setLabelFor((v) => (v === id ? null : id)); setColorFor(null); };
  const openColor = (id: string) => { setColorFor((v) => (v === id ? null : id)); setLabelFor(null); };

  function update(id: string, patch: Partial<PatchDevice>) {
    onChange(devices.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  }
  function add() {
    onChange([...devices, { id: uid("dev"), name: `Device ${devices.length + 1}`, kind: "rack", inputs: 8, outputs: 0 }]);
  }
  function remove(id: string) {
    onChange(devices.filter((d) => d.id !== id));
    if (labelFor === id) setLabelFor(null);
    if (colorFor === id) setColorFor(null);
  }

  return (
    <div className="rounded-xl border border-line bg-surface">
      <Collapsible label="Devices" summary={`${devices.length}`} defaultOpen={devices.length === 0} headerClassName="px-4 py-2.5">
        <div className="flex flex-col gap-2 px-3 pb-3">
          {devices.map((d) => {
            const inSum = labelSummary(d.inLabels);
            const outSum = labelSummary(d.outLabels);
            const open = labelFor === d.id;
            return (
              <div key={d.id} className="rounded-lg border border-line bg-surface-raised">
                <div className="flex flex-wrap items-center gap-2 px-3 py-2">
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
                  {(inSum || outSum) && (
                    <span className="text-caption2 tabular-nums text-fg-faint">
                      {inSum && `in ${inSum}`}{inSum && outSum && " · "}{outSum && `out ${outSum}`}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => openColor(d.id)}
                    className={`ml-auto flex size-7 items-center justify-center rounded-md transition-colors ${colorFor === d.id ? "bg-fill" : "hover:bg-fill"}`}
                    aria-label={`Set color for ${d.name}`}
                    aria-expanded={colorFor === d.id}
                  >
                    <span className="size-4 rounded-full border" style={{ background: d.color ?? "transparent", borderColor: d.color ?? "var(--su-line-strong)" }} />
                  </button>
                  <button
                    type="button"
                    onClick={() => openLabel(d.id)}
                    className={`rounded-md p-1.5 transition-colors ${open ? "bg-fill text-fg" : "text-fg-subtle hover:bg-fill hover:text-fg"}`}
                    aria-label={`Generate connector labels for ${d.name}`}
                    aria-expanded={open}
                  >
                    <ListOrderedIcon className="size-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(d.id)}
                    className="rounded-md p-1.5 text-fg-subtle hover:bg-fill hover:text-warn-11 transition-colors"
                    aria-label={`Remove ${d.name}`}
                  >
                    <Trash2Icon className="size-4" />
                  </button>
                </div>
                {colorFor === d.id && (
                  <div className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-2.5">
                    <span className="text-caption2 text-fg-subtle">Color</span>
                    {PATCH_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => update(d.id, { color: c })}
                        className={`size-5 rounded-full transition-transform hover:scale-110 ${d.color === c ? "ring-2 ring-fg ring-offset-2 ring-offset-surface-raised" : ""}`}
                        style={{ background: c }}
                        aria-label={`Use ${c}`}
                      />
                    ))}
                    {d.color && (
                      <button type="button" onClick={() => update(d.id, { color: undefined })} className="rounded-md px-2 py-1 text-caption2 text-fg-subtle hover:text-fg">
                        None
                      </button>
                    )}
                    <span className="w-full text-caption2 text-fg-faint">Tints every channel sourced from this device in the table and the /patch view.</span>
                  </div>
                )}
                {open && (
                  <div className="flex flex-wrap items-end gap-2 border-t border-line px-3 py-2.5">
                    <label className="flex flex-col gap-1 text-caption2 text-fg-subtle">
                      Prefix
                      <Input value={prefix} onChange={(e) => setPrefix(e.target.value)} className="w-24" placeholder="e.g. B-" />
                    </label>
                    <label className="flex flex-col gap-1 text-caption2 text-fg-subtle">
                      Start #
                      <NumberInput value={start} min={0} max={999} onChange={setStart} />
                    </label>
                    <Button variant="filled" size="small" disabled={d.inputs <= 0} onClick={() => update(d.id, { inLabels: generateLabels(d.inputs, prefix, start) })}>
                      Label {d.inputs} inputs
                    </Button>
                    <Button variant="filled" size="small" disabled={d.outputs <= 0} onClick={() => update(d.id, { outLabels: generateLabels(d.outputs, prefix, start) })}>
                      Label {d.outputs} outputs
                    </Button>
                    {(inSum || outSum) && (
                      <Button variant="transparent" size="small" onClick={() => update(d.id, { inLabels: undefined, outLabels: undefined })}>
                        Clear
                      </Button>
                    )}
                    <p className="w-full text-caption2 text-fg-faint">
                      Generates connectors {prefix}{start}…{prefix}{start + Math.max(d.inputs, d.outputs, 1) - 1}. They autocomplete in From/To cells and ripple cleanly in the table.
                    </p>
                  </div>
                )}
              </div>
            );
          })}
          <Button variant="filled" size="small" onClick={add}>
            <PlusIcon className="size-3.5" /> Add device
          </Button>
        </div>
      </Collapsible>
    </div>
  );
}
