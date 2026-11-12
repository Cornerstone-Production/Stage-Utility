// legend.ts — what a plot's legend lists, read from its items. One reading for
// the editor's legend panel, /stageplots, print and (later) the published page.
//
// Rows group items by label and colour, so two orange "Floor wedge" read as one
// row, "×2". An item with no label, and every text item, is left out of the
// rows: a callout's text is listed in the callout key instead, numbered in the
// order the callouts were added (the number drawn on the plot).

import type { ItemType, PlotItem, SymbolKind } from "@main/types/stageplots";

export interface LegendRow {
  label: string;
  color: string | null;
  /** The first item of the group, which the row's glyph draws. */
  type: ItemType;
  symbol?: SymbolKind;
  dashed?: boolean;
  count: number;
}

export function legendRows(items: readonly PlotItem[]): LegendRow[] {
  const rows = new Map<string, LegendRow>();
  for (const it of items) {
    if (it.type === "text" || !it.label) continue;
    const key = `${it.label}\u0000${it.color ?? ""}`;
    const row = rows.get(key);
    if (row) row.count++;
    else
      rows.set(key, {
        label: it.label,
        color: it.color,
        type: it.type,
        ...(it.symbol ? { symbol: it.symbol } : {}),
        ...(it.type === "cable" ? { dashed: it.dashed === true } : {}),
        count: 1,
      });
  }
  return [...rows.values()];
}

/** Each callout's number and text, in the order the callouts were added. */
export function calloutKey(items: readonly PlotItem[]): { n: number; text: string }[] {
  return items.filter(isCallout).map((it, i) => ({ n: i + 1, text: it.label }));
}

/** The number each callout carries on the plot, by item id. */
export function calloutNumbers(items: readonly PlotItem[]): Map<string, number> {
  return new Map(items.filter(isCallout).map((it, i) => [it.id, i + 1]));
}

/** Connection points with inputs, for the printed list of what plugs in where. */
export function connectionInputs(items: readonly PlotItem[]): { label: string; inputs: string[] }[] {
  return items.filter((it) => it.type === "conn" && it.inputs.length > 0).map((it) => ({ label: it.label, inputs: it.inputs }));
}

function isCallout(it: PlotItem): boolean {
  return it.type === "text" && it.textKind === "callout";
}
