// slug.ts — the one rule that turns a name into a URL slug.
//
// Lowercase, every run of anything but a-z and 0-9 one hyphen, none at either end.
// ServiceCue layouts and service types (servicecue-slug.ts) and Q-SYS panels
// (qsys.ts) each wrap it with their own fallback and limits; the core is here once.

/** `name` as lowercase a-z, 0-9 and single hyphens; "" when nothing is left. */
export function slugCore(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
