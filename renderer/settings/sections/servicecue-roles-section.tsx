// servicecue-roles-section.tsx — Category roles on the ServiceCue layouts page.
//
// A role is one column: the names different service types give the same notes ("Audio"
// on one, "Sound" on another). Planning Center owns the categories, per service type;
// the page reads them for every type the landing page shows. The section lists the
// roles, each with its categories in priority order, and the categories no role has,
// with "Make a role for each". On a first run, with no roles at all, those categories
// and that action are the whole section.

import { PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import type { Ref } from "react";

import { Button, ErrorNote, Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "../../components/ui";
import { cn } from "../../lib/cn";
import type { ServiceCueLayout } from "../../../main/types/pco.js";
import type { CategoryRole } from "../../../main/types/servicecue-roles.js";
import { Grip, LiftedList, useCarried, useLifted, type DragItem } from "./servicecue-drag";
import { NameField } from "./servicecue-layout-card";
import { ambiguousCategories, listOf, unassignedByType, unassignedDistinct } from "./servicecue-layouts-model";

const norm = (s: string) => s.trim().toLowerCase();

/** The note categories the page has read, and what it could not. */
export interface CategorySource {
  /** Every service type Planning Center lists, in its order, for names. */
  types: { id: string; name: string }[];
  /** The service types the landing page shows. */
  shownIds: string[];
  /** Each read type's categories: the landing page's types and the previewed one, and
   *  every type once a + Add category list has been opened. */
  catsByType: ReadonlyMap<string, string[]>;
  /** The types whose categories could not be read. */
  failedTypeIds: string[];
  pcoConfigured: boolean | null;
}

export interface RoleActions {
  rename: (role: CategoryRole, name: string) => void;
  addMember: (role: CategoryRole, category: string) => void;
  removeMember: (role: CategoryRole, category: string) => void;
  remove: (role: CategoryRole) => void;
  /** A role named for one category, holding only it. */
  makeOne: (category: string) => void;
  /** "Make a role for each": one per category in no role, on every landing-page type. */
  makeEach: () => void;
  newRole: () => void;
}

export function CategoryRoles({
  roles,
  layouts,
  source,
  actions,
  onOpenAddCategory,
  newRoleId,
  newRoleRef,
}: {
  roles: CategoryRole[];
  layouts: ServiceCueLayout[];
  source: CategorySource;
  actions: RoleActions;
  /** A + Add category list is being opened: the page reads every type's categories. */
  onOpenAddCategory: () => void;
  /** The role just added with + New role, whose name field takes the focus. */
  newRoleId: string | null;
  newRoleRef: Ref<HTMLInputElement>;
}) {
  const typeName = (id: string) => source.types.find((t) => t.id === id)?.name ?? id;
  const groups = unassignedByType(roles, source.shownIds, source.catsByType);
  const unassigned = unassignedDistinct(groups);
  const ambiguous = ambiguousCategories(roles);
  const failures = source.failedTypeIds.length > 0 && (
    <ErrorNote>
      Couldn't load the note categories for {listOf(source.failedTypeIds.map(typeName))}, so they are not listed here.
    </ErrorNote>
  );
  // What the categories line says when there are none to list, and why.
  const noCategories =
    source.pcoConfigured === false
      ? "Connect Planning Center to list its note categories."
      : source.shownIds.length === 0
        ? "No service types are on the landing page yet. Pick them under Landing page, below, and their note categories are listed here."
        : null;

  if (roles.length === 0) {
    return (
      <div className="flex flex-col gap-2.5 rounded-xl border border-line bg-surface p-3.5 shadow-[var(--su-shadow-1)]" data-first-run>
        {failures}
        {noCategories ? (
          <p className="text-caption1 text-fg-muted">{noCategories}</p>
        ) : (
          <>
            <p className="text-caption1 text-fg-muted">
              Planning Center has <span className="font-mono tabular-nums">{unassigned.length}</span> note categories on the landing
              page's service types. Start with one role each; then rename them, and move the ones that mean the same thing into one
              role.
            </p>
            {unassigned.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {unassigned.map((c) => (
                  <span key={c.name} className={cn(CATEGORY_CHIP, "cursor-default")} data-category>
                    {c.name} <small className="text-caption2 text-fg-subtle">{c.typeIds.map(typeName).join(", ")}</small>
                  </span>
                ))}
              </div>
            )}
          </>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {!noCategories && unassigned.length > 0 && (
            <Button variant="accent" size="medium" onClick={actions.makeEach}>Make a role for each</Button>
          )}
          <Button variant="transparent" size="medium" onClick={actions.newRole} data-focus-key="new-role">
            <PlusIcon className="size-[15px]" aria-hidden="true" />
            New role
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-2">
        {roles.map((r) => (
          <RoleRow
            key={r.id}
            role={r}
            roles={roles}
            layouts={layouts}
            source={source}
            actions={actions}
            onOpenAddCategory={onOpenAddCategory}
            nameRef={r.id === newRoleId ? newRoleRef : undefined}
          />
        ))}
      </div>
      <div className="mt-2.5">
        <Button variant="filled" size="medium" onClick={actions.newRole} data-focus-key="new-role">
          <PlusIcon className="size-[15px]" aria-hidden="true" />
          New role
        </Button>
      </div>
      {ambiguous.length > 0 && (
        <p role="alert" className="mt-2.5 rounded-lg bg-warn-9/12 px-2.5 py-2 text-caption1 text-warn-11">
          In more than one role, so which column shows its note is ambiguous:{" "}
          {ambiguous.map((a) => `${a.name} (${listOf(a.roles)})`).join("; ")}.
        </p>
      )}
      {failures && <div className="mt-3">{failures}</div>}
      {unassigned.length > 0 && (
        <div className="mt-3 flex flex-col gap-2 rounded-[10px] border border-dashed border-line-strong px-3 py-2.5">
          <h3 className="text-footnote font-semibold text-fg">Categories in no role</h3>
          <p className="text-caption1 text-fg-muted">
            They still appear under All columns, but no layout can pick them. Make a role for one, or add it to a role above.
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            {unassigned.map((c) => (
              <button
                key={c.name}
                type="button"
                onClick={() => actions.makeOne(c.name)}
                aria-label={`Make a role for ${c.name}`}
                className={cn(CATEGORY_CHIP, "cursor-pointer transition-colors hover:border-accent hover:bg-fill focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus")}
              >
                <PlusIcon className="size-[13px] text-fg-muted" aria-hidden="true" />
                {c.name} <small className="text-caption2 text-fg-subtle">{c.typeIds.map(typeName).join(", ")}</small>
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="filled" size="medium" onClick={actions.makeEach}>Make a role for each</Button>
          </div>
        </div>
      )}
    </div>
  );
}

const CATEGORY_CHIP =
  "inline-flex h-7 items-center gap-[5px] whitespace-nowrap rounded-md border border-line-strong bg-transparent pl-[7px] pr-[9px] text-caption1 text-fg";

function RoleRow({
  role: r,
  roles,
  layouts,
  source,
  actions,
  onOpenAddCategory,
  nameRef,
}: {
  role: CategoryRole;
  roles: CategoryRole[];
  layouts: ServiceCueLayout[];
  source: CategorySource;
  actions: RoleActions;
  onOpenAddCategory: () => void;
  nameRef?: Ref<HTMLInputElement>;
}) {
  const used = layouts.filter((l) => (l.columnRoles ?? []).includes(r.id)).length;
  const has = new Set(r.members.map(norm));
  // Every read type's categories this role does not have, grouped by type, each saying
  // when another role already has it.
  const groups = source.types
    .filter((t) => source.catsByType.has(t.id))
    .map((t) => ({
      type: t,
      cats: (source.catsByType.get(t.id) ?? []).filter((c) => !has.has(norm(c))),
    }))
    .filter((g) => g.cats.length > 0);
  // The value carries its type, so a category two types share is still one option each.
  const SEP = "\u0000";
  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-line bg-surface px-2.5 py-[9px]" data-role={r.id}>
      <div className="flex items-center gap-2">
        <NameField
          name={r.name}
          onCommit={(name) => actions.rename(r, name)}
          label="Role name"
          inputRef={nameRef}
          className="h-[30px] min-w-0 max-w-[240px] flex-1 font-medium"
        />
        <span className="ml-auto whitespace-nowrap text-caption1 text-fg-subtle">
          {used ? (
            <>
              In <span className="font-mono tabular-nums">{used}</span> {used === 1 ? "layout" : "layouts"}
            </>
          ) : (
            "In no layout"
          )}
        </span>
        <Button
          variant="transparent"
          size="medium"
          iconOnly
          onClick={() => actions.remove(r)}
          aria-label={`Delete role ${r.name}`}
          className="text-fg-muted hover:text-danger-11"
        >
          <Trash2Icon className="size-4" aria-hidden="true" />
        </Button>
      </div>
      <div role="list" aria-label={`Categories in ${r.name}, first has priority`} className="flex flex-wrap items-center gap-1.5" data-members={r.id}>
        {r.members.length === 0 && <span className="px-1 text-caption1 text-fg-subtle">No categories yet, so this column is empty.</span>}
        <LiftedList kind="member" ctx={r.id} items={r.members.map((m) => ({ id: m }))}>
          {({ id: m }) => <MemberChip key={m} role={r} member={m} onRemove={() => actions.removeMember(r, m)} />}
        </LiftedList>
        {groups.length > 0 && (
          // A native <select>: its label is a placeholder option.
          <Select value="" onValueChange={(v) => actions.addMember(r, v.slice(v.indexOf(SEP) + 1))}>
            <SelectTrigger className="h-[26px] w-auto text-caption1" aria-label={`Add a category to ${r.name}`} data-add-member data-focus-key={`add-member:${r.id}`} onFocus={onOpenAddCategory} onPointerDown={onOpenAddCategory}>
              <SelectValue placeholder="+ Add category" />
            </SelectTrigger>
            <SelectContent>
              {groups.map((g) => (
                <SelectGroup key={g.type.id}>
                  <SelectLabel>{g.type.name}</SelectLabel>
                  {g.cats.map((c) => {
                    const other = roles.find((x) => x.id !== r.id && x.members.some((m) => norm(m) === norm(c)));
                    return (
                      <SelectItem key={c} value={`${g.type.id}${SEP}${c}`}>
                        {other ? `${c} (in ${other.name})` : c}
                      </SelectItem>
                    );
                  })}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
    </div>
  );
}

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
