// companion-export.ts — reading Companion's own configuration export.
//
// PURE: no I/O. `GET /int/export/full?format=json` on a Companion returns the
// whole config, and everything here turns that document into the two things this
// app needs from it — a list of pressable buttons, and the ON/OFF pairs among
// them. companion-api.ts does the fetching and the caching.
//
// Written against Companion 5.0.3's real export, which differs from the 3.x/4.x
// shape in three ways that each look like an empty result rather than an error:
//
//  - a button's text lives at `style.layers[].text.value` (a layer of
//    `type: "text"`), not at `style.text`. 3.x's flat string is still read, so an
//    older export is not silently label-less.
//  - an action names its connection as `connectionId`; 3.x called it `instance`.
//  - a connection declares its module as `moduleId`; 3.x called it
//    `instance_type`.
//
// Every one of those is read both ways. None of them can be told apart from
// "this button has no label" or "this button drives nothing" by looking at the
// output, which is exactly why they are read defensively here rather than
// assumed.

/** One pressable Companion button, at the coordinates the press API takes. */
export interface CompanionButton {
  page: number;
  /**
   * The page's own opaque id (`8h51ShTMsZ4ECnQhLlMg5`), which survives being
   * renumbered — `page` does not. "" for a document with no page ids at all.
   */
  pageId: string;
  pageName: string;
  row: number;
  col: number;
  /** The button's text with whitespace collapsed, as the picker shows it. */
  label: string;
  /** Module ids of the connections this button's actions drive ("generic-pjlink"). */
  drives: string[];
  /**
   * The ids of every action this button runs, sorted — the button's identity.
   *
   * A control in Companion has no id of its own; its ACTIONS do, and they travel
   * with the button when somebody drags it to another key. Empty for a button
   * that runs nothing, which is 59 of the 536 on the install this was built
   * against and cannot be identified by anything but its coordinates.
   */
  actionIds: string[];
}

/** Two buttons whose labels differ only by a trailing ON/OFF (or Startup/Shutdown). */
export interface CompanionPair {
  /** The shared label with the suffix removed ("Projectors"). */
  base: string;
  page: number;
  pageName: string;
  on: CompanionButton;
  off: CompanionButton;
}

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * Whitespace collapsed, INCLUDING the literal two-character `\n` Companion
 * stores for a line break.
 *
 * Not a nicety: a button reads `PVP:\nLyrics ON` in the export, with a real
 * backslash and a real `n`. Collapsing only real whitespace leaves that
 * backslash in the middle of the label, which then becomes part of a cue name
 * and part of the ON/OFF comparison — so the ON and OFF halves of a two-line
 * button still pair up, but under a name nobody could say out loud.
 */
export function collapse(text: string): string {
  return text.replace(/\\[rn]/g, " ").replace(/\s+/g, " ").trim();
}

/** The Companion build string from an export, or null. */
export function exportBuild(raw: unknown): string | null {
  const build = str(rec(raw).companionBuild).trim();
  return build || null;
}

/** Every text a button draws, joined — 5.x text layers first, 3.x flat style too. */
function labelOf(control: Record<string, unknown>): string {
  const style = rec(control.style);
  const parts: string[] = [];
  if (typeof style.text === "string") parts.push(style.text);
  for (const layer of arr(style.layers)) {
    const l = rec(layer);
    if (l.type !== "text") continue;
    const t = l.text;
    if (typeof t === "string") parts.push(t);
    else if (typeof rec(t).value === "string") parts.push(rec(t).value as string);
  }
  return collapse(parts.join(" "));
}

/**
 * Every action a control runs, in every step and every action set, INCLUDING the
 * ones nested inside a container action.
 *
 * The nesting is real and not rare: `logic_if` keeps its branches in
 * `children.actions` and `children.else_actions`, and 28 actions on the install
 * this was built against live there. A walk that stopped at the top level
 * reported a button driving nothing — which decides whether the import ticks it
 * — and would leave its identity out of the fingerprint, so moving it would read
 * as two different buttons.
 *
 * `children.condition` holds FEEDBACKS, which also carry ids and are not actions.
 * They are excluded by `type`, so a feedback id never enters a fingerprint.
 */
function actionsOf(control: Record<string, unknown>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const visit = (list: unknown[]): void => {
    for (const entry of list) {
      const a = rec(entry);
      if (str(a.type) === "feedback") continue;
      out.push(a);
      for (const nested of Object.values(rec(a.children))) visit(arr(nested));
    }
  };
  for (const step of Object.values(rec(control.steps))) {
    for (const set of Object.values(rec(rec(step).action_sets))) visit(arr(set));
  }
  return out;
}

