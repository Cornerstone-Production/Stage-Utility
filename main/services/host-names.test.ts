// The host-name check: what is answered with no list, what is recorded, what is
// refused, and what turning refusal on accepts. Driven through a real HostNames
// over real stores in a temporary data directory, with a clock.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-host-names-"));
process.env.STAGE_UTILITY_DATA = TMP;
process.env.HOME = path.join(TMP, "home");

const { HostNames, hostNamesConfigStore, hostNamesSeenStore, MAX_SEEN, SEED_WINDOW_MS } = await import("./host-names.js");
const { alwaysAnswered, listableName, HOST_NAMES_CHANNEL } = await import("./host-name-rules.js");
const { hostnameOf } = await import("./http-origin.js");
const { addBroadcastListener } = await import("./broadcaster.js");

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
let clock = Date.parse("2026-10-20T12:00:00Z");
let names: InstanceType<typeof HostNames>;
let warned: string[] = [];
let broadcasts: unknown[] = [];
const realWarn = console.warn;
const realLog = console.log;

addBroadcastListener((channel, payload) => {
  if (channel === HOST_NAMES_CHANNEL) broadcasts.push(payload);
});

const req = (pathname = "/api/state") => ({ method: "GET", path: pathname, from: "192.168.1.23", userAgent: "Mozilla/5.0 Chrome/141.0" });
/** A name in use: seen now and again two days on. */
const established = (name: string) => {
  names.check(name, req());
  clock += 2 * DAY;
  names.check(name, req());
};
const settle = () => new Promise((r) => setTimeout(r, 5));
const refusals = () => warned.filter((l) => l.includes("refused host name")).length;

function make() {
  const n = new HostNames(hostNamesConfigStore, hostNamesSeenStore, { now: () => clock, machineName: () => "stage-utility", changeDelayMs: 0 });
  n.setPublicUrlSource(() => "http://stageutility.prod.example.org");
  return n;
}

beforeEach(async () => {
  warned = [];
  broadcasts = [];
  console.warn = (...a: unknown[]) => void warned.push(a.join(" "));
  console.log = () => {};
  await hostNamesConfigStore.save({ accepted: [], dismissed: [] });
  await hostNamesSeenStore.save({ names: [] });
  names = make();
  await names.init();
});

afterEach(async () => {
  await names.stop();
  console.warn = realWarn;
  console.log = realLog;
});

describe("answered with no list", () => {
  for (const host of [
    "192.168.1.50:8788",
    "[fe80::1]:8788",
    "localhost:3000",
    "display.localhost",
    "stage-display",
    "STAGE-DISPLAY.local",
    "cam.internal",
    "box.home.arpa",
    "2130706433",
  ]) {
    test(host, async () => {
      await names.setEnforce(true);
      assert.equal(names.check(host, req()).answer, true);
    });
  }

  test("a request with no Host at all, which no browser sends", async () => {
    await names.setEnforce(true);
    assert.equal(names.check(undefined, req()).answer, true);
  });

  test("the Public address, in any case and with a trailing dot", async () => {
    await names.setEnforce(true);
    assert.equal(names.check("StageUtility.Prod.Example.org.:8788", req()).answer, true);
  });

  test("a .lan name is NOT: the suffix is not reserved", () => {
    assert.equal(alwaysAnswered(hostnameOf("box.lan")!), false);
  });
});

