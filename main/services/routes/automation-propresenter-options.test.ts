// The two option sources the ProPresenter macro action's dropdowns read.
//
// The one thing that decides whether an operator can edit a rule on a Tuesday
// is what these answer when a booth machine is OFF. A 5xx here, or a rejected
// promise, closes the rule editor for every rule in the app — not just the ones
// that mention ProPresenter — because the section fetches both on mount.
//
// Driven through the real handler with the real manager: the instance whose
// macros cannot be read points at a port nothing is listening on, so the
// failure is a genuine ECONNREFUSED rather than a stubbed rejection. Nothing
// here knows the address of any real ProPresenter.

import assert from "node:assert/strict";
import { describe, it, before, after, afterEach } from "node:test";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-prop-macro-opts-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { automationRoutes } = await import("./automation-routes.js");
const { callRoute } = await import("./route-harness.js");
const { propresenterService, propresenterManager } = await import("../propresenter-service.js");

const MACROS = [
  { id: { uuid: "u-1", name: "DOORS", index: 0 } },
  { id: { uuid: "u-2", name: "SONG INTRO", index: 1 } },
];

let server: http.Server;
let port = 0;

/** A port nothing listens on — a booth machine that is off. */
const DEAD_PORT = 9;

interface Option {
  value: string;
  label: string;
}

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/v1/macros") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(MACROS));
      return;
    }
    res.writeHead(204);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
});

after(async () => {
  server.close();
  await fs.rm(TMP, { recursive: true, force: true });
});

afterEach(() => {
  propresenterManager.apply(null, []);
  propresenterService.configure("", 0);
  propresenterService.stop();
  clearMacroCache();
});

/** The primary's private cache. The route is allowed to be served from it;
 *  a test that means to exercise a READ has to start cold. */
function clearMacroCache(): void {
  (propresenterService as unknown as { macroCache: unknown }).macroCache = null;
}

function primaryAt(p: number): void {
  propresenterService.configure("127.0.0.1", p);
  propresenterService.stop();
  clearMacroCache();
}

const items = (json: unknown): Option[] => (json as { items: Option[] }).items;

/** Just the macro-list lines. The poller writes its own "unreachable, backing
 *  off" warning into the same window, and that one is not under test here. */
const macroWarnings = (lines: string[]): string[] =>
  lines.filter((l) => l.includes("macro list unavailable"));

/** Run `fn`, collecting what it wrote to console.warn. The log is the only
 *  place the "configured but off" / "never set up" distinction shows. */
async function withWarnings<T>(fn: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
  const warnings: string[] = [];
  const real = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
  try {
    return { result: await fn(), warnings };
  } finally {
    console.warn = real;
  }
}

describe("GET /api/automation/propresenter-instances", () => {
  it("lists the primary even with no extras configured", async () => {
    propresenterManager.apply("MA", []);
    const r = await callRoute(automationRoutes, "/api/automation/propresenter-instances");
    assert.equal(r.status, 200);
    assert.deepEqual(items(r.json), [{ value: "default", label: "MA" }]);
  });

  it("lists the extras beside it, by id and display name", async () => {
    propresenterManager.apply("MA", [
      { id: "chapel", name: "Chapel", host: "127.0.0.1", port: DEAD_PORT, enabled: true },
    ]);
    const r = await callRoute(automationRoutes, "/api/automation/propresenter-instances");
    assert.deepEqual(items(r.json), [
      { value: "default", label: "MA" },
      { value: "chapel", label: "Chapel" },
    ]);
  });
});

