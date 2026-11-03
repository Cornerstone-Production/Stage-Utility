// What a key says on the picker's page: Companion's text, not the label.
//
// `label` is the collapsed text that import, search and fingerprints key on. `text` is
// what the key SHOWS: line breaks kept, a size and alignment of its own, and the
// `$(connection:name)` variables in it filled from Companion for the page being drawn.
//
// Every fixture here is synthetic. The field names (`fontsize`, `halign`, `valign`,
// `fontsizeAllowShrink`) were read off a real Companion 5 export.
//
//  - PARSING runs the real parsePages over a one-page document.
//  - SUBSTITUTION runs the real companionApi.withLiveText with a stubbed fetch, never a real
//    Companion: a hit, a 404, the cache, which variables are read, the deadline, the cap on
//    reads in flight, and a getTarget that rejects.

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fsp from "node:fs/promises";

process.env.STAGE_UTILITY_DATA = await fsp.mkdtemp(path.join(os.tmpdir(), "companion-page-text-"));

const { companionApi, companionDeps, pageVariableDeps } = await import("./companion-api.js");
const { parsePages, variableRefsIn, substituteVariables } = await import("./companion-export.js");
type CompanionPageKey = import("./companion-export.js").CompanionPageKey;
type CompanionPageView = import("./companion-export.js").CompanionPageView;

const realFetch = companionDeps.fetch;
const realTarget = companionDeps.getTarget;
const realDeadline = pageVariableDeps.deadlineMs;
const realWarn = console.warn;
const realLog = console.log;

// A stuck read holds one of the shared slots until it ends, so a test that sticks one lets it go.
const stuck: Array<() => void> = [];
const stick = (): Promise<Response> => new Promise<Response>((resolve) => stuck.push(() => resolve(new Response("late", { status: 200 }))));

afterEach(async () => {
  for (const release of stuck.splice(0)) release();
  await new Promise((r) => setTimeout(r, 5));
  companionDeps.fetch = realFetch;
  companionDeps.getTarget = realTarget;
  pageVariableDeps.deadlineMs = realDeadline;
  console.warn = realWarn;
  console.log = realLog;
  companionApi.invalidate();
});

// ── Parsing ──────────────────────────────────────────────────────────────────

const layer = (text: string, over: Record<string, unknown> = {}, expression = false) => ({
  type: "text",
  enabled: { value: true, isExpression: false },
  text: { value: text, isExpression: expression },
  fontsize: { value: 23.3, isExpression: false },
  fontsizeAllowShrink: { value: false, isExpression: false },
  halign: { value: "center", isExpression: false },
  valign: { value: "center", isExpression: false },
  ...over,
});
const keyOf = (style: unknown): CompanionPageKey =>
  parsePages({ pages: { "1": { name: "P", controls: { "0": { "0": { type: "button-layered", style } } } } } }).views[0]!.keys[0]!;

describe("a key's text", () => {
  test("a newline, and a typed backslash-n, break the line; the label stays one collapsed line", () => {
    const k = keyOf({ layers: [layer("Alpha  beta\nGamma\\nDelta\r\nEpsilon")] });
    assert.equal(k.text, "Alpha beta\nGamma\nDelta\nEpsilon");
    assert.equal(k.label, "Alpha beta Gamma Delta Epsilon", "the label is the identity string and must stay one collapsed line");
  });

  test("padding blank lines are dropped, one inside is kept", () => {
    assert.equal(keyOf({ layers: [layer("\n  One\n\nTwo  \n\n")] }).text, "One\n\nTwo");
  });

  test("an expression layer is shown as the label shows it, and names no variables", () => {
    const k = keyOf({ layers: [layer('$(a:b) + "x"\n', {}, true)] });
    assert.equal(k.text, '$(a:b) + "x"');
    assert.deepEqual(k.vars, []);
  });

  test("the variables a key names are listed once each, local ones left out", () => {
    const k = keyOf({ layers: [layer("$(Stage_Utility:count) of $(custom:cap) at $(internal:time_hms) $(Stage_Utility:count) $(this:page) $(local:x) $(plain)")] });
    assert.deepEqual(k.vars, ["Stage_Utility:count", "custom:cap", "internal:time_hms"]);
  });
});

describe("a key's size and alignment", () => {
  test("a numeric size is carried, with where the text sits", () => {
    const k = keyOf({ layers: [layer("Hi", { fontsize: { value: 40, isExpression: false }, halign: { value: "left", isExpression: false }, valign: { value: "bottom", isExpression: false } })] });
    assert.deepEqual([k.size, k.halign, k.valign], [40, "left", "bottom"]);
  });

  test("shrink-to-fit is auto: no size", () => {
    const k = keyOf({ layers: [layer("Hi", { fontsize: { value: 100, isExpression: false }, fontsizeAllowShrink: { value: true, isExpression: false } })] });
    assert.equal(k.size, null);
  });

  test("an expression size or alignment is not guessed at", () => {
    const k = keyOf({ layers: [layer("Hi", { fontsize: { value: "$(a:b)", isExpression: true }, halign: { value: "left", isExpression: true } })] });
    assert.deepEqual([k.size, k.halign], [null, null]);
  });

  test("a 3.x flat button's points become the same percentage of the key", () => {
    const k = keyOf({ text: "Hi", size: "18", alignment: "right:top" });
    assert.deepEqual([k.size, k.halign, k.valign], [30, "right", "top"]);
    assert.equal(keyOf({ text: "Hi", size: "auto" }).size, null);
  });

  test("the first layer that SAYS something sets the layout, not an empty one before it", () => {
    const k = keyOf({ layers: [layer("", { fontsize: { value: 90, isExpression: false } }), layer("Hi", { fontsize: { value: 30, isExpression: false } })] });
    assert.equal(k.size, 30);
  });
});

