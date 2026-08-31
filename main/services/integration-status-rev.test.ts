// The published-snapshot version, and the two ways it can be got wrong.
//
// `rev` is what lets a client tell a hydrate read apart from a push it already
// applied — see the note on StatusIntegration.rev. It is only useful if it
// advances EXACTLY when a frame goes out: bump it on a skipped frame and a fresh
// read looks stale; leave it out of a frame and the client cannot compare at all.
//
// The other failure this pins is subtler and would have been silent. emitIfChanged
// compares every key of the DTO, so a rev stored INSIDE `this.last` would differ
// on every comparison and turn every change-driven channel into an unconditional
// one — a 2 Hz ProPresenter poll re-rendering every dashboard in the building,
// forever, with nothing looking broken.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test, describe, beforeEach } from "node:test";

import { addBroadcastListener } from "./broadcaster.js";
import { StatusIntegration } from "./integration-base.js";
import { serviceWindow, DEFAULT_RECONNECT_SCHEDULE } from "./service-window.js";

interface Dto { connected: boolean; value: number; rev?: number }
const OFFLINE: Dto = { connected: false, value: 0 };

/** A StatusIntegration the test publishes through by hand. */
class Pub extends StatusIntegration<Dto> {
  constructor(channel: string) { super("pub", channel, OFFLINE); }
  protected get configured(): boolean { return true; }
  protected async connect(): Promise<void> {}

  publish(value: number, connected = true): void { this.emit({ connected, value }); }
  publishIfChanged(value: number, connected = true): void {
    this.emitIfChanged({ connected, value });
  }
}

/** Collect every frame broadcast on one channel. */
function capture(channel: string): Dto[] {
  const sent: Dto[] = [];
  addBroadcastListener((c, payload) => {
    if (c === channel) sent.push(payload as Dto);
  });
  return sent;
}

let n = 0;
const freshChannel = () => `rev-test-${n++}:status`;

describe("StatusIntegration publish version", () => {
  beforeEach(() => {
    serviceWindow.setSchedule({ ...DEFAULT_RECONNECT_SCHEDULE });
    const now = Date.now();
    serviceWindow.setWindows([{ open: now - 60_000, close: now + 600_000 }]);
  });

  test("every broadcast frame carries the version", () => {
    const ch = freshChannel();
    const sent = capture(ch);
    const p = new Pub(ch);

    p.publish(1);
    p.publish(2);

    assert.equal(sent.length, 2);
    assert.equal(sent[0]!.rev, 1);
    assert.equal(sent[1]!.rev, 2);
  });

  test("the read answers the same version as the frame it last published", () => {
    // The whole point: the two halves the client compares must come from one
    // counter. If getLatest() stopped stamping, the client would see no rev on
    // the read, skip the comparison, and the ordering bug would be back with
    // every test above this one still green.
    const ch = freshChannel();
    const sent = capture(ch);
    const p = new Pub(ch);

    p.publish(1);
    p.publish(2);

    assert.equal(p.getLatest().rev, sent.at(-1)!.rev);
  });

  test("an unchanged snapshot neither broadcasts nor advances the version", () => {
    // Bumping on a skipped frame would make a client's read look OLDER than a
    // push carrying the identical value, so the read would be dropped and a
    // display that hydrated between changes would keep whatever it had.
    const ch = freshChannel();
    const sent = capture(ch);
    const p = new Pub(ch);

    p.publishIfChanged(1);
    const afterFirst = p.getLatest().rev;
    p.publishIfChanged(1);
    p.publishIfChanged(1);

    assert.equal(sent.length, 1, "an unchanged snapshot must not be broadcast");
    assert.equal(p.getLatest().rev, afterFirst, "nor advance the version");
  });

  test("the version does not leak into the change comparison", () => {
    // Guards the silent failure: a rev stored on `this.last` differs on every
    // emitIfChanged comparison, so every unchanged poll would broadcast. Run
    // enough rounds that a single stale-by-one comparison cannot pass by luck.
    const ch = freshChannel();
    const sent = capture(ch);
    const p = new Pub(ch);

    p.publishIfChanged(7);
    for (let i = 0; i < 10; i++) p.publishIfChanged(7);

    assert.equal(sent.length, 1, `a change-driven channel broadcast ${sent.length} times for one change`);
  });

  test("a real change after a run of unchanged frames advances by exactly one", () => {
    const ch = freshChannel();
    const p = new Pub(ch);

    p.publishIfChanged(1);
    const before = p.getLatest().rev!;
    p.publishIfChanged(1);
    p.publishIfChanged(1);
    p.publishIfChanged(2);

    assert.equal(p.getLatest().rev, before + 1);
  });
});

