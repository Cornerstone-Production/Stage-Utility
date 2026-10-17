import { Fragment, useRef } from "react";
import { ChevronRightIcon } from "lucide-react";

import { plural } from "@main/services/plural";
import { cn } from "../lib/cn";
import { endpointKey, type ResolvedPatch } from "../lib/patch-resolve";
import {
  chainNodes,
  noRowsMessage,
  sourceColor,
  UNUSED_NOTE,
  withOwnerHeadings,
  type PatchChange,
  type RackSection,
} from "../lib/patch-view-model";
import { prefersReducedMotion } from "../lib/reduced-motion";
import { Input } from "../components/ui/input";
import { LEGEND_NODES, PatchChain } from "./patch-chain";

export interface PatchWideProps {
  sheet: PatchSheet;
  state: StageState | null;
  resolved: ResolvedPatch;
  /** Every change across inputs and outputs. */
  changes: PatchChange[];
  /** The racks, filtered, for the direction on screen. */
  sections: RackSection[];
  tab: "in" | "out";
  onTab: (t: "in" | "out") => void;
  q: string;
  onQ: (q: string) => void;
  changesOnly: boolean;
  onChangesOnly: (v: boolean) => void;
  collapsed: Record<string, boolean>;
  onToggleRack: (id: string) => void;
  onOpenRack: (id: string) => void;
}

const CARD = "rounded-xl border border-line bg-surface";
const EYEBROW = "text-caption2 font-semibold uppercase tracking-wider text-fg-subtle";
const PILL = "inline-flex items-center rounded-full border border-line-strong px-2 py-px text-caption2 text-fg-muted";
const TH = "whitespace-nowrap border-b border-line px-2.5 py-[7px] text-left text-caption2 font-semibold uppercase tracking-wider text-fg-subtle";
const TD = "h-[34px] whitespace-nowrap border-b border-line px-2.5 align-middle";

/**
 * The /patch volunteer view at desk width: a sticky column for this week's
 * context, what changed and a jump list, and one table per rack beside it. A
 * desk has the room to show every channel on one line, which is what lets a
 * volunteer scan 56 inputs without scrolling past two lines of each.
 */
