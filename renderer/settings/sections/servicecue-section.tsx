import { errorMessage } from "@main/services/errors";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PlusIcon, Trash2Icon, XIcon, ChevronLeftIcon, ChevronDownIcon } from "lucide-react";
import { useRouter } from "@tanstack/react-router";

import { Button, Checkbox, Input, Select, SelectTrigger, SelectValue, SelectContent, SelectItem, ErrorNote, confirm, SkeletonRows } from "../../components/ui";
import { cn } from "../../lib/cn";
import { invoke } from "../../lib/api";
import { useFailedReads } from "../../lib/use-failed-reads";
import { pcoConnected, useStageState } from "../../main/use-stage-state";
import type { CategoryRole } from "../../../main/types/servicecue-roles.js";
import { useResyncOn } from "@renderer/lib/use-resync-on";
import { useLayoutSaves, type LayoutEdit } from "./use-layout-saves";
import { PublicLinkCard, usePublishSummary } from "./servicecue-public-link";
import { appZoneOf } from "./history-trends/trends";
import { hostTimeZone } from "@main/services/app-timezone";
import { uid } from "@renderer/lib/uid";
import { LayoutCard, type LayoutPatch, type PreviewSource } from "./servicecue-layout-card";
import {
  byOrder,
  columnPatch,
  deleteLayoutBody,
  duplicateLayout,
  FIXED_LABEL,
  layoutRoles,
  moveTo,
  newLayout,
  reorderLayouts,
  type ColumnChange,
  type Rich,
} from "./servicecue-layouts-model";
import { byData, Grip, LayoutsDnd, LiftedList, useAnnouncer, useCarried, useLifted, type DragItem, type DropHandlers } from "./servicecue-drag";

/** The ServiceCue layouts page: the layouts, the category roles their columns come
 *  from, and the landing page and public link that offer them. */
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
    () => byOrder(layouts),
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
  const update = (id: string, patch: LayoutPatch) =>
    persist((list) => list.map((l) => (l.id === id ? { ...l, ...(typeof patch === "function" ? patch(l) : patch) } : l)));

  const rename = (id: string, name: string) =>
    persist((list) => list.map((l) => (l.id === id ? { ...l, name } : l)), id);

  // A new or copied layout opens with its name field focused and selected, so it can
  // be named straight away. Set by the handler, done once the card has drawn.
  const focusName = useRef<string | null>(null);
  const nameField = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (!focusName.current || focusName.current !== expandedId || !nameField.current) return;
    focusName.current = null;
    nameField.current.focus();
    nameField.current.select();
  });

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
    focusName.current = id;
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
    focusName.current = id;
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
          const members = moveTo(role.members, item.id, target.index);
          void saveRoles(roles.map((r) => (r.id === role.id ? { ...r, members } : r)));
          return `Moved ${item.label} to position ${target.index + 1} of ${members.length} in ${role.name}.`;
        }
      }
      return `${item.label} dropped outside the list. Nothing changed.`;
    },
    onReorder(item, order) {
      if (item.kind === "layout") void persist((list) => reorderLayouts(list, order));
      else if (item.kind === "col") void update(item.ctx, { columnRoles: order });
      else if (item.kind === "member") void saveRoles(roles.map((r) => (r.id === item.ctx ? { ...r, members: order } : r)));
    },
  };

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

  // One page-wide choice, drawn inside whichever card is open.
  const preview: PreviewSource = {
    types,
    typeId,
    setTypeId,
    typesPending,
    rundown,
    noteCats,
    pcoConfigured,
    rundownFailed: failed.has("rundown"),
    typesFailed: failed.has("types"),
  };

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

      <LayoutsDnd handlers={handlers} announce={announce}>
      <section className="mt-7" aria-labelledby="sc-layouts-h">
        <SectionHead id="sc-layouts-h" title="Layouts">
          A layout is the set of columns a rundown shows. The landing page offers them in this order, then All columns; the first
          is its default.
        </SectionHead>

      {failed.has("types") && (
        <ErrorNote className="mb-3">Couldn't load the service types from Planning Center, so there may be none to preview with.</ErrorNote>
      )}
      {failed.has("noteCats") && (
        <ErrorNote className="mb-3">Couldn't load this service type's note categories, so the previews and roles below are missing them.</ErrorNote>
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
          <RolesPanel roles={roles} categories={noteCats} categoriesFailed={failed.has("noteCats")} onChange={saveRoles} />
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

/** One of a role's categories: moved by its grip (first has priority), taken out by its X. */
function MemberChip({ role, member, onRemove }: { role: CategoryRole; member: string; onRemove: () => void }) {
  const item: DragItem = { kind: "member", ctx: role.id, id: member, label: member, within: role.name };
  const carried = useCarried(item);
  const lifted = useLifted(item);
  return (
    <span
      role="listitem"
      data-sort-id={member}
      className={cn(
        "inline-flex h-[26px] max-w-full select-none items-center gap-0.5 whitespace-nowrap rounded-md border border-line-strong bg-surface-raised pl-px pr-[3px] text-caption1 text-fg",
        carried && "opacity-35",
        lifted && "bg-popover shadow-[0_0_0_2px_var(--su-accent),var(--su-shadow-2)]",
      )}
    >
      <Grip item={item} order={role.members} size="sm" />
      {member}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${member} from ${role.name}`}
        className="touch-target-y ml-0.5 inline-grid size-6 shrink-0 place-items-center rounded-[5px] text-fg-subtle transition-colors hover:bg-fill hover:text-danger-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <XIcon className="size-[13px]" aria-hidden="true" />
      </button>
    </span>
  );
}

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
          <div className="flex flex-wrap items-center gap-1.5" data-members={r.id}>
            <LiftedList kind="member" ctx={r.id} items={r.members.map((m) => ({ id: m }))}>
              {({ id: m }) => (
                <MemberChip key={m} role={r} member={m} onRemove={() => patch(r.id, { members: r.members.filter((x) => x !== m) })} />
              )}
            </LiftedList>
            {categories.some((c) => !r.members.some((m) => norm(m) === norm(c))) && (
              // Select renders a NATIVE <select>, so the label must be a placeholder
              // OPTION — a custom trigger child does not render and the browser would
              // show the first real option as though it were already a member.
              <Select value="" onValueChange={(v) => patch(r.id, { members: [...r.members, v] })}>
                <SelectTrigger className="w-auto h-6 px-2 text-caption2" aria-label={`Add a category to ${r.name}`} data-add-member>
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
