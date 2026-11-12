import { errorMessage } from "@main/services/errors";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { AlertCircleIcon, PlusIcon, ChevronLeftIcon, ChevronDownIcon } from "lucide-react";
import { useRouter } from "@tanstack/react-router";

import { Button, Checkbox, ErrorNote, confirm, SkeletonRows } from "../../components/ui";
import { cn } from "../../lib/cn";
import { invoke } from "../../lib/api";
import { useFailedReads } from "../../lib/use-failed-reads";
import { pcoConnected, useStageState } from "../../main/use-stage-state";
import type { CategoryRole } from "../../../main/types/servicecue-roles.js";
import { useResyncOn } from "@renderer/lib/use-resync-on";
import { useListSaves, type ListEdit, type ListIo, type ListSaveResult } from "../../lib/use-list-saves";
import { CategoryRoles, type RoleActions } from "./servicecue-roles-section";
import { PublicLinkCard, usePublishSummary } from "./servicecue-public-link";
import { appZoneOf } from "./history-trends/trends";
import { hostTimeZone } from "@main/services/app-timezone";
import { uid } from "@renderer/lib/uid";
import { LayoutCard, type LayoutPatch, type PreviewSource } from "./servicecue-layout-card";
import {
  byOrder,
  columnPatch,
  deleteLayoutBody,
  deleteRoleBody,
  listOf,
  duplicateLayout,
  FIXED_LABEL,
  layoutRoles,
  moveTo,
  newLayout,
  noticeText,
  unassignedByType,
  reorderLayouts,
  type ColumnChange,
  type Rich,
} from "./servicecue-layouts-model";
import { byData, LayoutsDnd, LiftedList, useAnnouncer, type DropHandlers } from "./servicecue-drag";

/** What can fail to save, each said on its own line at the top of the page. */
const FAILURES = ["layouts", "roles", "seed", "landing"] as const;
type Failure = (typeof FAILURES)[number];

/** Focus and select `ref`'s field once for each new `key`, once it has drawn. */
function useFocusSelectOnce(key: string | null, ref: RefObject<HTMLInputElement | null>) {
  const done = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!key || done.current === key || !ref.current) return;
    done.current = key;
    ref.current.focus();
    ref.current.select();
  });
}

/** A note-category read, per service type. */
type CatsRead = `cats:${string}`;

/** How the page's two whole lists reach the server, each saved one change at a time. */
export const LAYOUTS: ListIo<ServiceCueLayout> = {
  save: (layouts) => invoke<ServiceCueLayout[]>("servicecue:saveLayouts", { layouts }),
  read: () => invoke<ServiceCueLayout[]>("servicecue:listLayouts"),
};

export const ROLES: ListIo<CategoryRole> = {
  save: (roles) => invoke<CategoryRole[]>("servicecue:saveRoles", { roles }),
  read: () => invoke<CategoryRole[]>("servicecue:listRoles"),
};

/** The ServiceCue layouts page: the layouts, the category roles their columns come
 *  from, and the landing page and public link that offer them. */
