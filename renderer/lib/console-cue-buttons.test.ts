// Where a cue button lands on a console, and what is said when a console refuses.
//
// The placement is pure and is checked on plain layouts. The writes go through
// the views API in the dialog's own test (new-cue-dialog.test.tsx), against the
// real routes; here the seam is replaced so a refusal can be made to happen.

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import type { LayoutDTO, LayoutObject, View } from "@main/types/views";

import {
  BUTTON_GAP,
  DEFAULT_BUTTON_SIZE,
  addCueButtonToConsoles,
  consoleButtonDeps,
  consolesWithLayouts,
  fitFontSize,
  repointCueButtons,
  repointLogLines,
  withCueButton,
  withCueRepointed,
} from "./console-cue-buttons.js";

const obj = (over: Partial<LayoutObject> & { config?: LayoutObject["config"] }): LayoutObject => ({
  id: "o",
  x: 0.1,
  y: 0.1,
  w: 0.2,
  h: 0.1,
  z: 1,
  config: { type: "clock" } as LayoutObject["config"],
  ...over,
});
const layoutOf = (...objects: LayoutObject[]): LayoutDTO => ({ version: 1, canvas: { width: 1920, height: 1080 }, objects });
const button = (id: string, over: Partial<LayoutObject> = {}): LayoutObject =>
  obj({ id, config: { type: "cue-button", cue: "other" }, style: { fontSize: 0.07 }, ...over });

const added = (l: LayoutDTO): LayoutObject => l.objects.at(-1)!;

