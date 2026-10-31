// Home's snoozes: what survives, what clears, and what is said about it.
//
// Real files and the real broadcaster. The decisions worth proving are the ones
// a green happy path hides: a restart in the middle of a service must not read
// as the service starting, and a snooze that cannot be saved must not read as
// one that was.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { before, describe, it, mock } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-home-snoozes-"));
process.env.STAGE_UTILITY_DATA = TMP;

const { HomeSnoozes, homeSnoozes, SnoozeRefused } = await import("./home-snoozes.js");
const { addBroadcastListener, broadcast } = await import("./broadcaster.js");
const { runtimeFiles, configFiles } = await import("./config-snapshot.js");
const { SNOOZE_NO_PCO_MS, SNOOZE_BACKSTOP_MS, SNOOZE_MAX } = await import("../types/home-snoozes.js");
type HomeSnoozesState = import("../types/home-snoozes.js").HomeSnoozesState;

const FILE = path.join(TMP, "home-snoozes.json");
const onDisk = async () => (JSON.parse(await fs.readFile(FILE, "utf8")) as { snoozes: { key: string }[] }).snoozes.map((s) => s.key);
const keys = (s: HomeSnoozesState) => s.snoozes.map((x) => x.key);

const frames: HomeSnoozesState[] = [];
addBroadcastListener((channel, payload) => {
  if (channel === "home:snoozes") frames.push(payload as HomeSnoozesState);
});

// The log lines are part of the behaviour.
const logged: string[] = [];
mock.method(console, "log", (...a: unknown[]) => void logged.push(a.map(String).join(" ")));

const live = (mode: "item" | "preservice" | "none") => broadcast("pco:live", { mode });
const settle = () => new Promise((r) => setTimeout(r, 40));

before(async () => {
  await homeSnoozes.start();
});

