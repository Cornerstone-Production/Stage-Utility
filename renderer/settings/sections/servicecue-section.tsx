import { errorMessage } from "@main/services/errors";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { PlusIcon, Trash2Icon, ChevronUpIcon, ChevronDownIcon, XIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";

import { Button, Checkbox, Input, Select, SelectTrigger, SelectValue, SelectContent, SelectItem, MultiSelect, EmptyState, ErrorNote, confirm, SkeletonRows } from "../../components/ui";
import { useRouter } from "@tanstack/react-router";
import { cn } from "../../lib/cn";
import { invoke } from "../../lib/api";
import { useFailedReads } from "../../lib/use-failed-reads";
import { pcoConnected, useStageState } from "../../main/use-stage-state";
import { RundownTable } from "../../main/rundown-table";
import { resolveServiceCueSpec, computeClocks, buildServiceCueColumns, totalLengthSec, fmtTotal } from "../../main/servicecue-columns";
import type { CategoryRole } from "../../../main/types/servicecue-roles.js";
import { useResyncOn } from "@renderer/lib/use-resync-on";
import { freeLayoutName, usersMessage } from "./servicecue-layout-names";
import { useLayoutSaves, type LayoutEdit } from "./use-layout-saves";
import { useNameDraft } from "../../lib/use-name-draft";
import { PublicLinkCard, usePublishSummary } from "./servicecue-public-link";
import { appZoneOf } from "./history-trends/trends";
import { hostTimeZone } from "@main/services/app-timezone";
import { uid } from "@renderer/lib/uid";


/** ServiceCue layouts editor: per-service-type named column presets, with a live
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
  { key: "showMeter", label: "Time signature" },
  { key: "showArrangement", label: "Arrangement" },
  { key: "showItemNotes", label: "Item notes" },
  { key: "showTotalTime", label: "Total time" },
  { key: "showMaxSpl", label: "Max SPL", optIn: true },
] as const satisfies readonly { key: keyof ServiceCueLayout; label: string; optIn?: boolean }[];

/** Is this element currently on for `l`? Opt-in elements need an explicit true. */
const elementOn = (e: (typeof ELEMENTS)[number], l: ServiceCueLayout): boolean =>
  "optIn" in e && e.optIn ? l[e.key] === true : l[e.key] !== false;

export function ServiceCueSection() {
  const [types, setTypes] = useState<ServiceTypeDTO[]>([]);
  const { layouts, adopt: adoptLayouts, edit: editLayouts } = useLayoutSaves();
  const [typeId, setTypeId] = useState<string | null>(null);
  const [noteCats, setNoteCats] = useState<string[]>([]);
  const [roles, setRoles] = useState<CategoryRole[]>([]);
  const [rundown, setRundown] = useState<ServiceCueRundownDTO | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [shownIds, setShownIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  // A rename the server refused, said under the name field it was typed into.
  const [nameError, setNameError] = useState<{ id: string; message: string } | null>(null);
  // Which reads FAILED, as opposed to came back empty. The settings' failure is
  // the dangerous one: drawn as "No layouts yet", its Add layout saved a
  // one-layout list over every real one.
  const { failed, fail, clear } = useFailedReads<"settings" | "types" | "noteCats" | "rundown">("servicecue");
  const [settingsRead, setSettingsRead] = useState(false);
  // Everything Planning Center backs — the service types, and each type's note
  // categories and plan — is asked for only once it is connected, and until
  // then the preview says to connect it (see pcoConnected).
  const stage = useStageState();
  const pcoConfigured = pcoConnected(stage.state, stage.error);
  // A read tried while the state was unknown may have failed only because
  // Planning Center is not connected. Once the state says so, that is what the
  // page shows, not an error.
  useResyncOn([pcoConfigured], () => {
    if (pcoConfigured === false) clear("types", "noteCats", "rundown");
  });

  // This app's own settings: the layouts, which types the landing page shows,
  // and the category roles. Read apart from Planning Center, so one that is not
  // connected, or is down, costs the previews and never the layouts editor.
  useEffect(() => {
    Promise.all([
      invoke<ServiceCueLayout[]>("servicecue:listLayouts"),
      invoke<ServiceCueConfig>("servicecue:getConfig"),
      invoke<CategoryRole[]>("servicecue:listRoles"),
    ])
      .then(([l, c, r]) => {
        adoptLayouts(l);
        setRoles(r);
        setShownIds(c.serviceTypeIds ?? []);
        // Preview against the first enabled type; Planning Center's first is
        // the fallback, below.
        setTypeId((cur) => cur ?? (c.serviceTypeIds ?? [])[0] ?? null);
        setSettingsRead(true);
      })
      .catch((err: unknown) => fail("settings", "the ServiceCue layouts and settings", err));
  }, [fail, adoptLayouts]);

  // After the settings, so the landing page's own first type stays the
  // preview's default whichever read answers first.
  useEffect(() => {
    if (!pcoConfigured || !settingsRead) return;
    let cancelled = false;
    invoke<ServiceTypeDTO[]>("stage:listServiceTypes")
      .then((t) => {
        if (cancelled) return;
        setTypes(t);
        setTypeId((cur) => cur ?? t[0]?.id ?? null);
        clear("types");
      })
      .catch((err: unknown) => {
        if (!cancelled) fail("types", "the service types", err);
      });
    return () => {
      cancelled = true;
    };
  }, [pcoConfigured, settingsRead, fail, clear]);

  async function setShown(ids: string[]) {
    // Store in PCO listing order regardless of the order they were checked.
    const wanted = new Set(ids);
    const next = types.filter((t) => wanted.has(t.id)).map((t) => t.id);
    setShownIds(next);
    try { await invoke("servicecue:setConfig", { serviceTypeIds: next }); }
    catch (e) { setError(errorMessage(e)); }
  }

  // Drop the previous type's rundown in the same render the type changes, so the
  // preview never shows the old plan while the new one is still in flight.
  useResyncOn([typeId], () => {
    if (typeId) {
      setRundown(null);
      clear("noteCats", "rundown");
    }
  });

  useEffect(() => {
    if (!typeId || !pcoConfigured) return;
    // Cancelled on a type change, so a slow read for the previous type can
    // neither land its answer nor its failure under this one.
    let cancelled = false;
    invoke<string[]>("servicecue:noteCategories", { serviceTypeId: typeId })
      .then((c) => { if (!cancelled) setNoteCats(c); })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Emptied as well as flagged, so the previous type's categories are
        // never offered as this one's.
        setNoteCats([]);
        fail("noteCats", `the note categories for service type ${typeId}`, err);
      });
    invoke<ServiceCueRundownDTO>("servicecue:rundown", { serviceTypeId: typeId })
      .then((r) => { if (!cancelled) setRundown(r); })
      .catch((err: unknown) => {
        if (!cancelled) fail("rundown", `the plan to preview for service type ${typeId}`, err);
      });
    return () => {
      cancelled = true;
    };
  }, [typeId, pcoConfigured, fail]);

  // Layouts are global — one set across all service types. `typeId` only chooses
  // which type/plan to preview against (and which note categories are offered).
  const sortedLayouts = useMemo(
    () => [...layouts].sort((a, b) => a.order - b.order),
    [layouts],
  );


  /** Saves an edit; true when the server took it. Edits save one at a time, each applied
   *  to the newest list (see useLayoutSaves). A refusal is said at the name field when
   *  the edit was a rename (`renamed` is that layout's id), else at the top of the page. */
  async function persist(edit: LayoutEdit, renamed?: string): Promise<boolean> {
    // The settings read (this page's own layouts list) has not landed yet: `layouts`
    // is still `[]` regardless of what is actually saved. Posting now would replace
    // every real layout with whatever the edit builds from that empty starting point.
    if (!settingsRead) return false;
    const result = await editLayouts(edit);
    const message = result.ok ? null : result.error;
    if (renamed) setNameError(message === null ? null : { id: renamed, message });
    else setError(message);
    return result.ok;
  }

  /** Changes one layout. `patch` may be a function of the layout as it is when the edit
   *  saves, for a change built on what the layout already holds (its columns). */
  const update = (id: string, patch: Partial<ServiceCueLayout> | ((l: ServiceCueLayout) => Partial<ServiceCueLayout>)) =>
    persist((list) => list.map((l) => (l.id === id ? { ...l, ...(typeof patch === "function" ? patch(l) : patch) } : l)));

  const rename = (id: string, name: string) =>
    persist((list) => list.map((l) => (l.id === id ? { ...l, name } : l)), id);

  function addLayout() {
    if (!settingsRead) return;
    const id = uid("svl");
    const columnRoles = roles.map((r) => r.id); // all element toggles default on
    setExpandedId(id);
    void persist((list) => [
      ...list,
      {
        id,
        // The first free "Layout N" among the layouts as they are when this saves.
        name: freeLayoutName(list),
        order: list.length ? Math.max(...list.map((l) => l.order)) + 1 : 0,
        columnRoles,
        autoNamed: true, // its first rename moves its address; see ServiceCueLayout.autoNamed
      },
    ]);
  }

  async function removeLayout(l: ServiceCueLayout) {
    if (!(await confirm({
      title: `Delete "${l.name}"?`,
      message: usersMessage(l, stage.state?.views),
      confirmLabel: "Delete",
      destructive: true,
    }))) return;
    void persist((list) => list.filter((x) => x.id !== l.id));
  }

  function moveLayout(l: ServiceCueLayout, dir: -1 | 1) {
    void persist((list) => {
      const arr = [...list].sort((a, b) => a.order - b.order);
      const i = arr.findIndex((x) => x.id === l.id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= arr.length) return list;
      [arr[i], arr[j]] = [arr[j], arr[i]];
      return arr.map((x, idx) => ({ ...x, order: idx }));
    });
  }

  async function saveRoles(next: CategoryRole[]) {
    setRoles(next);
    // Deleting a role must not leave layouts pointing at it.
    const live = new Set(next.map((r) => r.id));
    const clean = (list: ServiceCueLayout[]) => list.map((l) => ({
      ...l,
      columnRoles: (l.columnRoles ?? []).filter((id) => live.has(id)),
      accentRole: l.accentRole && live.has(l.accentRole) ? l.accentRole : null,
    }));
    if (JSON.stringify(clean(layouts)) !== JSON.stringify(layouts)) await persist(clean);
    try {
      await invoke("servicecue:saveRoles", { roles: next });
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  // Column ops on one layout. Columns are ROLE IDS — a role resolves to whatever the
  // service type being viewed happens to call that category.
  const roleName = (id: string) => roles.find((r) => r.id === id)?.name ?? id;
  const addColumn = (l: ServiceCueLayout, roleId: string) =>
    update(l.id, (cur) => ({ columnRoles: [...(cur.columnRoles ?? []).filter((c) => c !== roleId), roleId] }));
  const removeColumn = (l: ServiceCueLayout, roleId: string) =>
    update(l.id, (cur) => ({
      columnRoles: (cur.columnRoles ?? []).filter((c) => c !== roleId),
      // A layout must not keep accenting a role it no longer shows.
      ...(cur.accentRole === roleId ? { accentRole: null } : {}),
    }));
  const moveColumn = (l: ServiceCueLayout, roleId: string, dir: -1 | 1) =>
    update(l.id, (cur) => {
      const cols = [...(cur.columnRoles ?? [])];
      const i = cols.indexOf(roleId);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= cols.length) return {};
      [cols[i], cols[j]] = [cols[j], cols[i]];
      return { columnRoles: cols };
    });

  // The expanded card is the one being edited + previewed. Null = all collapsed
  // (the default, and reachable by toggling the open one shut); a stale id (deleted
  // layout) also collapses rather than forcing the first one open.
  const openId = sortedLayouts.some((l) => l.id === expandedId) ? expandedId : null;
  // What both service-type pickers say while they have no types to offer.
  const typesPending =
    pcoConfigured === false
      ? "Connect Planning Center to pick"
      : failed.has("types") || failed.has("settings")
        ? "Service types unavailable"
        : "Loading service types…";

  const typeName = (id: string) => types.find((t) => t.id === id)?.name;
  const shownNames = shownIds.map(typeName).filter((n): n is string => !!n);
  const publishWord = usePublishSummary();

  return (
    <div className="max-w-[920px] pt-5 max-sm:pt-4 pb-[50vh] max-sm:pb-24">
      <div className="pb-1">
        <BackLink to="/servicecue/manage">ServiceCue</BackLink>
        <h1 className="mt-0.5 text-title3 font-semibold text-fg">ServiceCue layouts</h1>
      </div>
      {error && <ErrorNote className="mt-3">{error}</ErrorNote>}

      <section className="mt-7" aria-labelledby="sc-layouts-h">
        <SectionHead id="sc-layouts-h" title="Layouts">
          A layout is the set of columns a rundown shows. The landing page offers them in this order, then All columns; the first
          is its default.
        </SectionHead>

      <div className="flex items-center gap-2 mb-4">
        <span className="text-caption1 text-gray-11">Preview with</span>
        {/* Held empty until the service types are in. The default comes from
            the settings, which answer first, and an id the picker cannot name
            yet would read "not found". */}
        <Select value={types.length > 0 ? (typeId ?? "") : ""} onValueChange={(v) => setTypeId(v)} disabled={types.length === 0}>
          <SelectTrigger className="w-64" aria-label="Preview with">
            <SelectValue placeholder={types.length > 0 ? "Select a service type" : typesPending} />
          </SelectTrigger>
          <SelectContent>
            {types.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <span className="text-caption2 text-gray-9">the plan + note columns used for the previews below</span>
      </div>
      {failed.has("types") && (
        <ErrorNote className="mb-4">Couldn't load the service types from Planning Center, so there may be none to preview with.</ErrorNote>
      )}
      {failed.has("noteCats") && (
        <ErrorNote className="mb-4">Couldn't load this service type's note categories, so the previews and roles below are missing them.</ErrorNote>
      )}

      {failed.has("settings") ? (
        <ErrorNote>Couldn't load the ServiceCue layouts. Nothing has been changed; reload the page to try again.</ErrorNote>
      ) : !settingsRead ? (
        // Drawn in place of the empty state below, whose Add layout button would
        // otherwise post a one-layout list over every saved layout the read has
        // not answered with yet.
        <SkeletonRows rows={3} />
      ) : sortedLayouts.length === 0 ? (
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
                  <LayoutNameInput name={l.name} onCommit={(name) => void rename(l.id, name)} />
                  {!open && (
                    <span className="text-caption1 text-gray-9 truncate min-w-0 hidden sm:block">
                      {(l.columnRoles ?? []).length ? (l.columnRoles ?? []).map(roleName).join(" · ") : "No columns"}
                    </span>
                  )}
                  <div className="ml-auto flex items-center gap-1 shrink-0">
                    <Button variant="transparent" size="small" iconOnly touchTargetY disabled={li === 0} onClick={() => moveLayout(l, -1)} aria-label="Move up"><ChevronUpIcon className="size-4" /></Button>
                    <Button variant="transparent" size="small" iconOnly touchTargetY disabled={li === sortedLayouts.length - 1} onClick={() => moveLayout(l, 1)} aria-label="Move down"><ChevronDownIcon className="size-4" /></Button>
                    <Button variant="transparent" size="small" iconOnly touchTargetY onClick={() => removeLayout(l)} aria-label="Delete"><Trash2Icon className="size-4 text-red-10" /></Button>
                  </div>
                </div>
                {nameError?.id === l.id && <ErrorNote className="mx-3 mb-3 -mt-1">{nameError.message}</ErrorNote>}

                {open && (
                  <div className="px-4 pb-4 border-t border-gray-a4 pt-3">
                    <div className="mb-3">
                      <span className="text-caption2 uppercase tracking-wider text-gray-9">Columns</span>
                      <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                        {(l.columnRoles ?? []).length === 0 && <span className="text-caption1 text-gray-9">No columns — add one →</span>}
                        {(l.columnRoles ?? []).map((c, ci) => (
                          <span key={c} className="inline-flex items-center gap-1 rounded-md border border-gray-a5 bg-gray-a3 pl-2 pr-1 py-1 text-caption1 text-gray-12">
                            <button className="touch-target-y text-gray-9 hover:text-gray-12 disabled:opacity-30" disabled={ci === 0} onClick={() => moveColumn(l, c, -1)} aria-label="Move left"><ChevronLeftIcon className="size-3.5" /></button>
                            {roleName(c)}
                            <button className="touch-target-y text-gray-9 hover:text-gray-12 disabled:opacity-30" disabled={ci === (l.columnRoles ?? []).length - 1} onClick={() => moveColumn(l, c, 1)} aria-label="Move right"><ChevronRightIcon className="size-3.5" /></button>
                            <button className="touch-target-y text-gray-9 hover:text-red-10 ml-0.5" onClick={() => removeColumn(l, c)} aria-label={`Remove ${roleName(c)}`}><XIcon className="size-3.5" /></button>
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
                            ) as Partial<ServiceCueLayout>);
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
                        {pcoConfigured === false ? (
                          <div className="p-6 text-caption1 text-gray-9">Connect Planning Center to preview a plan.</div>
                        ) : failed.has("rundown") ? (
                          <div className="p-6">
                            <ErrorNote>Couldn't load the plan to preview.</ErrorNote>
                          </div>
                        ) : !typeId && failed.has("types") ? (
                          <div className="p-6 text-caption1 text-gray-9">No service type to preview against.</div>
                        ) : !rundown ? (
                          <div className="p-6 text-caption1 text-gray-9">Loading plan…</div>
                        ) : rundown.items.length === 0 ? (
                          <div className="p-6 text-caption1 text-gray-9">No upcoming plan for this service type.</div>
                        ) : (
                          <RundownTable
                            items={rundown.items}
                            columns={buildServiceCueColumns(resolveServiceCueSpec(l, roles, noteCats), computeClocks(rundown.items, rundown.serviceTimes?.[0]), rundown.timeZone)}
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
        </div>
      )}
      </section>

      <section className="mt-7" aria-labelledby="sc-roles-h">
        <SectionHead id="sc-roles-h" title="Category roles">
          A role is one column. It groups the names different service types give the same notes, like Audio and Sound. When several
          have a note, the first in the role is shown first.
        </SectionHead>
        {/* Always drawn, with or without a layout, but only once the settings are read:
            the roles save as a whole list, and one built before the read would replace
            every saved role. */}
        {failed.has("settings") ? null : !settingsRead ? (
          <SkeletonRows rows={2} />
        ) : (
          <RolesPanel roles={roles} categories={noteCats} categoriesFailed={failed.has("noteCats")} onChange={saveRoles} />
        )}
      </section>

      <section className="mt-7 flex flex-col gap-2" aria-label="Landing page and public link">
        <MoreRow
          title="Landing page"
          summary={shownNames.length ? shownNames.join(", ") : shownIds.length ? typesPending : "No service types"}
        >
          <p className="text-caption1 text-fg-muted">
            Only these service types appear on the ServiceCue landing page, each with the layouts above, in that order, then All
            columns.
          </p>
          {types.length === 0 ? (
            <p className="text-caption1 text-fg-subtle">{typesPending}</p>
          ) : (
            types.map((t) => (
              <label key={t.id} className="flex cursor-pointer items-center gap-2 text-footnote text-fg">
                <Checkbox
                  checked={shownIds.includes(t.id)}
                  onCheckedChange={(on) => void setShown(on === true ? [...shownIds, t.id] : shownIds.filter((id) => id !== t.id))}
                />
                {t.name}
              </label>
            ))
          )}
        </MoreRow>
        <MoreRow title="Public link" summary={publishWord}>
          {/* The same landing page and layouts, handed to anyone with a link. It lists
              what it publishes from the two lists above, so it cannot say one thing
              while the page does another. */}
          <PublicLinkCard
            typeNames={shownNames}
            layoutNames={sortedLayouts.map((l) => l.name)}
            timeZone={appZoneOf(stage.state, hostTimeZone())}
            embedded
          />
        </MoreRow>
      </section>
    </div>
  );
}

/**
 * The link back to ServiceCue. A real link, so it opens in a new tab like any
 * other; inside the app's router a plain click navigates without a reload.
 * `warn: false` answers null outside a router (the tests render the page bare).
 */
function BackLink({ to, children }: { to: string; children: ReactNode }) {
  const router = useRouter({ warn: false }) as { navigate: (o: { to: string }) => unknown } | null;
  return (
    <a
      href={to}
      onClick={(e) => {
        if (!router || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        void router.navigate({ to });
      }}
      className="-ml-1 inline-flex items-center gap-0.5 rounded-md px-1 py-0.5 text-caption1 text-fg-muted transition-colors hover:bg-fill hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    >
      <ChevronLeftIcon className="size-3.5" aria-hidden="true" />
      {children}
    </a>
  );
}

/** A section's heading and the sentence under it. */
function SectionHead({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <div className="mb-2.5">
      <h2 id={id} className="text-subheadline font-semibold text-fg">{title}</h2>
      <p className="mt-0.5 max-w-[72ch] text-caption1 text-fg-muted">{children}</p>
    </div>
  );
}

/** A collapsed row at the foot of the page: a title, what it holds, and its body when open. */
function MoreRow({ title, summary, children }: { title: string; summary: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-[10px] border border-line bg-surface">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex min-h-11 w-full items-center gap-2 rounded-[10px] px-3 py-2 text-left text-footnote transition-colors hover:bg-fill focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <span className="whitespace-nowrap font-semibold text-fg">{title}</span>
        <span className="min-w-0 flex-1 truncate text-fg-muted">· {summary}</span>
        <ChevronDownIcon className={cn("size-4 shrink-0 text-fg-subtle transition-transform", open && "rotate-180")} aria-hidden="true" />
      </button>
      {open && <div className="flex flex-col gap-2.5 border-t border-line p-3">{children}</div>}
    </div>
  );
}

/** A layout's name. Typing edits a draft; the name is saved on blur or Enter, so a
 *  half-typed name is never the one a pinned screen's address was built from. A blank
 *  or unchanged name goes back to what it was, and so does a refused one: the page
 *  shows the new name while it saves and the stored one once it is refused, and the
 *  draft follows the stored name each time it changes (see useNameDraft). */
function LayoutNameInput({ name, onCommit }: { name: string; onCommit: (name: string) => void }) {
  const draft = useNameDraft(name, onCommit);
  return (
    <Input
      value={draft.draft}
      aria-label="Layout name"
      onChange={(e) => draft.setDraft(e.target.value)}
      onBlur={draft.commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") draft.setDraft(name);
      }}
      className="max-w-[14rem] font-medium"
    />
  );
}

/**
 * One color per note category, app-wide.
 *
 * Note categories are fetched per service type, so "Audio" exists separately under
 * Weekend, Youth and Gathering. Storing the color on a layout would mean setting it
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
  categoriesFailed,
  onChange,
}: {
  roles: CategoryRole[];
  categories: string[];
  /** The categories could not be read. Said here as well as at the top of the
   *  page: without it, no "+ Add category" and no "In no role" list read as a
   *  type whose categories are all assigned. */
  categoriesFailed: boolean;
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
      {categoriesFailed && <ErrorNote>Couldn't load this service type's note categories, so none can be added here.</ErrorNote>}

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
                <button className="touch-target-y text-gray-9 hover:text-gray-12 disabled:opacity-30" disabled={mi === 0} onClick={() => moveMember(r, mi, -1)} aria-label="Higher priority"><ChevronLeftIcon className="size-3" /></button>
                {m}
                <button className="touch-target-y text-gray-9 hover:text-gray-12 disabled:opacity-30" disabled={mi === r.members.length - 1} onClick={() => moveMember(r, mi, 1)} aria-label="Lower priority"><ChevronRightIcon className="size-3" /></button>
                <button className="touch-target-y text-gray-9 hover:text-red-10" onClick={() => patch(r.id, { members: r.members.filter((x) => x !== m) })} aria-label={`Remove ${m}`}><XIcon className="size-3" /></button>
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
