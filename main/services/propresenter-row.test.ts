// What the Integrations CARD says about ProPresenter, driven through the real
// manager and the real row rather than through the service.
//
// propresenter-stream.test.ts drives the SERVICE and asserts on what it reports.
// That is the wrong half for this defect: the row is written in two places —
// `applyPropresenter` writes "Connecting to h:p" optimistically, and the
// service's connection listener writes over it when the stream comes up — and
// the failure is the second one not happening. Only the row shows it.
//
// So this file seeds the manager's own state map, calls the same `setConfig` and
// `setEnabled` the routes call, and reads `getStates()` — the exact array the
// panel renders.
//
// Nothing here contacts a real ProPresenter: the stub is an `http.createServer`
// on an ephemeral port on 127.0.0.1, and every other integration is left
// unconfigured and switched off.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

// Before the module graph loads, so every store reads an empty tree instead of
// the operator's real config.
process.env.STAGE_UTILITY_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "prop-row-"));
process.env.HOME = path.join(process.env.STAGE_UTILITY_DATA, "home");

// ProPresenter is dialled with http.request, at the stub below. Everything else
// in the graph reaches for fetch, and an integration nobody configured should
// never get that far — `fetched` is asserted empty at the end so that stays true.
const realFetch = globalThis.fetch;
const fetched: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL) => {
  fetched.push(typeof input === "string" ? input : String((input as Request)?.url ?? input));
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { integrationManager } = await import("./integration-manager.js");
const { propresenterService, propresenterManager } = await import("./propresenter-service.js");
const { setSubscriberCheck } = await import("./broadcaster.js");

// THE unattended appliance, as propresenter-stream.test.ts sets it: the
// broadcaster fails open without a transport registered.
setSubscriberCheck(() => false);

// ── The stub ─────────────────────────────────────────────────────────────────

let server: http.Server;
let port = 0;
/** Held subscription responses, so the test can see a stream is really up. */
let streams: http.ServerResponse[] = [];
let heartbeats: ReturnType<typeof setInterval>[] = [];

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/version") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ host_description: "ProPresenter 21.3", api_version: "v1" }));
      return;
    }
    if (req.method === "POST" && (req.url ?? "").startsWith("/v1/status/updates")) {
      req.resume();
      // 21.3 answers chunked with no content-type, and the headers are FLUSHED
      // so the client sees a live stream before any frame arrives.
      res.writeHead(200, { Connection: "close" });
      res.flushHeaders();
      streams.push(res);
      res.on("close", () => {
        streams = streams.filter((s) => s !== res);
      });
      const tick = setInterval(
        () => res.write(`event: /v1/timer/system_time\r\ndata: ${Date.now() / 1000 | 0}\r\n\r\n`),
        25,
      );
      heartbeats.push(tick);
      res.on("close", () => clearInterval(tick));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
});

after(async () => {
  propresenterService.stop();
  propresenterManager.apply(null, []);
  for (const t of heartbeats) clearInterval(t);
  for (const s of streams) s.destroy();
  globalThis.fetch = realFetch;
  await new Promise<void>((r) => server.close(() => r()));
});

// ── The row ──────────────────────────────────────────────────────────────────

interface Seeded {
  id: string;
  enabled: boolean;
  connection: string;
  message: string | null;
  config: Record<string, unknown>;
}
/** The manager's own state map. init() is the whole appliance coming up — PCO,
 *  wireless, OSC, SenSource — and none of it is under test; the row it would
 *  create for ProPresenter is exactly this one. */
const states = (integrationManager as unknown as { states: Map<string, Seeded> }).states;

const row = (): { connection: string; message: string | null } => {
  const s = integrationManager.getStates().find((x) => x.id === "propresenter");
  assert.ok(s, "the ProPresenter row is not in getStates()");
  return { connection: s.connection, message: s.message };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(what: string, fn: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(5);
  }
  assert.fail(`timed out after ${ms}ms waiting for: ${what} — row is ${JSON.stringify(row())}`);
}

/**
 * The row once the stream is up and the card is green.
 *
 * Everything after the first seed goes through setEnabled, never back through
 * the state map: writing the map by hand would leave the row saying one thing
 * and the service doing another, which is a state the appliance cannot reach and
 * which would make the second case here pass or fail for the wrong reason.
 */
async function live(): Promise<string> {
  if (!states.has("propresenter")) {
    states.set("propresenter", {
      id: "propresenter",
      enabled: false,
      connection: "disconnected",
      message: null,
      config: { name: "Main", host: "127.0.0.1", port: String(port) },
    });
  }
  await integrationManager.setEnabled("propresenter", false);
  await until("any previous subscription to close", () => streams.length === 0);
  await integrationManager.setEnabled("propresenter", true);
  await until("the stream to be held", () => streams.length === 1);
  const streaming = `Streaming from 127.0.0.1:${port}`;
  await until("the row to say it is streaming", () => row().message === streaming);
  return streaming;
}

describe("the ProPresenter row on the Integrations card", () => {
  it("comes up green and stays green across an ordinary settings save", async () => {
    // GUARD. The applier announced "Connecting to h:p" on EVERY pass, and the
    // pass runs on every settings write. Every other integration gets away with
    // that because its configure() restarts unconditionally and the service
    // reports again; ProPresenter deliberately does not re-dial an unchanged
    // target, so nothing took the optimistic message back and the card read
    // "Connecting to 192.168.x.x:1025" over a live stream until it next dropped.
    const streaming = await live();

    // A save that changes only the FALLBACK poll interval — a number the stream
    // path does not read.
    await integrationManager.setConfig("propresenter", {
      name: "Main",
      host: "127.0.0.1",
      port: String(port),
      pollMs: "900",
    });
    await sleep(150);

    assert.deepEqual(
      row(),
      { connection: "connected", message: streaming },
      "a settings save left the card reading as still connecting over a live stream",
    );
    assert.equal(streams.length, 1, "the interval save dropped the stream");
  });

  it("goes back to green after the operator switches it off and on", async () => {
    // GUARD. The target does not move across a disable, so setTarget returns
    // early and nothing resets the report. The stream came straight back up and
    // reported the IDENTICAL "Streaming from h:p" it had reported before the
    // disable; report() compares the state AND the message and dropped it as a
    // repeat, so the applier's "Connecting to h:p" was the last thing the row was
    // ever told — under a live, healthy stream, for the rest of the service.
    // Toggling an integration off and on is the first thing anybody tries.
    const streaming = await live();

    await integrationManager.setEnabled("propresenter", false);
    assert.deepEqual(row(), { connection: "disconnected", message: null });
    await until("the stub to see the subscription close", () => streams.length === 0);

    await integrationManager.setEnabled("propresenter", true);
    await until("the row to leave Connecting", () => row().connection === "connected");
    assert.deepEqual(row(), { connection: "connected", message: streaming });
  });

  it("contacted nothing but the stub", () => {
    // The constraint this file runs under: no external host, no LAN device. Every
    // other integration is unconfigured and switched off, so nothing should have
    // reached for fetch at all.
    assert.deepEqual(fetched, []);
  });
});
