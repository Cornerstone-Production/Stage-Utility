// What the ScriptView rundown puts on a screen: how bright its text is, how the
// item's notes and its key/BPM/meter line are drawn, and where the time signature
// lands.
//
// Driven through the REAL column renderers and the real RundownTable, never the
// source text: a scan of scriptview-columns.tsx would be satisfied by a comment
// that names `text-fg-strong`, and would stay green with the class on the wrong
// cell. The rundown is one implementation called from three surfaces (the page, a
// `script` View, the `view-embed` object), so asserting here covers all three —
// scriptview-surfaces.test.ts is what guarantees nothing grows a second copy.
//
// WHAT THIS FILE DELIBERATELY DOES NOT TEST, because jsdom cannot see it: the
// colours themselves. jsdom loads no stylesheet, so `text-fg-strong` is a class
// name here and never a computed colour. What this file CAN pin is that the
// class names are right and that styles.css defines every token those names
// point at (the last describe). Tailwind emits nothing for a utility whose
// `--color-*` is missing, so a typo'd or undeclared token renders as inherited
// colour and no build step complains. The brightness, contrast and the 0.45em
// gap were checked in a browser instead.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { after, afterEach, describe, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import postcss from "postcss";

import { installRenderDom } from "../test-dom.js";
import { RundownTable } from "./rundown-table";
import { buildScriptViewColumns, resolveScriptViewSpec } from "./scriptview-columns";
import type { CategoryRole } from "../../main/types/scriptview-roles.js";
import type { PlanItemDTO, ScriptViewLayout } from "../../main/types/stage.js";

const teardown = installRenderDom();
const { render, cleanup } = await import("@testing-library/react");
after(() => teardown());
afterEach(() => cleanup());

const ROLE: CategoryRole = { id: "band", name: "Band", members: ["Band"] };

const SONG: PlanItemDTO = {
  id: "i1",
  title: "Thank God I'm Free",
  itemType: "song",
  lengthSec: 301,
  sequence: 0,
  notesByCategory: { Band: "* Play per arrangement" },
  description: "Hosting note under the title",
  songKey: "E",
  bpm: 128,
  meter: "4/4",
  arrangementName: "Elevation Rhythm",
  servicePosition: "during",
};

const spec = (layout: ScriptViewLayout | null = null) => resolveScriptViewSpec(layout, [ROLE], ["Band"]);
const CLOCKS = new Map([[SONG.id, Date.parse("2026-03-01T20:00:00Z")]]);
const columns = (layout: ScriptViewLayout | null = null) => buildScriptViewColumns(spec(layout), CLOCKS, "UTC");

const layout = (over: Partial<ScriptViewLayout> = {}): ScriptViewLayout => ({
  id: "l1", name: "Audio", order: 0, columnRoles: ["band"], ...over,
});

/** The item cell's markup, from the real "title" column renderer. */
function titleCell(item: PlanItemDTO, l: ScriptViewLayout | null = null, isCurrent = false): HTMLElement {
  const col = columns(l).find((c) => c.key === "title")!;
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<>{col.render(item, { isCurrent })}</>);
  return host;
}

/** The italic key/BPM/meter line, or null when the item has none to show. */
const metaLine = (host: HTMLElement) => host.querySelector("span.italic");

/** The whole rundown at its full-width shape (SSR has no ResizeObserver, so the
 *  table measures 1280 and takes the `full` branch). */
function tableDom(items: PlanItemDTO[], l: ScriptViewLayout | null = null, currentItemId: string | null = null): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(
    <RundownTable items={items} columns={columns(l)} currentItemId={currentItemId} roles={[ROLE]} footer={<span>total</span>} />,
  );
  return host;
}