describe("GET /api/automation/propresenter-macros", () => {
  it("offers the names, with no suffix when there is only one instance", async () => {
    primaryAt(port);
    propresenterManager.apply("MA", []);
    const r = await callRoute(automationRoutes, "/api/automation/propresenter-macros");
    assert.equal(r.status, 200);
    assert.deepEqual(items(r.json), [
      { value: "DOORS", label: "DOORS" },
      { value: "SONG INTRO", label: "SONG INTRO" },
    ]);
  });

  it("an unreachable ProPresenter yields an EMPTY LIST, not an error", async () => {
    primaryAt(DEAD_PORT);
    propresenterManager.apply("MA", []);
    const r = await callRoute(automationRoutes, "/api/automation/propresenter-macros");
    // 200 with nothing in it. A 500 here would close the rule editor for every
    // rule in the app, because the section fetches this on mount.
    assert.equal(r.status, 200);
    assert.deepEqual(items(r.json), []);
  });

  it("every instance being off is still a 200 with an empty list", async () => {
    primaryAt(DEAD_PORT);
    propresenterManager.apply("MA", [
      { id: "chapel", name: "Chapel", host: "127.0.0.1", port: DEAD_PORT, enabled: true },
    ]);
    const r = await callRoute(automationRoutes, "/api/automation/propresenter-macros");
    assert.equal(r.status, 200);
    assert.deepEqual(items(r.json), []);
  });

  it("one instance being off costs its macros, never the reachable one's", async () => {
    primaryAt(port);
    propresenterManager.apply("MA", [
      { id: "chapel", name: "Chapel", host: "127.0.0.1", port: DEAD_PORT, enabled: true },
    ]);
    const r = await callRoute(automationRoutes, "/api/automation/propresenter-macros");
    assert.equal(r.status, 200);
    // Two instances are configured and only one answered, so each name it did
    // return is marked as living on that one alone — which is true, as far as
    // anything can be known while the other machine is off.
    assert.deepEqual(items(r.json), [
      { value: "DOORS", label: "DOORS (MA only)" },
      { value: "SONG INTRO", label: "SONG INTRO (MA only)" },
    ]);
  });

  it("a name on both instances carries no suffix", async () => {
    primaryAt(port);
    // Both point at the same stub, so both report the same two macros.
    propresenterManager.apply("MA", [
      { id: "chapel", name: "Chapel", host: "127.0.0.1", port, enabled: true },
    ]);
    const r = await callRoute(automationRoutes, "/api/automation/propresenter-macros");
    assert.deepEqual(items(r.json), [
      { value: "DOORS", label: "DOORS" },
      { value: "SONG INTRO", label: "SONG INTRO" },
    ]);
  });

  it("a ProPresenter that was never set up says NOTHING in the log", async () => {
    // The primary has no host. An instance that does not exist yet is not a
    // failure, and must not be reported unreachable — that would put a warning
    // in the log of every site that does not use ProPresenter, every time
    // somebody opened the rule editor. The empty list alone cannot show this:
    // it is empty either way. The log line is the whole difference.
    propresenterService.configure("", 0);
    propresenterService.stop();
    clearMacroCache();
    propresenterManager.apply("MA", []);
    const r = await withWarnings(() =>
      callRoute(automationRoutes, "/api/automation/propresenter-macros"),
    );
    assert.equal(r.result.status, 200);
    assert.deepEqual(items(r.result.json), []);
    assert.deepEqual(macroWarnings(r.warnings), []);
  });

  it("an instance that IS set up and unreachable does say so in the log", async () => {
    // The other half, so the assertion above cannot pass by the warning being
    // unreachable code: a machine that was set up and is off is a real failure
    // and has to leave something for an operator to read.
    primaryAt(DEAD_PORT);
    propresenterManager.apply("MA", []);
    const r = await withWarnings(() =>
      callRoute(automationRoutes, "/api/automation/propresenter-macros"),
    );
    const said = macroWarnings(r.warnings);
    assert.equal(said.length, 1, r.warnings.join(" | "));
    assert.match(said[0], /\[propresenter\] macro list unavailable from MA/);
  });

  it("an unconfigured instance does not mark the real one's macros as 'only'", async () => {
    // The primary is set up; the extra was added and left disabled, so it has no
    // host. Counting it would label every real macro "(MA only)" — true of a
    // machine that is off, a lie about one that does not exist.
    primaryAt(port);
    propresenterManager.apply("MA", [
      { id: "chapel", name: "Chapel", host: "", port: 0, enabled: false },
    ]);
    const r = await callRoute(automationRoutes, "/api/automation/propresenter-macros");
    assert.deepEqual(items(r.json), [
      { value: "DOORS", label: "DOORS" },
      { value: "SONG INTRO", label: "SONG INTRO" },
    ]);
  });

  it("the value is the NAME, never the uuid", async () => {
    primaryAt(port);
    propresenterManager.apply("MA", []);
    const r = await callRoute(automationRoutes, "/api/automation/propresenter-macros");
    // A uuid is per-machine and dies on a re-import; a rule holding one would be
    // dead by Sunday. The stub's uuids are "u-1"/"u-2" precisely so this can say
    // they are nowhere in the answer.
    assert.equal(r.body.includes("u-1"), false, "a uuid reached the dropdown");
    assert.equal(r.body.includes("u-2"), false, "a uuid reached the dropdown");
  });
});
