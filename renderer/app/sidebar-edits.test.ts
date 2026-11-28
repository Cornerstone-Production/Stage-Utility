// The changes Customize makes, and where a drag over the rail lands.
//
// What a test here cannot see: the caret drawn on the wrong row, or a drop that
// lands where the caret was not. jsdom lays nothing out (every rect is zero), so
// those were checked by dragging in a browser; this file holds the rules and the
// geometry as plain functions over measured numbers.
//
// Nor can it see touch: whether a swipe on the rail scrolls it (touch-action) or
// a long-press drags a row is a browser's decision, so both were driven with real
// touch events at phone width.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";

import { EMPTY_SIDEBAR, LOCKED_PAGE, resolveSidebar } from "@main/services/sidebar-arrangement";
import {
  addSection,
  hidePage,
  moveSection,
  movePage,
  removeSection,
  renameSection,
  restorePage,
} from "./sidebar-edits";
import { rowPlace, sectionPlace, type RailItem } from "./rail-drop";

const CONSOLES = { all: ["console:a", "console:b"], hidden: new Set<string>() };
const base = () => resolveSidebar(EMPTY_SIDEBAR, CONSOLES);
const members = (r: ReturnType<typeof base>, id: string) => r.sections.find((s) => s.id === id)?.members;

describe("sidebar edits", () => {
  test("a page moves to another section, and into the top group beside Home", () => {
    const r = movePage(base(), "patch", "top", Infinity);
    assert.deepEqual(members(r!, "top"), ["home", "patch"]);
    assert.ok(!members(r!, "content")?.includes("patch"));
  });

  test("a page cannot go into Consoles, and a console cannot leave it", () => {
    assert.equal(movePage(base(), "patch", "consoles", 0), null);
    assert.equal(movePage(base(), "console:a", "content", 0), null);
    assert.deepEqual(members(movePage(base(), "console:b", "consoles", 0)!, "consoles"), ["console:b", "console:a"]);
  });

  test("a hidden page goes back to the section it came from", () => {
    const hidden = hidePage(base(), "baptisms")!;
    assert.deepEqual(hidden.hiddenPages, ["baptisms"]);
    const back = restorePage(hidden, "baptisms")!;
    assert.equal(members(back, "services")?.at(-1), "baptisms");
    assert.deepEqual(back.hiddenPages, []);
  });

  test("Advanced and consoles are not hidden here", () => {
    assert.equal(hidePage(base(), LOCKED_PAGE), null);
    assert.equal(hidePage(base(), "console:a"), null);
  });

  test("removing a section sends its pages to the tray, but Advanced stays in the sidebar", () => {
    const r = removeSection(base(), "settings")!;
    assert.ok(!r.sections.some((s) => s.id === "settings"));
    assert.deepEqual(r.hiddenPages.sort(), ["branding", "integrations", "messages"]);
    assert.equal(members(r, "services")?.at(-1), LOCKED_PAGE);
    assert.equal(removeSection(base(), "consoles"), null);
    assert.equal(removeSection(base(), "top"), null);
  });

  test("a section moves with its pages, and the top group stays first", () => {
    const r = moveSection(base(), "settings", "content")!;
    assert.deepEqual(r.sections.map((s) => s.id), ["top", "consoles", "settings", "content", "screens", "devices", "services"]);
    const toEnd = moveSection(base(), "content", null)!;
    assert.equal(toEnd.sections.at(-1)?.id, "content");
    assert.equal(moveSection(base(), "top", null), null);
  });

  test("a heading is renamed, never to nothing", () => {
    assert.equal(renameSection(base(), "content", "Show")!.sections[2].label, "Show");
    assert.equal(renameSection(base(), "content", "   "), null);
  });

  test("a new section is empty and at the end", () => {
    const r = addSection(base(), "s-new");
    assert.deepEqual(r.sections.at(-1), { id: "s-new", label: "New section", kind: "pages", members: [] });
  });
});

describe("where a drag over the rail lands", () => {
  // Home at 0-34, Consoles heading 40-60, two consoles, Content heading, two pages.
  const items: RailItem[] = [
    { kind: "row", section: "top", top: 0, bottom: 34 },
    { kind: "head", section: "consoles", top: 40, bottom: 60 },
    { kind: "row", section: "consoles", top: 62, bottom: 96 },
    { kind: "row", section: "consoles", top: 98, bottom: 132 },
    { kind: "head", section: "content", top: 140, bottom: 160 },
    { kind: "row", section: "content", top: 162, bottom: 196 },
    { kind: "row", section: "content", top: 198, bottom: 232 },
  ];
  const order = ["top", "consoles", "content"];

  test("the upper half of a row is before it, the lower half after it", () => {
    assert.deepEqual(rowPlace(items, order, 170), { section: "content", index: 0, caretY: 161 });
    assert.deepEqual(rowPlace(items, order, 190), { section: "content", index: 1, caretY: 197 });
  });

  test("just above a heading is the end of the section before it", () => {
    assert.deepEqual(rowPlace(items, order, 140), { section: "consoles", index: Infinity, caretY: 137 });
    assert.deepEqual(rowPlace(items, order, 38), { section: "top", index: Infinity, caretY: 37 });
  });

  test("below everything is the end of the last section", () => {
    assert.deepEqual(rowPlace(items, order, 500), { section: "content", index: Infinity, caretY: 233 });
  });

  test("an empty section's drop zone takes the drop at its start", () => {
    const withEmpty: RailItem[] = [...items, { kind: "head", section: "new", top: 240, bottom: 260 }, { kind: "dz", section: "new", top: 262, bottom: 296 }];
    assert.deepEqual(rowPlace(withEmpty, [...order, "new"], 270), { section: "new", index: 0, caretY: null });
  });

  test("a section lands before the first heading below the pointer, or last", () => {
    const heads = items.filter((i) => i.kind === "head" && i.section !== "consoles");
    assert.deepEqual(sectionPlace(heads, 100, 300), { before: "content", caretY: 135 });
    assert.deepEqual(sectionPlace(heads, 200, 300), { before: null, caretY: 300 });
  });
});
