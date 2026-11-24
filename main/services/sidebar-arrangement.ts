// The sidebar's arrangement: which section each page sits in, in what order, and
// which pages are hidden.
//
// ONE MODULE FOR BOTH SIDES. The server validates a save and a restore with
// `validateSidebarArrangement`, and the renderer draws the rail from
// `resolveSidebar`. A second copy of either is how a save the server accepts
// draws a different sidebar from the one the operator arranged.
//
// WHAT IS STORED IS THE OPERATOR'S CHANGE, NOT THE WHOLE LIST. Pages are defined
// in code and consoles come from the operator's views, so a page missing from the
// saved arrangement is not "removed": it lands in its default section. That is
// what lets a page added in a later release appear on an install that has
// already customized its sidebar, and why an empty arrangement means the default
// and an upgrade moves nobody's sidebar.
//
// IDS ARE NOT PATHS. A page is its destination's stable `id` (`patch`,
// `advanced`), a console is `console:<viewId>`. Routes get renamed (Stage plots
// is moving under /stageplots/manage), and an arrangement keyed by path would
// lose that page's place on the release that moved it. Whether an id is a
// console is read from its SHAPE, never from the live views, because the same
// validation refuses a restore and must give the same answer whatever views the
// server holds at that moment.
//
// Hiding a console is NOT in this file. A console's place in the sidebar is the
// view's own `showInSidebar` switch (Screens has it too), and a second copy here
// would disagree with it. `hidden` holds pages only.

import { screensListViews } from "./home-view.js";
import { refuse } from "./restore-check.js";
import { viewShownInSidebar, viewSurface, type View } from "../types/views.js";
import { isQsysPanel } from "../types/qsys.js";
import { isRecord } from "./is-record.js";

export type SidebarSectionKind = "top" | "consoles" | "pages";

export interface SidebarSection {
  /** Stable id. The default sections' ids are below; a new section gets its own. */
  id: string;
  /** The heading. Empty for the top group, which has none. */
  label: string;
  kind: SidebarSectionKind;
  /** Page ids (a destination's `id`) or console ids (`console:<viewId>`), in order. */
  members: string[];
}

/** What is saved. Empty `sections` means the default arrangement. */
export interface SidebarArrangement {
  sections: SidebarSection[];
  /** Page ids taken out of the sidebar. Never a console and never Advanced. */
  hidden: string[];
}

export const EMPTY_SIDEBAR: SidebarArrangement = { sections: [], hidden: [] };

/** The page that can move but never hide: it carries the update and
 *  duplicate-server warnings, and it is a way back into this editor. */
export const LOCKED_PAGE = "advanced";

export const CONSOLE_PREFIX = "console:";

/**
 * The sidebar as the code ships it. Every page in the app is in exactly one of
 * these; routes.test.tsx holds the list to the rail's destinations, both ways.
 *
 * Each section answers one question: what is shown, where it shows, what it
 * talks to, a service you ran, and set-up-once configuration.
 */
export const DEFAULT_SIDEBAR: readonly SidebarSection[] = [
  // Home sits above the headings: it is the front door, not a member of a category.
  { id: "top", label: "", kind: "top", members: ["home"] },
  // Filled from the operator's console views.
  { id: "consoles", label: "Consoles", kind: "consoles", members: [] },
  // Patch is here because volunteers READ it at /patch.
  { id: "content", label: "Content", kind: "pages", members: ["servicecue", "patch", "stageplots"] },
  { id: "screens", label: "Screens", kind: "pages", members: ["screens", "mic-slots", "video-feeds"] },
  // Automation rules act ON integrations.
  { id: "devices", label: "Devices", kind: "pages", members: ["automation", "qsys"] },
  { id: "services", label: "Services", kind: "pages", members: ["plan", "history", "baptisms"] },
  {
    id: "settings",
    label: "Settings",
    kind: "pages",
    members: ["integrations", "messages", "branding", "advanced"],
  },
];

/** Every page id the sidebar knows, in default order. */
export const SIDEBAR_PAGE_IDS: readonly string[] = DEFAULT_SIDEBAR.flatMap((s) => s.members);