describe("the key, BPM and meter line", () => {
  test("puts the meter right after the BPM and before the arrangement", () => {
    const meta = metaLine(titleCell(SONG));
    assert.equal(meta?.textContent, "Key E  ·  128 BPM  ·  4/4  ·  Elevation Rhythm");
  });

  test("leaves the meter out when the arrangement has none", () => {
    const meta = metaLine(titleCell({ ...SONG, meter: null }));
    assert.equal(meta?.textContent, "Key E  ·  128 BPM  ·  Elevation Rhythm");
    const absent = { ...SONG } as Partial<PlanItemDTO>;
    delete absent.meter;
    assert.equal(metaLine(titleCell(absent as PlanItemDTO))?.textContent, "Key E  ·  128 BPM  ·  Elevation Rhythm");
  });

  test("leaves the meter out when the layout turns it off, and keeps the rest", () => {
    const meta = metaLine(titleCell(SONG, layout({ showMeter: false })));
    assert.equal(meta?.textContent, "Key E  ·  128 BPM  ·  Elevation Rhythm");
  });

  test("a layout saved before the switch existed still shows it", () => {
    // `layout()` has no showMeter at all, which is every layout on disk today.
    assert.equal("showMeter" in layout(), false);
    assert.equal(spec(layout()).showMeter, true);
    assert.equal(metaLine(titleCell(SONG, layout()))?.textContent, "Key E  ·  128 BPM  ·  4/4  ·  Elevation Rhythm");
    // And the implicit "All columns" layout (null) too.
    assert.equal(spec(null).showMeter, true);
  });

  test("a meter alone still draws a line, and no line when nothing is set", () => {
    const only = layout({ showKey: false, showBpm: false, showArrangement: false });
    assert.equal(metaLine(titleCell(SONG, only))?.textContent, "4/4");
    const none = layout({ showKey: false, showBpm: false, showArrangement: false, showMeter: false });
    assert.equal(metaLine(titleCell(SONG, none)), null);
  });

  test("stays small and italic, and takes the lightened accent token", () => {
    const meta = metaLine(titleCell(SONG))!;
    const cls = meta.className.split(/\s+/);
    assert.ok(cls.includes("text-caption2"), `meta line grew: ${meta.className}`);
    assert.ok(cls.includes("italic"), meta.className);
    assert.ok(cls.includes("text-accent-text"), `meta line is not the lightened accent: ${meta.className}`);
    assert.ok(!cls.some((c) => c.startsWith("text-accent/")), `meta line is back on a translucent accent: ${meta.className}`);
  });
});

describe("the item's own notes", () => {
  const desc = (host: HTMLElement) => [...host.querySelectorAll("span")].find((s) => s.textContent === SONG.description)!;

  test("draw at the department notes' size, in full white, with a gap above", () => {
    const cls = desc(titleCell(SONG)).className.split(/\s+/);
    assert.ok(cls.includes("text-fg-strong"), `item notes are not full white: ${cls.join(" ")}`);
    assert.ok(!cls.includes("text-caption2"), "item notes are still the small caption size");
    assert.ok(!cls.includes("text-fg-subtle"), "item notes are still the dim ink");
    assert.ok(cls.includes("mt-[0.45em]"), `item notes lost their gap: ${cls.join(" ")}`);
    assert.ok(cls.includes("whitespace-pre-line"), "item notes lost their line breaks");
  });

  test("follow the layout's Item notes switch", () => {
    assert.equal(desc(titleCell(SONG, layout({ showItemNotes: false }))), undefined);
  });
});

