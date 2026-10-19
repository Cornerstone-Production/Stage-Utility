// The grouped, searchable pickers for a rule's trigger, condition and action.
//
// ONE component for every place a rule's step is chosen: the New cue dialog's
// When, If and Then steps, and the single-page editor's Trigger, Add condition and
// Action rows. They replace the flat selects, which listed every definition in
// the registry in one column — about a hundred of them, under no heading.
//
// Two shapes of the same panel:
//
//  - AutomationPicker is the panel itself: a search field, the headings down the
//    left with how many each holds, and the choices beside them, each with the
//    definition's own one-line `help`. A dialog step draws it open.
//  - PickerField is a button showing the current choice that opens the panel
//    beneath it. The editor draws that, so a one-field change is still one click.
//
// Typing in the search field filters across every heading at once and names the
// heading beside each match.
//
// The headings are not here: automation-groups.ts maps a trigger's channel, an
// action's integration and a condition's id to one. A definition nothing claims
// is drawn under Other rather than dropped, so a mapping that is missing is a
// heading that reads wrong and not a rule nobody can build — and
// automation-groups.test.ts fails before it can ship.
//
// NOT unit-tested here, and driven in a browser instead: the panel's two columns,
// that the option list scrolls instead of growing the dialog, and the selected
// row's tint. jsdom loads no stylesheet and reports every offsetHeight as 0.

import { useMemo, useState } from "react";
import { ChevronDownIcon, SearchIcon } from "lucide-react";

import {
  ACTION_GROUPS,
  CONDITION_GROUPS,
  OTHER_GROUP,
  TRIGGER_GROUPS,
  actionGroup,
  conditionGroup,
  triggerGroup,
} from "@main/services/automation-groups";
import { cn } from "../../lib/cn";
import { NOT_OFFERED } from "../../components/ui";

export type PickerKind = "trigger" | "action" | "condition";

/** One definition, as the picker needs it. A trigger carries its `channel`. */
export interface PickerDef {
  id: string;
  label: string;
  help?: string;
  channel?: string;
}

interface Entry {
  id: string;
  label: string;
  help: string;
  group: string;
}

const NOUN: Record<PickerKind, string> = { trigger: "triggers", action: "actions", condition: "conditions" };

const ORDER: Record<PickerKind, readonly string[]> = {
  trigger: TRIGGER_GROUPS,
  action: ACTION_GROUPS,
  condition: CONDITION_GROUPS,
};

/** The heading a definition sits under, for this kind of picker. Other when
 *  nothing claims it — never null, so nothing is ever left out of the list. */
export function pickerGroupOf(kind: PickerKind, def: PickerDef): string {
  const group =
    kind === "trigger" ? triggerGroup(def.channel ?? "") : kind === "action" ? actionGroup(def.id) : conditionGroup(def.id);
  return group ?? OTHER_GROUP;
}

/** The definitions as entries, in heading order and then registry order, with
 *  Other last. */
export function pickerEntries(kind: PickerKind, defs: readonly PickerDef[]): Entry[] {
  const order = [...ORDER[kind], OTHER_GROUP];
  return defs
    .map((d) => ({ id: d.id, label: d.label, help: d.help ?? "", group: pickerGroupOf(kind, d) }))
    .sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
}

/** The headings that hold something, in order, each with its count. */
export function pickerHeadings(entries: readonly Entry[]): { name: string; count: number }[] {
  const out: { name: string; count: number }[] = [];
  for (const e of entries) {
    const last = out[out.length - 1];
    if (last && last.name === e.group) last.count += 1;
    else out.push({ name: e.group, count: 1 });
  }
  return out;
}

/**
 * The first sentence of a definition's help, which is its one-line description.
 *
 * Several helps run to a paragraph (a recorder's, a macro's); a row that cut
 * that off mid-clause read worse than one that stopped at the end of the first
 * thought. The whole text stays on the row as its tooltip.
 */
export function oneLine(help: string): string {
  return help.split(/(?<=[.!?])\s+(?=[A-Z])/)[0] ?? help;
}

/** What a search matches: the name and the one-line description, in any case. */
export function pickerMatches(entries: readonly Entry[], query: string): Entry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return entries.filter((e) => e.label.toLowerCase().includes(q) || e.help.toLowerCase().includes(q));
}