describe("every status channel publishes a version", () => {
  // The read half, over the real singletons rather than a fake. Each of these
  // answers a hydrate route and the SSE hello burst from getLatest(), and each
  // has a renderer hook that compares that answer against a push.
  //
  // An EXACT list, not a floor: another StatusIntegration arriving without a
  // hook and without a line here is the drift this repo keeps paying for. The
  // COUNT deliberately does not appear in the title either — it said "seven"
  // while the list below held nine, which is the same drift wearing a different
  // hat.
  test("every StatusIntegration stamps its hydrate read", async () => {
    const services = await Promise.all([
      import("./obs-service.js").then((m) => ["obs:status", m.obsService] as const),
      import("./reaper-service.js").then((m) => ["reaper:status", m.reaperService] as const),
      import("./resi-service.js").then((m) => ["resi:status", m.resiService] as const),
      import("./youtube-service.js").then((m) => ["youtube:status", m.youtubeService] as const),
      import("./smaart-service.js").then((m) => ["spl:metrics", m.smaartService] as const),
      import("./sensource-service.js").then((m) => ["people:count", m.sensourceService] as const),
      import("./propresenter-service.js").then(
        (m) => ["propresenter:status", m.propresenterService] as const,
      ),
      import("./pvp-service.js").then((m) => ["pvp:status", m.pvpService] as const),
      import("./scores-service.js").then((m) => ["scores:status", m.scoresService] as const),
    ]);

    // DISCOVERED, not declared. This used to assert `services.length === 7`
    // against the array three lines above it — a test counting its own literal,
    // which cannot fail. It missed `scoresService` and `pvpService` in turn, so
    // by the time it was noticed the repo had NINE status integrations and this
    // still said seven, green the whole way. That is exactly the drift the
    // comment above it claims to catch.
    //
    // The set now comes off the filesystem, matching on `extends
    // StatusIntegration` — an assignment a docblock cannot satisfy — so a new
    // integration that is not wired in below fails HERE rather than shipping a
    // channel nobody checks.
    const serviceDir = path.dirname(fileURLToPath(import.meta.url));
    const onDisk = fs
      .readdirSync(serviceDir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .filter((f) => /extends\s+StatusIntegration\b/.test(fs.readFileSync(path.join(serviceDir, f), "utf8")))
      .sort();

    const wired = services.map(([, svc]) => svc.constructor.name).sort();
    assert.equal(
      services.length,
      onDisk.length,
      `${onDisk.length} StatusIntegration subclasses exist but ${services.length} are checked here.\n` +
        `  on disk: ${onDisk.join(", ")}\n` +
        `  wired:   ${wired.join(", ")}\n` +
        "  Add the missing one above — its rev is unchecked until you do.",
    );

    const unstamped = services
      .filter(([, svc]) => typeof svc.getLatest().rev !== "number")
      .map(([channel]) => channel);

    assert.deepEqual(unstamped, [], `these hydrate reads carry no version: ${unstamped.join(", ")}`);
  });
});

describe("no status integration broadcasts an unstamped frame", () => {
  // Three services override emit() and broadcast for themselves, so the base's
  // stamp does not reach them — this is the "fixed in one of four copies" shape
  // that has bitten this repo repeatedly, and the only place it can be checked
  // is where those calls are written.
  //
  // Counted rather than pattern-matched loosely, and it fails CLOSED: an
  // unstamped broadcast added in code raises the first count only, and a mention
  // in a comment can only ever raise a count, never hide a real one.
  const HERE = path.dirname(fileURLToPath(import.meta.url));

  function walk(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) out.push(p);
    }
    return out;
  }

  test("every broadcast on an integration's own channel is stamped", () => {
    let total = 0;
    let stamped = 0;
    const offenders: string[] = [];

    for (const file of walk(HERE)) {
      const src = fs.readFileSync(file, "utf8");
      const all = [...src.matchAll(/broadcast\(this\.channel,/g)].length;
      const ok = [...src.matchAll(/broadcast\(this\.channel,\s*this\.stamped\(/g)].length;
      total += all;
      stamped += ok;
      if (all !== ok) offenders.push(`${path.basename(file)} (${all - ok} unstamped)`);
    }

    assert.deepEqual(
      offenders,
      [],
      "a frame published without its version leaves the client unable to order it " +
        "against a hydrate read:\n  " + offenders.join("\n  "),
    );
    // The base plus the three services that override emit(). An EXACT count, so
    // a fourth override cannot be added without this line being considered.
    assert.equal(total, 4, `expected 4 channel broadcasts, found ${total} — a service was added or removed`);
    assert.equal(stamped, 4);
  });
});
