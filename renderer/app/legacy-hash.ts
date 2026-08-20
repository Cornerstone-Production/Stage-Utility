// Where the old settings panel's `#hash` deep links now point.
//
// `/settings#integrations` addressed a tab in a single-document panel. Those
// links are in operators' bookmarks and in the Connect tab's copy-to-clipboard
// list, so they resolve to the new route rather than landing on a blank page.
//
// Every id the old SECTIONS list carried appears here. A missing one is a dead
// bookmark, which is why legacy-hash.test.ts asserts the set rather than
// spot-checking it.

/** Section ids the old settings panel accepted in its URL hash. */
export const LEGACY_SECTION_IDS = [
  "plan",
  "views",
  "scriptview",
  "displays",
  "integrations",
  "patch",
  "connect",
  "branding",
  "service-history",
  "baptisms",
  "automation",
  "advanced",
] as const;

const ROUTES: Record<(typeof LEGACY_SECTION_IDS)[number], string> = {
  // Plan folded into Home in Phase 2; the tab's content is the front page now.
  plan: "/",
  // Views and Displays merged into Screens in Phase 2.
  views: "/screens",
  scriptview: "/scriptview",
  displays: "/screens",
  patch: "/patch",
  automation: "/automation",
  // History and Baptisms were tabs whose standalone twins are the real pages now.
  "service-history": "/history",
  baptisms: "/baptism",
  // Configuration lives under /settings.
  integrations: "/settings/integrations",
  // The Connect tab is gone: its QR toggle moved to Branding, its Companion
  // panel to Integrations, and the rest was links the rail already carries.
  // An old #connect bookmark lands on Integrations — Companion is the thing
  // people were most often going there for, and it is still a "connect this to
  // that" page. Kept rather than dropped: the entry IS the promise that an old
  // bookmark still works.
  connect: "/settings/integrations",
  branding: "/settings/branding",
  advanced: "/settings/advanced",
};

/**
 * The route a legacy hash should land on, or null when it is not one of ours.
 *
 * Returning null rather than a default matters: a hash we do not recognise
 * belongs to something else on the page (an anchor, another tool's state), and
 * silently redirecting it would hijack it.
 */
export function legacyHashRoute(hash: string): string | null {
  const id = hash.replace(/^#/, "");
  return (ROUTES as Record<string, string | undefined>)[id] ?? null;
}

/** Where bare `/settings` lands. */
export const SETTINGS_INDEX_ROUTE = "/settings/integrations";
