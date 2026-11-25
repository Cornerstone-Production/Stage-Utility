// qsys-core-browser.tsx — pick the control a Q-SYS object binds to, from the live Core.
//
// Components first, then the controls of one that fit the object. What fits is
// decided here and nowhere else, so an object can only be bound to something it
// can use:
//
//   - an object that WRITES (`writable`) is offered only allowlisted controls the
//     writer would accept: not read-only, and a numeric one has write limits
//     (isWritable, the writer's own rule, from main/types/qsys.ts);
//   - an object that only READS is offered every control of the right kind.
//
// With no Core connected it says so and offers nothing: a binding is an address
// on a real design, and a list made up for the occasion would be a way to bind a
// control that is not there. An existing binding stays visible and clearable.
// Nothing is read until the browser is opened.

import { useEffect, useState } from "react";
import { ChevronLeftIcon, XIcon } from "lucide-react";

import { choicesOf, isMeterControl, isSelectorButton, isWritable, kindOf, type QsysBinding } from "@main/types/qsys";
import { rangeOf } from "../main/qsys/fader-scale";
import { Button, Input } from "../components/ui";
import { invoke, type ApiError } from "../lib/api";
import { cn } from "../lib/cn";
import { logReadFailure } from "../lib/client-log";

/**
 * What an object wants to bind: a level, an on/off, a button, a choice list, a
 * meter, or text. `press` is a selector's button: a trigger, or an on/off control
 * (a selector plugin's `Button N` is a Boolean, on for the chosen one), both
 * written true on a press.
 */
export type QsysBrowseKind = "gain" | "boolean" | "trigger" | "press" | "choice" | "meter" | "string";

interface CatalogControl {
  Name: string;
  Type?: string;
  Direction?: string;
  Value?: unknown;
  ValueMin?: number;
  ValueMax?: number;
  Choices?: unknown;
  /** A selector button's name as the Core draws it, when the server could read it. */
  Legend?: string;
}
interface CatalogComponent {
  name: string;
  type: string;
  controls: CatalogControl[];
  /** The Core would not say its buttons' names. */
  legendError?: string;
}
interface AllowEntry {
  component: string;
  control: string;
  min: number | null;
  max: number | null;
}

// The panel's own rules (fader-scale.ts rangeOf, types/qsys.ts choicesOf), so the
// editor offers exactly what a panel will draw live.
const hasRange = (c: CatalogControl) => rangeOf(c) !== null;
const hasChoices = (c: CatalogControl) => choicesOf(c) !== null;

/** Whether a control is the kind of thing an object of `kind` binds to. Writability is separate. */
export function fitsKind(kind: QsysBrowseKind, componentType: string, c: CatalogControl): boolean {
  switch (kind) {
    case "meter":
      return isMeterControl(componentType, { Name: c.Name, Type: String(c.Type ?? "") });
    case "gain":
      return kindOf(c) === "number" && hasRange(c) && !isMeterControl(componentType, { Name: c.Name, Type: String(c.Type ?? "") });
    case "boolean":
      return kindOf(c) === "boolean";
    case "trigger":
      return kindOf(c) === "trigger";
    case "press":
      return kindOf(c) === "trigger" || kindOf(c) === "boolean";
    case "string":
      return kindOf(c) === "text";
    case "choice":
      return hasChoices(c);
  }
}

export type QsysCoreLoad =
  | { state: "loading" }
  | { state: "no-core" }
  | { state: "failed"; what: "catalog" | "allowlist" }
  | { state: "ready"; components: CatalogComponent[]; allow: Map<string, AllowEntry> | null };
export type { CatalogComponent, CatalogControl, AllowEntry };
export { hasChoices };

const keyOf = (component: string, control: string) => `${component}\u0000${control}`;

/** Controls in natural order: Button 2 before Button 10, output.2 before output.10. */
const natural = (a: CatalogControl, b: CatalogControl) => a.Name.localeCompare(b.Name, undefined, { numeric: true });

/** The name a Core draws on a control, when it reported a non-empty one. */
export const legendOf = (c: CatalogControl): string | null => (typeof c.Legend === "string" && c.Legend.trim() ? c.Legend.trim() : null);
export const allowKey = keyOf;

const LOADING: QsysCoreLoad = { state: "loading" };

/**
 * The Core's catalog (and the allowlist when `writable`) for an editor control,
 * read once per `request`: a number the caller bumps each time it wants a fresh
 * read (a browser opening; the design may have been redeployed since), or null
 * for none. "loading" until that request's read answers.
 */
