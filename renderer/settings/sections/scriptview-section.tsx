import { errorMessage } from "@main/services/errors";
import { useEffect, useMemo, useState } from "react";
import { PlusIcon, Trash2Icon, ChevronUpIcon, ChevronDownIcon, XIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";

import { Button, Input, Select, SelectTrigger, SelectValue, SelectContent, SelectItem, MultiSelect, EmptyState, Collapsible, confirm } from "../../components/ui";
import { invoke } from "../../lib/api";
import { RundownTable } from "../../main/rundown-table";
import { resolveScriptViewSpec, computeClocks, buildScriptViewColumns, totalLengthSec, fmtTotal } from "../../main/scriptview-columns";
import type { CategoryRole } from "../../../main/types/scriptview-roles.js";
import { useResyncOn } from "@renderer/lib/use-resync-on";

// crypto.randomUUID is undefined in an insecure (plain-HTTP) context, which prod
// is served over — fall back so layout creation never throws there.
function uid(): string {
  try { return crypto.randomUUID(); } catch { /* insecure context */ }
  return `svl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** ScriptView layouts editor: per-service-type named column presets, with a live
 *  preview against that type's live/next plan. */
/** The per-layout element toggles, as one list so the picker and the patch stay in
 *  step. `show*` is opt-OUT by default: undefined means shown, only `false` hides.
 *  `optIn` inverts that for elements that should NOT appear on a preset saved
 *  before they existed — Max SPL is only meaningful with Smaart connected, and
 *  turning it on for every existing layout would add a column of dashes. */
const ELEMENTS = [
  { key: "showClock", label: "Clock" },
  { key: "showLength", label: "Time" },
  { key: "showKey", label: "Song key" },
  { key: "showBpm", label: "BPM" },
  { key: "showArrangement", label: "Arrangement" },
  { key: "showItemNotes", label: "Item notes" },
  { key: "showTotalTime", label: "Total time" },
  { key: "showMaxSpl", label: "Max SPL", optIn: true },
] as const satisfies readonly { key: keyof ScriptViewLayout; label: string; optIn?: boolean }[];

/** Is this element currently on for `l`? Opt-in elements need an explicit true. */
const elementOn = (e: (typeof ELEMENTS)[number], l: ScriptViewLayout): boolean =>
  "optIn" in e && e.optIn ? l[e.key] === true : l[e.key] !== false;

export function ScriptViewSection() {
  const [types, setTypes] = useState<ServiceTypeDTO[]>([]);
  const [layouts, setLayouts] = useState<ScriptViewLayout[]>([]);
  const [typeId, setTypeId] = useState<string | null>(null);
  const [noteCats, setNoteCats] = useState<string[]>([]);
  const [roles, setRoles] = useState<CategoryRole[]>([]);
  const [rundown, setRundown] = useState<ScriptViewRundownDTO | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [shownIds, setShownIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      invoke<ServiceTypeDTO[]>("stage:listServiceTypes"),
      invoke<ScriptViewLayout[]>("scriptview:listLayouts"),
      invoke<ScriptViewConfig>("scriptview:getConfig"),
      invoke<CategoryRole[]>("scriptview:listRoles"),
    ])
      .then(([t, l, c, r]) => {
        setTypes(t);
        setLayouts(l);
        setRoles(r);
        setShownIds(c.serviceTypeIds ?? []);
        // Preview against the first enabled type, else the first service type.
        setTypeId((cur) => cur ?? (c.serviceTypeIds ?? [])[0] ?? t[0]?.id ?? null);
      })
      .catch((e) => setError(errorMessage(e)));
  }, []);

  async function setShown(ids: string[]) {
    // Store in PCO listing order regardless of the order they were checked.
    const wanted = new Set(ids);
    const next = types.filter((t) => wanted.has(t.id)).map((t) => t.id);
    setShownIds(next);
    try { await invoke("scriptview:setConfig", { serviceTypeIds: next }); }
    catch (e) { setError(errorMessage(e)); }
  }

  // Drop the previous type's rundown in the same render the type changes, so the
  // preview never shows the old plan while the new one is still in flight.
  useResyncOn([typeId], () => {
    if (typeId) setRundown(null);
  });

  useEffect(() => {
    if (!typeId) return;
    invoke<string[]>("scriptview:noteCategories", { serviceTypeId: typeId }).then(setNoteCats).catch(() => setNoteCats([]));
    invoke<ScriptViewRundownDTO>("scriptview:rundown", { serviceTypeId: typeId }).then(setRundown).catch(() => setRundown(null));
  }, [typeId]);

  // Layouts are global — one set across all service types. `typeId` only chooses
  // which type/plan to preview against (and which note categories are offered).
  const sortedLayouts = useMemo(
    () => [...layouts].sort((a, b) => a.order - b.order),
    [layouts],
  );


  async function persist(next: ScriptViewLayout[]) {
    setLayouts(next);
    try { await invoke("scriptview:saveLayouts", { layouts: next }); }
    catch (e) { setError(errorMessage(e)); }
  }

  const update = (id: string, patch: Partial<ScriptViewLayout>) =>
    persist(layouts.map((l) => (l.id === id ? { ...l, ...patch } : l)));

  function addLayout() {
    const order = sortedLayouts.length ? Math.max(...sortedLayouts.map((l) => l.order)) + 1 : 0;
    const layout: ScriptViewLayout = {
      id: uid(), name: `Layout ${sortedLayouts.length + 1}`, order,
      columnRoles: roles.map((r) => r.id), // all element toggles default on
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

  async function saveRoles(next: CategoryRole[]) {
    setRoles(next);
    // Deleting a role must not leave layouts pointing at it.
    const live = new Set(next.map((r) => r.id));
    const cleaned = layouts.map((l) => ({
      ...l,
      columnRoles: (l.columnRoles ?? []).filter((id) => live.has(id)),
      accentRole: l.accentRole && live.has(l.accentRole) ? l.accentRole : null,
    }));
    if (JSON.stringify(cleaned) !== JSON.stringify(layouts)) await persist(cleaned);
    try {
      await invoke("scriptview:saveRoles", { roles: next });
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  // Column ops on one layout. Columns are ROLE IDS — a role resolves to whatever the
  // service type being viewed happens to call that category.
  const roleName = (id: string) => roles.find((r) => r.id === id)?.name ?? id;
  const addColumn = (l: ScriptViewLayout, roleId: string) =>
    update(l.id, { columnRoles: [...(l.columnRoles ?? []), roleId] });
  const removeColumn = (l: ScriptViewLayout, roleId: string) => {
    const next = (l.columnRoles ?? []).filter((c) => c !== roleId);
    const patch: Partial<ScriptViewLayout> = { columnRoles: next };
    // A layout must not keep accenting a role it no longer shows.
    if (l.accentRole === roleId) patch.accentRole = null;
    update(l.id, patch);
  };
  const moveColumn = (l: ScriptViewLayout, idx: number, dir: -1 | 1) => {
    const cols = [...(l.columnRoles ?? [])];
    const j = idx + dir;
    if (j < 0 || j >= cols.length) return;
    [cols[idx], cols[j]] = [cols[j], cols[idx]];
    update(l.id, { columnRoles: cols });
  };

  // The expanded card is the one being edited + previewed. Null = all collapsed
  // (the default, and reachable by toggling the open one shut); a stale id (deleted
  // layout) also collapses rather than forcing the first one open.
  const openId = sortedLayouts.some((l) => l.id === expandedId) ? expandedId : null;

  return (
    <div className="pt-5 max-sm:pt-4 pb-[50vh] max-sm:pb-24">
      {/* ScriptView is its own rail destination now, so there is no "open it"
          link here: the viewer is one click away in the sidebar. */}
      {error && <p className="text-caption1 text-red-11 mb-3">{error}</p>}

      {/* Which service types appear on the landing page (curated per church). */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 mb-5">
        <span className="text-caption1 text-gray-11">Shown on the landing page</span>
        <MultiSelect
          label="Shown on the landing page"
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
            const remaining = roles.filter((r) => !(l.columnRoles ?? []).includes(r.id));
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
                      {(l.columnRoles ?? []).length ? (l.columnRoles ?? []).map(roleName).join(" · ") : "No columns"}
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
                        {(l.columnRoles ?? []).length === 0 && <span className="text-caption1 text-gray-9">No columns — add one →</span>}
                        {(l.columnRoles ?? []).map((c, ci) => (
                          <span key={c} className="inline-flex items-center gap-1 rounded-md border border-gray-a5 bg-gray-a3 pl-2 pr-1 py-1 text-caption1 text-gray-12">
                            <button className="text-gray-9 hover:text-gray-12 disabled:opacity-30" disabled={ci === 0} onClick={() => moveColumn(l, ci, -1)} aria-label="Move left"><ChevronLeftIcon className="size-3.5" /></button>
                            {roleName(c)}
                            <button className="text-gray-9 hover:text-gray-12 disabled:opacity-30" disabled={ci === (l.columnRoles ?? []).length - 1} onClick={() => moveColumn(l, ci, 1)} aria-label="Move right"><ChevronRightIcon className="size-3.5" /></button>
                            <button className="text-gray-9 hover:text-red-10 ml-0.5" onClick={() => removeColumn(l, c)} aria-label={`Remove ${roleName(c)}`}><XIcon className="size-3.5" /></button>
                          </span>
                        ))}
                        {remaining.length > 0 && (
                          // Native <select>: a custom trigger child cannot render, so the
                          // label has to be a placeholder OPTION. Without one the browser
                          // shows the first real option, which reads as a column this
                          // layout already has rather than a control that adds one.
                          <Select value="" onValueChange={(v) => addColumn(l, v)}>
                            <SelectTrigger className="w-auto h-7 px-2 text-caption1" aria-label="Add a column">
                              <SelectValue placeholder="+ Add column" />
                            </SelectTrigger>
                            <SelectContent>
                              {remaining.map((r) => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 mb-4">
                      {/* Seven switches read as seven decisions and filled the row edge
                          to edge. They are one decision — what this layout shows — so
                          they collapse into the same checkmark dropdown the service-type
                          picker above already uses. The trigger names what is on, so the
                          state is still legible without opening it. */}
                      <div className="flex items-center gap-2 text-caption1 text-gray-11">
                        Shows
                        <MultiSelect
                          // The layout's name is in it because the page repeats
                          // this control once per layout: "Shows" alone names
                          // every one of them and tells them apart not at all.
                          label={`Shows, ${l.name}`}
                          className="w-64"
                          options={ELEMENTS.map((e) => ({ value: e.key, label: e.label }))}
                          selected={ELEMENTS.filter((e) => elementOn(e, l)).map((e) => e.key)}
                          onChange={(next) => {
                            const on = new Set(next);
                            update(l.id, Object.fromEntries(
                              ELEMENTS.map((e) => [e.key, on.has(e.key)]),
                            ) as Partial<ScriptViewLayout>);
                          }}
                          placeholder="Nothing shown"
                        />
                      </div>

                      {/* One source per layout, never both — PCO's color answers "what
                          kind of item is this", the category answers "does my department
                          have something to do here". Stacking them is too much per row. */}
                      <div className="flex items-center gap-2 text-caption1 text-gray-11">
                        Row color
                        <Select
                          value={l.rowColor ?? "pco"}
                          onValueChange={(v) => update(l.id, { rowColor: v as "pco" | "category" | "none" })}
                        >
                          <SelectTrigger className="w-36 h-7"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="pco">From PCO</SelectItem>
                            <SelectItem value="category">By category</SelectItem>
                            <SelectItem value="none">None</SelectItem>
                          </SelectContent>
                        </Select>
                        {(l.rowColor ?? "pco") === "category" && (
                          <Select
                            value={l.accentRole ?? "__none__"}
                            onValueChange={(v) => update(l.id, { accentRole: v === "__none__" ? null : v })}
                          >
                            <SelectTrigger className="w-40 h-7"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__none__">Pick a category…</SelectItem>
                              {/* Every note category the service type defines, not just
                                  this layout's columns. Tinting by a category the layout
                                  does not display is legitimate — "Lighting has a cue
                                  here" is useful without showing the cue text. */}
                              {roles.map((r) => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        )}
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
                            columns={buildScriptViewColumns(resolveScriptViewSpec(l, roles, noteCats), computeClocks(rundown.items, rundown.serviceTimes?.[0]), rundown.timeZone)}
                            itemTypeColors={rundown.itemTypeColors}
                            rowColor={l.rowColor}
                            accentRole={l.accentRole ?? null}
                            roles={roles}
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

      {/* Roles last and collapsed: set up once, rarely revisited. */}
      <Collapsible
        label={<span className="text-callout font-semibold text-fg">Category roles</span>}
        summary={`${roles.length} role${roles.length === 1 ? "" : "s"}`}
        className="rounded-xl border border-gray-a5 bg-gray-a2 px-3 py-2"
      >
        <RolesPanel roles={roles} categories={noteCats} onChange={saveRoles} />
      </Collapsible>
        </div>
      )}

    </div>
  );
}

/**
 * One color per note category, app-wide.
 *
 * Note categories are fetched per service type, so "Audio" exists separately under
 * Weekend, Youth and Salt Company. Storing the color on a layout would mean setting it
 * once per layout per service type; storing it here means setting Audio once.
 *
 * "Reset" clears the color so the category falls back to its suggestion — it does not
 * remove the category, which PCO owns.
 */

/**
 * Category roles — editable alias sets.
 *
 * A church's PCO note categories are defined per service type and the names vary: one
 * org was measured with "Audio" and "Audio/Visual" for the same department, three
 * spellings of "MD + Playback Tech", and case variants of "EG 1 (Lead)". A role groups
 * those names so one layout resolves correctly everywhere.
 *
 * Member ORDER is the priority chain — the first member with a note wins, and several
 * populated members merge in this order.
 */
function RolesPanel({
  roles,
  categories,
  onChange,
}: {
  roles: CategoryRole[];
  categories: string[];
  onChange: (next: CategoryRole[]) => void;
}) {
  const [adding, setAdding] = useState("");
  const norm = (s: string) => s.trim().toLowerCase();

  const assigned = new Set(roles.flatMap((r) => r.members.map(norm)));
  const unassigned = categories.filter((c) => !assigned.has(norm(c)));

  // A category in two roles makes resolution ambiguous — both would claim the note.
  const counts = new Map<string, number>();
  for (const r of roles) for (const m of r.members) counts.set(norm(m), (counts.get(norm(m)) ?? 0) + 1);
  const duplicated = [...counts].filter(([, n]) => n > 1).map(([m]) => m);

  const patch = (id: string, next: Partial<CategoryRole>) =>
    onChange(roles.map((r) => (r.id === id ? { ...r, ...next } : r)));

  const moveMember = (r: CategoryRole, i: number, dir: -1 | 1) => {
    const m = [...r.members];
    const j = i + dir;
    if (j < 0 || j >= m.length) return;
    [m[i], m[j]] = [m[j], m[i]];
    patch(r.id, { members: m });
  };

  return (
    <div className="flex flex-col gap-3 pt-2">
      <span className="text-caption2 text-fg-muted">
        A role groups the names different service types use for the same thing. Layout
        columns reference roles, so one layout works across all of them. Member order is
        the priority chain.
      </span>

      {roles.map((r) => (
        <div key={r.id} className="flex flex-col gap-1.5 rounded-lg border border-gray-a5 p-2">
          <div className="flex items-center gap-2">
            <Input
              value={r.name}
              onChange={(e) => patch(r.id, { name: e.target.value })}
              className="h-7 flex-1 min-w-0"
              aria-label={`Role name for ${r.name}`}
            />
            <Button
              variant="transparent"
              size="small"
              onClick={() => onChange(roles.filter((x) => x.id !== r.id))}
              tooltip="Delete this role and remove it from every layout"
            >
              <Trash2Icon className="size-3.5 text-red-10" />
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {r.members.map((m, mi) => (
              <span key={m} className="inline-flex items-center gap-1 rounded-md border border-gray-a5 bg-gray-a3 pl-2 pr-1 py-0.5 text-caption2 text-gray-12">
                <button className="text-gray-9 hover:text-gray-12 disabled:opacity-30" disabled={mi === 0} onClick={() => moveMember(r, mi, -1)} aria-label="Higher priority"><ChevronLeftIcon className="size-3" /></button>
                {m}
                <button className="text-gray-9 hover:text-gray-12 disabled:opacity-30" disabled={mi === r.members.length - 1} onClick={() => moveMember(r, mi, 1)} aria-label="Lower priority"><ChevronRightIcon className="size-3" /></button>
                <button className="text-gray-9 hover:text-red-10" onClick={() => patch(r.id, { members: r.members.filter((x) => x !== m) })} aria-label={`Remove ${m}`}><XIcon className="size-3" /></button>
              </span>
            ))}
            {categories.some((c) => !r.members.some((m) => norm(m) === norm(c))) && (
              // Select renders a NATIVE <select>, so the label must be a placeholder
              // OPTION — a custom trigger child does not render and the browser would
              // show the first real option as though it were already a member.
              <Select value="" onValueChange={(v) => patch(r.id, { members: [...r.members, v] })}>
                <SelectTrigger className="w-auto h-6 px-2 text-caption2" aria-label={`Add a category to ${r.name}`}>
                  <SelectValue placeholder="+ Add category" />
                </SelectTrigger>
                <SelectContent>
                  {categories.filter((c) => !r.members.some((m) => norm(m) === norm(c)))
                    .map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
          </div>
        </div>
      ))}

      <div className="flex items-center gap-2">
        <Input
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          placeholder="New role name"
          className="h-7 flex-1 min-w-0"
          aria-label="New role name"
        />
        <Button
          variant="filled"
          size="small"
          disabled={!adding.trim()}
          onClick={() => {
            const name = adding.trim();
            if (!name) return;
            onChange([...roles, { id: `role-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${roles.length}`, name, members: [] }]);
            setAdding("");
          }}
        >
          Add role
        </Button>
      </div>

      {unassigned.length > 0 && (
        <div className="flex flex-col gap-1 border-t border-line pt-2">
          <span className="text-caption2 text-fg-muted">
            In no role — these categories can never appear as a column:
          </span>
          <div className="flex flex-wrap gap-1.5">
            {unassigned.map((c) => (
              <Button
                key={c}
                variant="transparent"
                size="small"
                onClick={() => onChange([...roles, { id: `role-${c.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, name: c, members: [c] }])}
                tooltip={`Create a "${c}" role`}
              >
                <PlusIcon className="size-3" /> {c}
              </Button>
            ))}
          </div>
        </div>
      )}

      {duplicated.length > 0 && (
        <p className="border-t border-line pt-2 text-caption2 text-amber-10" role="alert">
          In more than one role, so which column shows its note is ambiguous:{" "}
          {duplicated.join(", ")}
        </p>
      )}
    </div>
  );
}