describe("variableRefsIn and substituteVariables", () => {
  test("only a whole `$(...)` is replaced, and an unknown one stays as written", () => {
    const values = new Map([["a:b", "7"]]);
    assert.equal(substituteVariables("n=$(a:b) m=$(a:c) $a:b", values), "n=7 m=$(a:c) $a:b");
    assert.deepEqual(variableRefsIn("no variables here"), []);
  });
});

// ── Substitution ─────────────────────────────────────────────────────────────

const key = (row: number, col: number, text: string): CompanionPageKey => ({
  row,
  col,
  kind: "button",
  label: text,
  text,
  size: null,
  halign: null,
  valign: null,
  vars: variableRefsIn(text),
  bg: null,
  fg: null,
  icon: null,
  pickable: true,
});
const view = (...keys: CompanionPageKey[]): CompanionPageView => ({ page: 1, name: "P", cols: 8, rows: 4, keys });
const textsOf = (v: CompanionPageView) => v.keys.map((k) => k.text);

function serve(values: Record<string, string>): string[] {
  companionDeps.getTarget = async () => ({ host: "10.0.0.5", port: 8000 });
  const urls: string[] = [];
  companionDeps.fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    const m = /\/api\/(?:variable\/([^/]+)\/([^/]+)|custom-variable\/([^/]+))\/value$/.exec(url);
    const ref = m ? (m[3] ? `custom:${m[3]}` : `${m[1]}:${m[2]}`) : "";
    return ref in values ? new Response(values[ref]!, { status: 200 }) : new Response("Not found", { status: 404 });
  };
  return urls;
}

