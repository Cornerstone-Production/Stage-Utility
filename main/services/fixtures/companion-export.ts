// A Companion configuration export, shaped exactly like a real one.
//
// Built in code rather than checked in as a 4 MB JSON file, and built from the
// SHAPES OF THE REAL DOCUMENT rather than from the parser: page names are
// invented, but every key here was read off a Companion 5.0.3 export —
// `style.layers[]` with `type: "text"` and `text.value`, an action naming its
// connection as `connectionId`, a connection naming its module as `moduleId`,
// `pages` keyed by page number as a string, `controls` as row-then-column, and
// the `pagenum`/`pageup`/`pagedown` furniture Companion puts on every page —
// which draws the page name, so it is excluded by its TYPE and by nothing else.
//
// If any of those is wrong, the parser passes its tests and finds nothing on the
// real box — which is why the live read in the pull request that added this is
// part of the evidence, not a nicety.

/** A `text` layer as 5.x writes one. */
function textLayer(value: string): Record<string, unknown> {
  return {
    id: "text0",
    name: "Text",
    usage: "auto",
    type: "text",
    enabled: { value: true, isExpression: false },
    text: { isExpression: false, value },
    color: { value: 16777215, isExpression: false },
    fontsize: { value: 11.7, isExpression: false },
  };
}

/** The furniture layers every button carries, which have no text at all. */
const CHROME_LAYERS: Record<string, unknown>[] = [
  { id: "canvas", name: "Canvas", usage: "auto", type: "canvas" },
  { id: "box0", name: "Background", usage: "auto", type: "box", color: { value: 0, isExpression: false } },
  { id: "image0", name: "Image", usage: "auto", type: "image" },
];

interface ButtonSpec {
  row: number;
  col: number;
  text: string;
  /** Connection ids the button's down-action drives. */
  connections?: string[];
  /**
   * Wrap the down-actions in a `logic_if`, the way a real export nests them.
   *
   * The branches live in `children.actions`/`children.else_actions`, and
   * `children.condition` holds a FEEDBACK with an id of its own. A parser that
   * stops at the top level reports this button as driving nothing and leaves its
   * actions out of its fingerprint.
   */
  nested?: boolean;
}

/**
 * A stable 21-character id from the nanoid alphabet, as Companion writes.
 *
 * Real page ids and action ids are opaque (`8h51ShTMsZ4ECnQhLlMg5`), and the
 * fixture used to derive them from the page NAME and from the connection id.
 * Both were unfaithful in a way that mattered: two buttons on one page driving
 * the same connection got the SAME action id, so any fingerprint built from them
 * would have matched the wrong button, and the page id was a slug of a name
 * rather than a value that survives being renamed.
 */
