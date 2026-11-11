// servicecue-layout-card.tsx — one layout on the ServiceCue layouts page.
//
// Shut, a card is its name and every column it draws, in order. Open (one at a time),
// it is the name field, Duplicate and Delete, the rows that set what the layout shows,
// and a preview of it against the plan the page previews with.

import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, ChevronUpIcon, CopyIcon, Trash2Icon, XIcon } from "lucide-react";
import { useRef, type ReactNode, type Ref } from "react";

import { Button, ErrorNote, Input, MultiSelect, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui";
import { cn } from "../../lib/cn";
import { useNameDraft } from "../../lib/use-name-draft";
import { RundownTable } from "../../main/rundown-table";
import { buildServiceCueColumns, computeClocks, fmtTotal, resolveServiceCueSpec, totalLengthSec } from "../../main/servicecue-columns";
import type { ServiceCueLayout } from "../../../main/types/pco.js";
import type { CategoryRole } from "../../../main/types/servicecue-roles.js";
import { columnSummary, layoutRoles, listOf, roleApplies } from "./servicecue-layouts-model";

/** The per-layout element toggles, until the Columns row replaces them. */
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

const elementOn = (e: (typeof ELEMENTS)[number], l: ServiceCueLayout): boolean =>
  "optIn" in e && e.optIn ? l[e.key] === true : l[e.key] !== false;

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
  preview,
  move,
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
  preview: PreviewSource;
  /** Up and down, until a card can be dragged. */
  move: { first: boolean; last: boolean; by: (dir: -1 | 1) => void };
  /** The open card's name field, for the page to focus on a new or copied layout. */
  nameRef?: Ref<HTMLInputElement>;
}) {
  const summary = columnSummary(l, roles).join(" · ");
  const arrows = (
    <>
      <Button variant="transparent" size="small" iconOnly touchTargetY disabled={move.first} onClick={() => move.by(-1)} aria-label="Move up"><ChevronUpIcon className="size-4" /></Button>
      <Button variant="transparent" size="small" iconOnly touchTargetY disabled={move.last} onClick={() => move.by(1)} aria-label="Move down"><ChevronDownIcon className="size-4" /></Button>
    </>
  );

  if (!open) {
    return (
      <div className="rounded-xl border border-line bg-surface shadow-[var(--su-shadow-1)]" data-layout-card={l.id}>
        <div className="flex min-h-12 items-center gap-1 py-[7px] pl-1 pr-2">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={false}
            aria-label={`${l.name}, ${summary}`}
            className="grid min-w-0 flex-1 cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 rounded-md p-1 text-left transition-colors hover:bg-fill focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus max-sm:grid-cols-[minmax(0,1fr)_auto]"
          >
            <span className="max-w-[22ch] truncate text-[14px] font-semibold leading-[19px] text-fg" data-layout-name>{l.name}</span>
            <span className="min-w-0 truncate text-caption1 text-fg-muted max-sm:col-start-1 max-sm:row-start-2 max-sm:whitespace-normal">{summary}</span>
            <ChevronDownIcon className="size-4 text-fg-subtle max-sm:col-start-2 max-sm:row-span-2 max-sm:row-start-1" aria-hidden="true" />
          </button>
          {arrows}
        </div>
        {nameError && <ErrorNote className="mx-3 mb-3">{nameError}</ErrorNote>}
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-line bg-surface shadow-[var(--su-shadow-1)]" data-layout-card={l.id}>
      <div className="flex min-h-12 items-center gap-1 py-[7px] pl-1 pr-2">
        <NameField name={l.name} onCommit={onRename} label="Layout name" inputRef={nameRef} className="h-[30px] min-w-0 max-w-[280px] flex-1 text-[14px] font-semibold" />
        <span className="flex-1" />
        {arrows}
        <Button variant="transparent" size="medium" onClick={onDuplicate} aria-label={`Duplicate ${l.name}`} className="max-sm:px-2">
          <CopyIcon className="size-[15px]" aria-hidden="true" />
          <span className="max-sm:hidden">Duplicate</span>
        </Button>
        <Button variant="transparent" size="medium" onClick={onDelete} aria-label={`Delete ${l.name}`} className="text-danger-11 hover:text-danger-11 max-sm:px-2">
          <Trash2Icon className="size-[15px]" aria-hidden="true" />
          <span className="max-sm:hidden">Delete</span>
        </Button>
        <Button variant="transparent" size="medium" iconOnly onClick={onToggle} aria-expanded aria-label={`Collapse ${l.name}`}>
          <ChevronDownIcon className="size-4 rotate-180 text-fg-subtle" aria-hidden="true" />
        </Button>
      </div>
      {nameError && <ErrorNote className="mx-3 mb-3">{nameError}</ErrorNote>}

      <div className="flex flex-col gap-3.5 border-t border-line px-3.5 pb-4 pt-3.5 max-sm:p-3">
        <Row label="Columns">
          <div className="flex flex-wrap items-center gap-1.5">
            {layoutRoles(l, roles).map((r, ci, cols) => (
              <span key={r.id} className="inline-flex items-center gap-1 rounded-md border border-line-strong bg-surface-raised py-1 pl-2 pr-1 text-caption1 text-fg">
                <button type="button" className="touch-target-y text-fg-subtle hover:text-fg disabled:opacity-30" disabled={ci === 0} onClick={() => onUpdate((cur) => ({ columnRoles: swap(cur.columnRoles ?? [], r.id, -1) }))} aria-label="Move left"><ChevronLeftIcon className="size-3.5" /></button>
                {r.name}
                <button type="button" className="touch-target-y text-fg-subtle hover:text-fg disabled:opacity-30" disabled={ci === cols.length - 1} onClick={() => onUpdate((cur) => ({ columnRoles: swap(cur.columnRoles ?? [], r.id, 1) }))} aria-label="Move right"><ChevronRightIcon className="size-3.5" /></button>
                <button
                  type="button"
                  className="touch-target-y ml-0.5 text-fg-subtle hover:text-danger-11"
                  onClick={() => onUpdate((cur) => ({
                    columnRoles: (cur.columnRoles ?? []).filter((c) => c !== r.id),
                    ...(cur.accentRole === r.id ? { accentRole: null } : {}),
                  }))}
                  aria-label={`Remove ${r.name}`}
                >
                  <XIcon className="size-3.5" />
                </button>
              </span>
            ))}
            {roles.some((r) => !(l.columnRoles ?? []).includes(r.id)) && (
              <Select value="" onValueChange={(v) => onUpdate((cur) => ({ columnRoles: [...(cur.columnRoles ?? []).filter((c) => c !== v), v] }))}>
                <SelectTrigger className="h-7 w-auto px-2 text-caption1" aria-label="Add a column">
                  <SelectValue placeholder="+ Add column" />
                </SelectTrigger>
                <SelectContent>
                  {roles.filter((r) => !(l.columnRoles ?? []).includes(r.id)).map((r) => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
          </div>
        </Row>
        <Row label="Shows">
          <MultiSelect
            label={`Shows, ${l.name}`}
            className="w-64 max-sm:w-full"
            options={ELEMENTS.map((e) => ({ value: e.key, label: e.label }))}
            selected={ELEMENTS.filter((e) => elementOn(e, l)).map((e) => e.key)}
            onChange={(next) => {
              const on = new Set(next);
              onUpdate(Object.fromEntries(ELEMENTS.map((e) => [e.key, on.has(e.key)])) as Partial<ServiceCueLayout>);
            }}
            placeholder="Nothing shown"
          />
        </Row>
        <Row label="Row color">
          <RowColor layout={l} roles={roles} onUpdate={onUpdate} />
        </Row>
        <Preview layout={l} roles={roles} source={preview} />
      </div>
    </div>
  );
}

function swap(cols: string[], id: string, dir: -1 | 1): string[] {
  const out = [...cols];
  const i = out.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= out.length) return cols;
  [out[i], out[j]] = [out[j], out[i]];
  return out;
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
