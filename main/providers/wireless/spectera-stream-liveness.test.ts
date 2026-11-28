// A Spectera base station that goes away reads as offline.
//
// The telemetry arrives on a receive-only HTTPS event stream. Nothing writes to
// that socket and nothing timed it, so a base station that lost power or network
// without closing the connection never produced an 'end' or an 'error': every
// pack stayed online at its last battery and RF figures, and the connection
// stayed "connected", for as long as the process ran.
//
// Real path: a loopback HTTPS server (certificate made for the run, which the
// driver accepts as it accepts a base station's self-signed one) plays the base
// station. The idle window is shortened through the provider's own field; the
// device's real event cadence is not known, which is why a quiet stream is
// checked with a request before anything is marked offline.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type * as http from "node:http";

import type { DeviceStatus } from "../../types/devices.js";
import type { ConnectionState } from "../../types/integrations.js";
import { startSelfSignedServer, type SelfSignedServer } from "../../services/fixtures/self-signed-page.js";
import { SennheiserSpectera } from "./sennheiser-spectera.js";

const SESSION = "0f0e0d0c-test";

/** How the stand-in base station behaves once the stream is open. */
type Mode =
  | "dead" // stream goes silent and the check is never answered: power cut
  | "quiet" // stream goes silent but the box answers the check: idle, alive
  | "mute"; // accepts the stream request and never answers it at all

let mode: Mode = "dead";
let server: SelfSignedServer;
const held = new Set<http.ServerResponse>();

before(async () => {
  server = await startSelfSignedServer((req, res) => {
    const url = req.url ?? "";
    if (req.method === "GET" && url === "/api/ssc/state/subscriptions") {
      if (mode === "mute") {
        held.add(res);
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ sessionUUID: SESSION })}\n\n`);
      res.write(
        `data: ${JSON.stringify({ address: "/api/mts/paired/all/sek1", value: { name: "Lead", state: "Connected", battery: { gauge: 80 } } })}\n\n`,
      );
      held.add(res); // and then nothing, ever
      return;
    }
    if (req.method === "PUT") {
      res.writeHead(200).end();
      return;
    }
    // Anything else is the driver checking on a quiet stream.
    if (mode === "quiet") res.writeHead(200).end("{}");
    else held.add(res);
  });
});

after(async () => {
  held.clear();
  await server.close();
});

type Watch = { p: SennheiserSpectera; states: ConnectionState[]; statuses: DeviceStatus[] };

async function watch(m: Mode): Promise<Watch> {
  mode = m;
  const p = new SennheiserSpectera();
  const knobs = p as unknown as { idleMs: number; probeTimeoutMs: number };
  knobs.idleMs = 120;
  knobs.probeTimeoutMs = 120;
  const states: ConnectionState[] = [];
  const statuses: DeviceStatus[] = [];
  p.onConnectionStateChange((s) => states.push(s));
  p.onStatus((s) => statuses.push(s));
  await p.connect({ host: "localhost", port: server.port, password: "pw" });
  return { p, states, statuses };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("a Spectera stream that goes silent", () => {
  it("reads offline when the base station stops answering", async () => {
    const { p, states, statuses } = await watch("dead");
    try {
      await wait(150);
      assert.ok(states.includes("connected"), "the stream never connected, so this case proves nothing");
      assert.ok(
        statuses.some((s) => s.channelId === "sek1" && s.online),
        "the pack never read online, so this case proves nothing",
      );
      await wait(700);
      assert.notEqual(
        p.getConnectionState(),
        "connected",
        "the base station went silent and stopped answering, and the connection still reads connected",
      );
      const last = statuses.filter((s) => s.channelId === "sek1").at(-1);
      assert.equal(last?.online, false, "the pack still reads online at its last battery figure");
    } finally {
      await p.disconnect();
    }
  });

  it("stays connected while a quiet base station answers the check", async () => {
    const { p, states } = await watch("quiet");
    try {
      await wait(900); // several idle windows
      assert.equal(p.getConnectionState(), "connected", `a healthy, quiet base station was dropped: ${states.join(" → ")}`);
      assert.ok(!states.includes("error"), `a healthy, quiet base station flapped: ${states.join(" → ")}`);
    } finally {
      await p.disconnect();
    }
  });

  it("gives up on a stream request that is never answered", async () => {
    const { p, states } = await watch("mute");
    try {
      await wait(700);
      assert.ok(
        states.includes("error"),
        `the request was accepted and never answered, and the connection sat at: ${states.join(" → ")}`,
      );
    } finally {
      await p.disconnect();
    }
  });
});
