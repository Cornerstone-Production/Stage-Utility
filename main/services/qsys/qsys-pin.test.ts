// The staff PIN: set, checked, locked after five wrong tries, and stored only as
// a salted hash. The clock is injected, so the minute's lock is not waited out.

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes, scryptSync } from "node:crypto";
import { after, beforeEach, mock, test } from "node:test";

const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "stage-qsys-pin-"));
process.env.STAGE_UTILITY_DATA = TMP;

const { checkPin, setPin, pinState, __setPinClockForTests, __resetPinTriesForTests, __pinDerivationsForTests, __reloadPinForTests, PIN_LOCK_MS, PIN_FORGET_IDLE_MS, PinTries } = await import("./qsys-pin.js");
const { restoreCheckFor } = await import("../stores.js");
const { configSnapshot } = await import("../config-snapshot.js");

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
  await quiet(() => setPin("2580", "2001:db8::9"));
  assert.deepEqual(await pinState(), { set: true });
  assert.deepEqual(await checkPin("2580", "c1"), { ok: true });
  assert.deepEqual(await checkPin("2581", "c1"), { ok: false, lockedForMs: 0 });
  assert.deepEqual(await checkPin("258", "c1"), { ok: false, lockedForMs: 0 }, "a short PIN is a wrong try, not a match");
  assert.deepEqual(await checkPin("2580", "c1"), { ok: true }, "a correct PIN after wrong ones still opens");
});

test("with no PIN set nothing opens, and it is not counted as a wrong try", async () => {
  await quiet(() => setPin(null, "2001:db8::9"));
  assert.deepEqual(await pinState(), { set: false });
  for (let i = 0; i < 7; i++) assert.deepEqual(await checkPin("0000", "c2"), { ok: false, lockedForMs: 0, notSet: true });
  await quiet(() => setPin("1111"));
  assert.deepEqual(await checkPin("1111", "c2"), { ok: true }, "the no-PIN tries locked the client");
});

test("five wrong tries lock for 60 s, then it accepts again", async () => {
  await quiet(() => setPin("4321"));
  const answers = await quiet(async () => {
    const out = [];
    for (let i = 0; i < 5; i++) out.push(await checkPin("0000", "2001:db8::3"));
    return out;
  });
  assert.deepEqual(answers.slice(0, 4), Array(4).fill({ ok: false, lockedForMs: 0 }));
  assert.deepEqual(answers[4], { ok: false, lockedForMs: PIN_LOCK_MS });
  assert.equal(PIN_LOCK_MS, 60_000);
  assert.deepEqual(warnings.filter((w) => w.startsWith("[qsys] PIN locked for 2001:db8::3")).length, 1, `warned: ${JSON.stringify(warnings)}`);

  clock += 20_000;
  assert.deepEqual(await checkPin("4321", "2001:db8::3"), { ok: false, lockedForMs: 40_000 }, "the correct PIN opened a locked client");
  assert.deepEqual(await checkPin("4321", "2001:db8::9"), { ok: true }, "another client was locked too");

  clock += 40_000;
  assert.deepEqual(await checkPin("4321", "2001:db8::3"), { ok: true });
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
  const before = __pinDerivationsForTests();
  const answers = await quiet(() => Promise.all(guesses.map((g) => checkPin(g, "burst"))));
  assert.equal(answers.filter((a) => a.ok).length, 0, "a guess got past the lock in a burst");
  assert.deepEqual(answers.slice(5).map((a) => (a.ok ? 0 : a.lockedForMs > 0)), Array(15).fill(true));
  // The lock spares the CPU too: the five that counted were hashed, the fifteen
  // refused while locked were not.
  assert.equal(__pinDerivationsForTests() - before, 5, "a locked client's guesses were still hashed");
  const lockedAgain = __pinDerivationsForTests();
  clock += 10_000;
  assert.equal((await checkPin("4321", "burst")).ok, false);
  assert.equal(__pinDerivationsForTests(), lockedAgain, "a guess during the lock was hashed");
});

