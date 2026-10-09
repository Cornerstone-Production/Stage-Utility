import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { InFlight } from "./in-flight.js";

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (err: Error) => void } {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const turn = () => new Promise((resolve) => setImmediate(resolve));

/** The unhandled rejections a fresh process reports for `body`, which runs
 *  with `InFlight` and `deferred` in scope. A child process because the test
 *  runner fails whichever test is running when one reaches the process. */
function unhandledIn(body: string): string[] {
  const script = `
    import { InFlight } from ${JSON.stringify(new URL("./in-flight.ts", import.meta.url).href)};
    const seen = [];
    process.on("unhandledRejection", (reason) => seen.push(reason instanceof Error ? reason.message : String(reason)));
    const deferred = () => { let reject; const promise = new Promise((_, rej) => (reject = rej)); return { promise, reject }; };
    ${body}
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    console.log(JSON.stringify(seen));
  `;
  const run = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 30_000 });
  assert.equal(run.status, 0, run.error ? `the child did not finish: ${run.error.message}` : run.stderr);
  return JSON.parse(run.stdout.trim().split("\n").at(-1)!) as string[];
}

test("whenIdle() resolves at once with nothing running", async () => {
  await new InFlight().whenIdle();
});

test("whenIdle() waits for work started while it waited, not only what was running when it was called", async () => {
  const inFlight = new InFlight();
  const first = deferred();
  const second = deferred();
  // The first piece of work starts the second before it settles, as a
  // finishing probe round starts the one a change queued meanwhile.
  void inFlight.track(first.promise.then(() => void inFlight.track(second.promise)));
  let idle = false;
  void inFlight.whenIdle().then(() => (idle = true));

  first.resolve();
  await turn();
  assert.equal(idle, false, "whenIdle() resolved with the second piece of work still running");
  assert.equal(inFlight.isIdle(), false);
  second.resolve();
  await turn();
  assert.equal(idle, true);
  assert.equal(inFlight.isIdle(), true);
});

test("whenIdle() resolves, never rejects, when the work fails", async () => {
  const inFlight = new InFlight();
  const work = deferred();
  const tracked = inFlight.track(work.promise);
  const idle = inFlight.whenIdle();
  work.reject(new Error("EIO"));
  await assert.rejects(tracked, /EIO/);
  await idle;
});

test("a voided failure still reaches the process as unhandled, once; an awaited one does not", () => {
  const voided = unhandledIn(`
    const inFlight = new InFlight();
    const work = deferred();
    void inFlight.track(work.promise);
    work.reject(new Error("voided"));
    await inFlight.whenIdle();
  `);
  assert.deepEqual(voided, ["voided"], "a tracked fire-and-forget failure was swallowed");

  const awaited = unhandledIn(`
    const inFlight = new InFlight();
    const work = deferred();
    const tracked = inFlight.track(work.promise);
    work.reject(new Error("awaited"));
    await tracked.catch(() => {});
  `);
  assert.deepEqual(awaited, [], "an awaited, handled failure was also reported unhandled");
});
