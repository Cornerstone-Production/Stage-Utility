// OBS's connect failure side, against the stub OBS (obs-server-harness.ts).
//
// Two guards. A reconfigure tears down the adapter whose handshake is still in
// flight, and that handshake's rejection must not be reported as the new host's
// failure, blank it, or queue a reconnect that builds a second adapter over the
// live one. And a failure AFTER the handshake closes an adapter that has
// identified: the service lets go of it before closing it, because close()
// fires onClose synchronously and would otherwise take the "connection dropped"
// path too — a second line and a second retry for one failure.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, test, type TestContext } from "node:test";
import { until } from "./fixtures/within.js";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-utility-obs-lifecycle-"));
process.env.STAGE_UTILITY_DATA = path.join(TMP, "data");
process.env.HOME = path.join(TMP, "home");

const { obsService } = await import("./obs-service.js");
const { FakeObs } = await import("./obs-server-harness.js");

const fake = new FakeObs();

before(async () => {
  await fake.listen();
});
after(async () => {
  obsService.stop();
  await fake.close();
  await fs.rm(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});
beforeEach(() => {
  obsService.stop();
  obsService.setConnectionListener(() => {});
  fake.reset();
});

/** A port that refuses: bound, read, and closed again. */
async function refusingPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

/** [obs] warn lines, and every delay handed to scheduleIn, for the test. */
function watch(t: TestContext): { lines: string[]; delays: number[] } {
  const lines: string[] = [];
  const { warn, log } = console;
  console.warn = (...a: unknown[]) => {
    const line = a.map(String).join(" ");
    if (line.startsWith("[obs]")) lines.push(line);
  };
  console.log = () => {};
  const delays: number[] = [];
  const svc = obsService as unknown as { scheduleIn(ms: number): void };
  const real = svc.scheduleIn.bind(obsService);
  svc.scheduleIn = (ms: number) => {
    delays.push(ms);
    real(ms);
  };
  t.after(() => {
    console.warn = warn;
    console.log = log;
    delete (svc as { scheduleIn?: unknown }).scheduleIn;
  });
  return { lines, delays };
}

test("OBS: the replaced host's handshake failing is not the new host's failure", async (t) => {
  const { delays } = watch(t);
  const reports: { state: string; message: string | null }[] = [];
  obsService.setConnectionListener((state, message) => reports.push({ state, message }));
  const gone = await refusingPort();
  // Seen when the old handshake's failure reaches the catch and asks whether
  // its run is still current — or, with that check gone, when it reports.
  let staleHandled = false;
  const svc = obsService as unknown as { current(run: number): boolean };
  const realCurrent = svc.current.bind(obsService);
  svc.current = (run: number) => {
    const now = realCurrent(run);
    if (!now) staleHandled = true;
    return now;
  };
  t.after(() => {
    delete (svc as { current?: unknown }).current;
  });

  obsService.configure("127.0.0.1", gone, null);
  obsService.configure("127.0.0.1", fake.port, null); // before the first handshake can finish
  await until(() => obsService.getLatest().connected, "the new host to connect");
  await until(() => staleHandled || reports.some((r) => r.state === "error"), "the old handshake's failure to land");

  assert.deepEqual(
    reports.filter((r) => r.state === "error"),
    [],
    "the replaced host's failure was reported on the new one",
  );
  assert.equal(obsService.getLatest().connected, true, "the replaced host's failure blanked the new one");
  assert.deepEqual(delays, [], "the replaced host's failure queued a reconnect over the live connection");
});

test("OBS: a failure after the handshake is one line and one retry", async (t) => {
  const { lines, delays } = watch(t);
  // Something past the handshake throws — here the connection listener — so the
  // connect fails holding an adapter that has identified.
  obsService.setConnectionListener((state) => {
    if (state === "connected") throw new Error("listener failed");
  });

  obsService.configure("127.0.0.1", fake.port, null);
  await until(() => delays.length > 0, "the retry");
  // A second line and retry, when there is one, come from the same catch in the
  // same tick; a few turns is margin, not a wait for something in flight.
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

  assert.equal(lines.length, 1, `one failure wrote ${lines.length} lines:\n${lines.join("\n")}`);
  assert.equal(delays.length, 1, `one failure queued ${delays.length} retries`);
});
