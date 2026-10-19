// When a Mac helper or a Windows kiosk is told to update, and what it is told.
//
// The gate is the part that can black out an SDI feed on air, so each reason it
// should decline is pinned on its own: a live service, the window around one, the
// switch, a version that already failed here. Update now is pinned too, because it
// overrides some of them and must not override a live service.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { decide, describe as sentence, MachineUpdates, MAX_MACHINES, parseCheck, REPORT_TTL_MS, type CheckInput, type Gate } from "./machine-updates.js";
import { setAppTimeZone } from "./app-timezone.js";

const OPEN: Gate = { want: "1.27.0", auto: true, requested: false, live: false, windowCloses: null, serviceTimesKnown: true };
const MAC = { platform: "macos" as const, have: "1.26.0", state: "idle" as const, target: undefined };

describe("decide", () => {
  it("updates a Mac that is behind when nothing holds it back", () => {
    assert.deepEqual(decide(MAC, OPEN), { update: true });
  });

  it("leaves a Mac on this server's version alone, whatever else is true", () => {
    assert.deepEqual(decide({ ...MAC, have: "1.27.0" }, { ...OPEN, requested: true }), { update: false, why: "current" });
  });

  it("never updates a Mac while a service is live, even when someone asked", () => {
    assert.deepEqual(decide(MAC, { ...OPEN, live: true }), { update: false, why: "live" });
    assert.deepEqual(decide(MAC, { ...OPEN, live: true, requested: true }), { update: false, why: "live" });
  });

  it("waits out the service window, and says when it closes", () => {
    assert.deepEqual(decide(MAC, { ...OPEN, windowCloses: 1_000 }), { update: false, why: "window", until: 1_000 });
  });

  it("holds a Mac while Planning Center's times are not known, unless someone asked", () => {
    assert.deepEqual(decide(MAC, { ...OPEN, serviceTimesKnown: false }), { update: false, why: "unknown" });
    assert.deepEqual(decide(MAC, { ...OPEN, serviceTimesKnown: false, requested: true }), { update: true });
    // A Windows kiosk restarts nothing, so it does not wait on them.
    assert.deepEqual(decide({ ...MAC, platform: "windows" }, { ...OPEN, serviceTimesKnown: false }), { update: true });
  });

  it("lets Update now through the window", () => {
    assert.deepEqual(decide(MAC, { ...OPEN, windowCloses: 1_000, requested: true }), { update: true });
  });

  it("holds every machine with the switch off, until someone asks", () => {
    assert.deepEqual(decide(MAC, { ...OPEN, auto: false }), { update: false, why: "off" });
    assert.deepEqual(decide(MAC, { ...OPEN, auto: false, requested: true }), { update: true });
    assert.deepEqual(decide({ ...MAC, platform: "windows" }, { ...OPEN, auto: false }), { update: false, why: "off" });
  });

  it("does not retry a version that failed on this machine, until someone asks", () => {
    const failed = { ...MAC, state: "failed" as const, target: "1.27.0" };
    assert.deepEqual(decide(failed, OPEN), { update: false, why: "failed" });
    assert.deepEqual(decide(failed, { ...OPEN, requested: true }), { update: true });
    // A failure of an older version says nothing about this one.
    assert.deepEqual(decide({ ...failed, target: "1.26.5" }, OPEN), { update: true });
  });

  it("updates a Windows launcher during a service: it restarts nothing", () => {
    const win = { ...MAC, platform: "windows" as const, have: "a".repeat(64) };
    assert.deepEqual(decide(win, { ...OPEN, want: "b".repeat(64), live: true, windowCloses: 1_000 }), { update: true });
  });
});