describe("home snoozes", () => {
  it("is runtime: a restore must not resurrect last month's decisions", () => {
    assert.ok(runtimeFiles().includes("home-snoozes.json"));
    assert.ok(!configFiles().includes("home-snoozes.json"));
  });

  it("saves to disk before it answers, stamps a rev, and says so on the log", async () => {
    const rev = homeSnoozes.state().rev;
    const s = await homeSnoozes.snooze("wireless-battery:ch3", "critical", true);
    assert.ok(s.expiresAt !== null && s.expiresAt - Date.now() > SNOOZE_BACKSTOP_MS - 5000 && s.expiresAt - Date.now() <= SNOOZE_BACKSTOP_MS, "with Planning Center, a 7-day backstop");
    assert.deepEqual(await onDisk(), ["wireless-battery:ch3"]);
    assert.equal(homeSnoozes.state().rev, rev + 1);
    assert.equal(frames.at(-1)?.rev, rev + 1, "the channel carries the new rev");
    assert.ok(logged.includes("[home] snoozed wireless-battery:ch3 (critical) until next service (7 days at most)"), logged.join("\n"));
  });

  it("outside Planning Center a snooze lapses after 12 hours", async () => {
    const t0 = Date.now();
    const s = await homeSnoozes.snooze("screen:lobby", "warn", false);
    assert.ok(s.expiresAt !== null && s.expiresAt >= t0 + SNOOZE_NO_PCO_MS && s.expiresAt <= Date.now() + SNOOZE_NO_PCO_MS);
    await homeSnoozes.unsnooze("screen:lobby");
  });

  it("re-snoozing at another severity replaces the stored severity", async () => {
    await homeSnoozes.snooze("wireless-battery:ch3", "warn", true);
    assert.equal(homeSnoozes.state().snoozes.find((s) => s.key === "wireless-battery:ch3")?.severity, "warn");
    await homeSnoozes.snooze("wireless-battery:ch3", "critical", true);
  });

  it("refuses a key or severity that breaks a rule, and stores nothing", async () => {
    const rev = homeSnoozes.state().rev;
    for (const key of ["", "nosubject", "a:b c", "__proto__", "x".repeat(200) + ":y", 7, null]) {
      await assert.rejects(homeSnoozes.snooze(key, "warn", true), SnoozeRefused, `key ${String(key)}`);
    }
    await assert.rejects(homeSnoozes.snooze("a:b", "info", true), SnoozeRefused);
    assert.equal(homeSnoozes.state().rev, rev);
  });

  it("unsnooze removes one key and reports whether there was one", async () => {
    await homeSnoozes.snooze("integration:pco", "warn", true);
    assert.equal(await homeSnoozes.unsnooze("integration:pco"), true);
    assert.equal(await homeSnoozes.unsnooze("integration:pco"), false);
    assert.ok(!(await onDisk()).includes("integration:pco"));
  });

  it("a service starting clears every snooze, once, and says how many", async () => {
    live("none"); // baseline: not live
    await homeSnoozes.snooze("screen:a", "warn", true);
    const n = keys(homeSnoozes.state()).length;
    assert.ok(n >= 2);
    live("preservice");
    await settle();
    assert.equal(keys(homeSnoozes.state()).length, n, "pre-service is not the service starting");
    live("item");
    await settle();
    assert.deepEqual(keys(homeSnoozes.state()), []);
    assert.deepEqual(await onDisk(), []);
    assert.ok(logged.includes(`[home] cleared ${n} snoozes: service started`), logged.join("\n"));

    // Snoozed DURING the service, it stays: item after item is not a new start.
    await homeSnoozes.snooze("screen:b", "warn", true);
    live("item");
    await settle();
    assert.deepEqual(keys(homeSnoozes.state()), ["screen:b"]);
  });

  it("a restart in the middle of a service is not the service starting", async () => {
    await homeSnoozes.snooze("screen:c", "warn", true);
    // A fresh process: the first pco:live it hears is a service already running.
    const restarted = new HomeSnoozes();
    await restarted.start();
    assert.ok(keys(restarted.state()).includes("screen:c"), "the snooze survives the restart (loaded from the file)");
    live("item");
    await settle();
    assert.ok(keys(restarted.state()).includes("screen:c"), "the first frame only sets the baseline");
  });

  it("a snooze that cannot be saved is refused, not remembered", async () => {
    // A directory where the file belongs makes the write fail.
    await fs.rm(FILE, { force: true });
    await fs.mkdir(FILE);
    const before = homeSnoozes.state();
    const errors = mock.method(console, "error", () => {});
    await assert.rejects(homeSnoozes.snooze("screen:d", "warn", true));
    errors.mock.restore();
    assert.deepEqual(homeSnoozes.state(), before, "memory did not move ahead of the disk");
    await fs.rmdir(FILE);
  });

  it("refuses a new key past 500, and still takes a key it already holds", async () => {
    const held = keys(homeSnoozes.state());
    for (let i = 0; i < SNOOZE_MAX - held.length; i++) await homeSnoozes.snooze(`cap:${i}`, "warn", true);
    assert.equal(homeSnoozes.state().snoozes.length, SNOOZE_MAX);
    await assert.rejects(homeSnoozes.snooze("cap:over", "warn", true), SnoozeRefused);
    await homeSnoozes.snooze("cap:0", "critical", true);
    assert.equal(homeSnoozes.state().snoozes.length, SNOOZE_MAX);
    for (const k of keys(homeSnoozes.state())) await homeSnoozes.unsnooze(k);
  });

  it("a snooze committed while a drop waits is not lost with it", async () => {
    await homeSnoozes.snooze("race:a", "warn", true);
    const pending = homeSnoozes.snooze("race:b", "warn", true); // queued first
    const drop = (homeSnoozes as unknown as { drop: (w: (s: { key: string }) => boolean, y: (n: number) => string) => Promise<void> })
      .drop((s) => s.key === "race:a", (n) => `race ${n}`);
    await Promise.all([pending, drop]);
    assert.deepEqual(keys(homeSnoozes.state()), ["race:b"], "memory");
    assert.deepEqual(await onDisk(), ["race:b"], "disk");
    await homeSnoozes.unsnooze("race:b");
  });

  it("the 12 hour lapse itself clears a no-Planning-Center snooze and leaves a Planning Center one", async () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    try {
      await homeSnoozes.snooze("lapse:nopco", "warn", false);
      await homeSnoozes.snooze("lapse:pco", "warn", true);
      mock.timers.tick(SNOOZE_NO_PCO_MS + 1000);
      mock.timers.reset();
      await settle();
      assert.deepEqual(keys(homeSnoozes.state()), ["lapse:pco"]);
      assert.ok(logged.includes("[home] cleared 1 snooze: lapsed"), logged.join("\n"));
    } finally {
      mock.timers.reset();
    }
    await homeSnoozes.unsnooze("lapse:pco");
  });

  it("a failed save while clearing logs it and keeps the clear in memory", async () => {
    live("none");
    await homeSnoozes.snooze("fail:a", "warn", true);
    await fs.rm(FILE, { force: true });
    await fs.mkdir(FILE);
    const errs: string[] = [];
    const errors = mock.method(console, "error", (...a: unknown[]) => void errs.push(a.map(String).join(" ")));
    live("item");
    await settle();
    errors.mock.restore();
    await fs.rmdir(FILE);
    assert.deepEqual(keys(homeSnoozes.state()), [], "the service has started: the snoozes are over");
    assert.ok(errs.some((e) => e.includes("[home] could not save snoozes after clearing them")), errs.join("\n"));
  });
});