describe("withCueButton", () => {
  test("goes under the lowest object, in the last button's column, sized and styled like it", () => {
    const l = layoutOf(
      obj({ id: "clock", y: 0.05, h: 0.2 }),
      button("b1", { x: 0.05, y: 0.3, w: 0.4, h: 0.12, z: 2 }),
      button("b2", { x: 0.55, y: 0.5, w: 0.35, h: 0.14, z: 3 }),
    );
    const { layout, overEdge } = withCueButton(l, "projectors_on_cue", "Projectors on");
    const b = added(layout);
    assert.equal(layout.objects.length, 4);
    assert.equal(overEdge, false);
    assert.deepEqual(b.config, { type: "cue-button", cue: "projectors_on_cue", label: "Projectors on", showDevice: true });
    assert.equal(b.w, 0.35, "sized like the last button");
    assert.equal(b.h, 0.14);
    assert.equal(b.x, 0.55, "in the last button's column");
    assert.ok(Math.abs(b.y - (0.5 + 0.14 + BUTTON_GAP)) < 1e-9, `at ${b.y}`);
    assert.deepEqual(b.style, { fontSize: 0.07 }, "styled like the last button");
    assert.equal(b.z, 4, "in front of everything");
  });

  test("the original layout is not changed", () => {
    const l = layoutOf(button("b1"));
    withCueButton(l, "x", "");
    assert.equal(l.objects.length, 1);
  });

  test("with no button to copy: the default size, centred", () => {
    const { layout } = withCueButton(layoutOf(obj({ id: "clock", y: 0.05, h: 0.2 })), "x", "");
    const b = added(layout);
    assert.equal(b.w, DEFAULT_BUTTON_SIZE.w);
    assert.equal(b.h, DEFAULT_BUTTON_SIZE.h);
    assert.ok(Math.abs(b.x - (1 - DEFAULT_BUTTON_SIZE.w) / 2) < 1e-9, `at x ${b.x}`);
    assert.ok(Math.abs(b.y - (0.25 + BUTTON_GAP)) < 1e-9, `at y ${b.y}`);
    assert.equal(b.config.type, "cue-button");
    assert.ok(b.style && Object.keys(b.style).length > 0, "no default style");
  });

  test("a button with nothing to copy has its text sized to fit, and a longer name is smaller", () => {
    const canvas = { width: 1920, height: 1080 };
    const short = fitFontSize("Go", DEFAULT_BUTTON_SIZE, canvas);
    const long = fitFontSize("Foyer televisions and lobby lights off", DEFAULT_BUTTON_SIZE, canvas);
    assert.ok(short <= 0.12, "bigger than a button added by hand");
    assert.ok(long < short, `${long} is not smaller than ${short}`);
    // The estimate the box has to hold: the label's width at 0.66em a letter.
    const letters = "Foyer televisions and lobby lights off".length;
    assert.ok(0.66 * letters * long * canvas.height <= DEFAULT_BUTTON_SIZE.w * canvas.width, "the long label still overflows");
    const placed = added(withCueButton(layoutOf(), "x", "", "Projectors on").layout);
    assert.equal(placed.style?.fontSize, fitFontSize("Projectors on", DEFAULT_BUTTON_SIZE, canvas));
    assert.ok((placed.style?.fontSize ?? 1) < 0.12, "Projectors on at the full default size is clipped in this box");
  });

  test("a label typed by the operator, not the cue's name, is what is fitted", () => {
    // A name long enough to fit below the default size, so fitting the name
    // instead of the label would come out smaller than the label's fit.
    const name = "Foyer televisions and lobby lights off";
    const named = fitFontSize(name, DEFAULT_BUTTON_SIZE, { width: 1920, height: 1080 });
    const labelled = added(withCueButton(layoutOf(), "x", "On", name).layout);
    assert.equal(labelled.style?.fontSize, fitFontSize("On", DEFAULT_BUTTON_SIZE, { width: 1920, height: 1080 }));
    assert.ok((labelled.style?.fontSize ?? 0) > named, `the label's ${labelled.style?.fontSize} is not larger than the name's ${named}`);
  });

  test("an existing button's style is copied as it is, not refitted", () => {
    const ref = button("b1", { w: 0.2, h: 0.1, style: { fontSize: 0.5 } });
    const b = added(withCueButton(layoutOf(ref), "x", "A very long name that would never fit", "").layout);
    assert.deepEqual(b.style, { fontSize: 0.5 });
  });

  test("an empty layout puts it along the bottom edge", () => {
    const { layout, overEdge } = withCueButton(layoutOf(), "x", "");
    const b = added(layout);
    assert.equal(overEdge, false);
    assert.ok(Math.abs(b.y + b.h - (1 - BUTTON_GAP)) < 1e-9, `bottom at ${b.y + b.h}`);
  });

  test("any kind of button is a button to copy, and an object that is not one is not", () => {
    const l = layoutOf(
      obj({ id: "act", config: { type: "rosstalk-button", targetId: null, commandId: null, params: {}, label: "RossTalk" }, w: 0.5, h: 0.2, y: 0.1 }),
      obj({ id: "clock", w: 0.9, h: 0.05, y: 0.4 }),
    );
    const b = added(withCueButton(l, "x", "").layout);
    assert.equal(b.w, 0.5);
    assert.equal(b.h, 0.2);
  });

  test("with no room below, it is against the bottom edge and says it overlaps", () => {
    const l = layoutOf(obj({ id: "wall", y: 0.1, h: 0.85 }), button("b", { y: 0.2, h: 0.2, x: 0.3, w: 0.3 }));
    const { layout, overEdge } = withCueButton(l, "x", "");
    const b = added(layout);
    assert.equal(overEdge, true);
    assert.ok(Math.abs(b.y + b.h - 1) < 1e-9, `bottom at ${b.y + b.h}`);
  });

  test("a backdrop that fills the canvas is not content, so it does not push the button onto the edge", () => {
    const l = layoutOf(
      obj({ id: "bg", x: 0, y: 0, w: 1, h: 1, z: 0 }),
      obj({ id: "clock", y: 0.05, h: 0.2 }),
    );
    const { layout, overEdge } = withCueButton(l, "x", "");
    const b = added(layout);
    assert.equal(overEdge, false, "a full-canvas backdrop was counted as content");
    assert.ok(Math.abs(b.y - (0.25 + BUTTON_GAP)) < 1e-9, `at ${b.y}`);
    // A tall object that is not a backdrop (narrow) still counts.
    const tall = layoutOf(obj({ id: "strip", x: 0, y: 0, w: 0.2, h: 1, z: 1 }));
    assert.equal(withCueButton(tall, "x", "").overEdge, true);
  });

  test("a nested object does not move the bottom: its box is a fraction of its container's", () => {
    const l = layoutOf(
      obj({ id: "box", y: 0.1, h: 0.2, config: { type: "container" } as LayoutObject["config"], children: [obj({ id: "inner", y: 0.9, h: 0.5 })] }),
    );
    const b = added(withCueButton(l, "x", "").layout);
    assert.ok(Math.abs(b.y - (0.3 + BUTTON_GAP)) < 1e-9, `at ${b.y}`);
  });
});