/** Where each page lives by default. A Map: ids arrive in requests. */
const DEFAULT_HOME = new Map<string, string>(
  DEFAULT_SIDEBAR.flatMap((s) => s.members.map((m) => [m, s.id] as const)),
);

/** The section a page belongs to when nothing says otherwise. */
export function defaultSectionOf(pageId: string): string | null {
  return DEFAULT_HOME.get(pageId) ?? null;
}

/** Is this id a console's, by its shape? */
export function isConsoleId(id: string): boolean {
  return id.startsWith(CONSOLE_PREFIX) && id.length > CONSOLE_PREFIX.length;
}

/** A console view's id in the sidebar. */
export function consoleMemberId(viewId: string): string {
  return `${CONSOLE_PREFIX}${viewId}`;
}

/** The view id inside a console's sidebar id. */
export function consoleViewId(id: string): string {
  return id.slice(CONSOLE_PREFIX.length);
}

/** Can `id` sit in a section of this kind? Consoles hold consoles, and only they do. */
export function canPlace(id: string, section: Pick<SidebarSection, "kind">): boolean {
  return isConsoleId(id) === (section.kind === "consoles");
}

/** A copy whose sections and member lists can be changed without touching `s`. */
export function cloneSections(s: readonly SidebarSection[]): SidebarSection[] {
  return s.map((x) => ({ ...x, members: [...x.members] }));
}

/**
 * Every View that is a console, in the order the operator's views are in. Home is
 * filtered out: it is a console view, and `/consoles/home` redirects to `/`.
 */
export function consoleViews<V extends Pick<View, "id" | "surface">>(views: readonly V[] | undefined): V[] {
  return screensListViews(views ?? []).filter((v) => viewSurface(v) === "console");
}

/** What the resolver needs to know about consoles, from the operator's views. */
export interface SidebarConsoles {
  /** Every console's sidebar id, in view order. */
  all: string[];
  /** Those whose "Show in the sidebar" is off. */
  hidden: ReadonlySet<string>;
  /**
   * Consoles that are Q-SYS panels, listed under Q-SYS rather than here. Where the
   * saved arrangement places one is kept, not drawn and not dropped, so making it
   * an ordinary console again puts it back where the operator had it.
   */
  held?: ReadonlySet<string>;
}

/**
 * The consoles the sidebar may list: every console but a Q-SYS panel, which is
 * listed under Q-SYS instead. Only the sidebar narrows the list; a panel is still
 * a console everywhere else.
 */
export function sidebarConsoleViews<V extends Pick<View, "id" | "surface" | "qsys">>(views: readonly V[] | undefined): V[] {
  return consoleViews(views).filter((v) => !isQsysPanel(v));
}

export function sidebarConsolesOf(views: readonly View[] | undefined): SidebarConsoles {
  const list = sidebarConsoleViews(views);
  return {
    all: list.map((v) => consoleMemberId(v.id)),
    hidden: new Set(list.filter((v) => !viewShownInSidebar(v)).map((v) => consoleMemberId(v.id))),
    held: new Set(consoleViews(views).filter(isQsysPanel).map((v) => consoleMemberId(v.id))),
  };
}

/**
 * `next` with each held console (a Q-SYS panel) put back where `prev` placed it:
 * the arrangement a page saves draws no panel, so without this a save would forget
 * a panel's place. Into the section of the same id, after the member it followed
 * there (or first); a section the save removed takes its panels with it.
 */
export function keepHeldPlacements(prev: SidebarArrangement | null | undefined, next: SidebarArrangement, consoles: SidebarConsoles): SidebarArrangement {
  const held = consoles.held;
  if (!held || held.size === 0 || !prev || next.sections.length === 0) return next;
  const present = new Set(next.sections.flatMap((x) => x.members));
  const sections = cloneSections(next.sections);
  for (const was of prev.sections) {
    const into = sections.find((x) => x.id === was.id);
    if (!into) continue;
    was.members.forEach((id, i) => {
      if (!held.has(id) || present.has(id)) return;
      const after = was.members.slice(0, i).reverse().find((m) => into.members.includes(m));
      into.members.splice(after === undefined ? 0 : into.members.indexOf(after) + 1, 0, id);
      present.add(id);
    });
  }
  return { ...next, sections };
}