export function useQsysCoreLoad(request: number | null, writable: boolean): QsysCoreLoad {
  const [answer, setAnswer] = useState<{ request: number; writable: boolean; load: Exclude<QsysCoreLoad, { state: "loading" }> } | null>(null);
  useEffect(() => {
    if (request === null) return;
    let current = true;
    void loadQsysCore(writable).then((load) => {
      if (current) setAnswer({ request, writable, load });
    });
    return () => {
      current = false;
    };
  }, [request, writable]);
  return answer && answer.request === request && answer.writable === writable ? answer.load : LOADING;
}

/** What a Core read says while it is not ready: reading, no Core, or what could not be read. Nothing once ready. */
export function CoreLoadNotice({ load, className }: { load: QsysCoreLoad; className?: string }) {
  switch (load.state) {
    case "loading":
      return <p className={cn("text-caption2 text-fg-muted", className)}>Reading the Core…</p>;
    case "no-core":
      return (
        <p role="status" className={cn("text-caption2 text-fg-muted", className)}>
          No Q-SYS Core is connected, so there is nothing to choose from. Set it up under Settings, Integrations, Q-SYS.
        </p>
      );
    case "failed":
      return (
        <p role="alert" className={cn("text-caption2 text-danger-11", className)}>
          {load.what === "catalog" ? "The Core's controls could not be read. See /log." : "The allowlist could not be read, so no writable control is known. See /log."}
        </p>
      );
    case "ready":
      return null;
  }
}

/** The Core's catalog, and the allowlist when `writable`, as the browser reads them. Never throws; says what failed. */
export async function loadQsysCore(writable: boolean): Promise<Exclude<QsysCoreLoad, { state: "loading" }>> {
  let catalog: { components: CatalogComponent[] };
  try {
    catalog = await invoke<{ components: CatalogComponent[] }>("qsys:catalog");
    if (!Array.isArray(catalog?.components)) throw new Error("the catalog answer has no component list");
  } catch (err) {
    // 503 is the server saying there is no connection. Anything else is a failed read.
    if ((err as ApiError).status === 503) return { state: "no-core" };
    logReadFailure("qsys", "the Core's catalog for the control browser", err);
    return { state: "failed", what: "catalog" };
  }
  let allow: Map<string, AllowEntry> | null = null;
  if (writable) {
    try {
      const a = await invoke<{ entries: AllowEntry[] }>("qsys:allowlist");
      allow = new Map(a.entries.map((e) => [keyOf(e.component, e.control), e]));
    } catch (err) {
      logReadFailure("qsys", "the allowlist for the control browser", err);
      return { state: "failed", what: "allowlist" };
    }
  }
  return { state: "ready", components: catalog.components, allow };
}