describe("consolesWithLayouts", () => {
  const v = (id: string, over: Partial<View>): View => ({ id, name: id, kind: "custom", createdAt: "", ...over });
  test("a custom console only: not a wall view, not a calendar console, not Home", () => {
    const views = [
      v("a", { surface: "console" }),
      v("b", {}),
      v("c", { surface: "console", kind: "calendar" }),
      v("d", { surface: "console", kind: "slots" }),
      // Home is a custom console with a layout, seeded on every install.
      v("home", { surface: "console" }),
    ];
    assert.deepEqual(consolesWithLayouts(views).map((x) => x.id), ["a"]);
  });
});

describe("addCueButtonToConsoles", () => {
  const original = { ...consoleButtonDeps };
  afterEach(() => Object.assign(consoleButtonDeps, original));

  const console1 = (id: string, rev = 1): View => ({
    id,
    name: `Console ${id}`,
    kind: "custom",
    surface: "console",
    createdAt: "",
    layout: layoutOf(button("b")),
    layoutRev: rev,
  });

  test("one failure does not stop the next, and each console gets its own result", async () => {
    const written: string[] = [];
    consoleButtonDeps.readViews = async () => [console1("a"), console1("b"), console1("c")];
    consoleButtonDeps.writeLayout = async (id) => {
      if (id === "b") throw new Error("the disk is full");
      written.push(id);
    };
    const results = await addCueButtonToConsoles(["a", "b", "c"], "x", "");
    assert.deepEqual(written, ["a", "c"]);
    assert.deepEqual(
      results.map((r) => [r.viewId, r.ok, r.error ?? ""]),
      [["a", true, ""], ["b", false, "the disk is full"], ["c", true, ""]],
    );
    assert.equal(results[1].name, "Console b", "the failure names the console");
  });

  test("a console that has never saved a layout is written at revision 0, not unconditionally", async () => {
    const revs: (number | undefined)[] = [];
    consoleButtonDeps.readViews = async () => [{ ...console1("a"), layoutRev: undefined }];
    consoleButtonDeps.writeLayout = async (_id, _layout, rev) => {
      revs.push(rev);
    };
    await addCueButtonToConsoles(["a"], "x", "");
    assert.deepEqual(revs, [0]);
  });

  test("a stale revision is retried once from a fresh read, and then reported", async () => {
    const revs: (number | undefined)[] = [];
    let reads = 0;
    consoleButtonDeps.readViews = async () => [console1("a", ++reads)];
    consoleButtonDeps.writeLayout = async (_id, _layout, rev) => {
      revs.push(rev);
      throw Object.assign(new Error("changed by someone else"), { status: 409 });
    };
    const results = await addCueButtonToConsoles(["a"], "x", "");
    assert.deepEqual(revs, [1, 2], "the retry must carry the fresh revision");
    assert.equal(results[0].ok, false);
    assert.equal(results[0].error, "changed by someone else");

    const again: (number | undefined)[] = [];
    reads = 0;
    let first = true;
    consoleButtonDeps.writeLayout = async (_id, _layout, rev) => {
      again.push(rev);
      if (first) {
        first = false;
        throw Object.assign(new Error("stale"), { status: 409 });
      }
    };
    const retried = await addCueButtonToConsoles(["a"], "x", "");
    assert.deepEqual(again, [1, 2]);
    assert.equal(retried[0].ok, true, "the retry succeeded, so the console is written");
  });

  test("a console that is gone, or no longer has a layout, is a result and not a throw", async () => {
    consoleButtonDeps.readViews = async () => [{ ...console1("a"), surface: "display" }];
    consoleButtonDeps.writeLayout = async () => assert.fail("nothing should be written");
    const results = await addCueButtonToConsoles(["gone", "a"], "x", "");
    assert.deepEqual(results.map((r) => [r.viewId, r.ok]), [["gone", false], ["a", false]]);
    assert.match(results[0].error ?? "", /no longer exists/);
    assert.match(results[1].error ?? "", /no longer a console/);
  });

  test("a read that fails is that console's failure", async () => {
    consoleButtonDeps.readViews = async () => {
      throw new Error("server down");
    };
    const results = await addCueButtonToConsoles(["a"], "x", "");
    assert.equal(results[0].ok, false);
    assert.equal(results[0].error, "server down");
  });
});