export function PatchWide(p: PatchWideProps) {
  const { sheet, resolved } = p;
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const noteByKey = new Map(p.changes.map((c) => [endpointKey(c.e), c.note] as const));

  function jumpTo(rackId: string) {
    p.onOpenRack(rackId);
    const card = cardRefs.current.get(rackId);
    card?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
    // Scrolling does not move focus: without this the next Tab from a keyboard
    // jump goes to the next rack in the list, not into the one just shown.
    card?.querySelector("button")?.focus({ preventScroll: true });
  }

  const planLine = [p.state?.planTitle, p.state?.planDates].filter(Boolean).join(" · ");
  const isIn = p.tab === "in";
  // One per header cell below, so an owner row spans the whole table.
  const cols = isIn ? 7 : 6;

  return (
    <div className="grid grid-cols-[270px_minmax(0,1fr)] items-start gap-3.5">
      <aside className="sticky top-0 flex max-h-[calc(100vh-7rem)] flex-col gap-3 overflow-y-auto">
        <div className={cn(CARD, "px-4 py-3.5")}>
          <div className={EYEBROW}>This week</div>
          <div className="mt-1 text-callout font-semibold">{p.state?.serviceTypeName ?? "—"}</div>
          {planLine && <div className="mt-0.5 text-footnote text-fg-muted">{planLine}</div>}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {resolved.variantName && <span className={PILL}>Base: {resolved.variantName}</span>}
            <span className={PILL}>Read-only</span>
          </div>
        </div>

        {p.changes.length > 0 && (
          <div className="rounded-xl border border-warn-9/40 bg-warn-9/12 px-3.5 py-3">
            <h2 className="mb-2 text-footnote font-semibold text-warn-11">{plural(p.changes.length, "change")} from the standard patch</h2>
            {p.changes.map(({ e, note }) => (
              <div key={endpointKey(e)} className="flex gap-2 border-t border-warn-9/22 py-1 text-footnote">
                <span className="w-11 shrink-0 font-mono text-caption1 text-fg-muted">{e.dir} {e.index}</span>
                <span className={cn("min-w-0 truncate", e.unused && "text-fg-muted line-through")}>
                  {e.unused ? e.label || "(source)" : e.label || "(unnamed)"}
                </span>
                {note && <em className="ml-auto whitespace-nowrap pl-1 not-italic text-warn-11">{note === UNUSED_NOTE ? "unused" : note}</em>}
              </div>
            ))}
          </div>
        )}

        {p.sections.length > 0 && (
          <nav aria-label="Jump to" className={cn(CARD, "p-2")}>
            <div className={cn(EYEBROW, "px-2 py-1.5")}>Jump to</div>
            {p.sections.map(({ rack, rows }) => (
              <button
                key={rack.id}
                type="button"
                onClick={() => jumpTo(rack.id)}
                className="flex w-full items-center gap-2 rounded-[7px] px-2 py-1.5 text-left text-footnote hover:bg-fill"
              >
                <i className="size-2 shrink-0 rounded-sm" style={{ background: rack.color ?? "var(--su-line-strong)" }} />
                <span className="min-w-0 truncate">{rack.name}</span>
                <span className="ml-auto font-mono text-caption1 text-fg-subtle">{rows.length}</span>
              </button>
            ))}
          </nav>
        )}
      </aside>

      <section className="min-w-0">
        <div className="mb-2.5 flex flex-wrap items-center gap-2">
          <div className="inline-flex overflow-hidden rounded-lg border border-line-strong">
            {(["in", "out"] as const).map((t) => (
              <button
                key={t}
                type="button"
                aria-pressed={p.tab === t}
                onClick={() => p.onTab(t)}
                className={cn("px-2.5 py-1 text-footnote", p.tab === t ? "bg-fill-hover font-semibold text-fg" : "text-fg-muted hover:text-fg")}
              >
                {t === "in" ? "Inputs" : "Outputs"}
              </button>
            ))}
          </div>
          <Input
            value={p.q}
            onChange={(e) => p.onQ(e.target.value)}
            placeholder="Filter channels, sources, mics"
            aria-label="Filter channels"
            className="h-8 w-[200px] rounded-[7px]"
          />
          <button
            type="button"
            aria-pressed={p.changesOnly}
            onClick={() => p.onChangesOnly(!p.changesOnly)}
            className={cn(
              "h-8 rounded-[7px] border px-2.5 text-footnote font-medium",
              p.changesOnly ? "border-warn-9 bg-warn-9/12 text-fg" : "border-line-strong bg-surface text-fg hover:bg-fill",
            )}
          >
            Changes only
          </button>
          <div className="ml-auto flex items-center gap-1.5 text-caption1 text-fg-muted">
            <span className="whitespace-nowrap">How to read:</span>
            <PatchChain compact nodes={LEGEND_NODES} />
          </div>
        </div>

        {p.sections.length === 0 && (
          <div className={cn(CARD, "px-4 py-8 text-center text-footnote text-fg-muted")}>
            {noRowsMessage(p.tab, { changesOnly: p.changesOnly, q: p.q })}
          </div>
        )}

        {p.sections.map(({ rack, rows, total }) => {
          const isCollapsed = p.collapsed[rack.id];
          return (
            <div
              key={rack.id}
              ref={(el) => {
                if (el) cardRefs.current.set(rack.id, el);
                else cardRefs.current.delete(rack.id);
              }}
              className={cn(CARD, "@container mb-3 overflow-hidden")}
            >
              <button
                type="button"
                aria-expanded={!isCollapsed}
                onClick={() => p.onToggleRack(rack.id)}
                className={cn("flex w-full items-center gap-2 px-3.5 py-2.5 text-left", !isCollapsed && "border-b border-line")}
              >
                <ChevronRightIcon className={cn("size-4 shrink-0 text-fg-subtle transition-transform", !isCollapsed && "rotate-90")} />
                {rack.color && <span className="size-2.5 shrink-0 rounded-full" style={{ background: rack.color }} />}
                <b className="text-subheadline font-semibold">{rack.name}</b>
                <span className="font-mono text-caption1 text-fg-subtle">{rows.length === total ? rows.length : `${rows.length} of ${total}`}</span>
              </button>
              {!isCollapsed && (
                <div className="overflow-x-auto">
                  <table aria-label={`${rack.name} ${isIn ? "inputs" : "outputs"}`} className="w-full border-collapse text-footnote">
                    <thead>
                      <tr>
                        <th className={TH}>Ch</th>
                        <th className={TH}>Console</th>
                        <th className={TH}>{isIn ? "Source" : "Destination"}</th>
                        <th className={TH}>{isIn ? "Mic" : "Feed"}</th>
                        {isIn && <th className={TH}>48V</th>}
                        <th className={TH}>Signal path</th>
                        <th className={TH}><span className="sr-only">Note</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {withOwnerHeadings(rows).map(({ e, heading }) => {
                        const key = endpointKey(e);
                        const changed = resolved.changed.has(key);
                        const edge = sourceColor(e, sheet.devices) ?? (changed ? "var(--su-warn-9)" : undefined);
                        // An unused channel the standard patch already had unused is not a change,
                        // so its note is said plainly rather than in the colour of one.
                        const note = changed ? (noteByKey.get(key) ?? "") : e.unused ? UNUSED_NOTE : "";
                        return (
                          <Fragment key={key}>
                            {heading && (
                              <tr>
                                <td colSpan={cols} className="h-6 border-b border-line bg-fill/60 px-2.5 text-caption2 font-semibold uppercase tracking-wider text-fg-subtle">
                                  Owned by {heading}
                                </td>
                              </tr>
                            )}
                            <tr
                              data-changed={changed || undefined}
                              data-unused={e.unused || undefined}
                              className={cn("[&:last-child>td]:border-b-0", changed && "bg-warn-9/12", e.unused && "text-fg-subtle")}
                            >
                              <td
                                className={cn(TD, "w-11 font-mono text-caption1 text-fg-muted")}
                                style={edge ? { boxShadow: `inset 3px 0 0 ${edge}` } : undefined}
                              >
                                {e.index}
                              </td>
                              <td className={cn(TD, "w-11 font-mono text-caption1 text-fg-muted")}>{e.consoleChannel ?? ""}</td>
                              <td className={cn(TD, "font-semibold", e.unused && "line-through")}>{e.label || "—"}</td>
                              <td className={cn(TD, "text-fg-muted")}>{isIn ? e.mic : e.feedType}</td>
                              {isIn && (
                                <td className={TD}>
                                  {e.phantom && <span className="rounded border border-accent/40 px-1 font-mono text-caption2 text-accent">48V</span>}
                                </td>
                              )}
                              <td className={TD}>
                                <PatchChain compact dropConsoleInNarrowCard nodes={chainNodes(e, sheet.devices)} />
                              </td>
                              <td className={cn(TD, "text-caption2 font-medium", changed ? "text-warn-11" : "text-fg-subtle")}>{note}</td>
                            </tr>
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}
      </section>
    </div>
  );
}