/** The arrangement drawn: every known page and console placed once. */
export interface ResolvedSidebar {
  sections: SidebarSection[];
  /** Pages in the tray, in default order. */
  hiddenPages: string[];
  /** Consoles in the tray, in view order. */
  hiddenConsoles: string[];
  /** Ids the saved arrangement names that the app no longer has. */
  dropped: string[];
}

/** Where a page goes when its default section is gone: the last section of
 *  pages, else the top group. */
export function fallbackSection(sections: readonly SidebarSection[]): SidebarSection {
  for (let i = sections.length - 1; i >= 0; i--) if (sections[i].kind === "pages") return sections[i];
  return sections.find((s) => s.kind === "top") ?? sections[0];
}

/** The section a page belongs in among `sections`: its default one if it is still
 *  there, else the fallback. A page whose default is the top group goes there. */
export function homeSectionIn(sections: readonly SidebarSection[], pageId: string): SidebarSection {
  const home = defaultSectionOf(pageId);
  if (home === "top") return sections.find((s) => s.kind === "top") ?? sections[0];
  return sections.find((s) => s.id === home && s.kind === "pages") ?? fallbackSection(sections);
}

/**
 * The sidebar to draw, from what was saved and what exists.
 *
 * - A page in no section and not hidden goes to its default section, at the end,
 *   or to the fallback above when the operator removed that section.
 * - A console in no section goes to the end of Consoles.
 * - An id that is not a page or a console any more is dropped, and returned in
 *   `dropped` for the caller to log.
 * - A page placed twice keeps its first place. Validation refuses that; this
 *   copes with it, because a file can be edited by hand.
 *
 * `pages` is every page id the app has; it is a parameter so a test can add a
 * page this release does not have.
 */
export function resolveSidebar(
  saved: SidebarArrangement | null | undefined,
  consoles: SidebarConsoles,
  pages: readonly string[] = SIDEBAR_PAGE_IDS,
): ResolvedSidebar {
  const knownPages = new Set(pages);
  const knownConsoles = new Set(consoles.all);
  const dropped: string[] = [];
  const placed = new Set<string>();

  // Hidden first: with nothing else saved, the default sections are the source,
  // and they list every page.
  const hiddenSet = new Set<string>();
  for (const id of saved?.hidden ?? []) {
    if (!knownPages.has(id)) {
      if (!isConsoleId(id)) dropped.push(id);
      continue;
    }
    if (id !== LOCKED_PAGE) hiddenSet.add(id);
  }

  const savedSections = saved?.sections ?? [];
  const source = savedSections.length > 0 ? savedSections : DEFAULT_SIDEBAR;

  const sections: SidebarSection[] = [];
  let top: SidebarSection | null = null;
  let consolesSection: SidebarSection | null = null;
  for (const s of source) {
    // One top group and one Consoles. A second of either is not drawn; its
    // members fall to where they belong.
    if (s.kind === "top" && top) continue;
    if (s.kind === "consoles" && consolesSection) continue;
    const members: string[] = [];
    for (const id of s.members) {
      if (placed.has(id) || hiddenSet.has(id)) continue;
      const consoleId = isConsoleId(id);
      // A Q-SYS panel's place is kept for when it is an ordinary console again.
      if (consoleId && consoles.held?.has(id)) continue;
      if (consoleId ? !knownConsoles.has(id) : !knownPages.has(id)) {
        dropped.push(id);
        continue;
      }
      if (!canPlace(id, s)) continue;
      if (consoleId && consoles.hidden.has(id)) continue;
      placed.add(id);
      members.push(id);
    }
    const section = { id: s.id, label: s.kind === "top" ? "" : s.label, kind: s.kind, members };
    if (s.kind === "top") top = section;
    if (s.kind === "consoles") consolesSection = section;
    sections.push(section);
  }
  if (!consolesSection) {
    consolesSection = { id: "consoles", label: "Consoles", kind: "consoles", members: [] };
    sections.unshift(consolesSection);
  }
  if (!top) {
    top = { id: "top", label: "", kind: "top", members: [] };
    sections.unshift(top);
  }

  for (const id of pages) {
    if (placed.has(id) || hiddenSet.has(id)) continue;
    homeSectionIn(sections, id).members.push(id);
    placed.add(id);
  }
  for (const id of consoles.all) {
    if (placed.has(id) || consoles.hidden.has(id)) continue;
    consolesSection.members.push(id);
    placed.add(id);
  }

  return {
    sections,
    hiddenPages: pages.filter((id) => hiddenSet.has(id)),
    hiddenConsoles: consoles.all.filter((id) => consoles.hidden.has(id)),
    dropped,
  };
}