describe("a name not on the list", () => {
  test("is answered while refusal is off, recorded once, and logged once", () => {
    assert.equal(names.check("rebind-7f3a.attacker.example", req()).answer, true);
    assert.equal(names.check("rebind-7f3a.attacker.example", req("/api/log")).answer, true);
    const view = names.view();
    assert.deepEqual(view.waiting.map((w) => [w.name, w.count, w.client]), [["rebind-7f3a.attacker.example", 2, "Chrome"]]);
    assert.equal(warned.filter((l) => l.includes("is not on the list")).length, 1, warned.join("\n"));
  });

  test("is refused while refusal is on, reads and writes alike", async () => {
    await names.setEnforce(true);
    assert.deepEqual(names.check("rebind-7f3a.attacker.example:8788", req()), { answer: false, name: "rebind-7f3a.attacker.example" });
    assert.equal(names.check("rebind-7f3a.attacker.example", { ...req(), method: "POST" }).answer, false);
  });

  test("is answered once accepted, and refused again once removed", async () => {
    await names.setEnforce(true);
    names.check("ha.example.org", req());
    assert.deepEqual(await names.add("ha.example.org", "accepted"), { ok: true });
    assert.equal(names.check("ha.example.org", req()).answer, true);
    assert.deepEqual(names.view().waiting, []);
    await names.remove("ha.example.org");
    assert.equal(names.check("ha.example.org", req()).answer, false);
  });

  test("tells the card, once per new name, not once per request", async () => {
    names.check("ha.example.org", req());
    await settle();
    assert.deepEqual(broadcasts, [{ waiting: 1, enforce: false }]);
    for (let i = 0; i < 5; i++) names.check("ha.example.org", req());
    await settle();
    assert.equal(broadcasts.length, 1);
  });
});

describe("the refusal log", () => {
  test("a refused name: one line, then one an hour with the count", async () => {
    await names.setEnforce(true);
    for (let i = 0; i < 5; i++) names.check("rebind-3.attacker.example", req());
    assert.equal(refusals(), 1, warned.join("\n"));
    clock += 61 * 60 * 1000;
    await names.tick();
    assert.equal(refusals(), 2, warned.join("\n"));
    assert.match(warned.at(-1)!, /4 more request/);
    await names.tick();
    assert.equal(refusals(), 2, "a quiet hour logs nothing");
  });

  test("a name seen and dismissed before refusal turned on still logs its first refusal", async () => {
    names.check("rebind-4.attacker.example", req());
    assert.deepEqual(await names.dismiss("rebind-4.attacker.example"), { ok: true });
    await names.setEnforce(true);
    names.check("rebind-4.attacker.example", req());
    assert.equal(refusals(), 1, warned.join("\n"));
  });

  test("a Host that is not a name is refused on a line too", async () => {
    await names.setEnforce(true);
    assert.equal(names.check("a b", req()).answer, false);
    assert.equal(refusals(), 1, warned.join("\n"));
  });

  for (const enforce of [false, true]) {
    test(`a burst of names is logged a few at a time, then counted, with refusal ${enforce ? "on" : "off"}`, async () => {
      await names.setEnforce(enforce);
      // Past the seen list's cap, so the lines about forgotten names count too.
      for (let i = 0; i < 2 * MAX_SEEN; i++) names.check(`burst-${i}.attacker.example`, req());
      const lines = warned.filter((l) => l.includes(".attacker.example")).length;
      assert.equal(lines, 5, warned.join("\n"));
      await names.tick();
      assert.match(warned.at(-1)!, /more line\(s\) about names not on the list/);
    });
  }
});

