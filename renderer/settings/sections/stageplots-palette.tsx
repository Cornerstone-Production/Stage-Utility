// stageplots-palette.tsx — what can be added to a plot: shapes, text and the
// nine symbols. A press adds the item at the middle of what the canvas shows,
// each one a little further down and right of the last so they do not stack.

import { SYMBOL_KINDS } from "@main/types/stageplots";

import { eyebrow } from "../../main/stageplots/doc-helpers";
import type { AddKind } from "../../main/stageplots/editor-state";
import { Part, SYMBOLS, TYPE_NAMES, iconDrawing, type IconKey } from "../../main/stageplots/symbols";
import { cn } from "../../lib/cn";

/** The palette, as the mockup groups it. Symbols in their drawing order. */
export const PALETTE: { group: string; entries: { kind: AddKind; name: string }[] }[] = [
  {
    group: "Shapes",
    entries: (["box", "circle", "zone", "cable", "conn"] as const).map((kind) => ({ kind, name: TYPE_NAMES[kind] })),
  },
  {
    group: "Text",
    entries: (["label", "callout", "dimension"] as const).map((kind) => ({ kind, name: TYPE_NAMES[kind] })),
  },
  {
    group: "Symbols",
    entries: (Object.keys(SYMBOLS) as (typeof SYMBOL_KINDS)[number][]).map((k) => ({ kind: `sym:${k}` as const, name: SYMBOLS[k].name })),
  },
];

/** Lucide's line: 2 units of a 24-unit icon. */
const LINE_PER_UNIT = 2 / 24;

/** A palette icon, drawn in the current colour, its line as wide as a Lucide
 *  icon's at the same size, so it matches the app's other icons. */
export function ItemIcon({ kind, className }: { kind: IconKey | `sym:${(typeof SYMBOL_KINDS)[number]}`; className?: string }) {
  const { box, parts } = iconDrawing(kind);
  return (
    <svg
      viewBox={`0 0 ${box[0]} ${box[1]}`}
      aria-hidden
      className={cn("size-4 flex-none text-fg-muted", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={Math.max(...box) * LINE_PER_UNIT}
      strokeLinejoin="round"
      strokeLinecap="round"
    >
      {parts.map((p, i) => (
        <Part key={i} part={p} />
      ))}
    </svg>
  );
}

/** The palette's width with names, and as icons only. */
export const PALETTE_PX = 140;
export const PALETTE_ICONS_PX = 44;

/**
 * `icons` is the narrow form, for when the canvas would otherwise be under 600
 * px wide: icons only, each named by its tooltip and its accessible name.
 */
export function StagePlotsPalette({ onAdd, icons = false }: { onAdd: (kind: AddKind) => void; icons?: boolean }) {
  return (
    <nav aria-label="Add to the plot" className={cn("su-card flex flex-col gap-px p-1.5", icons && "items-center")} data-testid="palette" data-icons={icons ? "" : undefined}>
      {PALETTE.map(({ group, entries }, gi) => (
        <div key={group} className={cn("flex flex-col gap-px", icons && gi > 0 && "mt-1.5 border-t border-line pt-1.5")}>
          {!icons && <span className={cn(eyebrow, "px-1.5 pb-[3px]", gi === 0 ? "pt-1" : "pt-2")}>{group}</span>}
          {entries.map((e) => (
            <button
              key={e.kind}
              type="button"
              title={icons ? e.name : `Add ${e.name}`}
              aria-label={icons ? `Add ${e.name}` : undefined}
              data-testid={`add-${e.kind.replace("sym:", "")}`}
              onClick={() => onAdd(e.kind)}
              className={cn(
                "flex items-center rounded-md text-left text-caption1 whitespace-nowrap text-fg-soft transition-colors hover:bg-fill hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus active:bg-accent-soft",
                icons ? "size-7 justify-center" : "h-[25px] gap-2 px-1.5",
              )}
            >
              <ItemIcon kind={e.kind} />
              {!icons && <span>{e.name}</span>}
            </button>
          ))}
        </div>
      ))}
    </nav>
  );
}