describe("rundown text brightness, through the real table", () => {
  test("department note cells are full white", () => {
    const td = tableDom([SONG]).querySelector("tbody tr td:last-child")!;
    assert.match(td.textContent ?? "", /Play per arrangement/);
    const cls = td.className.split(/\s+/);
    assert.ok(cls.includes("text-fg-strong"), `department notes are not full white: ${td.className}`);
    assert.ok(!cls.includes("text-fg-muted"), `department notes are still 70%: ${td.className}`);
  });

  test("Clock and Time are 82% white", () => {
    const cells = [...tableDom([SONG]).querySelectorAll("tbody tr td")];
    for (const i of [0, 1]) {
      const cls = cells[i]!.className.split(/\s+/);
      assert.ok(cls.includes("text-fg-soft"), `column ${i} is not 82%: ${cells[i]!.className}`);
      assert.ok(!cls.includes("text-fg-subtle"), `column ${i} is still 45%: ${cells[i]!.className}`);
    }
    assert.equal(cells[0]!.textContent, "20:00:00");
  });

  test("the item title is full white, and the live item keeps its green", () => {
    const title = (cur: string | null) => tableDom([SONG], null, cur).querySelector("tbody tr td:nth-child(3) > div > span")!;
    assert.ok(title(null).className.split(/\s+/).includes("text-fg-strong"), title(null).className);
    const live = title(SONG.id).className.split(/\s+/);
    assert.ok(live.includes("text-live-11"), "the live item lost its green");
    assert.ok(!live.includes("text-fg-strong"));
  });

  test("header labels, section rows and the footer stay dimmer on purpose", () => {
    const section: PlanItemDTO = { ...SONG, id: "h1", title: "Pre-service", itemType: "header" };
    const dom = tableDom([section, SONG]);
    assert.ok(dom.querySelector("thead")!.className.split(/\s+/).includes("text-fg-subtle"), "column labels brightened");
    assert.ok(dom.querySelector("tbody tr td[colspan]")!.className.split(/\s+/).includes("text-fg-muted"), "section row brightened");
    assert.ok(dom.querySelector("tfoot td")!.className.split(/\s+/).includes("text-fg-muted"), "footer brightened");
  });

  test("Max SPL keeps the ink it had", () => {
    const withSpl = buildScriptViewColumns(spec(layout({ showMaxSpl: true })), CLOCKS, "UTC", new Map([[SONG.id, 98]]));
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(<RundownTable items={[SONG]} columns={withSpl} roles={[ROLE]} />);
    const cls = host.querySelector("tbody tr td:last-child")!.className.split(/\s+/);
    assert.ok(cls.includes("text-fg") && !cls.includes("text-fg-strong"), cls.join(" "));
  });

  test("the stacked (narrow) shape draws the same inks", () => {
    // The table cells are only one of the two shapes that draw a column's value:
    // under 640px each column becomes `label  value`, and that value used to be
    // hard-coded `text-fg-muted`, so a narrow preview would have kept the 70%
    // text the wide one just lost.
    const g = globalThis as unknown as { ResizeObserver: unknown };
    const real = g.ResizeObserver;
    g.ResizeObserver = class {
      constructor(private cb: (e: { contentRect: { width: number } }[]) => void) {}
      observe() { this.cb([{ contentRect: { width: 400 } }]); }
      unobserve() {}
      disconnect() {}
    };
    try {
      const { container } = render(<RundownTable items={[SONG]} columns={columns()} roles={[ROLE]} />);
      assert.equal(container.querySelector("table"), null, "this width did not take the stacked shape");
      const values = [...container.querySelectorAll("span.min-w-0")];
      const byText = (t: string) => values.find((v) => v.textContent === t)!;
      assert.ok(byText("* Play per arrangement").className.split(/\s+/).includes("text-fg-strong"), "stacked department note");
      assert.ok(byText("5:01").className.split(/\s+/).includes("text-fg-soft"), "stacked Time");
    } finally {
      g.ResizeObserver = real;
    }
  });
});

describe("styles.css defines every token the rundown names", () => {
  const CSS = postcss.parse(readFileSync(new URL("../styles.css", import.meta.url), "utf8"));
  /** Declaration NODES on a selector — a comment that mentions a token cannot satisfy this. */
  function decl(selector: string, prop: string): string | undefined {
    let value: string | undefined;
    CSS.walkRules((rule) => {
      if (!rule.selector.split(",").map((s) => s.trim()).includes(selector)) return;
      rule.each((n) => { if (n.type === "decl" && n.prop === prop) value = n.value; });
    });
    return value;
  }
  const themeDecl = (prop: string): string | undefined => {
    let value: string | undefined;
    CSS.walkAtRules("theme", (at) => at.each((n) => { if (n.type === "decl" && n.prop === prop) value = n.value; }));
    return value;
  };

  for (const [name, white] of [["fg-strong", "#ffffff"], ["fg-soft", "rgba(255, 255, 255, 0.82)"]] as const) {
    test(`${name} is a Tailwind colour, a .kiosk step and a .kiosk-surface literal`, () => {
      assert.equal(themeDecl(`--color-${name}`), `var(--su-${name})`, `@theme does not expose text-${name}`);
      assert.equal(decl(".kiosk", `--su-${name}`), white, `.kiosk does not set --su-${name}`);
      // A kiosk preview inside the LIGHT app (the layout editor's preview) resolves
      // --color-* at :root, so without this literal it draws the light theme's ink on black.
      assert.equal(decl(".kiosk-surface", `--color-${name}`), white, `.kiosk-surface does not set --color-${name}`);
    });
  }

  test("accent-text is the Branding accent mixed with white, everywhere it can render", () => {
    assert.equal(themeDecl("--color-accent-text"), "var(--su-accent-text)");
    assert.equal(decl(":root", "--su-accent-text"), "color-mix(in srgb, var(--brand-accent), white 45%)");
  });
});
