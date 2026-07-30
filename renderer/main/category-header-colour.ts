// Column header colours for a ScriptView rundown.
//
// Layouts differ by which note columns they show — the Audio layout carries Audio /
// Band / MD, another carries fourteen. When every header is the same grey, telling
// which column is which means reading each one. A colour per column makes it a glance.
//
// Deliberately NOT configurable. PCO has no colour for a note category
// (item_note_categories carries only name / sequence / frequently_used), so any
// configurable colour would be invented here — one more thing to set up that says
// nothing about the plan.
//
// Colours are spread EVENLY across the columns a layout actually shows, rather than
// hashed from the name. Hashing was tried first and cannot guarantee what matters:
// with fourteen columns in a ~290-degree space, collisions are a birthday problem, and
// two columns sharing a colour inside one layout defeats the whole point. Even spacing
// guarantees maximum separation in every layout, at the cost of a category not keeping
// the same colour across layouts that show different column sets.
//
// Header text only. Rows are coloured solely by PCO's item row colours, so a plan still
// reads the way PCO shows it.

/** Fixed so every header reads at the same weight on a dark surface. */
const SAT = 62;
const LIGHT = 72;

// Purple is off-limits (project rule), and the gap has to be generous at BOTH ends:
// 249 is indigo and 320 is violet, so a narrow "purple only" gap still produced
// purple-reading headers. 230-330 removed leaves blue at one edge and rose at the other.
const GAP_START = 230;
const GAP_SIZE = 100;
const USABLE = 360 - GAP_SIZE;

/** Columns the app owns rather than PCO note categories. Structural, so they keep the
 *  default header colour instead of taking a hue. */
const STRUCTURAL = new Set(["clock", "time", "item", "title", "len"]);

export function isStructuralColumn(key: string): boolean {
  return STRUCTURAL.has(key.trim().toLowerCase());
}

/**
 * A colour for each note column in a layout, keyed by column key.
 *
 * `columnKeys` must be the layout's columns in render order; the note columns among
 * them are spread evenly around the usable hue circle, so a fourteen-column layout
 * gets fourteen well-separated colours and a three-column layout gets three very
 * distinct ones.
 */
export function headerColoursFor(columnKeys: string[]): Record<string, string> {
  const noteKeys = columnKeys.filter((k) => !isStructuralColumn(k));
  const out: Record<string, string> = {};
  const n = noteKeys.length;
  if (n === 0) return out;
  noteKeys.forEach((key, i) => {
    let hue = Math.round((i * USABLE) / n);
    if (hue >= GAP_START) hue += GAP_SIZE;
    out[key] = hslToHex(hue, SAT, LIGHT);
  });
  return out;
}

/** hsl -> "#rrggbb", so callers only ever deal in hex. */
function hslToHex(hDeg: number, sPct: number, lPct: number): string {
  const s = sPct / 100;
  const l = lPct / 100;
  const k = (n: number) => (n + hDeg / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to = (x: number) => Math.round(x * 255).toString(16).padStart(2, "0");
  return `#${to(f(0))}${to(f(8))}${to(f(4))}`;
}
