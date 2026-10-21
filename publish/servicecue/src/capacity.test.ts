// capacity.ts — who may hold a socket open.
//
// The cases are the ones a real deploy met: one script holding every slot, a phone
// that slept without closing, a church whose whole building is one address. The
// object's use of the policy (what it reads, what it closes) is shown in workerd.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { DEFAULT_LIMITS, admit, limitsFrom, type Held, type Limits } from "./capacity.js";

const NOW = 1_000_000;
const LIMITS: Limits = { max: 6, perAddress: 3, idleAfterMs: 90_000 };
/** A socket last heard `agoMs` ago. */
const heard = (address: string | null, agoMs = 1000): Held => ({ address, lastHeardAt: NOW - agoMs });
const stale = (address: string | null): Held => heard(address, LIMITS.idleAfterMs + 1);
const times = (n: number, make: (i: number) => Held): Held[] => Array.from({ length: n }, (_, i) => make(i));

describe("admit", () => {
  test("lets a socket in when there is room, and closes nothing", () => {
    assert.deepEqual(admit([], "a", NOW, LIMITS), { admit: true, evict: [] });
    assert.deepEqual(admit([heard("a"), heard("b")], "a", NOW, LIMITS), { admit: true, evict: [] });
  });

  test("closes no idle socket while there is room: idle is only ever a reason to make room", () => {
    assert.deepEqual(admit([stale("a"), stale("b")], "c", NOW, LIMITS), { admit: true, evict: [] });
  });

  test("an address at its share is turned away, and another address is not", () => {
    const held = times(LIMITS.perAddress, () => heard("a"));
    assert.deepEqual(admit(held, "a", NOW, LIMITS), { admit: false, why: "address" });
    assert.deepEqual(admit(held, "b", NOW, LIMITS), { admit: true, evict: [] });
  });

  test("an address at its share has its own idle sockets closed to make room, and only its own", () => {
    const held = [heard("a"), stale("a"), heard("a"), stale("b")];
    assert.deepEqual(admit(held, "a", NOW, LIMITS), { admit: true, evict: [1] });
  });

  test("an address whose sockets are all in use is turned away without closing any", () => {
    const held = [stale("b"), heard("a"), heard("a"), heard("a")];
    assert.deepEqual(admit(held, "a", NOW, LIMITS), { admit: false, why: "address" });
  });

  test("a full page turns away the next when no socket is idle", () => {
    const held = times(LIMITS.max, (i) => heard(`address-${i}`));
    assert.deepEqual(admit(held, "new", NOW, LIMITS), { admit: false, why: "full" });
  });

  test("a full page closes its idle sockets, and only those, to let one in", () => {
    const held = [heard("a"), stale("b"), heard("c"), stale("d"), heard("e"), stale("f")];
    assert.deepEqual(admit(held, "new", NOW, LIMITS), { admit: true, evict: [1, 3, 5] });
  });

  test("a socket that was heard exactly the idle time ago is not yet idle", () => {
    const held = times(LIMITS.max, (i) => heard(`address-${i}`, LIMITS.idleAfterMs));
    assert.deepEqual(admit(held, "new", NOW, LIMITS), { admit: false, why: "full" });
    const past = times(LIMITS.max, (i) => heard(`address-${i}`, LIMITS.idleAfterMs + 1));
    assert.equal(admit(past, "new", NOW, LIMITS).admit, true);
  });

  test("one script holding every slot, silently, is what the share is for", () => {
    // Six slots, one address, the share is three: the script never gets the other three.
    const script = times(LIMITS.perAddress, () => heard("script"));
    assert.equal(admit(script, "script", NOW, LIMITS).admit, false);
    assert.equal(admit(script, "church", NOW, LIMITS).admit, true);
  });

  test("a client with no address is one address among the rest, held to the same share", () => {
    const held = times(LIMITS.perAddress, () => heard(null));
    assert.deepEqual(admit(held, null, NOW, LIMITS), { admit: false, why: "address" });
    assert.deepEqual(admit(held, "a", NOW, LIMITS), { admit: true, evict: [] });
  });

  test("a socket turned away for its address closes nothing on its behalf", () => {
    // Full page, an address at its share, and idle sockets elsewhere: the answer is no, and the idle ones stay until a socket is admitted.
    const held = [heard("a"), heard("a"), heard("a"), stale("b"), stale("c"), stale("d")];
    assert.deepEqual(admit(held, "a", NOW, LIMITS), { admit: false, why: "address" });
  });

  test("the defaults are 500 sockets, 25 to an address, and three missed pings", () => {
    assert.deepEqual(DEFAULT_LIMITS, { max: 500, perAddress: 25, idleAfterMs: 90_000 });
    const held = times(24, () => heard("church"));
    assert.equal(admit(held, "church", NOW).admit, true);
    assert.equal(admit([...held, heard("church")], "church", NOW).admit, false);
  });
});

describe("limitsFrom", () => {
  test("is the defaults for a deploy that sets nothing", () => {
    assert.deepEqual(limitsFrom({}), DEFAULT_LIMITS);
  });

  test("takes a whole number of at least one, as text or a number", () => {
    assert.deepEqual(limitsFrom({ MAX_VIEWERS: "6", MAX_VIEWERS_PER_ADDRESS: 3, VIEWER_IDLE_MS: "2500" }), { max: 6, perAddress: 3, idleAfterMs: 2500 });
  });

  test("ignores anything else, a variable at a time", () => {
    for (const bad of ["", "0", "-1", "1.5", "six", " 6", "6 ", "1e3", 0, -1, 1.5, Number.NaN, null, undefined, {}, [], true]) {
      assert.deepEqual(limitsFrom({ MAX_VIEWERS: bad, MAX_VIEWERS_PER_ADDRESS: bad, VIEWER_IDLE_MS: bad }), DEFAULT_LIMITS, JSON.stringify(bad));
    }
    assert.deepEqual(limitsFrom({ MAX_VIEWERS: "nine", MAX_VIEWERS_PER_ADDRESS: "40" }), { ...DEFAULT_LIMITS, perAddress: 40 });
  });
});