const ALPHABET = "useandom26T198340PX75pxJACKVERYMINDBUSHWOLFGQZbfghjklqvwyzrict";
function opaqueId(seed: string): string {
  // FNV-1a, then base-62. Deterministic, so a fixture built twice is identical.
  let h = 0x811c9dc5;
  const out: string[] = [];
  for (let i = 0; i < 21; i++) {
    for (const ch of `${seed}#${i}`) {
      h ^= ch.charCodeAt(0);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out.push(ALPHABET[h % ALPHABET.length]!);
  }
  return out.join("");
}

/** The id of the nth action on the button at these coordinates. */
export function fixtureActionId(page: number, row: number, col: number, i = 0): string {
  return opaqueId(`action:${page}:${row}:${col}:${i}`);
}

function button(spec: ButtonSpec, pageNum: number): Record<string, unknown> {
  const actions = (spec.connections ?? []).map((connectionId, i) => ({
    type: "action",
    // Unique per CONTROL, not per connection: two buttons on a page driving the
    // same device must not share an id, or a fingerprint identifies both.
    id: fixtureActionId(pageNum, spec.row, spec.col, i),
    definitionId: "power",
    connectionId,
    options: {},
    children: {},
  }));
  const down = spec.nested
    ? [
        {
          type: "action",
          id: fixtureActionId(pageNum, spec.row, spec.col, 99),
          definitionId: "logic_if",
          connectionId: "internal",
          options: {},
          children: {
            condition: [
              {
                type: "feedback",
                id: opaqueId(`feedback:${pageNum}:${spec.row}:${spec.col}`),
                definitionId: "transport_status",
                connectionId: (spec.connections ?? [])[0] ?? "internal",
                options: {},
              },
            ],
            actions,
            else_actions: [],
          },
        },
      ]
    : actions;
  return {
    type: "button-layered",
    style: { layers: [...CHROME_LAYERS, textLayer(spec.text)] },
    steps: { "0": { action_sets: { down, up: [] }, options: { runWhileHeld: [] } } },
  };
}

/**
 * The page-navigation controls Companion adds to every page. Never pressable.
 *
 * Each carries a real TEXT LAYER, because Companion draws the page name on a
 * `pagenum` and a caption on the arrows — so the ONLY thing that excludes these
 * from the picker is the `type` filter in parseButtons. They used to carry no
 * text and no steps, which meant the "skips pagenum, pageup and pagedown" test
 * passed with that filter deleted: the label-or-actions check was excluding them
 * instead, and the guard was proving nothing.
 */
function nav(pageName: string): Record<string, Record<string, unknown>> {
  return {
    "0": { type: "pagenum", style: { layers: [...CHROME_LAYERS, textLayer(pageName)] } },
    "1": { type: "pageup", style: { layers: [...CHROME_LAYERS, textLayer("Page up")] } },
    "2": { type: "pagedown", style: { layers: [...CHROME_LAYERS, textLayer("Page down")] } },
  };
}

function page(pageNum: number, name: string, buttons: ButtonSpec[]): Record<string, unknown> {
  const controls: Record<string, Record<string, unknown>> = { "7": nav(name) };
  for (const b of buttons) {
    controls[String(b.row)] = { ...(controls[String(b.row)] ?? {}), [String(b.col)]: button(b, pageNum) };
  }
  return {
    id: FIXTURE_PAGE_IDS[pageNum] ?? opaqueId(`page:${pageNum}`),
    name,
    controls,
    gridSize: { minColumn: 0, maxColumn: 17, minRow: 0, maxRow: 7 },
  };
}

/**
 * The opaque page ids, by the page number they START on.
 *
 * Named so a reconcile test can renumber a page and still say which one it
 * means — which is the whole point of the id being in the export.
 */
export const FIXTURE_PAGE_IDS: Record<number, string> = {
  1: opaqueId("page:screens"),
  2: opaqueId("page:lights"),
  3: opaqueId("page:cameras"),
  4: opaqueId("page:blank"),
};

/** Fake page names, deliberately — the real ones name a real building. */
export const FIXTURE_PAGES = {
  screens: "Room A: Screens",
  lights: "Room A: Lighting",
  cameras: "Room A: Cameras",
} as const;

export function companionExportFixture(): Record<string, unknown> {
  return {
    version: 12,
    type: "full",
    companionBuild: "5.0.3+9703-stable-2daa0d7670",
    instances: {
      "conn-pjlink": {
        label: "Projectors",
        enabled: true,
        moduleId: "generic-pjlink",
        moduleInstanceType: "connection",
        moduleVersionId: "1.2.0",
      },
      "conn-lights": {
        label: "Lighting",
        enabled: true,
        moduleId: "malighting-msc",
        moduleInstanceType: "connection",
        moduleVersionId: "1.4.0",
      },
      // The pre-5.x spelling, so a 3.x export is not silently module-less.
      "conn-legacy": { label: "Old Thing", instance_type: "generic-tcp-udp" },
    },
    pages: {
      "1": page(1, FIXTURE_PAGES.screens, [
        // A clean pair.
        { row: 0, col: 1, text: "Projectors ON", connections: ["conn-pjlink"] },
        { row: 0, col: 2, text: "Projectors OFF", connections: ["conn-pjlink"] },
        // A pair whose label carries Companion's LITERAL \n escape, which is what
        // a two-line button looks like in the export.
        { row: 1, col: 1, text: "Lobby:\\nTVs ON", connections: ["conn-legacy"] },
        { row: 1, col: 2, text: "Lobby:\\nTVs OFF", connections: ["conn-legacy"] },
        // An ON with no OFF. Must not become a pair.
        { row: 2, col: 1, text: "House Lights ON", connections: ["conn-lights"] },
        // No suffix at all.
        { row: 2, col: 3, text: "Take Screens", connections: ["conn-pjlink"] },
        // A button with actions and NO label — pressable, unpickable by name.
        { row: 3, col: 0, text: "", connections: ["conn-pjlink"] },
      ]),
      "2": page(2, FIXTURE_PAGES.lights, [
        { row: 0, col: 0, text: "Rig Startup", connections: ["conn-lights"] },
        { row: 0, col: 1, text: "Rig Shutdown", connections: ["conn-lights"] },
        // The SAME base as page 1, on a different page and a different device.
        // Pairing across pages would cross these two.
        { row: 1, col: 0, text: "Projectors ON", connections: ["conn-lights"] },
        { row: 1, col: 1, text: "Projectors OFF", connections: ["conn-lights"] },
      ]),
      "3": page(3, FIXTURE_PAGES.cameras, [
        // TWO buttons that run nothing, deliberately, and the second one is not
        // decoration: an actionless button has no identity but its coordinates,
        // and the reconcile must never SEARCH the page for an empty
        // fingerprint. With one such button on the page a search finds nothing
        // and answers "missing" anyway, so the test for that refusal passed
        // with the refusal deleted. With two, deleting it makes the search find
        // exactly one and report a MOVE onto the wrong button. See
        // companion-reconcile.test.ts.
        { row: 0, col: 0, text: "Cam 1", connections: [] },
        { row: 1, col: 0, text: "Cam 2", connections: [] },
        // Its actions live inside a `logic_if`. Both what it drives and its
        // fingerprint have to come out of the nesting.
        { row: 0, col: 1, text: "Record Toggle", connections: ["conn-pjlink"], nested: true },
      ]),
      // A page with nothing but navigation, as most of a real install's are.
      "4": page(4, "PAGE", []),
    },
  };
}
