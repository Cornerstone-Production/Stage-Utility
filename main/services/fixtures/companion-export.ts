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
}

function button(spec: ButtonSpec): Record<string, unknown> {
  const actions = (spec.connections ?? []).map((connectionId, i) => ({
    type: "action",
    id: `act-${connectionId}-${i}`,
    definitionId: "power",
    connectionId,
    options: {},
    children: {},
  }));
  return {
    type: "button-layered",
    style: { layers: [...CHROME_LAYERS, textLayer(spec.text)] },
    steps: { "0": { action_sets: { down: actions, up: [] }, options: { runWhileHeld: [] } } },
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

function page(name: string, buttons: ButtonSpec[]): Record<string, unknown> {
  const controls: Record<string, Record<string, unknown>> = { "7": nav(name) };
  for (const b of buttons) {
    controls[String(b.row)] = { ...(controls[String(b.row)] ?? {}), [String(b.col)]: button(b) };
  }
  return {
    id: `page-${name.replace(/\W+/g, "-").toLowerCase()}`,
    name,
    controls,
    gridSize: { minColumn: 0, maxColumn: 17, minRow: 0, maxRow: 7 },
  };
}

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
      "1": page(FIXTURE_PAGES.screens, [
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
      "2": page(FIXTURE_PAGES.lights, [
        { row: 0, col: 0, text: "Rig Startup", connections: ["conn-lights"] },
        { row: 0, col: 1, text: "Rig Shutdown", connections: ["conn-lights"] },
        // The SAME base as page 1, on a different page and a different device.
        // Pairing across pages would cross these two.
        { row: 1, col: 0, text: "Projectors ON", connections: ["conn-lights"] },
        { row: 1, col: 1, text: "Projectors OFF", connections: ["conn-lights"] },
      ]),
      "3": page(FIXTURE_PAGES.cameras, [
        { row: 0, col: 0, text: "Cam 1", connections: [] },
      ]),
      // A page with nothing but navigation, as most of a real install's are.
      "4": page("PAGE", []),
    },
  };
}