describe("withCueRepointed", () => {
  const cueAt = (id: string, cue: string, extra: Partial<LayoutObject> = {}): LayoutObject =>
    obj({ id, config: { type: "cue-button", cue }, ...extra });

  test("points only the listed Buttons that still name the old command", () => {
    const l = layoutOf(cueAt("a", "old_name"), cueAt("b", "old_name"), cueAt("c", "something_else"), cueAt("d", "OLD_NAME "));
    const { layout, count } = withCueRepointed(l, new Set(["a", "c", "d"]), ["old_name"], "new_name");
    assert.equal(count, 2, "a (listed, names it) and d (listed, same name in other case); b is not listed and c names another");
    assert.deepEqual(
      layout.objects.map((o) => (o.config as { cue?: string }).cue),
      ["new_name", "old_name", "something_else", "new_name"],
    );
  });

  test("reaches a Button inside a container, and leaves the container's other children whole", () => {
    const inner = cueAt("inner", "old_name");
    const sibling = obj({ id: "sib" });
    const l = layoutOf(obj({ id: "box", children: [sibling, inner] }));
    const { layout, count } = withCueRepointed(l, new Set(["inner"]), ["old_name"], "new_name");
    assert.equal(count, 1);
    const kids = layout.objects[0]!.children!;
    assert.equal(kids[0], sibling, "an untouched child is the same object");
    assert.equal((kids[1]!.config as { cue?: string }).cue, "new_name");
  });

  test("changes nothing, and returns the very same layout, when nothing matches", () => {
    const l = layoutOf(cueAt("a", "other"));
    const out = withCueRepointed(l, new Set(["a"]), ["old_name"], "new_name");
    assert.equal(out.count, 0);
    assert.equal(out.layout, l);
  });

  test("never repoints an object that is not a cue Button, whatever it holds", () => {
    const l = layoutOf(obj({ id: "a", config: { type: "label", cue: "old_name" } as unknown as LayoutObject["config"] }));
    assert.equal(withCueRepointed(l, new Set(["a"]), ["old_name"], "new_name").count, 0);
  });
});

describe("repointCueButtons", () => {
  const original = { ...consoleButtonDeps };
  afterEach(() => Object.assign(consoleButtonDeps, original));

  const viewWith = (id: string, name: string, ...objects: LayoutObject[]): View =>
    ({ id, name, kind: "custom", surface: "console", layout: layoutOf(...objects), layoutRev: 4 }) as unknown as View;
  const btn = (id: string, cue: string) => obj({ id, config: { type: "cue-button", cue } });

  test("writes each view once, with its own revision, and reports what each did", async () => {
    const views = [viewWith("a", "Booth", btn("o1", "old"), btn("o2", "old")), viewWith("b", "FOH", btn("o3", "old"))];
    const written: { id: string; rev: number | undefined; cues: unknown[] }[] = [];
    consoleButtonDeps.readViews = async () => views;
    consoleButtonDeps.writeLayout = async (id, layout, rev) => {
      written.push({ id, rev, cues: layout.objects.map((o) => (o.config as { cue?: string }).cue) });
    };
    const results = await repointCueButtons(
      [{ viewId: "a", objectId: "o1" }, { viewId: "a", objectId: "o2" }, { viewId: "b", objectId: "o3" }],
      ["old"],
      "new",
    );
    assert.deepEqual(results.map((r) => [r.name, r.ok, r.count]), [["Booth", true, 2], ["FOH", true, 1]]);
    assert.deepEqual(written, [
      { id: "a", rev: 4, cues: ["new", "new"] },
      { id: "b", rev: 4, cues: ["new"] },
    ]);
  });

  test("a view that refuses is named with the reason, and the next view is still written", async () => {
    consoleButtonDeps.readViews = async () => [viewWith("a", "Booth", btn("o1", "old")), viewWith("b", "FOH", btn("o2", "old"))];
    const wrote: string[] = [];
    consoleButtonDeps.writeLayout = async (id) => {
      if (id === "a") throw Object.assign(new Error("This view was changed by someone else"), { status: 400 });
      wrote.push(id);
    };
    const results = await repointCueButtons([{ viewId: "a", objectId: "o1" }, { viewId: "b", objectId: "o2" }], ["old"], "new");
    assert.deepEqual(results.map((r) => [r.name, r.ok]), [["Booth", false], ["FOH", true]]);
    assert.match(results[0]!.error ?? "", /changed by someone else/);
    assert.deepEqual(wrote, ["b"]);
  });

  test("a 409 is retried once from a fresh read, and a second one is a refusal", async () => {
    let reads = 0;
    consoleButtonDeps.readViews = async () => {
      reads++;
      return [viewWith("a", "Booth", btn("o1", "old"))];
    };
    let writes = 0;
    consoleButtonDeps.writeLayout = async () => {
      writes++;
      if (writes <= 2) throw Object.assign(new Error("stale"), { status: 409 });
    };
    const [r] = await repointCueButtons([{ viewId: "a", objectId: "o1" }], ["old"], "new");
    assert.equal(r!.ok, false);
    assert.equal(reads, 2, "one retry, from a fresh read");
    assert.equal(writes, 2);
  });

  test("a view that no longer exists, or whose Button no longer names the command, is reported or skipped without a write", async () => {
    consoleButtonDeps.readViews = async () => [viewWith("b", "FOH", btn("o2", "already_changed"))];
    let writes = 0;
    consoleButtonDeps.writeLayout = async () => {
      writes++;
    };
    const results = await repointCueButtons([{ viewId: "gone", objectId: "o1" }, { viewId: "b", objectId: "o2" }], ["old"], "new");
    assert.deepEqual(results.map((r) => [r.viewId, r.ok, r.count]), [["gone", false, 0], ["b", true, 0]]);
    assert.match(results[0]!.error ?? "", /no longer exists/);
    assert.equal(writes, 0);
  });
});