export function ServiceCueSection() {
  const [types, setTypes] = useState<ServiceTypeDTO[]>([]);
  const { list: layouts, adopt: adoptLayouts, edit: editLayouts } = useListSaves(LAYOUTS);
  const [typeId, setTypeId] = useState<string | null>(null);
  // Each read service type's note categories: the landing page's types, and the
  // one previewed. Kept for the page's life; Planning Center changes them rarely.
  const [catsByType, setCatsByType] = useState<ReadonlyMap<string, string[]>>(() => new Map());
  const { list: roles, adopt: adoptRoles, edit: editRoles, request: requestRoles } = useListSaves(ROLES);
  const [rundown, setRundown] = useState<ServiceCueRundownDTO | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [shownIds, setShownIds] = useState<string[]>([]);
  // What failed, one line per source, so a save that works says nothing about another
  // that did not. Each is cleared by the next success of its own kind.
  const [failures, setFailures] = useState<Partial<Record<Failure, string>>>({});
  const setFailure = (which: Failure, message: string | null) =>
    setFailures((f) => {
      if ((f[which] ?? null) === message) return f;
      const next = { ...f };
      if (message === null) delete next[which];
      else next[which] = message;
      return next;
    });
  // A rename the server refused, said under the name field it was typed into.
  const [nameError, setNameError] = useState<{ id: string; message: string } | null>(null);
  // Which reads FAILED, as opposed to came back empty. The settings' failure is
  // the dangerous one: drawn as "No layouts yet", its Add layout saved a
  // one-layout list over every real one.
  const { failed, fail, clear } = useFailedReads<"settings" | "types" | "rundown" | CatsRead>("servicecue");
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
    if (pcoConfigured === false) clear();
  });

  // This app's own settings: the layouts, which types the landing page shows,
  // and the category roles. Read apart from Planning Center, so one that is not
  // connected, or is down, costs the previews and never the layouts editor.
  useEffect(() => {
    Promise.all([
      LAYOUTS.read(),
      invoke<ServiceCueConfig>("servicecue:getConfig"),
      ROLES.read(),
    ])
      .then(([l, c, r]) => {
        adoptLayouts(l);
        adoptRoles(r);
        setShownIds(c.serviceTypeIds ?? []);
        // Preview against the first enabled type; Planning Center's first is
        // the fallback, below.
        setTypeId((cur) => cur ?? (c.serviceTypeIds ?? [])[0] ?? null);
        setSettingsRead(true);
      })
      .catch((err: unknown) => fail("settings", "the ServiceCue layouts and settings", err));
  }, [fail, adoptLayouts, adoptRoles]);

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
    try {
      await invoke("servicecue:setConfig", { serviceTypeIds: next });
      setFailure("landing", null);
    } catch (e) {
      setFailure("landing", `Couldn't save which service types the landing page shows: ${errorMessage(e)}`);
    }
  }

  // Drop the previous type's rundown in the same render the type changes, so the
  // preview never shows the old plan while the new one is still in flight.
  useResyncOn([typeId], () => {
    if (typeId) {
      setRundown(null);
      clear("rundown");
    }
  });

  // The note categories of every landing-page type (for the roles, the notice and
  // + Add category) and of the previewed one. A type that stops being needed has its
  // late answer or failure dropped, and a failure it already had is drawn nowhere: the
  // notes name only the previewed type and the landing page's.
  const neededKey = [...new Set([...shownIds, ...(typeId ? [typeId] : [])])].join("\u0000");
  useEffect(() => {
    if (!pcoConfigured) return;
    let cancelled = false;
    for (const id of neededKey ? neededKey.split("\u0000") : []) {
      if (catsByType.has(id)) continue;
      invoke<string[]>("servicecue:noteCategories", { serviceTypeId: id })
        .then((c) => {
          if (cancelled) return;
          setCatsByType((m) => new Map(m).set(id, c));
          clear(`cats:${id}`);
        })
        .catch((err: unknown) => {
          if (!cancelled) fail(`cats:${id}`, `the note categories for service type ${id}`, err);
        });
    }
    return () => {
      cancelled = true;
    };
    // `catsByType` is read, not watched: an answer landing must not start the reads again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [neededKey, pcoConfigured, fail, clear]);

  useEffect(() => {
    if (!typeId || !pcoConfigured) return;
    // Cancelled on a type change, so a slow read for the previous type can
    // neither land its answer nor its failure under this one.
    let cancelled = false;
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
  // which type's plan the preview draws against.
  const sortedLayouts = useMemo(
    () => byOrder(layouts),
    [layouts],
  );


  const typeName = (id: string) => types.find((t) => t.id === id)?.name;

  /** Saves an edit through one of the page's queues (see useListSaves); true when the
   *  server took it. `report` hears the refusal, or null once it has saved. Never before
   *  the settings read has answered: both lists save whole, and one built from the empty
   *  list the page starts with would replace every saved entry. */
  async function persistVia<T>(
    save: (edit: ListEdit<T>) => Promise<ListSaveResult>,
    edit: ListEdit<T>,
    report: (error: string | null) => void,
  ): Promise<boolean> {
    if (!settingsRead) return false;
    const result = await save(edit);
    report(result.ok ? null : result.error);
    return result.ok;
  }

  /** Saves a layouts edit. A refusal is said at the name field when the edit was a rename
   *  (`renamed` is that layout's id), else at the top of the page. */
  const persist = (edit: ListEdit<ServiceCueLayout>, renamed?: string) =>
    persistVia(editLayouts, edit, (e) =>
      renamed ? setNameError(e === null ? null : { id: renamed, message: e }) : setFailure("layouts", e && `Couldn't save the layouts: ${e}`));

  /** Changes one layout. `patch` may be a function of the layout as it is when the edit
   *  saves, for a change built on what the layout already holds (its columns). */
  const update = (id: string, patch: LayoutPatch) =>
    persist((list) => list.map((l) => (l.id === id ? { ...l, ...(typeof patch === "function" ? patch(l) : patch) } : l)));

  const rename = (id: string, name: string) =>
    persist((list) => list.map((l) => (l.id === id ? { ...l, name } : l)), id);

  // A new or copied layout opens with its name field focused and selected, so it can
  // be named straight away.
  const [nameLayoutId, setNameLayoutId] = useState<string | null>(null);
  const nameField = useRef<HTMLInputElement>(null);
  useFocusSelectOnce(nameLayoutId, nameField);

  // The control a change moves focus to once it has drawn: the tray chip a removed
  // column became, the X of one just added. Without it focus falls to the page.
  const focusNext = useRef<string | null>(null);
  useLayoutEffect(() => {
    const key = focusNext.current;
    if (!key) return;
    // One render to find it: a key nothing answers to must not wait on and take the
    // focus from wherever the operator has gone since.
    focusNext.current = null;
    (byData("data-focus-key", key) as HTMLElement | null)?.focus();
  });

  function addLayout() {
    if (!settingsRead) return;
    const id = uid("svl");
    setExpandedId(id);
    setNameLayoutId(id);
    // Built from the list as it is when it saves: the first free "Layout N" then.
    void persist((list) => {
      const made = newLayout(list, id);
      announce(`Added ${made.name}. It starts with Clock, Time and Item; every role is in Not in this layout.`);
      return [...list, made];
    });
  }

  function duplicate(l: ServiceCueLayout) {
    const id = uid("svl");
    setExpandedId(id);
    setNameLayoutId(id);
    void persist((list) => duplicateLayout(list, l.id, id));
    announce(`Duplicated ${l.name}.`);
  }

  async function removeLayout(l: ServiceCueLayout) {
    if (!(await confirm({
      title: `Delete ${l.name}?`,
      richMessage: <RichText rich={deleteLayoutBody(l, stage.state?.views)} />,
      confirmLabel: "Delete layout",
      destructive: true,
    }))) return;
    // Focus goes to the card that takes its place: the next, else the one before, else New layout.
    const i = sortedLayouts.findIndex((x) => x.id === l.id);
    const near = sortedLayouts[i + 1] ?? sortedLayouts[i - 1];
    focusNext.current = near ? `open:${near.id}` : "new-layout";
    // Said once the server has it: a refused delete leaves the card where it was.
    if (await persist((list) => list.filter((x) => x.id !== l.id))) announce(`Deleted ${l.name}.`);
  }

  const { announce, region: announcer } = useAnnouncer();

  /** A change to a layout's Columns row, from a click or a drop. */
  function changeColumns(layoutId: string, change: ColumnChange, focus?: string) {
    if (focus) focusNext.current = focus;
    void update(layoutId, (cur) => columnPatch(cur, change));
  }

  const roleName = (id: string) => roles.find((r) => r.id === id)?.name ?? id;

  /** What a click on a chip, or its X, says it did. */
  function columnsSaid(change: ColumnChange): string {
    if (change.kind === "remove-role") return `Removed ${roleName(change.roleId)}. It is in Not in this layout.`;
    if (change.kind === "set-fixed") {
      return change.on ? `Added ${FIXED_LABEL[change.key]}.` : `Removed ${FIXED_LABEL[change.key]}. It is in Not in this layout.`;
    }
    return `Added ${roleName(change.roleId)}.`;
  }

  const handlers: DropHandlers = {
    onDrop(item, target) {
      // Let go where it already was: nothing to save, and nothing moved to say.
      const stayed = `${item.label} dropped where it was. Nothing changed.`;
      if (item.kind === "layout" && target.kind === "index") {
        const ids = sortedLayouts.map((l) => l.id);
        if (ids.indexOf(item.id) === target.index) return stayed;
        void persist((list) => reorderLayouts(list, moveTo(byOrder(list).map((l) => l.id), item.id, target.index)));
        return `Moved ${item.label} to position ${target.index + 1} of ${ids.length}.`;
      }
      if (item.kind === "col") {
        if (target.kind === "remove") {
          changeColumns(item.ctx, { kind: "remove-role", roleId: item.id });
          return `Removed ${item.label}. It is in Not in this layout.`;
        }
        if (target.kind === "index") {
          const layout = layouts.find((l) => l.id === item.ctx);
          const drawn = layout ? layoutRoles(layout, roles).map((r) => r.id) : [];
          if (drawn.indexOf(item.id) === target.index) return stayed;
          const n = (layout?.columnRoles ?? []).length;
          changeColumns(item.ctx, { kind: "move-role", roleId: item.id, index: target.index });
          return `Moved ${item.label} to column ${target.index + 1} of ${n} roles.`;
        }
      }
      if (item.kind === "tray") {
        if (target.kind === "fixed") {
          changeColumns(item.ctx, { kind: "set-fixed", key: target.key, on: true });
          return `Added ${item.label} in its fixed place.`;
        }
        if (target.kind === "index") {
          const n = (layouts.find((l) => l.id === item.ctx)?.columnRoles ?? []).length + 1;
          changeColumns(item.ctx, { kind: "add-role", roleId: item.id, index: target.index });
          return `Added ${item.label} as role column ${target.index + 1} of ${n}.`;
        }
      }
      if (item.kind === "member" && target.kind === "index") {
        const role = roles.find((r) => r.id === item.ctx);
        if (role) {
          if (role.members.indexOf(item.id) === target.index) return stayed;
          void editRole(role.id, (r) => ({ members: moveTo(r.members, item.id, target.index) }));
          return `Moved ${item.label} to position ${target.index + 1} of ${role.members.length} in ${role.name}.`;
        }
      }
      return `${item.label} dropped outside the list. Nothing changed.`;
    },
    onReorder(item, order) {
      if (item.kind === "layout") void persist((list) => reorderLayouts(list, order));
      else if (item.kind === "col") void update(item.ctx, { columnRoles: order });
      else if (item.kind === "member") void editRole(item.ctx, { members: order });
    },
  };

  /** Saves a roles edit, as persist does the layouts'. `report` words a refusal, for a
   *  save that means more than "the roles". */
  const persistRoles = (
    edit: ListEdit<CategoryRole>,
    report: (error: string) => string = (e) => `Couldn't save the category roles: ${e}`,
  ) => persistVia(editRoles, edit, (e) => setFailure("roles", e && report(e)));

  /** Changes one role, as it is when the change saves. */
  const editRole = (id: string, patch: Partial<CategoryRole> | ((r: CategoryRole) => Partial<CategoryRole>)) =>
    persistRoles((list) => list.map((r) => (r.id === id ? { ...r, ...(typeof patch === "function" ? patch(r) : patch) } : r)));

  // + New role puts the cursor in the new role's name, selected.
  const [newRoleId, setNewRoleId] = useState<string | null>(null);
  const newRoleField = useRef<HTMLInputElement>(null);
  useFocusSelectOnce(newRoleId, newRoleField);

  /** Every service type's categories, for + Add category, read the first time one of
   *  those lists is opened: one type at a time, each failure noted by its type. */
  const everyTypeAsked = useRef(false);
  // Drawn from, once asked: only then does a failure of a type off the landing page
  // belong in the roles section (a previewed type's is said above the previews).
  const [everyTypeListed, setEveryTypeListed] = useState(false);
  async function readEveryType() {
    if (everyTypeAsked.current || !pcoConfigured || types.length === 0) return;
    everyTypeAsked.current = true;
    setEveryTypeListed(true);
    for (const t of types) {
      if (catsByType.has(t.id)) continue;
      try {
        const c = await invoke<string[]>("servicecue:noteCategories", { serviceTypeId: t.id });
        setCatsByType((m) => new Map(m).set(t.id, c));
        clear(`cats:${t.id}`);
      } catch (err) {
        // Recorded, so the roles section names the type it could not list.
        fail(`cats:${t.id}`, `the note categories for service type ${t.id}`, err);
      }
    }
  }

  /** "Make a role for each": the server adds one for every category no role has, one
   *  landing-page type at a time (each reads and writes the whole list, so never two at
   *  once), and says which types it could not. */
  async function makeEach() {
    if (!settingsRead) return;
    const before = roles.length;
    const failedTypes: string[] = [];
    let latest = roles;
    for (const id of shownIds) {
      const result = await requestRoles(async () => {
        latest = await invoke<CategoryRole[]>("servicecue:seedRoles", { serviceTypeId: id });
        return latest;
      });
      if (!result.ok) failedTypes.push(`${typeName(id) ?? id} (${result.error})`);
    }
    const made = Math.max(0, latest.length - before);
    setFailure("seed", failedTypes.length ? `Couldn't make roles for ${listOf(failedTypes)}.` : null);
    announce(`Made ${made} ${made === 1 ? "role" : "roles"}, one for each category.`);
  }

  const roleActions: RoleActions = {
    rename: (r, name) => void editRole(r.id, { name }),
    addMember: (r, category) => {
      void editRole(r.id, (cur) => ({ members: [...cur.members, category] }));
      announce(`Added ${category} to ${r.name}.`);
    },
    removeMember: (r, category) => {
      focusNext.current = `add-member:${r.id}`;
      void editRole(r.id, (cur) => ({ members: cur.members.filter((m) => m !== category) }));
      announce(`Removed ${category} from ${r.name}.`);
    },
    remove: (r) => void removeRole(r),
    makeOne: (category) => {
      void persistRoles((list) => [...list, { id: uid("role"), name: category, members: [category] }]);
      announce(`Made a ${category} role.`);
    },
    makeEach: () => void makeEach(),
    newRole: () => {
      const id = uid("role");
      setNewRoleId(id);
      void persistRoles((list) => [...list, { id, name: "New role", members: [] }]);
      announce("Added a role. Name it, then add its categories.");
    },
  };

  /** Deleting a role asks first, naming the layouts it leaves and those it stops tinting.
   *  The layouts let go of it before it goes, so none is left pointing at nothing. */
  async function removeRole(r: CategoryRole) {
    if (!(await confirm({
      title: `Delete the ${r.name} role?`,
      richMessage: <RichText rich={deleteRoleBody(r, sortedLayouts)} />,
      confirmLabel: "Delete role",
      destructive: true,
    }))) return;
    const holds = (l: ServiceCueLayout) => (l.columnRoles ?? []).includes(r.id) || l.accentRole === r.id;
    const inLayouts = layouts.some(holds);
    const dropped = await persist((list) => (list.some(holds)
      ? list.map((l) => (holds(l)
        ? { ...l, columnRoles: (l.columnRoles ?? []).filter((id) => id !== r.id), accentRole: l.accentRole === r.id ? null : (l.accentRole ?? null) }
        : l))
      : list));
    if (!dropped) return; // said at the top of the page; the role stays, so nothing points at nothing
    focusNext.current = "new-role";
    // Half done is said as half done: the layouts no longer show it, the role is still there.
    const deleted = await persistRoles(
      (list) => list.filter((x) => x.id !== r.id),
      (e) => inLayouts
        ? `${r.name} was taken out of every layout, but the role itself could not be deleted: ${/[.!?]$/.test(e) ? e : `${e}.`} It is still listed; delete it again to finish.`
        : `Couldn't delete the ${r.name} role: ${e}`,
    );
    if (deleted) announce(`Deleted the ${r.name} role.`);
  }

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

  const layoutIds = sortedLayouts.map((l) => l.id);
  // Categories on the landing page's types that no role has, by type, for the notice.
  const noticeGroups = unassignedByType(roles, shownIds, catsByType).map((g) => ({ typeName: typeName(g.typeId) ?? g.typeId, cats: g.cats }));

  // One page-wide choice, drawn inside whichever card is open.
  const preview: PreviewSource = {
    types,
    typeId,
    setTypeId,
    typesPending,
    rundown,
    noteCats: (typeId && catsByType.get(typeId)) || [],
    pcoConfigured,
    rundownFailed: failed.has("rundown"),
    typesFailed: failed.has("types"),
  };

  const shownNames = shownIds.map(typeName).filter((n): n is string => !!n);
  const publishWord = usePublishSummary();

  return (
    <div className="max-w-[920px] pt-5 max-sm:pt-4 pb-[50vh] max-sm:pb-24">
      <div className="pb-1">
        <BackLink to="/servicecue/manage">ServiceCue</BackLink>
        <h1 className="mt-0.5 text-title3 font-semibold text-fg">ServiceCue layouts</h1>
      </div>
      {FAILURES.map((k) => failures[k] && <ErrorNote key={k} className="mt-3">{failures[k]}</ErrorNote>)}
      {/* Not on a first run: with no roles, the roles section already lists every
          category, with this same action. */}
      {settingsRead && roles.length > 0 && noticeGroups.length > 0 && (
        <Notice groups={noticeGroups} onMakeEach={() => void makeEach()} />
      )}

      <LayoutsDnd handlers={handlers} announce={announce}>
      <section className="mt-7" aria-labelledby="sc-layouts-h">
        <SectionHead id="sc-layouts-h" title="Layouts">
          A layout is the set of columns a rundown shows. The landing page offers them in this order, then All columns; the first
          is its default.
        </SectionHead>

      {failed.has("types") && (
        <ErrorNote className="mb-3">Couldn't load the service types from Planning Center, so there may be none to preview with.</ErrorNote>
      )}
      {typeId && failed.has(`cats:${typeId}`) && (
        <ErrorNote className="mb-3">Couldn't load the note categories for {typeName(typeId) ?? "the previewed service type"}, so its preview is missing them.</ErrorNote>
      )}

      {failed.has("settings") ? (
        <ErrorNote>Couldn't load the ServiceCue layouts. Nothing has been changed; reload the page to try again.</ErrorNote>
      ) : !settingsRead ? (
        // Drawn in place of the empty state below, whose New layout button would
        // otherwise post a one-layout list over every saved layout the read has
        // not answered with yet.
        <SkeletonRows rows={3} />
      ) : sortedLayouts.length === 0 ? (
        <div className="flex flex-col items-start gap-2 rounded-xl border border-dashed border-line-strong p-[18px]">
          <b className="text-[14px] font-semibold text-fg">No layouts yet</b>
          <p className="text-caption1 text-fg-muted">
            Until there is one, every screen and the landing page show All columns: every role, plus any category in no role.
          </p>
          <Button variant="accent" size="medium" onClick={addLayout} data-focus-key="new-layout"><PlusIcon className="size-[15px]" aria-hidden="true" />New layout</Button>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-2.5" data-sort-list="layouts">
            <LiftedList kind="layout" ctx="" items={sortedLayouts}>
              {(l) => (
                <LayoutCard
                  key={l.id}
                  layout={l}
                  roles={roles}
                  open={openId === l.id}
                  onToggle={() => setExpandedId(openId === l.id ? null : l.id)}
                  onRename={(name) => void rename(l.id, name)}
                  nameError={nameError?.id === l.id ? nameError.message : null}
                  onDuplicate={() => duplicate(l)}
                  onDelete={() => void removeLayout(l)}
                  onUpdate={(patch) => void update(l.id, patch)}
                  onColumns={(change, focus) => {
                    changeColumns(l.id, change, focus);
                    announce(columnsSaid(change));
                  }}
                  preview={preview}
                  layoutIds={layoutIds}
                  nameRef={openId === l.id ? nameField : undefined}
                />
              )}
            </LiftedList>
          </div>
          <div className="mt-2.5">
            <Button variant="filled" size="medium" onClick={addLayout} data-focus-key="new-layout"><PlusIcon className="size-[15px]" aria-hidden="true" />New layout</Button>
          </div>
        </>
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
          <CategoryRoles
            roles={roles}
            layouts={sortedLayouts}
            source={{
              types,
              shownIds,
              catsByType,
              // The landing page's, and any other type + Add category tried to list.
              failedTypeIds: [...new Set([...shownIds, ...(everyTypeListed ? types.map((t) => t.id) : [])])].filter((id) => failed.has(`cats:${id}`)),
              pcoConfigured,
            }}
            actions={roleActions}
            onOpenAddCategory={() => void readEveryType()}
            newRoleId={newRoleId}
            newRoleRef={newRoleField}
          />
        )}
      </section>
      </LayoutsDnd>

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
      {announcer}
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

/** The line at the top of the page naming the categories no layout can show. */
function Notice({ groups, onMakeEach }: { groups: { typeName: string; cats: string[] }[]; onMakeEach: () => void }) {
  const { lead, rest, still } = noticeText(groups);
  return (
    <div role="status" className="mt-4 flex flex-wrap items-center gap-x-3.5 gap-y-2 rounded-[10px] border border-line-strong bg-surface px-3 py-2.5 shadow-[var(--su-shadow-1)]">
      <AlertCircleIcon className="mt-px size-4 shrink-0 self-start text-warn-11" aria-hidden="true" />
      <p className="min-w-[200px] flex-1 text-footnote text-fg" data-notice>
        <b className="font-semibold">{lead}</b>
        {rest} <span className="text-fg-muted">{still}</span>
      </p>
      <Button variant="filled" size="medium" onClick={onMakeEach}>Make a role for each</Button>
    </div>
  );
}

/** Confirm text with its names in bold. */
function RichText({ rich }: { rich: Rich }) {
  return <>{rich.map((p, i) => (typeof p === "string" ? p : <b key={i} className="font-semibold text-fg">{p.b}</b>))}</>;
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