export function AutomationPicker({
  kind,
  defs,
  value,
  onChange,
  exclude,
}: {
  kind: PickerKind;
  defs: readonly PickerDef[];
  /** The chosen id, or "" for none. */
  value: string;
  onChange: (id: string) => void;
  /** Ids this picker does not offer. Called by name is the one a trigger picker
   *  leaves out: a manual cue is made by choosing the kind. */
  exclude?: ReadonlySet<string>;
}) {
  const entries = useMemo(
    () => pickerEntries(kind, exclude ? defs.filter((d) => !exclude.has(d.id)) : defs),
    [kind, defs, exclude],
  );
  const headings = useMemo(() => pickerHeadings(entries), [entries]);
  const [query, setQuery] = useState("");
  // The heading shown with no search: the chosen one's, or the first.
  const [picked, setPicked] = useState<string | null>(null);
  const shown = picked ?? entries.find((e) => e.id === value)?.group ?? headings[0]?.name ?? "";

  const searching = query.trim() !== "";
  const options = searching ? pickerMatches(entries, query) : entries.filter((e) => e.group === shown);

  return (
    <div className="flex flex-col gap-2" data-picker={kind}>
      <span className="relative block">
        <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Enter takes the first match, so a search is a keyboard-only path.
            if (e.key === "Enter" && searching && options[0]) {
              e.preventDefault();
              onChange(options[0].id);
            }
          }}
          placeholder={`Search ${NOUN[kind]}`}
          aria-label={`Search ${NOUN[kind]}`}
          className="h-8 w-full rounded-md border border-line-strong bg-field pl-8 pr-2.5 text-footnote text-fg placeholder:text-fg-subtle focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus"
        />
      </span>
      <div className="grid min-h-0 grid-cols-[150px_minmax(0,1fr)] gap-3 max-sm:grid-cols-1">
        <div role="group" aria-label="Headings" className="flex flex-col gap-0.5 max-sm:flex-row max-sm:flex-wrap">
          {headings.map((h) => (
            <button
              key={h.name}
              type="button"
              data-picker-group={h.name}
              aria-pressed={!searching && shown === h.name}
              onClick={() => {
                setPicked(h.name);
                setQuery("");
              }}
              className={cn(
                "flex items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-footnote transition-colors",
                !searching && shown === h.name ? "bg-fill-hover font-medium text-fg" : "text-fg-muted hover:bg-fill",
              )}
            >
              <span className="min-w-0 truncate">{h.name}</span>
              <span className="font-mono text-caption2 text-fg-subtle">{h.count}</span>
            </button>
          ))}
        </div>
        <div className="flex max-h-72 min-h-0 flex-col gap-1.5 overflow-y-auto pr-0.5" role="group" aria-label={`Choose one of the ${NOUN[kind]}`}>
          {options.length === 0 ? (
            <p className="rounded-lg border border-line bg-surface px-3 py-2 text-caption1 text-fg-muted">
              Nothing matches. Try another word.
            </p>
          ) : (
            options.map((e) => (
              <button
                key={e.id}
                type="button"
                data-picker-option={e.id}
                aria-pressed={e.id === value}
                title={e.help}
                onClick={() => onChange(e.id)}
                className={cn(
                  "flex flex-col gap-px rounded-lg border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus",
                  e.id === value ? "border-accent bg-accent/12" : "border-line bg-surface hover:bg-fill",
                )}
              >
                <span className="text-footnote font-medium text-fg">{e.label}</span>
                <span className="truncate text-caption1 text-fg-muted">
                  {searching ? <span data-picker-group-name="">{e.group} · </span> : null}
                  {oneLine(e.help)}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The picker as a field: the current choice on a button, the panel beneath it
 * while it is open. Choosing closes it.
 *
 * `value` may name something the registry no longer lists (a trigger an older
 * release saved). The button then shows the id with "not found" after it, rather
 * than going blank or showing a neighbour, which is what the Select this
 * replaced did too.
 */
export function PickerField({
  kind,
  defs,
  value,
  onChange,
  placeholder,
  ariaLabel,
  exclude,
}: {
  kind: PickerKind;
  defs: readonly PickerDef[] | null;
  value: string;
  onChange: (id: string) => void;
  placeholder: string;
  ariaLabel: string;
  exclude?: ReadonlySet<string>;
}) {
  const [open, setOpen] = useState(false);
  // A stored id the registry no longer lists reads as the id and says so, the way
  // a Select does for a value it has no option for (NOT_OFFERED). While the
  // registry has not answered it is just the id: nothing is known to be missing.
  const found = defs?.find((d) => d.id === value);
  const current = !value ? "" : found ? found.label : defs ? `${value} ${NOT_OFFERED}` : value;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <button
        type="button"
        aria-label={ariaLabel}
        aria-expanded={open}
        data-picker-field={kind}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex h-7 w-full items-center justify-between gap-2 rounded-md border border-line-strong bg-field px-2.5 text-left text-footnote",
          "focus:border-focus focus:outline-none focus:ring-1 focus:ring-focus",
          current ? "text-fg" : "text-fg-subtle",
        )}
      >
        <span className="min-w-0 truncate">{current || placeholder}</span>
        <ChevronDownIcon className={cn("size-3.5 shrink-0 text-fg-subtle transition-transform", open && "rotate-180")} />
      </button>
      {open && defs && (
        <div className="rounded-lg border border-line bg-surface p-2.5">
          <AutomationPicker
            kind={kind}
            defs={defs}
            value={value}
            exclude={exclude}
            onChange={(id) => {
              onChange(id);
              setOpen(false);
            }}
          />
        </div>
      )}
    </div>
  );
}