describe("parseCheck", () => {
  const q = (o: Record<string, string>) => new URLSearchParams(o);

  it("reads a Mac's check", () => {
    const r = parseCheck(q({ machine: "5f1c09ab-7e22", platform: "macos", have: "1.26.0", host: "booth-mini", state: "failed", target: "1.27.0", detail: "Chromium did not start" }));
    assert.deepEqual(r, { machine: "5f1c09ab-7e22", platform: "macos", have: "1.26.0", host: "booth-mini", state: "failed", target: "1.27.0", detail: "Chromium did not start", at: undefined });
  });

  it("refuses what an updater must always send, and an unknown state", () => {
    assert.ok("error" in parseCheck(q({ platform: "macos", have: "1" })));
    assert.ok("error" in parseCheck(q({ machine: "m", platform: "linux", have: "1" })));
    assert.ok("error" in parseCheck(q({ machine: "m", platform: "macos" })));
    assert.ok("error" in parseCheck(q({ machine: "m", platform: "macos", have: "1", state: "exploded" })));
    assert.ok("error" in parseCheck(q({ machine: "a b", platform: "macos", have: "1" })));
  });

  it("takes no state as idle, and cuts a long reason rather than refusing it", () => {
    const r = parseCheck(q({ machine: "m", platform: "macos", have: "1", detail: "x".repeat(500) }));
    assert.ok(!("error" in r));
    assert.equal(r.state, "idle");
    assert.equal(r.detail?.length, 200);
  });
});

