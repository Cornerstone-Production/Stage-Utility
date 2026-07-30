// Color for a ScriptView note category, when a layout tints rows by category rather
// than by PCO's item colors.
//
// A fixed keyword table with no configuration. PCO has no color for a note category —
// `ItemNote` carries only category_name / content / created_at / updated_at, and
// `ItemNoteCategory` only name / sequence / frequently_used — so any category color is
// invented here either way. A default that needs no setup beats a picker that has to be
// filled in per category before the feature does anything.
//
// The unmatched case is the known weakness: a category named "Hospitality" gets neutral
// gray. Acceptable, because the categories that matter on a stage rundown — audio,
// lighting, video, band, stage — all match.

/** Used when a category name matches no keyword. */
export const NEUTRAL_CATEGORY_COLOUR = "#8b8d98";

/** Color for a note category. Matching is case-insensitive and by substring, so
 *  "MD + Playback Tech" and "FOH" both land. */
export function categoryColor(name: string): string {
  const d = name.trim().toLowerCase();
  if (d.includes("light")) return "#ffb224";
  if (d.includes("video") || d.includes("graphic") || d.includes("pro") || d.includes("screen")) return "#46a758";
  if (d.includes("audio") || d.includes("sound") || d.includes("foh")) return "#0091ff";
  if (d.includes("vocal") || d.includes("band") || d.includes("music") || d.includes("md") || d.includes("key") || d.includes("drum")) return "#12a594";
  if (d.includes("stage") || d.includes("cam") || d.includes("director")) return "#e5484d";
  return NEUTRAL_CATEGORY_COLOUR;
}
