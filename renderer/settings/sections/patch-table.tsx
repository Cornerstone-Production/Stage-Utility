import { useState } from "react";
import { XIcon, PlusIcon, WavesIcon } from "lucide-react";

import { Input, Switch } from "../../components/ui";
import { cn } from "../../lib/cn";
import { rippleEndpoints, type RippleField, type RippleCount } from "../../lib/patch-ripple";

type Dir = "in" | "out";
const keyOf = (rackId: string, dir: Dir, index: number) => `${rackId}:${dir}:${index}`;
const meaningful = (e: PatchEndpoint) => Boolean(e.label || e.consoleChannel || (e.path && e.path.length) || e.unused || e.mic || e.feedType);

const GRID = "grid grid-cols-[52px_64px_1fr_110px_44px_1.4fr] gap-2";

const RIPPLE_COUNTS: RippleCount[] = [2, 4, 6, 8, 10, 12, "end"];
// Which columns can ripple, per direction, and their chip label.
const RIPPLE_FIELDS_IN: { field: RippleField; label: string }[] = [
  { field: "path", label: "From" },
  { field: "consoleChannel", label: "Console" },
  { field: "label", label: "Source" },
  { field: "mic", label: "Mic" },
  { field: "phantom", label: "48V" },
];
const RIPPLE_FIELDS_OUT: { field: RippleField; label: string }[] = [
  { field: "path", label: "To" },
  { field: "consoleChannel", label: "Console" },
  { field: "label", label: "Dest" },
  { field: "feedType", label: "Feed" },
];

interface RippleState {
  on: boolean;
  count: RippleCount;
  fields: Record<RippleField, boolean>;
}
const DEFAULT_RIPPLE: RippleState = {
  on: false,
  count: 8,
  fields: { path: true, consoleChannel: true, label: false, mic: false, phantom: false, feedType: false },
};

/** Whether a value is worth rippling (don't fan an empty edit down a rack). */
function rippleHasValue(field: RippleField, value: unknown): boolean {
  if (field === "phantom") return true;
  if (field === "path") return Array.isArray(value) && (value as PatchHop[]).some((h) => (h.connector ?? "").trim() !== "");
  return String(value ?? "").trim() !== "";
}

