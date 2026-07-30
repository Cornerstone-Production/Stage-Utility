import { useEffect, useMemo, useState } from "react";
import { PlusIcon, Trash2Icon, ChevronUpIcon, ChevronDownIcon, XIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";

import { Button, Input, Switch, Select, SelectTrigger, SelectValue, SelectContent, SelectItem, MultiSelect, EmptyState, Collapsible, confirm } from "../../components/ui";
import { invoke } from "../../lib/api";
import { useStageState } from "../../main/use-stage-state";
import { RundownTable } from "../../main/rundown-table";
import { categoryColour, normaliseCategory } from "../../main/category-colour";
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
  // Category colours are app-wide, so they come off stage state rather than a layout.
  const categoryColors = useStageState().state?.scriptViewCategoryColors;
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
        // Preview against the first enabled type, else the first service type.
        setTypeId((cur) => cur ?? (c.serviceTypeIds ?? [])[0] ?? t[0]?.id ?? null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  async function setShown(ids: string[]) {
    // Store in PCO listing order regardless of the order they were checked.
    const wanted = new Set(ids);
    const next = types.filter((t) => wanted.has(t.id)).map((t) => t.id);
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

  // Layouts are global — one set across all service types. `typeId` only chooses
  // which type/plan to preview against (and which note categories are offered).
  const sortedLayouts = useMemo(
    () => [...layouts].sort((a, b) => a.order - b.order),
    [layouts],
  );

  // Only the categories actually chosen as a row accent by some layout — that choice is
  // ours, not PCO's. Colouring every category PCO happens to report would be a long list
  // of entries that change nothing. Anything already given a colour stays listed so it
  // can still be reset after its layout stops using it.
  const accentCategories = useMemo(() => {
    const seen = new Map<string, string>();
    for (const l of layouts) {
      const a = l.accentDepartment?.trim();
      if (a) seen.set(normaliseCategory(a), a);
    }
    for (const k of Object.keys(categoryColors ?? {})) if (!seen.has(k)) seen.set(k, k);
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
  }, [layouts, categoryColors]);

  async function persist(next: ScriptViewLayout[]) {
    setLayouts(next);
    try { await invoke("scriptview:saveLayouts", { layouts: next }); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }

  const update = (id: string, patch: Partial<ScriptViewLayout>) =>
    persist(layouts.map((l) => (l.id === id ? { ...l, ...patch } : l)));

  function addLayout() {
    const order = sortedLayouts.length ? Math.max(...sortedLayouts.map((l) => l.order)) + 1 : 0;
    const layout: ScriptViewLayout = {
      id: uid(), name: `Layout ${sortedLayouts.length + 1}`, order,
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
    const arr = [...sortedLayouts];
    const i = arr.findIndex((x) => x.id === l.id);
    const j = i + dir;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    persist(arr.map((x, idx) => ({ ...x, order: idx })));
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

  // The expanded card is the one being edited + previewed. Null = all collapsed
  // (the default, and reachable by toggling the open one shut); a stale id (deleted
  // layout) also collapses rather than forcing the first one open.
  const openId = sortedLayouts.some((l) => l.id === expandedId) ? expandedId : null;

  return (
    <div className="px-5 max-sm:px-3 pt-5 max-sm:pt-4 pb-[50vh]">
      {/* "Open ScriptView" lives inline in the section header (settings-view). */}
      {error && <p className="text-caption1 text-red-11 mb-3">{error}</p>}

      {/* Which service types appear on the landing page (curated per church). */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 mb-5">
        <span className="text-caption1 text-gray-11">Shown on the landing page</span>
        <MultiSelect
          className="w-64 max-sm:w-full"
          options={types.map((t) => ({ value: t.id, label: t.name }))}
          selected={shownIds}
          onChange={setShown}
          placeholder={types.length === 0 ? "Loading service types…" : "Select service types…"}
          disabled={types.length === 0}
        />
        <span className="text-caption2 text-gray-9 basis-full sm:basis-auto">Only these appear on the ScriptView landing page.</span>
      </div>

      <div className="flex items-center gap-2 mb-4">
        <span className="text-caption1 text-gray-11">Preview with</span>
        <Select value={typeId ?? ""} onValueChange={(v) => setTypeId(v)}>
          <SelectTrigger className="w-64"><SelectValue placeholder="Select a service type" /></SelectTrigger>
          <SelectContent>
            {types.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <span className="text-caption2 text-gray-9">the plan + note columns used for the previews below</span>
      </div>

      {sortedLayouts.length === 0 ? (
        <EmptyState
          title="No layouts yet"
          hint="Add a layout to choose which PCO note columns show. Layouts apply across every service type."
          action={<Button variant="accent" size="small" onClick={addLayout}><PlusIcon className="size-4" /> Add layout</Button>}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {sortedLayouts.map((l, li) => {
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
                    <Button variant="transparent" size="small" iconOnly disabled={li === sortedLayouts.length - 1} onClick={() => moveLayout(l, 1)} aria-label="Move down"><ChevronDownIcon className="size-4" /></Button>
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
                            itemTypeColors={rundown.itemTypeColors}
                            categoryColors={categoryColors}
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

      {/* Last on the page and collapsed: these are set once and rarely revisited, so
          they should not be the first thing you look at. */}
      <Collapsible
        label={<span className="text-callout font-semibold text-fg">Row accent colours</span>}
        summary={accentCategories.length ? `${accentCategories.length} in use` : "none in use"}
        className="rounded-xl border border-line bg-surface px-3 py-2"
      >
        <CategoryColoursPanel categories={accentCategories} colors={categoryColors} />
      </Collapsible>
    </div>
  );
}

/**
 * One colour per note category, app-wide.
 *
 * Note categories are fetched per service type, so "Audio" exists separately under
 * Weekend, Youth and Salt Company. Storing the colour on a layout would mean setting it
 * once per layout per service type; storing it here means setting Audio once.
 *
 * "Reset" clears the colour so the category falls back to its suggestion — it does not
 * remove the category, which PCO owns.
 */
function CategoryColoursPanel({
  categories,
  colors,
}: {
  categories: string[];
  colors?: Record<string, string>;
}) {
  const set = (category: string, color: string) =>
    void invoke("scriptview:setCategoryColor", { category, color });

  if (categories.length === 0) {
    return (
      <p className="py-1 text-caption1 text-fg-muted">
        Pick a row accent on a layout above, then its colour appears here.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2 pt-1">
      <span className="text-caption2 text-fg-muted">
        Used for the row stripe when a layout accents this category. Set once — the same
        colour applies under every service type.
      </span>
      <div className="flex flex-col gap-1">
        {categories.map((cat) => {
          const key = normaliseCategory(cat);
          const chosen = colors?.[key];
          return (
            <div key={key} className="flex items-center gap-2">
              <label
                className="size-5 shrink-0 cursor-pointer rounded border border-line-strong"
                style={{ backgroundColor: categoryColour(cat, colors) }}
                title={`Change the ${cat} colour`}
              >
                <input
                  type="color"
                  className="sr-only"
                  value={categoryColour(cat, colors)}
                  aria-label={`${cat} colour`}
                  onChange={(e) => set(cat, e.target.value)}
                />
              </label>
              <span className="min-w-0 flex-1 truncate text-caption1 text-gray-11">{cat}</span>
              {chosen && (
                <Button variant="transparent" size="small" onClick={() => set(cat, "")} title="Back to the default colour">
                  Reset
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