describe("repointLogLines", () => {
  const ok = (name: string, count: number) => ({ viewId: name, name, ok: true, count });
  const no = (name: string, error: string) => ({ viewId: name, name, ok: false, count: 0, error });

  test("a short head line with a count and the screens, and a line of its own for each refusal", () => {
    const lines = repointLogLines("old", "new", [ok("Booth", 2), ok("Home", 1), no("FOH", "changed by someone else"), no("Lobby", "no such view")]);
    assert.deepEqual(lines, [
      "renamed old to new; repointed 3 buttons on Booth, Home; 2 refused",
      "could not point the buttons on FOH at new: changed by someone else",
      "could not point the buttons on Lobby at new: no such view",
    ]);
  });

  test("no line can outgrow the log route's 300 characters, and a long reason is still said, cut", () => {
    const long = "x".repeat(600);
    const screens = Array.from({ length: 9 }, (_, i) => `A screen with a rather long name number ${i}`);
    const lines = repointLogLines("old_name", "new_name", [...screens.map((n) => ok(n, 1)), ...screens.map((n) => no(n, long))]);
    for (const l of lines) assert.ok(l.length <= 300, `${l.length} characters: ${l.slice(0, 80)}`);
    assert.ok(lines[0]!.includes("; 9 refused"), "the refused count is cut off the head line");
    assert.ok(lines[1]!.includes("xxxx"), "the reason is gone");
    assert.ok(lines.some((l) => l.startsWith("3 more screens refused")), "refusals past the cap are not counted");
  });

  test("nothing involved, nothing said", () => {
    assert.deepEqual(repointLogLines("a", "b", []), []);
  });

  test("a rename that only some screens took says none were refused by saying nothing of it", () => {
    assert.deepEqual(repointLogLines("a", "b", [ok("Booth", 1)]), ["renamed a to b; repointed 1 button on Booth"]);
  });
});

describe("withCueRepointed with several names", () => {
  test("points a Button on any of the names: the command's own and its former names", () => {
    const l = layoutOf(obj({ id: "a", config: { type: "cue-button", cue: "now" } }), obj({ id: "b", config: { type: "cue-button", cue: "was" } }), obj({ id: "c", config: { type: "cue-button", cue: "other" } }));
    const { layout, count } = withCueRepointed(l, new Set(["a", "b", "c"]), ["now", "was"], "next");
    assert.equal(count, 2);
    assert.deepEqual(layout.objects.map((o) => (o.config as { cue?: string }).cue), ["next", "next", "other"]);
  });
});
