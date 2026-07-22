import { XIcon, PlusIcon } from "lucide-react";

import { Input, Switch } from "../../components/ui";

type Dir = "in" | "out";
const keyOf = (rackId: string, dir: Dir, index: number) => `${rackId}:${dir}:${index}`;
const meaningful = (e: PatchEndpoint) => Boolean(e.label || e.consoleChannel || (e.path && e.path.length) || e.unused || e.mic || e.feedType);

const GRID = "grid grid-cols-[52px_64px_1fr_110px_44px_1.4fr] gap-2";

/** Compact editor for one endpoint's ordered From (in) / To (out) hop chain. */
function PathCell({ path, stageDevices, onChange }: { path: PatchHop[] | undefined; stageDevices: PatchDevice[]; onChange: (hops: PatchHop[]) => void }) {
  const hops = path ?? [];
  const setHop = (i: number, patch: Partial<PatchHop>) => onChange(hops.map((h, j) => (j === i ? { ...h, ...patch } : h)));
  const add = () => onChange([...hops, { deviceId: stageDevices[0]?.id ?? "", connector: "" }]);
  const remove = (i: number) => onChange(hops.filter((_, j) => j !== i));
  return (
    <div className="flex flex-col gap-1">
      {hops.map((h, i) => (
        <div key={i} className="flex items-center gap-1">
          <select value={h.deviceId} onChange={(e) => setHop(i, { deviceId: e.target.value })} className="h-6 min-w-0 flex-1 rounded border border-line-strong bg-field px-1.5 text-caption2 text-fg focus:outline-none focus:border-focus">
            <option value="">— device —</option>
            {stageDevices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <input value={h.connector} onChange={(e) => setHop(i, { connector: e.target.value })} placeholder="ch" className="h-6 w-14 rounded border border-line-strong bg-field px-1.5 text-caption2 tabular-nums text-fg focus:outline-none focus:border-focus" />
          <button type="button" onClick={() => remove(i)} className="rounded p-0.5 text-fg-subtle hover:text-warn-11" aria-label="Remove hop"><XIcon className="size-3.5" /></button>
        </div>
      ))}
      <button type="button" onClick={add} className="inline-flex w-fit items-center gap-1 rounded px-1 py-0.5 text-caption2 text-fg-subtle hover:text-fg"><PlusIcon className="size-3" /> {hops.length ? "hop" : "direct — add hop"}</button>
    </div>
  );
}

/**
 * Editable rack-centric endpoint table for one direction. Grouped either by rack
 * (every channel of every rack, blanks included) or by the stage device each
 * endpoint's path starts at (mirrors the Analog tab's snake/pocket sections).
 * Editing a cell upserts the endpoint keyed by rack + dir + index either way.
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
  const byKey = new Map(endpoints.map((e) => [keyOf(e.rackId, e.dir, e.index), e] as const));
  const rackName = (id: string) => racks.find((r) => r.id === id)?.name ?? id;

  function upsert(rackId: string, index: number, patch: Partial<PatchEndpoint>) {
    const k = keyOf(rackId, dir, index);
    const existing = byKey.get(k) ?? { rackId, dir, index };
    const next = endpoints.filter((e) => keyOf(e.rackId, e.dir, e.index) !== k);
    next.push({ ...existing, ...patch });
    onChange(next);
  }

  const headCols = dir === "in" ? ["#", "Console", "Source", "Mic", "48V", "From"] : ["#", "Console", "Destination", "Feed", "To", ""];

  function HeaderRow() {
    return (
      <div className={`${GRID} border-b border-line px-3 py-1.5 text-caption2 font-semibold uppercase tracking-wider text-fg-subtle`}>
        {headCols.map((c, i) => <div key={i} className={i === 4 && dir === "in" ? "text-center" : ""}>{c}</div>)}
      </div>
    );
  }

  function Row(rackId: string, idx: number, showRack: boolean) {
    const e = byKey.get(keyOf(rackId, dir, idx));
    return (
      <div key={`${rackId}:${idx}`} className={`${GRID} items-start border-b border-line/60 px-3 py-1.5`}>
        <div className="pt-1.5 font-mono text-caption1 tabular-nums text-fg-subtle">
          {idx}
          {showRack && <div className="truncate text-[10px] text-fg-faint">{rackName(rackId)}</div>}
        </div>
        <input value={e?.consoleChannel ?? ""} onChange={(ev) => upsert(rackId, idx, { consoleChannel: ev.target.value })} placeholder="—" className="h-7 w-full rounded border border-line-strong bg-field px-1.5 text-footnote tabular-nums text-fg focus:outline-none focus:border-focus" />
        <Input value={e?.label ?? ""} onChange={(ev) => upsert(rackId, idx, { label: ev.target.value })} placeholder={dir === "in" ? "Source" : "Destination"} />
        {dir === "in" ? (
          <>
            <Input value={e?.mic ?? ""} onChange={(ev) => upsert(rackId, idx, { mic: ev.target.value })} placeholder="Mic / DI" />
            <div className="flex justify-center pt-1"><Switch checked={e?.phantom ?? false} onCheckedChange={(v) => upsert(rackId, idx, { phantom: v })} /></div>
          </>
        ) : (
          <>
            <Input value={e?.feedType ?? ""} onChange={(ev) => upsert(rackId, idx, { feedType: ev.target.value })} placeholder="IEM / wedge…" />
            <div />
          </>
        )}
        <PathCell path={e?.path} stageDevices={stageDevices} onChange={(hops) => upsert(rackId, idx, { path: hops })} />
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
              <div className="overflow-x-auto"><div className="min-w-[680px]"><HeaderRow />{list.map((e) => Row(e.rackId, e.index, racks.length > 1))}</div></div>
            </div>
          );
        })}
      </div>
    );
  }

  // ── By rack: every channel of every rack ──
  return (
    <div className="flex flex-col gap-4">
      {racks.map((rack) => {
        const count = dir === "in" ? rack.inputs : rack.outputs;
        return (
          <div key={rack.id} className="overflow-hidden rounded-xl border border-line bg-surface">
            <div className="border-b border-line px-4 py-2 text-footnote font-semibold text-fg">{rack.name}</div>
            <div className="overflow-x-auto">
              <div className="min-w-[680px]">
                <HeaderRow />
                {Array.from({ length: Math.max(0, count) }, (_, i) => i + 1).map((idx) => Row(rack.id, idx, false))}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