/** Connection ids referenced by any action of a control. */
function connectionsOf(control: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const a of actionsOf(control)) {
    // 5.x names it connectionId; 3.x named it instance.
    const id = str(a.connectionId) || str(a.instance);
    if (id) out.push(id);
  }
  return out;
}

/**
 * The sorted, de-duplicated action ids of a control — its fingerprint.
 *
 * SORTED here and nowhere else, so a comparison is a string compare and cannot
 * depend on the order Companion happened to write the steps in.
 */
export function actionIdsOf(control: unknown): string[] {
  const ids = new Set<string>();
  for (const a of actionsOf(rec(control))) {
    const id = str(a.id);
    if (id) ids.add(id);
  }
  return [...ids].sort();
}

/**
 * Every button in an export that a rule could sensibly press.
 *
 * A control is included when its `type` starts with `button` AND it either
 * carries a label or does something. That excludes `pagenum`, `pageup` and
 * `pagedown` — the navigation furniture Companion puts on every page, which on
 * a real install is 150-odd controls that press nothing on the gear.
 */
export function parseButtons(raw: unknown): CompanionButton[] {
  const doc = rec(raw);
  const instances = rec(doc.instances);
  const out: CompanionButton[] = [];

  // `pages` is an object keyed by page number in every export seen; an array is
  // accepted too so an older or hand-built document does not read as empty.
  const pages: [string, unknown][] = Array.isArray(doc.pages)
    ? doc.pages.map((p, i) => [String(i + 1), p] as [string, unknown])
    : Object.entries(rec(doc.pages));

  for (const [pageKey, pageRaw] of pages) {
    const page = rec(pageRaw);
    const pageNum = Number(pageKey);
    if (!Number.isFinite(pageNum)) continue;
    const pageName = collapse(str(page.name)) || `Page ${pageNum}`;
    const pageId = str(page.id);

    for (const [rowKey, rowRaw] of Object.entries(rec(page.controls))) {
      const row = Number(rowKey);
      if (!Number.isFinite(row)) continue;
      for (const [colKey, controlRaw] of Object.entries(rec(rowRaw))) {
        const col = Number(colKey);
        if (!Number.isFinite(col)) continue;
        const control = rec(controlRaw);
        if (!str(control.type).startsWith("button")) continue;

        const label = labelOf(control);
        const connections = connectionsOf(control);
        if (!label && connections.length === 0) continue;

        const drives = [...new Set(connections)]
          .map((id) => {
            const inst = rec(instances[id]);
            // 5.x: moduleId. 3.x: instance_type.
            return str(inst.moduleId) || str(inst.instance_type);
          })
          .filter((m) => m !== "");

        out.push({
          page: pageNum,
          pageId,
          pageName,
          row,
          col,
          label,
          drives,
          actionIds: actionIdsOf(control),
        });
      }
    }
  }

  return out;
}

/**
 * The suffix pairs an ON/OFF button set may use.
 *
 * Deliberately a short closed list rather than a general "opposites" idea. A
 * pair that is wrong here becomes two rules a voice assistant will call, and a
 * guess about what "Open"/"Close" or "Up"/"Down" means on somebody's lighting
 * console is not a guess this should make.
 */
const SUFFIX_PAIRS: readonly (readonly [string, string])[] = [
  ["on", "off"],
  ["startup", "shutdown"],
];

const SUFFIXES = SUFFIX_PAIRS.flat();

/** Split "Projectors ON" into ["Projectors", "on"], or null. */
function splitSuffix(label: string): { base: string; suffix: string } | null {
  const m = /^(.*?)[\s]+(\S+)$/.exec(collapse(label));
  if (!m) return null;
  const suffix = m[2]!.toLowerCase();
  const base = m[1]!.trim();
  if (!base || !SUFFIXES.includes(suffix)) return null;
  return { base, suffix };
}

/**
 * ON/OFF pairs, matched WITHIN a page.
 *
 * Per page on purpose: "Conf TVs ON" exists on both the main auditorium's page
 * and the south auditorium's, and they are different televisions. Pairing across
 * pages would silently cross them, and the operator would only find out by
 * saying the cue out loud during setup.
 */
