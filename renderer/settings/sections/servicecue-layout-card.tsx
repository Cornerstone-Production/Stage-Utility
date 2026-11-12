// servicecue-layout-card.tsx — one layout on the ServiceCue layouts page.
//
// Shut, a card is its name and every column it draws, in order. Open (one at a time),
// it is the name field, Duplicate and Delete, the rows that set what the layout shows,
// and a preview of it against the plan the page previews with.

import { CheckIcon, ChevronDownIcon, CopyIcon, LockIcon, PinIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import { useRef, type ReactNode, type Ref } from "react";

import { Button, ErrorNote, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui";
import { cn } from "../../lib/cn";
import { Grip, TrayChip, useCarried, useLifted, useLiftedOrder, useTrayOn, type DragItem } from "./servicecue-drag";
import { useNameDraft } from "../../lib/use-name-draft";
import { RundownTable } from "../../main/rundown-table";
import { buildServiceCueColumns, computeClocks, fmtTotal, resolveServiceCueSpec, totalLengthSec } from "../../main/servicecue-columns";
import type { ServiceCueLayout } from "../../../main/types/pco.js";
import type { CategoryRole } from "../../../main/types/servicecue-roles.js";
import {
  columnSummary,
  FIXED_LABEL,
  fixedOn,
  FOOTER,
  layoutRoles,
  listOf,
  roleApplies,
  toggleOn,
  trayItems,
  UNDER_TITLE,
  type ColumnChange,
  type FixedKey,
} from "./servicecue-layouts-model";

/** What the preview draws against: the page-wide service type and its plan. */
export interface PreviewSource {
  types: { id: string; name: string }[];
  typeId: string | null;
  setTypeId: (id: string) => void;
  /** What the picker says while it has no types to offer. */
  typesPending: string;
  rundown: ServiceCueRundownDTO | null;
  /** The previewed type's note categories. */
  noteCats: string[];
  pcoConfigured: boolean | null;
  rundownFailed: boolean;
  typesFailed: boolean;
}

export type LayoutPatch = Partial<ServiceCueLayout> | ((l: ServiceCueLayout) => Partial<ServiceCueLayout>);

export function LayoutCard({
  layout: l,
  roles,
  open,
  onToggle,
  onRename,
  nameError,
  onDuplicate,
  onDelete,
  onUpdate,
  onColumns,
  preview,
  layoutIds,
  nameRef,
}: {
  layout: ServiceCueLayout;
  roles: CategoryRole[];
  open: boolean;
  onToggle: () => void;
  onRename: (name: string) => void;
  /** A rename the server refused, said under the name field. */
  nameError: string | null;
  onDuplicate: () => void;
  onDelete: () => void;
  onUpdate: (patch: LayoutPatch) => void;
  /** A change to the Columns row. `focus` names the control to focus once it has drawn. */
  onColumns: (change: ColumnChange, focus?: string) => void;
  preview: PreviewSource;
  /** Every layout's id in page order: what the card's grip moves it among. */
  layoutIds: readonly string[];
  /** The open card's name field, for the page to focus on a new or copied layout. */
  nameRef?: Ref<HTMLInputElement>;
}) {
  const card: DragItem = { kind: "layout", ctx: "", id: l.id, label: l.name };
  const carried = useCarried(card);
  const lifted = useLifted(card);
  // While a column is picked up by the keyboard, the row, the summary and the
  // preview draw the order the arrows have moved it to.
  const liftedCols = useLiftedOrder("col", l.id);
  const shown = liftedCols ? { ...l, columnRoles: liftedCols } : l;
  const summary = columnSummary(shown, roles).join(" · ");
  const cols = layoutRoles(shown, roles);
  const colIds = layoutRoles(l, roles).map((r) => r.id);
  const tray = trayItems(l, roles);
  const trayOn = useTrayOn(l.id);
  const frame = cn(
    "rounded-xl border border-line bg-surface shadow-[var(--su-shadow-1)] transition-shadow",
    carried && "opacity-40",
    lifted && "shadow-[0_0_0_2px_var(--su-accent),var(--su-shadow-2)]",
  );
  const grip = <Grip item={card} order={layoutIds} />;

  if (!open) {
    return (
      <div className={frame} data-layout-card={l.id}>
        <div className="flex min-h-12 items-center gap-1 py-[7px] pl-1 pr-2">
          {grip}
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={false}
            aria-label={`${l.name}, ${summary}`}
            data-focus-key={`open:${l.id}`}
            className="grid min-w-0 flex-1 cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 rounded-md p-1 text-left transition-colors hover:bg-fill focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus max-sm:grid-cols-[minmax(0,1fr)_auto]"
          >
            <span className="max-w-[22ch] truncate text-[14px] font-semibold leading-[19px] text-fg" data-layout-name>{l.name}</span>
            <span className="min-w-0 truncate text-caption1 text-fg-muted max-sm:col-start-1 max-sm:row-start-2 max-sm:whitespace-normal">{summary}</span>
            <ChevronDownIcon className="size-4 text-fg-subtle max-sm:col-start-2 max-sm:row-span-2 max-sm:row-start-1" aria-hidden="true" />
          </button>
        </div>
        {nameError && <ErrorNote className="mx-3 mb-3">{nameError}</ErrorNote>}
      </div>
    );
  }

  return (
    <div className={frame} data-layout-card={l.id}>
      <div className="flex min-h-12 items-center gap-1 py-[7px] pl-1 pr-2">
        {grip}
        <NameField name={l.name} onCommit={onRename} label="Layout name" inputRef={nameRef} className="h-[30px] min-w-0 max-w-[280px] flex-1 text-[14px] font-semibold" />
        <span className="flex-1" />
        <Button variant="transparent" size="medium" onClick={onDuplicate} aria-label={`Duplicate ${l.name}`} className="max-sm:px-2">
          <CopyIcon className="size-[15px]" aria-hidden="true" />
          <span className="max-sm:hidden">Duplicate</span>
        </Button>
        <Button variant="transparent" size="medium" onClick={onDelete} aria-label={`Delete ${l.name}`} className="text-danger-11 hover:text-danger-11 max-sm:px-2">
          <Trash2Icon className="size-[15px]" aria-hidden="true" />
          <span className="max-sm:hidden">Delete</span>
        </Button>
        <Button variant="transparent" size="medium" iconOnly onClick={onToggle} aria-expanded aria-label={`Collapse ${l.name}`} data-focus-key={`open:${l.id}`}>
          <ChevronDownIcon className="size-4 rotate-180 text-fg-subtle" aria-hidden="true" />
        </Button>
      </div>
      {nameError && <ErrorNote className="mx-3 mb-3">{nameError}</ErrorNote>}

      <div className="flex flex-col gap-3.5 border-t border-line px-3.5 pb-4 pt-3.5 max-sm:p-3">
        <Row label="Columns" hint="Drag roles to reorder" id={`sc-cols-${l.id}`}>
          <div role="list" aria-labelledby={`sc-cols-${l.id}`} className="flex min-w-0 flex-wrap items-center gap-1.5" data-cols={l.id}>
            {fixedOn(l, "showClock") && <PinnedChip layoutId={l.id} k="showClock" where="Always first" onColumns={onColumns} />}
            {fixedOn(l, "showLength") && <PinnedChip layoutId={l.id} k="showLength" where="Always before Item" onColumns={onColumns} />}
            <span
              role="listitem"
              title="Always shown"
              aria-label="Item, always shown"
              data-anchor="item"
              className={cn(CHIP, "gap-[5px] border-transparent bg-fill pl-2 pr-2.5 text-fg-muted")}
            >
              <LockIcon className="size-[13px]" aria-hidden="true" />
              Item
            </span>
            {cols.map((r) => (
              <RoleChip key={r.id} item={{ kind: "col", ctx: l.id, id: r.id, label: r.name }} order={colIds}>
                <RemoveX label={`Remove ${r.name}`} focusKey={`x:${l.id}:${r.id}`} onClick={() => onColumns({ kind: "remove-role", roleId: r.id }, `tray:${l.id}:${r.id}`)} />
              </RoleChip>
            ))}
            {fixedOn(l, "showMaxSpl") && <PinnedChip layoutId={l.id} k="showMaxSpl" where="Always last" onColumns={onColumns} />}
          </div>
        </Row>
        <Row label="Not in this layout" hint="Click or drag in" id={`sc-tray-${l.id}`}>
          <div
            role="list"
            aria-labelledby={`sc-tray-${l.id}`}
            data-tray={l.id}
            className={cn(
              "flex min-h-11 flex-wrap items-center gap-1.5 rounded-lg border border-dashed border-line-strong p-1.5 transition-colors",
              trayOn && "border-accent bg-accent-soft",
            )}
          >
            {tray.map((it) => {
              const id = it.kind === "fixed" ? `fixed:${it.key}` : it.id;
              return (
                <span key={id} role="listitem" className="inline-flex">
                  <TrayChip
                    item={{ kind: "tray", ctx: l.id, id, label: it.name }}
                    title={it.kind === "fixed" ? "Goes to its fixed place" : undefined}
                    onAdd={() => onColumns(it.kind === "fixed" ? { kind: "set-fixed", key: it.key, on: true } : { kind: "add-role", roleId: it.id }, `x:${l.id}:${id}`)}
                  >
                    <PlusIcon className="size-[13px]" aria-hidden="true" />
                    {it.name}
                  </TrayChip>
                </span>
              );
            })}
            {tray.length === 0 && <span className="px-1.5 text-caption1 text-fg-subtle">Every column is in this layout.</span>}
            {roles.length === 0 && <span className="px-1.5 text-caption1 text-fg-subtle">Department columns come from category roles, below.</span>}
          </div>
        </Row>
        <Row label="Under the title">
          <div className="flex flex-wrap items-center gap-1.5">
            {UNDER_TITLE.map((t) => (
              <Toggle key={t.key} label={t.label} on={toggleOn(l, t.key)} onClick={() => onUpdate((cur) => ({ [t.key]: !toggleOn(cur, t.key) }))} />
            ))}
          </div>
        </Row>
        <Row label="Footer">
          <div className="flex flex-wrap items-center gap-1.5">
            {FOOTER.map((t) => (
              <Toggle key={t.key} label={t.label} on={toggleOn(l, t.key)} onClick={() => onUpdate((cur) => ({ [t.key]: !toggleOn(cur, t.key) }))} />
            ))}
          </div>
        </Row>
        <Row label="Row color">
          <RowColor layout={l} roles={roles} onUpdate={onUpdate} />
        </Row>
        <Preview layout={shown} roles={roles} source={preview} />
      </div>
    </div>
  );
}

/** A chip in the Columns row. */
const CHIP =
  "inline-flex h-[30px] max-w-full select-none items-center gap-0.5 whitespace-nowrap rounded-md border border-line-strong bg-surface-raised pl-2.5 pr-[3px] text-footnote text-fg";

const ICON_BUTTON =
  "inline-grid size-6 shrink-0 place-items-center rounded-[5px] p-0 text-fg-subtle transition-colors hover:bg-fill hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-30";

/** A role column: moved by its grip, taken out by its X. */
function RoleChip({ item, order, children }: { item: DragItem; order: readonly string[]; children: ReactNode }) {
  const carried = useCarried(item);
  const lifted = useLifted(item);
  return (
    <span
      role="listitem"
      data-sort-id={item.id}
      className={cn(CHIP, "pl-px", carried && "opacity-35", lifted && "bg-popover shadow-[0_0_0_2px_var(--su-accent),var(--su-shadow-2)]")}
    >
      <Grip item={item} order={order} />
      {item.label}
      {children}
    </span>
  );
}

/** A chip's X: takes the column out of the layout, into "Not in this layout". */
function RemoveX({ label, focusKey, onClick }: { label: string; focusKey: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} data-focus-key={focusKey} className={cn(ICON_BUTTON, "touch-target-y ml-0.5 hover:text-danger-11")}>
      <XIcon className="size-[13px]" aria-hidden="true" />
    </button>
  );
}

/** Clock, Time or Max SPL: a column with a fixed place, removable but not movable. */
function PinnedChip({ layoutId, k, where, onColumns }: { layoutId: string; k: FixedKey; where: string; onColumns: (c: ColumnChange, focus?: string) => void }) {
  return (
    <span role="listitem" title={where} data-fixed={k} className={cn(CHIP, "border-transparent bg-fill")}>
      <PinIcon className="mr-[3px] size-3 text-fg-subtle" aria-hidden="true" />
      {FIXED_LABEL[k]}
      <RemoveX label={`Remove ${FIXED_LABEL[k]}`} focusKey={`x:${layoutId}:fixed:${k}`} onClick={() => onColumns({ kind: "set-fixed", key: k, on: false }, `tray:${layoutId}:fixed:${k}`)} />
    </span>
  );
}

/** One thing a layout shows or hides, as a pill that says which. */
function Toggle({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className="group inline-flex h-[30px] items-center gap-[5px] whitespace-nowrap rounded-full border border-line-strong bg-transparent pl-2 pr-[11px] text-footnote text-fg-muted transition-colors hover:bg-fill hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus aria-pressed:border-accent/40 aria-pressed:bg-accent-soft aria-pressed:text-fg"
    >
      <CheckIcon className="size-3.5 opacity-0 group-aria-pressed:text-accent group-aria-pressed:opacity-100" aria-hidden="true" />
      {label}
    </button>
  );
}

/** One labelled row of the open card: the label in a column of its own, stacked above on a phone. */
export function Row({ label, hint, id, children }: { label: string; hint?: string; id?: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[132px_minmax(0,1fr)] items-start gap-x-4 gap-y-1.5 max-sm:grid-cols-[minmax(0,1fr)]">
      <div id={id} className="pt-1.5 text-caption1 font-medium text-fg-muted max-sm:pt-0">
        {label}
        {hint && <small className="mt-px block text-caption2 font-normal text-fg-subtle max-sm:ml-1.5 max-sm:inline">{hint}</small>}
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">{children}</div>
    </div>
  );
}

/** One source per layout, never both: PCO's color says what kind of item a row is, a
 *  category says whether a department has something to do there. */
function RowColor({ layout: l, roles, onUpdate }: { layout: ServiceCueLayout; roles: CategoryRole[]; onUpdate: (p: LayoutPatch) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Select value={l.rowColor ?? "pco"} onValueChange={(v) => onUpdate({ rowColor: v as "pco" | "category" | "none" })}>
        <SelectTrigger className="w-36" aria-label="Row color"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="pco">From PCO</SelectItem>
          <SelectItem value="category">By category</SelectItem>
          <SelectItem value="none">None</SelectItem>
        </SelectContent>
      </Select>
      {(l.rowColor ?? "pco") === "category" && (
        <Select value={l.accentRole ?? "__none__"} onValueChange={(v) => onUpdate({ accentRole: v === "__none__" ? null : v })}>
          <SelectTrigger className="w-44" aria-label="Row color category"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">Pick a category…</SelectItem>
            {/* Every role, not only this layout's columns: "Lighting has a cue here" is
                worth a tint without showing the cue's text. */}
            {roles.map((r) => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

/** The layout drawn against the previewed plan: capped in height, scrolling inside. */
function Preview({ layout: l, roles, source: p }: { layout: ServiceCueLayout; roles: CategoryRole[]; source: PreviewSource }) {
  const typeName = p.types.find((t) => t.id === p.typeId)?.name ?? "";
  // A role with no category in the previewed type draws no column; say which, so a
  // column missing from the preview is not read as one the layout lost.
  const skipped = p.rundown && p.rundown.items.length > 0 ? layoutRoles(l, roles).filter((r) => !roleApplies(r, p.noteCats)) : [];
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-caption2 font-medium uppercase tracking-[0.06em] text-fg-subtle">Preview</span>
        <label className="inline-flex items-center gap-1.5 text-caption1 text-fg-muted">
          Preview with
          {/* Held empty until the service types are in. The default comes from the
              settings, which answer first, and an id the picker cannot name yet
              would read "not found". */}
          <Select value={p.types.length > 0 ? (p.typeId ?? "") : ""} onValueChange={p.setTypeId} disabled={p.types.length === 0}>
            <SelectTrigger className="h-[26px] w-auto max-w-full text-caption1" aria-label="Preview with">
              <SelectValue placeholder={p.types.length > 0 ? "Select a service type" : p.typesPending} />
            </SelectTrigger>
            <SelectContent>
              {p.types.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </label>
        {p.rundown?.planTitle && <span className="text-caption1 text-fg-muted">{p.rundown.planTitle}</span>}
      </div>
      <div className="kiosk-surface max-h-[260px] overflow-auto overscroll-contain rounded-xl border border-white/10" data-preview={l.id}>
        {p.pcoConfigured === false ? (
          <div className="p-6 text-caption1 text-fg-muted">Connect Planning Center to preview a plan.</div>
        ) : p.rundownFailed ? (
          <div className="p-6"><ErrorNote>Couldn't load the plan to preview.</ErrorNote></div>
        ) : !p.typeId && p.typesFailed ? (
          <div className="p-6 text-caption1 text-fg-muted">No service type to preview against.</div>
        ) : !p.rundown ? (
          <div className="p-6 text-caption1 text-fg-muted">Loading plan…</div>
        ) : p.rundown.items.length === 0 ? (
          <div className="p-6 text-caption1 text-fg-muted">No upcoming plan for this service type.</div>
        ) : (
          <RundownTable
            items={p.rundown.items}
            columns={buildServiceCueColumns(resolveServiceCueSpec(l, roles, p.noteCats), computeClocks(p.rundown.items, p.rundown.serviceTimes?.[0]), p.rundown.timeZone)}
            itemTypeColors={p.rundown.itemTypeColors}
            rowColor={l.rowColor}
            accentRole={l.accentRole ?? null}
            roles={roles}
            autoScroll={false}
            everyColumn
            footer={l.showTotalTime !== false ? <span>{fmtTotal(totalLengthSec(p.rundown.items))} <span className="text-white/40">· total time</span></span> : undefined}
          />
        )}
      </div>
      {skipped.length > 0 && (
        <p className={cn("text-caption1 text-fg-subtle")}>
          {listOf(skipped.map((r) => r.name))} {skipped.length === 1 ? "has" : "have"} no category in {typeName}, so the preview leaves{" "}
          {skipped.length === 1 ? "it" : "them"} out.
        </p>
      )}
    </div>
  );
}

/**
 * A name that saves when it is left. Typing edits a draft; Enter or leaving the field
 * saves it, so a half-typed name is never the one a pinned screen's address was built
 * from. Escape puts the stored name back and leaves without saving. A blank or
 * unchanged name goes back to what it was, and so does a refused one: the draft
 * follows the stored name each time it changes (see useNameDraft).
 */
export function NameField({
  name,
  onCommit,
  label,
  className,
  inputRef,
}: {
  name: string;
  onCommit: (name: string) => void;
  label: string;
  className?: string;
  inputRef?: Ref<HTMLInputElement>;
}) {
  const draft = useNameDraft(name, onCommit);
  // Escape blurs the field; that blur must not save the draft it is throwing away.
  const reverting = useRef(false);
  return (
    <Input
      ref={inputRef}
      value={draft.draft}
      aria-label={label}
      autoComplete="off"
      onChange={(e) => draft.setDraft(e.target.value)}
      onBlur={() => {
        if (reverting.current) {
          reverting.current = false;
          draft.setDraft(name);
          return;
        }
        draft.commit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          reverting.current = true;
          e.currentTarget.blur();
        }
      }}
      className={className}
    />
  );
}