describe("turning refusal on", () => {
  test("accepts names in use over a day in the last 30 days; never one seen once, a dismissed one or an older one", async () => {
    established("old.example.org");
    clock += SEED_WINDOW_MS + DAY;
    names.check("ha.example.org", req());
    names.check("burst.attacker.example", req());
    names.check("rebind-1.attacker.example", req());
    clock += 2 * DAY;
    names.check("ha.example.org", req());
    names.check("rebind-1.attacker.example", req());
    assert.deepEqual(await names.dismiss("rebind-1.attacker.example"), { ok: true });
    await names.setEnforce(true);
    assert.deepEqual(names.view().accepted.map((a) => [a.name, a.source]), [["ha.example.org", "seen"]]);
    assert.equal(names.check("ha.example.org", req()).answer, true);
    for (const refused of ["rebind-1.attacker.example", "old.example.org", "burst.attacker.example"]) {
      assert.equal(names.check(refused, req()).answer, false, refused);
    }
  });

  test("a flood of names cannot push out a name in use, nor get itself accepted", async () => {
    established("ha.example.org");
    for (let i = 0; i < 4 * MAX_SEEN; i++) names.check(`r${i}.attacker.example`, req());
    await names.setEnforce(true);
    assert.deepEqual(names.view().accepted.map((a) => a.name), ["ha.example.org"]);
  });

  test("accepts only the first time: off and on again accepts nothing it refused", async () => {
    await names.setEnforce(true);
    established("rebind-5.attacker.example");
    await names.setEnforce(false);
    await names.setEnforce(true);
    assert.deepEqual(names.view().accepted, []);
    assert.equal(names.check("rebind-5.attacker.example", req()).answer, false);
  });

  test("survives a restart: the switch and the list are config", async () => {
    established("ha.example.org");
    await names.setEnforce(true);
    await names.stop();
    const again = make();
    await again.init();
    assert.equal(again.enforcing, true);
    assert.equal(again.check("ha.example.org", req()).answer, true);
    assert.equal(again.check("rebind-2.attacker.example", req()).answer, false);
    await again.stop();
  });
});

describe("a save that fails", () => {
  test("changes nothing: the switch stays off, the name is not answered", async () => {
    const save = hostNamesConfigStore.save.bind(hostNamesConfigStore);
    hostNamesConfigStore.save = () => Promise.reject(new Error("disk full"));
    try {
      await assert.rejects(names.setEnforce(true), /disk full/);
      assert.equal(names.enforcing, false);
      await assert.rejects(names.add("new.example.org", "added"), /disk full/);
      assert.deepEqual(names.view().accepted, []);
    } finally {
      hostNamesConfigStore.save = save;
    }
  });
});

test("counts reach disk when the server stops", async () => {
  names.check("ha.example.org", req());
  await settle();
  names.check("ha.example.org", req());
  await names.stop();
  const onDisk = JSON.parse(await fs.readFile(path.join(TMP, "host-names-seen.json"), "utf8"));
  assert.equal(onDisk.names.find((s: { name: string }) => s.name === "ha.example.org")?.count, 2);
});

test(`remembers at most ${MAX_SEEN} names, forgetting the least established`, () => {
  for (let i = 0; i < MAX_SEEN + 5; i++) {
    clock += 1000;
    names.check(`n${i}.example.org`, req());
  }
  const waiting = names.view().waiting.map((w) => w.name);
  assert.equal(waiting.length, MAX_SEEN);
  assert.ok(!waiting.includes("n0.example.org"));
  assert.ok(waiting.includes(`n${MAX_SEEN + 4}.example.org`));
});

describe("what may go on the list", () => {
  test("a pasted address keeps its host", () => {
    assert.deepEqual(listableName("http://Stage.Example.org:8788/display-1"), { ok: true, name: "stage.example.org" });
    assert.deepEqual(listableName("stage.example.org/display-1"), { ok: true, name: "stage.example.org" });
  });
  test("an underscore, which browsers send, is a name", () => {
    assert.deepEqual(listableName("panel_2.example.org"), { ok: true, name: "panel_2.example.org" });
  });
  test("an IP, a no-dot name and a junk string are refused with a reason", () => {
    for (const v of ["10.0.0.5", "stage-display", "cam.local", "bad name.example.org", ""]) assert.equal(listableName(v).ok, false, v);
  });
  test("the service refuses the same", async () => {
    assert.equal((await names.add("10.0.0.5", "added")).ok, false);
    assert.deepEqual(names.view().accepted, []);
  });
  test("only a waiting name can be dismissed: not an unseen one, not a listed one", async () => {
    assert.equal((await names.dismiss("never-seen.example.org")).ok, false);
    await names.add("ha.example.org", "added");
    assert.equal((await names.dismiss("ha.example.org")).ok, false);
    assert.deepEqual(names.view().dismissed, []);
  });
});
