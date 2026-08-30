// The one answer to "what page is this".
//
// Three copies of that question lived in the shell. PageHeader matched
// `d.path === pathname` EXACTLY, Shell matched by longest prefix, and the rail
// matched by longest prefix over a different candidate list. All three read the
// static route table only, so a route built from the operator's own data matched
// none of them: a console is `/consoles/<id>`, one per console View, and on a
// console the desktop header rendered nothing while the mobile top bar was a
// hamburger and an empty row.
//
// So one list and one matcher, with the exact-versus-prefix distinction kept —
// it is a real distinction, not the accident it looked like:
//
//   prefix  "which section am I in"  — rail highlight, mobile top bar
//   exact   "does the shell own this page's heading" — desktop PageHeader
//
// A child route renders its own heading (the layout editor puts the view's name
// in an editable field, a ScriptView plan draws ScriptViewHeader), so the shell
// adding the section's name above it would be a second, wronger title.

import { screensListViews } from "@main/services/home-view";
import { viewSurface, type View } from "@main/types/views";
import { ALL_DESTINATIONS, NESTED_ROUTES } from "./destinations";

/** What the chrome needs to know about a page. A Destination minus its icon and
 *  its component, so a page that has no rail entry can still have a name. */
export interface PageIdentity {
  path: string;
  label: string;
  /** Subtitle under the desktop title. Empty where the page wants the height. */
  description: string;
}

export interface ActivePage {
  page: PageIdentity;
  /** True when the URL IS this page rather than a child route of it. */
  exact: boolean;
}

/**
 * The Views that are consoles, in rail order.
 *
 * Home is filtered out by the same helper the Screens page uses. It is a console
 * view, so it qualified — the rail once carried TWO Home entries — and
 * `/consoles/home` redirects to `/`.
 */
export function consoleViewList(views: readonly View[] | undefined): View[] {
  return screensListViews(views ?? []).filter((v) => viewSurface(v) === "console");
}

/**
 * One console View as a page.
 *
 * Derived from state rather than a fixed table because consoles are created by
 * the operator — this is the one part of the route space that is theirs, and the
 * reason neither of the shell's matchers could name the page you were on.
 */
export function consolePageFor(view: View): PageIdentity {
  return {
    path: `/consoles/${view.id}`,
    label: view.name,
    // No subtitle. A console is full-bleed and wants every pixel of height it
    // can get; a line of boilerplate under its name buys nothing.
    description: "",
  };
}

/** Every console View as a page. */
export function consolePages(views: readonly View[] | undefined): PageIdentity[] {
  return consoleViewList(views).map(consolePageFor);
}

/** Nested routes that the shell titles. The rest fall back to their parent
 *  destination's name, because they draw their own heading. */
const TITLED_NESTED: readonly PageIdentity[] = NESTED_ROUTES.flatMap((r) =>
  r.label ? [{ path: r.path, label: r.label, description: r.description ?? "" }] : [],
);

/**
 * The active page for a pathname, or null if nothing claims it.
 *
 * `consoles` is passed in rather than read from state here so this stays a plain
 * function: the guard walks the real route table through it, and the hook in the
 * shell is the only thing that needs React.
 */
export function resolvePage(
  pathname: string,
  consoles: readonly PageIdentity[] = [],
): ActivePage | null {
  const page = [
    ...ALL_DESTINATIONS.map((d) => ({
      path: d.path,
      label: d.label,
      description: d.description,
    })),
    ...TITLED_NESTED,
    ...consoles,
  ]
    // Longest match first: /settings/branding must beat /settings, and
    // /history/manage must beat /history.
    .sort((a, b) => b.path.length - a.path.length)
    // "/" prefix-matches nothing: `${"/"}/` is "//", which no pathname starts
    // with. So an unrouted URL falls through to null rather than claiming Home.
    .find((p) => pathname === p.path || pathname.startsWith(`${p.path}/`));

  return page ? { page, exact: pathname === page.path } : null;
}
