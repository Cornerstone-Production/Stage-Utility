import { useEffect, useRef, useState } from "react";
import { PlusIcon, XIcon } from "lucide-react";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui";

/** A device's color on a dot, as the variable the print stylesheet reads back. */
export function dotStyle(color: string | undefined): React.CSSProperties {
  return { "--dot": color ?? "var(--color-fg-faint)", background: "var(--dot)" } as React.CSSProperties;
}

/** Which hop is open for editing, and which of its two fields takes focus. */
type Editing = { index: number; focus: "device" | "connector" } | null;

/**
 * One endpoint's ordered From (in) / To (out) hop chain, on one line.
 *
 * Each hop reads as a chip — the device's color and "Device · connector". A click
 * swaps that chip for its editor in place: the device select and the connector
 * input, with the connector autocompleting from the device's generated labels.
 * The editor closes when focus leaves it, so there is no separate Done.
 *
 * Exported for patch-table.test.tsx — it is the one place in this file a stored
 * id (a hop's deviceId) can outlive the list it was chosen from.
 */
export function PathCell({ path, stageDevices, onChange }: { path: PatchHop[] | undefined; stageDevices: PatchDevice[]; onChange: (hops: PatchHop[]) => void }) {
  const hops = path ?? [];
  const [editing, setEditing] = useState<Editing>(null);
  const setHop = (i: number, patch: Partial<PatchHop>) => onChange(hops.map((h, j) => (j === i ? { ...h, ...patch } : h)));
  const add = () => {
    onChange([...hops, { deviceId: stageDevices[0]?.id ?? "", connector: "" }]);
    setEditing({ index: hops.length, focus: "device" });
  };
  const remove = (i: number) => {
    onChange(hops.filter((_, j) => j !== i));
    setEditing(null);
  };
  const dev = (id: string) => stageDevices.find((d) => d.id === id);

  return (
    <div className="flex flex-wrap items-center gap-1 px-2 py-[3px]">
      {hops.map((h, i) => {
        const device = dev(h.deviceId);
        if (editing?.index === i) {
          return (
            <HopEditor
              key={i}
              hop={h}
              device={device}
              devices={stageDevices}
              focus={editing.focus}
              onChange={(patch) => setHop(i, patch)}
              onRemove={() => remove(i)}
              onClose={() => setEditing(null)}
            />
          );
        }
        // A hop naming a device that is no longer in the list keeps its id on the
        // chip, in the warning color, rather than reading as a blank.
        const missing = !device;
        const name = device?.name ?? (h.deviceId || "no device");
        return (
          <button
            key={i}
            type="button"
            onClick={() => setEditing({ index: i, focus: "connector" })}
            title={missing ? "This device is no longer in the sheet's device list" : "Edit hop"}
            className={`inline-flex items-center gap-1 rounded-[5px] border px-1.5 py-px font-mono text-[11.5px] hover:bg-fill ${missing ? "border-warn-9 text-warn-11" : "border-line-strong text-fg"}`}
          >
            <i className="patch-dot size-[7px] rounded-[2px]" style={dotStyle(device?.color)} />
            {name}{h.connector ? ` · ${h.connector}` : ""}
          </button>
        );
      })}
      {hops.length === 0 ? (
        <button type="button" onClick={add} className="patch-print-hide rounded px-0.5 text-footnote text-fg-faint hover:text-fg-muted">
          direct · add hop
        </button>
      ) : editing ? null : (
        <button
          type="button"
          onClick={add}
          aria-label="Add hop"
          className="patch-print-hide inline-flex items-center gap-0.5 rounded-[5px] border border-dashed border-line-strong px-1.5 text-caption1 text-fg-subtle opacity-0 hover:text-fg focus-visible:opacity-100 group-focus-within/row:opacity-100 group-hover/row:opacity-100 pointer-coarse:opacity-100"
        >
          <PlusIcon className="size-3" /> hop
        </button>
      )}
    </div>
  );
}

/**
 * A hop's editor: the device select and the connector input, side by side.
 * Takes focus on mount — the editor exists because the operator clicked it, and
 * the field they came for (the connector for a chip, the device for a new hop)
 * must be ready for the keyboard.
 */
function HopEditor({
  hop,
  device,
  devices,
  focus,
  onChange,
  onRemove,
  onClose,
}: {
  hop: PatchHop;
  device: PatchDevice | undefined;
  devices: PatchDevice[];
  focus: "device" | "connector";
  onChange: (patch: Partial<PatchHop>) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    rootRef.current?.querySelector<HTMLElement>(focus === "device" ? "select" : "input")?.focus();
    // Once, on open. Later renders (every keystroke) must not pull focus back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Suggest the source device's connector labels (from "Generate labels").
  const labels = device?.inLabels ?? device?.outLabels ?? [];
  const listId = labels.length ? `hoplabels-${hop.deviceId}` : undefined;
  return (
    <span
      ref={rootRef}
      role="group"
      aria-label="Edit hop"
      className="inline-flex items-center gap-1"
      onBlur={(e) => {
        // Focus moving between this editor's own controls is not leaving it.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" || (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT")) onClose();
      }}
    >
      {/* A hop points at a device by id, and deleting a device does not walk the
          endpoints to clear the hops that name it — so the Select has to keep the
          id visible rather than let the row read as "— device —". */}
      <Select value={hop.deviceId} onValueChange={(v) => onChange({ deviceId: v })}>
        <SelectTrigger className="h-6 w-28 min-w-0 rounded px-1.5 text-caption2" aria-label="Device">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="">— device —</SelectItem>
          {devices.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
        </SelectContent>
      </Select>
      <input
        value={hop.connector}
        list={listId}
        onChange={(e) => onChange({ connector: e.target.value })}
        placeholder="ch"
        aria-label="Connector"
        className="h-6 w-14 rounded border border-line-strong bg-field px-1.5 font-mono text-caption2 tabular-nums text-fg focus:border-focus focus:outline-none"
      />
      {listId && <datalist id={listId}>{labels.map((l) => <option key={l} value={l} />)}</datalist>}
      {/* mousedown is held so focus stays in the editor: Safari does not focus a
          button on click, so the input would blur first, close the editor, and
          the click would land on nothing. */}
      <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={onRemove} className="touch-target rounded p-0.5 text-fg-subtle hover:text-danger-11" aria-label="Remove hop">
        <XIcon className="size-3.5" />
      </button>
    </span>
  );
}
