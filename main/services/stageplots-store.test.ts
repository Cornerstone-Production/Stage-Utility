import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stageplots-store-"));
process.env.STAGE_UTILITY_DATA = TMP;

const {
  checkStagePlotsDoc,
  validateVenueInput,
  validatePlotInput,
  validateItems,
  checkItems,
  limitProblem,
  stageplotsStore,
  applyOverride,
  readOverrideChange,
  normalizeStagePlots,
} = await import("./stageplots-store.js");
const { SYMBOL_KINDS } = await import("../types/stageplots.js");
const { restoreCheckFor } = await import("./store-registry.js");

const HASH = "0123456789abcdef";

function background(id = "b-1") {
  return {
    id,
    name: "Plan",
    original: { hash: HASH, mime: "image/png", bytes: 1000 },
    source: { hash: HASH, ext: "png" },
    converted: { hash: "fedcba9876543210", width: 2400, height: 1600, bytes: 400_000 },
    cleanup: true,
    pdfPage: null,
    pdfPages: null,
  };
}

function goodDoc() {
  return {
    venues: [{ id: "v-1", name: "Main room", kind: "home", notes: "", plotIds: ["p-1"], defaultPlotId: "p-1" }],
    backgrounds: [background()],
    plots: [{ id: "p-1", venueId: "v-1", name: "Standard", backgroundId: "b-1" as string | null, bgFade: 0.4, items: [], version: 1 }],
  };
}

function refusal(raw: unknown): string {
  try {
    checkStagePlotsDoc(raw);
  } catch (err) {
    return (err as Error).message;
  }
  assert.fail("expected a refusal");
}

describe("stageplots store restore check", () => {
  test("the store is registered with its restore check", async () => {
    const check = restoreCheckFor("stageplots.json");
    assert.ok(check, "stageplots.json has no restore check");
    assert.deepEqual(await check(goodDoc()), { ok: true, value: { ...goodDoc(), overrides: [] } });
  });

  test("restore check accepts the empty doc", () => {
    assert.deepEqual(checkStagePlotsDoc({ venues: [], backgrounds: [], plots: [], overrides: [] }), { venues: [], backgrounds: [], plots: [], overrides: [] });
  });

  test("restore check refuses a plot whose venueId is unknown", () => {
    const doc = goodDoc();
    doc.plots[0].venueId = "v-nowhere";
    assert.match(refusal(doc), /plot "p-1".*venue/);
  });

  test("restore check refuses a venue whose defaultPlotId is not one of its plotIds", () => {
    const doc = goodDoc();
    doc.venues[0].defaultPlotId = "p-9";
    assert.match(refusal(doc), /default plot/);
  });

  test("restore check refuses a venue with plots and no default", () => {
    const doc = goodDoc();
    (doc.venues[0] as { defaultPlotId: string | null }).defaultPlotId = null;
    assert.match(refusal(doc), /default plot/);
  });

  test("restore check refuses a plot its venue does not list", () => {
    const doc = goodDoc();
    doc.plots.push({ id: "p-2", venueId: "v-1", name: "Other", backgroundId: null, bgFade: 0, items: [], version: 0 });
    assert.match(refusal(doc), /p-2/);
  });

  test("restore check refuses a plot whose background is unknown", () => {
    const doc = goodDoc();
    doc.plots[0].backgroundId = "b-gone";
    assert.match(refusal(doc), /background/);
  });

  test("restore check refuses a background with a hash that is not 16 hex chars", () => {
    const doc = goodDoc();
    doc.backgrounds[0].converted.hash = "../../etc/passwd";
    assert.match(refusal(doc), /hash/);
    const long = goodDoc();
    long.backgrounds[0].source.hash = HASH + HASH;
    assert.match(refusal(long), /hash/);
  });

  test("restore check refuses a background whose original is not png, jpeg or pdf", () => {
    const doc = goodDoc();
    doc.backgrounds[0].original.mime = "image/svg+xml";
    assert.match(refusal(doc), /original/);
  });

  test("restore check refuses a fade outside 0 to 1", () => {
    const doc = goodDoc();
    doc.plots[0].bgFade = 2;
    assert.match(refusal(doc), /fade/);
  });

  test("restore check refuses an id that could not go in a URL", () => {
    const doc = goodDoc();
    doc.venues[0].id = "v/../1";
    assert.match(refusal(doc), /id/);
  });

  test("limits: the 51st venue is refused", () => {
    const venues = Array.from({ length: 50 }, (_, i) => ({ id: `v-${i}`, name: `Room ${i}`, kind: "home", notes: "", plotIds: [], defaultPlotId: null }));
    const doc = { venues, backgrounds: [], plots: [] };
    assert.deepEqual(checkStagePlotsDoc(doc).venues.length, 50);
    assert.match(limitProblem(checkStagePlotsDoc(doc), "venue") ?? "", /50 venues/);
    const over = { ...doc, venues: [...venues, { ...venues[0], id: "v-50" }] };
    assert.match(refusal(over), /50 venues/);
  });

  test("limits: the 21st plot in a venue and the 51st background are refused", () => {
    const plots = Array.from({ length: 20 }, (_, i) => ({ id: `p-${i}`, venueId: "v-1", name: `Plot ${i}`, backgroundId: null, bgFade: 0, items: [], version: 0 }));
    const doc = checkStagePlotsDoc({
      venues: [{ id: "v-1", name: "Main", kind: "home", notes: "", plotIds: plots.map((p) => p.id), defaultPlotId: "p-0" }],
      backgrounds: Array.from({ length: 50 }, (_, i) => background(`b-${i}`)),
      plots,
    });
    assert.match(limitProblem(doc, "plot", "v-1") ?? "", /20 plots/);
    assert.match(limitProblem(doc, "background") ?? "", /50 backgrounds/);
    assert.equal(limitProblem(doc, "venue"), null);
  });
});

