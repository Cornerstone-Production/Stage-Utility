import { useEffect, useMemo, useState } from "react";
import { PlusIcon, Trash2Icon, ChevronUpIcon, ChevronDownIcon, XIcon, ChevronLeftIcon, ChevronRightIcon, ExternalLinkIcon } from "lucide-react";

import { Button, Input, Switch, Select, SelectTrigger, SelectValue, SelectContent, SelectItem, EmptyState, confirm } from "../../components/ui";
import { invoke } from "../../lib/api";
import { RundownTable } from "../../main/rundown-table";
import { resolveScriptViewSpec, computeClocks, buildScriptViewColumns, totalLengthSec, fmtTotal } from "../../main/scriptview-columns";

// crypto.randomUUID is undefined in an insecure (plain-HTTP) context, which prod
// is served over — fall back so layout creation never throws there.
function uid(): string {
  try { return crypto.randomUUID(); } catch { /* insecure context */ }
  return `svl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** ScriptView layouts editor: per-service-type named column presets, with a live
 *  preview against that type's live/next plan. */
export function ScriptViewSection() {
  const [types, setTypes] = useState<ServiceTypeDTO[]>([]);
  const [layouts, setLayouts] = useState<ScriptViewLayout[]>([]);
  const [typeId, setTypeId] = useState<string | null>(null);
  const [noteCats, setNoteCats] = useState<string[]>([]);
  const [rundown, setRundown] = useState<ScriptViewRundownDTO | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [shownIds, setShownIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      invoke<ServiceTypeDTO[]>("stage:listServiceTypes"),
      invoke<ScriptViewLayout[]>("scriptview:listLayouts"),
      invoke<ScriptViewConfig>("scriptview:getConfig"),
    ])
      .then(([t, l, c]) => {
        setTypes(t);
        setLayouts(l);
        setShownIds(c.serviceTypeIds ?? []);
        setTypeId((cur) => cur ?? l[0]?.serviceTypeId ?? t[0]?.id ?? null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  async function toggleShown(id: string, on: boolean) {
    // Preserve service-type order (PCO listing order) when adding.
    const next = on
      ? types.filter((t) => shownIds.includes(t.id) || t.id === id).map((t) => t.id)
      : shownIds.filter((x) => x !== id);
    setShownIds(next);
    try { await invoke("scriptview:setConfig", { serviceTypeIds: next }); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  useEffect(() => {
    if (!typeId) return;
    setRundown(null);
    invoke<string[]>("scriptview:noteCategories", { serviceTypeId: typeId }).then(setNoteCats).catch(() => setNoteCats([]));
    invoke<ScriptViewRundownDTO>("scriptview:rundown", { serviceTypeId: typeId }).then(setRundown).catch(() => setRundown(null));
  }, [typeId]);

  const typeLayouts = useMemo(
    () => layouts.filter((l) => l.serviceTypeId === typeId).sort((a, b) => a.order - b.order),
    [layouts, typeId],
  );

  async function persist(next: ScriptViewLayout[]) {
    setLayouts(next);
    try { await invoke("scriptview:saveLayouts", { layouts: next }); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  const update = (id: string, patch: Partial<ScriptViewLayout>) =>
    persist(layouts.map((l) => (l.id === id ? { ...l, ...patch } : l)));

  function addLayout() {
    if (!typeId) return;
    const order = typeLayouts.length ? Math.max(...typeLayouts.map((l) => l.order)) + 1 : 0;
    const layout: ScriptViewLayout = {
      id: uid(), serviceTypeId: typeId, name: `Layout ${typeLayouts.length + 1}`, order,
      columns: [...noteCats], accentDepartment: null, // all element toggles default on
    };
    setExpandedId(layout.id);
    persist([...layouts, layout]);
  }

  async function removeLayout(l: ScriptViewLayout) {
    if (!(await confirm({ title: `Delete "${l.name}"?`, confirmLabel: "Delete", destructive: true }))) return;
    persist(layouts.filter((x) => x.id !== l.id));
  }

  function moveLayout(l: ScriptViewLayout, dir: -1 | 1) {
    const arr = [...typeLayouts];
    const i = arr.findIndex((x) => x.id === l.id);
    const j = i + dir;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    const reordered = arr.map((x, idx) => ({ ...x, order: idx }));
    const others = layouts.filter((x) => x.serviceTypeId !== typeId);
    persist([...others, ...reordered]);
  }

  // Column ops on one layout.
  const addColumn = (l: ScriptViewLayout, cat: string) => update(l.id, { columns: [...l.columns, cat] });
  const removeColumn = (l: ScriptViewLayout, cat: string) => {
    const patch: Partial<ScriptViewLayout> = { columns: l.columns.filter((c) => c !== cat) };
    if (l.accentDepartment === cat) patch.accentDepartment = null;
    update(l.id, patch);
  };
  const moveColumn = (l: ScriptViewLayout, idx: number, dir: -1 | 1) => {
    const cols = [...l.columns];
    const j = idx + dir;
    if (j < 0 || j >= cols.length) return;
    [cols[idx], cols[j]] = [cols[j], cols[idx]];
    update(l.id, { columns: cols });
  };

  // The expanded card is the one being edited + previewed; fall back to the first.
  const openId = typeLayouts.some((l) => l.id === expandedId) ? expandedId : (typeLayouts[0]?.id ?? null);

  return (
    <div className="px-5 max-sm:px-3 pt-5 max-sm:pt-4 pb-[50vh]">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <h2 className="text-title3 font-semibold text-gray-12">ScriptView layouts</h2>
          <p className="text-caption1 text-gray-10 mt-0.5 max-w-prose">
            Named column presets per service type — our in-app replacement for ScriptViewer. Each opens at a shareable URL you can pin in its own tab.
          </p>
        </div>
        <a href="/scriptview" target="_blank" rel="noopener noreferrer" className="shrink-0 inline-flex items-center gap-1.5 text-caption1 text-gray-11 hover:text-gray-12 rounded-lg border border-gray-a5 px-3 py-1.5">
          Open ScriptView <ExternalLinkIcon className="size-3.5" />
        </a>
      </div>

      {error && <p className="text-caption1 text-red-11 mb-3">{error}</p>}

      {/* Which service types appear on the landing page (curated per church). */}
      <div className="rounded-xl border border-gray-a5 bg-gray-a2 p-4 mb-5">
        <div className="text-caption2 uppercase tracking-wider text-gray-9 mb-2">Shown on the landing page</div>
        {types.length === 0 ? (
          <p className="text-caption1 text-gray-9">Loading service types…</p>
        ) : (
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {types.map((t) => (
              <label key={t.id} className="flex items-center gap-2 text-caption1 text-gray-11">
                <Switch checked={shownIds.includes(t.id)} onCheckedChange={(v: boolean) => toggleShown(t.id, v)} /> {t.name}
              </label>
            ))}
          </div>
        )}
        <p className="text-caption2 text-gray-9 mt-2">Only the selected service types appear on the ScriptView landing page.</p>
      </div>

      <div className="flex items-center gap-2 mb-4">
        <span className="text-caption1 text-gray-11">Service type</span>
        <Select value={typeId ?? ""} onValueChange={(v) => { setTypeId(v); setExpandedId(null); }}>
          <SelectTrigger className="w-64"><SelectValue placeholder="Select a service type" /></SelectTrigger>
          <SelectContent>
            {types.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {typeLayouts.length === 0 ? (
        <EmptyState
          title="No layouts yet"
          hint="Add a layout to choose which PCO note columns show for this service type."
          action={<Button variant="accent" size="small" onClick={addLayout}><PlusIcon className="size-4" /> Add layout</Button>}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {typeLayouts.map((l, li) => {
            const open = openId === l.id;
            const remaining = noteCats.filter((c) => !l.columns.includes(c));
            return (
              <div key={l.id} className="rounded-xl border border-gray-a5 bg-gray-a2 overflow-hidden">
                {/* Header — click to expand/collapse (and preview). */}
                <div className="flex items-center gap-2 p-3">
                  <button
                    onClick={() => setExpandedId(open ? null : l.id)}
                    className="shrink-0 text-gray-10 hover:text-gray-12"
                    aria-label={open ? "Collapse" : "Expand"}
                    aria-expanded={open}
                  >
                    <ChevronRightIcon className={`size-4 transition-transform ${open ? "rotate-90" : ""}`} />
                  </button>
                  <Input value={l.name} onChange={(e) => update(l.id, { name: e.target.value })} className="max-w-[14rem] font-medium" />
                  {!open && (
                    <span className="text-caption1 text-gray-9 truncate min-w-0 hidden sm:block">
                      {l.columns.length ? l.columns.join(" · ") : "No columns"}
                    </span>
                  )}
                  <div className="ml-auto flex items-center gap-1 shrink-0">
                    <Button variant="transparent" size="small" iconOnly disabled={li === 0} onClick={() => moveLayout(l, -1)} aria-label="Move up"><ChevronUpIcon className="size-4" /></Button>
                    <Button variant="transparent" size="small" iconOnly disabled={li === typeLayouts.length - 1} onClick={() => moveLayout(l, 1)} aria-label="Move down"><ChevronDownIcon className="size-4" /></Button>
                    <Button variant="transparent" size="small" iconOnly onClick={() => removeLayout(l)} aria-label="Delete"><Trash2Icon className="size-4 text-red-10" /></Button>
                  </div>
                </div>

                {open && (
                  <div className="px-4 pb-4 border-t border-gray-a4 pt-3">
                    <div className="mb-3">
                      <span className="text-caption2 uppercase tracking-wider text-gray-9">Columns</span>
                      <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                        {l.columns.length === 0 && <span className="text-caption1 text-gray-9">No columns — add one →</span>}
                        {l.columns.map((c, ci) => (
                          <span key={c} className="inline-flex items-center gap-1 rounded-md border border-gray-a5 bg-gray-a3 pl-2 pr-1 py-1 text-caption1 text-gray-12">
                            <button className="text-gray-9 hover:text-gray-12 disabled:opacity-30" disabled={ci === 0} onClick={() => moveColumn(l, ci, -1)} aria-label="Move left"><ChevronLeftIcon className="size-3.5" /></button>
                            {c}
                            <button className="text-gray-9 hover:text-gray-12 disabled:opacity-30" disabled={ci === l.columns.length - 1} onClick={() => moveColumn(l, ci, 1)} aria-label="Move right"><ChevronRightIcon className="size-3.5" /></button>
                            <button className="text-gray-9 hover:text-red-10 ml-0.5" onClick={() => removeColumn(l, c)} aria-label={`Remove ${c}`}><XIcon className="size-3.5" /></button>
                          </span>
                        ))}
                        {remaining.length > 0 && (
                          <Select value="" onValueChange={(v) => addColumn(l, v)}>
                            <SelectTrigger className="w-auto h-7 px-2 text-caption1"><span className="inline-flex items-center gap-1 text-gray-10"><PlusIcon className="size-3.5" /> Add</span></SelectTrigger>
                            <SelectContent>
                              {remaining.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 mb-4">
                      <label className="flex items-center gap-2 text-caption1 text-gray-11"><Switch checked={l.showClock !== false} onCheckedChange={(v: boolean) => update(l.id, { showClock: v })} /> Clock</label>
                      <label className="flex items-center gap-2 text-caption1 text-gray-11"><Switch checked={l.showLength !== false} onCheckedChange={(v: boolean) => update(l.id, { showLength: v })} /> Time</label>
                      <label className="flex items-center gap-2 text-caption1 text-gray-11"><Switch checked={l.showKey !== false} onCheckedChange={(v: boolean) => update(l.id, { showKey: v })} /> Song key</label>
                      <label className="flex items-center gap-2 text-caption1 text-gray-11"><Switch checked={l.showBpm !== false} onCheckedChange={(v: boolean) => update(l.id, { showBpm: v })} /> BPM</label>
                      <label className="flex items-center gap-2 text-caption1 text-gray-11"><Switch checked={l.showArrangement !== false} onCheckedChange={(v: boolean) => update(l.id, { showArrangement: v })} /> Arrangement</label>
                      <label className="flex items-center gap-2 text-caption1 text-gray-11"><Switch checked={l.showItemNotes !== false} onCheckedChange={(v: boolean) => update(l.id, { showItemNotes: v })} /> Item notes</label>
                      <label className="flex items-center gap-2 text-caption1 text-gray-11"><Switch checked={l.showTotalTime !== false} onCheckedChange={(v: boolean) => update(l.id, { showTotalTime: v })} /> Total time</label>
                      <div className="flex items-center gap-2 text-caption1 text-gray-11">
                        Row accent
                        <Select value={l.accentDepartment ?? "__none__"} onValueChange={(v) => update(l.id, { accentDepartment: v === "__none__" ? null : v })}>
                          <SelectTrigger className="w-40 h-7"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none__">None</SelectItem>
                            {l.columns.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>

                    {/* Inline live preview for this layout (16:9, scrolls internally). */}
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-caption2 uppercase tracking-wider text-gray-9">Preview</span>
                      {rundown?.planTitle && <span className="text-caption1 text-gray-11">{rundown.planTitle}</span>}
                    </div>
                    <div className="rounded-xl border border-white/10 overflow-hidden aspect-video w-full kiosk-surface">
                      <div className="h-full overflow-y-auto">
                        {!rundown ? (
                          <div className="p-6 text-caption1 text-gray-9">Loading plan…</div>
                        ) : rundown.items.length === 0 ? (
                          <div className="p-6 text-caption1 text-gray-9">No upcoming plan for this service type.</div>
                        ) : (
                          <RundownTable
                            items={rundown.items}
                            columns={buildScriptViewColumns(resolveScriptViewSpec(l, noteCats), computeClocks(rundown.items, rundown.serviceTimes?.[0]), rundown.timeZone)}
                            accentDepartment={l.accentDepartment ?? null}
                            autoScroll={false}
                            footer={l.showTotalTime !== false ? <span>{fmtTotal(totalLengthSec(rundown.items))} <span className="text-white/40">· total time</span></span> : undefined}
                          />
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          <Button variant="filled" size="small" className="self-start" onClick={addLayout}><PlusIcon className="size-4" /> Add layout</Button>
        </div>
      )}
    </div>
  );
}
