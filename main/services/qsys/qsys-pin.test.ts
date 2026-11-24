// The staff PIN: set, checked, locked after five wrong tries, and stored only as
// a salted hash. The clock is injected, so the minute's lock is not waited out.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, beforeEach, mock, test } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-qsys-pin-"));
process.env.STAGE_UTILITY_DATA = TMP;

const { checkPin, setPin, pinState, __setPinClockForTests, __resetPinTriesForTests, PIN_LOCK_MS } = await import("./qsys-pin.js");
const { restoreCheckFor } = await import("../stores.js");

after(async () => {
  __setPinClockForTests(null);
  await fs.rm(TMP, { recursive: true, force: true });
});

let clock = 1_000_000;
const warnings: string[] = [];
beforeEach(() => {
  clock = 1_000_000;
  __setPinClockForTests(() => clock);
  __resetPinTriesForTests();
  warnings.length = 0;
});

/** Run `fn` with console quiet, keeping what was warned. */
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const m = [
    mock.method(console, "warn", (...a: unknown[]) => void warnings.push(a.map(String).join(" "))),
    mock.method(console, "log", () => {}),
  ];
  try {
    return await fn();
  } finally {
    for (const x of m) x.mock.restore();
  }
}

test("checkPin accepts the set PIN and refuses others", async () => {
  await quiet(() => setPin("2580", "10.0.0.9"));
  assert.deepEqual(await pinState(), { set: true });
  assert.deepEqual(await checkPin("2580", "c1"), { ok: true });
  assert.deepEqual(await checkPin("2581", "c1"), { ok: false, lockedForMs: 0 });
  assert.deepEqual(await checkPin("258", "c1"), { ok: false, lockedForMs: 0 }, "a short PIN is a wrong try, not a match");
  assert.deepEqual(await checkPin("2580", "c1"), { ok: true }, "a correct PIN after wrong ones still opens");
});

test("with no PIN set nothing opens, and it is not counted as a wrong try", async () => {
  await quiet(() => setPin(null, "10.0.0.9"));
  assert.deepEqual(await pinState(), { set: false });
  for (let i = 0; i < 7; i++) assert.deepEqual(await checkPin("0000", "c2"), { ok: false, lockedForMs: 0, notSet: true });
  await quiet(() => setPin("1111"));
  assert.deepEqual(await checkPin("1111", "c2"), { ok: true }, "the no-PIN tries locked the client");
});

test("five wrong tries lock for 60 s, then it accepts again", async () => {
  await quiet(() => setPin("4321"));
  const answers = await quiet(async () => {
    const out = [];
    for (let i = 0; i < 5; i++) out.push(await checkPin("0000", "10.1.2.3"));
    return out;
  });
  assert.deepEqual(answers.slice(0, 4), Array(4).fill({ ok: false, lockedForMs: 0 }));
  assert.deepEqual(answers[4], { ok: false, lockedForMs: PIN_LOCK_MS });
  assert.equal(PIN_LOCK_MS, 60_000);
  assert.deepEqual(warnings.filter((w) => w.startsWith("[qsys] PIN locked for 10.1.2.3")).length, 1, `warned: ${JSON.stringify(warnings)}`);

  clock += 20_000;
  assert.deepEqual(await checkPin("4321", "10.1.2.3"), { ok: false, lockedForMs: 40_000 }, "the correct PIN opened a locked client");
  assert.deepEqual(await checkPin("4321", "10.9.9.9"), { ok: true }, "another client was locked too");

  clock += 40_000;
  assert.deepEqual(await checkPin("4321", "10.1.2.3"), { ok: true });
});

test("a correct PIN clears the count: four wrong, one right, four wrong never locks", async () => {
  await quiet(() => setPin("4321"));
  for (let i = 0; i < 4; i++) await checkPin("0000", "c3");
  assert.deepEqual(await checkPin("4321", "c3"), { ok: true });
  for (let i = 0; i < 4; i++) assert.deepEqual(await checkPin("0000", "c3"), { ok: false, lockedForMs: 0 });
});

test("a burst of parallel guesses is counted one at a time: the sixth is locked, unhashed", async () => {
  await quiet(() => setPin("4321"));
  // Twenty guesses at once, the correct PIN last.
  const guesses = [...Array.from({ length: 19 }, (_, i) => String(1000 + i)), "4321"];
  const answers = await quiet(() => Promise.all(guesses.map((g) => checkPin(g, "burst"))));
  assert.equal(answers.filter((a) => a.ok).length, 0, "a guess got past the lock in a burst");
  assert.deepEqual(answers.slice(5).map((a) => (a.ok ? 0 : a.lockedForMs > 0)), Array(15).fill(true));
});

test("the hash, not the PIN, is stored", async () => {
  await quiet(() => setPin("7319"));
  const first = JSON.parse(await fs.readFile(path.join(TMP, "qsys-pin.json"), "utf8")) as { pin: Record<string, string> };
  assert.deepEqual(Object.keys(first).sort(), ["pin"]);
  assert.deepEqual(Object.keys(first.pin).sort(), ["hash", "salt"]);
  assert.match(first.pin.salt, /^[0-9a-f]{32}$/);
  assert.match(first.pin.hash, /^[0-9a-f]{64}$/);
  await quiet(() => setPin("7319"));
  const second = JSON.parse(await fs.readFile(path.join(TMP, "qsys-pin.json"), "utf8")) as { pin: Record<string, string> };
  assert.notEqual(second.pin.salt, first.pin.salt, "the same PIN was salted the same twice");
  assert.notEqual(second.pin.hash, first.pin.hash, "the same PIN hashed the same twice: no salt");
  assert.deepEqual(await checkPin("7319", "c4"), { ok: true });
});

test("a PIN that is not four digits is refused", async () => {
  for (const bad of ["123", "12345", "abcd", "12 4", "１２３４"]) await assert.rejects(setPin(bad), /4 digits/);
});

test("a restore takes a hash or null, and refuses anything else", async () => {
  const check = restoreCheckFor("qsys-pin.json");
  assert.ok(check, "the PIN store is not a registered config store");
  const good = { pin: { salt: "a".repeat(32), hash: "b".repeat(64) } };
  assert.deepEqual(await check(good), { ok: true, value: good });
  assert.deepEqual(await check({ pin: null }), { ok: true, value: { pin: null } });
  for (const bad of [{ pin: "1234" }, { pin: { salt: "x", hash: "y" } }, null, []]) {
    assert.equal((await check(bad)).ok, false, `restored: ${JSON.stringify(bad)}`);
  }
});