/** goodDoc with a second venue and plots, and `overrides`. */
function withOverrides(overrides: unknown[]) {
  return {
    venues: [
      { id: "v-1", name: "Main room", kind: "home", notes: "", plotIds: ["p-1", "p-2"], defaultPlotId: "p-1" },
      { id: "v-2", name: "Chapel", kind: "home", notes: "", plotIds: ["p-3"], defaultPlotId: "p-3" },
    ],
    backgrounds: [],
    plots: [
      { id: "p-1", venueId: "v-1", name: "Standard", backgroundId: null, bgFade: 0.4, items: [], version: 0 },
      { id: "p-2", venueId: "v-1", name: "Baptism", backgroundId: null, bgFade: 0.4, items: [], version: 0 },
      { id: "p-3", venueId: "v-2", name: "Chapel", backgroundId: null, bgFade: 0.4, items: [], version: 0 },
    ],
    overrides,
  };
}

describe("stageplots overrides in the restore check", () => {
  const ov = (o: Record<string, unknown> = {}) => ({ planId: "101", venueId: "v-1", plotId: "p-2", planDate: "2026-11-16T15:00:00Z", ...o });

  test("a doc without overrides restores and reads as []", async () => {
    const { overrides: _, ...old } = withOverrides([]);
    assert.equal("overrides" in old, false);
    assert.deepEqual(checkStagePlotsDoc(old).overrides, []);
    const check = restoreCheckFor("stageplots.json")!;
    const r = await check(old);
    assert.equal(r.ok, true);
    assert.deepEqual((r as { value: { overrides: unknown } }).value.overrides, []);
  });

  test("a good override passes, its date as an ISO instant", () => {
    assert.deepEqual(checkStagePlotsDoc(withOverrides([ov()])).overrides, [
      { planId: "101", venueId: "v-1", plotId: "p-2", planDate: "2026-11-16T15:00:00.000Z" },
    ]);
    assert.deepEqual(checkStagePlotsDoc(withOverrides([ov({ planDate: null })])).overrides[0].planDate, null);
  });

  test("restore check refuses an override to an unknown venue", () => {
    assert.match(refusal(withOverrides([ov({ venueId: "v-gone" })])), /override for plan "101" names a venue that does not exist/);
  });

  test("restore check refuses an override to an unknown plot, or to another venue's plot", () => {
    assert.match(refusal(withOverrides([ov({ plotId: "p-gone" })])), /override for plan "101" names a plot that is not one of venue "v-1"'s/);
    assert.match(refusal(withOverrides([ov({ plotId: "p-3" })])), /override for plan "101" names a plot that is not one of venue "v-1"'s/);
  });

  test("restore check refuses two overrides for one plan and venue", () => {
    assert.match(refusal(withOverrides([ov(), ov({ plotId: "p-1" })])), /plan "101" has more than one override for venue "v-1"/);
    // One plan, two venues, is two overrides.
    assert.equal(checkStagePlotsDoc(withOverrides([ov(), ov({ venueId: "v-2", plotId: "p-3" })])).overrides.length, 2);
  });

  test("restore check refuses a bad plan id, a date that is not one, and a list past the limit", () => {
    assert.match(refusal(withOverrides([ov({ planId: "1/../2" })])), /plan id/);
    assert.match(refusal(withOverrides([ov({ planDate: "next sunday" })])), /date/);
    assert.match(refusal(withOverrides([ov({ planDate: 20261116 })])), /date/);
    assert.match(refusal(withOverrides([ov({ planDate: "2026-11-16T15:00:00Z".padEnd(41, " ") })])), /date/);
    assert.match(refusal({ ...withOverrides([]), overrides: "none" }), /overrides must be a list/);
    const many = Array.from({ length: 2001 }, (_, i) => ov({ planId: String(1000 + i) }));
    assert.match(refusal(withOverrides(many)), /at most 2000 overrides/);
  });

  test("a plan date must be a full date and time: a bare date is midnight UTC, the day before in the Americas", () => {
    assert.match(refusal(withOverrides([ov({ planDate: "2026-11-15" })])), /date and time/);
    const r = readOverrideChange({ planId: "101", venueId: "v-1", plotId: "p-2", planDate: "2026-11-15" });
    assert.match((r as { problem: string }).problem, /date and time/);
    assert.equal((readOverrideChange({ planId: "101", venueId: "v-1", plotId: "p-2", planDate: "2026-11-15T09:00:00-06:00" }) as { planDate: string }).planDate, "2026-11-15T15:00:00.000Z");
  });

  test("a new override goes in at its sorted place on the write itself", () => {
    const doc = checkStagePlotsDoc(withOverrides([ov({ planId: "200" })]));
    const next = applyOverride(doc, { planId: "100", venueId: "v-1", plotId: "p-2", planDate: null });
    assert.ok("doc" in next, JSON.stringify(next));
    assert.deepEqual(
      next.doc.overrides.map((o) => o.planId),
      ["100", "200"],
    );
    assert.equal(next.plotName, "Baptism");
    assert.equal(next.venueName, "Main room");
  });

  test("a stored overrides that is not a list reads as none, and says so on [stageplots]", (t) => {
    const warned: string[] = [];
    t.mock.method(console, "warn", (...a: unknown[]) => void warned.push(a.join(" ")));
    const { overrides: _, ...old } = withOverrides([]);
    assert.deepEqual(normalizeStagePlots(old as unknown as Parameters<typeof normalizeStagePlots>[0]).overrides, []);
    assert.equal(warned.length, 0, "a document from before overrides is not a problem to report");
    assert.deepEqual(normalizeStagePlots({ ...old, overrides: { "101": "p-2" } } as unknown as Parameters<typeof normalizeStagePlots>[0]).overrides, []);
    assert.equal(warned.filter((w) => w.startsWith("[stageplots]") && /overrides/.test(w)).length, 1, warned.join(" | "));
  });

  test("overrides come out sorted by plan, then venue, and pass the check again unchanged", () => {
    const once = checkStagePlotsDoc(
      withOverrides([ov({ planId: "300" }), ov({ planId: "200", venueId: "v-2", plotId: "p-3" }), ov({ planId: "200" })]),
    );
    assert.deepEqual(
      once.overrides.map((o) => `${o.planId} ${o.venueId}`),
      ["200 v-1", "200 v-2", "300 v-1"],
    );
    assert.deepEqual(checkStagePlotsDoc(JSON.parse(JSON.stringify(once))), once);
  });
});

describe("stageplots input validation", () => {
  test("validateVenueInput refuses a 61-char name and a kind other than home/offsite", () => {
    assert.equal(validateVenueInput({ name: "Main", kind: "home", notes: "" }, { partial: false }), null);
    assert.match(validateVenueInput({ name: "x".repeat(61), kind: "home", notes: "" }, { partial: false }) ?? "", /60/);
    assert.match(validateVenueInput({ name: "Main", kind: "garage", notes: "" }, { partial: false }) ?? "", /home or offsite/);
    assert.match(validateVenueInput({ name: "   ", kind: "home" }, { partial: false }) ?? "", /name/);
    assert.match(validateVenueInput({ notes: "x".repeat(501) }, { partial: true }) ?? "", /500/);
    assert.match(validateVenueInput({ kind: "home" }, { partial: false }) ?? "", /name/);
    assert.equal(validateVenueInput({ kind: "offsite" }, { partial: true }), null);
    assert.match(validateVenueInput([], { partial: true }) ?? "", /object/);
  });

  test("validatePlotInput refuses a bad name, fade and background id", () => {
    assert.equal(validatePlotInput({ name: "Standard", bgFade: 0.4, backgroundId: null }, { partial: true }), null);
    assert.match(validatePlotInput({ name: "" }, { partial: true }) ?? "", /name/);
    assert.match(validatePlotInput({ bgFade: 1.5 }, { partial: true }) ?? "", /fade/);
    assert.match(validatePlotInput({ bgFade: "0.4" }, { partial: true }) ?? "", /fade/);
    assert.match(validatePlotInput({ backgroundId: 7 }, { partial: true }) ?? "", /background/);
    assert.match(validatePlotInput({}, { partial: false }) ?? "", /name/);
  });
});

describe("stageplots store", () => {
  test("update persists through the DataStore and get reads it back", async () => {
    assert.deepEqual(await stageplotsStore.get(), { venues: [], backgrounds: [], plots: [], overrides: [] });
    await stageplotsStore.update((d) => ({ ...d, venues: [{ id: "v-1", name: "Main", kind: "home", notes: "", plotIds: [], defaultPlotId: null }] }));
    const onDisk = JSON.parse(await fs.readFile(path.join(TMP, "stageplots.json"), "utf8"));
    assert.equal(onDisk.venues[0].name, "Main");
    assert.equal((await stageplotsStore.get()).venues.length, 1);
  });
});

/** A valid item of each kind, on a 1000 x 562.5 plot. */
function item(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "i-1", type: "box", x: 100, y: 100, w: 80, h: 60, rotation: 0, label: "Riser", color: null, notes: "", inputs: [], ...over };
}
const H = 562.5;

describe("stage plot items", () => {
  test("a good item of every type and every symbol passes", () => {
    const items = [
      item({ id: "a", type: "box" }),
      item({ id: "b", type: "circle", color: "#0091ff" }),
      item({ id: "c", type: "zone", rotation: 180 }),
      item({ id: "d", type: "cable", points: [[10, 10], [200, 300]], dashed: true, x: 10, y: 10, w: 190, h: 290 }),
      item({ id: "e", type: "conn", inputs: ["Kick In", "Kick Out"] }),
      item({ id: "f", type: "text", textKind: "callout" }),
      ...SYMBOL_KINDS.map((k, i) => item({ id: `s${i}`, type: "symbol", symbol: k })),
    ];
    assert.equal(validateItems(items, H), null);
  });

  test("an unknown type, symbol, text kind or colour is refused", () => {
    assert.match(validateItems([item({ type: "triangle" })], H) ?? "", /type/);
    assert.match(validateItems([item({ type: "symbol", symbol: "harp" })], H) ?? "", /symbol/);
    assert.match(validateItems([item({ type: "symbol" })], H) ?? "", /symbol/);
    assert.match(validateItems([item({ type: "text", textKind: "banner" })], H) ?? "", /text kind/);
    assert.match(validateItems([item({ color: "#123456" })], H) ?? "", /colou?r/);
    assert.match(validateItems([item({ color: "red" })], H) ?? "", /colou?r/);
  });

  test("geometry must be finite and inside the plot", () => {
    for (const [over, why] of [
      [{ x: Number.NaN }, /x/],
      [{ x: -1 }, /x/],
      [{ x: 1000.5 }, /x/],
      [{ y: H + 1 }, /y/],
      [{ w: 7 }, /width/],
      [{ h: 1001 }, /height/],
      [{ rotation: -180 }, /rotation/],
      [{ rotation: 181 }, /rotation/],
      [{ rotation: Number.POSITIVE_INFINITY }, /rotation/],
    ] as const) {
      assert.match(validateItems([item(over)], H) ?? "", why, JSON.stringify(over));
    }
    assert.equal(validateItems([item({ x: 1000, y: H, rotation: 180 })], H), null);
  });

  test("text, inputs and counts are bounded", () => {
    assert.match(validateItems([item({ label: "x".repeat(61) })], H) ?? "", /60/);
    assert.match(validateItems([item({ notes: "x".repeat(501) })], H) ?? "", /500/);
    assert.match(validateItems([item({ inputs: Array.from({ length: 65 }, () => "In") })], H) ?? "", /64/);
    assert.match(validateItems([item({ inputs: ["x".repeat(41)] })], H) ?? "", /40/);
    assert.match(validateItems([item({ inputs: [3] })], H) ?? "", /input/);
    const many = Array.from({ length: 501 }, (_, i) => item({ id: `i-${i}` }));
    assert.match(validateItems(many, H) ?? "", /500 items/);
    assert.equal(validateItems(many.slice(0, 500), H), null);
    assert.match(validateItems([item(), item()], H) ?? "", /more than once/);
    assert.match(validateItems([item({ id: "a/b" })], H) ?? "", /id/);
    assert.match(validateItems("items", H) ?? "", /list/);
  });

  test("a cable has 2 to 50 points, each inside the plot", () => {
    const cable = (points: unknown) => item({ type: "cable", points, dashed: false });
    assert.match(validateItems([cable([[1, 1]])], H) ?? "", /2 to 50 points/);
    assert.match(validateItems([cable(Array.from({ length: 51 }, () => [1, 1]))], H) ?? "", /2 to 50 points/);
    assert.match(validateItems([cable([[1, 1], [2, H + 5]])], H) ?? "", /point/);
    assert.match(validateItems([cable([[1, 1], [2]])], H) ?? "", /point/);
    assert.match(validateItems([item({ type: "cable", points: [[1, 1], [9, 9]] })], H) ?? "", /dashed/);
  });

  test("an item is rebuilt field by field: an unknown field is dropped, a type's own fields only on that type", () => {
    const [box] = checkItems([item({ symbol: "piano", points: [[0, 0]], dashed: true, secret: "x" })], H, "the plot");
    assert.deepEqual(Object.keys(box).sort(), ["color", "h", "id", "inputs", "label", "notes", "rotation", "type", "w", "x", "y"]);
  });

  test("a refusal states its bound rounded inward, never as the value it refused", () => {
    // A 3:2 plot is 666.666… high: 666.7 is outside it and must not read as allowed.
    assert.match(validateItems([item({ y: 666.7 })], 2000 / 3) ?? "", /from 0 to 666\.6$/);
    assert.equal(validateItems([item({ y: 666.6 })], 2000 / 3), null);
  });

  test("checkItems' output passes checkItems again, a full-height cable on a 3:2 plot included", () => {
    const H32 = 2000 / 3;
    const items = [
      item({ type: "cable", points: [[10, 0], [10, H32]], dashed: false, x: 10, y: 0, w: 0, h: H32 }),
      item({ id: "i-2", type: "box", y: 600 }),
    ];
    const once = checkItems(items, H32, "the plot");
    assert.ok(once[0].h <= H32, `the cable's box is ${once[0].h} high`);
    assert.deepEqual(checkItems(once, H32, "the plot"), once);
  });

  test("a cable's client box is never checked, only derived: a box past the plot is not a refusal", () => {
    const [cable] = checkItems([item({ type: "cable", points: [[10, 20], [300, 120]], dashed: true, x: -5, y: 9999, w: 5000, h: -3 })], H, "the plot");
    assert.deepEqual([cable.x, cable.y, cable.w, cable.h], [10, 20, 290, 100]);
  });

  test("a cable's box and turn are its points', whatever the client sent", () => {
    const [cable] = checkItems(
      [item({ type: "cable", points: [[10, 20], [300, 120]], dashed: true, x: 900, y: 400, w: 5, h: 5, rotation: 45 })],
      H,
      "the plot",
    );
    assert.deepEqual([cable.x, cable.y, cable.w, cable.h, cable.rotation], [10, 20, 290, 100, 0]);
  });

  test("the restore check holds a plot's items to the same rules, against its own height", () => {
    const doc = goodDoc();
    (doc.plots[0] as { items: unknown[] }).items = [item({ y: 600 })];
    // The background is 2400 x 1600: a plot 666.7 units high, so y 600 is inside.
    assert.equal(checkStagePlotsDoc(doc).plots[0].items.length, 1);
    doc.plots[0].backgroundId = null;
    doc.backgrounds = [];
    assert.match(refusal(doc), /y/);
    const bad = goodDoc();
    (bad.plots[0] as { items: unknown[] }).items = [item({ type: "triangle" })];
    assert.match(refusal(bad), /plot "p-1".*type/);
  });
});
