// The hourly reconcile actually puts the connection health on the row.
//
// This is the wiring, not the pieces. `healthReport()` is covered pure in
// companion-connections.test.ts and `setCompanionOutbound()` is covered on the
// real manager in companion-connection-row.test.ts — and with both of those
// green, deleting `await reportConnectionHealth()` from runCompanionReconcile
// left the ENTIRE suite passing. The feature could have been cut out of the
// production path and CI would have said nothing, which is verbatim the failure
// CLAUDE.md names: green tests over the pieces and a broken path through them.
//
// So this runs the REAL runCompanionReconcile against a stubbed fetch and reads
// the row off the REAL integrationManager afterwards. Nothing here asserts what
// the sentence says; that is the pure test's job. It asserts only that the pass
// asked Companion and that the answer arrived.
//
// The reconcile is driven with NO cues in the rules file, which is what an empty
// data directory gives. Every cue-following branch is covered by
// companion-reconcile.test.ts over the pure pass; what is left is exactly the
// health call and the early return above it.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

process.env.STAGE_UTILITY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "companion-reconcile-health-"));

const { companionApi, companionDeps } = await import("./companion-api.js");
const { runCompanionReconcile, resetConnectionHealthLog } = await import("./companion-reconcile.js");
const { integrationManager } = await import("./integration-manager.js");
const { companionExportFixture } = await import("./fixtures/companion-export.js");

const realFetch = companionDeps.fetch;
const realTarget = companionDeps.getTarget;

/** Six connections: three good, two in error, one disabled. */
const CONNECTIONS = [
  { id: "a", label: "Projector", moduleId: "generic-pjlink", enabled: true, status: { category: "good", level: "ok", message: null } },
  { id: "b", label: "TV-1", moduleId: "vizio-smartcast", enabled: true, status: { category: "good", level: "ok", message: null } },
  { id: "c", label: "TV-2", moduleId: "vizio-smartcast", enabled: true, status: { category: "good", level: "ok", message: null } },
  { id: "d", label: "Bulb-1", moduleId: "tplink-kasasmartbulb", enabled: true, status: { category: "error", level: "Connecting", message: null } },
  { id: "e", label: "Bulb-2", moduleId: "tplink-kasasmartbulb", enabled: true, status: { category: "error", level: "Connecting", message: null } },
  { id: "f", label: "Old-TV", moduleId: "vizio-smartcast", enabled: false, status: null },
];

const states = (
  integrationManager as unknown as {
    states: Map<string, { id: string; enabled: boolean; connection: string; message: string | null; config: Record<string, unknown> }>;
  }
).states;

const message = () => integrationManager.getStates().find((s) => s.id === "companion")?.message ?? null;

/** Answer the export and the connection list; refuse anything else loudly. */
function serve(connections: () => Response): void {
  companionDeps.getTarget = async () => ({ host: "10.0.0.5", port: 8000 });
  companionDeps.fetch = async (input) => {
    const url = String(input);
    if (url.includes("/api/connections")) return connections();
    if (url.includes("/int/export/full")) return Response.json(companionExportFixture());
    throw new Error(`the reconcile asked for something unexpected: ${url}`);
  };
}

beforeEach(() => {
  states.set("companion", {
    id: "companion",
    enabled: true,
    connection: "disconnected",
    message: null,
    config: { host: "10.0.0.5", port: 8000 },
  });
  integrationManager.setCompanionClients(0);
  integrationManager.setCompanionOutbound(null);
  companionApi.invalidate();
  resetConnectionHealthLog();
});

afterEach(() => {
  companionDeps.fetch = realFetch;
  companionDeps.getTarget = realTarget;
  companionApi.invalidate();
});

describe("runCompanionReconcile and the connection health", () => {
  test("a real pass puts the health on the row", async () => {
    serve(() => Response.json(CONNECTIONS));

    assert.equal(message(), null, "the row was not clean before the pass");
    const run = await runCompanionReconcile();

    assert.notEqual(run, null, "the pass could not read the export");
    assert.equal(message(), "2 of 5 connection(s) in error");
  });

  test("a Companion too old for the endpoint leaves the row alone, not wrong", async () => {
    serve(() => new Response("Not found", { status: 404 }));

    await runCompanionReconcile();

    assert.equal(message(), null);
  });

  // The pass has to ASK. A cached list from a minute ago is fine; a pass that
  // never dialled at all is the feature missing.
  test("the pass reads Companion's connection list", async () => {
    const asked: string[] = [];
    companionDeps.getTarget = async () => ({ host: "10.0.0.5", port: 8000 });
    companionDeps.fetch = async (input) => {
      const url = String(input);
      asked.push(url);
      if (url.includes("/api/connections")) return Response.json(CONNECTIONS);
      return Response.json(companionExportFixture());
    };

    await runCompanionReconcile();

    assert.equal(
      asked.filter((u) => u.endsWith("/api/connections")).length,
      1,
      `the pass never asked for the connection list; it asked for ${asked.join(", ")}`,
    );
  });

  // An unreadable export returns null before anything else happens, and the row
  // must not then be told about connections nobody read.
  test("an unreadable export changes the row not at all", async () => {
    integrationManager.setCompanionOutbound("5 connection(s) ok");
    companionDeps.getTarget = async () => ({ host: "10.0.0.5", port: 8000 });
    companionDeps.fetch = async () => new Response("nope", { status: 500 });

    assert.equal(await runCompanionReconcile(), null);
    assert.equal(message(), "5 connection(s) ok");
  });
});