describe("withLiveText", () => {
  test("a module, a custom and an internal variable are replaced by what Companion says", async () => {
    serve({ "Stage_Utility:occupancy": "12", "custom:cap": "40", "internal:time_hms": "10:30:00" });
    const out = await companionApi.withLiveText(view(key(0, 0, "In $(Stage_Utility:occupancy)/$(custom:cap)"), key(0, 1, "$(internal:time_hms)")));
    assert.deepEqual(textsOf(out), ["In 12/40", "10:30:00"]);
  });

  test("a variable Companion does not have stays as written, and says so once on a tagged line", async () => {
    serve({});
    const warned: string[] = [];
    console.warn = (...a: unknown[]) => void warned.push(a.join(" "));
    const v = view(key(0, 0, "Gone $(Nope:missing)"));
    assert.deepEqual(textsOf(await companionApi.withLiveText(v)), ["Gone $(Nope:missing)"]);
    // A second view of the same page, past the cache: still failing, still one line.
    (companionApi as unknown as { pageVariables: Map<string, unknown> }).pageVariables.clear();
    await companionApi.withLiveText(v);
    assert.equal(warned.filter((l) => l.startsWith("[companion]") && l.includes("$(Nope:missing)")).length, 1, warned.join("\n"));
  });

  test("a second view inside the cache window reads nothing", async () => {
    const urls = serve({ "A:x": "1" });
    const v = view(key(0, 0, "$(A:x)"));
    await companionApi.withLiveText(v);
    assert.equal((await companionApi.withLiveText(v)).keys[0]!.text, "1");
    assert.equal(urls.length, 1, "the second view read Companion again");
  });

  test("only the variables of the page being drawn are read, once each", async () => {
    const urls = serve({ "A:x": "1", "B:y": "2" });
    await companionApi.withLiveText(view(key(0, 0, "$(A:x) $(A:x)"), key(0, 1, "$(B:y)"), key(0, 2, "plain")));
    assert.deepEqual(urls.sort(), ["http://10.0.0.5:8000/api/variable/A/x/value", "http://10.0.0.5:8000/api/variable/B/y/value"]);
  });

  test("a page with no variables reads nothing and is returned as it came", async () => {
    const urls = serve({});
    const v = view(key(0, 0, "plain"));
    assert.equal(await companionApi.withLiveText(v), v);
    assert.equal(urls.length, 0);
  });

  test("reads run in parallel, never more than four at once", async () => {
    companionDeps.getTarget = async () => ({ host: "10.0.0.5", port: 8000 });
    let live = 0;
    let peak = 0;
    companionDeps.fetch = async () => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 15));
      live--;
      return new Response("v", { status: 200 });
    };
    const keys = Array.from({ length: 12 }, (_, i) => key(0, i, `$(L:v${i})`));
    const out = await companionApi.withLiveText(view(...keys));
    assert.equal(out.keys.every((k) => k.text === "v"), true);
    assert.ok(peak > 1, "the reads ran one after another");
    assert.ok(peak <= 4, `${peak} reads were in flight at once`);
  });

  test("a read that never answers does not hold the page past the deadline", { timeout: 5000 }, async () => {
    companionDeps.getTarget = async () => ({ host: "10.0.0.5", port: 8000 });
    pageVariableDeps.deadlineMs = 60;
    // Ignores its abort signal, as a stuck socket might: only the page's own deadline can end the wait.
    companionDeps.fetch = async (input) => (String(input).includes("/Slow/") ? stick() : new Response("fast", { status: 200 }));
    const started = Date.now();
    const out = await companionApi.withLiveText(view(key(0, 0, "$(Slow:s)"), key(0, 1, "$(Quick:q)")));
    assert.ok(Date.now() - started < 1500, "the page waited on the stuck read");
    assert.deepEqual(textsOf(out), ["$(Slow:s)", "fast"]);
  });

  test("two overlapping views of a hung Companion never have more than four reads out in all", async () => {
    companionDeps.getTarget = async () => ({ host: "10.0.0.5", port: 8000 });
    pageVariableDeps.deadlineMs = 40;
    let live = 0;
    let peak = 0;
    companionDeps.fetch = () => {
      live++;
      peak = Math.max(peak, live);
      return stick().finally(() => live--);
    };
    const page = (p: string) => view(...Array.from({ length: 12 }, (_, i) => key(0, i, `$(${p}:v${i})`)));
    await Promise.all([companionApi.withLiveText(page("A")), companionApi.withLiveText(page("B"))]);
    assert.equal(peak, 4, `${peak} reads were in flight at once across two views`);
  });

  test("after the deadline a view starts no new read", async () => {
    companionDeps.getTarget = async () => ({ host: "10.0.0.5", port: 8000 });
    pageVariableDeps.deadlineMs = 30;
    let started = 0;
    companionDeps.fetch = async () => {
      started++;
      await new Promise((r) => setTimeout(r, 80));
      return new Response("v", { status: 200 });
    };
    const keys = Array.from({ length: 12 }, (_, i) => key(0, i, `$(D:v${i})`));
    await companionApi.withLiveText(view(...keys));
    // The four reads out finish after the deadline; the other eight must not follow them.
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(started, 4, `${started} reads started for a view that gave up after four`);
  });

  test("a view during a read already out for the same variable joins it", async () => {
    companionDeps.getTarget = async () => ({ host: "10.0.0.5", port: 8000 });
    let calls = 0;
    companionDeps.fetch = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 40));
      return new Response("7", { status: 200 });
    };
    const v = view(key(0, 0, "$(J:x)"));
    const [a, b] = await Promise.all([companionApi.withLiveText(v), companionApi.withLiveText(v)]);
    assert.equal(calls, 1, "the variable was read once per view");
    assert.deepEqual([textsOf(a), textsOf(b)], [["7"], ["7"]]);
  });

  test("a read of the old Companion lands after invalidate() and is not remembered for the new one", async () => {
    companionDeps.getTarget = async () => ({ host: "10.0.0.5", port: 8000 });
    companionDeps.fetch = async () => {
      await new Promise((r) => setTimeout(r, 30));
      return new Response("old", { status: 200 });
    };
    const v = view(key(0, 0, "$(H:x)"));
    const first = companionApi.withLiveText(v);
    await new Promise((r) => setTimeout(r, 5));
    companionApi.invalidate();
    await first;
    companionDeps.fetch = async () => new Response("new", { status: 200 });
    assert.equal((await companionApi.withLiveText(v)).keys[0]!.text, "new");
  });

  test("a huge value is cut at 200 characters and ends in an ellipsis; a value of exactly 200 is whole", async () => {
    serve({ "A:big": "x".repeat(5000), "A:edge": "y".repeat(200) });
    const out = await companionApi.withLiveText(view(key(0, 0, "$(A:big)"), key(0, 1, "$(A:edge)")));
    assert.equal(out.keys[0]!.text, `${"x".repeat(200)}\u2026`);
    assert.equal(out.keys[1]!.text, "y".repeat(200));
  });

  test("a getTarget that rejects leaves the text as written and does not throw", async () => {
    companionDeps.getTarget = async () => {
      throw new Error("config store gone");
    };
    console.warn = () => {};
    const out = await companionApi.withLiveText(view(key(0, 0, "$(A:x)")));
    assert.deepEqual(textsOf(out), ["$(A:x)"]);
  });

  test("the cached export's view is not changed", async () => {
    serve({ "A:x": "1" });
    const v = view(key(0, 0, "$(A:x)"));
    await companionApi.withLiveText(v);
    assert.equal(v.keys[0]!.text, "$(A:x)");
  });
});