test("the client table: a full table refuses a newcomer rather than reset a count part way to a lock", () => {
  let at = 0;
  const t = new PinTries(2, () => at);
  for (const c of ["a", "b"]) t.of(c)!.fails = 4;
  assert.equal(t.of("n"), null, "a newcomer pushed out a client four tries into a lock");
  assert.equal(t.of("a")!.fails, 4, "a partial count was reset");
  at = PIN_FORGET_IDLE_MS - 1;
  assert.equal(t.of("n"), null, "a count that had not rested a quarter of an hour was forgotten");
  // A count that has rested a quarter of an hour makes room; one tried since stays.
  t.of("a")!.lastTry = 100;
  at = PIN_FORGET_IDLE_MS;
  assert.notEqual(t.of("n"), null);
  assert.equal(t.of("a")!.fails, 4, "the client that tried most recently was forgotten");
  // A lock that is over makes room: its next try starts afresh anyway.
  const locks = new PinTries(1, () => at);
  locks.of("x")!.lockedUntil = at + 5;
  assert.equal(locks.of("y"), null, "a client still locked was forgotten");
  at += 5;
  assert.notEqual(locks.of("y"), null, "a client whose lock is over kept its place");
  // A client with a check in flight is never forgotten.
  const busy = new PinTries(1, () => at);
  const x = busy.of("x")!;
  x.pending = 1;
  x.lockedUntil = 1;
  assert.equal(busy.of("y"), null);
});

test("a client with nothing to remember is forgotten, so the table holds only counts and locks", async () => {
  await quiet(() => setPin("4321"));
  const t = new PinTries(10, () => clock);
  t.of("ok");
  t.settle("ok");
  assert.equal(t.size, 0);
  const w = t.of("wrong")!;
  w.fails = 1;
  t.settle("wrong");
  assert.equal(t.size, 1, "a client with a wrong try was forgotten");
});

test("a hash stored without its cost (before it was stored) is read at Node's defaults, through a real restore", async () => {
  const salt = randomBytes(16);
  const hash = scryptSync("9157", salt, 32);
  const old = { pin: { salt: salt.toString("hex"), hash: hash.toString("hex") } };
  await quiet(() => configSnapshot.apply({ kind: "stage-utility-config", version: 1, createdAt: "2026-01-01T00:00:00.000Z", files: { "qsys-pin.json": old } }));
  await __reloadPinForTests();
  assert.deepEqual(await pinState(), { set: true });
  assert.deepEqual(await checkPin("9157", "c5"), { ok: true }, "an old hash no longer opens");
  assert.deepEqual(await checkPin("9158", "c5"), { ok: false, lockedForMs: 0 });
});

test("a new hash is stored with its cost, and a restore keeps it", async () => {
  await quiet(() => setPin("2468"));
  const saved = JSON.parse(await fs.readFile(path.join(TMP, "qsys-pin.json"), "utf8")) as { pin: { cost?: unknown } };
  assert.deepEqual(saved.pin.cost, { N: 16384, r: 8, p: 1 });
  await quiet(() => configSnapshot.apply({ kind: "stage-utility-config", version: 1, createdAt: "2026-01-01T00:00:00.000Z", files: { "qsys-pin.json": saved } }));
  await __reloadPinForTests();
  const after = JSON.parse(await fs.readFile(path.join(TMP, "qsys-pin.json"), "utf8")) as { pin: { cost?: unknown } };
  assert.deepEqual(after.pin.cost, { N: 16384, r: 8, p: 1 }, "the restore dropped the cost");
  assert.deepEqual(await checkPin("2468", "c6"), { ok: true });
});

test("the hash, not the PIN, is stored", async () => {
  await quiet(() => setPin("7319"));
  const first = JSON.parse(await fs.readFile(path.join(TMP, "qsys-pin.json"), "utf8")) as { pin: Record<string, string> };
  assert.deepEqual(Object.keys(first).sort(), ["pin"]);
  assert.deepEqual(Object.keys(first.pin).sort(), ["cost", "hash", "salt"]);
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
  const withCost = { pin: { ...good.pin, cost: { N: 16384, r: 8, p: 1 } } };
  assert.deepEqual(await check(withCost), { ok: true, value: withCost });
  const costly = (cost: unknown) => ({ pin: { ...good.pin, cost } });
  for (const bad of [
    { pin: "1234" },
    { pin: { salt: "x", hash: "y" } },
    null,
    [],
    // A cost the server would not run: memory past the bound, N not a power of two, too many lanes, an extra field.
    costly({ N: 2 ** 20, r: 8, p: 1 }),
    costly({ N: 10_000, r: 8, p: 1 }),
    costly({ N: 16384, r: 8, p: 64 }),
    costly({ N: 16384, r: 8, p: 1, maxmem: 1 }),
  ]) {
    assert.equal((await check(bad)).ok, false, `restored: ${JSON.stringify(bad)}`);
  }
});