export function QsysCoreBrowser({
  kind,
  writable,
  value,
  onChange,
  label = "Control",
  placeholder = "Choose control",
  clearable = true,
}: {
  kind: QsysBrowseKind;
  /** The object WRITES this control: only allowlisted, writable ones are offered. */
  writable: boolean;
  value: QsysBinding | null;
  /** `legend`: the name the Core draws on the chosen control, when it reported one. */
  onChange: (b: QsysBinding | null, legend?: string) => void;
  /** What this binding is called in the inspector ("Fader control", "On trigger"). */
  label?: string;
  /** What the button says while nothing is bound. */
  placeholder?: string;
  /** False where the binding is required (a preset's control): choose another instead. */
  clearable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  /** Bumped on each open: a fresh read each time, since the design may have been redeployed. */
  const [opened, setOpened] = useState(0);
  const load = useQsysCoreLoad(open ? opened : null, writable);
  const [component, setComponent] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const offered = (comp: CatalogComponent): CatalogControl[] =>
    load.state !== "ready"
      ? []
      : comp.controls
          .filter((c) => {
            if (!fitsKind(kind, comp.type, c)) return false;
            if (!writable) return true;
            const entry = load.allow?.get(keyOf(comp.name, c.Name));
            // A choice list is written with one of its choices, which bound it in place of a range.
            return !!entry && isWritable(c, entry, kind === "choice");
          })
          .sort(natural);

  const pick = (comp: string, c: CatalogControl) => {
    onChange({ component: comp, control: c.Name }, legendOf(c) ?? undefined);
    setOpen(false);
    setQuery("");
    setComponent(null);
  };

  const q = query.trim().toLowerCase();
  const withControls = load.state === "ready" ? load.components.map((c) => ({ comp: c, list: offered(c) })).filter((x) => x.list.length > 0) : [];
  const matches = q
    ? withControls.flatMap(({ comp, list }) =>
        list.filter((c) => comp.name.toLowerCase().includes(q) || c.Name.toLowerCase().includes(q)).map((c) => ({ comp, c })),
      )
    : [];
  const chosen = component ? withControls.find((x) => x.comp.name === component) : undefined;

  const row = "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-footnote hover:bg-fill-hover min-h-9";

  const controlRow = (comp: CatalogComponent, c: CatalogControl, showComponent: boolean) => (
    <li key={`${comp.name}/${c.Name}`}>
      <button type="button" data-qsys-control={c.Name} className={row} onClick={() => pick(comp.name, c)}>
        <span className="min-w-0 truncate">
          <span className="font-mono">{c.Name}</span>
          {legendOf(c) && (
            <>
              {" "}
              <span data-qsys-legend>{legendOf(c)}</span>
            </>
          )}
          {showComponent && <span className="text-fg-muted"> in {comp.name}</span>}
        </span>
        {/* A space for the accessible name; a flex container draws none. */}
        {" "}
        {kind === "gain" && hasRange(c) && (
          <span className="shrink-0 font-mono text-caption2 text-fg-muted">
            {c.ValueMin} to {c.ValueMax}
          </span>
        )}
      </button>
    </li>
  );

  return (
    <div className="flex w-full min-w-0 flex-col gap-1">
      <div className="flex items-center gap-1">
        <Button
          variant="filled"
          aria-label={label}
          aria-expanded={open}
          className="min-w-0 flex-1 justify-start"
          onClick={() => {
            setOpened((n) => n + 1);
            setOpen((o) => !o);
            setComponent(null);
            setQuery("");
          }}
        >
          <span className="truncate font-mono">{value ? `${value.component} / ${value.control}` : placeholder}</span>
        </Button>
        {value && clearable && (
          <Button variant="transparent" iconOnly aria-label={`Clear ${label}`} onClick={() => onChange(null)}>
            <XIcon className="size-3.5" />
          </Button>
        )}
      </div>

      {open && (
        <div className="flex flex-col gap-1 rounded-md border border-line bg-surface p-1.5" data-qsys-browser>
          <CoreLoadNotice load={load} className="px-1" />
          {load.state === "ready" && (
            <>
              <Input aria-label="Search controls" placeholder="Search components and controls" value={query} onChange={(e) => setQuery(e.target.value)} />
              {chosen && !q && (
                <button type="button" className={cn(row, "text-fg-muted")} onClick={() => setComponent(null)}>
                  <span className="flex items-center gap-1">
                    <ChevronLeftIcon className="size-3.5" />
                    Components
                  </span>
                </button>
              )}
              <ul className="flex max-h-64 flex-col overflow-y-auto">
                {q ? (
                  matches.length === 0 ? (
                    <li className="px-2 py-1.5 text-caption2 text-fg-muted">Nothing matches.</li>
                  ) : (
                    matches.slice(0, 200).map(({ comp, c }) => controlRow(comp, c, true))
                  )
                ) : chosen ? (
                  <>
                    {chosen.comp.legendError && chosen.list.some((c) => isSelectorButton(c.Name)) && (
                      <li role="status" className="px-2 py-1.5 text-caption2 text-fg-muted">
                        The Core did not say these buttons&apos; names, so they are listed by number. See /log.
                      </li>
                    )}
                    {chosen.list.map((c) => controlRow(chosen.comp, c, false))}
                  </>
                ) : withControls.length === 0 ? (
                  <li className="px-2 py-1.5 text-caption2 text-fg-muted">
                    {writable ? "No allowlisted control fits. Allow one on the Q-SYS manage page." : "No control on this Core fits."}
                  </li>
                ) : (
                  withControls.map(({ comp, list }) => (
                    <li key={comp.name}>
                      <button type="button" data-qsys-component={comp.name} className={row} onClick={() => setComponent(comp.name)}>
                        <span className="min-w-0 truncate font-mono">{comp.name}</span>
                        <span className="shrink-0 font-mono text-caption2 text-fg-muted">{list.length}</span>
                      </button>
                    </li>
                  ))
                )}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