/** Compact editor for one endpoint's ordered From (in) / To (out) hop chain. */
function PathCell({ path, stageDevices, onChange }: { path: PatchHop[] | undefined; stageDevices: PatchDevice[]; onChange: (hops: PatchHop[]) => void }) {
  const hops = path ?? [];
  const setHop = (i: number, patch: Partial<PatchHop>) => onChange(hops.map((h, j) => (j === i ? { ...h, ...patch } : h)));
  const add = () => onChange([...hops, { deviceId: stageDevices[0]?.id ?? "", connector: "" }]);
  const remove = (i: number) => onChange(hops.filter((_, j) => j !== i));
  const dev = (id: string) => stageDevices.find((d) => d.id === id);
  return (
    <div className="flex flex-col gap-1">
      {hops.map((h, i) => {
        // Suggest the source device's connector labels (from "Generate labels").
        const labels = dev(h.deviceId)?.inLabels ?? dev(h.deviceId)?.outLabels ?? [];
        const listId = labels.length ? `hoplabels-${h.deviceId}` : undefined;
        return (
          <div key={i} className="flex items-center gap-1">
            <select value={h.deviceId} onChange={(e) => setHop(i, { deviceId: e.target.value })} className="h-6 min-w-0 flex-1 rounded border border-line-strong bg-field px-1.5 text-caption2 text-fg focus:outline-none focus:border-focus">
              <option value="">— device —</option>
              {stageDevices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <input value={h.connector} list={listId} onChange={(e) => setHop(i, { connector: e.target.value })} placeholder="ch" className="h-6 w-14 rounded border border-line-strong bg-field px-1.5 text-caption2 tabular-nums text-fg focus:outline-none focus:border-focus" />
            {listId && <datalist id={listId}>{labels.map((l) => <option key={l} value={l} />)}</datalist>}
            <button type="button" onClick={() => remove(i)} className="rounded p-0.5 text-fg-subtle hover:text-warn-11" aria-label="Remove hop"><XIcon className="size-3.5" /></button>
          </div>
        );
      })}
      <button type="button" onClick={add} className="inline-flex w-fit items-center gap-1 rounded px-1 py-0.5 text-caption2 text-fg-subtle hover:text-fg"><PlusIcon className="size-3" /> {hops.length ? "hop" : "direct — add hop"}</button>
    </div>
  );
}

/** The armed-ripple control bar (by-rack mode only). */
function RippleBar({ dir, ripple, setRipple }: { dir: Dir; ripple: RippleState; setRipple: (r: RippleState) => void }) {
  const fields = dir === "in" ? RIPPLE_FIELDS_IN : RIPPLE_FIELDS_OUT;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-line bg-surface-raised px-3 py-2">
      <label className="flex items-center gap-1.5 text-footnote font-medium text-fg">
        <Switch checked={ripple.on} onCheckedChange={(v) => setRipple({ ...ripple, on: v })} />
        <WavesIcon className="size-3.5 text-fg-subtle" /> Ripple
      </label>
      {ripple.on && (
        <>
          <div className="flex items-center gap-1">
            <span className="text-caption2 text-fg-subtle">Channels</span>
            {RIPPLE_COUNTS.map((c) => (
              <button
                key={String(c)}
                type="button"
                onClick={() => setRipple({ ...ripple, count: c })}
                className={cn(
                  "h-6 min-w-6 rounded px-1.5 text-caption2 tabular-nums transition-colors",
                  ripple.count === c ? "bg-accent text-white" : "bg-fill text-fg-muted hover:bg-fill-active",
                )}
              >
                {c === "end" ? "To end" : c}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <span className="text-caption2 text-fg-subtle">Fill</span>
            {fields.map(({ field, label }) => (
              <button
                key={field}
                type="button"
                onClick={() => setRipple({ ...ripple, fields: { ...ripple.fields, [field]: !ripple.fields[field] } })}
                className={cn(
                  "h-6 rounded px-2 text-caption2 transition-colors",
                  ripple.fields[field] ? "bg-accent/15 text-accent ring-1 ring-accent/40" : "bg-fill text-fg-subtle hover:bg-fill-active",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Editable rack-centric endpoint table for one direction. Grouped either by rack
 * (every channel of every rack, blanks included) or by the stage device each
 * endpoint's path starts at (mirrors the Analog tab's snake/pocket sections).
 * Editing a cell upserts the endpoint keyed by rack + dir + index either way.
 *
 * In by-rack mode a DiGiCo-style ripple can be armed: set one channel and the run
 * below auto-fills (numeric increments, text/toggles copy), clamped to the rack.
 */
export function PatchTable({
  dir,
  group,
  racks,
  stageDevices,
  endpoints,
  onChange,
}: {
  dir: Dir;
  group: "rack" | "device";
  racks: PatchDevice[];
  stageDevices: PatchDevice[];
  endpoints: PatchEndpoint[];
  onChange: (next: PatchEndpoint[]) => void;
}) {
  const [ripple, setRipple] = useState<RippleState>(DEFAULT_RIPPLE);
  // The row whose cell is focused, so we can highlight the ripple's reach.
  const [focus, setFocus] = useState<{ rackId: string; index: number } | null>(null);
  const rippleActive = group === "rack" && ripple.on;

  const byKey = new Map(endpoints.map((e) => [keyOf(e.rackId, e.dir, e.index), e] as const));
  const rackName = (id: string) => racks.find((r) => r.id === id)?.name ?? id;

  function upsert(rackId: string, index: number, patch: Partial<PatchEndpoint>) {
    const k = keyOf(rackId, dir, index);
    const existing = byKey.get(k) ?? { rackId, dir, index };
    const next = endpoints.filter((e) => keyOf(e.rackId, e.dir, e.index) !== k);
    next.push({ ...existing, ...patch });
    onChange(next);
  }

  // Route an edit through ripple when armed + the field is checked + it has a
  // value worth spreading; otherwise a plain single-cell upsert.
  function edit(rackId: string, index: number, field: RippleField, value: unknown, patch: Partial<PatchEndpoint>, rackChannels: number) {
    if (rippleActive && ripple.fields[field] && rippleHasValue(field, value)) {
      onChange(rippleEndpoints({ endpoints, rackId, dir, startIndex: index, field, value, count: ripple.count, rackChannels, stageDevices }));
    } else {
      upsert(rackId, index, patch);
    }
  }

  // Highlight rows the next rippled edit would touch, from the focused row down.
  function lastRippleIndex(start: number, rackChannels: number): number {
    return ripple.count === "end" ? rackChannels : Math.min(rackChannels, start + ripple.count - 1);
  }
  function isInFocusRun(rackId: string, index: number, rackChannels: number): boolean {
    return rippleActive && focus != null && focus.rackId === rackId && index >= focus.index && index <= lastRippleIndex(focus.index, rackChannels);
  }

  const headCols = dir === "in" ? ["#", "Console", "Source", "Mic", "48V", "From"] : ["#", "Console", "Destination", "Feed", "To", ""];

  function HeaderRow() {
    return (
      <div className={`${GRID} border-b border-line px-3 py-1.5 text-caption2 font-semibold uppercase tracking-wider text-fg-subtle`}>
        {headCols.map((c, i) => <div key={i} className={i === 4 && dir === "in" ? "text-center" : ""}>{c}</div>)}
      </div>
    );
  }

  function Row(rackId: string, idx: number, showRack: boolean, rackChannels: number) {
    const e = byKey.get(keyOf(rackId, dir, idx));
    return (
      <div
        key={`${rackId}:${idx}`}
        onFocus={() => rippleActive && setFocus({ rackId, index: idx })}
        onBlur={() => setFocus(null)}
        className={cn(`${GRID} items-start border-b border-line/60 px-3 py-1.5 transition-colors`, isInFocusRun(rackId, idx, rackChannels) && "bg-accent/5")}
      >
        <div className="pt-1.5 font-mono text-caption1 tabular-nums text-fg-subtle">
          {idx}
          {showRack && <div className="truncate text-[10px] text-fg-faint">{rackName(rackId)}</div>}
        </div>
        <input value={e?.consoleChannel ?? ""} onChange={(ev) => edit(rackId, idx, "consoleChannel", ev.target.value, { consoleChannel: ev.target.value }, rackChannels)} placeholder="—" className="h-7 w-full rounded border border-line-strong bg-field px-1.5 text-footnote tabular-nums text-fg focus:outline-none focus:border-focus" />
        <Input value={e?.label ?? ""} onChange={(ev) => edit(rackId, idx, "label", ev.target.value, { label: ev.target.value }, rackChannels)} placeholder={dir === "in" ? "Source" : "Destination"} />
        {dir === "in" ? (
          <>
            <Input value={e?.mic ?? ""} onChange={(ev) => edit(rackId, idx, "mic", ev.target.value, { mic: ev.target.value }, rackChannels)} placeholder="Mic / DI" />
            <div className="flex justify-center pt-1"><Switch checked={e?.phantom ?? false} onCheckedChange={(v) => edit(rackId, idx, "phantom", v, { phantom: v }, rackChannels)} /></div>
          </>
        ) : (
          <>
            <Input value={e?.feedType ?? ""} onChange={(ev) => edit(rackId, idx, "feedType", ev.target.value, { feedType: ev.target.value }, rackChannels)} placeholder="IEM / wedge…" />
            <div />
          </>
        )}
        <PathCell path={e?.path} stageDevices={stageDevices} onChange={(hops) => edit(rackId, idx, "path", hops, { path: hops }, rackChannels)} />
      </div>
    );
  }

  if (racks.length === 0) {
    return <div className="rounded-lg border border-line bg-surface px-4 py-6 text-center text-footnote text-fg-subtle">Add a rack device above to build the {dir === "in" ? "input" : "output"} patch.</div>;
  }

  // ── By device: group existing endpoints by the stage box their path starts at ──
  if (group === "device") {
    const rows = endpoints.filter((e) => e.dir === dir && meaningful(e));
    const groups = new Map<string, PatchEndpoint[]>();
    for (const e of rows) {
      const gk = e.path?.[0]?.deviceId || "__direct";
      const arr = groups.get(gk);
      if (arr) arr.push(e);
      else groups.set(gk, [e]);
    }
    const orderedKeys = [
      ...stageDevices.map((d) => d.id).filter((id) => groups.has(id)),
      ...[...groups.keys()].filter((k) => k !== "__direct" && !stageDevices.some((d) => d.id === k)),
      ...(groups.has("__direct") ? ["__direct"] : []),
    ];
    if (orderedKeys.length === 0) {
      return <div className="rounded-lg border border-line bg-surface px-4 py-6 text-center text-footnote text-fg-subtle">No patched {dir === "in" ? "inputs" : "outputs"} yet — switch to “By rack” to build the patch.</div>;
    }
    return (
      <div className="flex flex-col gap-4">
        {orderedKeys.map((gk) => {
          const list = groups.get(gk)!.slice().sort((a, b) => a.rackId.localeCompare(b.rackId) || a.index - b.index);
          const name = gk === "__direct" ? "Direct to rack" : stageDevices.find((d) => d.id === gk)?.name ?? gk;
          return (
            <div key={gk} className="overflow-hidden rounded-xl border border-line bg-surface">
              <div className="border-b border-line px-4 py-2 text-footnote font-semibold text-fg">{name} <span className="text-caption2 font-normal text-fg-subtle">{list.length}</span></div>
              <div className="overflow-x-auto"><div className="min-w-[680px]"><HeaderRow />{list.map((e) => Row(e.rackId, e.index, racks.length > 1, dir === "in" ? racks.find((r) => r.id === e.rackId)?.inputs ?? 0 : racks.find((r) => r.id === e.rackId)?.outputs ?? 0))}</div></div>
            </div>
          );
        })}
      </div>
    );
  }

  // ── By rack: every channel of every rack ──
  return (
    <div className="flex flex-col gap-4">
      <RippleBar dir={dir} ripple={ripple} setRipple={setRipple} />
      {racks.map((rack) => {
        const count = dir === "in" ? rack.inputs : rack.outputs;
        return (
          <div key={rack.id} className="overflow-hidden rounded-xl border border-line bg-surface">
            <div className="border-b border-line px-4 py-2 text-footnote font-semibold text-fg">{rack.name}</div>
            <div className="overflow-x-auto">
              <div className="min-w-[680px]">
                <HeaderRow />
                {Array.from({ length: Math.max(0, count) }, (_, i) => i + 1).map((idx) => Row(rack.id, idx, false, count))}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