/**
 * What to save for a drawn arrangement: nothing at all when it is the default,
 * so an install that customized and then restored the default follows the code's
 * default again, including a regrouping a later release makes.
 */
export function toSavedSidebar(resolved: ResolvedSidebar, consoles: SidebarConsoles): SidebarArrangement {
  const sections = cloneSections(resolved.sections);
  const hidden = [...resolved.hiddenPages];
  const def = resolveSidebar(EMPTY_SIDEBAR, consoles);
  if (hidden.length === 0 && JSON.stringify(def.sections) === JSON.stringify(sections)) return { ...EMPTY_SIDEBAR };
  return { sections, hidden };
}

// ── Validation ───────────────────────────────────────────────────────────────

/** Longest heading. A sidebar is ~230 px wide; past this a heading is a sentence. */
export const MAX_SECTION_LABEL = 40;
const MAX_SECTIONS = 40;
const MAX_MEMBERS = 500;
const MAX_ID = 200;
const SECTION_ID = /^[A-Za-z0-9_-]{1,40}$/;
const KINDS = new Set<string>(["top", "consoles", "pages"]);
/** A page's id: lower-case words joined by hyphens. */
const PAGE_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/**
 * Characters a heading may not hold: control characters (a newline among them)
 * and the bidirectional overrides and isolates, which can make a heading read
 * as something other than what it holds.
 */
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

/**
 * A saved arrangement, checked and tidied, or a refusal saying what is wrong.
 *
 * Used by the save route and by a config restore alike, so it never reads live
 * state: a restore checks sidebar-config.json alone, before the views.json it
 * arrives with is written. A console id is therefore taken on its prefix, with
 * any view id after it, so a real but unusual view id cannot make every save
 * fail. The route then holds console ids to the views that exist
 * (`keepKnownConsoles`), and an id that is not a page is dropped when drawn.
 */
