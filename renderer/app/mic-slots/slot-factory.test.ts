// New slots and spacers over plain HTTP.
//
// crypto.randomUUID is undefined outside a secure context, and production is
// plain HTTP. freshSlotId once called it directly, so + Slot, + Spacer, Start
// blank, Duplicate, the check's Add to and a recalled saved layout all threw on
// the real box while working on localhost. Node provides randomUUID, so it is
// deleted here to stand in for prod.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { duplicateOf, freshSlotId, newSlot, newSpacer } from "./slot-factory.js";

describe("the slot factory with no randomUUID", () => {
  const real = Object.getOwnPropertyDescriptor(globalThis.crypto, "randomUUID");
  beforeEach(() => {
    Object.defineProperty(globalThis.crypto, "randomUUID", { value: undefined, configurable: true, writable: true });
  });
  afterEach(() => {
    if (real) Object.defineProperty(globalThis.crypto, "randomUUID", real);
    else delete (globalThis.crypto as { randomUUID?: unknown }).randomUUID;
  });

  test("mints distinct slot ids", () => {
    const a = freshSlotId();
    assert.notEqual(a, freshSlotId());
    assert.ok(a.startsWith("slot-"), a);
  });

  test("makes a slot, a spacer and a duplicate", () => {
    const s = newSlot([]);
    const sp = newSpacer([s]);
    const d = duplicateOf(s, [s, sp]);
    assert.equal(new Set([s.id, sp.id, d.id]).size, 3);
  });
});
