/** Neutral used when a category has no colour and matches no keyword. */
export const DEFAULT_CATEGORY_COLOUR = "#8b8d98";

/** One key per category name, regardless of casing or padding — note categories come
 *  from PCO per service type, so "Audio" under Weekend and "audio " under Youth must
 *  resolve to the same colour. */
export function normaliseCategory(name: string): string {
  return name.trim().toLowerCase();
}

/** The keyword guess that used to BE the colour. It survives only as the suggested
 *  fallback, so boards look identical until someone picks something. */
function suggestion(name: string): string {
  const d = normaliseCategory(name);
  if (d.includes("light")) return "#ffb224";
  if (d.includes("video") || d.includes("graphic") || d.includes("pro") || d.includes("screen")) return "#46a758";
  if (d.includes("audio") || d.includes("sound") || d.includes("foh")) return "#0091ff";
  if (d.includes("vocal") || d.includes("band") || d.includes("music") || d.includes("md") || d.includes("key") || d.includes("drum")) return "#12a594";
  if (d.includes("stage") || d.includes("cam") || d.includes("director")) return "#e5484d";
  return DEFAULT_CATEGORY_COLOUR;
}

/** The colour for a note category: the operator's choice, else the keyword suggestion. */
export function categoryColour(name: string, map: Record<string, string> | undefined): string {
  const chosen = map?.[normaliseCategory(name)];
  return chosen || suggestion(name);
}

/** The value a colour picker should open on for a category with no colour yet. */
export function suggestedCategoryColour(name: string): string {
  return suggestion(name);
}