describe("MachineUpdates", () => {
  let lines: string[];
  let changes: number;
  let updates: MachineUpdates;
  const realLog = console.log;
  const check = (over: Partial<CheckInput> = {}): CheckInput => ({ machine: "5f1c09ab-7e22-4c1d", platform: "macos", host: "booth-mini", have: "1.26.0", state: "idle", ...over });
  const gate = { want: "1.27.0", auto: true, live: false, windowCloses: null, serviceTimesKnown: true };

  beforeEach(() => {
    lines = [];
    changes = 0;
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    updates = new MachineUpdates(() => changes++);
    setAppTimeZone("America/Chicago");
  });
  afterEach(() => {
    console.log = realLog;
    setAppTimeZone(null);
  });

  it("logs a decision when it changes, not on every check", () => {
    updates.check(check(), { ...gate, live: true }, 0);
    updates.check(check(), { ...gate, live: true }, 300_000);
    updates.check(check(), gate, 600_000);
    assert.deepEqual(lines, [
      "[helper-update] Mac booth-mini (5f1c09ab) is on 1.26.0, this server is 1.27.0: waiting, a service is live",
      "[helper-update] Mac booth-mini (5f1c09ab) is on 1.26.0, this server is 1.27.0: going ahead",
    ]);
    assert.equal(changes, 2);
  });

  it("names the window's close in the app's zone, not the host's", () => {
    // A zone no development Mac or UTC server is in, half an hour off the hour:
    // 17:30 UTC is 23:00 in Kolkata, all year.
    setAppTimeZone("Asia/Kolkata");
    const closes = Date.UTC(2026, 9, 18, 17, 30);
    const m = updates.check(check(), { ...gate, windowCloses: closes }, closes - 3_600_000);
    assert.equal(m.reason, "Helper 1.26.0. Updates to 1.27.0 after the service window closes at 23:00");
    assert.match(lines[0], /waiting, a service window is open until 23:00$/);
  });

  it("logs what the Mac says it did, once", () => {
    updates.check(check(), gate, 0);
    updates.check(check({ state: "failed", target: "1.27.0", detail: "Chromium did not start" }), gate, 300_000);
    const m = updates.check(check({ state: "failed", target: "1.27.0", detail: "Chromium did not start" }), gate, 600_000);
    assert.equal(m.reason, "Helper 1.26.0. The update to 1.27.0 failed and was undone: Chromium did not start");
    assert.deepEqual(lines.slice(1), [
      "[helper-update] Mac booth-mini (5f1c09ab): the update to 1.27.0 failed: Chromium did not start; it is not tried again until someone asks from Screens",
      "[helper-update] Mac booth-mini (5f1c09ab) is on 1.26.0, this server is 1.27.0: waiting, this version failed here before",
    ]);
  });

  it("logs a Local Network refusal after an update", () => {
    updates.check(check({ have: "1.27.0", state: "local-network", target: "1.27.0" }), gate, 0);
    assert.equal(lines[0], "[helper-update] Mac booth-mini (5f1c09ab): macOS refuses the helper Local Network access since the update to 1.27.0; answer the prompt at the Mac");
  });

  it("Update now goes ahead at the next check, once", () => {
    updates.check(check(), { ...gate, auto: false }, 0);
    assert.equal(updates.request("5f1c09ab-7e22-4c1d", 1_000), true);
    assert.equal(updates.list(1_000)[0].reason, "Update asked for. It starts at the machine's next check, within 5 minutes");
    // What the button overrode no longer stands, so Screens offers it no longer.
    assert.equal(updates.list(1_000)[0].waitingOn, undefined);
    assert.equal(updates.check(check(), { ...gate, auto: false }, 300_000).update, true);
    // A failure after it is not retried by itself.
    updates.check(check({ state: "failed", target: "1.27.0", at: 1 }), { ...gate, auto: false }, 600_000);
    assert.equal(updates.check(check({ state: "failed", target: "1.27.0", at: 1 }), { ...gate, auto: false }, 900_000).update, false);
  });

  it("keeps Update now through a check the Mac could not act on", () => {
    updates.check(check(), { ...gate, auto: false }, 0);
    updates.request("5f1c09ab-7e22-4c1d", 1_000);
    assert.equal(updates.check(check(), { ...gate, auto: false }, 300_000).update, true);
    // Nobody logged in, or the helper quit: the press must still stand.
    assert.equal(updates.check(check({ state: "not-running", target: "1.27.0" }), { ...gate, auto: false }, 600_000).update, true);
    assert.equal(updates.check(check({ state: "no-session", target: "1.27.0" }), { ...gate, auto: false }, 900_000).update, true);
  });

  it("Try again stands until a new failure, not the one it was pressed on", () => {
    const failed = check({ state: "failed", target: "1.27.0", detail: "Chromium did not start", at: 100 });
    updates.check(failed, gate, 0);
    updates.request("5f1c09ab-7e22-4c1d", 1_000);
    // The same failure reported again is what Try again was pressed on.
    assert.equal(updates.check(failed, gate, 300_000).update, true);
    // A failure at a new time is the retry's outcome, and holds the version again.
    updates.check({ ...failed, at: 400 }, gate, 600_000);
    assert.equal(updates.check({ ...failed, at: 400 }, gate, 900_000).update, false);
  });

  it("refuses Update now for a machine that is not asking", () => {
    assert.equal(updates.request("nobody"), false);
  });

  it("forgets a machine that stops asking, and says so", () => {
    updates.check(check(), gate, 0);
    assert.equal(updates.list(REPORT_TTL_MS + 1).length, 0);
    assert.match(lines.at(-1)!, /Mac booth-mini \(5f1c09ab\) stopped checking for updates$/);
  });

  it("holds no more machines than its cap", () => {
    for (let i = 0; i <= MAX_MACHINES; i++) updates.check(check({ machine: `m-${i}` }), gate, i);
    const list = updates.list(MAX_MACHINES);
    assert.equal(list.length, MAX_MACHINES);
    assert.ok(!list.some((m) => m.machine === "m-0"));
  });

  it("scrubs what a machine says before it reaches the log", () => {
    updates.check(check({ host: "booth\n[stage-controller] forged", state: "failed", target: "1.27.0", detail: "bad\nline" }), gate, 0);
    assert.ok(lines.every((l) => !l.includes("\n")));
  });
});

describe("the sentence Screens shows", () => {
  it("names a Windows launcher without its digest", () => {
    const d = { update: false as const, why: "current" as const };
    assert.equal(sentence({ platform: "windows", have: "a".repeat(64), state: "updated", target: undefined, detail: undefined }, "a".repeat(64), d), "Kiosk launcher updated. It takes effect at the next sign-in");
    assert.equal(sentence({ platform: "windows", have: "a".repeat(64), state: "idle", target: undefined, detail: undefined }, "b".repeat(64), { update: false, why: "off" }), "Kiosk launcher out of date. Automatic updates are off");
  });
});