export function validateSidebarArrangement(raw: unknown): SidebarArrangement {
  if (!isRecord(raw)) refuse("the sidebar must be an object");
  const rawSections = raw.sections ?? [];
  const rawHidden = raw.hidden ?? [];
  if (!Array.isArray(rawSections)) refuse("the sidebar's sections must be a list");
  if (!Array.isArray(rawHidden)) refuse("the sidebar's hidden pages must be a list");
  if (rawSections.length > MAX_SECTIONS) refuse(`the sidebar can have at most ${MAX_SECTIONS} sections`);

  const seenSections = new Set<string>();
  const seenMembers = new Set<string>();
  let total = 0;
  const memberId = (v: unknown, what: string): string => {
    if (typeof v !== "string" || v.length > MAX_ID || UNSAFE_TEXT.test(v) || !(PAGE_ID.test(v) || isConsoleId(v))) {
      refuse(`${what} must be a page id or console:<view id>`);
    }
    if (seenMembers.has(v)) refuse(`the sidebar lists "${v.slice(0, 60)}" more than once`);
    seenMembers.add(v);
    if (++total > MAX_MEMBERS) refuse(`the sidebar can list at most ${MAX_MEMBERS} pages and consoles`);
    return v;
  };

  let tops = 0;
  let consoleSections = 0;
  const sections: SidebarSection[] = rawSections.map((entry: unknown, i: number) => {
    const what = `sidebar section ${i + 1}`;
    if (!isRecord(entry)) refuse(`${what} must be an object`);
    const { id, kind, label, members } = entry;
    if (typeof id !== "string" || !SECTION_ID.test(id)) {
      refuse(`${what}'s id must be 1-40 letters, digits, "-" or "_"`);
    }
    if (seenSections.has(id)) refuse(`the sidebar has two sections with the id "${id}"`);
    seenSections.add(id);
    if (typeof kind !== "string" || !KINDS.has(kind)) {
      refuse(`${what} has an unknown kind ("${String(kind).slice(0, 30)}"): it must be top, consoles or pages`);
    }
    const k = kind as SidebarSectionKind;
    if (k === "top") tops++;
    if (k === "consoles") consoleSections++;
    let text = "";
    if (k !== "top") {
      if (typeof label !== "string" || !label.trim()) refuse(`${what} needs a name`);
      text = label.trim();
      if (UNSAFE_TEXT.test(text)) refuse(`${what}'s name holds a control or text-direction character`);
      if (text.length > MAX_SECTION_LABEL) {
        refuse(`the section name "${text.slice(0, 20)}…" is longer than ${MAX_SECTION_LABEL} characters`);
      }
    }
    if (!Array.isArray(members)) refuse(`${what}'s pages must be a list`);
    const list = members.map((m: unknown) => memberId(m, `a page in ${what}`));
    for (const m of list) {
      if (canPlace(m, { kind: k })) continue;
      refuse(
        k === "consoles"
          ? `Consoles holds consoles only: "${m.slice(0, 60)}" is a page`
          : `a console stays in Consoles: "${m.slice(0, 60)}" is in ${text ? `"${text}"` : "the top group"}`,
      );
    }
    return { id, label: text, kind: k, members: list };
  });
  if (tops > 1) refuse("the sidebar can have only one top group");
  if (consoleSections > 1) refuse("the sidebar can have only one Consoles section");
  if (sections.length > 0 && (tops === 0 || consoleSections === 0)) {
    refuse("the sidebar must keep its top group and its Consoles section");
  }
  if (sections.length > 0 && sections[0].kind !== "top") refuse("the top group must come first, above every heading");

  const hidden = rawHidden.map((m: unknown) => {
    const id = memberId(m, "a hidden page");
    if (id === LOCKED_PAGE) refuse("Advanced can't be hidden: it carries the update and server warnings");
    if (isConsoleId(id)) refuse("a console is hidden with its own Show in the sidebar switch, not in this list");
    return id;
  });
  return { sections, hidden };
}

/**
 * Consoles left out of an arrangement the route is about to save: those that are
 * not a console view on this server. Returns the arrangement without them and
 * the ids it dropped.
 */
export function keepKnownConsoles(
  arrangement: SidebarArrangement,
  consoles: SidebarConsoles,
): { arrangement: SidebarArrangement; dropped: string[] } {
  const known = new Set([...consoles.all, ...(consoles.held ?? [])]);
  const dropped: string[] = [];
  const sections = arrangement.sections.map((s) => ({
    ...s,
    members: s.members.filter((m) => {
      if (!isConsoleId(m) || known.has(m)) return true;
      dropped.push(m);
      return false;
    }),
  }));
  return { arrangement: { sections, hidden: arrangement.hidden }, dropped };
}

/**
 * What can be drawn from a saved file that breaks the save rules: its sections
 * that have the right shape, and its hidden ids, for the resolver to place. The
 * resolver already copes with a page in the wrong place or listed twice; this
 * keeps a file edited by hand, or written by a build with other rules, in use
 * rather than replaced by the default.
 */
export function readSidebarLeniently(raw: unknown): SidebarArrangement {
  if (!isRecord(raw)) return { ...EMPTY_SIDEBAR };
  const text = (v: unknown): v is string => typeof v === "string";
  const sections = (Array.isArray(raw.sections) ? raw.sections : []).flatMap((s: unknown): SidebarSection[] => {
    if (!isRecord(s) || !text(s.id) || !text(s.kind) || !KINDS.has(s.kind) || !Array.isArray(s.members)) return [];
    const label = text(s.label) ? s.label.replace(new RegExp(UNSAFE_TEXT.source, "g"), "").trim().slice(0, MAX_SECTION_LABEL) : "";
    return [{ id: s.id, label, kind: s.kind as SidebarSectionKind, members: s.members.filter(text) }];
  });
  const hidden = (Array.isArray(raw.hidden) ? raw.hidden : []).filter(text);
  return { sections, hidden };
}