export function findPairs(buttons: CompanionButton[]): CompanionPair[] {
  const byPage = new Map<number, Map<string, Record<string, CompanionButton>>>();

  for (const b of buttons) {
    const split = splitSuffix(b.label);
    if (!split) continue;
    const page = byPage.get(b.page) ?? new Map<string, Record<string, CompanionButton>>();
    byPage.set(b.page, page);
    const key = split.base.toLowerCase();
    const entry = page.get(key) ?? {};
    // First one wins: a duplicated "Projectors ON" on one page is a Companion
    // problem, and taking the later one would make the import order-dependent.
    if (!entry[split.suffix]) entry[split.suffix] = b;
    page.set(key, entry);
  }

  const out: CompanionPair[] = [];
  for (const page of byPage.values()) {
    for (const entry of page.values()) {
      for (const [onSuffix, offSuffix] of SUFFIX_PAIRS) {
        const on = entry[onSuffix];
        const off = entry[offSuffix];
        if (!on || !off) continue;
        out.push({
          base: splitSuffix(on.label)!.base,
          page: on.page,
          pageName: on.pageName,
          on,
          off,
        });
        break;
      }
    }
  }

  return out.sort((a, b) => a.page - b.page || a.base.localeCompare(b.base));
}

/**
 * Module ids that mean "a utility device somebody turns on before a service and
 * off after it" — projectors, televisions, smart plugs and bulbs, lighting.
 *
 * This is what decides which pairs the import dialog TICKS. It used to be a list
 * of one site's Companion page names, which is meaningless on anybody else's
 * install and made the dialog's defaults a coincidence. What a button DRIVES is
 * in the export on every install.
 *
 * A trailing `*` matches a family: MA Lighting ships several modules
 * (`malighting-msc`, `malighting-grandma3`, …) and they are all the same answer.
 *
 * Getting this wrong is cheap in one direction only: an un-ticked pair is still
 * offered and one click away, while a wrongly ticked one is a cue somebody can
 * say by accident. Anything not listed here is offered unticked.
 */
export const UTILITY_MODULES: readonly string[] = [
  "generic-pjlink",
  "vizio-smartcast",
  "tplink-kasasmartplug",
  "tplink-kasasmartbulb",
  "malighting-*",
];

/** Does this module id name a utility device? Supports the trailing `*`. */
export function isUtilityModule(moduleId: string): boolean {
  const id = moduleId.trim().toLowerCase();
  if (!id) return false;
  return UTILITY_MODULES.some((m) =>
    m.endsWith("*") ? id.startsWith(m.slice(0, -1)) : id === m,
  );
}

/**
 * Is this pair ticked by default in the import dialog?
 *
 * EITHER half is enough. A pair whose OFF button is a Companion macro with no
 * connection of its own is still the same projector, and requiring both would
 * silently untick it.
 */
export function isSuggestedPair(pair: CompanionPair): boolean {
  return [...pair.on.drives, ...pair.off.drives].some(isUtilityModule);
}

/**
 * A unique cue slug per pair, keyed by `<page>:<base slug>`.
 *
 * A plain slug of the label is not unique, and this is not hypothetical: the
 * real Companion this was built against has "Conf TVs ON" on the main
 * auditorium's page and again on the south auditorium's, driving different
 * televisions. Two cues cannot share a name — the second would be refused on
 * import and one room would quietly have no cue — so a base used on more than
 * one page is prefixed with the page.
 *
 * Only the CLASHING ones grow a prefix. Naming every cue after its page would
 * make `ma_tvs_pjs_projectors_on` the normal case, which is a thing nobody will
 * say out loud.
 */
export function slugsForPairs(pairs: CompanionPair[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const p of pairs) {
    const base = slugForCue(p.base);
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }
  const out = new Map<string, string>();
  for (const p of pairs) {
    const base = slugForCue(p.base);
    const unique = (counts.get(base) ?? 0) > 1 ? `${slugForCue(p.pageName)}_${base}` : base;
    out.set(`${p.page}:${base}`, base ? unique : "");
  }
  return out;
}

/**
 * A cue name from a button label: lower snake_case, letters/digits/underscore.
 *
 * The name is said out loud to a voice assistant and typed into a Home Assistant
 * config, so it has to survive both. Anything else collapses to a single
 * underscore, and a name that reduces to nothing returns "" for the caller to
 * reject rather than a cue called `_`.
 */
export function slugForCue(text: string): string {
  return collapse(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}
