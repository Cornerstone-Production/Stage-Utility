import { XIcon, PlusIcon } from "lucide-react";

import { Input, Switch } from "../../components/ui";

type Dir = "in" | "out";
const keyOf = (rackId: string, dir: Dir, index: number) => `${rackId}:${dir}:${index}`;

/** Compact editor for one endpoint's ordered From (in) / To (out) hop chain. */
function PathCell({
  path,
  stageDevices,
  onChange,
}: {
  path: PatchHop[] | undefined;
  stageDevices: PatchDevice[];
  onChange: (hops: PatchHop[]) => void;
}) {
  const hops = path ?? [];
  const setHop = (i: number, patch: Partial<PatchHop>) => onChange(hops.map((h, j) => (j === i ? { ...h, ...patch } : h)));
  const add = () => onChange([...hops, { deviceId: stageDevices[0]?.id ?? "", connector: "" }]);
  const remove = (i: number) => onChange(hops.filter((_, j) => j !== i));

  return (
    <div className="flex flex-col gap-1">
      {hops.map((h, i) => (
        <div key={i} className="flex items-center gap-1">
          <select
            value={h.deviceId}
            onChange={(e) => setHop(i, { deviceId: e.target.value })}
            className="h-6 min-w-0 flex-1 rounded border border-line-strong bg-field px-1.5 text-caption2 text-fg focus:outline-none focus:border-focus"
          >
            <option value="">— device —</option>
            {stageDevices.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
          <input
            value={h.connector}
            onChange={(e) => setHop(i, { connector: e.target.value })}
            placeholder="ch"
            className="h-6 w-14 rounded border border-line-strong bg-field px-1.5 text-caption2 tabular-nums text-fg focus:outline-none focus:border-focus"
          />
          <button type="button" onClick={() => remove(i)} className="rounded p-0.5 text-fg-subtle hover:text-warn-11" aria-label="Remove hop">
            <XIcon className="size-3.5" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={add}
        className="inline-flex w-fit items-center gap-1 rounded px-1 py-0.5 text-caption2 text-fg-subtle hover:text-fg"
      >
        <PlusIcon className="size-3" /> {hops.length ? "hop" : "direct — add hop"}
      </button>
    </div>
  );
}

/**
 * Editable rack-centric endpoint table for one direction (inputs or outputs).
 * Rows are every channel of every rack; editing a cell upserts the endpoint keyed
 * by rack + dir + index. Stage devices (non-racks) feed the From/To path picker.
 */
export function PatchTable({
  dir,
  racks,
  stageDevices,
  endpoints,
  onChange,
}: {
  dir: Dir;
  racks: PatchDevice[];
  stageDevices: PatchDevice[];
  endpoints: PatchEndpoint[];
  onChange: (next: PatchEndpoint[]) => void;
}) {
  const byKey = new Map(endpoints.map((e) => [keyOf(e.rackId, e.dir, e.index), e] as const));

  function upsert(rackId: string, index: number, patch: Partial<PatchEndpoint>) {
    const k = keyOf(rackId, dir, index);
    const existing = byKey.get(k) ?? { rackId, dir, index };
    const next = endpoints.filter((e) => keyOf(e.rackId, e.dir, e.index) !== k);
    next.push({ ...existing, ...patch });
    onChange(next);
  }

  if (racks.length === 0) {
    return <div className="rounded-lg border border-line bg-surface px-4 py-6 text-center text-footnote text-fg-subtle">Add a rack device above to build the {dir === "in" ? "input" : "output"} patch.</div>;
  }

  const headCols =
    dir === "in"
      ? ["#", "Console", "Source", "Mic", "48V", "From"]
      : ["#", "Console", "Destination", "Feed", "To", ""];

  return (
    <div className="flex flex-col gap-4">
      {racks.map((rack) => {
        const count = dir === "in" ? rack.inputs : rack.outputs;
        return (
          <div key={rack.id} className="overflow-hidden rounded-xl border border-line bg-surface">
            <div className="border-b border-line px-4 py-2 text-footnote font-semibold text-fg">{rack.name}</div>
            <div className="overflow-x-auto">
              <div className="min-w-[680px]">
                <div className="grid grid-cols-[40px_64px_1fr_110px_44px_1.4fr] gap-2 border-b border-line px-3 py-1.5 text-caption2 font-semibold uppercase tracking-wider text-fg-subtle">
                  {headCols.map((c, i) => (
                    <div key={i} className={i === 4 && dir === "in" ? "text-center" : ""}>{c}</div>
                  ))}
                </div>
                {Array.from({ length: Math.max(0, count) }, (_, i) => i + 1).map((idx) => {
                  const e = byKey.get(keyOf(rack.id, dir, idx));
                  return (
                    <div key={idx} className="grid grid-cols-[40px_64px_1fr_110px_44px_1.4fr] items-start gap-2 border-b border-line/60 px-3 py-1.5">
                      <div className="pt-1.5 font-mono text-caption1 tabular-nums text-fg-subtle">{idx}</div>
                      <input
                        value={e?.consoleChannel ?? ""}
                        onChange={(ev) => upsert(rack.id, idx, { consoleChannel: ev.target.value })}
                        placeholder="—"
                        className="h-7 w-full rounded border border-line-strong bg-field px-1.5 text-footnote tabular-nums text-fg focus:outline-none focus:border-focus"
                      />
                      <Input
                        value={e?.label ?? ""}
                        onChange={(ev) => upsert(rack.id, idx, { label: ev.target.value })}
                        placeholder={dir === "in" ? "Source" : "Destination"}
                      />
                      {dir === "in" ? (
                        <>
                          <Input value={e?.mic ?? ""} onChange={(ev) => upsert(rack.id, idx, { mic: ev.target.value })} placeholder="Mic / DI" />
                          <div className="flex justify-center pt-1">
                            <Switch checked={e?.phantom ?? false} onCheckedChange={(v) => upsert(rack.id, idx, { phantom: v })} />
                          </div>
                        </>
                      ) : (
                        <>
                          <Input value={e?.feedType ?? ""} onChange={(ev) => upsert(rack.id, idx, { feedType: ev.target.value })} placeholder="IEM / wedge…" />
                          <div />
                        </>
                      )}
                      <PathCell path={e?.path} stageDevices={stageDevices} onChange={(hops) => upsert(rack.id, idx, { path: hops })} />
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
