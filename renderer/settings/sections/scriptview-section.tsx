import { useEffect, useMemo, useState } from "react";
import { PlusIcon, Trash2Icon, ChevronUpIcon, ChevronDownIcon, XIcon, ChevronLeftIcon, ChevronRightIcon, ExternalLinkIcon, EyeIcon } from "lucide-react";

import { Button, Input, Switch, Select, SelectTrigger, SelectValue, SelectContent, SelectItem, EmptyState, confirm } from "../../components/ui";
import { invoke } from "../../lib/api";
import { RundownTable, songMeta, type RundownColumn } from "../../main/rundown-table";

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
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      invoke<ServiceTypeDTO[]>("stage:listServiceTypes"),
      invoke<ScriptViewLayout[]>("scriptview:listLayouts"),
    ])
      .then(([t, l]) => {
        setTypes(t);
        setLayouts(l);
        setTypeId((cur) => cur ?? l[0]?.serviceTypeId ?? t[0]?.id ?? null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

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
      columns: [...noteCats], showLength: true, showTitleMeta: true, accentDepartment: null,
    };
    setPreviewId(layout.id);
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

  const previewLayout = typeLayouts.find((l) => l.id === previewId) ?? typeLayouts[0] ?? null;

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

      <div className="flex items-center gap-2 mb-4">
        <span className="text-caption1 text-gray-11">Service type</span>
        <Select value={typeId ?? ""} onValueChange={(v) => { setTypeId(v); setPreviewId(null); }}>
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
            const remaining = noteCats.filter((c) => !l.columns.includes(c));
            return (
              <div key={l.id} className="rounded-xl border border-gray-a5 bg-gray-a2 p-4">
                <div className="flex items-center gap-2 mb-3">
                  <Input value={l.name} onChange={(e) => update(l.id, { name: e.target.value })} className="max-w-xs font-medium" />
                  <div className="ml-auto flex items-center gap-1">
                    <Button variant="transparent" size="small" iconOnly disabled={li === 0} onClick={() => moveLayout(l, -1)} aria-label="Move up"><ChevronUpIcon className="size-4" /></Button>
                    <Button variant="transparent" size="small" iconOnly disabled={li === typeLayouts.length - 1} onClick={() => moveLayout(l, 1)} aria-label="Move down"><ChevronDownIcon className="size-4" /></Button>
                    <Button variant="transparent" size="small" iconOnly onClick={() => setPreviewId(l.id)} aria-label="Preview"><EyeIcon className={`size-4 ${previewLayout?.id === l.id ? "text-accent-11" : ""}`} /></Button>
                    <Button variant="transparent" size="small" iconOnly onClick={() => removeLayout(l)} aria-label="Delete"><Trash2Icon className="size-4 text-red-10" /></Button>
                  </div>
                </div>

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

                <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                  <label className="flex items-center gap-2 text-caption1 text-gray-11"><Switch checked={l.showLength !== false} onCheckedChange={(v: boolean) => update(l.id, { showLength: v })} /> Show length</label>
                  <label className="flex items-center gap-2 text-caption1 text-gray-11"><Switch checked={l.showTitleMeta !== false} onCheckedChange={(v: boolean) => update(l.id, { showTitleMeta: v })} /> Show item detail</label>
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
              </div>
            );
          })}

          <Button variant="filled" size="small" className="self-start" onClick={addLayout}><PlusIcon className="size-4" /> Add layout</Button>
        </div>
      )}

      {/* Live preview */}
      {previewLayout && (
        <div className="mt-6">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-caption2 uppercase tracking-wider text-gray-9">Preview</span>
            <span className="text-caption1 text-gray-11">{previewLayout.name}{rundown?.planTitle ? ` · ${rundown.planTitle}` : ""}</span>
          </div>
          <div className="rounded-xl border border-white/10 overflow-hidden max-h-[420px] overflow-y-auto kiosk-surface">
            {!rundown ? (
              <div className="p-6 text-caption1 text-gray-9">Loading plan…</div>
            ) : rundown.items.length === 0 ? (
              <div className="p-6 text-caption1 text-gray-9">No upcoming plan for this service type.</div>
            ) : (
              <RundownTable
                items={rundown.items}
                columns={previewColumns(previewLayout)}
                accentDepartment={previewLayout.accentDepartment ?? null}
                autoScroll={false}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function previewColumns(l: ScriptViewLayout): RundownColumn[] {
  const c: RundownColumn[] = [];
  if (l.showLength !== false) c.push({ key: "len", header: "Time", align: "right", width: "4.5rem", cellClassName: "text-white/55", render: (it) => fmtLen(it.lengthSec) });
  c.push({
    key: "title", header: "Item",
    render: (it, { isCurrent }) => {
      const meta = l.showTitleMeta !== false ? songMeta(it) : null;
      return (
        <div className="flex flex-col leading-tight">
          <span className={`font-medium ${isCurrent ? "text-[#7fe3c4]" : "text-white/90"}`}>{it.title}</span>
          {meta && <span className="text-caption2 italic text-[#8ab4ff]/85">{meta}</span>}
          {l.showTitleMeta !== false && !meta && it.description && <span className="text-caption2 text-white/45 whitespace-pre-line">{it.description}</span>}
        </div>
      );
    },
  });
  for (const cat of l.columns) c.push({ key: `note:${cat}`, header: cat, cellClassName: "text-white/60 whitespace-pre-line", render: (it) => it.notesByCategory[cat] ?? "" });
  return c;
}

function fmtLen(sec: number): string {
  if (!sec || sec <= 0) return "—";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