/**
 * The hourly line, which an install with a permanent fault would otherwise get
 * twenty-four times a day.
 *
 * The reason a CLEAN read is silent — "52 connection(s) ok twenty-four times a
 * day is what buries the pass that found twelve in error" — applies harder to a
 * fault that does not move. The install this was built against sits permanently
 * at twelve in error, so the rule as first written buried exactly the pass it
 * was meant to protect.
 *
 * console.warn is captured rather than the /log buffer: the buffer is what
 * console.warn feeds (see log-buffer.ts), and reading the buffer here would test
 * two things at once and pass if either wrote.
 */
describe("the hourly health line", () => {
  const warnings: string[] = [];
  const realWarn = console.warn;

  const capture = (): void => {
    warnings.length = 0;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
  };
  const release = (): void => {
    console.warn = realWarn;
  };

  const health = () => warnings.filter((w) => w.includes("connection(s)"));

  test("an unchanged fault is written ONCE, not once an hour", async () => {
    serve(() => Response.json(CONNECTIONS));
    capture();
    try {
      await runCompanionReconcile();
      await runCompanionReconcile();
      await runCompanionReconcile();
    } finally {
      release();
    }
    assert.deepEqual(health(), ["[companion] 2 of 5 connection(s) in error: 2 tplink-kasasmartbulb (Connecting)"]);
  });

  test("a fault that MOVES is written again — that is the pass worth reading", async () => {
    let worse = false;
    companionDeps.getTarget = async () => ({ host: "10.0.0.5", port: 8000 });
    companionDeps.fetch = async (input) => {
      const url = String(input);
      if (!url.includes("/api/connections")) return Response.json(companionExportFixture());
      return Response.json(
        worse
          ? CONNECTIONS.map((c) =>
              c.id === "c" ? { ...c, status: { category: "error", level: "Connecting", message: null } } : c,
            )
          : CONNECTIONS,
      );
    };
    capture();
    try {
      await runCompanionReconcile();
      worse = true;
      companionApi.invalidate();
      await runCompanionReconcile();
    } finally {
      release();
    }
    assert.equal(health().length, 2, `expected two lines, got ${JSON.stringify(health())}`);
    assert.match(health()[1]!, /3 of 5 connection\(s\) in error/);
  });

  // Otherwise a fault that is fixed and then returns is silent forever, matched
  // against a line from hours ago.
  test("a fault that clears and returns is written again", async () => {
    const clean = CONNECTIONS.map((c) => ({
      ...c,
      status: c.enabled ? { category: "good", level: "ok", message: null } : c.status,
    }));
    let broken = true;
    companionDeps.getTarget = async () => ({ host: "10.0.0.5", port: 8000 });
    companionDeps.fetch = async (input) => {
      const url = String(input);
      if (!url.includes("/api/connections")) return Response.json(companionExportFixture());
      return Response.json(broken ? CONNECTIONS : clean);
    };
    capture();
    try {
      await runCompanionReconcile();
      broken = false;
      companionApi.invalidate();
      await runCompanionReconcile();
      broken = true;
      companionApi.invalidate();
      await runCompanionReconcile();
    } finally {
      release();
    }
    assert.equal(health().length, 2, `expected two lines, got ${JSON.stringify(health())}`);
  });

  test("a clean read writes nothing at all, however many passes", async () => {
    const clean = CONNECTIONS.map((c) => ({
      ...c,
      status: c.enabled ? { category: "good", level: "ok", message: null } : c.status,
    }));
    serve(() => Response.json(clean));
    capture();
    try {
      await runCompanionReconcile();
      await runCompanionReconcile();
    } finally {
      release();
    }
    assert.deepEqual(health(), []);
  });
});

describe("runCompanionReconcile and an unreadable export", () => {
  test("changes the row not at all", async () => {
    integrationManager.setCompanionOutbound("5 connection(s) ok");
    companionDeps.getTarget = async () => ({ host: "10.0.0.5", port: 8000 });
    companionDeps.fetch = async () => new Response("nope", { status: 500 });

    assert.equal(await runCompanionReconcile(), null);
    assert.equal(message(), "5 connection(s) ok");
  });
});
