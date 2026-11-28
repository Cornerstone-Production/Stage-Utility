// Smaart's connect path against a scripted adapter (smaartDeps.adapter).
//
// Two guards live here. The run check (integration-base.ts `current(run)`): a
// reconfigure restarts while a connect to the OLD host is still in flight, and
// that connect must neither report its failure on the new host's row nor
// publish its inputs as the new host's. And the order of a close: the service
// lets go of an adapter BEFORE closing it, so a stream close the adapter fires
// from close() reads as superseded rather than as a second drop with a second
// reconnect queued.

import assert from "node:assert/strict";
import { afterEach, test, type TestContext } from "node:test";

import { smaartDeps, smaartService } from "./smaart-service.js";
import type { SmaartAdapter, SmaartInput } from "./smaart-protocol.js";

const realAdapter = smaartDeps.adapter;

/** A Smaart that answers as scripted. close() fires every stream's close, as a
 *  torn-down socket does. */
class ScriptedSmaart implements SmaartAdapter {
  readonly serverInfo = null;
  closed = false;
  private streamCloses: (() => void)[] = [];
  private held: { resolve: () => void; reject: (e: Error) => void } | null = null;

  constructor(
    readonly apiVersion: string,
    private readonly inputs: SmaartInput[],
    private readonly opts: { hold?: boolean; closeRejects?: boolean } = {},
  ) {}

  connect(): Promise<void> {
    if (!this.opts.hold) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.held = { resolve, reject };
    });
  }

  release(): void {
    this.held?.resolve();
  }

  listInputs(): Promise<SmaartInput[]> {
    return Promise.resolve(this.inputs);
  }

  openSplStream(_input: SmaartInput, _fps: number, _onReading: unknown, onClose: () => void): () => void {
    this.streamCloses.push(onClose);
    return () => {};
  }

  /** One stream drops, as Smaart closing a meter socket does. */
  dropStream(): void {
    this.streamCloses[0]?.();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.opts.closeRejects !== false) this.held?.reject(new Error("socket closed"));
    for (const cb of [...this.streamCloses]) cb();
  }
}

const input = (n: number): SmaartInput =>
  ({ deviceName: "dev", channelName: `ch${n}`, streamEndpoint: `/s${n}` }) as unknown as SmaartInput;

afterEach(() => {
  smaartDeps.adapter = realAdapter;
  smaartService.setConnectionListener(() => {});
  smaartService.stop();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

/** Every delay the service hands to scheduleIn, for the life of the test. */
function retries(t: TestContext): number[] {
  const delays: number[] = [];
  const svc = smaartService as unknown as { scheduleIn(ms: number): void };
  const real = svc.scheduleIn.bind(smaartService);
  svc.scheduleIn = (ms: number) => {
    delays.push(ms);
    real(ms);
  };
  t.after(() => {
    delete (svc as { scheduleIn?: unknown }).scheduleIn;
  });
  return delays;
}

function quiet(t: TestContext): void {
  const { warn, log } = console;
  console.warn = () => {};
  console.log = () => {};
  t.after(() => {
    console.warn = warn;
    console.log = log;
  });
}

test("Smaart: a connect to the replaced host failing is not the new host's failure", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  quiet(t);
  const old = new ScriptedSmaart("3", [input(1)], { hold: true });
  smaartDeps.adapter = (host) => (host === "old.example" ? old : new ScriptedSmaart("4", [input(1)]));
  const reports: string[] = [];
  smaartService.setConnectionListener((state) => reports.push(state));

  smaartService.configure("old.example", 26000, null);
  await settle();
  smaartService.configure("new.example", 26000, null); // teardown closes the old adapter
  await settle();

  assert.deepEqual(reports.filter((s) => s === "error"), [], "the replaced host's failure was reported on the new one");
  assert.equal(smaartService.getLatest().connected, true, "the replaced host's failure blanked the new one");
});

test("Smaart: a connect to the replaced host succeeding late is not published", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  quiet(t);
  const old = new ScriptedSmaart("3", [input(1), input(2), input(3)], { hold: true, closeRejects: false });
  smaartDeps.adapter = (host) => (host === "old.example" ? old : new ScriptedSmaart("4", [input(1)]));

  smaartService.configure("old.example", 26000, null);
  await settle();
  smaartService.configure("new.example", 26000, null);
  await settle();
  old.release();
  await settle();

  assert.equal(smaartService.getLatest().apiVersion, "4", "the replaced host's Smaart was published as the new one");
});

test("Smaart: a dropped stream queues one reconnect, not one per stream the close tears down", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  quiet(t);
  const live = new ScriptedSmaart("4", [input(1), input(2)]);
  smaartDeps.adapter = () => live;
  const delays = retries(t);

  smaartService.configure("smaart.example", 26000, null);
  await settle();
  assert.equal(smaartService.getLatest().connected, true);
  live.dropStream();
  await settle();

  assert.equal(delays.length, 1, `one dropped stream queued ${delays.length} reconnects`);
});

test("Smaart: a failure after the streams opened queues one reconnect", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  quiet(t);
  smaartDeps.adapter = () => new ScriptedSmaart("4", [input(1)]);
  const delays = retries(t);
  // Something past openStreams throws — here the connection listener — so the
  // connect fails with a stream already open on the adapter it closes.
  smaartService.setConnectionListener((state) => {
    if (state === "connected") throw new Error("listener failed");
  });

  smaartService.configure("smaart.example", 26000, null);
  await settle();

  assert.equal(delays.length, 1, `one failed connect queued ${delays.length} reconnects`);
});
